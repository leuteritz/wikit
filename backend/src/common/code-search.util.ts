// Zeilengenaue Textsuche im gespeicherten Java-Quelltext. REINE Funktionen (testbar) – die
// Verdrahtung liegt in `java.service.ts` (Kandidatenauswahl + Scan-Budget).
//
// ZWILLING von `frontend/src/lib/codeSearch.js`: dieselbe Musterlogik (Case / ganzes Wort / Regex),
// getrennte Laufzeiten. Der Client sucht in EINER angezeigten Klasse (ohne Request), der Server
// ueber ALLE gespeicherten Klassen. Ein Import ueber die Grenze gibt es nicht (Frontend ESM,
// Backend CommonJS) – genau wie bei `reindentJava`, das aus demselben Grund doppelt vorliegt.
// Aenderung an der Musterlogik gehoert gegen BEIDE Dateien geprueft, sonst findet die globale
// Suche etwas anderes als die Suche in der geoeffneten Klasse.

// Java-Identifier: `$` gehoert dazu, `\b` kennt es nicht -> eigene Wortgrenzen per Lookaround.
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

// Deckel je Zeile: eine minifizierte oder generierte Zeile kann hunderte Treffer tragen; mehr als
// ein paar Markierungen pro Zeile sind im Ergebnis ohnehin nicht zu unterscheiden.
const RANGES_PER_LINE = 20;
// Zeichen je ausgelieferter Zeile. Generierter Code hat Zeilen mit mehreren tausend Zeichen –
// die wuerden die Antwort aufblaehen, ohne lesbar zu sein.
const MAX_LINE_CHARS = 260;

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface MatchRange {
  from: number;
  to: number;
}

export interface HitLine {
  line: number;
  text: string;
  isHit: boolean;
  ranges?: MatchRange[];
}

export interface CodeHit {
  line: number;
  lines: HitLine[];
}

// Suchmuster bauen. Eine ungueltige Nutzer-Regex ist ein Bedienfehler, kein Absturz -> als
// `error` zurueckgeben (der Aufrufer macht daraus eine 400 mit lesbarer Meldung), nicht werfen.
export function buildSearchRegex({
  query,
  caseSensitive = false,
  wholeWord = false,
  regex = false,
}: SearchOptions): { re: RegExp | null; error: string } {
  const q = query || '';
  if (!q) return { re: null, error: '' };
  let body = regex ? q : q.replace(RE_SPECIAL, '\\$&');
  if (wholeWord) body = `(?<![\\w$])(?:${body})(?![\\w$])`;
  try {
    return { re: new RegExp(body, caseSensitive ? 'g' : 'gi'), error: '' };
  } catch (e: any) {
    return { re: null, error: e?.message || 'Invalid regular expression' };
  }
}

// Zeile auf MAX_LINE_CHARS kuerzen – nach Moeglichkeit als Fenster um den ersten Treffer, damit
// die markierte Stelle im Ergebnis auch sichtbar ist. Verschobene Treffer-Offsets werden
// mitgezogen; was wegfaellt, wird mit „…" angeschrieben (kein stilles Abschneiden).
function clampLine(text: string, ranges: MatchRange[]): { text: string; ranges: MatchRange[] } {
  if (text.length <= MAX_LINE_CHARS) return { text, ranges };
  const anchor = ranges.length ? ranges[0].from : 0;
  const start = Math.max(0, Math.min(anchor - 40, text.length - MAX_LINE_CHARS));
  const end = Math.min(text.length, start + MAX_LINE_CHARS);
  const prefix = start > 0 ? '… ' : '';
  const shift = start - prefix.length;
  return {
    text: prefix + text.slice(start, end) + (end < text.length ? ' …' : ''),
    ranges: ranges
      .filter((r) => r.from >= start && r.to <= end)
      .map((r) => ({ from: r.from - shift, to: r.to - shift })),
  };
}

// Gemeinsame Einrueckung eines Blocks entfernen. Der Treffer steht oft tief verschachtelt; die
// 16 fuehrenden Leerzeichen sind in einer schmalen Ergebnisliste nur verschenkte Breite. Die
// RELATIVE Einrueckung bleibt erhalten (deshalb blockweise, nicht je Zeile), und die
// Treffer-Offsets werden um denselben Betrag verschoben – sie zeigen also weiter auf den
// ausgelieferten Text.
function dedent(lines: HitLine[]): HitLine[] {
  let common = Infinity;
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const lead = l.text.length - l.text.replace(/^[ \t]+/, '').length;
    if (lead < common) common = lead;
  }
  if (!isFinite(common) || common === 0) return lines;
  return lines.map((l) => ({
    ...l,
    text: l.text.slice(common),
    ranges: l.ranges?.map((r) => ({ from: Math.max(0, r.from - common), to: Math.max(0, r.to - common) })),
  }));
}

// Fundstelle + Kontextzeilen als fertigen Block (1-basierte Zeilennummern).
function buildHit(lines: string[], index: number, ranges: MatchRange[], context: number): CodeHit {
  const from = Math.max(0, index - context);
  const to = Math.min(lines.length - 1, index + context);
  const block: HitLine[] = [];
  for (let i = from; i <= to; i++) {
    const isHit = i === index;
    const clamped = clampLine(lines[i], isHit ? ranges : []);
    block.push({
      line: i + 1,
      text: clamped.text,
      isHit,
      ...(isHit ? { ranges: clamped.ranges } : {}),
    });
  }
  return { line: index + 1, lines: dedent(block) };
}

// Eine Quelldatei zeilenweise durchsuchen.
// `total` zaehlt ALLE Treffer der Datei, `hits` liefert nur die ersten `maxHits` Fundstellen –
// die Zahl in der Kopfzeile („12 matches") bleibt damit ehrlich, auch wenn die Liste kuerzt.
export function scanSource(
  source: string,
  re: RegExp,
  { context = 2, maxHits = 5 }: { context?: number; maxHits?: number } = {},
): { hits: CodeHit[]; total: number } {
  const lines = (source || '').replace(/\r\n?/g, '\n').split('\n');
  const hits: CodeHit[] = [];
  let total = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    re.lastIndex = 0;
    const ranges: MatchRange[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // Leertreffer (`a*`, `\b`) bewegen lastIndex nicht -> Endlosschleife. Ueberspringen.
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push({ from: m.index, to: m.index + m[0].length });
      if (ranges.length >= RANGES_PER_LINE) break;
    }
    if (!ranges.length) continue;
    total += ranges.length;
    if (hits.length < maxHits) hits.push(buildHit(lines, i, ranges, context));
  }

  return { hits, total };
}
