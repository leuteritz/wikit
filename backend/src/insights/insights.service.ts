import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { safeJson } from '../common/json.util';
import { classMetrics } from '../common/code-metrics';
import { buildSplitPlan, SplitConsumer, SplitMember } from './split-plan';
import { buildTestShadow, ShadowImport } from './test-shadow';
import {
  againstLayers,
  checkRules,
  layerCheckFrom,
  parseRules,
  Rule,
  suggestRules,
} from './arch-rules';
import { chainPairs, pairKey, partitionCycles } from './cycle-diff';
import { applyChanges, Change } from './what-if';
import { Setting } from '../entities/setting.entity';
import { CodeFormatterService } from '../common/code-formatter.service';
import { MarkdownService } from '../common/markdown.service';

// Wie viele Klassen ein Nachtrags-Haeppchen umfasst. Der Lauf liest `raw_source` – die groesste
// Spalte der Datenbank –, deshalb bewusst klein: zwischen zwei Haeppchen bekommt der Event-Loop
// die Kontrolle zurueck, sonst antwortet der Server waehrend des Nachtrags auf nichts.
const BACKFILL_CHUNK = 40;

// Wie viele Knoten einer Zyklengruppe als Startpunkt fuer die Suche nach dem kuerzesten Kreis
// dienen. Eine grosse verklebte Gruppe (gemessen: 300 Klassen in einem einzigen SCC) haette sonst
// 300 BFS-Laeufe, und der 300. findet keinen kuerzeren Kreis als die ersten zwoelf.
const CYCLE_PROBE_NODES = 12;

// Wie viele tragende Klassenpaare eine Package-Kante namentlich nennt. Mehr liest niemand, und die
// Restzahl daneben sagt, dass es mehr sind.
const LINK_SAMPLE = 6;

// Wie viele Mitglieder (Methoden/Felder) ein Paar namentlich mitfuehrt. Das Beispiel im Plan nennt
// eines beim Namen; drei reichen, um zu sehen, ob es eines oder viele sind.
const MEMBER_SAMPLE = 3;

// --- Deckel des Sandkastens ---------------------------------------------------------------------
//
// Ein Umbau kann hunderte Klassen bewegen; die Bilanz soll trotzdem auf einen Blick lesbar bleiben.
// Was wegfaellt, wird GEZAEHLT – ein stiller Deckel liest sich wie „mehr ist da nicht".
const SIM_CYCLE_SAMPLE = 8;
const SIM_CLASS_SAMPLE = 12;
// Wie viele Klassen ein Zyklus namentlich nennt – dieselbe Groessenordnung wie im Drift-Bericht.
const SIM_CYCLE_NAMES = 8;
// Ab welcher Verschiebung eine Klasse ueberhaupt in der Liste steht. Faellt eine Klasse weg,
// bewegen sich ALLE Raenge ein wenig (der Score ist ein Rang innerhalb seines eigenen Bestands);
// ohne diese Schwelle bestuende die Liste aus lauter Einer-Verschiebungen, die niemand verursacht
// hat, und die zwei echten Aenderungen stuenden mittendrin.
const SIM_SCORE_NOISE = 2;

// Gewichte des Hotspot-Scores. Verzweigungsdichte vor Groesse vor Kopplung: eine lange, aber
// geradlinige Klasse liest sich, eine kurze mit zwanzig Verzweigungen nicht.
const W_COMPLEXITY = 0.4;
const W_LOC = 0.35;
const W_COUPLING = 0.25;
// Wie stark die Aenderungshaeufigkeit den Strukturanteil anhebt. Ein Faktor und kein Summand: eine
// Klasse, die niemand anfasst, ist auch dann kein Brandherd, wenn sie gross ist – aber eine grosse,
// die staendig angefasst wird, ist einer. Bei 0,5 kann Churn den Score hoechstens um die Haelfte
// anheben; die Struktur bleibt die fuehrende Aussage.
const CHURN_WEIGHT = 0.5;

// --- Was von aussen hereinkommt (Reiter "Outside") ----------------------------------------------
//
// Wie viele Typen ein externes Package namentlich nennt. Der Rest wird gezaehlt – ein Package wie
// `java.util` traegt dreissig Typen, und die letzten zwanzig sagen ueber die Abhaengigkeit nichts
// mehr, was die ersten zwoelf nicht schon sagen.
const OUTSIDE_TYPE_SAMPLE = 12;
// Wie viele benutzende Klassen ein externer Typ namentlich nennt. Sie sind der Absprung nach
// `/code` – mehr als eine Handvoll klickt niemand durch.
const OUTSIDE_USER_SAMPLE = 6;
// Wie viele Packages je Gruppe. Bei einem Ausschnitt aus einer grossen Fremdcodebasis sind es sonst
// hunderte, und die unteren haengen an einer einzigen Importzeile. Der Deckel gilt JE GRUPPE, nicht
// insgesamt: sonst verdraengten die vierzig meistbenutzten Fremd-Packages genau die Luecken, um
// derentwillen es den Reiter gibt.
const OUTSIDE_PACKAGE_SAMPLE = 40;

// Was zur Plattform gehoert und deshalb nie "fehlt". Praefixe statt einer Namensliste: `java.util`
// und `java.util.concurrent` sind dieselbe Herkunft. `javax`/`jakarta` stehen bewusst dabei – sie
// sind formal Bibliotheken, aber niemand wuerde `javax.servlet.HttpServletRequest` in sein Wikit
// laden wollen, und in der Gruppe "third-party" waeren sie nur Rauschen vor den echten Funden.
const PLATFORM_PREFIXES = [
  'java', 'javax', 'jakarta', 'jdk', 'sun', 'com.sun', 'org.w3c', 'org.xml', 'org.ietf',
];

// Kantenarten nach "wie schwer ist sie aufzuloesen" – die Reihenfolge, in der ein Zyklus
// aufgebrochen werden sollte. Ein Typbezug (`uses`) laesst sich oft durch ein Interface ersetzen,
// ein echter Methodenaufruf selten.
const BREAK_ORDER: Record<string, number> = { uses: 0, field: 1, call: 2 };

// Die Schicht-Konvention (LAYER_RANK, layerOf, againstLayers) steht in `arch-rules.ts`: sie ist der
// RUECKFALL fuer den Fall, dass niemand Schichten aufgeschrieben hat, und dieselbe Liste erzeugt
// dort den Vorschlag "diese vier Schichten liegen bei dir – als Regel festhalten?". Zwei Fassungen
// waeren zwei Konventionen.

// Wo der Regeltext liegt. Eine Zeile in der generischen `settings`-Tabelle statt einer eigenen:
// eine FEHLENDE Zeile heisst "keine Regeln", und genau diese Unterscheidung braucht die Ansicht
// (leeres Textfeld vs. bewusst geleert ist derselbe Zustand – niemand hat etwas festgelegt).
const RULES_KEY = 'arch.rules';

export type ClassRow = {
  id: number;
  package: string | null;
  class_name: string;
  class_type: string | null;
  stereotype: string | null;
  class_modifiers: string | null;
  loc: number | null;
  complexity: number | null;
};

export type EdgeRow = {
  source_class: string;
  source_pkg: string | null;
  target_class: string;
  target_pkg: string | null;
  kind: string | null;
  confidence: number | null;
  method_name: string | null;
};

// Ein aufgeloestes Klassenpaar mit allem, was die Bruchstellen-Empfehlung braucht.
// `members` sind die Methoden-/Feldnamen, ueber die das Paar zusammenhaengt – ohne sie liesse sich
// kein Beispiel schreiben, das die Stelle beim Namen nennt („escape()" statt „the member").
export type Pair = { from: number; to: number; count: number; kind: string; confidence: number; members: string[] };

// --- Eine Importzeile zerlegen ------------------------------------------------------------------
//
// ⚠️ Der letzte Punkt trennt NICHT Package und Typ. `com.acme.util.KeyVal.Pair` ist ein genesteter
// Typ und `com.acme.util.Strings.escape` ein statischer Import – in beiden Faellen liegt der Typ
// nicht hinter dem letzten Punkt. Die Java-Konvention entscheidet es dagegen zuverlaessig:
// Package-Segmente beginnen klein, Typen gross. Alles, was hinter dem letzten Typ-Segment noch
// folgt, ist ein Mitglied und faellt weg – sonst zaehlten `Strings.escape` und `Strings.pad` als
// zwei fremde Typen, obwohl es eine Abhaengigkeit ist.
function splitImport(fqcn: string): { pkg: string; type: string } {
  const segs = fqcn.split('.');
  let i = 0;
  while (i < segs.length - 1 && /^[a-z_$]/.test(segs[i])) i++;
  const rest = segs.slice(i);
  // Nur die gross beginnenden Segmente ab dem ersten Typ – `KeyVal.Pair` bleibt, `Strings.escape`
  // wird zu `Strings`. Trifft die Konvention nicht zu (alles klein), bleibt der Rest wie er ist:
  // etwas zu raten waere schlechter als den Namen so stehenzulassen, wie er im Code steht.
  //
  // ⚠️ Der grosse Anfangsbuchstabe allein reicht nicht: eine Konstante ist SCREAMING_CASE und
  // beginnt damit ebenfalls gross. Gemessen kam `com.acme.Money.ZERO` als Typ „Money.ZERO" an –
  // also als eigener fremder Typ, und ein zweiter statischer Import derselben Klasse waere ein
  // dritter gewesen. Ein Segment aus lauter Grossbuchstaben beendet den Typnamen deshalb, sofern
  // schon eines dasteht: so bleibt `java.net.URL` sein eigener Typ und `Money.ZERO` wird `Money`.
  const typed: string[] = [];
  for (const s of rest) {
    if (!/^[A-Z]/.test(s)) break;
    if (typed.length && /^[A-Z0-9_$]+$/.test(s)) break;
    typed.push(s);
  }
  return { pkg: segs.slice(0, i).join('.'), type: (typed.length ? typed : rest).join('.') };
}

const isPlatform = (pkg: string): boolean =>
  PLATFORM_PREFIXES.some((p) => pkg === p || pkg.startsWith(`${p}.`));

/**
 * Was man einer Codebasis nicht ansieht: Zyklen, Kopplungsmetriken, Brandherde.
 *
 * Drei Entscheidungen, die man dem Code sonst nicht ansieht:
 *
 * 1. **Kein Cache.** Der Lauf liest drei kleine Tabellen (Klassen OHNE `raw_source`, Kanten,
 *    Versionszaehler) und rechnet in O(V+E) – gemessen wenige Millisekunden bei 1500 Klassen. Ein
 *    Cache waere eine zweite Wahrheit mit eigener Invalidierung an jedem Schreibpfad, und die
 *    Antwort waere nach dem naechsten Import stillschweigend falsch. Teuer ist an dieser Rechnung
 *    nur `loc`/`complexity`, und genau die stehen deshalb als Spalten in der Zeile.
 *
 * 2. **Die Grundlage sind `java_edges`, nicht die Imports.** Eine Import-Zeile nennt eine Klasse,
 *    benutzt sie aber nicht – ein "leftover import" ergaebe einen Zyklus, den es im laufenden
 *    Programm nicht gibt. `uses` deckt jeden echten Typbezug bereits ab.
 *
 * 3. **Kanten, die sich nicht eindeutig aufloesen lassen, fallen raus und werden GEZAEHLT.**
 *    Altbestand ohne `source_pkg` und zwei gleichnamige Klassen in verschiedenen Packages sind
 *    nicht entscheidbar; sie zu raten hiesse, einen Zyklus zu erfinden. Die Zahl steht in der
 *    Antwort (`unresolved`), denn ein stiller Ausschluss liest sich wie "gibt es nicht".
 */
@Injectable()
export class InsightsService implements OnModuleInit {
  private readonly logger = new Logger(InsightsService.name);
  private backfilling = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    // Nur fuer den Aufteilungsvorschlag: der erzeugt Java-Quelltext und braucht dafuer dieselbe
    // Einrueckung und denselben Highlighter wie jede andere Codeanzeige – kein zweiter von beiden.
    private readonly formatter: CodeFormatterService,
    private readonly markdown: MarkdownService,
  ) {}

  onModuleInit(): void {
    // Nicht awaiten: der Nachtrag darf den Start nicht aufhalten (gleiche Bauart wie
    // `ensureJavaSourceIndex` -> `backfillSourceIndex` im DatabaseService).
    void this.backfillMetrics();
  }

  // --- Nachtrag fuer den Altbestand ------------------------------------------------------------
  //
  // Klassen, die vor diesen Spalten analysiert wurden, haben `loc`/`complexity` NULL. Der Nachtrag
  // braucht KEINEN Reparse: die Zeilenzahl steht im Quelltext, die Verzweigungen stehen in den
  // gespeicherten Rumpfen (`java_methods.body`). Deshalb Sekunden statt Minuten.
  private async backfillMetrics(): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      let done = 0;
      for (;;) {
        const rows: Array<{ id: number; raw_source: string }> = await this.ds.query(
          `SELECT id, raw_source FROM java_files WHERE loc IS NULL LIMIT ${BACKFILL_CHUNK}`,
        );
        if (!rows.length) break;

        const ids = rows.map((r) => r.id);
        const bodies = new Map<number, string[]>();
        for (const m of await this.ds.query(
          `SELECT file_id, body FROM java_methods WHERE file_id IN (${ids.join(',')})`,
        )) {
          const list = bodies.get(Number(m.file_id)) || [];
          list.push(m.body || '');
          bodies.set(Number(m.file_id), list);
        }

        for (const row of rows) {
          const { loc, complexity } = classMetrics(row.raw_source || '', bodies.get(row.id) || []);
          await this.ds.query(`UPDATE java_files SET loc = ?, complexity = ? WHERE id = ?`, [
            loc,
            complexity,
            row.id,
          ]);
        }
        done += rows.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (done) this.logger.log(`Backfilled size metrics for ${done} classes`);
    } catch (e: any) {
      // Ein fehlgeschlagener Nachtrag darf den Server nicht mitreissen: die Spalten bleiben NULL,
      // die Antwort schreibt es als `pending` an, und der naechste Aufruf versucht es erneut.
      this.logger.warn(`Metrics backfill failed: ${e?.message || e}`);
    } finally {
      this.backfilling = false;
    }
  }

  // --- Architektur-Regeln: lesen und schreiben --------------------------------------------------

  /** Der Regeltext, wie er dasteht. Keine Zeile in `settings` = niemand hat etwas festgelegt. */
  private async rulesText(): Promise<string> {
    const row = await this.ds.getRepository(Setting).findOne({ where: { key: RULES_KEY } });
    return row?.value ?? '';
  }

  /**
   * Den Regeltext samt seinem Befund.
   *
   * ⚠️ Eigener Endpunkt, obwohl der Befund auch in `overview()` steht – und der Grund ist der
   * Editor: nach dem Speichern will man SOFORT sehen, was die geänderte Regel findet, und dafür den
   * ganzen Bericht neu zu rechnen hiesse, für zwei geänderte Zeichen alles noch einmal zu lesen.
   * Umgekehrt braucht die Übersicht die Verstösse mit, weil die Sidebar-Zahl sie zählt.
   */
  async rules(): Promise<any> {
    const classes: ClassRow[] = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, class_modifiers, loc, complexity
         FROM java_files ORDER BY class_name COLLATE NOCASE`,
    );
    const edgeRows: EdgeRow[] = await this.ds.query(
      `SELECT source_class, source_pkg, target_class, target_pkg, kind, confidence, method_name
         FROM java_edges WHERE dismissed = 0`,
    );
    const { pairs, unresolved } = this.resolveEdges(classes, edgeRows);
    const text = await this.rulesText();
    return { ...this.ruleReport(text, parseRules(text), classes, pairs), unresolved };
  }

  /**
   * Den Regeltext ersetzen. Ganzer Text statt einzelner Zeilen: der Editor IST ein Textfeld, und
   * Reihenfolge, Leerzeilen und die `#`-Begründungen gehören zur Eingabe – in Zeilen zerlegt wären
   * sie beim ersten Speichern weg.
   *
   * ⚠️ Fehlerhafte Zeilen werden GESPEICHERT, nicht abgelehnt. Wer mitten im Schreiben abbricht,
   * darf seinen Text nicht verlieren; die Meldung steht an der Zeile, und die Regel gilt eben
   * nicht. Eine Speicherung, die den halben Text ablehnt, erzieht dazu, gar nicht erst zu tippen.
   */
  async saveRules(text: string): Promise<any> {
    const value = String(text ?? '');
    const repo = this.ds.getRepository(Setting);
    // Ein leerer Text LOESCHT die Zeile – "keine Regeln" und "eine Regel, die leer ist" sind
    // dasselbe, und zwei Darstellungen desselben Zustands wären eine zu viel (gleiche Regel wie
    // beim Zurücksetzen einer Bot-Einstellung).
    if (!value.trim()) await repo.delete(RULES_KEY);
    else await repo.save({ key: RULES_KEY, value, updated_at: new Date().toISOString() });
    return this.rules();
  }

  /**
   * Text -> Regeln -> Befund. Eine Stelle, damit Übersicht und Editor dasselbe zeigen.
   *
   * Die geparsten Regeln kommen vom AUFRUFER: `overview()` braucht sie zusätzlich für die
   * Zyklen-Bruchstelle, und zweimal zu parsen hiesse, zwei Fassungen derselben Zeilen zu haben.
   */
  private ruleReport(
    text: string,
    parsed: { rules: Rule[]; errors: any[] },
    classes: ClassRow[],
    pairs: Pair[],
  ): any {
    const shape = classes.map((c) => ({ id: c.id, className: c.class_name, package: c.package || '' }));
    const { rules, errors } = parsed;
    const checked = checkRules(rules, shape, pairs);
    const violations = checked.reduce((s, r) => s + r.count, 0);
    return {
      text,
      rules: checked,
      errors,
      suggestions: suggestRules(shape, pairs, rules),
      totals: {
        rules: rules.length,
        violated: checked.filter((r) => r.status === 'violated').length,
        inert: checked.filter((r) => r.status === 'inert').length,
        violations,
        errors: errors.length,
        // Ob eine Schichtregel dasteht – die Zyklen-Bruchstelle sagt damit "gegen deine Regel"
        // statt "sieht aus wie gegen die Schichten".
        hasLayers: rules.some((r) => r.kind === 'layers'),
      },
    };
  }

  // --- Die eine Antwort ------------------------------------------------------------------------

  async overview(): Promise<any> {
    const classes: ClassRow[] = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, class_modifiers, loc, complexity
         FROM java_files ORDER BY class_name COLLATE NOCASE`,
    );
    const edgeRows: EdgeRow[] = await this.ds.query(
      `SELECT source_class, source_pkg, target_class, target_pkg, kind, confidence, method_name
         FROM java_edges WHERE dismissed = 0`,
    );

    const methodCount = new Map<number, number>();
    for (const r of await this.ds.query(
      `SELECT file_id, COUNT(*) AS n FROM java_methods
        WHERE member_kind IS NULL OR member_kind = 'method' GROUP BY file_id`,
    )) {
      methodCount.set(Number(r.file_id), Number(r.n));
    }

    // Zahl der gespeicherten Staende je Klasse = wie oft sie neu eingelesen wurde. Das ist die
    // einzige Aenderungsspur, die Wikit ohne Git-Zugriff hat.
    const versionCount = new Map<number, number>();
    for (const r of await this.ds.query(
      `SELECT java_file_id, COUNT(*) AS n FROM java_file_versions GROUP BY java_file_id`,
    )) {
      versionCount.set(Number(r.java_file_id), Number(r.n));
    }

    const pending = classes.filter((c) => c.loc == null).length;
    if (pending && !this.backfilling) void this.backfillMetrics();

    const { pairs, unresolved } = this.resolveEdges(classes, edgeRows);

    // Die Architektur-Regeln – und zwar VOR den Zyklen, denn eine `layers`-Regel entscheidet die
    // Bruchstelle mit. Ohne sie bleibt es bei der Konvention (`againstLayers`), mit ihr wird aus
    // "sieht aus wie gegen die Schichten" die Aussage "gegen deine Schichtregel".
    const rulesText = await this.rulesText();
    const parsedRules = parseRules(rulesText);
    const layerCheck = layerCheckFrom(parsedRules.rules);

    // Zyklen, Kennzahlen je Klasse und je Package – dieselbe Rechnung, die der Sandkasten ueber
    // seinen veraenderten Stand laufen laesst (s. `structure`).
    const { classes: classOut, packages, classCycles, pkgCycles, hasChurn } = this.structure(classes, pairs, {
      methodCount,
      versionCount,
      layerCheck,
    });

    // Die Importzeilen – EINMAL gelesen, von ZWEI Auswertungen gebraucht. `outsideView` fragt sie,
    // was dieser Code von aussen holt; der Testschatten, welche Klasse ein Testframework importiert.
    // Zweimal abzufragen waeren zwei Durchlaeufe ueber dieselbe Tabelle in derselben Antwort.
    const importRows: ShadowImport[] = await this.ds.query(
      `SELECT from_file_id, to_class_name FROM java_dependencies`,
    );

    // Der einzige Teil, der die Importe liest statt der Kanten – und der einzige, der etwas ueber
    // Klassen sagen kann, die gar nicht da sind (s. `outsideView`).
    const outside = this.outsideView(classes, importRows);

    // Was kein Test anfasst. Rechnet auf `classOut` statt auf `classes`, weil die Rangfolge die
    // ganze Aussage ist: „ungetestet" allein ist eine Liste, „die schwerste Klasse ist ungetestet"
    // ist ein Befund. Reine Rechnung – die Datei daneben kennt keine Datenbank.
    const tests = buildTestShadow(
      classOut.map((c) => ({
        id: c.id,
        className: c.className,
        package: c.package,
        score: c.score,
        loc: c.loc,
        complexity: c.complexity,
        driver: c.driver,
        cycle: c.cycle ?? null,
      })),
      pairs.map((p) => ({ from: p.from, to: p.to })),
      importRows,
    );

    // Die Regeln gegen dieselben Paare, aus denen auch Zyklen und Kennzahlen entstehen.
    const rules = this.ruleReport(rulesText, parsedRules, classes, pairs);

    const nameOf = new Map<number, string>(classes.map((c) => [c.id, c.class_name]));

    // --- Was eine Package-Kante TRÄGT -------------------------------------------------------------
    // „Zwischen web und service liegt eine Beziehung" ist keine Arbeitsanweisung. Die Frage lautet
    // „welche Klassen genau?", und erst damit wird aus dem Befund ein Plan: diese Zeilen sind die,
    // die man anfasst. Gedeckelt, weil eine Package-Kante bei einer großen Codebasis hunderte
    // Klassenpaare bündeln kann – was wegfällt, wird gezählt (`more`).
    const pkgOfId = new Map<number, string>(classes.map((c) => [c.id, c.package || '(default)']));
    const linksBetween = (fromPkg: string, toPkg: string) => {
      const hits = pairs.filter((p) => pkgOfId.get(p.from) === fromPkg && pkgOfId.get(p.to) === toPkg);
      return {
        links: hits.slice(0, LINK_SAMPLE).map((p) => ({
          fromId: p.from,
          from: nameOf.get(p.from) || String(p.from),
          toId: p.to,
          to: nameOf.get(p.to) || String(p.to),
          kind: p.kind,
          count: p.count,
          members: p.members,
        })),
        more: Math.max(0, hits.length - LINK_SAMPLE),
      };
    };

    return {
      totals: {
        classes: classes.length,
        packages: packages.length,
        relations: pairs.length,
        loc: classes.reduce((s, c) => s + (c.loc ?? 0), 0),
        complexity: classes.reduce((s, c) => s + (c.complexity ?? 0), 0),
        classCycles: classCycles.length,
        packageCycles: pkgCycles.length,
        // Ohne diese Zahl liest sich ein leerer Bericht wie "alles in Ordnung", obwohl in
        // Wirklichkeit nur nie jemand die Kanten berechnet hat.
        unresolved,
        pending,
        hasChurn,
        // Klassen, die dieser Bestand importiert, aber nicht enthaelt, obwohl ihr Package hier
        // liegt. Die eine Zahl aus `outside`, die eine Aufgabe ist – deshalb steht sie oben.
        missing: outside.totals.gap.types,
        // Beziehungen, die gegen eine aufgeschriebene Regel laufen. Sie steht hier oben, weil die
        // Sidebar sie zu den Zyklen addiert: beides sind Befunde, und beide koennen echt 0 werden –
        // die Bedingung, die an diese Zahl gestellt ist.
        ruleViolations: rules.totals.violations,
      },
      classes: classOut,
      packages,
      outside,
      tests,
      // Was der Betreiber festgelegt hat – und wo der Code es gerade nicht einhaelt. Teil DIESER
      // Antwort, weil die Regeln auf denselben aufgeloesten Paaren rechnen: sie getrennt zu holen
      // hiesse, den Graphen ein zweites Mal aufzuloesen, nur um dieselben Kanten anders zu lesen.
      rules,
      cycles: {
        // `chain` traegt die Datei-Ids (der Absprung nach /code braucht sie), `chainLabels` die
        // Namen. Auf der Package-Ebene ist beides derselbe Pfad – die Oberflaeche liest dadurch
        // in beiden Faellen dieselben zwei Felder und braucht keine Fallunterscheidung.
        classes: classCycles.map((c) => ({
          size: c.members.length,
          members: c.members,
          chain: c.chain,
          chainLabels: (c.chain as number[]).map((id) => nameOf.get(id) || String(id)),
          weakest: labelWeakest(c.weakest, (id) => nameOf.get(id as number) || String(id)),
        })),
        packages: pkgCycles.map((c) => {
          const weakest = labelWeakest(c.weakest, (p) => String(p));
          return {
            size: c.members.length,
            members: c.members,
            chain: c.chain,
            chainLabels: c.chain as string[],
            // Die Bruchstelle nennt ihre tragenden Klassen – ohne sie bliebe der Vorschlag eine
            // Aussage über zwei Ordner.
            weakest: weakest ? { ...weakest, ...linksBetween(weakest.from, weakest.to) } : null,
          };
        }),
      },
    };
  }

  // --- Die Struktur eines Bestands -------------------------------------------------------------

  /**
   * Zyklen, Kennzahlen je Klasse und je Package – aus NICHTS als `classes` und `pairs`.
   *
   * ⚠️ Eigene Methode, weil es zwei Aufrufer gibt: den Bericht ueber den echten Bestand und den
   * Sandkasten ueber einen vorgemerkten Umbau. Beide muessen dieselbe Rechnung sehen – eine zweite
   * Fassung fuer den simulierten Stand hiesse, im Vergleich den Unterschied zwischen zwei Rechnungen
   * zu messen statt den zwischen zwei Staenden. Genau diese Regel gilt schon zwischen
   * `recomputeAutoEdges` und dem Drift-Bericht (`computeEdges`).
   *
   * Der Kontext ist optional, weil er fuer die Struktur nichts entscheidet: ohne `versionCount`
   * entfaellt die Aenderungshaeufigkeit (der Score ist dann eine reine Strukturaussage, und
   * `hasChurn` sagt es), ohne `methodCount` fehlt nur eine Anzeigespalte.
   *
   * ⚠️ Die Raenge entstehen INNERHALB des uebergebenen Bestands (`weigher`/`percentiler`). Ein
   * Score ist damit immer relativ zu seinem eigenen Stand – wer eine Klasse entfernt, verschiebt die
   * Skala fuer alle uebrigen. Der Sandkasten schreibt das an; ohne diesen Satz laese sich ein
   * gesunkener Score wie eine Verbesserung, die niemand gemacht hat.
   */
  private structure(
    classes: ClassRow[],
    pairs: Pair[],
    ctx: {
      methodCount?: Map<number, number>;
      versionCount?: Map<number, number>;
      layerCheck?: ((from: any, to: any) => boolean) | null;
    } = {},
  ): { classes: any[]; packages: any[]; classCycles: any[]; pkgCycles: any[]; hasChurn: boolean } {
    const methodCount = ctx.methodCount || new Map<number, number>();
    const versionCount = ctx.versionCount || new Map<number, number>();
    const layerCheck = ctx.layerCheck || null;

    const classCycles = this.findCycles(
      classes.map((c) => c.id),
      pairs,
    );

    // --- Kopplung je Klasse: Zahl der VERSCHIEDENEN Nachbarn, nicht der Kanten ------------------
    // Zwei Klassen, die sich mit zwanzig Methoden gegenseitig aufrufen, sind eine Abhaengigkeit,
    // keine zwanzig. Genau so ist Ca/Ce bei Martin definiert, und nur so ist die Instabilitaet
    // zwischen zwei Klassen ueberhaupt vergleichbar.
    const fanOut = new Map<number, number>();
    const fanIn = new Map<number, number>();
    for (const p of pairs) {
      fanOut.set(p.from, (fanOut.get(p.from) || 0) + 1);
      fanIn.set(p.to, (fanIn.get(p.to) || 0) + 1);
    }

    const cycleOfClass = new Map<number, number>();
    classCycles.forEach((c, i) => c.members.forEach((id) => cycleOfClass.set(id as number, i)));

    // --- Hotspot-Score --------------------------------------------------------------------------
    // ⚠️ Rang UND Groessenordnung, je zur Haelfte (`weigher`). Beides allein ist falsch:
    //
    //   * Nur der RANG kennt kein "um wieviel". Gemessen an der Demo-Codebasis stand eine Klasse
    //     mit 100 Verzweigungen damit UNTER einer mit 8 – beide sind "unter den obersten", und den
    //     Rest entschieden dann Nebenkriterien. Eine Rangliste, die das tut, glaubt niemand mehr.
    //   * Nur die GROESSE laesst einen einzelnen Ausreisser alles andere platt druecken: eine
    //     4000-Zeilen-Klasse macht jede 400-Zeilen-Klasse zu einer 0,1.
    //
    // Die Groessenordnung geht deshalb logarithmisch und gegen das 95. Perzentil statt gegen das
    // Maximum ein – der Ausreisser setzt nicht mehr allein den Massstab.
    const locRank = weigher(classes.map((c) => c.loc ?? 0));
    const cxRank = weigher(classes.map((c) => c.complexity ?? 0));
    const coupling = classes.map((c) => (fanIn.get(c.id) || 0) + (fanOut.get(c.id) || 0));
    const coRank = weigher(coupling);
    // Churn zaehlt erst ab dem zweiten Stand: Version 1 entsteht beim ersten Import und ist keine
    // Aenderung. Hat NICHTS mehr als einen Stand, bleibt der Faktor ueberall 1 – der Score ist dann
    // eine reine Strukturaussage, und die Oberflaeche sagt das.
    const churn = classes.map((c) => Math.max(0, (versionCount.get(c.id) || 1) - 1));
    const hasChurn = churn.some((n) => n > 0);
    const churnRank = percentiler(churn);

    const classOut = classes.map((c, i) => {
      const out = fanOut.get(c.id) || 0;
      const inn = fanIn.get(c.id) || 0;
      const parts = {
        branching: W_COMPLEXITY * cxRank(c.complexity ?? 0),
        size: W_LOC * locRank(c.loc ?? 0),
        coupling: W_COUPLING * coRank(coupling[i]),
      };
      const structure = parts.branching + parts.size + parts.coupling;
      const factor = hasChurn ? 1 + CHURN_WEIGHT * churnRank(churn[i]) : 1;
      // WARUM eine Klasse oben steht, ist die eigentliche Auskunft: „viele Entscheidungen" führt zu
      // einer anderen Handlung als „hängt an zwanzig anderen". Der Score sortiert nur; der Treiber
      // sagt, wo man ansetzt. Bestimmt wird er über den groessten GEWICHTETEN Beitrag – nicht über
      // den groessten Rang, sonst gewaenne die Kopplung staendig gegen ihr eigenes kleines Gewicht.
      const driver = (Object.keys(parts) as Array<keyof typeof parts>).reduce((a, b) =>
        parts[b] > parts[a] ? b : a,
      );
      return {
        id: c.id,
        className: c.class_name,
        package: c.package || '',
        type: c.stereotype || c.class_type || 'class',
        loc: c.loc ?? 0,
        complexity: c.complexity ?? 0,
        methods: methodCount.get(c.id) || 0,
        fanIn: inn,
        fanOut: out,
        // Instabilitaet nach Martin: 0 = nur benutzt (stabil), 1 = benutzt nur (instabil).
        // Ohne jede Beziehung ist sie nicht definiert -> null, nicht 0. Eine isolierte Klasse als
        // "maximal stabil" auszuweisen waere eine Aussage ueber nichts.
        instability: inn + out === 0 ? null : round2(out / (inn + out)),
        churn: churn[i],
        score: Math.round(100 * Math.min(1, structure * factor)),
        // 'branching' | 'size' | 'coupling', oder 'churn', wenn die Änderungshäufigkeit den
        // Ausschlag gibt (sie hebt den Score um mehr als ein Fünftel).
        driver: hasChurn && factor > 1.2 ? 'churn' : driver,
        cycle: cycleOfClass.has(c.id) ? cycleOfClass.get(c.id) : null,
      };
    });

    const packages = this.packageMetrics(classes, pairs);
    // Schichten beruecksichtigen: die aufgeschriebene Regel, sonst die Konvention (s. arch-rules).
    const pkgCycles = this.findCycles(
      packages.map((p) => p.path),
      this.packagePairs(classes, pairs),
      layerCheck || true,
    );
    const cycleOfPkg = new Map<string, number>();
    pkgCycles.forEach((c, i) => c.members.forEach((p) => cycleOfPkg.set(p as string, i)));
    for (const p of packages) p.cycle = cycleOfPkg.has(p.path) ? cycleOfPkg.get(p.path)! : null;

    return { classes: classOut, packages, classCycles, pkgCycles, hasChurn };
  }

  // --- Was waere, wenn? ------------------------------------------------------------------------

  /**
   * Ein vorgemerkter Umbau, durchgerechnet – **ohne dass sich am Bestand irgendetwas aendert**.
   *
   * Der Bericht sagt, was nicht stimmt; `CyclePlan` und `SplitPlan` sagen, was man tun koennte. Die
   * Frage direkt dahinter beantwortet keiner von beiden: **und was bringt es?** Eine Kante
   * wegzunehmen loest selten nur einen Zyklus – sie verschiebt die Instabilitaet, kann eine Regel
   * brechen, die vorher hielt, und macht eine andere Klasse zum schwersten Brocken. Genau diese
   * Nebenwirkungen sind der Grund, warum ein Umbau im Kopf so oft besser aussieht als in echt.
   *
   * ⚠️ **BEIDE Staende laufen durch dieselbe Rechnung** (`structure`, `checkRules`) – dieselbe Regel
   * wie im Drift-Bericht, nur dass der zweite Stand hier nicht aus der Vergangenheit kommt, sondern
   * aus einer Absicht. Eine eigene Fassung fuer den simulierten Stand hiesse, im Vergleich den
   * Unterschied zwischen zwei Rechnungen zu sehen statt den zwischen zwei Staenden.
   *
   * ⚠️ **Geschrieben wird nichts.** Kein Tombstone, keine manuelle Kante, keine Spalte – s. `what-if.ts`.
   */
  async simulate(changes: Change[]): Promise<any> {
    const classes: ClassRow[] = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, class_modifiers, loc, complexity
         FROM java_files ORDER BY class_name COLLATE NOCASE`,
    );
    const edgeRows: EdgeRow[] = await this.ds.query(
      `SELECT source_class, source_pkg, target_class, target_pkg, kind, confidence, method_name
         FROM java_edges WHERE dismissed = 0`,
    );
    // Ein leerer Sandkasten ist kein leeres Ergebnis, sondern ein GRUND – gleiche Regel wie bei
    // `/ask` und beim Drift-Bericht.
    if (!classes.length) return this.emptySimulation('no-classes');
    if (!edgeRows.length) return this.emptySimulation('no-relations');

    // Die Aenderungshaeufigkeit faehrt mit, damit die „Vorher"-Spalte dieselben Zahlen zeigt wie der
    // Bericht daneben. Die Methodenzahl dagegen nicht: sie ist eine reine Anzeigespalte, und der
    // Sandkasten zeigt keine – eine Abfrage fuer nichts.
    const versionCount = new Map<number, number>();
    for (const r of await this.ds.query(
      `SELECT java_file_id, COUNT(*) AS n FROM java_file_versions GROUP BY java_file_id`,
    )) {
      versionCount.set(Number(r.java_file_id), Number(r.n));
    }

    const rulesText = await this.rulesText();
    const parsedRules = parseRules(rulesText);
    const ctx = { versionCount, layerCheck: layerCheckFrom(parsedRules.rules) };

    const { pairs, unresolved } = this.resolveEdges(classes, edgeRows);
    const sim = applyChanges(classes, pairs, changes);
    // ⚠️ Ueber `mergePairs`, nicht roh: ein Umbau kann zwei Paare aufeinander schieben (eine
    // umgedrehte Kante auf eine schon vorhandene Gegenrichtung, zwei zusammengelegte Klassen).
    // Blieben sie doppelt stehen, zaehlte die Kopplung dieselbe Abhaengigkeit zweimal.
    const nextPairs = mergePairs(sim.pairs);

    const before = this.structure(classes, pairs, ctx);
    const after = this.structure(sim.classes, nextPairs, ctx);

    const shapeOf = (list: ClassRow[]) =>
      list.map((c) => ({ id: c.id, className: c.class_name, package: c.package || '' }));
    // Nur `checkRules`, nicht der ganze `ruleReport`: die Vorschlagsliste („was haelst du schon
    // ein?") ist eine Aussage ueber den ECHTEN Bestand und im Sandkasten sinnlos – sie zweimal je
    // Tastendruck zu rechnen waere ein Durchlauf ueber alle Paare fuer nichts.
    const rulesBefore = checkRules(parsedRules.rules, shapeOf(classes), pairs);
    const rulesAfter = checkRules(parsedRules.rules, shapeOf(sim.classes), nextPairs);

    const nameOf = new Map<number, string>(classes.map((c) => [c.id, c.class_name]));
    const label = (v: any) => nameOf.get(v as number) || String(v);
    const asIs = (v: any) => String(v);

    // --- Zyklen: was faellt weg, was entsteht ---------------------------------------------------
    const beforeKeys = new Set(pairs.map((p) => pairKey(p.from, p.to)));
    const afterByKey = new Map(nextPairs.map((p) => [pairKey(p.from, p.to), p]));
    const classCycles = partitionCycles(before.classCycles, after.classCycles);
    const packageCycles = partitionCycles(before.pkgCycles, after.pkgCycles);

    const asCycle = (c: any, name: (v: any) => string) => ({
      length: c.members.length,
      chain: (c.chain as any[]).map(name),
      members: (c.members as any[]).slice(0, SIM_CYCLE_NAMES).map(name),
      more: Math.max(0, c.members.length - SIM_CYCLE_NAMES),
    });

    // ⚠️ Ein neu entstandener Kreis traegt die Kante, die ihn geschlossen hat – die einzige seiner
    // Kette, die es vorher nicht gab. Dieselbe Regel wie im Drift-Bericht: „ein Zyklus ist
    // entstanden" ohne Adresse ist eine Sorge, keine Aufgabe. Auf PACKAGE-Ebene entfaellt sie
    // bewusst: dort ist jede Kante ein Buendel vieler Klassenbeziehungen, und welche davon den
    // Kreis schliesst, steht in der Bruchstelle des Zyklen-Reiters.
    const appearedClass = classCycles.appeared.map((c) => ({
      ...asCycle(c, label),
      closedBy: chainPairs(c.chain)
        .filter((k) => !beforeKeys.has(k))
        .map((k) => afterByKey.get(k))
        .filter((p): p is Pair => !!p)
        .map((p) => ({
          from: label(p.from),
          to: label(p.to),
          kind: p.kind,
          count: p.count,
          members: p.members,
        })),
    }));

    // --- Klassen: wo sich das Gewicht hin verschiebt --------------------------------------------
    const beforeById = new Map<number, any>(before.classes.map((c) => [c.id, c]));
    const shifted = after.classes
      .map((c) => {
        const b = beforeById.get(c.id);
        if (!b) return null;
        return {
          id: c.id,
          className: c.className,
          package: c.package,
          score: { before: b.score, after: c.score },
          fanIn: { before: b.fanIn, after: c.fanIn },
          fanOut: { before: b.fanOut, after: c.fanOut },
          instability: { before: b.instability, after: c.instability },
          delta: c.score - b.score,
          // Ob sie nach dem Umbau noch in einem Kreis steckt – die eigentliche Frage bei einem
          // Zyklen-Umbau, und an der Zeile ablesbar statt in der Zyklenliste zu suchen.
          cycle: { before: b.cycle != null, after: c.cycle != null },
        };
      })
      .filter((c): c is NonNullable<typeof c> => !!c)
      .filter(
        (c) =>
          Math.abs(c.delta) >= SIM_SCORE_NOISE ||
          c.fanIn.before !== c.fanIn.after ||
          c.fanOut.before !== c.fanOut.after ||
          c.cycle.before !== c.cycle.after,
      )
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.className.localeCompare(b.className));

    const aliveAfter = new Set(sim.classes.map((c) => c.id));
    const gone = classes
      .filter((c) => !aliveAfter.has(c.id))
      .map((c) => ({ id: c.id, className: c.class_name, package: c.package || '', loc: c.loc ?? 0 }));

    // --- Die Bilanz ------------------------------------------------------------------------------
    const balance = (s: { classes: any[]; packages: any[]; classCycles: any[]; pkgCycles: any[] }, checked: any[], relations: number) => {
      const withInstability = s.classes.filter((c) => c.instability != null);
      const withDistance = s.packages.filter((p) => p.distance != null);
      const worst = s.classes.reduce((a: any, b: any) => (!a || b.score > a.score ? b : a), null as any);
      return {
        classes: s.classes.length,
        packages: s.packages.length,
        relations,
        classCycles: s.classCycles.length,
        packageCycles: s.pkgCycles.length,
        // In wie vielen Klassen ein Kreis steckt – „5 Zyklen" sagt nichts darueber, wie viel Code
        // davon betroffen ist, und genau das aendert ein Umbau.
        inCycle: s.classes.filter((c: any) => c.cycle != null).length,
        ruleViolations: checked.reduce((n, r) => n + r.count, 0),
        rulesViolated: checked.filter((r) => r.status === 'violated').length,
        avgInstability: withInstability.length
          ? round2(withInstability.reduce((n: number, c: any) => n + c.instability, 0) / withInstability.length)
          : null,
        // Packages, die weder ausgewogen noch bewusst abstrakt sind (Abstand zur Hauptsequenz).
        offMainSequence: withDistance.filter((p: any) => p.distance >= 0.5).length,
        worstScore: worst ? worst.score : null,
        worstClass: worst ? worst.className : null,
      };
    };

    return {
      available: true,
      reason: null,
      applied: sim.applied,
      cost: sim.cost,
      // Ob ueberhaupt Regeln dastehen. Ohne diese Angabe liest sich „0 → 0" wie ein gutes Ergebnis,
      // obwohl niemand etwas festgelegt hat, das brechen koennte.
      hasRules: parsedRules.rules.length > 0,
      unresolved,
      totals: {
        before: balance(before, rulesBefore, pairs.length),
        after: balance(after, rulesAfter, nextPairs.length),
      },
      cycles: {
        classes: {
          healed: classCycles.healed.slice(0, SIM_CYCLE_SAMPLE).map((c) => asCycle(c, label)),
          appeared: appearedClass.slice(0, SIM_CYCLE_SAMPLE),
          moreHealed: Math.max(0, classCycles.healed.length - SIM_CYCLE_SAMPLE),
          moreAppeared: Math.max(0, appearedClass.length - SIM_CYCLE_SAMPLE),
        },
        packages: {
          healed: packageCycles.healed.slice(0, SIM_CYCLE_SAMPLE).map((c) => asCycle(c, asIs)),
          appeared: packageCycles.appeared.slice(0, SIM_CYCLE_SAMPLE).map((c) => asCycle(c, asIs)),
          moreHealed: Math.max(0, packageCycles.healed.length - SIM_CYCLE_SAMPLE),
          moreAppeared: Math.max(0, packageCycles.appeared.length - SIM_CYCLE_SAMPLE),
        },
      },
      // Je Regel der Vorher/Nachher-Stand – aber nur die, bei denen sich etwas bewegt. Eine Regel,
      // die vorher hielt und danach bricht, ist der wichtigste Einzelbefund dieser Ansicht: sie ist
      // das Einzige hier, das der Betreiber ausdruecklich verboten hat.
      rules: rulesBefore
        .map((b, i) => ({
          line: b.line,
          text: b.text,
          note: b.note,
          before: { status: b.status, count: b.count },
          after: { status: rulesAfter[i].status, count: rulesAfter[i].count },
          violations: rulesAfter[i].violations,
        }))
        .filter((r) => r.before.count !== r.after.count || r.before.status !== r.after.status),
      classes: {
        shifted: shifted.slice(0, SIM_CLASS_SAMPLE),
        moreShifted: Math.max(0, shifted.length - SIM_CLASS_SAMPLE),
        gone,
      },
    };
  }

  // Ein Sandkasten ohne Bestand nennt seinen GRUND: ohne Klassen ist nichts zu rechnen, ohne
  // berechnete Kanten saehe jeder Umbau folgenlos aus – und das laese sich wie ein Ergebnis.
  private emptySimulation(reason: string): any {
    return {
      available: false,
      reason,
      applied: [],
      cost: { classes: 0, sites: 0, newFiles: 0, movedLines: 0 },
      hasRules: false,
      unresolved: 0,
      totals: null,
      cycles: null,
      rules: [],
      classes: null,
    };
  }

  // --- Wie man EINE Klasse aufteilen wuerde ----------------------------------------------------

  /**
   * Der Aufteilungsvorschlag zu einer Klasse – die Frage direkt hinter der Hotspot-Rangliste.
   *
   * ⚠️ **Warum das im Backend rechnet und nicht im Client** (anders als Lesepfad, `path:` und
   * `impact:`, die aus demselben Bericht entstehen): die Rechnung braucht die METHODENRUEMPFE, und
   * `GET /api/java/files` liefert sie bewusst nicht – sie sind die groesste Spalte der Datenbank.
   * Sie fuer eine Rechnung in den Client zu holen, die hier in Millisekunden fertig ist, waere
   * genau der Transport, den dieses Feld einspart.
   *
   * ⚠️ **Der `driver` kommt vom AUFRUFER, er wird hier nicht neu gerechnet.** Er entsteht in
   * `overview()` aus der ganzen Codebasis und liegt der Rangliste, aus der man hierher klickt,
   * bereits vor. Ihn erneut zu bestimmen hiesse, den kompletten Bericht fuer eine Zeichenkette zu
   * wiederholen – und er ist nur der Stichentscheid zwischen zwei gleich gut passenden Schnitten,
   * ein fehlender Wert also folgenlos.
   */
  async splitPlan(fileId: number, driver?: string): Promise<any> {
    const [file] = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, loc, complexity
         FROM java_files WHERE id = ?`,
      [fileId],
    );
    if (!file) throw new NotFoundException(`No class with id ${fileId}`);

    const rows: Array<{
      method_name: string;
      return_type: string | null;
      parameters: string | null;
      modifiers: string | null;
      body: string | null;
      start_line: number | null;
      member_kind: string | null;
    }> = await this.ds.query(
      `SELECT method_name, return_type, parameters, modifiers, body, start_line, member_kind
         FROM java_methods WHERE file_id = ? ORDER BY start_line`,
      [fileId],
    );
    // ⚠️ `safeJson(null, [])` liefert null, nicht [] – auf Array normieren, sonst wirft der erste
    // `.map` in der Rechnung (dieselbe Falle wie im Serializer).
    const jsonArray = <T>(raw: string | null): T[] => safeJson<T[]>(raw, []) || [];
    const members: SplitMember[] = rows.map((r) => ({
      name: r.method_name,
      kind: r.member_kind || 'method',
      returnType: r.return_type || '',
      parameters: jsonArray<{ type: string; name: string }>(r.parameters),
      modifiers: jsonArray<string>(r.modifiers),
      body: r.body || '',
      line: r.start_line,
    }));

    // Wer ruft diese Klasse? Dieselbe Aufloesung wie in `resolveEdges`: das Package entscheidet,
    // fehlt es (Altbestand), gilt der Name. Kanten OHNE Mitglied (`uses`/`import`) fahren mit –
    // sie sind kein Rollen-Kandidat, aber die Zahl daneben, die sagt, dass es sie gibt.
    const pkg = file.package || null;
    const classes: Array<{ id: number; package: string | null; class_name: string }> =
      await this.ds.query(`SELECT id, package, class_name FROM java_files`);
    const byFqcn = new Map<string, number>();
    const byName = new Map<string, number[]>();
    for (const c of classes) {
      byFqcn.set(c.package ? `${c.package}.${c.class_name}` : c.class_name, c.id);
      const list = byName.get(c.class_name) || [];
      list.push(c.id);
      byName.set(c.class_name, list);
    }
    const resolve = (name: string, p: string | null): number | null => {
      if (p) return byFqcn.get(`${p}.${name}`) ?? null;
      const direct = byFqcn.get(name);
      if (direct != null) return direct;
      const list = byName.get(name);
      return list && list.length === 1 ? list[0] : null;
    };

    const edges: Array<{
      source_class: string;
      source_pkg: string | null;
      target_pkg: string | null;
      method_name: string | null;
    }> = await this.ds.query(
      `SELECT source_class, source_pkg, target_pkg, method_name
         FROM java_edges WHERE target_class = ? AND dismissed = 0`,
      [file.class_name],
    );

    const byConsumer = new Map<string, SplitConsumer>();
    for (const e of edges) {
      // Zielseite pruefen: NULL ist Altbestand und zaehlt (dort gab es die Spalte noch nicht),
      // ein abweichendes Package ist eine gleichnamige Klasse woanders.
      if (e.target_pkg && pkg && e.target_pkg !== pkg) continue;
      const fromId = resolve(e.source_class, e.source_pkg);
      if (fromId === file.id) continue; // Selbstbezug ist kein Nutzer.
      const key = fromId != null ? `#${fromId}` : `?${e.source_pkg || ''}.${e.source_class}`;
      let c = byConsumer.get(key);
      if (!c) {
        c = { className: e.source_class, fileId: fromId, members: [] };
        byConsumer.set(key, c);
      }
      const member = (e.method_name || '').trim();
      if (member && !c.members.includes(member)) c.members.push(member);
    }

    // Die Import-Zeilen der Ursprungsklasse. Welche davon eine erzeugte Datei WIRKLICH braucht,
    // entscheidet `importsFor` am fertigen Text – alle zu übernehmen wäre bequem und falsch.
    const imports: string[] = (
      await this.ds.query(`SELECT to_class_name FROM java_dependencies WHERE from_file_id = ?`, [fileId])
    ).map((r: any) => String(r.to_class_name || '')).filter(Boolean);

    const allowed = new Set(['branching', 'size', 'coupling', 'churn']);
    const plan = buildSplitPlan(
      {
        id: file.id,
        className: file.class_name,
        package: file.package || '',
        type: file.stereotype || file.class_type || 'class',
        loc: file.loc ?? 0,
        complexity: file.complexity ?? 0,
        driver: driver && allowed.has(driver) ? driver : null,
      },
      members,
      [...byConsumer.values()].sort((a, b) => a.className.localeCompare(b.className)),
      imports,
    );

    // ⚠️ EINMAL einrücken, daraus BEIDES. Der erzeugte Text setzt sich aus Rümpfen zusammen, die
    // ihre Einrückung aus verschiedenen Tiefen mitbringen; `reindentJava` stellt sie her. Würde
    // stattdessen die Markdown-Pipeline einrücken (ihr Default), zeigte das Fenster einen anderen
    // Text an, als der Kopierknopf herausgibt – deshalb `reindentJava: false` beim Rendern und
    // `code` bereits eingerückt. Dieselbe Falle wie beim `raw=1` des Themen-Bündels.
    for (const s of plan.strategies) {
      for (const f of s.files || []) {
        // `verbatim` ist Originalcode und bleibt unangetastet (s. SplitFile) – alles andere ist
        // zusammengesetzt und bekommt erst hier seine Form.
        if (!f.verbatim) f.code = this.formatter.reindentJava(f.code);
        f.lines = f.code.split('\n').length;
        const { html } = await this.markdown.renderMarkdown('```java\n' + f.code + '\n```', {
          reindentJava: false,
        });
        f.html = html;
      }
    }
    return plan;
  }

  // --- Was von aussen hereinkommt --------------------------------------------------------------

  /**
   * Woher dieser Bestand Typen bezieht, die er selbst nicht enthaelt – und was davon eigentlich
   * hineingehoert.
   *
   * ⚠️ **Der einzige Teil des Berichts, der auf den IMPORTS rechnet, nicht auf `java_edges`** – und
   * zwar aus genau dem Grund, aus dem alles andere sie meidet: eine Kante entsteht nur zwischen
   * zwei Klassen IM Bestand. Was fehlt, hat per Definition keine Kante; die Importzeile ist die
   * einzige Spur, die eine abwesende Klasse ueberhaupt hinterlaesst. Ein "leftover import" faellt
   * hier deshalb nicht als Fehlerquelle ins Gewicht, sondern ist selbst Teil der Auskunft: er sagt,
   * dass diese Datei den Typ nennt.
   *
   * Drei Herkuenfte, und nur eine davon ist eine Aufgabe:
   *
   * * **gap** – das Package (oder eines darueber/darunter) liegt im Bestand, die Klasse nicht. Das
   *   ist der eigene Code, der beim Hochladen fehlte: der Graph endet dort, ohne es zu sagen.
   * * **library** – eine fremde Abhaengigkeit. Keine Aufgabe, aber eine Ansage darueber, was man
   *   mitlernen muss, um diesen Code zu lesen.
   * * **platform** – die JDK-nahen Packages. Vollstaendigkeitshalber gezaehlt, nie eine Luecke.
   *
   * ⚠️ **Die Grenze dieser Auskunft steht in der Oberflaeche**: eine Klasse im SELBEN Package
   * braucht keinen Import und kann hier nicht fehlen – sichtbar wird eine Luecke nur, wenn sie
   * jemand aus einem anderen Package importiert. `java.lang` gilt dasselbe.
   */
  private outsideView(classes: ClassRow[], rows: Array<{ from_file_id: number; to_class_name: string }>): any {
    const knownFqcn = new Set<string>();
    const knownPkgs = new Set<string>();
    const nameOf = new Map<number, string>();
    for (const c of classes) {
      const pkg = c.package || '';
      knownFqcn.add(pkg ? `${pkg}.${c.class_name}` : c.class_name);
      if (pkg) knownPkgs.add(pkg);
      nameOf.set(c.id, c.class_name);
    }

    // Liegt der Typ selbst im Bestand? Dieselbe Regel wie `resolveImport` im Client: eine
    // Importzeile NENNT die Klasse vollstaendig, also entscheidet die volle FQCN – und genestete
    // Typen fallen auf den umschliessenden zurueck (`a.b.KeyVal.Pair` -> `a.b.KeyVal`).
    const inStock = (fqcn: string): boolean => {
      let name = fqcn;
      for (;;) {
        if (knownFqcn.has(name)) return true;
        const cut = name.lastIndexOf('.');
        if (cut < 0) return false;
        name = name.slice(0, cut);
      }
    };

    // Eigenes Terrain?
    //
    // ⚠️ Entschieden wird ueber das ELTERNPACKAGE, nicht ueber das Package selbst: `com.acme.shop.util`
    // ist eigener Code, sobald `com.acme.shop.core` im Bestand liegt – die beiden sind Geschwister,
    // und genau so entstehen die haeufigsten Luecken (`web` importiert aus `repo`, und `repo` wurde
    // nie hochgeladen). Ueber Vorfahre/Nachfahre allein waere dieser Fall durchgefallen und in
    // "third-party" gelandet, also ausgerechnet der Fall, um dessentwillen es die Gruppe gibt.
    //
    // Die Regel bleibt trotzdem ohne Magie-Zahl ("die ersten zwei Segmente" waere geraten): sie
    // fragt den Bestand. `com.google.protobuf` ist nur dann eigenes Terrain, wenn hier tatsaechlich
    // `com.google.…` liegt – und dann ist die Aussage auch nicht falsch. Ein Package OHNE Eltern
    // (ein einzelnes Segment) zaehlt nur, wenn es selbst im Bestand steht: der leere Praefix waere
    // sonst Praefix von allem, und jede fremde Wurzel eine Luecke.
    const startsWithPkg = (k: string, p: string) => k === p || k.startsWith(`${p}.`);
    const ownPkgs = new Map<string, boolean>();
    const isOwn = (pkg: string): boolean => {
      if (!pkg) return false;
      const cached = ownPkgs.get(pkg);
      if (cached != null) return cached;
      const cut = pkg.lastIndexOf('.');
      const parent = cut < 0 ? '' : pkg.slice(0, cut);
      const hit = parent
        ? [...knownPkgs].some((k) => startsWithPkg(k, parent))
        : knownPkgs.has(pkg);
      ownPkgs.set(pkg, hit);
      return hit;
    };

    type Entry = { fqcn: string; type: string; pkg: string; kind: string; users: Set<number> };
    const entries = new Map<string, Entry>();
    let wildcards = 0;
    let internal = 0;

    for (const r of rows) {
      const raw = String(r.to_class_name || '');
      if (!raw) continue;

      // ⚠️ Ein Wildcard-Import nennt meistens keine Klasse – `p.q.*` kann also weder fehlen noch
      // gezaehlt werden. `import static p.q.Money.*` dagegen NENNT eine: der Stern steht dort fuer
      // die Mitglieder eines Typs, nicht fuer die Typen eines Packages. Ihn zu den namenlosen zu
      // legen, hiesse eine Abhaengigkeit zu verschweigen, die im Code wortwoertlich dasteht.
      // Verschwiegen wird der echte Package-Wildcard trotzdem nicht: er ist der Grund, warum diese
      // Liste unvollstaendig sein KANN, und genau das steht als Zahl daneben.
      const fqcn = raw.endsWith('.*') ? raw.slice(0, -2) : raw;
      if (raw !== fqcn && !/^[A-Z]/.test(splitImport(fqcn).type)) {
        wildcards++;
        continue;
      }
      if (inStock(fqcn)) {
        internal++;
        continue;
      }
      const { pkg, type } = splitImport(fqcn);
      const key = pkg ? `${pkg}.${type}` : type;
      let e = entries.get(key);
      if (!e) {
        e = { fqcn: key, type, pkg, kind: isOwn(pkg) ? 'gap' : isPlatform(pkg) ? 'platform' : 'library', users: new Set() };
        entries.set(key, e);
      }
      e.users.add(Number(r.from_file_id));
    }

    // Je Package buendeln – die Herkunft ist die Frage, nicht die einzelne Zeile.
    const byPkg = new Map<string, { path: string; kind: string; types: Entry[]; users: Set<number> }>();
    for (const e of entries.values()) {
      const path = e.pkg || '(default)';
      let g = byPkg.get(path);
      if (!g) {
        g = { path, kind: e.kind, types: [], users: new Set() };
        byPkg.set(path, g);
      }
      g.types.push(e);
      for (const u of e.users) g.users.add(u);
    }

    const groups: Record<string, any[]> = { gap: [], library: [], platform: [] };
    for (const g of byPkg.values()) {
      const types = [...g.types].sort((a, b) => b.users.size - a.users.size || a.type.localeCompare(b.type));
      groups[g.kind].push({
        path: g.path,
        kind: g.kind,
        usedBy: g.users.size,
        typeCount: types.length,
        types: types.slice(0, OUTSIDE_TYPE_SAMPLE).map((t) => ({
          name: t.type,
          fqcn: t.fqcn,
          usedBy: t.users.size,
          // Die benutzenden Klassen sind der Absprung: „wo taucht das auf?" ist die Frage direkt
          // hinter „was ist das?", und ohne sie endet der Reiter bei der Erkenntnis.
          users: [...t.users]
            .slice(0, OUTSIDE_USER_SAMPLE)
            .map((id) => ({ id, className: nameOf.get(id) || String(id) }))
            .sort((a, b) => a.className.localeCompare(b.className)),
          moreUsers: Math.max(0, t.users.size - OUTSIDE_USER_SAMPLE),
        })),
        moreTypes: Math.max(0, types.length - OUTSIDE_TYPE_SAMPLE),
      });
    }

    const totalsFor = (kind: string) => ({
      packages: groups[kind].length,
      types: groups[kind].reduce((s: number, p: any) => s + p.typeCount, 0),
    });
    for (const kind of Object.keys(groups)) {
      groups[kind].sort((a, b) => b.usedBy - a.usedBy || b.typeCount - a.typeCount || a.path.localeCompare(b.path));
    }

    return {
      totals: {
        types: entries.size,
        packages: byPkg.size,
        wildcards,
        // Importe, deren Ziel im Bestand liegt. Sie sind hier kein Befund, sondern der Massstab:
        // ohne sie liest sich „140 fremde Typen" wie eine Bewertung statt wie ein Verhaeltnis.
        internal,
        gap: totalsFor('gap'),
        library: totalsFor('library'),
        platform: totalsFor('platform'),
      },
      // Der Deckel gilt je Gruppe und wird angeschrieben – ein still gekuerzter Rest liest sich
      // wie „mehr gibt es nicht".
      groups: {
        gap: groups.gap.slice(0, OUTSIDE_PACKAGE_SAMPLE),
        library: groups.library.slice(0, OUTSIDE_PACKAGE_SAMPLE),
        platform: groups.platform.slice(0, OUTSIDE_PACKAGE_SAMPLE),
      },
      more: {
        gap: Math.max(0, groups.gap.length - OUTSIDE_PACKAGE_SAMPLE),
        library: Math.max(0, groups.library.length - OUTSIDE_PACKAGE_SAMPLE),
        platform: Math.max(0, groups.platform.length - OUTSIDE_PACKAGE_SAMPLE),
      },
    };
  }

  // --- Kanten auf Datei-Ids aufloesen ----------------------------------------------------------
  //
  // Eine Klasse ist ihr FQCN, nicht ihr Name (dieselbe Regel wie in `recomputeAutoEdges`). Ist das
  // Package bekannt, entscheidet es; fehlt es (Altbestand oder default package), bleibt nur der
  // Name – und der zaehlt nur, wenn er im Bestand EINDEUTIG ist.
  //
  // Oeffentlich, weil der Drift-Bericht denselben Schritt fuer den Stand von DAMALS braucht: haette
  // er eine eigene Fassung, verglichen am Ende zwei verschieden aufgeloeste Graphen.
  resolveEdges(classes: ClassRow[], rows: EdgeRow[]): { pairs: Pair[]; unresolved: number } {
    const byFqcn = new Map<string, number>();
    const byName = new Map<string, number[]>();
    for (const c of classes) {
      byFqcn.set(c.package ? `${c.package}.${c.class_name}` : c.class_name, c.id);
      const list = byName.get(c.class_name) || [];
      list.push(c.id);
      byName.set(c.class_name, list);
    }
    const resolve = (name: string, pkg: string | null): number | null => {
      if (pkg) return byFqcn.get(`${pkg}.${name}`) ?? null;
      const direct = byFqcn.get(name);
      if (direct != null) return direct;
      const list = byName.get(name);
      return list && list.length === 1 ? list[0] : null;
    };

    // Ein Klassenpaar EINMAL, mit der Zahl der zugrundeliegenden Kanten als Gewicht: mehrere
    // Aufrufe zwischen denselben zwei Klassen sind eine Abhaengigkeit. Das Zusammenfassen selbst
    // steht in `mergePairs` – der Sandkasten braucht es ein zweites Mal, sobald ein vorgemerkter
    // Umbau zwei Paare aufeinander schiebt, und eine eigene Fassung dort waere eine zweite
    // Aufloesungsregel neben dieser.
    const raw: Pair[] = [];
    let unresolved = 0;
    for (const e of rows) {
      const from = resolve(e.source_class, e.source_pkg);
      const to = resolve(e.target_class, e.target_pkg);
      if (from == null || to == null) {
        unresolved++;
        continue;
      }
      if (from === to) continue; // Selbstbezug ist kein Zyklus und keine Kopplung.
      const member = (e.method_name || '').trim();
      raw.push({
        from,
        to,
        count: 1,
        kind: e.kind || 'call',
        confidence: Number(e.confidence ?? 1),
        members: member ? [member] : [],
      });
    }
    return { pairs: mergePairs(raw), unresolved };
  }

  // --- Package-Ebene ---------------------------------------------------------------------------

  private packageMetrics(classes: ClassRow[], pairs: Pair[]): any[] {
    const pkgOf = new Map<number, string>(classes.map((c) => [c.id, c.package || '(default)']));
    const members = new Map<string, ClassRow[]>();
    for (const c of classes) {
      const p = c.package || '(default)';
      const list = members.get(p) || [];
      list.push(c);
      members.set(p, list);
    }

    // Ca/Ce zaehlen KLASSEN, nicht Kanten (Martin). Zwei Sets je Package, damit dieselbe Klasse
    // nicht mehrfach zaehlt, wenn sie ueber drei Wege ins Package hineinreicht.
    const afferent = new Map<string, Set<number>>();
    const efferent = new Map<string, Set<number>>();
    const add = (map: Map<string, Set<number>>, key: string, id: number) => {
      const set = map.get(key) || new Set<number>();
      set.add(id);
      map.set(key, set);
    };
    for (const p of pairs) {
      const a = pkgOf.get(p.from)!;
      const b = pkgOf.get(p.to)!;
      if (a === b) continue;
      add(afferent, b, p.from); // Klasse ausserhalb, die hineinzeigt
      add(efferent, a, p.from); // Klasse innerhalb, die hinauszeigt
    }

    return [...members.entries()]
      .map(([path, list]) => {
        const ca = afferent.get(path)?.size || 0;
        const ce = efferent.get(path)?.size || 0;
        // Abstraktheit: Interfaces, Annotationstypen und abstrakte Klassen. Ein Package aus
        // lauter Schnittstellen ist maximal abstrakt (A=1) – dort DARF alles hinzeigen.
        const abstractCount = list.filter((c) => isAbstractType(c)).length;
        const a = list.length ? abstractCount / list.length : 0;
        const i = ca + ce === 0 ? null : ce / (ca + ce);
        return {
          path,
          classes: list.length,
          loc: list.reduce((s, c) => s + (c.loc ?? 0), 0),
          complexity: list.reduce((s, c) => s + (c.complexity ?? 0), 0),
          ca,
          ce,
          abstractness: round2(a),
          instability: i == null ? null : round2(i),
          // Abstand zur Hauptsequenz: 0 = ausgewogen, 1 = entweder starr und konkret ("zone of
          // pain") oder abstrakt und von niemandem benutzt ("zone of uselessness").
          distance: i == null ? null : round2(Math.abs(a + i - 1)),
          cycle: null as number | null,
        };
      })
      .sort((x, y) => y.classes - x.classes);
  }

  private packagePairs(classes: ClassRow[], pairs: Pair[]): Pair[] {
    const pkgOf = new Map<number, string>(classes.map((c) => [c.id, c.package || '(default)']));
    const index = new Map<string, number>();
    const names: string[] = [];
    const idOf = (p: string) => {
      if (!index.has(p)) {
        index.set(p, names.length);
        names.push(p);
      }
      return index.get(p)!;
    };
    // Der Zyklensucher arbeitet auf Zahlen; die Package-Pfade bekommen deshalb laufende Nummern
    // und werden vom Aufrufer ueber `members` wieder benannt.
    const merged = new Map<string, Pair>();
    for (const p of pairs) {
      const a = pkgOf.get(p.from)!;
      const b = pkgOf.get(p.to)!;
      if (a === b) continue;
      const key = `${a}\u0000${b}`;
      const prev = merged.get(key);
      if (prev) {
        prev.count += p.count;
        if ((BREAK_ORDER[p.kind] ?? 9) < (BREAK_ORDER[prev.kind] ?? 9)) prev.kind = p.kind;
        for (const m of p.members) {
          if (!prev.members.includes(m) && prev.members.length < MEMBER_SAMPLE) prev.members.push(m);
        }
      } else {
        merged.set(key, {
          from: idOf(a),
          to: idOf(b),
          count: p.count,
          kind: p.kind,
          confidence: p.confidence,
          members: [...p.members],
        });
      }
    }
    // Erst jetzt die Nummern gegen die Pfade tauschen – der Sucher bekommt sie als `any`.
    return [...merged.values()].map((m) => ({ ...m, from: names[m.from] as any, to: names[m.to] as any }));
  }

  // --- Zyklen ----------------------------------------------------------------------------------
  //
  // Tarjan, ITERATIV. Eine rekursive Fassung ist kuerzer, kippt aber bei einer langen
  // Abhaengigkeitskette in den Stack-Overflow – und genau eine solche Codebasis ist der Grund,
  // warum jemand nach Zyklen sucht.
  //
  // Oeffentlich aus demselben Grund wie `resolveEdges`: der Drift-Bericht laesst sie ueber den
  // Stand von damals laufen. „Dieser Kreis ist neu" ist nur eine Aussage, wenn beide Staende mit
  // derselben Rechnung gesucht wurden.
  findCycles(
    nodes: Array<number | string>,
    pairs: Pair[],
    // `false` = Schichten ignorieren · `true` = die Konvention · eine FUNKTION = die aufgeschriebene
    // Schichtregel. Der dritte Fall ist der Grund für den Umbau: die Bruchstelle soll gegen das
    // entscheiden, was jemand festgelegt hat, und nicht gegen das, was Wikit vermutet.
    useLayers: boolean | ((from: any, to: any) => boolean) = false,
  ): Array<{ members: Array<number | string>; chain: Array<number | string>; weakest: any }> {
    const adj = new Map<any, any[]>();
    const edgeOf = new Map<string, Pair>();
    for (const n of nodes) adj.set(n, []);
    for (const p of pairs) {
      if (!adj.has(p.from)) adj.set(p.from, []);
      adj.get(p.from)!.push(p.to);
      edgeOf.set(`${p.from}\u0000${p.to}`, p);
    }

    const index = new Map<any, number>();
    const low = new Map<any, number>();
    const onStack = new Set<any>();
    const stack: any[] = [];
    const sccs: any[][] = [];
    let counter = 0;

    for (const start of adj.keys()) {
      if (index.has(start)) continue;
      // Jeder Rahmen merkt sich, welchen Nachbarn er als naechstes besucht (`i`) – das ersetzt die
      // Ruecksprungadresse der rekursiven Fassung.
      const frames: Array<{ v: any; i: number }> = [{ v: start, i: 0 }];
      index.set(start, counter);
      low.set(start, counter);
      counter++;
      stack.push(start);
      onStack.add(start);

      while (frames.length) {
        const frame = frames[frames.length - 1];
        const neighbours = adj.get(frame.v) || [];
        if (frame.i < neighbours.length) {
          const w = neighbours[frame.i++];
          if (!index.has(w)) {
            index.set(w, counter);
            low.set(w, counter);
            counter++;
            stack.push(w);
            onStack.add(w);
            frames.push({ v: w, i: 0 });
          } else if (onStack.has(w)) {
            low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
          }
          continue;
        }
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
        if (low.get(frame.v) === index.get(frame.v)) {
          const group: any[] = [];
          for (;;) {
            const w = stack.pop();
            onStack.delete(w);
            group.push(w);
            if (w === frame.v) break;
          }
          // Eine Gruppe aus einem Knoten ist kein Zyklus (Selbstbezuege sind bereits raus).
          if (group.length > 1) sccs.push(group);
        }
      }
    }

    return sccs
      .sort((a, b) => b.length - a.length)
      .map((group) => {
        const chain = shortestCycle(group, adj);
        return { members: group, chain, weakest: weakestOn(chain, edgeOf, useLayers) };
      });
  }
}

// --- Reine Helfer ------------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Gerichtete Klassenpaare zu je EINEM Paar zusammenfassen.
 *
 * Mehrere Aufrufe zwischen denselben zwei Klassen sind eine Abhaengigkeit, kein Dutzend – genau so
 * ist Ca/Ce bei Martin definiert. Fuer die Bruchstelle zaehlt die am leichtesten aufzuloesende Art
 * des Paares (`BREAK_ORDER`), fuer die Sicherheit die schlechteste Konfidenz.
 *
 * Eigene Funktion, weil es ZWEI Aufrufer gibt: `resolveEdges` (aus den gespeicherten Kanten) und
 * der Sandkasten, sobald ein vorgemerkter Umbau zwei Paare aufeinander schiebt – eine umgedrehte
 * Kante auf eine schon vorhandene Gegenrichtung, oder zwei zusammengelegte Klassen. Zweimal
 * geschrieben waeren es zwei Auflosungsregeln, und der Vergleich zwischen den beiden Staenden
 * maesse dann die Regeln statt den Umbau.
 */
export function mergePairs(list: Pair[]): Pair[] {
  const merged = new Map<string, Pair>();
  for (const p of list) {
    const key = `${p.from}\u0000${p.to}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...p, members: p.members.slice(0, MEMBER_SAMPLE) });
      continue;
    }
    prev.count += p.count;
    if ((BREAK_ORDER[p.kind] ?? 9) < (BREAK_ORDER[prev.kind] ?? 9)) prev.kind = p.kind;
    if (p.confidence < prev.confidence) prev.confidence = p.confidence;
    for (const m of p.members) {
      if (!prev.members.includes(m) && prev.members.length < MEMBER_SAMPLE) prev.members.push(m);
    }
  }
  return [...merged.values()];
}

// Die Bruchstelle nennt ihre Enden BEIM NAMEN – auf Klassenebene sind `from`/`to` Datei-Ids, und
// eine Zahl in einem Satz wie "break X → Y" waere keine Auskunft.
function labelWeakest(weakest: any, label: (v: any) => string): any {
  if (!weakest) return null;
  return { ...weakest, fromLabel: label(weakest.from), toLabel: label(weakest.to) };
}

function isAbstractType(c: ClassRow): boolean {
  const t = (c.class_type || '').toLowerCase();
  if (t === 'interface' || t === 'annotation') return true;
  return safeJson<string[]>(c.class_modifiers, [])?.includes('abstract') ?? false;
}

/**
 * Perzentilrang-Funktion ueber eine Werteliste: `f(x)` = Anteil der Werte, die kleiner sind.
 *
 * Ueber eine sortierte Kopie plus binaerer Suche statt einer Map, weil auch Werte gefragt werden
 * duerfen, die so nicht in der Liste stehen. Alle gleich (typisch: jede Klasse hat 0 Aenderungen)
 * -> ueberall 0, und der Aufrufer entscheidet, ob er die Dimension dann ueberhaupt zeigt.
 */
/**
 * Gewicht eines Wertes: halb Rang, halb Größenordnung – beides in 0…1.
 *
 * Der Rang sagt „wie viele sind kleiner", die Größenordnung „um wieviel". Erst zusammen ergeben sie
 * eine Rangliste, die sowohl robust gegen einen Ausreißer ist als auch den Unterschied zwischen
 * 8 und 100 Verzweigungen kennt.
 *
 * Die Größenordnung läuft LOGARITHMISCH gegen das Maximum. Der Logarithmus erledigt die
 * Ausreißer-Dämpfung bereits: 400 Zeilen gegen eine 4000-Zeilen-Klasse ergeben 0,72 und nicht 0,1,
 * wie es eine lineare Skala täte.
 *
 * ⚠️ Bewusst gegen das Maximum und NICHT gegen ein hohes Perzentil: bei zwanzig Klassen ist das
 * 95. Perzentil der zweitgrößte Wert, also erreichen die beiden größten beide den Deckel und sind
 * wieder ununterscheidbar – gemessen an der Demo-Codebasis lagen 100 und 8 Verzweigungen damit
 * gleichauf. Genau der Fall, den diese Funktion beheben soll.
 */
function weigher(values: number[]): (v: number) => number {
  const rank = percentiler(values);
  const denom = Math.log1p(Math.max(1, ...values.map((v) => Math.max(0, v))));
  return (v: number) => {
    const magnitude = Math.min(1, Math.log1p(Math.max(0, v)) / denom);
    return (rank(v) + magnitude) / 2;
  };
}

function percentiler(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v: number) => {
    if (!n) return 0;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  };
}

/**
 * Der kuerzeste Kreis innerhalb einer Zyklengruppe – die Kette, die man zeigen kann.
 *
 * Eine Gruppe aus 40 Klassen ist als Liste keine Auskunft; "A → B → C → A" ist eine. Gesucht wird
 * per BFS von mehreren Startknoten aus zurueck zum Start, und der kuerzeste gefundene Kreis
 * gewinnt. Der Deckel (CYCLE_PROBE_NODES) kostet nichts an Aussage: der kuerzeste Kreis einer
 * Gruppe geht durch viele ihrer Knoten, und ein laengerer waere ohnehin die schlechtere Erklaerung.
 */
function shortestCycle(group: any[], adj: Map<any, any[]>): any[] {
  const inGroup = new Set(group);
  let best: any[] | null = null;
  for (const start of group.slice(0, CYCLE_PROBE_NODES)) {
    const prev = new Map<any, any>();
    const queue: any[] = [start];
    const seen = new Set([start]);
    let found: any[] | null = null;
    while (queue.length && !found) {
      const v = queue.shift();
      for (const w of adj.get(v) || []) {
        if (!inGroup.has(w)) continue;
        if (w === start) {
          const path = [v];
          let cur = v;
          while (prev.has(cur)) {
            cur = prev.get(cur);
            path.unshift(cur);
          }
          found = [...path, start];
          break;
        }
        if (seen.has(w)) continue;
        seen.add(w);
        prev.set(w, v);
        queue.push(w);
      }
    }
    if (found && (!best || found.length < best.length)) best = found;
  }
  return best || [...group, group[0]];
}

/**
 * Die Kante auf der Kette, die am ehesten aufzuloesen ist – ein VORSCHLAG, keine Wahrheit.
 *
 * Rangfolge: Art zuerst (ein Typbezug laesst sich durch ein Interface ersetzen, ein Aufruf
 * selten), dann die Zahl der Fundstellen (eine einzelne Benutzung ist schneller entfernt als
 * zwanzig), dann die Sicherheit (eine geratene Kante ist womoeglich gar keine).
 */
function weakestOn(
  chain: any[],
  edgeOf: Map<string, Pair>,
  useLayers: boolean | ((from: any, to: any) => boolean) = false,
): any {
  // Woran die Schichtfrage entschieden wird: an der aufgeschriebenen Regel, wenn es eine gibt –
  // sonst an der Konvention. Der Unterschied faehrt bis in die Oberflaeche mit (`layerSource`), denn
  // "sieht aus wie" und "verstoesst gegen deine Regel" sind zwei verschieden starke Saetze.
  const violates = typeof useLayers === 'function' ? useLayers : useLayers ? againstLayers : null;

  // Rangfolge als Tupel, in dieser Reihenfolge verglichen (kleiner ist besser):
  //   1. Schichtverstoss – schlaegt alles. Eine Kante, die von innen zurueck nach aussen laeuft,
  //      IST der Fehler; die billigste Kante daneben ist regelmaessig `service -> repo`, also
  //      ausgerechnet die Richtung, die bleiben soll. Gemessen an der Demo-Codebasis schlug der
  //      Vorschlag genau diese vor, bevor die Stufe davor kam.
  //   2. Art der Kante  – ein Typbezug loest sich leichter als ein Aufruf.
  //   3. Fundstellen    – eine einzelne Benutzung ist schneller entfernt als zwanzig.
  const rank = (e: Pair): number[] => [
    violates && violates(e.from, e.to) ? 0 : 1,
    BREAK_ORDER[e.kind] ?? 9,
    e.count,
  ];
  const better = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };

  let best: Pair | null = null;
  let bestRank: number[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const e = edgeOf.get(`${chain[i]}\u0000${chain[i + 1]}`);
    if (!e) continue;
    const r = rank(e);
    if (!best || better(r, bestRank)) {
      best = e;
      bestRank = r;
    }
  }
  if (!best) return null;
  return {
    from: best.from,
    to: best.to,
    kind: best.kind,
    count: best.count,
    // Der Oberflaeche sagen, WARUM diese – sie soll die Konvention nicht ein zweites Mal raten.
    againstLayers: !!(violates && violates(best.from, best.to)),
    // 'rule' = der Betreiber hat die Schichten aufgeschrieben, 'convention' = geraten. Die Ansicht
    // formuliert danach als Vermutung oder als Feststellung.
    layerSource: typeof useLayers === 'function' ? 'rule' : 'convention',
  };
}
