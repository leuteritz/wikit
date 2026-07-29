// Textsuche im Quellcode-Tab einer Java-Klasse. REINE Funktionen (testbar) – die Editor-Verdrahtung
// liegt in `JavaCodeEditor.vue` (Decorations), die Bedienung in `JavaClassDetail.vue` (Suchleiste).
//
// Bewusst KEIN zweiter Suchindex und kein `@codemirror/search`-Panel: gesucht wird im ANGEZEIGTEN
// Quelltext-String (`displaySource`), damit Treffer-Offsets 1:1 Dokument-Offsets des Editors sind.

// Deckel gegen „ein Zeichen = zehntausend Decorations" (dieselbe Logik wie TREE_MATCH_LIMIT im
// Klassenbaum): der Zaehler schreibt an, dass nur die ersten Treffer markiert sind.
export const MATCH_LIMIT = 2000

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g
// Java-Identifier: `$` gehoert dazu, `\b` kennt es nicht -> eigene Wortgrenzen per Lookaround.
const IDENT_RE = /^[A-Za-z_$][\w$]*$/

export function isIdentifier(text) {
  return IDENT_RE.test(text || '')
}

// Suchmuster bauen. Ungueltige Regex des Nutzers sind ein Bedienfehler, kein Absturz -> als
// `error` zurueckgeben (die Leiste zeigt ihn an), nicht werfen.
export function buildSearchRegex({ query, caseSensitive = false, wholeWord = false, regex = false } = {}) {
  const q = query || ''
  if (!q) return { re: null, error: '' }
  let body = regex ? q : q.replace(RE_SPECIAL, '\\$&')
  if (wholeWord) body = `(?<![\\w$])(?:${body})(?![\\w$])`
  try {
    return { re: new RegExp(body, caseSensitive ? 'g' : 'gi'), error: '' }
  } catch (e) {
    return { re: null, error: e.message }
  }
}

// Alle Treffer als Zeichenbereiche { from, to } (aufsteigend, ueberschneidungsfrei).
// `capped` = es gaebe mehr als `limit` Treffer.
export function findMatches(text, config, limit = MATCH_LIMIT) {
  const { re, error } = buildSearchRegex(config)
  if (!re || !text) return { matches: [], capped: false, error }
  const matches = []
  let m
  while ((m = re.exec(text)) !== null) {
    // Leertreffer (`a*`, `\b`) wuerden lastIndex nicht bewegen -> Endlosschleife. Ueberspringen.
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    matches.push({ from: m.index, to: m.index + m[0].length })
    if (matches.length >= limit) return { matches, capped: re.exec(text) !== null, error: '' }
  }
  return { matches, capped: false, error: '' }
}

// Index des Treffers, der an `pos` beginnt (exakt) – sonst der erste Treffer ab `pos`, sonst 0.
// Dient der Selektions-Uebernahme: markiertes Vorkommen wird zum aktiven Treffer, damit „weiter"
// dort fortsetzt, wo der Blick liegt, statt am Dateianfang.
export function indexAtOrAfter(matches, pos) {
  if (!matches || !matches.length) return -1
  const exact = matches.findIndex((m) => m.from === pos)
  if (exact >= 0) return exact
  const next = matches.findIndex((m) => m.from >= pos)
  return next >= 0 ? next : 0
}
