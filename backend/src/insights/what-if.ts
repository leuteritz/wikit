import type { ClassRow, Pair } from './insights.service';

/**
 * **Was wäre, wenn?** – die reine Rechnung hinter dem Sandkasten.
 *
 * Der Bericht sagt, was nicht stimmt (Zyklen, Brandherde, Regelverstöße), und `CyclePlan`/`SplitPlan`
 * sagen, was man tun könnte. Die Frage direkt dahinter beantwortet keiner von beiden: **und was
 * bringt es?** – nicht für den einen Befund, sondern für den ganzen Bestand. Eine Kante wegzunehmen
 * löst selten nur einen Zyklus: sie verschiebt Instabilität, kann eine Regel brechen, die vorher
 * hielt, und macht eine andere Klasse zum schwersten Brocken.
 *
 * Diese Datei kennt **keine Datenbank** (gleiche Bauart wie `test-shadow.ts` und `arch-rules.ts`):
 * sie nimmt den Bestand, wie der Bericht ihn ohnehin auflöst (`classes` + `pairs`), und gibt ihn
 * verändert zurück. Alles Weitere – Zyklen, Kennzahlen, Regelprüfung – rechnet danach **dieselbe**
 * Rechnung wie für den echten Stand. Genau das ist die Bauart von `drift.service.ts`: zwei Stände,
 * eine Rechnung. Eine zweite Fassung der Kennzahlen für den simulierten Stand hiesse, den
 * Unterschied zwischen zwei Rechnungen zu messen statt den zwischen zwei Ständen.
 *
 * Die Festlegungen:
 *
 * 1. ⚠️ **Nichts hiervon wird geschrieben.** Der Sandkasten ist eine Frage, keine Handlung. „Kante
 *    entfernen" hiesse in der Datenbank einen Tombstone zu setzen – der bedeutet aber „diese Kante
 *    gibt es gar nicht", nicht „ich habe sie entfernt", und der Drift-Bericht müsste den Klick
 *    danach korrekt als Nicht-Änderung melden, während die Kennzahlen sich bewegt hätten. Der echte
 *    Weg zurück bleibt: umbauen, neu hochladen, Drift lesen.
 *
 * 2. ⚠️ **Jeder Eingriff sagt, ob er überhaupt gegriffen hat** (`applied` + `reason`). Zwei Klicks
 *    auf dieselbe Kante, eine Klasse, die ein früherer Eingriff schon zusammengelegt hat – ein
 *    wirkungsloser Eingriff, der stumm in der Liste steht, macht die ganze Bilanz unglaubwürdig.
 *    Dieselbe Regel wie der `inert`-Zustand einer Architektur-Regel.
 *
 * 3. ⚠️ **Der PREIS wird mitgerechnet, nicht nur der Gewinn** (`cost`). „3 Zyklen weniger" ohne
 *    „14 Aufrufstellen und 6 Klassen betroffen" ist eine Werbung, keine Entscheidungsgrundlage –
 *    dieselbe Regel wie `shared` im Aufteilungsvorschlag.
 *
 * 4. **Die Eingriffe wirken NACHEINANDER.** Jeder sieht den Stand nach seinen Vorgängern; nur so
 *    lässt sich ein Umbau aus mehreren Schritten überhaupt durchrechnen.
 */

/** Wie viele Mitgliedsnamen ein Paar mitführt – dieselbe Größenordnung wie im Bericht. */
const MEMBER_SAMPLE = 3;

export type Change =
  | { op: 'remove-edge'; from: number; to: number }
  | { op: 'invert-edge'; from: number; to: number }
  | { op: 'move-class'; id: number; package: string }
  | { op: 'merge-classes'; id: number; into: number }
  | { op: 'remove-class'; id: number };

export type ChangeCost = {
  /** Klassen, deren Quelltext jemand anfassen muss. */
  classes: number;
  /** Aufrufstellen/Fundstellen dahinter – die Zahl, die den Aufwand wirklich bestimmt. */
  sites: number;
  /** Dateien, die neu entstehen (das Interface einer umgedrehten Kante). */
  newFiles: number;
  /** Codezeilen, die ihren Platz wechseln (Zusammenlegen). */
  movedLines: number;
};

export type AppliedChange = {
  op: Change['op'];
  /** Was der Eingriff meint, in einer Zeile mit echten Namen. */
  title: string;
  /** Was er im Code bedeutet – Anfängersprache, gleiche Regel wie in `CyclePlan`. */
  detail: string;
  applied: boolean;
  /** Warum er nichts bewirkt hat. `null`, wenn er gegriffen hat. */
  reason: string | null;
  /** Was dagegen spricht, obwohl er greift (z. B. „14 Klassen benutzen sie noch"). */
  warning: string | null;
  cost: ChangeCost;
  /** Die Enden, damit die Oberfläche nach `/code` springen kann. */
  refs: number[];
};

export type WhatIfResult = {
  classes: ClassRow[];
  /** ⚠️ Kann Doppelpaare enthalten – der Aufrufer normalisiert mit derselben Funktion, die auch
   *  `resolveEdges` benutzt. Eine eigene Verschmelzungsregel hier wäre eine zweite Auflösung. */
  pairs: Pair[];
  applied: AppliedChange[];
  /** Die Summe über alle Eingriffe, die gegriffen haben. */
  cost: ChangeCost & { classes: number };
};

const EMPTY_COST: ChangeCost = { classes: 0, sites: 0, newFiles: 0, movedLines: 0 };

/**
 * Eingaben von aussen in Eingriffe – oder eine Meldung, was daran nicht stimmt.
 *
 * Hier und nicht im Controller, weil die Form der Eingriffe zu dieser Rechnung gehört: eine zweite
 * Prüfung dort liefe beim nächsten neuen Eingriff auseinander.
 */
export function parseChanges(raw: any): { changes: Change[]; error: string | null } {
  if (!Array.isArray(raw)) return { changes: [], error: 'Expected { changes: [...] }' };
  const out: Change[] = [];
  for (const [i, c] of raw.entries()) {
    const at = `changes[${i}]`;
    const num = (v: any) => (Number.isInteger(v) && v > 0 ? Number(v) : null);
    switch (c?.op) {
      case 'remove-edge':
      case 'invert-edge': {
        const from = num(c.from);
        const to = num(c.to);
        if (from == null || to == null) return { changes: [], error: `${at}: needs from and to class ids` };
        out.push({ op: c.op, from, to });
        break;
      }
      case 'move-class': {
        const id = num(c.id);
        if (id == null) return { changes: [], error: `${at}: needs a class id` };
        if (typeof c.package !== 'string') return { changes: [], error: `${at}: needs a target package` };
        out.push({ op: 'move-class', id, package: c.package.trim() });
        break;
      }
      case 'merge-classes': {
        const id = num(c.id);
        const into = num(c.into);
        if (id == null || into == null) return { changes: [], error: `${at}: needs id and into` };
        out.push({ op: 'merge-classes', id, into });
        break;
      }
      case 'remove-class': {
        const id = num(c.id);
        if (id == null) return { changes: [], error: `${at}: needs a class id` };
        out.push({ op: 'remove-class', id });
        break;
      }
      default:
        return { changes: [], error: `${at}: unknown operation “${String(c?.op ?? '')}”` };
    }
  }
  return { changes: out, error: null };
}

/**
 * Die Eingriffe auf einen aufgelösten Bestand anwenden.
 *
 * Gearbeitet wird auf Kopien – der echte Bestand des Aufrufers darf sich nicht bewegen, er ist die
 * „Vorher"-Seite derselben Bilanz.
 */
export function applyChanges(classesIn: ClassRow[], pairsIn: Pair[], changes: Change[]): WhatIfResult {
  let classes = classesIn.map((c) => ({ ...c }));
  let pairs = pairsIn.map((p) => ({ ...p, members: [...p.members] }));

  // Namen aus dem UNVERÄNDERTEN Bestand: eine zusammengelegte oder entfernte Klasse soll in der
  // Begründung weiter bei ihrem Namen genannt werden („X is gone" braucht X).
  const nameOf = new Map<number, string>(classesIn.map((c) => [c.id, c.class_name]));
  const label = (id: number) => nameOf.get(id) || `#${id}`;

  const applied: AppliedChange[] = [];
  const touchedClasses = new Set<number>();
  const total: ChangeCost = { ...EMPTY_COST };

  const alive = () => new Set(classes.map((c) => c.id));
  const findPair = (from: number, to: number) => pairs.find((p) => p.from === from && p.to === to) || null;
  const usersOf = (id: number) => pairs.filter((p) => p.to === id);

  const skip = (change: Change, title: string, detail: string, reason: string, refs: number[]): void => {
    applied.push({ op: change.op, title, detail, applied: false, reason, warning: null, cost: { ...EMPTY_COST }, refs });
  };

  const done = (
    change: Change,
    title: string,
    detail: string,
    cost: ChangeCost,
    refs: number[],
    warning: string | null = null,
  ): void => {
    applied.push({ op: change.op, title, detail, applied: true, reason: null, warning, cost, refs });
    total.sites += cost.sites;
    total.newFiles += cost.newFiles;
    total.movedLines += cost.movedLines;
    for (const id of refs) touchedClasses.add(id);
  };

  for (const change of changes) {
    const live = alive();

    if (change.op === 'remove-edge' || change.op === 'invert-edge') {
      const title = `${label(change.from)} → ${label(change.to)}`;
      const inverting = change.op === 'invert-edge';
      const verb = inverting ? 'Turn around' : 'Remove';
      if (!live.has(change.from) || !live.has(change.to)) {
        skip(change, `${verb} ${title}`, '', 'One of the two classes is no longer there.', [change.from, change.to]);
        continue;
      }
      const pair = findPair(change.from, change.to);
      if (!pair) {
        skip(change, `${verb} ${title}`, '', 'There is no relation in this direction.', [change.from, change.to]);
        continue;
      }

      pairs = pairs.filter((p) => p !== pair);
      // Umdrehen heisst nicht „Pfeil malen": die benutzende Klasse beschreibt, was sie braucht, und
      // die benutzte erfüllt es. Die Abhängigkeit bleibt, ihre Richtung kehrt sich um – und mit ihr
      // die Zahl der Fundstellen, denn dieselben Stellen werden umgeschrieben.
      if (inverting) pairs.push({ ...pair, from: pair.to, to: pair.from });

      const members = pair.members.length ? ` (${pair.members.slice(0, MEMBER_SAMPLE).join(', ')})` : '';
      const sites = `${pair.count} ${pair.count === 1 ? 'place' : 'places'}${members}`;
      done(
        change,
        `${verb} ${title}`,
        inverting
          ? `${label(change.from)} declares what it needs as an interface, ${label(change.to)} implements it — ${sites}.`
          : `${label(change.from)} stops depending on ${label(change.to)} — ${sites}.`,
        { classes: inverting ? 2 : 1, sites: pair.count, newFiles: inverting ? 1 : 0, movedLines: 0 },
        [change.from, change.to],
      );
      continue;
    }

    if (change.op === 'move-class') {
      const cls = classes.find((c) => c.id === change.id);
      const title = `Move ${label(change.id)} to ${change.package || '(default)'}`;
      if (!cls) {
        skip(change, title, '', 'That class is no longer there.', [change.id]);
        continue;
      }
      const from = cls.package || '';
      if (from === change.package) {
        skip(change, title, '', `It already sits in ${change.package || '(default)'}.`, [change.id]);
        continue;
      }
      cls.package = change.package || null;

      // Der Preis eines Umzugs steht nicht in der Klasse selbst, sondern bei allen, die sie
      // importieren: ihre Importzeile nennt den alten Ort. Wer im ZIELpackage sitzt, braucht danach
      // gar keine mehr – der Umzug macht die Beziehung dort zu einer innerhalb des Packages.
      const pkgOf = new Map<number, string>(classes.map((c) => [c.id, c.package || '']));
      const importers = pairs.filter(
        (p) => (p.to === change.id || p.from === change.id) && pkgOf.get(p.from === change.id ? p.to : p.from) !== cls.package,
      );
      done(
        change,
        title,
        `Its package line changes, and ${importers.length} ${importers.length === 1 ? 'class updates its import' : 'classes update their imports'}.`,
        { classes: 1 + importers.length, sites: importers.reduce((n, p) => n + p.count, 0), newFiles: 0, movedLines: cls.loc ?? 0 },
        [change.id, ...importers.map((p) => (p.from === change.id ? p.to : p.from))],
      );
      continue;
    }

    if (change.op === 'merge-classes') {
      const title = `Merge ${label(change.id)} into ${label(change.into)}`;
      if (change.id === change.into) {
        skip(change, title, '', 'A class cannot be merged into itself.', [change.id]);
        continue;
      }
      const gone = classes.find((c) => c.id === change.id);
      const host = classes.find((c) => c.id === change.into);
      if (!gone || !host) {
        skip(change, title, '', 'One of the two classes is no longer there.', [change.id, change.into]);
        continue;
      }

      const users = usersOf(change.id).filter((p) => p.from !== change.into);
      const moved = pairs.filter((p) => p.from === change.id || p.to === change.id);
      const sites = moved.reduce((n, p) => n + p.count, 0);

      // Alles, was an der verschwindenden Klasse hing, hängt danach an der aufnehmenden. Was dabei
      // auf sie selbst zeigt, ist kein Zyklus mehr, sondern ein Selbstbezug – und der ist weder
      // Kopplung noch Kreis (gleiche Regel wie in `resolveEdges`).
      pairs = pairs
        .map((p) => ({
          ...p,
          from: p.from === change.id ? change.into : p.from,
          to: p.to === change.id ? change.into : p.to,
        }))
        .filter((p) => p.from !== p.to);
      classes = classes.filter((c) => c.id !== change.id);

      // ⚠️ Größe und Verzweigungen wandern MIT. Ohne das sähe jedes Zusammenlegen gut aus – eine
      // Klasse weniger, ein Zyklus vielleicht auch –, während in Wirklichkeit die aufnehmende
      // Klasse genau um das wächst, was die andere mitbringt. Der Brandherd-Reiter zeigt es dann.
      host.loc = (host.loc ?? 0) + (gone.loc ?? 0);
      host.complexity = (host.complexity ?? 0) + (gone.complexity ?? 0);

      done(
        change,
        title,
        `${label(change.id)} disappears; its ${gone.loc ?? 0} lines and every relation move to ${label(change.into)}.`,
        { classes: 2 + users.length, sites, newFiles: 0, movedLines: gone.loc ?? 0 },
        [change.id, change.into, ...users.map((p) => p.from)],
        users.length ? `${users.length} ${users.length === 1 ? 'class names' : 'classes name'} ${label(change.id)} directly and would have to be rewritten.` : null,
      );
      continue;
    }

    // remove-class
    const cls = classes.find((c) => c.id === change.id);
    const title = `Delete ${label(change.id)}`;
    if (!cls) {
      skip(change, title, '', 'That class is no longer there.', [change.id]);
      continue;
    }
    const users = usersOf(change.id);
    const sites = users.reduce((n, p) => n + p.count, 0);
    classes = classes.filter((c) => c.id !== change.id);
    pairs = pairs.filter((p) => p.from !== change.id && p.to !== change.id);
    done(
      change,
      title,
      `${cls.loc ?? 0} lines and every relation it had are gone.`,
      { classes: 1 + users.length, sites, newFiles: 0, movedLines: cls.loc ?? 0 },
      [change.id, ...users.map((p) => p.from)],
      // ⚠️ Der wichtigste Satz dieser Datei: „löschen" ist gratis gerechnet und teuer in echt.
      users.length
        ? `${users.length} ${users.length === 1 ? 'class still uses' : 'classes still use'} it — those come first.`
        : null,
    );
  }

  return {
    classes,
    pairs,
    applied,
    cost: { ...total, classes: touchedClasses.size },
  };
}
