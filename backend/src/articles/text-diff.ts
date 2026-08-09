// Der Unterschied zwischen zwei Fassungen eines Artikels -- reine Rechnung, kennt keine
// Datenbank (gleiche Bauart wie insights/test-shadow.ts und insights/arch-rules.ts).
//
// ⚠️ Warum nicht der Unified-Diff aus JavaDiffViewer: der ist ZEILENbasiert, und eine Zeile ist in
// Markdown ein ganzer Absatz. Ein korrigierter Tippfehler faerbt damit fuenf Zeilen rot und
// dieselben fuenf gruen -- die Frage "was hat sich geaendert?" bleibt unbeantwortet, obwohl alles
// dasteht. Fuer Java ist das in Ordnung (dort IST die Zeile die Einheit), fuer Prosa nicht.
// Gerechnet wird deshalb zweistufig: Zeilen gegeneinander, und innerhalb gepaarter Zeilen noch
// einmal Wort fuer Wort.
//
// ⚠️ Gerechnet wird im BACKEND, obwohl der Client die Texte ohnehin holen koennte: die
// `diff`-Bibliothek liegt dort bereits (java.service.ts nutzt sie fuer den Changelog), und sie
// im Frontend ein zweites Mal einzuhaengen hiesse eine neue Abhaengigkeit im Lockfile fuer eine
// Rechnung, die es schon gibt -- dieselbe Regel wie beim server-seitigen Markdown-Rendering.
import { createPatch, diffArrays, diffWordsWithSpace } from 'diff';

/** Ein Stueck einer Zeile: `changed` = gegenueber der anderen Seite neu bzw. entfallen. */
export interface DiffSeg {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  /** `gap` = zusammengefaltete unveraenderte Zeilen (dann zaehlt nur `lines`). */
  kind: 'equal' | 'add' | 'del' | 'change' | 'gap';
  leftNo: number | null;
  rightNo: number | null;
  left: DiffSeg[] | null;
  right: DiffSeg[] | null;
  /** Nur bei `gap`: wie viele unveraenderte Zeilen hier zusammengefasst sind. */
  lines?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
  /** Netto-Zeichen, die dazugekommen bzw. weggefallen sind (der Prosa-Massstab, s. u.). */
  charsAdded: number;
  charsRemoved: number;
}

export interface TextDiff {
  rows: DiffRow[];
  stats: DiffStats;
}

// Unveraenderte Zeilen um eine Aenderung herum, die stehen bleiben.
const CONTEXT_LINES = 3;

// Ab wie vielen unveraenderten Zeilen am Stueck gefaltet wird. Unter 2*CONTEXT+2 waere die
// Faltung laenger als das, was sie versteckt.
const FOLD_FROM = CONTEXT_LINES * 2 + 2;

// ⚠️ Zwei Zeilen werden nur dann Wort fuer Wort verglichen, wenn sie ueberhaupt noch dieselbe
// Zeile SIND. Bei einem komplett neu geschriebenen Absatz findet ein Wortdiff zufaellige
// gemeinsame "der"/"und" und markiert den Rest -- das Ergebnis liest sich wie ein Flickenteppich
// und behauptet dabei eine Verwandtschaft, die es nicht gibt. Darunter gilt die ganze Zeile als
// ersetzt, und das ist die ehrlichere Auskunft.
const PAIR_MIN_SIMILARITY = 0.3;

// Oberhalb dieser Zeilenlaenge entfaellt der Wortdiff. `diffWordsWithSpace` ist in der Laenge
// quadratisch, und eine 8000 Zeichen lange Zeile ist ohnehin keine, an der man ein einzelnes Wort
// sucht -- eine Markdown-Tabelle oder ein eingebetteter Datenblock.
const MAX_WORDDIFF_CHARS = 4000;

// ⚠️ Ein leerer Text hat KEINE Zeile, nicht eine leere. `''.split('\n')` liefert `['']`, und diese
// Phantomzeile findet im Vergleich gegen einen echten Text eine der vielen Leerzeilen von Markdown
// -- gemessen beim Blick auf die aelteste Fassung („gegen nichts"): mitten in einem durchgehend
// neuen Text stand eine Zeile unmarkiert da, als waere sie schon immer dagewesen.
function lines(text: string): string[] {
  const t = text ?? '';
  return t === '' ? [] : t.split('\n');
}

/**
 * Zwei Zeilen Wort fuer Wort vergleichen.
 *
 * Liefert `null`, wenn die beiden zu verschieden sind, um noch als dieselbe Zeile zu gelten --
 * der Aufrufer markiert dann beide Seiten komplett.
 *
 * ⚠️ `diffWordsWithSpace`, nicht `diffWords`: letzteres wirft Whitespace weg, und die Segmente
 * ergaeben aneinandergehaengt nicht mehr die Originalzeile. Genau das tut die Ansicht aber -- sie
 * setzt den Text aus den Segmenten zusammen, und eine verschluckte Einrueckung waere eine
 * Aenderung, die niemand vorgenommen hat.
 */
function pairLines(left: string, right: string): { left: DiffSeg[]; right: DiffSeg[] } | null {
  if (left.length > MAX_WORDDIFF_CHARS || right.length > MAX_WORDDIFF_CHARS) return null;

  const parts = diffWordsWithSpace(left, right);
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.length;

  const longest = Math.max(left.length, right.length);
  // Zwei leere Zeilen sind identisch, nicht unaehnlich -- ohne den Sonderfall waere 0/0 = NaN.
  const similarity = longest === 0 ? 1 : same / longest;
  if (similarity < PAIR_MIN_SIMILARITY) return null;

  const l: DiffSeg[] = [];
  const r: DiffSeg[] = [];
  for (const p of parts) {
    if (p.added) r.push({ text: p.value, changed: true });
    else if (p.removed) l.push({ text: p.value, changed: true });
    else {
      l.push({ text: p.value, changed: false });
      r.push({ text: p.value, changed: false });
    }
  }
  return { left: l, right: r };
}

/**
 * Der vollstaendige Vergleich zweier Texte als Zeilenpaare (zwei Spalten).
 *
 * ⚠️ Jede Reihe traegt BEIDE Seiten, auch wenn eine davon leer ist. Eine Liste aus abwechselnd
 * linken und rechten Zeilen waere ein Unified-Diff mit anderer Farbe -- der Gewinn der zwei
 * Spalten entsteht erst dadurch, dass "vorher" und "nachher" derselben Zeile auf derselben Hoehe
 * stehen.
 */
export function compareTexts(before: string, after: string): TextDiff {
  const A = lines(before);
  const B = lines(after);
  const rows: DiffRow[] = [];
  const stats: DiffStats = { added: 0, removed: 0, changed: 0, charsAdded: 0, charsRemoved: 0 };

  let leftNo = 0;
  let rightNo = 0;

  // Auf Zeilen-ARRAYS statt auf dem Text: `diffLines` haengt an der Frage, ob ein Text mit einem
  // Zeilenumbruch endet, und dieselbe Aenderung faellt dann je nach letztem Zeichen anders aus.
  const parts = diffArrays(A, B);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (!part.added && !part.removed) {
      for (const text of part.value) {
        rows.push({
          kind: 'equal',
          leftNo: ++leftNo,
          rightNo: ++rightNo,
          left: [{ text, changed: false }],
          right: [{ text, changed: false }],
        });
      }
      continue;
    }

    // Entfernt + direkt darauf hinzugefuegt = eine ERSETZUNG. Nur in dieser Paarung kann ein
    // Wortdiff etwas finden -- ein isolierter Block ist eine echte Einfuegung bzw. Loeschung.
    const removed = part.removed ? part.value : [];
    const nextPart = parts[i + 1];
    const added = part.removed && nextPart?.added ? nextPart.value : part.added ? part.value : [];
    if (part.removed && nextPart?.added) i++; // beide Teile sind jetzt verarbeitet

    const height = Math.max(removed.length, added.length);
    for (let k = 0; k < height; k++) {
      const l = k < removed.length ? removed[k] : null;
      const r = k < added.length ? added[k] : null;

      if (l != null && r != null) {
        const paired = pairLines(l, r);
        rows.push({
          kind: 'change',
          leftNo: ++leftNo,
          rightNo: ++rightNo,
          left: paired ? paired.left : [{ text: l, changed: true }],
          right: paired ? paired.right : [{ text: r, changed: true }],
        });
        stats.changed++;
        // Bei einer geaenderten Zeile zaehlt nur die Differenz -- ein umgestellter Satz ist keine
        // 200 neuen Zeichen.
        const delta = r.length - l.length;
        if (delta > 0) stats.charsAdded += delta;
        else stats.charsRemoved += -delta;
      } else if (l != null) {
        rows.push({ kind: 'del', leftNo: ++leftNo, rightNo: null, left: [{ text: l, changed: true }], right: null });
        stats.removed++;
        stats.charsRemoved += l.length;
      } else if (r != null) {
        rows.push({ kind: 'add', leftNo: null, rightNo: ++rightNo, left: null, right: [{ text: r, changed: true }] });
        stats.added++;
        stats.charsAdded += r.length;
      }
    }
  }

  return { rows: fold(rows), stats };
}

/**
 * Lange unveraenderte Strecken zu einer `gap`-Reihe zusammenlegen.
 *
 * ⚠️ Am Anfang und am Ende des Textes wird der Kontext einseitig behalten: vor der ersten
 * Aenderung braucht niemand die drei Zeilen des Dateianfangs, wohl aber die drei DAVOR. Ein
 * beidseitiger Schnitt liesse ausgerechnet am Rand Kontext stehen, der zu nichts gehoert.
 */
function fold(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'equal') {
      out.push(rows[i++]);
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === 'equal') end++;
    const run = rows.slice(i, end);
    const atStart = i === 0;
    const atEnd = end === rows.length;

    if (run.length < FOLD_FROM) {
      out.push(...run);
    } else if (atStart && atEnd) {
      // Der ganze Text ist unveraendert: nichts falten, sonst zeigt die Ansicht ausschliesslich
      // eine Faltung -- also gar nichts.
      out.push(...run);
    } else {
      const head = atStart ? [] : run.slice(0, CONTEXT_LINES);
      const tail = atEnd ? [] : run.slice(-CONTEXT_LINES);
      out.push(...head);
      out.push({
        kind: 'gap',
        leftNo: null,
        rightNo: null,
        left: null,
        right: null,
        lines: run.length - head.length - tail.length,
      });
      out.push(...tail);
    }
    i = end;
  }
  return out;
}

/**
 * Nur die Bilanz zweier Texte -- fuer die Fassungsliste, die sie fuer JEDE Zeile braucht.
 *
 * Bewusst ohne Wortdiff: das ist der teure Teil, und "+3 −1" braucht ihn nicht.
 */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffArrays(lines(before), lines(after))) {
    if (part.added) added += part.value.length;
    else if (part.removed) removed += part.value.length;
  }
  return { added, removed };
}

/**
 * Klassischer Unified-Diff -- ausschliesslich als Eingabe fuer die KI-Zusammenfassung.
 *
 * Ein Sprachmodell liest dieses Format ohnehin (es steht in jedem Commit, den es je gesehen hat),
 * und die Zeilenpaare oben als JSON hineinzugeben waere eine zweite Darstellung derselben
 * Aussage -- diesmal in einer, die niemand als Diff erkennt.
 */
export function unifiedDiff(name: string, before: string, after: string): string {
  return createPatch(name, before ?? '', after ?? '');
}
