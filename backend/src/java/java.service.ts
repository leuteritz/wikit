import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { createHash } from 'crypto';
import { createPatch, structuredPatch } from 'diff';
import { FtsService } from '../database/fts.service';
import { TRIGRAM_MIN_CHARS } from '../database/schema';
import { safeJson } from '../common/json.util';
import { CodeFormatterService } from '../common/code-formatter.service';
import { classMetrics } from '../common/code-metrics';
import { buildSearchRegex, scanSource } from '../common/code-search.util';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { SerializerService } from '../common/serializer.service';
import { parseJava, parseJavaForEdges, splitJavaSources, JavaClassGraphInfo } from '../common/java-parser';
import { JavaDependency } from '../entities/java-dependency.entity';
import { JavaEdge } from '../entities/java-edge.entity';
import { JavaFile } from '../entities/java-file.entity';
import { JavaFileVersion } from '../entities/java-file-version.entity';
import { JavaMethod } from '../entities/java-method.entity';
import { JavaBatchProgressService } from './java-batch-progress.service';
import { JavaEmbeddingsService } from './java-embeddings.service';

// parseJava() ist synchron (chevrotain). Eine Schleife ueber tausende Chunks blockiert den
// Event-Loop komplett – der Fortschritts-Stream kaeme erst NACH getaner Arbeit beim Client an
// und der Server waere solange fuer jede andere Anfrage tot. Alle YIELD_EVERY Chunks wird die
// Kontrolle deshalb kurz abgegeben.
const YIELD_EVERY = 25;
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

// SQLite bricht bei sehr grossen Mehrzeilen-Inserts mit "Expression tree is too large
// (maximum depth 1000)" ab: TypeORM laedt die eingefuegten Zeilen anschliessend per SELECT mit
// einer OR-Kette ueber ALLE Zeilen zurueck, und diese Kette ist der zu tiefe Ausdruck. Eine
// Codebasis mit einigen tausend Klassen erzeugt zehntausende Auto-Kanten – deshalb blockweise.
const INSERT_CHUNK = 200;
async function insertChunked(repo: { insert: (rows: any[]) => Promise<any> }, rows: any[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await repo.insert(rows.slice(i, i + INSERT_CHUNK));
  }
}

// --- Globale Code-Suche (codeSearch) -----------------------------------------------------------
// Kandidaten aus dem FTS-Index; grosszuegig, weil der Index Praefixe matcht und der exakte Scan
// danach noch aussortiert.
const CODE_SEARCH_CANDIDATES = 300;
// Obergrenze des Vollscans (Regex/Interpunktion). Bei einer Codebasis mit einigen tausend Klassen
// haengt daran, wie lange ein Tastendruck den Pi beschaeftigt – die Antwort schreibt an, wie viel
// tatsaechlich gelesen wurde.
const CODE_SEARCH_SCAN_LIMIT = 1500;
// Zeitbudget je Anfrage. Greift vor dem Datei-Deckel, wenn einzelne Klassen sehr gross sind.
const CODE_SEARCH_BUDGET_MS = 1200;
// Wie viele Quelltexte auf einmal geladen werden (raw_source ist die groesste Spalte).
const CODE_SEARCH_CHUNK = 60;
const CODE_SEARCH_FILE_LIMIT = 25;
const CODE_SEARCH_HITS_PER_FILE = 5;
const CODE_SEARCH_CONTEXT = 2;
// Kontextzeilen je Seite im Vorschau-Fenster (getSourceWindow); der Client schneidet daraus sein
// endgueltiges Fenster (buildCallWindow haelt +-3 Nicht-Leerzeilen).
const SOURCE_WINDOW_CONTEXT = 8;
// Deckel der GANZ-Klassen-Vorschau (`full=1`). Ein Klassentreffer meint die Klasse als Ganzes, also
// wird sie auch ganz gerendert – aber Shiki laeuft dafuer ueber jede Zeile, und auf dem Pi ist das
// bei einer Riesenklasse eine spuerbare Wartezeit vor einer Vorschau, durch die man ohnehin nur
// blaettert. Was der Deckel abschneidet, steht in der Antwort (`truncated`) und wird angeschrieben –
// ein stiller Schnitt liest sich wie „so kurz ist die Klasse".
const SOURCE_FULL_MAX_LINES = 1500;

// --- Wo steht dieser Typ? (getTypeUsages) ------------------------------------------------------
// Eine `uses`-Kante trug bisher keinen Code: das Bundle-Panel schrieb „No call site to show" und
// liess den Nutzer mit einer Behauptung zurueck, die er nur durch Aufmachen der Klasse pruefen
// konnte – obwohl `Http.GET` an drei Stellen im Quelltext steht. Gedeckelt, weil jede Fundstelle
// einen eigenen Shiki-Lauf kostet; was wegfaellt, steht als `truncated` in der Antwort.
const TYPE_USAGE_MAX = 6;
const TYPE_USAGE_CONTEXT = 3;
// `import`/`package` NENNEN den Typ, benutzen ihn aber nicht. Genau diese Unterscheidung ist die
// Frage, die das Panel beantwortet ("leftover import" oder echte Verwendung?) – die Zeilen werden
// deshalb getrennt gezaehlt statt mitgeliefert.
const TYPE_MENTION_HEADER_RE = /^\s*(?:import|package)\b/;

// --- Kanten-Identitaet: der einfache Name reicht nicht --------------------------------------
//
// `efw.util.http.Header` und `wt.doc.Header` sind zwei Klassen. Solange die Kantenberechnung nur
// mit einfachen Namen rechnete, verschmolzen sie zu einer: `definesMethod['Header']` enthielt die
// Methoden BEIDER, und wer die eine benutzte, bekam eine Kante zur anderen. Alles unten ist
// deshalb ueber den FQCN geschluesselt; der einfache Name bleibt nur die Beschriftung.
const fqcnOf = (pkg: string, name: string): string => (pkg ? `${pkg}.${name}` : name);
const simpleOf = (fqcn: string): string => fqcn.split('.').pop() || fqcn;

// Ein analysierter Typ mit allem, was zum Aufloesen fremder Typnamen aus SEINER Sicht noetig ist.
type EdgeClass = {
  fqcn: string;
  name: string;
  pkg: string; // '' = default package
  info: JavaClassGraphInfo;
  imports: string[]; // FQCNs aus java_dependencies, inkl. `p.q.*`
};

// Die klassenbeschreibenden Spalten aus einem geparsten Typ – an drei Stellen gebraucht
// (analyze, analyze-batch Insert + Overwrite-Update); getrennte Literale waeren dreimal die
// Gelegenheit, ein neues Feld zu vergessen. `class_modifiers` ist JSON-als-TEXT (s. json.util).
//
// `source` ist der Quelltext GENAU DIESER Klasse (bei analyze-batch also der Chunk, nicht der
// ganze Paste) – daraus entstehen `loc` und `complexity` fuer den Insights-Bereich. Sie hier zu
// rechnen statt beim Lesen ist der Unterschied zwischen einer Zahl, die in der Zeile schon steht,
// und einem Scan ueber die groesste Spalte der Datenbank bei jedem Aufruf.
function classColumns(cls: any, source: string) {
  const { loc, complexity } = classMetrics(
    source,
    (cls.methods || []).map((m: any) => m.body),
  );
  return {
    class_type: cls.class_type,
    stereotype: cls.stereotype ?? null,
    class_modifiers: JSON.stringify(cls.class_modifiers ?? []),
    extends_name: cls.extends_name || null,
    field_count: cls.field_count ?? 0,
    ctor_count: cls.ctor_count ?? 0,
    class_line: cls.class_line ?? null,
    loc,
    complexity,
  };
}

// Gleichartige Hinweise eines Massen-Imports zu Warnungstexten machen – gedeckelt.
//
// Drei Stellen brauchen das: nicht lesbare Abschnitte, Duplikate im Paste, unveraenderte
// Klassen. Bei einem Re-Import einer ganzen Codebasis sind das schnell tausende Faelle, und
// das Frontend haengt jede Warnung in dieselbe Karte. Die Regel ist deshalb ueberall gleich:
// bis WARN_LIST_MAX mit Namen (bei zwei, drei Faellen IST der Name die Information – daran
// liess sich zuletzt ueberhaupt erst erkennen, dass es Annotationstypen waren), darueber die
// ersten paar plus eine Zeile mit der Restzahl.
const WARN_LIST_MAX = 5;
function summarizeWarnings(items: string[], line: (x: string) => string, rest: (n: number) => string): string[] {
  if (!items.length) return [];
  if (items.length <= WARN_LIST_MAX) return items.map(line);
  return [...items.slice(0, WARN_LIST_MAX).map(line), rest(items.length - WARN_LIST_MAX)];
}

// java-parser (chevrotain) wirft bei einem Syntaxfehler eine mehrere Kilobyte lange Meldung
// ("Expecting: one of these possible Token sequences: 1. … 157. …"). Fuer die UI bleibt davon
// nur die Fundstelle uebrig – der Rest ist fuer den Nutzer wertlos.
function shortParseMessage(message: string): string {
  const msg = String(message || '').trim();
  const pos = /line:\s*(\d+),\s*column:\s*(\d+)/.exec(msg);
  if (pos) return `Syntax error at line ${pos[1]}, column ${pos[2]}`;
  return msg.split('\n')[0].slice(0, 200);
}

// Uebersprungenen Abschnitt benennen: Typname aus dem Chunk raten + Fundstelle des Fehlers.
function describeChunkError(chunk: string, message: string): string {
  const name = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(chunk)?.[1];
  return `Skipped ${name ? `"${name}"` : 'one section'} – ${shortParseMessage(message)}.`;
}

// Java-Code-Analyse: parsen (rein JS), speichern, Graph liefern, KI-Summaries on-demand.
// Muster wie ArticlesService: erst async arbeiten, DANN in einer ds.transaction() schreiben.
@Injectable()
export class JavaService {
  private readonly logger = new Logger(JavaService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly serializer: SerializerService,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
    private readonly fts: FtsService,
    private readonly progress: JavaBatchProgressService,
    private readonly formatter: CodeFormatterService,
    private readonly embeddings: JavaEmbeddingsService,
  ) {}

  // Datei analysieren: parsen + speichern (ohne KI -> Graph erscheint sofort).
  async analyze(body: any): Promise<any> {
    const b = body || {};
    const { source = '', filename = '' } = b;
    if (!source.trim()) throw new BadRequestException('Source code is required');

    let parsed;
    try {
      parsed = parseJava(source);
    } catch (e: any) {
      throw new BadRequestException(`Parsing failed: ${shortParseMessage(e.message)}`);
    }

    const cls = parsed.primary;
    const name = (filename && filename.trim()) || `${cls.class_name}.java`;

    let fileId!: number;
    await this.ds.transaction(async (manager) => {
      const res = await manager.getRepository(JavaFile).insert({
        filename: name,
        pkg: parsed.package || null,
        class_name: cls.class_name,
        raw_source: source,
        ...classColumns(cls, source),
      });
      fileId = res.identifiers[0].id as number;

      for (const m of cls.methods) {
        // ai_summary initial = Javadoc-Fallback (KI spaeter on-demand pro Methode).
        await manager.getRepository(JavaMethod).insert({
          file_id: fileId,
          method_name: m.method_name,
          return_type: m.return_type,
          parameters: JSON.stringify(m.parameters),
          modifiers: JSON.stringify(m.modifiers ?? []),
          javadoc: m.javadoc || '',
          ai_summary: m.javadoc || '',
          body: m.body || '',
          start_line: m.start_line ?? null,
          body_start_line: m.body_start_line ?? null,
          member_kind: m.member_kind ?? 'method',
        });
      }

      for (const fqn of parsed.imports) {
        await manager.getRepository(JavaDependency).insert({ from_file_id: fileId, to_class_name: fqn });
      }

      // Erste Version im Changelog anlegen (Basislinie fuer spaetere Diffs; kein Diff/Summary).
      await this.insertVersion(manager, fileId, source, null);

      // Klasse sofort in den Java-FTS aufnehmen (Wissensquelle fuer kuenftige Prompt-Anreicherung).
      await this.fts.indexJavaFile(manager, fileId);

      // Call-Edges global neu berechnen (manuelle + verworfene Kanten bleiben erhalten).
      await this.recomputeAutoEdges(manager);
    });

    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    return {
      file: await this.serializer.serializeJavaFile(row, { withSource: true }),
      graph: await this.serializer.graphForJavaFiles(),
    };
  }

  // Mehrere Klassen aus einem Roh-Paste (oder mehreren zusammengefuegten .java-Dateien)
  // analysieren. Ablauf wie analyze(): erst zerlegen + parsen (sync) und DB lesen, DANN in
  // EINER Transaktion schreiben. Trennt den Text in eigenstaendige Klassen-Chunks, dedupliziert
  // FQCNs im Paste, erkennt DB-Duplikate (class_name + package). Liegen Duplikate vor und ist
  // `overwrite` nicht gesetzt, wird NICHTS geschrieben und needsConfirm zurueckgegeben, damit
  // das Frontend nachfragen kann.
  async analyzeBatch(body: any): Promise<any> {
    const b = body || {};
    const source = (b.source ?? '').toString();
    const overwrite = b.overwrite === true;
    if (!source.trim()) throw new BadRequestException('Source code is required');

    // Optionale Job-Id des Clients: nur dann wird Fortschritt gestreamt (SSE).
    const jobId: string | null = typeof b.jobId === 'string' && b.jobId ? b.jobId : null;

    // 1) In eigenstaendige Klassen-Chunks zerlegen + je Chunk parsen (nur Top-Level-Typ).
    this.progress.emit(jobId, { phase: 'split', done: 0, total: 0 });
    const chunks = splitJavaSources(source);
    this.progress.emit(jobId, { phase: 'parse', done: 0, total: chunks.length });
    const warnings: string[] = [];
    const parseErrors: string[] = []; // Chunks, die nicht geparst werden konnten
    // FQCN mehrfach IM PASTE – je betroffener Klasse EIN Eintrag: dass `Foo` dreimal drinsteht,
    // ist eine Feststellung ueber Foo, keine drei verschiedenen Hinweise.
    const duplicates: string[] = [];
    const reportedDuplicates = new Set<string>();
    const seen = new Set<string>(); // FQCN -> bereits im Paste vorgekommen
    const items: Array<{ fqcn: string; pkg: string | null; cls: any; imports: string[]; chunk: string }> = [];

    let parsedCount = 0;
    for (const chunk of chunks) {
      parsedCount++;
      if (parsedCount % YIELD_EVERY === 0) {
        this.progress.emit(jobId, { phase: 'parse', done: parsedCount, total: chunks.length });
        await breathe();
      }
      if (!chunk.trim()) continue;
      let parsed;
      try {
        parsed = parseJava(chunk);
      } catch (e: any) {
        // Ein einzelner unlesbarer Abschnitt darf einen Paste mit hunderten Klassen nicht
        // komplett scheitern lassen -> ueberspringen und am Ende gesammelt melden.
        parseErrors.push(describeChunkError(chunk, e?.message));
        continue;
      }
      const cls = parsed.primary; // genau ein Top-Level-Typ pro Chunk (Splitter)
      const pkg = parsed.package || null;
      const fqcn = (pkg ? pkg + '.' : '') + cls.class_name;
      if (seen.has(fqcn)) {
        if (!reportedDuplicates.has(fqcn)) {
          reportedDuplicates.add(fqcn);
          duplicates.push(fqcn);
        }
        continue;
      }
      seen.add(fqcn);
      items.push({ fqcn, pkg, cls, imports: parsed.imports, chunk });
    }

    warnings.push(
      ...summarizeWarnings(
        parseErrors,
        (msg) => msg, // bereits fertige Saetze aus describeChunkError
        (n) => `… and ${n} more section(s) skipped.`,
      ),
      ...summarizeWarnings(
        duplicates,
        (fqcn) => `Duplicate class “${fqcn}” in the paste – only the first occurrence was kept.`,
        (n) => `… and ${n} more duplicated class(es) in the paste – only the first occurrence was kept.`,
      ),
    );

    if (!items.length) {
      throw new BadRequestException(
        parseErrors.length
          ? `Parsing failed – no section could be read. ${parseErrors[0]}`
          : 'No class, interface or enum found in the source',
      );
    }

    // 2) DB-Duplikate (class_name + package) ermitteln.
    const repo = this.ds.getRepository(JavaFile);
    const existingByFqcn = new Map<string, JavaFile>();
    this.progress.emit(jobId, { phase: 'check', done: 0, total: items.length });
    let checked = 0;
    for (const it of items) {
      if (++checked % YIELD_EVERY === 0) {
        this.progress.emit(jobId, { phase: 'check', done: checked, total: items.length });
        await breathe();
      }
      const existing = await repo.findOne({
        where: { class_name: it.cls.class_name, pkg: it.pkg ?? IsNull() },
      });
      if (existing) existingByFqcn.set(it.fqcn, existing);
    }

    // 3) Konflikte ohne Bestaetigung -> nichts schreiben, Frontend fragt nach (200-Antwort).
    const conflicts = [...existingByFqcn.keys()];
    if (conflicts.length && !overwrite) {
      return {
        needsConfirm: true,
        conflicts,
        detected: items.map((it) => ({ class_name: it.cls.class_name, package: it.pkg })),
        warnings,
      };
    }

    // 4) Klassifizieren (vor der Transaktion): neu / unveraendert / geaendert. Bei Konflikt den
    //    Unified-Diff gegen den aktuellen Stand berechnen (sync, guenstig). Byte-identische
    //    Klassen werden uebersprungen (kein neuer Version-Snapshot) und nur als Warnung gemeldet.
    type WritePlan = { it: (typeof items)[number]; existing: JavaFile | undefined; diff: string | null };
    const plans: WritePlan[] = [];
    const unchanged: string[] = [];
    for (const it of items) {
      const existing = existingByFqcn.get(it.fqcn);
      if (!existing) {
        plans.push({ it, existing: undefined, diff: null });
        continue;
      }
      const fname = `${it.cls.class_name}.java`;
      const check = structuredPatch(fname, fname, existing.raw_source, it.chunk);
      if (!check.hunks.length) {
        unchanged.push(it.fqcn);
        continue;
      }
      plans.push({ it, existing, diff: createPatch(fname, existing.raw_source, it.chunk) });
    }

    warnings.push(
      ...summarizeWarnings(
        unchanged,
        (fqcn) => `Class “${fqcn}” unchanged — no new version created.`,
        (n) => `… and ${n} more unchanged — no new versions created.`,
      ),
    );

    // Nichts zu schreiben (alle Konflikte waren identisch) -> 409, damit das Frontend meldet.
    if (!plans.length) {
      throw new ConflictException('No changes detected — file is identical to the current version.');
    }

    // 5) Schreiben: neue Klasse -> insert + Version 1. Geaenderte Klasse -> UPDATE in-place
    //    (java_files.id bleibt stabil -> Versions-FK + Artikel-Verknuepfung ueberleben), Methoden/
    //    Dependencies ersetzen, neuen Version-Snapshot mit Diff anlegen. Diff-KI folgt NACH der Tx.
    const savedIds: number[] = [];
    const overwritten: string[] = [];
    const changedVersions: Array<{ versionId: number; className: string; diff: string }> = [];
    // Ab hier blockiert better-sqlite3 den Thread bis zum Commit: einmal melden, einmal den
    // Loop atmen lassen – danach traegt die Anzeige im Client die Phase ueber die Zeit weiter.
    this.progress.emit(jobId, { phase: 'save', done: 0, total: plans.length });
    await breathe();
    await this.ds.transaction(async (manager) => {
      for (const plan of plans) {
        const { it, existing } = plan;
        if (existing) {
          // Bestandsklassen ohne Historie: aktuellen Stand als implizite Version 1 sichern.
          const versionCount = await manager.getRepository(JavaFileVersion).count({
            where: { java_file_id: existing.id },
          });
          if (versionCount === 0) {
            await this.insertVersion(manager, existing.id, existing.raw_source, null);
          }

          await manager.getRepository(JavaFile).update(
            { id: existing.id },
            {
              filename: `${it.cls.class_name}.java`,
              raw_source: it.chunk,
              ...classColumns(it.cls, it.chunk),
            },
          );
          await manager.getRepository(JavaMethod).delete({ file_id: existing.id });
          await manager.getRepository(JavaDependency).delete({ from_file_id: existing.id });
          await this.insertMethodsAndDeps(manager, existing.id, it.cls.methods, it.imports);

          const versionId = await this.insertVersion(manager, existing.id, it.chunk, plan.diff);
          changedVersions.push({ versionId, className: it.cls.class_name, diff: plan.diff! });

          await this.fts.indexJavaFile(manager, existing.id);
          savedIds.push(existing.id);
          overwritten.push(it.fqcn);
          continue;
        }

        const res = await manager.getRepository(JavaFile).insert({
          filename: `${it.cls.class_name}.java`,
          pkg: it.pkg,
          class_name: it.cls.class_name,
          raw_source: it.chunk,
          ...classColumns(it.cls, it.chunk),
        });
        const fileId = res.identifiers[0].id as number;

        await this.insertMethodsAndDeps(manager, fileId, it.cls.methods, it.imports);
        await this.insertVersion(manager, fileId, it.chunk, null);

        await this.fts.indexJavaFile(manager, fileId);
        savedIds.push(fileId);
      }

      // Einmalig nach allen Schreibvorgaengen: Call-Edges global neu berechnen. Mit `jobId`, damit
      // der Fortschrittsbalken auch diese Phase zeigt – bei einem Massen-Import ist sie der
      // laengste Abschnitt nach dem Speichern.
      await this.recomputeAutoEdges(manager, jobId);
    });

    // 6) KI-Zusammenfassung je geaenderter Version im Hintergrund nachtragen (blockiert die
    //    Antwort NICHT; Ollama optional -> ai_summary bleibt sonst NULL, Frontend faellt zurueck).
    //
    //    NACHEINANDER, nicht als Schleife von .catch()-Aufrufen: Der Re-Import einer ganzen
    //    Codebasis meldet hier tausende geaenderte Versionen. Alle gleichzeitig loszuschicken
    //    heisst tausende offene Ollama-Anfragen samt anschliessendem Shiki-Rendering – Ollama
    //    beantwortet ohnehin nur wenige parallel, der Rest laeuft in den Timeout, und auf einem
    //    Pi geht dem Prozess dabei der Speicher aus. Die Kette laeuft ohne await weiter: die
    //    Antwort geht sofort raus, die Summaries tropfen nach.
    void changedVersions.reduce(
      (chain, cv) =>
        chain.then(() =>
          this.generateVersionSummary(cv.versionId, cv.className, cv.diff, b.userContext).catch((e) =>
            this.logger.warn(`Diff-Summary fehlgeschlagen (Version ${cv.versionId}): ${e?.message || e}`),
          ),
        ),
      Promise.resolve(),
    );

    // Reihenfolge wie savedIds beibehalten (find() sortiert nicht garantiert).
    const savedRows = await repo.find({ where: { id: In(savedIds) } });
    const byId = new Map(savedRows.map((r) => [r.id, r]));
    // Listenform statt Detailform: der Client nutzt aus `saved` nur id + Anzahl. Die Detailform
    // wuerde jede gespeicherte Klasse samt Shiki-Rendering aller Methoden zurueckgeben – bei einem
    // Paste mit hunderten Klassen ist das ein Vielfaches der Antwortgroesse ohne jeden Nutzen.
    const saved = await this.serializer.serializeJavaFileList(
      savedIds.map((id) => byId.get(id)).filter(Boolean),
    );

    this.progress.emit(jobId, { phase: 'done', done: saved.length, total: saved.length });

    return {
      saved,
      graph: await this.serializer.graphForJavaFiles(),
      warnings,
      overwritten,
    };
  }

  // Methoden + Import-Dependencies einer geparsten Klasse fuer file_id einfuegen. Gemeinsame
  // Hilfe fuer Erst-Insert und Re-Upload (dort nach vorherigem Loeschen der alten Zeilen).
  private async insertMethodsAndDeps(
    manager: EntityManager,
    fileId: number,
    methods: any[],
    imports: string[],
  ): Promise<void> {
    // Blockweise statt Zeile fuer Zeile: ein Massen-Paste bringt zehntausende Methoden mit, und
    // jedes einzelne INSERT ist ein eigener TypeORM-Roundtrip. Der Deckel (insertChunked) bleibt
    // noetig – s. Kommentar dort zur zu tiefen Ausdrucks-Kette bei sehr grossen Mehrzeilen-Inserts.
    if (methods.length) {
      await insertChunked(
        manager.getRepository(JavaMethod),
        methods.map((m) => ({
          file_id: fileId,
          method_name: m.method_name,
          return_type: m.return_type,
          parameters: JSON.stringify(m.parameters),
          modifiers: JSON.stringify(m.modifiers ?? []),
          javadoc: m.javadoc || '',
          // ai_summary initial = Javadoc-Fallback (KI spaeter on-demand pro Methode).
          ai_summary: m.javadoc || '',
          body: m.body || '',
          start_line: m.start_line ?? null,
          body_start_line: m.body_start_line ?? null,
          member_kind: m.member_kind ?? 'method',
        })),
      );
    }
    if (imports.length) {
      await insertChunked(
        manager.getRepository(JavaDependency),
        imports.map((fqn) => ({ from_file_id: fileId, to_class_name: fqn })),
      );
    }
  }

  // Neuen Version-Snapshot anlegen (version_number = bisheriges Maximum + 1). Liefert die neue id.
  private async insertVersion(
    manager: EntityManager,
    fileId: number,
    source: string,
    diff: string | null,
  ): Promise<number> {
    const maxRow = await manager
      .getRepository(JavaFileVersion)
      .createQueryBuilder('v')
      .select('MAX(v.version_number)', 'max')
      .where('v.java_file_id = :id', { id: fileId })
      .getRawOne<{ max: number | null }>();
    const next = Number(maxRow?.max ?? 0) + 1;
    const res = await manager.getRepository(JavaFileVersion).insert({
      java_file_id: fileId,
      version_number: next,
      source,
      diff: diff ?? null,
    });
    return res.identifiers[0].id as number;
  }

  // Hintergrund: KI-Zusammenfassung eines Version-Diffs erzeugen (async, ausserhalb jeder Tx)
  // und in java_file_versions nachtragen. Ist Ollama nicht erreichbar -> '' -> nichts schreiben,
  // ai_summary bleibt NULL (Frontend zeigt Fallback). Rendert Markdown -> HTML (Cache).
  private async generateVersionSummary(
    versionId: number,
    className: string,
    diff: string,
    context?: string,
  ): Promise<void> {
    const summary = await this.ollama.generateDiffSummary({ className, diff, context });
    if (!summary) return;
    const { html } = await this.markdown.renderMarkdown(summary);
    await this.ds
      .getRepository(JavaFileVersion)
      .update({ id: versionId }, { ai_summary: summary, ai_summary_html: html });
  }

  // Versionsverlauf einer Klasse (neueste zuerst), ohne Quelltext (kleine Payload).
  async listVersions(idParam: string): Promise<any[]> {
    const id = Number(idParam);
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id }, select: { id: true } });
    if (!file) throw new NotFoundException('File not found');
    const rows = await this.ds.getRepository(JavaFileVersion).find({
      where: { java_file_id: id },
      order: { version_number: 'DESC' },
    });
    return rows.map((v) => ({
      id: v.id,
      version_number: v.version_number,
      diff: v.diff,
      ai_summary: v.ai_summary,
      ai_summary_html: v.ai_summary_html,
      created_at: v.created_at,
    }));
  }

  // Vollstaendiger Quelltext EINER Version (on-demand, z. B. fuer die Initial-Version-Ansicht).
  async getVersionSource(idParam: string, versionIdParam: string): Promise<{ source: string }> {
    const id = Number(idParam);
    const versionId = Number(versionIdParam);
    const v = await this.ds.getRepository(JavaFileVersion).findOne({
      where: { id: versionId, java_file_id: id },
    });
    if (!v) throw new NotFoundException('Version not found');
    return { source: v.source };
  }

  // Liste aller analysierten Dateien (ohne raw_source). COLLATE NOCASE -> Raw-SQL.
  async listFiles(): Promise<any[]> {
    const rows = await this.ds.query(
      `SELECT id, article_id, filename, package, class_name, class_type, stereotype, class_modifiers,
              extends_name, field_count, ctor_count, class_line, description, generated_at, created_at
       FROM java_files ORDER BY class_name COLLATE NOCASE`,
    );
    return this.serializer.serializeJavaFileList(rows);
  }

  // Globaler Abhaengigkeitsgraph (Knoten = Klassen, Kanten = interne Imports).
  async graph(): Promise<any> {
    return this.serializer.graphForJavaFiles();
  }

  // Detail einer Datei inkl. Methoden, Dependencies und Quelltext.
  async getFile(idParam: string): Promise<any> {
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id: Number(idParam) } });
    if (!row) throw new NotFoundException('File not found');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Quellcode EINER Methode als Shiki-gehighlightetes HTML (fuers Graph-Edge-Panel).
  // Rein lesend + Render -> KEINE Transaktion noetig. Das HTML kommt aus dem vorhandenen
  // Markdown-Primitiv (Dual-Theme, defaultColor:false) inkl. sanitize-html -> kein Extra-Sanitizing.
  async getMethodSnippet(fileIdParam: string, methodNameParam: string): Promise<any> {
    const fileId = Number(fileIdParam);
    const methodName = (methodNameParam || '').toString().trim();
    if (!fileId || !methodName) {
      throw new BadRequestException('fileId and methodName are required');
    }

    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');

    // Overloads teilen sich den Namen -> erste Methode (ORDER BY id, wie ueberall im Serializer).
    const method = await this.ds.getRepository(JavaMethod).findOne({
      where: { file_id: fileId, method_name: methodName },
      order: { id: 'ASC' },
    });
    if (!method) {
      throw new NotFoundException(`Method "${methodName}" not found in ${file.class_name}`);
    }

    const parameters = safeJson(method.parameters, []);
    const modifiers = safeJson(method.modifiers, []);
    const signature = this.serializer.buildSignature({ ...method, parameters, modifiers });
    // Interface-/abstract-Methoden haben keinen Body -> dann die Signatur als Snippet zeigen.
    const hasBody = !!(method.body && method.body.trim());
    const code = hasBody ? method.body : `${signature};`;
    // Zeile: gespeicherter Wert (neu analysiert) oder Fallback aus dem Rohquelltext (Bestandsdaten).
    const startLine = method.start_line ?? this.findMethodLine(file.raw_source, methodName);

    // Kombinierter, leerzeilenbereinigter Block fuer die ANZEIGE im Edge-Panel: Signatur + Rumpf in
    // EINER Shiki-Box. Leerzeilen raus -> kompakte, gut lesbare Detailansicht.
    const combinedCode = (hasBody ? `${signature} ${method.body}` : `${signature};`)
      .replace(/\n[ \t]*\n+/g, '\n')
      .trim();
    // endLine = ECHTE letzte Quellzeile der Methode (schliessende `}`), NICHT die der kompaktierten
    // Anzeige-Box. method.body ist der verbatim aus raw_source geschnittene Rumpf (mit echten
    // Leerzeilen) -> seine Zeilenzahl ab body_start_line ergibt die reale Spanne. So markiert das
    // Frontend die KOMPLETTE Methode im Gesamt-Quellcode statt nur bis zur kompaktierten Laenge.
    const endLine =
      hasBody && method.body
        ? (method.body_start_line ?? startLine) + method.body.split('\n').length - 1
        : startLine;

    const { html } = await this.markdown.renderMarkdown('```java\n' + code + '\n```');
    const { html: combinedHtml } = await this.markdown.renderMarkdown('```java\n' + combinedCode + '\n```');
    return {
      code,
      startLine,
      endLine,
      html,
      combinedHtml,
      combinedCode,
      signature,
      filename: file.filename,
      className: file.class_name,
      methodName,
    };
  }

  // Alle gespeicherten Quelltexte als EIN Text – zum Kopieren und, das ist der Zweck,
  // zum Wieder-Einlesen ueber `analyze-batch`. Deshalb ist das Format **kein** eigenes:
  // es ist genau das, was der Paste-Weg ohnehin versteht (verkettete Kompilationseinheiten;
  // `package`/`import` nach einem Typ beginnt fuer `splitJavaSources` die naechste Datei).
  //
  // Der Kopf und die Package-Trenner sind Kommentare – und Kommentare vor einer
  // `package`-Anweisung verwirft der Splitter (er setzt `segStart` zurueck). Sie sind also fuer
  // Menschen da und stoeren den Rueckweg nicht. Sortiert wird nach Package und Klassenname, damit
  // zwei Exporte derselben Datenlage denselben Text ergeben (diffbar).
  //
  // ⚠️ `ids` macht daraus den Themen-Export (`/topic`), ohne ein zweites Format zu erfinden: der
  // Ausschnitt ist derselbe Text, nur kuerzer – also bleibt er ueber „Add code" einlesbar, und die
  // Regeln fuer Dubletten, Sortierung und Kopf gelten unveraendert an EINER Stelle. `topic` steht
  // nur im Kopf: wer das Buendel in einen Chat wirft, soll dort lesen koennen, wonach gefragt war.
  async exportAll(ids?: number[] | null, topic?: string): Promise<any> {
    const picked = (ids || []).filter((n) => Number.isInteger(n) && n > 0);
    // Eine LEERE Auswahl ist eine Auswahl, kein „alles": wer nichts angehakt hat, bekommt nichts.
    // Der Unterschied haengt am Argument, nicht an der Laenge – `null` heisst „ganzer Bestand".
    if (ids && !picked.length) {
      return { text: '', classes: 0, duplicates: 0, packages: 0, bytes: 0, lines: 0, generatedAt: '', files: [] };
    }
    const rows = await this.ds.query(
      `SELECT id, class_name, package, filename, raw_source
       FROM java_files
       ${picked.length ? `WHERE id IN (${picked.join(',')})` : ''}
       ORDER BY package COLLATE NOCASE, class_name COLLATE NOCASE`,
    );

    // Gleiche FQCN doppelt: der Import behaelt beim Wieder-Einlesen ohnehin nur die erste (zwei
    // Klassen mit demselben vollqualifizierten Namen kann es nicht geben). Wer sie hier
    // mitschreibt, bekommt beim Rueckweg eine Warnung und eine andere Zahl als versprochen –
    // also faellt die Dublette schon im Export weg, und das Modal sagt, wie viele es waren.
    const seen = new Set<string>();
    const unique = rows.filter((r: any) => {
      const fqn = `${r.package || ''}.${r.class_name}`;
      if (seen.has(fqn)) return false;
      seen.add(fqn);
      return true;
    });
    const duplicates = rows.length - unique.length;

    // ⚠️ Neben dem Text entsteht hier die LANDKARTE dazu: wo im Ergebnis jede Klasse anfaengt und
    // wie lang sie ist. Der Client braucht beides – die Vorschau soll auf Zuruf zu einer Klasse
    // springen und ihren Abschnitt hervorheben, und die Trefferliste soll sagen, welche Klasse das
    // Budget frisst. Gerechnet wird es GENAU HIER, weil hier der Text entsteht: die Zeilen im
    // Client nachzuzaehlen hiesse, die Trenner-Regel ein zweites Mal zu kennen, und die erste
    // Aenderung am Kopf haette beide Seiten still auseinandergebracht.
    const packages = new Set<string>();
    const parts: string[] = [];
    const spans: any[] = [];
    let lastPkg: string | null = null;
    // 1-basiert, gezaehlt ab dem ersten `parts`-Eintrag – der Kopf kommt erst danach dazu (seine
    // Zeilenzahl haengt an `packages.size`, also steht sie vor dieser Schleife noch nicht fest).
    let line = 1;
    for (const r of unique) {
      const pkg = r.package || '(default package)';
      packages.add(pkg);
      if (pkg !== lastPkg) {
        parts.push(`// ${'─'.repeat(4)} ${pkg} ${'─'.repeat(Math.max(4, 60 - pkg.length))}`);
        lastPkg = pkg;
        line += 1;
      }
      const src = String(r.raw_source || '').replace(/\r\n?/g, '\n').trimEnd();
      const srcLines = src.split('\n').length;
      spans.push({
        fileId: r.id,
        className: r.class_name,
        package: r.package || '',
        startLine: line,
        lines: srcLines,
        bytes: Buffer.byteLength(src, 'utf8'),
      });
      parts.push(src, '');
      // `parts.join('\n')`: ein Eintrag mit n Zeilen traegt n Zeilen bei, der leere Eintrag eine.
      line += srcLines + 1;
    }

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const subject = (topic || '').trim().slice(0, 80);
    const head = [
      '// ═══════════════════════════════════════════════════════════════════',
      picked.length
        ? `// Wikit topic bundle${subject ? ` · "${subject}"` : ''} · ${unique.length} classes · ${packages.size} packages`
        : `// Wikit code export · ${unique.length} classes · ${packages.size} packages`,
      `// ${generatedAt} UTC`,
      duplicates ? `// ${duplicates} duplicate class name(s) skipped – only one per package is kept.` : '',
      '//',
      // Der Rueckweg gilt fuer beide Faelle, verspricht aber Verschiedenes: der Vollexport stellt
      // den Bestand wieder her, ein Buendel traegt genau die ausgewaehlten Klassen weiter.
      picked.length
        ? '// Paste this whole text into "Add code" to load these classes somewhere else.'
        : '// Paste this whole text back into "Add code" to restore every class.',
      '// Everything above a package statement is a comment and is dropped on import.',
      '// ═══════════════════════════════════════════════════════════════════',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n')
      .concat('\n');

    const text = unique.length ? head + parts.join('\n') : '';
    // Der Kopf endet mit einem `\n`, `parts` schliesst also direkt an: `"a\nb\n".split('\n')` ist
    // `['a','b','']` – die Zeilenzahl des Kopfes ist deshalb `length - 1`.
    const headLines = head.split('\n').length - 1;
    return {
      text,
      classes: unique.length,
      duplicates,
      packages: packages.size,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text ? text.split('\n').length : 0,
      generatedAt,
      files: spans.map((s) => ({ ...s, startLine: s.startLine + headLines })),
    };
  }

  // Fenster aus dem Quelltext einer Klasse, Shiki-gerendert (Vorschau der globalen Code-Suche).
  // Bewusst dieselbe Bauart wie getMethodSnippet: der Server highlightet, der Client schneidet mit
  // den vorhandenen DOM-Helfern (`buildCallWindow`) zurecht – kein zweiter Highlighter im Client.
  // Eingerueckt wird wie im Quellcode-Tab der Klasse (`reindentJava`, Zeilenzahl bleibt konstant),
  // damit die Vorschau und die Ansicht NACH dem Sprung dasselbe zeigen.
  //
  // ZWEI Ausschnitte, weil es zwei Fragen sind – aber EIN Endpunkt, weil der Gegenstand derselbe
  // ist (Shiki-HTML aus dem Quelltext EINER Klasse, samt Zeilennummern): `full=1` liefert die
  // ganze Klasse (Treffer auf den KLASSENNAMEN meint die Klasse, nicht die eine Zeile), ohne
  // `full` das Fenster um `line` (Treffer im Quelltext meint genau die Stelle). Die Antwortform
  // bleibt in beiden Faellen gleich, nur `startLine`/`endLine` unterscheiden sich.
  //
  // ⚠️ `raw=1` schaltet das Einruecken AB. Es gibt genau einen Aufrufer dafuer – das Themen-Buendel,
  // das dieses HTML nicht fuer sich anzeigt, sondern es ZEILENWEISE in einen Text einsetzt, der aus
  // `raw_source` gebaut ist (`exportAll`). `reindentJava` haelt zwar die Zeilenzahl konstant, nicht
  // aber den Zeileninhalt: die Einrueckung spraenge beim Hover sichtbar um, und die Suchoffsets des
  // Buendels (gerechnet auf demselben `raw_source`) laegen daneben. Wer den Quelltext ANSIEHT,
  // bekommt ihn weiterhin eingerueckt – das ist die Vorgabe und bleibt es.
  async getSourceWindow(
    fileIdParam: string,
    lineParam: string,
    contextParam?: string,
    fullParam?: string,
    rawParam?: string,
  ): Promise<any> {
    const fileId = Number(fileIdParam);
    const line = Number(lineParam);
    if (!fileId || !Number.isFinite(line) || line < 1) {
      throw new BadRequestException('fileId and line are required');
    }
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');

    const full = fullParam === '1';
    const context = Math.min(Math.max(Number(contextParam) || SOURCE_WINDOW_CONTEXT, 1), 40);
    // Genau die Normalisierung, die auch `exportAll` anwendet – sonst waeren die Zeilen dort und
    // hier bei CRLF-Quelltexten verschieden lang.
    const source = rawParam === '1'
      ? String(file.raw_source || '').replace(/\r\n?/g, '\n').trimEnd()
      : this.formatter.reindentJava(file.raw_source || '');
    const lines = source.split('\n');
    const hitLine = Math.min(line, lines.length || 1);
    const startLine = full ? 1 : Math.max(1, hitLine - context);
    const endLine = full
      ? Math.min(lines.length, SOURCE_FULL_MAX_LINES)
      : Math.min(lines.length, hitLine + context);
    const code = lines.slice(startLine - 1, endLine).join('\n');
    const { html } = await this.markdown.renderMarkdown('```java\n' + code + '\n```');

    return {
      fileId,
      className: file.class_name,
      package: file.pkg || '',
      filename: file.filename,
      startLine,
      endLine,
      hitLine,
      totalLines: lines.length,
      full,
      // Nur im Ganz-Klassen-Modus eine Aussage: beim Fenster ist „da fehlt was" der Zweck.
      truncated: full && endLine < lines.length,
      html,
    };
  }

  // Wo im Quelltext von `fileId` steht der Typ `typeName`? Die Antwort auf die Frage, die eine
  // `uses`- oder `import`-Kante aufwirft und bisher unbeantwortet blieb.
  //
  // Vier Festlegungen:
  //  * **Gesucht wird als ganzes Wort, gross-/kleinschreibungsgenau** – dieselbe Musterlogik wie
  //    ueberall (`buildSearchRegex`). Ohne die Wortgrenzen traefe `Http` auch `HttpsURLConnection`
  //    und `HttpURLConnection`, und aus einer belegten Aussage wuerde eine falsche.
  //  * **`import`/`package`-Zeilen zaehlen getrennt.** Sie nennen den Typ, benutzen ihn nicht –
  //    und ob es ausser ihnen noch etwas gibt, IST die Frage. `total: 0` bei `imports: 1` heisst
  //    belegt „leftover import"; jede andere Zahl widerlegt es.
  //  * **Der Quelltext wird eingerueckt wie im Source-Tab** (`reindentJava`, wie getSourceWindow),
  //    damit die gemeldete Zeile die ist, die der Sprung anschliessend markiert.
  //  * **Kein Parser.** Die Kante ist bereits berechnet; hier geht es nur noch darum, sie zu
  //    BELEGEN. Ein zweiter Parse-Lauf je aufgeklappter Zeile waere auf dem Pi spuerbar, und ein
  //    Textbeleg ist genau das, was der Nutzer selbst nachlesen wuerde.
  async getTypeUsages(fileIdParam: string, typeNameParam: string): Promise<any> {
    const fileId = Number(fileIdParam);
    const typeName = String(typeNameParam || '').trim();
    if (!fileId || !typeName) throw new BadRequestException('fileId and typeName are required');
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');

    const { re } = buildSearchRegex({ query: typeName, caseSensitive: true, wholeWord: true });
    const lines = this.formatter.reindentJava(file.raw_source || '').split('\n');
    const hitLines: number[] = [];
    let imports = 0;
    if (re) {
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        if (TYPE_MENTION_HEADER_RE.test(lines[i])) imports++;
        else hitLines.push(i + 1);
      }
    }

    const shown = hitLines.slice(0, TYPE_USAGE_MAX);
    const usages = await Promise.all(
      shown.map(async (line) => {
        const startLine = Math.max(1, line - TYPE_USAGE_CONTEXT);
        const endLine = Math.min(lines.length, line + TYPE_USAGE_CONTEXT);
        const { html } = await this.markdown.renderMarkdown(
          '```java\n' + lines.slice(startLine - 1, endLine).join('\n') + '\n```',
        );
        return { line, startLine, endLine, html };
      }),
    );

    return {
      fileId,
      typeName,
      className: file.class_name,
      filename: file.filename,
      total: hitLines.length,
      imports,
      truncated: hitLines.length > shown.length,
      usages,
    };
  }

  // Zeilengenaue Volltextsuche ueber ALLE gespeicherten Klassen – die globale Entsprechung der
  // Suchleiste im Quellcode-Tab (gleiche Musterlogik, s. common/code-search.util.ts).
  //
  // Zwei Wege, nach Kosten gewaehlt:
  //  * `index` – normale Anfrage: FTS5 nennt die Kandidaten (bm25), nur die werden gelesen. Das
  //    sind ein paar Dutzend Quelltexte statt aller.
  //  * `scan`  – Regex, reine Interpunktion (`->`, `!=`, die der FTS-Tokenizer wegwirft) oder ein
  //    Index-Lauf ohne Treffer: Vollscan in Id-Reihenfolge. FTS5 kennt nur Token-PRAEFIXE, die
  //    Suche hier beliebige Teilstrings – ohne diesen Rueckfall faende „ById" nichts, obwohl die
  //    Suche in der geoeffneten Klasse `findById` findet.
  //
  // Gedeckelt wird nach Dateien UND nach Zeit; was nicht gelesen wurde, steht als `scannedFiles`/
  // `truncated` in der Antwort und wird angeschrieben – ein stiller Deckel liest sich wie „nichts
  // weiter gefunden".
  async codeSearch(params: {
    q?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
    context?: number;
    limit?: number;
  }): Promise<any> {
    const query = (params.q || '').toString();
    const empty = {
      query,
      mode: 'index',
      files: [],
      totalFiles: 0,
      totalMatches: 0,
      scannedFiles: 0,
      truncated: false,
    };
    if (!query.trim()) return empty;

    const { re, error } = buildSearchRegex({
      query,
      caseSensitive: !!params.caseSensitive,
      wholeWord: !!params.wholeWord,
      regex: !!params.regex,
    });
    if (!re) throw new BadRequestException(error || 'Invalid search pattern');

    const maxFiles = Math.min(Math.max(Number(params.limit) || CODE_SEARCH_FILE_LIMIT, 1), 60);
    const context = Math.min(Math.max(Number(params.context ?? CODE_SEARCH_CONTEXT), 0), 8);
    const repo = this.ds.getRepository(JavaFile);
    const totalFiles = await repo.count();

    // Weg 1: Trigram-Index. Er kennt jeden Teilstring ab TRIGRAM_MIN_CHARS – also ist seine
    // Antwort VOLLSTAENDIG, und „keine Kandidaten" heisst hier wirklich „kommt nirgends vor".
    // Genau das spart den Vollscan, der bisher jede solche Anfrage kostete.
    //
    // ⚠️ Die Laengenpruefung gehoert HIERHER, nicht nur in den Kandidaten-Lookup. Ein Trigramm
    // braucht drei Zeichen; darunter liefert der Index leer, und das ist dann eben KEINE Aussage
    // ueber die Codebasis. Ohne diese Bedingung wurde das leere Ergebnis trotzdem als
    // vollstaendige Antwort ausgegeben – „jt" fand nirgends etwas, obwohl es in jeder zweiten
    // Klasse steht. Kurze Eingaben nehmen deshalb weiter den alten Weg (Praefix-Index, sonst Scan).
    if (!params.regex && this.fts.sourceIndexUsable() && query.trim().length >= TRIGRAM_MIN_CHARS) {
      const ids = await this.fts.candidateJavaFileIdsBySource(query, CODE_SEARCH_CANDIDATES);
      const result = await this.scanFiles(repo, ids, re, { context, maxFiles });
      return {
        query,
        mode: 'index',
        totalFiles,
        scannedFiles: result.scanned,
        // Der Deckel liegt jetzt bei den KANDIDATEN, nicht bei den gelesenen Dateien: mehr
        // Kandidaten als CODE_SEARCH_CANDIDATES heisst, dass es weitere Klassen mit Treffern gibt.
        truncated: result.truncated || ids.length >= CODE_SEARCH_CANDIDATES,
        totalMatches: result.files.reduce((sum, f) => sum + f.matchCount, 0),
        files: result.files,
      };
    }

    // Weg 2 (Regex, sehr kurze Eingabe, Index noch im Aufbau): Kandidaten aus dem Praefix-Index
    // oder Vollscan. Unveraendert – nur noch selten erreicht.
    let mode: 'index' | 'scan' = 'scan';
    let ids: number[] = [];
    if (!params.regex) {
      ids = await this.fts.candidateJavaFileIds(query, CODE_SEARCH_CANDIDATES);
      if (ids.length) mode = 'index';
    }
    if (mode === 'scan') ids = await this.allFileIds(repo);

    let result = await this.scanFiles(repo, ids, re, { context, maxFiles });
    // Index-Weg ohne Treffer -> der Praefix-Index hat die Frage nicht beantwortet, nicht die
    // Codebasis. Einmal vollstaendig nachsehen, statt „no results" zu behaupten.
    if (mode === 'index' && !result.files.length) {
      mode = 'scan';
      result = await this.scanFiles(repo, await this.allFileIds(repo), re, { context, maxFiles });
    }

    return {
      query,
      mode,
      totalFiles,
      scannedFiles: result.scanned,
      truncated: result.truncated,
      totalMatches: result.files.reduce((sum, f) => sum + f.matchCount, 0),
      files: result.files,
    };
  }

  // Alle Ids in stabiler Reihenfolge – gedeckelt, damit der Vollscan nicht unbegrenzt waechst.
  private async allFileIds(repo: any): Promise<number[]> {
    const rows = await repo.find({
      select: { id: true },
      order: { id: 'ASC' },
      take: CODE_SEARCH_SCAN_LIMIT,
    });
    return rows.map((r: any) => r.id);
  }

  // Quelltexte blockweise nachladen und scannen. Blockweise, weil `raw_source` die mit Abstand
  // groesste Spalte ist: eine Codebasis mit einigen tausend Klassen als EIN SELECT waeren zig MB
  // im Speicher, obwohl nach den ersten Treffern ohnehin Schluss ist.
  private async scanFiles(
    repo: any,
    ids: number[],
    re: RegExp,
    { context, maxFiles }: { context: number; maxFiles: number },
  ): Promise<{ files: any[]; scanned: number; truncated: boolean }> {
    const files: any[] = [];
    const deadline = Date.now() + CODE_SEARCH_BUDGET_MS;
    let scanned = 0;
    let truncated = false;

    for (let i = 0; i < ids.length; i += CODE_SEARCH_CHUNK) {
      if (files.length >= maxFiles || Date.now() > deadline) {
        truncated = i < ids.length;
        break;
      }
      const chunk = ids.slice(i, i + CODE_SEARCH_CHUNK);
      const rows = await repo.find({
        where: { id: In(chunk) },
        // `pkg` ist das Property, die Spalte heisst `package` (reserviertes Wort, s. Entity).
        select: { id: true, filename: true, class_name: true, pkg: true, raw_source: true },
      });
      // Reihenfolge der Kandidaten (bm25 bzw. Id) wiederherstellen – `IN` gibt sie nicht zurueck.
      const byId = new Map<number, any>(rows.map((r: any) => [r.id, r]));
      for (const id of chunk) {
        const row = byId.get(id);
        if (!row) continue;
        scanned++;
        const { hits, total } = scanSource(row.raw_source || '', re, {
          context,
          maxHits: CODE_SEARCH_HITS_PER_FILE,
        });
        if (!total) continue;
        files.push({
          fileId: row.id,
          className: row.class_name,
          package: row.pkg || '',
          filename: row.filename,
          matchCount: total,
          capped: total > hits.length,
          hits,
        });
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
      // parseJava-Regel sinngemaess: eine lange Schleife blockiert den Event-Loop komplett.
      await breathe();
    }

    return { files, scanned, truncated };
  }

  // Fallback-Zeilenermittlung fuer Bestandsdaten ohne gespeicherte start_line:
  // erste Quellzeile, in der "<methodName>(" auftaucht. 1-basiert, Default 1.
  private findMethodLine(source: string, methodName: string): number {
    const lines = (source || '').split('\n');
    const safe = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${safe}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
    return 1;
  }

  // On-demand KI-Beschreibung fuer EINE Methode (async, ausserhalb der Transaktion).
  // Body optional `{ userContext }` -> Projekt-Kontext fliesst in den Prompt ein.
  // Nutzt den geparsten Methodenrumpf (generateMethodDescription) und pflegt den Java-FTS.
  async summarize(idParam: string, body?: any): Promise<any> {
    const id = Number(idParam);
    const method = await this.ds.getRepository(JavaMethod).findOne({ where: { id } });
    if (!method) throw new NotFoundException('Method not found');
    const file = await this.ds
      .getRepository(JavaFile)
      .findOne({ where: { id: method.file_id }, select: { class_name: true } });

    const summary = await this.ollama.generateMethodDescription({
      className: file?.class_name || '',
      method: { ...method, parameters: safeJson(method.parameters, []) },
      context: body?.userContext,
    });

    // Fallback: ist Ollama nicht erreichbar, bleibt der Javadoc/bisherige Text erhalten.
    const ollamaUnavailable = !summary;
    const finalSummary = summary || method.ai_summary || method.javadoc || '';

    // Markdown -> HTML vor der Transaktion rendern (async/teuer ausserhalb der Tx).
    const { html: summaryHtml } = await this.markdown.renderMarkdown(finalSummary);

    await this.ds.transaction(async (manager) => {
      await manager.getRepository(JavaMethod).update({ id }, { ai_summary: finalSummary });
      await this.fts.indexJavaFile(manager, method.file_id);
    });

    const updated = await this.ds.getRepository(JavaMethod).findOne({ where: { id } });
    return {
      method: { ...updated, parameters: safeJson(updated!.parameters, []) },
      summary_html: summaryHtml,
      ollama_unavailable: ollamaUnavailable,
    };
  }

  // Java-Datei zu einem Artikel (article_id) holen -> Live-Panel auf dem Wiki-Artikel.
  // Liefert null (Controller -> 404), wenn der Artikel keine verknuepfte Klasse hat.
  async getFileByArticle(articleIdParam: string): Promise<any> {
    const articleId = Number(articleIdParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { article_id: articleId } });
    if (!row) throw new NotFoundException('No Java class is linked to this article');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Datei + Methoden + Dependencies loeschen (CASCADE ueber FK). Verknuepfter Artikel bleibt
  // bestehen (FK ist andersherum: article -> SET NULL). Der java_fts-Eintrag (rowid = id) wird
  // nicht per Trigger gepflegt -> hier explizit entfernen, sonst bleibt er verwaist.

  // Komplett-Reset: ALLE analysierten Klassen entfernen.
  //
  // Frueher lief das als ein DELETE je Klasse ueber HTTP – und jeder einzelne Delete rechnete den
  // kompletten Auto-Kanten-Graphen neu. Bei ein paar tausend Klassen ist das quadratisch und
  // dauert entsprechend ewig. Hier: blockweise loeschen (damit ein Fortschritt ueberhaupt
  // meldbar ist), Kanten EINMAL am Ende leeren – ohne Klassen kann keine Kante mehr gelten.
  async resetAllFiles(jobId?: string | null): Promise<{ deleted: number }> {
    const rows: Array<{ id: number }> = await this.ds.query('SELECT id FROM java_files');
    const ids = rows.map((r) => Number(r.id));
    const total = ids.length;
    this.progress.emit(jobId, { phase: 'delete', done: 0, total });

    const CHUNK = 250;
    let done = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      await this.ds.transaction(async (manager) => {
        const marks = slice.map(() => '?').join(',');
        // FTS5 hat keine Fremdschluessel -> Indexzeilen explizit entfernen. BEIDE Indizes.
        await manager.query(`DELETE FROM java_fts WHERE rowid IN (${marks})`, slice);
        await this.fts.removeJavaSources(manager, slice);
        // java_methods / java_dependencies / java_file_versions haengen per ON DELETE CASCADE dran.
        await manager.getRepository(JavaFile).delete(slice);
      });
      done += slice.length;
      this.progress.emit(jobId, { phase: 'delete', done, total });
      await breathe();
    }

    // Die Vektoren haengen per CASCADE an den Dateien und sind damit schon weg – der Cache im
    // Speicher weiss davon nichts, und ein Treffer aus ihm zeigte auf eine Klasse, die es nicht
    // mehr gibt.
    await this.embeddings.clear();

    this.progress.emit(jobId, { phase: 'edges', done: total, total });
    await this.ds.transaction(async (manager) => {
      // Auch manuelle Kanten und Tombstones (dismissed=1) muessen weg: sonst unterdruecken sie
      // spaeter die Neuberechnung, wenn dieselbe Klasse erneut eingelesen wird.
      await manager.query('DELETE FROM java_edges');
    });

    this.progress.emit(jobId, { phase: 'done', done: total, total });
    this.logger.log(`[java-reset] ${total} Klasse(n) entfernt`);
    return { deleted: total };
  }

  async deleteFile(idParam: string): Promise<void> {
    const id = Number(idParam);
    await this.ds.transaction(async (manager) => {
      // Klassennamen VOR dem Loeschen merken -> alle Kanten dieser Klasse mitentfernen.
      const file = await manager.getRepository(JavaFile).findOne({ where: { id } });
      await manager.query('DELETE FROM java_fts WHERE rowid = ?', [id]);
      await this.fts.removeJavaSources(manager, [id]);
      await manager.getRepository(JavaFile).delete({ id });
      // ALLE Kanten dieser Klasse entfernen (aktiv + manuell + verworfene Tombstones).
      // Sonst ueberleben verworfene Auto-Kanten (dismissed=1) das Loeschen/den Komplett-Reset
      // und unterdruecken die Neuberechnung beim erneuten Hinzufuegen derselben Klasse.
      if (file?.class_name) {
        await manager.query('DELETE FROM java_edges WHERE source_class = ? OR target_class = ?', [
          file.class_name,
          file.class_name,
        ]);
      }
      // Auto-Kanten neu berechnen -> Kanten der geloeschten Klasse verschwinden.
      await this.recomputeAutoEdges(manager);
    });
  }

  // Optional: erstellten Wiki-Artikel mit der Java-Datei verknuepfen (macht sie via FTS auffindbar).
  async linkArticle(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    if (!row) throw new NotFoundException('File not found');
    const articleId = body?.article_id ?? null;

    await this.ds.transaction(async (manager) => {
      await manager.getRepository(JavaFile).update({ id }, { article_id: articleId });
      if (articleId) await this.fts.indexArticle(manager, articleId);
    });

    const updated = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    return this.serializer.serializeJavaFile(updated);
  }

  // --- Call-Edges (Klassen-Graph) ------------------------------------------

  // Globale Neuberechnung der automatischen Call-Edges. Eine Kante A -> B(`m`) entsteht
  // nur, wenn A `m` auf etwas vom Typ B aufruft UND B `m` definiert (getypte Aufloesung).
  // HIGH (1.0): Empfaenger ueber Feld/Parameter/lokale Var/`new`/statischen Klassennamen
  // aufgeloest. LOW (0.5): unqualifizierter Aufruf, dessen Methode in GENAU einer anderen
  // Klasse definiert ist ("Bitte pruefen"). Manuelle (is_manual=1) und verworfene
  // (dismissed=1) Kanten bleiben unangetastet. Laeuft INNERHALB der Aufrufer-Transaktion.
  // Geparste Kanten-Infos je Datei, geschluesselt ueber den INHALT (sha1 des Rohquelltexts).
  // Der Hash statt einer Versionsspalte, weil damit KEIN Schreibpfad ein „invalidate" braucht:
  // genau diese Zeile vergisst man beim naechsten Endpunkt. Der Cache haelt nur so viele Eintraege,
  // wie es Klassen gibt (Aufraeumen s. recomputeAutoEdges) – er ist eine Beschleunigung, kein Zustand.
  private edgeParseCache = new Map<number, { hash: string; infos: JavaClassGraphInfo[] }>();

  // `jobId` schaltet den Live-Fortschritt ein (derselbe SSE-Strom wie analyze-batch/Reset). Die
  // Meldungen kommen aus dem Parse-Lauf, weil dort die Zeit vergeht – Kanten rechnen und schreiben
  // sind danach Millisekunden. Ohne jobId aendert sich nichts (emit ignoriert null).
  private async recomputeAutoEdges(manager: EntityManager, jobId?: string | null): Promise<void> {
    const files = await manager.getRepository(JavaFile).find();

    // Importe je Datei (FQCN, inkl. `p.q.*`). Sie sind der Grund, warum ein einfacher Typname
    // ueberhaupt eindeutig aufloesbar ist: bei zwei Klassen `Header` sagt erst der Import, welche
    // gemeint ist – genau wie beim Kompilieren.
    const importsByFile = new Map<number, string[]>();
    for (const d of await manager.getRepository(JavaDependency).find()) {
      const list = importsByFile.get(d.from_file_id);
      if (list) list.push(d.to_class_name);
      else importsByFile.set(d.from_file_id, [d.to_class_name]);
    }

    const classes: EdgeClass[] = [];
    const byFqcn = new Map<string, EdgeClass>();
    const byName = new Map<string, EdgeClass[]>();
    const definesMethod = new Map<string, Set<string>>(); // FQCN -> definierte Methoden
    const methodToClasses = new Map<string, Set<string>>(); // Methode -> definierende FQCNs

    // Eintraege geloeschter Klassen mitnehmen – sonst waechst der Cache mit jedem Reset weiter.
    const liveIds = new Set(files.map((f) => f.id));
    for (const id of this.edgeParseCache.keys()) if (!liveIds.has(id)) this.edgeParseCache.delete(id);

    let scanned = 0;
    this.progress.emit(jobId, { phase: 'edges', done: 0, total: files.length });
    for (const f of files) {
      // Der Parser ist der teure Teil dieser Funktion – und sie laeuft nach JEDEM Schreibvorgang
      // (analyze, analyze-batch, delete) einmal ueber die GESAMTE Codebasis. Gemessen ~6 ms je
      // 2,4-KB-Klasse auf einer Entwicklungsmaschine: eine Codebasis mit einigen tausend Klassen
      // parst der Pi damit minutenlang, bei jedem Klick auf „Recompute edges" erneut. Deshalb ein
      // Cache je Datei-Inhalt: der erste Lauf zahlt, jeder weitere zahlt nur fuer das, was sich
      // geaendert hat (bei einem Massen-Import also fuer die neuen Klassen statt fuer alle).
      const hash = createHash('sha1').update(f.raw_source || '').digest('hex');
      const cached = this.edgeParseCache.get(f.id);
      let infos: JavaClassGraphInfo[];
      if (cached && cached.hash === hash) {
        infos = cached.infos;
      } else {
        try {
          infos = parseJavaForEdges(f.raw_source);
        } catch {
          infos = []; // Parse-Fehler tolerieren (z. B. unvollstaendiger Code)
        }
        this.edgeParseCache.set(f.id, { hash, infos });
      }
      // Melden und Luft holen gehoeren ZUSAMMEN und stehen ausserhalb des Cache-Zweigs:
      //  * Ein Lauf ueber tausende Dateien blockiert den Event-Loop komplett – waehrenddessen
      //    antwortet der Server auf NICHTS, auch nicht auf das Queue-Polling (Regel wie in
      //    analyzeBatch, YIELD_EVERY).
      //  * Und ein `emit` ohne freien Event-Loop erreicht niemanden: die SSE-Antwort wird erst
      //    geschrieben, wenn der Stapel leer ist. Stand die Atempause nur im Cache-Miss-Zweig,
      //    kamen bei warmem Cache ALLE Ereignisse erst nach getaner Arbeit an – also nie.
      // Gezaehlt werden ALLE Dateien (auch die aus dem Cache), sonst stuende der Balken still,
      // waehrend die Neuberechnung laengst durchlaeuft.
      if (++scanned % YIELD_EVERY === 0) {
        this.progress.emit(jobId, { phase: 'edges', done: scanned, total: files.length });
        await breathe();
      }
      for (const info of infos) {
        const entry: EdgeClass = {
          fqcn: fqcnOf(f.pkg || '', info.class_name),
          name: info.class_name,
          pkg: f.pkg || '',
          info,
          imports: importsByFile.get(f.id) || [],
        };
        // Zwei Klassen mit demselben FQCN kann es nicht geben (der Import verwirft Dubletten und
        // meldet sie). Kommt es doch vor, gewinnt die erste – stabil statt zufaellig.
        if (byFqcn.has(entry.fqcn)) continue;
        byFqcn.set(entry.fqcn, entry);
        const sameName = byName.get(entry.name);
        if (sameName) sameName.push(entry);
        else byName.set(entry.name, [entry]);
        classes.push(entry);

        const dm = new Set<string>();
        definesMethod.set(entry.fqcn, dm);
        for (const m of info.definedMethods) {
          dm.add(m);
          let mc = methodToClasses.get(m);
          if (!mc) {
            mc = new Set();
            methodToClasses.set(m, mc);
          }
          mc.add(entry.fqcn);
        }
      }
    }

    // Parse durch – ab hier ist es Rechnen und Schreiben (Millisekunden). Der Balken steht damit
    // auf voll, waehrend der Rest laeuft, statt kurz vor Schluss haengenzubleiben.
    this.progress.emit(jobId, { phase: 'edges', done: files.length, total: files.length });

    // Einen einfachen Typnamen AUS SICHT VON `from` aufloesen – in Javas Reihenfolge. Das ist der
    // Kern der Eindeutigkeit: `Header` allein ist keine Klasse, `Header` in `efw.n8n` mit
    // `import efw.util.http.Header` schon.
    let ambiguous = 0;
    const resolveType = (from: EdgeClass, name: string): EdgeClass | null => {
      if (!name) return null;
      // 1. Eigenes Package – dafuer braucht Java keinen Import, und es schlaegt jeden Import.
      const own = byFqcn.get(fqcnOf(from.pkg, name));
      if (own) return own;
      // 2. Expliziter Import. Er ENTSCHEIDET: nennt er eine Klasse, die nicht analysiert ist, gibt
      //    es hier keine Kante – auf eine gleichnamige aus einem anderen Package auszuweichen
      //    waere nachweislich falsch, denn der Import sagt ausdruecklich etwas anderes.
      for (const imp of from.imports) {
        if (imp.endsWith('.*') || simpleOf(imp) !== name) continue;
        return byFqcn.get(imp) || null;
      }
      // 3. Wildcard-Import (`import p.q.*`) – benennt immerhin das Package.
      for (const imp of from.imports) {
        if (!imp.endsWith('.*')) continue;
        const hit = byFqcn.get(fqcnOf(imp.slice(0, -2), name));
        if (hit) return hit;
      }
      // 4. Der Name ist im Bestand eindeutig -> dann ist nichts offen. Das traegt Codebasen ohne
      //    gepflegte Importliste (Altbestand: java_dependencies leer) und Klassen aus derselben
      //    Datei. Ist er es NICHT und hat nichts oben entschieden, entsteht keine Kante: eine
      //    geratene waere hier genau der Fehler, den diese Umstellung beseitigt.
      const list = byName.get(name);
      if (list?.length === 1) return list[0];
      if (list?.length) ambiguous++;
      return null;
    };

    // Vererbung: Klasse -> AUFGELOESTE Ober-Typen (extends + implements). Ein unqualifizierter
    // Aufruf, den die Klasse selbst nicht definiert, landet zuerst bei einem Vorfahren – nicht bei
    // einer beliebigen anderen Klasse, die zufaellig denselben Methodennamen traegt.
    const superOf = new Map<string, EdgeClass[]>();
    for (const c of classes) {
      const list: EdgeClass[] = [];
      for (const t of c.info.superTypes || []) {
        const hit = resolveType(c, t);
        if (hit) list.push(hit);
      }
      superOf.set(c.fqcn, list);
    }
    // Kette hochlaufen, mit Besuchsmarkierung: zyklische Vererbung gibt es in gueltigem Java nicht,
    // in halb analysiertem Bestand aber sehr wohl.
    const resolveInherited = (A: EdgeClass, m: string): EdgeClass | null => {
      const seen = new Set<string>([A.fqcn]);
      const stack = [...(superOf.get(A.fqcn) || [])];
      while (stack.length) {
        const s = stack.pop() as EdgeClass;
        if (!s || seen.has(s.fqcn)) continue;
        seen.add(s.fqcn);
        if (definesMethod.get(s.fqcn)?.has(m)) return s;
        for (const up of superOf.get(s.fqcn) || []) stack.push(up);
      }
      return null;
    };

    const edges = new Map<
      string,
      { source: EdgeClass; target: EdgeClass; method: string | null; confidence: number; kind: string }
    >();
    const put = (A: EdgeClass | null, B: EdgeClass | null, m: string | null, c: number, kind: string) => {
      if (!A || !B || A.fqcn === B.fqcn) return;
      const key = `${A.fqcn}\u0000${B.fqcn}\u0000${m ?? ''}\u0000${kind}`;
      const prev = edges.get(key);
      if (!prev || c > prev.confidence) edges.set(key, { source: A, target: B, method: m, confidence: c, kind });
    };

    // Klassenpaare mit einer BENANNTEN Kante (Aufruf oder Feldzugriff) -> kein zusaetzliches
    // `uses` dafuer. `uses` ist der Rueckfall fuer „Typbezug, aber kein Mitglied benannt";
    // steht der Name schon am Pfeil, waere eine zweite, stummere Kante daneben nur Rauschen.
    const pairHasCall = new Set<string>();
    // Strukturell referenzierte Zielklassen je Quellklasse (Kandidaten fuer `uses`-Kanten).
    const usesTargets = new Map<string, { from: EdgeClass; targets: Map<string, EdgeClass> }>();
    const addUses = (A: EdgeClass, B: EdgeClass | null) => {
      if (!B || A.fqcn === B.fqcn) return;
      let e = usesTargets.get(A.fqcn);
      if (!e) {
        e = { from: A, targets: new Map() };
        usesTargets.set(A.fqcn, e);
      }
      e.targets.set(B.fqcn, B);
    };

    for (const A of classes) {
      const info = A.info;
      // Typ-Bezuege (Feld-/Variablen-/Parameter-/Rueckgabetyp, new X(), statischer Zugriff, Cast,
      // instanceof, catch, throws, extends/implements) als `uses`-Kandidaten.
      for (const t of info.referencedTypes) addUses(A, resolveType(A, t));

      // Feldzugriffe (`Http.GET`, `conn.timeout`) – eine eigene Kantenart, weil sie ein MITGLIED
      // benennt und damit nachpruefbar ist, anders als ein blosser Typbezug. Bedingung: die
      // Zielklasse deklariert das Feld auch. Ohne diese Pruefung stuende ein erfundener Name am
      // Pfeil, sobald der Empfaenger falsch aufgeloest wurde.
      for (const ref of info.fieldRefs || []) {
        const B = resolveType(A, ref.type);
        if (!B || B.fqcn === A.fqcn) continue;
        addUses(A, B); // ein aufgeloester Empfaenger ist immer auch ein Typbezug
        if (!Object.prototype.hasOwnProperty.call(B.info.fields, ref.field)) continue;
        put(A, B, ref.field, 1.0, 'field');
        pairHasCall.add(`${A.fqcn}\u0000${B.fqcn}`);
      }

      for (const caller of info.callers) {
        for (const inv of caller.invocations) {
          const m = inv.method;
          // Empfaengertyp B aufloesen: erst als Typname (`new B().m()`, statisch `B.m()`), sonst
          // ueber den Scope (Variable/Feld/Parameter -> Typ). Reihenfolge wie zuvor.
          let B: EdgeClass | null = null;
          if (inv.receiver) {
            B = resolveType(A, inv.receiver);
            if (!B) {
              const t = caller.scope[inv.receiver];
              if (t) B = resolveType(A, t);
            }
          }
          // Aufgeloester Empfaenger ist immer ein Typ-Bezug (auch ohne Methoden-Treffer).
          if (B) addUses(A, B);
          if (B && B.fqcn !== A.fqcn && definesMethod.get(B.fqcn)?.has(m)) {
            put(A, B, m, 1.0, 'call');
            pairHasCall.add(`${A.fqcn}\u0000${B.fqcn}`);
            continue;
          }
          // Empfaenger vorhanden, aber nicht aufloesbar (`foo().m()`, `a.b.m()`, `"x".m()`): hier
          // ist NICHTS offen, was Java fuer uns entscheiden wuerde – das Ziel haengt an einem Typ,
          // den wir nicht kennen. Alles Weitere unten gilt ausdruecklich nur fuer unqualifizierte
          // Aufrufe; ohne diese Zeile lief `reg.getWorkflows().entrySet()` in die Heuristik und
          // erzeugte eine Kante zu jeder eigenen Klasse, die zufaellig `entrySet()` definiert
          // (gemeldet an einem Interface `RequestParams` – getroffen wurde aber `Map.entrySet`).
          if (inv.receiverUnresolved) continue;
          // Unqualifizierter Aufruf (`m(…)`, `this.m(…)`, `super.m(…)`) – in Javas Reihenfolge
          // aufloesen, statt sofort zu raten. Vorher sprang die Berechnung direkt zur Heuristik
          // und erzeugte damit Kanten fuer Aufrufe, die die Klasse selbst beantwortet.
          if (inv.receiver === null) {
            // 1. Eigene Methode: ein unqualifizierter Aufruf bindet in Java IMMER zuerst an die
            //    eigene Klasse – dann gibt es hier gar keine Beziehung nach draussen.
            //    `super.m()` meint ausdruecklich die Oberklasse und ist ausgenommen.
            if (!inv.viaSuper && definesMethod.get(A.fqcn)?.has(m)) continue;
            // 2. Geerbt: der Vorfahre, der `m` definiert. Kein Raten – das steht im Code.
            const inherited = resolveInherited(A, m);
            if (inherited) {
              put(A, inherited, m, 1.0, 'call');
              pairHasCall.add(`${A.fqcn}\u0000${inherited.fqcn}`);
              continue;
            }
            // `super.m()` ohne analysierten Vorfahren: das Ziel ist bekannt (die Oberklasse), nur
            // nicht vorhanden. Eine geratene Kante waere hier nachweislich falsch.
            if (inv.viaSuper) continue;
            // 3. Statischer Import – der einzige legale Weg zu einer FREMDEN Klasse ohne Empfaenger.
            //    Der Parser liefert den EINFACHEN Namen der Traegerklasse; aufgeloest wird er wie
            //    jeder andere Typname, also ueber die Importe dieser Datei.
            const importedName = info.staticImports?.[m];
            let target: EdgeClass | null = importedName ? resolveType(A, importedName) : null;
            if (!target) {
              for (const c of info.staticWildcardTypes || []) {
                const hit = resolveType(A, c);
                if (hit && definesMethod.get(hit.fqcn)?.has(m)) {
                  target = hit;
                  break;
                }
              }
            }
            if (target) {
              put(A, target, m, 1.0, 'call');
              pairHasCall.add(`${A.fqcn}\u0000${target.fqcn}`);
              continue;
            }
            // 4. Rest: Methode in genau EINER anderen Klasse -> geraten, LOW ("Please review").
            //    Bleibt drin, weil Vererbung auch ueber NICHT analysierte Klassen laeuft
            //    (Framework-Basisklassen) und der Treffer dann oft stimmt – aber eben nur oft.
            //    Gezaehlt wird ueber FQCNs: zwei gleichnamige Klassen sind hier ZWEI Kandidaten,
            //    der Treffer also nicht mehr eindeutig – und genau das ist richtig so.
            const defs = methodToClasses.get(m);
            if (defs) {
              const others = [...defs].filter((c) => c !== A.fqcn);
              if (others.length === 1) {
                const only = byFqcn.get(others[0]);
                if (only) {
                  put(A, only, m, 0.5, 'call');
                  pairHasCall.add(`${A.fqcn}\u0000${only.fqcn}`);
                }
              }
            }
          }
        }
      }
    }

    // Struktur-Kanten (`uses`) nur, wo das Paar noch keine Methoden-Kante hat.
    for (const { from, targets } of usesTargets.values()) {
      for (const B of targets.values()) {
        if (pairHasCall.has(`${from.fqcn}\u0000${B.fqcn}`)) continue;
        put(from, B, null, 1.0, 'uses');
      }
    }

    const repo = manager.getRepository(JavaEdge);
    // Verworfene Auto-Kanten (Tombstones) merken -> NICHT neu erzeugen. Zwei Schluesselraeume:
    //  * exakt (mit Package) fuer alles, was seit der FQCN-Umstellung verworfen wurde,
    //  * nur ueber die Namen fuer Altbestand (Package NULL). Ein solcher Tombstone unterdrueckt
    //    JEDE gleichnamige Kante – konservativ, aber er laesst nie etwas wieder aufleben, das der
    //    Nutzer verworfen hat. Verwirft er es erneut, steht das Package drin und die Regel wird
    //    exakt. Ein neuer Tombstone landet deshalb NUR im exakten Raum.
    const dismissedRows = await repo.find({ where: { is_manual: 0, dismissed: 1 } });
    const tombExact = new Set<string>();
    const tombByName = new Set<string>();
    for (const e of dismissedRows) {
      const tail = `${e.method_name ?? ''}\u0000${e.kind}`;
      if (e.source_pkg != null && e.target_pkg != null) {
        tombExact.add(
          `${fqcnOf(e.source_pkg, e.source_class)}\u0000${fqcnOf(e.target_pkg, e.target_class)}\u0000${tail}`,
        );
      } else {
        tombByName.add(`${e.source_class}\u0000${e.target_class}\u0000${tail}`);
      }
    }

    // Nur aktive Auto-Kanten ersetzen; manuelle und Tombstone-Zeilen bleiben stehen.
    await repo.delete({ is_manual: 0, dismissed: 0 });

    const computed = [...edges.values()];
    const toInsert = computed
      .filter((e) => {
        const tail = `${e.method ?? ''}\u0000${e.kind}`;
        if (tombExact.has(`${e.source.fqcn}\u0000${e.target.fqcn}\u0000${tail}`)) return false;
        return !tombByName.has(`${e.source.name}\u0000${e.target.name}\u0000${tail}`);
      })
      .map((e) => ({
        source_class: e.source.name,
        source_pkg: e.source.pkg || null,
        target_class: e.target.name,
        target_pkg: e.target.pkg || null,
        method_name: e.method,
        confidence: e.confidence,
        kind: e.kind,
        is_manual: 0,
        dismissed: 0,
      }));
    if (toInsert.length) await insertChunked(repo, toInsert);

    // --- Debug-Log (docker logs wikit-backend): zeigt, was berechnet/gefiltert/eingefuegt wurde ---
    const byKind = computed.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] || 0) + 1;
      return acc;
    }, {});
    const suppressed = computed.length - toInsert.length;
    // Klassennamen nur bei ueberschaubarem Bestand ausschreiben: bei einigen tausend Klassen
    // waere das eine Logzeile von zig Kilobyte – bei JEDER Analyse, jedem Delete, jedem
    // Recompute. Die Zahl ist die Aussage, die Liste war nur zum Nachsehen bei wenigen Klassen.
    const NAME_LIST_MAX = 40;
    const nameList = byFqcn.size <= NAME_LIST_MAX ? ` [${[...byFqcn.keys()].join(', ')}]` : '';
    // `mehrdeutig` zaehlt Typnamen, die weder Package noch Import noch Eindeutigkeit klaeren
    // konnten – dort entsteht bewusst KEINE Kante. Steht die Zahl hoch, fehlen Importe.
    this.logger.log(
      `[java-edges] recompute: ${byFqcn.size} Klassen${nameList} | ` +
        `berechnet ${computed.length} ${JSON.stringify(byKind)} | ` +
        `mehrdeutig ${ambiguous} | ` +
        `Tombstones ${tombExact.size + tombByName.size}, davon unterdrueckt ${suppressed} | ` +
        `eingefuegt ${toInsert.length}`,
    );
  }

  // Manueller Trigger: alle Auto-Call-Edges neu berechnen + persistieren. Sinnvoll nach
  // Massen-Imports, bei denen Kanten ueber mehrere Analyse-Laeufe hinweg evtl. unvollstaendig
  // sind. Manuelle/verworfene Kanten bleiben erhalten. Eigene Transaktion (kein Aufrufer-Kontext).
  // Optionale `jobId` -> Live-Fortschritt ueber denselben SSE-Strom wie analyze-batch/Reset.
  // `done` wird auch im Fehlerfall gemeldet: ein Balken, der ohne Abschluss stehenbleibt, ist
  // schlimmer als gar keiner – der Client wuerde ewig auf das Ende warten.
  async recomputeEdges(jobId?: string | null): Promise<{ recomputed: true; count: number }> {
    try {
      await this.ds.transaction(async (manager) => {
        await this.recomputeAutoEdges(manager, jobId);
      });
    } catch (e) {
      this.progress.emit(jobId, { phase: 'error', message: (e as Error)?.message || 'Recompute failed' });
      throw e;
    }
    const count = await this.ds.getRepository(JavaEdge).count({ where: { dismissed: 0 } });
    this.progress.emit(jobId, { phase: 'done', done: count, total: count });
    return { recomputed: true, count };
  }

  private serializeEdge(e: JavaEdge): any {
    return {
      id: e.id,
      source_class: e.source_class,
      target_class: e.target_class,
      // Der Client ordnet die Kante damit EXAKT einer Datei zu, statt ueber den mehrdeutigen
      // Namen zu raten. NULL bei Altbestand -> dort bleibt es bei der Namensaufloesung.
      source_pkg: e.source_pkg ?? null,
      target_pkg: e.target_pkg ?? null,
      method_name: e.method_name,
      is_manual: !!e.is_manual,
      confidence: e.confidence,
      kind: e.kind,
    };
  }

  // Alle sichtbaren Kanten (auto + manuell, ohne Tombstones).
  async listEdges(): Promise<any[]> {
    const rows = await this.ds.getRepository(JavaEdge).find({ where: { dismissed: 0 }, order: { id: 'ASC' } });
    return rows.map((e) => this.serializeEdge(e));
  }

  // Manuelle Kante anlegen ({ source, target, methodName, sourcePkg?, targetPkg? }).
  // Die Packages sind optional: ohne sie bleibt die Kante namensbasiert (und damit bei zwei
  // gleichnamigen Klassen mehrdeutig) – der Client schickt sie mit, weil er die Datei kennt.
  async createEdge(body: any): Promise<any> {
    const source = (body?.source ?? body?.source_class ?? '').toString().trim();
    const target = (body?.target ?? body?.target_class ?? '').toString().trim();
    const methodName = (body?.methodName ?? body?.method_name ?? '').toString().trim();
    const sourcePkg = (body?.sourcePkg ?? body?.source_pkg ?? '').toString().trim();
    const targetPkg = (body?.targetPkg ?? body?.target_pkg ?? '').toString().trim();
    if (!source || !target) throw new BadRequestException('Source and target class are required');

    const repo = this.ds.getRepository(JavaEdge);
    const res = await repo.insert({
      source_class: source,
      source_pkg: sourcePkg || null,
      target_class: target,
      target_pkg: targetPkg || null,
      method_name: methodName || null,
      is_manual: 1,
      dismissed: 0,
      confidence: 1.0,
    });
    const id = res.identifiers[0].id as number;
    const row = await repo.findOne({ where: { id } });
    return this.serializeEdge(row!);
  }

  // Kante bearbeiten (Methodenname und/oder Quelle/Ziel).
  async updateEdge(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const repo = this.ds.getRepository(JavaEdge);
    const row = await repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Edge not found');

    const patch: Partial<JavaEdge> = {};
    if (body?.methodName !== undefined || body?.method_name !== undefined) {
      patch.method_name = (body.methodName ?? body.method_name ?? '').toString().trim() || null;
    }
    // Klasse und Package gehoeren ZUSAMMEN: wer die Quelle umhaengt, benennt damit eine andere
    // Klasse – bliebe das alte Package stehen, zeigte die Kante auf eine Klasse, die es so nicht
    // gibt. Fehlt das Package im Body, wird es geleert statt beibehalten.
    if (body?.source !== undefined || body?.source_class !== undefined) {
      const s = (body.source ?? body.source_class ?? '').toString().trim();
      if (!s) throw new BadRequestException('The source class must not be empty');
      patch.source_class = s;
      patch.source_pkg = (body.sourcePkg ?? body.source_pkg ?? '').toString().trim() || null;
    }
    if (body?.target !== undefined || body?.target_class !== undefined) {
      const t = (body.target ?? body.target_class ?? '').toString().trim();
      if (!t) throw new BadRequestException('The target class must not be empty');
      patch.target_class = t;
      patch.target_pkg = (body.targetPkg ?? body.target_pkg ?? '').toString().trim() || null;
    }
    // dismissed zuruecksetzen -> "Rueckgaengig" einer verworfenen Auto-Kante.
    if (body?.dismissed !== undefined) patch.dismissed = body.dismissed ? 1 : 0;
    if (Object.keys(patch).length) await repo.update({ id }, patch);

    const updated = await repo.findOne({ where: { id } });
    return this.serializeEdge(updated!);
  }

  // Kante loeschen. Manuell -> hart loeschen. Auto -> als Tombstone (dismissed=1) merken,
  // damit sie bei der naechsten Neuanalyse NICHT wieder erscheint.
  async deleteEdge(idParam: string): Promise<void> {
    const id = Number(idParam);
    const repo = this.ds.getRepository(JavaEdge);
    const row = await repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Edge not found');
    if (row.is_manual) await repo.delete({ id });
    else await repo.update({ id }, { dismissed: 1 });
  }
}
