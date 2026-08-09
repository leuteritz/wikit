/**
 * Wann ist ein Kreis NEU und wann GEHEILT – die eine Regel, die zwei Berichte teilen.
 *
 * `drift` vergleicht den Stand von damals mit dem von heute, `what-if` den Stand von heute mit dem
 * nach einem vorgemerkten Umbau. Es ist dieselbe Frage an zwei verschiedene Paare von Ständen, und
 * eine zweite Fassung davon wäre eine zweite Antwort auf sie: der eine Bericht meldete einen
 * geheilten Zyklus, wo der andere schweigt.
 *
 * ⚠️ **Verglichen werden GRUPPEN, nicht Mitgliedermengen.** Ein Kreis gilt als neu, wenn seine
 * Klassen vorher nicht schon gemeinsam in *einer* SCC lagen. Mengen zu vergleichen ginge daneben,
 * sobald eine Gruppe wächst oder zerfällt: aus einer Gruppe von fünf, die auf vier schrumpft, würde
 * sonst „ein Zyklus geheilt, ein Zyklus neu entstanden" – zwei Befunde für eine Verkleinerung.
 */

/** Was `findCycles` liefert – hier nur so weit, wie der Vergleich es braucht. */
export type CycleLike = {
  members: Array<number | string>;
  chain: Array<number | string>;
  weakest: any;
};

/** Knoten -> Nummer seiner Gruppe. Wer in keiner steckt, fehlt in der Map. */
function groupIndex(cycles: CycleLike[]): Map<number | string, number> {
  const map = new Map<number | string, number>();
  cycles.forEach((c, i) => c.members.forEach((m) => map.set(m, i)));
  return map;
}

/**
 * Lagen alle Mitglieder auf der anderen Seite schon gemeinsam in einer Gruppe?
 *
 * `groups.has(undefined)` fängt den Fall ab, dass eine der Klassen dort in gar keinem Zyklus stand –
 * dann ist der Kreis unabhängig von allem anderen neu bzw. aufgelöst.
 */
function isFresh(cycle: CycleLike, other: Map<number | string, number>): boolean {
  const groups = new Set(cycle.members.map((m) => other.get(m)));
  return groups.size !== 1 || groups.has(undefined);
}

/**
 * Was zwischen zwei Ständen mit den Zyklen passiert ist.
 *
 * `appeared` sind Kreise aus `after`, die es so vorher nicht gab; `healed` Kreise aus `before`, die
 * es nachher nicht mehr gibt. Die Objekte werden unverändert durchgereicht – wie sie benannt und
 * gedeckelt werden, entscheidet der Aufrufer (Drift zeigt Klassennamen, What-if zusätzlich die
 * Kante, die den Kreis geschlossen hat).
 */
export function partitionCycles(
  before: CycleLike[],
  after: CycleLike[],
): { appeared: CycleLike[]; healed: CycleLike[] } {
  const groupBefore = groupIndex(before);
  const groupAfter = groupIndex(after);
  return {
    appeared: after.filter((c) => isFresh(c, groupBefore)),
    healed: before.filter((c) => isFresh(c, groupAfter)),
  };
}

/**
 * Die Kanten einer Zyklenkette als Paar-Schlüssel.
 *
 * ⚠️ `shortestCycle` liefert die Kette BEREITS geschlossen (`A → B → C → A`), der Startknoten steht
 * also zweimal darin – ein zusätzlicher Umlauf vom letzten zum ersten Glied wäre die Kante `A → A`,
 * die es nirgends gibt.
 */
export function chainPairs(chain: Array<number | string>): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chain.length; i++) out.push(pairKey(chain[i], chain[i + 1]));
  return out;
}

/**
 * Der Schluessel eines gerichteten Paares – dieselbe Form, in der `resolveEdges` und `findCycles`
 * ihre Kanten ablegen. Eine zweite Schreibweise hiesse, dass eine Kette nicht mehr auf die Kante
 * zeigt, die der Bericht dazu gespeichert hat.
 *
 * ⚠️ NUL als Trenner, und zwar als `\u0000`-ESCAPE im Quelltext, nie als rohes Byte: mit einem
 * druckbaren Trennzeichen ergaeben `A|B` + `C` und `A` + `B|C` denselben Schluessel – als rohes
 * Byte gilt die Datei ripgrep aber als binaer, jede Suche darin liefert dann KEINE Zeile, und ein
 * trefferloses Ergebnis sieht aus wie „kommt nicht vor".
 */
export const pairKey = (from: number | string, to: number | string): string => `${from}\u0000${to}`;
