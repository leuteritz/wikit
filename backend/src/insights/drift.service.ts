import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { computeEdges, ComputedEdge, EdgeParseCache, fqcnOf, importsFrom } from '../common/edge-compute';
import { countCodeLines } from '../common/code-metrics';
import { ClassRow, EdgeRow, InsightsService, Pair } from './insights.service';
import { chainPairs, pairKey, partitionCycles } from './cycle-diff';

/**
 * **Was hat sich verändert?** – der einzige Blick in `/insights`, der keinen Zustand beschreibt,
 * sondern eine Bewegung.
 *
 * Alle anderen Reiter zeigen ein Standbild: Zyklen, Brandherde, Packages, Außenrand. Die Frage
 * davor lautet aber oft „ist es durch den letzten Import besser oder schlechter geworden?" – und
 * die beantwortet ein Standbild grundsätzlich nicht. Der teuerste Befund einer Codebasis ist ein
 * Zyklus, den niemand entstehen sah: beim Entstehen kostet er eine Kante, ein halbes Jahr später
 * den Umbauplan aus `CyclePlan`.
 *
 * Möglich ist das ohne eine einzige neue Spalte: `java_file_versions.source` hält jeden früheren
 * Quelltext vollständig. Die Festlegungen:
 *
 * 1. **Der Bezugspunkt ist ein ZEITPUNKT, kein „vorheriger Stand je Klasse".** Ein Vergleich gegen
 *    die jeweils vorletzte Version jeder Klasse mischt Stände, die nie gleichzeitig existiert
 *    haben – und ein Zyklus aus solchen Ständen ist erfunden. Der Schnitt (`since`) gilt für alle
 *    Klassen gleich: je Klasse zählt ihre letzte Version bis zu diesem Tag.
 *
 * 2. **BEIDE Stände werden mit derselben Rechnung gerechnet** (`computeEdges`), keiner davon aus
 *    `java_edges` gelesen. Sonst maß der Bericht die Unterschiede zwischen gespeicherten und
 *    gerechneten Kanten mit – also seine eigene Versionsgeschichte statt der des Codes.
 *
 * 3. **Was der NUTZER am Graphen getan hat, ist kein Drift.** Verworfene Kanten (Tombstones)
 *    fallen auf beiden Seiten weg, manuelle Kanten stehen auf beiden Seiten dabei. Beides trägt
 *    kein Datum; nur so kann ein Klick im Graphen nicht als Codeänderung erscheinen.
 *
 * 4. **Gelöschte Klassen hinterlassen keine Spur.** Ihre Versionen hängen an einer CASCADE. Der
 *    Bericht schreibt das an, statt „nichts entfernt" zu behaupten.
 */

// Wie viele Bezugspunkte zur Auswahl stehen. Weiter zurück als ein paar Wochen fragt niemand, und
// die Liste ist ein Auswahlfeld, keine Historie.
const MAX_POINTS = 30;

// Deckel der Listen. Ein Massen-Reimport erzeugt tausende Befunde; was wegfaellt, wird GEZAEHLT
// (ein stiller Deckel liest sich wie „mehr gibt es nicht").
const PAIR_SAMPLE = 60;
const CLASS_SAMPLE = 40;
const CYCLE_SAMPLE = 12;
// Wie viele Klassen ein Zyklus namentlich nennt, bevor gezaehlt wird – dieselbe Groessenordnung wie
// die Kette im Zyklen-Reiter.
const CYCLE_NAMES = 8;

// Wie viele Versions-Quelltexte auf einmal geladen werden. `source` ist neben `raw_source` die
// groesste Spalte der Datenbank – ein Massen-Reimport haette sonst hunderte Megabyte auf einmal im
// Speicher, und der Pi hat vier Gigabyte fuer alles.
const SOURCE_CHUNK = 60;

type VersionMeta = { id: number; java_file_id: number; version_number: number; created_at: string };

// Eine Klasse im Vergleich: `before` fehlt, wenn es sie damals noch nicht gab.
type Side = { pkg: string; source: string };

@Injectable()
export class DriftService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly parseCache: EdgeParseCache,
    // Aufloesung und Zyklensuche kommen aus dem Bericht selbst – zwei Fassungen davon waeren zwei
    // verschieden gerechnete Graphen, und ihr Unterschied saehe aus wie ein Befund.
    private readonly insights: InsightsService,
  ) {}

  async drift(since?: string | null): Promise<any> {
    const points = await this.points();
    // Ohne zwei verschiedene Tage gibt es nichts zu vergleichen – und das ist ein GRUND, kein
    // leeres Ergebnis (gleiche Regel wie bei `/ask`).
    if (!points.length) return this.empty(points, 'no-history');
    if (points.length < 2 && !since) return this.empty(points, 'single-point');

    // Vorgabe: der Lauf VOR dem letzten. Damit beantwortet der Bericht ohne jede Einstellung genau
    // die Frage, mit der man ihn aufschlaegt: „was hat der letzte Import angerichtet?"
    const chosen = points.find((p) => p.point === since) || points[1] || points[0];
    // SQLite-Zeitstempel sind `YYYY-MM-DD HH:MM:SS` (UTC, ohne Suffix) – ein String-Vergleich
    // ordnet sie korrekt, und der letzte Zeitstempel des Punktes ist der Schnitt.
    const cutoff = chosen.until;

    const classes: Array<ClassRow & { raw_source: string; created_at: string }> = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, class_modifiers, loc, complexity,
              raw_source, created_at
         FROM java_files ORDER BY class_name COLLATE NOCASE`,
    );
    if (!classes.length) return this.empty(points, 'no-classes', chosen.point);

    const versions: VersionMeta[] = await this.ds.query(
      `SELECT id, java_file_id, version_number, created_at FROM java_file_versions
        ORDER BY java_file_id, version_number`,
    );

    // Je Klasse: die letzte Version bis zum Schnitt (= ihr Stand von damals), die letzte ueberhaupt
    // (= ihr Stand von heute) und die aelteste (der Rueckfall, s. unten).
    const baselineVersion = new Map<number, VersionMeta>();
    const latestVersion = new Map<number, VersionMeta>();
    const oldestVersion = new Map<number, VersionMeta>();
    for (const v of versions) {
      const prevLatest = latestVersion.get(v.java_file_id);
      if (!prevLatest || v.version_number > prevLatest.version_number) latestVersion.set(v.java_file_id, v);
      const prevOldest = oldestVersion.get(v.java_file_id);
      if (!prevOldest || v.version_number < prevOldest.version_number) oldestVersion.set(v.java_file_id, v);
      if (v.created_at > cutoff) continue;
      const prev = baselineVersion.get(v.java_file_id);
      if (!prev || v.version_number > prev.version_number) baselineVersion.set(v.java_file_id, v);
    }

    // ⚠️ „Neu" entscheidet `java_files.created_at`, NICHT das Fehlen einer alten Version. Der
    // Unterschied ist keine Feinheit: ein Re-Import sichert den bisherigen Stand einer Klasse ohne
    // Historie erst in diesem Moment als Version 1 (s. `analyzeBatch`). Nach der Versionsregel
    // haette diese Klasse damals nicht existiert – und eine seit Jahren gewachsene Klasse stuende
    // als Neuzugang im Bericht.
    const isNew = (c: { id: number; created_at: string }) => (c.created_at || '') > cutoff;
    // Der Stand von damals, wenn es bis zum Schnitt keinen gab: der aelteste bekannte. Genau er ist
    // bei der eben beschriebenen Nachsicherung der Stand VOR dem Import.
    const baselineOf = (id: number) => baselineVersion.get(id) || oldestVersion.get(id) || null;

    // Welche Quelltexte muessen wirklich geladen werden? Nur die von Klassen, deren Stand von
    // damals NICHT ihr heutiger ist. Bei einem Import von zwanzig Klassen in einer Codebasis von
    // tausend sind das zwanzig – der Rest kostet keine Zeile.
    const needSource: number[] = [];
    for (const c of classes) {
      if (isNew(c)) continue;
      const base = baselineOf(c.id);
      const latest = latestVersion.get(c.id);
      if (base && latest && base.id !== latest.id) needSource.push(base.id);
    }
    const oldSource = new Map<number, string>();
    for (let i = 0; i < needSource.length; i += SOURCE_CHUNK) {
      const ids = needSource.slice(i, i + SOURCE_CHUNK);
      for (const row of await this.ds.query(
        `SELECT id, source FROM java_file_versions WHERE id IN (${ids.join(',')})`,
      )) {
        oldSource.set(Number(row.id), row.source || '');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // --- Die beiden Bestaende ---------------------------------------------------------------
    const before = new Map<number, Side>();
    const after = new Map<number, Side>();
    const added: ClassRow[] = []; // heute da, damals nicht
    const noHistory: number[] = []; // ohne jeden gespeicherten Stand -> keine Aussage moeglich
    for (const c of classes) {
      const pkg = c.package || '';
      after.set(c.id, { pkg, source: c.raw_source || '' });
      if (isNew(c)) {
        added.push(c);
        continue;
      }
      const base = baselineOf(c.id);
      if (!base) {
        // Klasse aus der Zeit vor der Versionierung: es gibt keinen alten Stand, also auch keine
        // Aussage. Ihr heutiger zaehlt fuer beide Seiten – so kann sie weder als Aenderung noch
        // als Neuzugang erscheinen –, und die Zahl steht in der Bilanz.
        noHistory.push(c.id);
        before.set(c.id, { pkg, source: c.raw_source || '' });
        continue;
      }
      const latest = latestVersion.get(c.id);
      before.set(c.id, {
        pkg,
        source: base.id === latest?.id ? c.raw_source || '' : oldSource.get(base.id) || '',
      });
    }

    const beforeIds = new Set(before.keys());
    const beforeClasses = classes.filter((c) => beforeIds.has(c.id));

    // --- Kanten beider Staende ----------------------------------------------------------------
    const manual: EdgeRow[] = await this.ds.query(
      `SELECT source_class, source_pkg, target_class, target_pkg, kind, confidence, method_name
         FROM java_edges WHERE is_manual = 1 AND dismissed = 0`,
    );
    const dismissed: EdgeRow[] = await this.ds.query(
      `SELECT source_class, source_pkg, target_class, target_pkg, kind, method_name
         FROM java_edges WHERE is_manual = 0 AND dismissed = 1`,
    );
    const tomb = new Set(dismissed.map((e) => tombKey(e)));
    const keep = (e: ComputedEdge): boolean => !tomb.has(tombKey(e as any));

    const edgesFor = async (side: Map<number, Side>): Promise<EdgeRow[]> => {
      const res = await computeEdges(
        [...side.values()].map((s) => ({ pkg: s.pkg, source: s.source, imports: importsFrom(s.source) })),
        { cache: this.parseCache },
      );
      return [...res.edges.filter(keep), ...manual] as EdgeRow[];
    };

    const beforePairs = this.insights.resolveEdges(beforeClasses, await edgesFor(before)).pairs;
    const afterResolved = this.insights.resolveEdges(classes, await edgesFor(after));
    const afterPairs = afterResolved.pairs;

    // --- Abhaengigkeiten: was ist dazugekommen, was ist weg? -----------------------------------
    const nameOf = new Map<number, ClassRow>(classes.map((c) => [c.id, c]));
    const key = (p: Pair) => pairKey(p.from, p.to);
    const beforeByKey = new Map(beforePairs.map((p) => [key(p), p]));
    const afterByKey = new Map(afterPairs.map((p) => [key(p), p]));

    const addedPairs = afterPairs.filter((p) => !beforeByKey.has(key(p)));
    // ⚠️ Eine Abhaengigkeit, deren eines Ende es damals noch gar nicht gab, ist keine ENTFERNTE –
    // sie kann nur bei Klassen fehlen, die es auf beiden Seiten gibt.
    const removedPairs = beforePairs.filter((p) => !afterByKey.has(key(p)));

    const describe = (p: Pair) => ({
      from: brief(nameOf.get(p.from)),
      to: brief(nameOf.get(p.to)),
      kind: p.kind,
      count: p.count,
      members: p.members.slice(0, 3),
    });

    // --- Zyklen: der Befund, um dessentwillen es den Reiter gibt -------------------------------
    const cyclesBefore = this.insights.findCycles([...beforeIds], beforePairs);
    const cyclesAfter = this.insights.findCycles(
      classes.map((c) => c.id),
      afterPairs,
    );
    // Was zwischen den beiden Staenden mit den Zyklen passiert ist. Die Regel dafuer („dieselbe
    // GRUPPE, nicht dieselbe Mitgliedermenge") steht in `cycle-diff.ts`, weil der Sandkasten sie
    // ein zweites Mal braucht – dort gegen einen vorgemerkten Umbau statt gegen einen frueheren
    // Stand. Zwei Fassungen davon hiessen, dass der eine Bericht einen geheilten Zyklus meldet, wo
    // der andere schweigt.
    const addedKeys = new Set(addedPairs.map(key));
    const split = partitionCycles(cyclesBefore, cyclesAfter);

    const appeared = split.appeared.map((c) => {
      // Die Kante, die den Kreis schliesst: die einzige seiner Kette, die es damals nicht gab.
      // Genau sie ist die Handlung – ohne sie bleibt „ein Zyklus ist entstanden" ein Befund
      // ohne Adresse.
      const closing = chainPairs(c.chain as number[])
        .filter((k) => addedKeys.has(k))
        .map((k) => {
          const p = afterByKey.get(k)!;
          return describe(p);
        });
      return {
        classes: (c.members as number[]).slice(0, CYCLE_NAMES).map((id) => brief(nameOf.get(id))),
        more: Math.max(0, c.members.length - CYCLE_NAMES),
        length: c.members.length,
        chain: (c.chain as number[]).map((id) => brief(nameOf.get(id))?.name),
        closing,
      };
    });

    const healed = split.healed.map((c) => ({
      classes: (c.members as number[]).slice(0, CYCLE_NAMES).map((id) => brief(nameOf.get(id))),
      more: Math.max(0, c.members.length - CYCLE_NAMES),
      length: c.members.length,
    }));

    // --- Gewachsen, geschrumpft, neu ----------------------------------------------------------
    //
    // Nur Codezeilen, nicht die Komplexitaet: die stuende in `java_files` zwar fuer heute, fuer
    // damals aber nur nach einem zweiten Lauf des schweren Parsers ueber jede geaenderte Klasse –
    // fuer eine Zahl, die in dieselbe Richtung zeigt. `countCodeLines` ist reine Textarbeit und auf
    // beiden Staenden buchstaeblich dieselbe Rechnung.
    const changed: any[] = [];
    for (const c of classes) {
      if (isNew(c)) continue;
      const base = baselineOf(c.id);
      const latest = latestVersion.get(c.id);
      if (!base || !latest || base.id === latest.id) continue;
      const locBefore = countCodeLines(before.get(c.id)?.source || '');
      const locAfter = countCodeLines(after.get(c.id)?.source || '');
      changed.push({
        ...brief(c),
        changedAt: latest.created_at,
        versions: latest.version_number,
        locBefore,
        locAfter,
        delta: locAfter - locBefore,
      });
    }
    changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));

    return {
      available: true,
      reason: null,
      since: chosen.point,
      sinceAt: chosen.at,
      points,
      totals: {
        changed: changed.length,
        added: added.length,
        grew: changed.filter((c) => c.delta > 0).length,
        shrank: changed.filter((c) => c.delta < 0).length,
        lines: changed.reduce((n, c) => n + c.delta, 0),
        addedDeps: addedPairs.length,
        removedDeps: removedPairs.length,
        newCycles: appeared.length,
        healedCycles: healed.length,
        cyclesNow: cyclesAfter.length,
        // Wie bei `/insights`: was sich nicht eindeutig aufloesen liess, wird gezaehlt statt
        // stillschweigend weggelassen.
        unresolved: afterResolved.unresolved,
        // Ohne gespeicherten Stand ist eine Klasse hier nicht vergleichbar – sie gilt als
        // unveraendert, und die Zahl sagt, wie oft das gilt.
        withoutHistory: noHistory.length,
      },
      classes: {
        changed: changed.slice(0, CLASS_SAMPLE),
        added: added.slice(0, CLASS_SAMPLE).map((c) => brief(c)),
        moreChanged: Math.max(0, changed.length - CLASS_SAMPLE),
        moreAdded: Math.max(0, added.length - CLASS_SAMPLE),
      },
      dependencies: {
        added: addedPairs.slice(0, PAIR_SAMPLE).map(describe),
        removed: removedPairs.slice(0, PAIR_SAMPLE).map(describe),
        moreAdded: Math.max(0, addedPairs.length - PAIR_SAMPLE),
        moreRemoved: Math.max(0, removedPairs.length - PAIR_SAMPLE),
      },
      cycles: {
        appeared: appeared.slice(0, CYCLE_SAMPLE),
        healed: healed.slice(0, CYCLE_SAMPLE),
        moreAppeared: Math.max(0, appeared.length - CYCLE_SAMPLE),
        moreHealed: Math.max(0, healed.length - CYCLE_SAMPLE),
      },
    };
  }

  /**
   * Wählbare Bezugspunkte: **Importläufe**, neuester zuerst.
   *
   * Ein Lauf ist die richtige Klammer, weil er der Vorgang ist, nach dessen Folgen man fragt.
   * Über `created_at` zu gruppieren ginge nicht ohne eine erfundene Toleranz – ein Massen-Import
   * verteilt seine Zeilen über die Sekunden, in denen er schreibt. Deshalb steht der Stempel in
   * der Zeile (`batch`, s. schema.ts). Altbestand ohne Stempel fällt auf den **Kalendertag**
   * zurück: gröber, aber nie erfunden.
   *
   * `until` ist der Schnitt des Punktes – der letzte Zeitstempel, der noch zu ihm gehört. „Stand
   * nach diesem Lauf" ist damit unabhängig davon, ob der Punkt ein Lauf oder ein Tag ist.
   */
  private async points(): Promise<Array<{ point: string; at: string; until: string; classes: number }>> {
    const rows = await this.ds.query(
      `SELECT COALESCE(batch, substr(created_at, 1, 10)) AS point,
              MIN(created_at) AS at,
              MAX(created_at) AS until,
              COUNT(DISTINCT java_file_id) AS classes
         FROM java_file_versions
        GROUP BY point ORDER BY point DESC LIMIT ${MAX_POINTS}`,
    );
    return rows.map((r: any) => ({
      point: String(r.point),
      at: String(r.at),
      until: String(r.until),
      classes: Number(r.classes || 0),
    }));
  }

  // Ein leerer Bericht nennt seinen GRUND – „no-history" (nie importiert), „single-point" (erst
  // ein Lauf, es gibt nichts zu vergleichen), „no-classes". Jeder verlangt einen anderen naechsten
  // Schritt, und ein gemeinsames „nichts gefunden" laese sich wie ein Befund ueber den Code.
  private empty(points: any[], reason: string, since: string | null = null): any {
    return {
      available: false,
      reason,
      since,
      sinceAt: null,
      points,
      totals: null,
      classes: null,
      dependencies: null,
      cycles: null,
    };
  }
}

// Die Kurzform einer Klasse: genug fuer Anzeige und Sprung nach `/code`, nicht mehr.
function brief(c?: ClassRow): any {
  if (!c) return null;
  return { id: c.id, name: c.class_name, package: c.package || '' };
}

// Schluessel einer verworfenen Kante – Package MIT, weil zwei gleichnamige Klassen zwei Kanten
// sind. Altbestand ohne Package faellt auf den Namen zurueck, genau wie in `recomputeAutoEdges`.
function tombKey(e: { source_class: string; source_pkg: string | null; target_class: string; target_pkg: string | null; method_name: string | null; kind: string | null }): string {
  const from = e.source_pkg != null ? fqcnOf(e.source_pkg, e.source_class) : e.source_class;
  const to = e.target_pkg != null ? fqcnOf(e.target_pkg, e.target_class) : e.target_class;
  return `${from}\u0000${to}\u0000${e.method_name ?? ''}\u0000${e.kind ?? ''}`;
}
