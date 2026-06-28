import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { SerializerService } from '../common/serializer.service';
import { parseJava, parseJavaForEdges, splitJavaSources, JavaClassGraphInfo } from '../common/java-parser';
import { JavaDependency } from '../entities/java-dependency.entity';
import { JavaEdge } from '../entities/java-edge.entity';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';

// Java-Code-Analyse: parsen (rein JS), speichern, Graph liefern, KI-Summaries on-demand.
// Muster wie ArticlesService: erst async arbeiten, DANN in einer ds.transaction() schreiben.
@Injectable()
export class JavaService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly serializer: SerializerService,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
    private readonly fts: FtsService,
  ) {}

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  // Datei analysieren: parsen + speichern (ohne KI -> Graph erscheint sofort).
  async analyze(body: any): Promise<any> {
    const b = body || {};
    const { source = '', filename = '' } = b;
    if (!source.trim()) throw new BadRequestException('Quellcode ist erforderlich');

    let parsed;
    try {
      parsed = parseJava(source);
    } catch (e: any) {
      throw new BadRequestException(`Parsen fehlgeschlagen: ${e.message}`);
    }

    const cls = parsed.primary;
    const name = (filename && filename.trim()) || `${cls.class_name}.java`;

    let fileId!: number;
    await this.ds.transaction(async (manager) => {
      const res = await manager.getRepository(JavaFile).insert({
        filename: name,
        pkg: parsed.package || null,
        class_name: cls.class_name,
        class_type: cls.class_type,
        raw_source: source,
        class_line: cls.class_line ?? null,
      });
      fileId = res.identifiers[0].id as number;

      for (const m of cls.methods) {
        // ai_summary initial = Javadoc-Fallback (KI spaeter on-demand pro Methode).
        await manager.getRepository(JavaMethod).insert({
          file_id: fileId,
          method_name: m.method_name,
          return_type: m.return_type,
          parameters: JSON.stringify(m.parameters),
          javadoc: m.javadoc || '',
          ai_summary: m.javadoc || '',
          body: m.body || '',
          start_line: m.start_line ?? null,
          body_start_line: m.body_start_line ?? null,
        });
      }

      for (const fqn of parsed.imports) {
        await manager.getRepository(JavaDependency).insert({ from_file_id: fileId, to_class_name: fqn });
      }

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
    if (!source.trim()) throw new BadRequestException('Quellcode ist erforderlich');

    // 1) In eigenstaendige Klassen-Chunks zerlegen + je Chunk parsen (nur Top-Level-Typ).
    const chunks = splitJavaSources(source);
    const warnings: string[] = [];
    const seen = new Set<string>(); // FQCN -> bereits im Paste vorgekommen
    const items: Array<{ fqcn: string; pkg: string | null; cls: any; imports: string[]; chunk: string }> = [];

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let parsed;
      try {
        parsed = parseJava(chunk);
      } catch (e: any) {
        throw new BadRequestException(`Parsen fehlgeschlagen: ${e.message}`);
      }
      const cls = parsed.primary; // genau ein Top-Level-Typ pro Chunk (Splitter)
      const pkg = parsed.package || null;
      const fqcn = (pkg ? pkg + '.' : '') + cls.class_name;
      if (seen.has(fqcn)) {
        warnings.push(`Doppelte Klasse „${fqcn}" im Paste – nur das erste Vorkommen wurde übernommen.`);
        continue;
      }
      seen.add(fqcn);
      items.push({ fqcn, pkg, cls, imports: parsed.imports, chunk });
    }

    if (!items.length) throw new BadRequestException('Keine Klasse/Interface/Enum im Quelltext gefunden');

    // 2) DB-Duplikate (class_name + package) ermitteln.
    const repo = this.ds.getRepository(JavaFile);
    const existingByFqcn = new Map<string, JavaFile>();
    for (const it of items) {
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

    // 4) Schreiben: je Klasse insert; bei Konflikt den alten Datensatz vorher loeschen
    //    (java_fts-Zeile + Datei -> CASCADE raeumt Methoden/Dependencies, wie deleteFile()).
    const savedIds: number[] = [];
    const overwritten: string[] = [];
    await this.ds.transaction(async (manager) => {
      for (const it of items) {
        const existing = existingByFqcn.get(it.fqcn);
        if (existing) {
          await manager.query('DELETE FROM java_fts WHERE rowid = ?', [existing.id]);
          await manager.getRepository(JavaFile).delete({ id: existing.id });
          overwritten.push(it.fqcn);
        }

        const res = await manager.getRepository(JavaFile).insert({
          filename: `${it.cls.class_name}.java`,
          pkg: it.pkg,
          class_name: it.cls.class_name,
          class_type: it.cls.class_type,
          raw_source: it.chunk,
          class_line: it.cls.class_line ?? null,
        });
        const fileId = res.identifiers[0].id as number;

        for (const m of it.cls.methods) {
          await manager.getRepository(JavaMethod).insert({
            file_id: fileId,
            method_name: m.method_name,
            return_type: m.return_type,
            parameters: JSON.stringify(m.parameters),
            javadoc: m.javadoc || '',
            ai_summary: m.javadoc || '',
            body: m.body || '',
            start_line: m.start_line ?? null,
            body_start_line: m.body_start_line ?? null,
          });
        }
        for (const fqn of it.imports) {
          await manager.getRepository(JavaDependency).insert({ from_file_id: fileId, to_class_name: fqn });
        }

        await this.fts.indexJavaFile(manager, fileId);
        savedIds.push(fileId);
      }

      // Einmalig nach allen Inserts: Call-Edges global neu berechnen.
      await this.recomputeAutoEdges(manager);
    });

    // Reihenfolge wie savedIds beibehalten (find() sortiert nicht garantiert).
    const savedRows = await repo.find({ where: { id: In(savedIds) } });
    const byId = new Map(savedRows.map((r) => [r.id, r]));
    const saved = await Promise.all(
      savedIds.map((id) => this.serializer.serializeJavaFile(byId.get(id), { withSource: true })),
    );

    return {
      saved,
      graph: await this.serializer.graphForJavaFiles(),
      warnings,
      overwritten,
    };
  }

  // Liste aller analysierten Dateien (ohne raw_source). COLLATE NOCASE -> Raw-SQL.
  async listFiles(): Promise<any[]> {
    const rows = await this.ds.query('SELECT * FROM java_files ORDER BY class_name COLLATE NOCASE');
    return Promise.all(rows.map((r: any) => this.serializer.serializeJavaFile(r)));
  }

  // Globaler Abhaengigkeitsgraph (Knoten = Klassen, Kanten = interne Imports).
  async graph(): Promise<any> {
    return this.serializer.graphForJavaFiles();
  }

  // Detail einer Datei inkl. Methoden, Dependencies und Quelltext.
  async getFile(idParam: string): Promise<any> {
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id: Number(idParam) } });
    if (!row) throw new NotFoundException('Datei nicht gefunden');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Quellcode EINER Methode als Shiki-gehighlightetes HTML (fuers Graph-Edge-Panel).
  // Rein lesend + Render -> KEINE Transaktion noetig. Das HTML kommt aus dem vorhandenen
  // Markdown-Primitiv (Dual-Theme, defaultColor:false) inkl. sanitize-html -> kein Extra-Sanitizing.
  async getMethodSnippet(fileIdParam: string, methodNameParam: string): Promise<any> {
    const fileId = Number(fileIdParam);
    const methodName = (methodNameParam || '').toString().trim();
    if (!fileId || !methodName) {
      throw new BadRequestException('fileId und methodName sind erforderlich');
    }

    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    // Overloads teilen sich den Namen -> erste Methode (ORDER BY id, wie ueberall im Serializer).
    const method = await this.ds.getRepository(JavaMethod).findOne({
      where: { file_id: fileId, method_name: methodName },
      order: { id: 'ASC' },
    });
    if (!method) {
      throw new NotFoundException(`Methode "${methodName}" in ${file.class_name} nicht gefunden`);
    }

    const parameters = this.safeJson(method.parameters, []);
    const signature = this.serializer.buildSignature({ ...method, parameters });
    // Interface-/abstract-Methoden haben keinen Body -> dann die Signatur als Snippet zeigen.
    const code = method.body && method.body.trim() ? method.body : `${signature};`;
    // Zeile: gespeicherter Wert (neu analysiert) oder Fallback aus dem Rohquelltext (Bestandsdaten).
    const startLine = method.start_line ?? this.findMethodLine(file.raw_source, methodName);

    const { html } = await this.markdown.renderMarkdown('```java\n' + code + '\n```');
    return { code, startLine, html, signature, className: file.class_name, methodName };
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
    if (!method) throw new NotFoundException('Methode nicht gefunden');
    const file = await this.ds
      .getRepository(JavaFile)
      .findOne({ where: { id: method.file_id }, select: { class_name: true } });

    const summary = await this.ollama.generateMethodDescription({
      className: file?.class_name || '',
      method: { ...method, parameters: this.safeJson(method.parameters, []) },
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
      method: { ...updated, parameters: this.safeJson(updated!.parameters, []) },
      summary_html: summaryHtml,
      ollama_unavailable: ollamaUnavailable,
    };
  }

  // On-demand KI-Beschreibung fuer die GANZE Klasse (async, ausserhalb der Transaktion).
  // Reuse der vorhandenen Spalten description/description_html/generated_at -> kein Schema-Aenderung.
  // Das Setzen von description flippt den Graph-Knoten auf analyzed: true (Serializer).
  async summarizeClass(idParam: string, body?: any): Promise<any> {
    const id = Number(idParam);
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    const methods = await this.ds
      .getRepository(JavaMethod)
      .find({ where: { file_id: id }, select: { method_name: true } });

    const summary = await this.ollama.generateClassSummary({
      classInfo: {
        class_name: file.class_name,
        class_type: file.class_type,
        package: file.pkg,
        methods: methods.map((m) => ({ method_name: m.method_name })),
      },
      context: body?.userContext,
    });

    // Fallback: ist Ollama nicht erreichbar, bleibt die bisherige Beschreibung erhalten.
    const ollamaUnavailable = !summary;
    const finalDescription = summary || file.description || '';

    // Markdown -> HTML vor der Transaktion rendern (async/teuer ausserhalb der Tx).
    const { html: descriptionHtml } = await this.markdown.renderMarkdown(finalDescription);
    const generatedAt = new Date().toISOString();

    await this.ds.transaction(async (manager) => {
      await manager
        .getRepository(JavaFile)
        .update({ id }, { description: finalDescription, description_html: descriptionHtml, generated_at: generatedAt });
      await this.fts.indexJavaFile(manager, id);
    });

    const updated = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    return {
      file: await this.serializer.serializeJavaFile(updated, { withSource: true }),
      description_html: descriptionHtml,
      ollama_unavailable: ollamaUnavailable,
    };
  }

  // Java-Datei zu einem Artikel (article_id) holen -> Live-Panel auf dem Wiki-Artikel.
  // Liefert null (Controller -> 404), wenn der Artikel keine verknuepfte Klasse hat.
  async getFileByArticle(articleIdParam: string): Promise<any> {
    const articleId = Number(articleIdParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { article_id: articleId } });
    if (!row) throw new NotFoundException('Keine Java-Klasse mit diesem Artikel verknuepft');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Datei + Methoden + Dependencies loeschen (CASCADE ueber FK). Verknuepfter Artikel bleibt
  // bestehen (FK ist andersherum: article -> SET NULL). Der java_fts-Eintrag (rowid = id) wird
  // nicht per Trigger gepflegt -> hier explizit entfernen, sonst bleibt er verwaist.
  async deleteFile(idParam: string): Promise<void> {
    const id = Number(idParam);
    await this.ds.transaction(async (manager) => {
      await manager.query('DELETE FROM java_fts WHERE rowid = ?', [id]);
      await manager.getRepository(JavaFile).delete({ id });
      // Auto-Kanten neu berechnen -> Kanten der geloeschten Klasse verschwinden.
      await this.recomputeAutoEdges(manager);
    });
  }

  // Optional: erstellten Wiki-Artikel mit der Java-Datei verknuepfen (macht sie via FTS auffindbar).
  async linkArticle(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    if (!row) throw new NotFoundException('Datei nicht gefunden');
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
  private async recomputeAutoEdges(manager: EntityManager): Promise<void> {
    const files = await manager.getRepository(JavaFile).find();

    const definesMethod = new Map<string, Set<string>>(); // Klasse -> definierte Methoden
    const methodToClasses = new Map<string, Set<string>>(); // Methode -> definierende Klassen
    const classNames = new Set<string>();
    const parsed: JavaClassGraphInfo[] = [];

    for (const f of files) {
      let infos: JavaClassGraphInfo[] = [];
      try {
        infos = parseJavaForEdges(f.raw_source);
      } catch {
        continue; // Parse-Fehler tolerieren (z. B. unvollstaendiger Code)
      }
      for (const info of infos) {
        classNames.add(info.class_name);
        let dm = definesMethod.get(info.class_name);
        if (!dm) {
          dm = new Set();
          definesMethod.set(info.class_name, dm);
        }
        for (const m of info.definedMethods) {
          dm.add(m);
          let mc = methodToClasses.get(m);
          if (!mc) {
            mc = new Set();
            methodToClasses.set(m, mc);
          }
          mc.add(info.class_name);
        }
        parsed.push(info);
      }
    }

    const edges = new Map<
      string,
      { source: string; target: string; method: string | null; confidence: number; kind: string }
    >();
    const put = (A: string, B: string, m: string | null, c: number, kind: string) => {
      if (!A || !B || A === B) return;
      const key = `${A} ${B} ${m ?? ''} ${kind}`;
      const prev = edges.get(key);
      if (!prev || c > prev.confidence) edges.set(key, { source: A, target: B, method: m, confidence: c, kind });
    };

    // Klassenpaare mit bereits erkannter Methoden-Kante -> kein zusaetzliches `uses` dafuer.
    const pairHasCall = new Set<string>();
    // Strukturell referenzierte Zielklassen je Quellklasse (Kandidaten fuer `uses`-Kanten).
    const usesTargets = new Map<string, Set<string>>();
    const addUses = (A: string, B: string) => {
      if (!B || A === B || !classNames.has(B)) return;
      let s = usesTargets.get(A);
      if (!s) {
        s = new Set();
        usesTargets.set(A, s);
      }
      s.add(B);
    };

    for (const info of parsed) {
      const A = info.class_name;
      // Typ-Bezuege (Feld-/Variablen-/Parameter-/Rueckgabetyp, new X()) als `uses`-Kandidaten.
      for (const t of info.referencedTypes) addUses(A, t);
      for (const caller of info.callers) {
        for (const inv of caller.invocations) {
          const m = inv.method;
          // Empfaengertyp B aufloesen.
          let B: string | null = null;
          if (inv.receiver) {
            if (inv.receiverIsNew && classNames.has(inv.receiver)) B = inv.receiver; // new B().m()
            else if (classNames.has(inv.receiver)) B = inv.receiver; // statisch: B.m()
            else {
              const t = caller.scope[inv.receiver]; // Variable/Feld/Parameter -> Typ
              if (t && classNames.has(t)) B = t;
            }
          }
          // Aufgeloester Empfaenger ist immer ein Typ-Bezug (auch ohne Methoden-Treffer).
          if (B) addUses(A, B);
          if (B && B !== A && definesMethod.get(B)?.has(m)) {
            put(A, B, m, 1.0, 'call');
            pairHasCall.add(`${A} ${B}`);
            continue;
          }
          // LOW-Fallback: unqualifizierter Aufruf, Methode in genau einer anderen Klasse.
          if (inv.receiver === null) {
            const defs = methodToClasses.get(m);
            if (defs) {
              const others = [...defs].filter((c) => c !== A);
              if (others.length === 1) {
                put(A, others[0], m, 0.5, 'call');
                pairHasCall.add(`${A} ${others[0]}`);
              }
            }
          }
        }
      }
    }

    // Struktur-Kanten (`uses`) nur, wo das Paar noch keine Methoden-Kante hat.
    for (const [A, targets] of usesTargets) {
      for (const B of targets) {
        if (pairHasCall.has(`${A} ${B}`)) continue;
        put(A, B, null, 1.0, 'uses');
      }
    }

    const repo = manager.getRepository(JavaEdge);
    // Verworfene Auto-Kanten (Tombstones) merken -> NICHT neu erzeugen.
    const dismissedRows = await repo.find({ where: { is_manual: 0, dismissed: 1 } });
    const dismissedKeys = new Set(
      dismissedRows.map((e) => `${e.source_class} ${e.target_class} ${e.method_name ?? ''} ${e.kind}`),
    );

    // Nur aktive Auto-Kanten ersetzen; manuelle und Tombstone-Zeilen bleiben stehen.
    await repo.delete({ is_manual: 0, dismissed: 0 });

    const toInsert = [...edges.values()]
      .filter((e) => !dismissedKeys.has(`${e.source} ${e.target} ${e.method ?? ''} ${e.kind}`))
      .map((e) => ({
        source_class: e.source,
        target_class: e.target,
        method_name: e.method,
        confidence: e.confidence,
        kind: e.kind,
        is_manual: 0,
        dismissed: 0,
      }));
    if (toInsert.length) await repo.insert(toInsert);
  }

  // Manueller Trigger: alle Auto-Call-Edges neu berechnen + persistieren. Sinnvoll nach
  // Massen-Imports, bei denen Kanten ueber mehrere Analyse-Laeufe hinweg evtl. unvollstaendig
  // sind. Manuelle/verworfene Kanten bleiben erhalten. Eigene Transaktion (kein Aufrufer-Kontext).
  async recomputeEdges(): Promise<{ recomputed: true; count: number }> {
    await this.ds.transaction(async (manager) => {
      await this.recomputeAutoEdges(manager);
    });
    const count = await this.ds.getRepository(JavaEdge).count({ where: { dismissed: 0 } });
    return { recomputed: true, count };
  }

  private serializeEdge(e: JavaEdge): any {
    return {
      id: e.id,
      source_class: e.source_class,
      target_class: e.target_class,
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

  // Manuelle Kante anlegen ({ source, target, methodName }).
  async createEdge(body: any): Promise<any> {
    const source = (body?.source ?? body?.source_class ?? '').toString().trim();
    const target = (body?.target ?? body?.target_class ?? '').toString().trim();
    const methodName = (body?.methodName ?? body?.method_name ?? '').toString().trim();
    if (!source || !target) throw new BadRequestException('Quell- und Zielklasse sind erforderlich');

    const repo = this.ds.getRepository(JavaEdge);
    const res = await repo.insert({
      source_class: source,
      target_class: target,
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
    if (!row) throw new NotFoundException('Kante nicht gefunden');

    const patch: Partial<JavaEdge> = {};
    if (body?.methodName !== undefined || body?.method_name !== undefined) {
      patch.method_name = (body.methodName ?? body.method_name ?? '').toString().trim() || null;
    }
    if (body?.source !== undefined || body?.source_class !== undefined) {
      const s = (body.source ?? body.source_class ?? '').toString().trim();
      if (!s) throw new BadRequestException('Quellklasse darf nicht leer sein');
      patch.source_class = s;
    }
    if (body?.target !== undefined || body?.target_class !== undefined) {
      const t = (body.target ?? body.target_class ?? '').toString().trim();
      if (!t) throw new BadRequestException('Zielklasse darf nicht leer sein');
      patch.target_class = t;
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
    if (!row) throw new NotFoundException('Kante nicht gefunden');
    if (row.is_manual) await repo.delete({ id });
    else await repo.update({ id }, { dismissed: 1 });
  }
}
