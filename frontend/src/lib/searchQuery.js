// Facetten der globalen Suche (Strg+K). REINE Funktionen – die Verdrahtung liegt in
// `SearchPalette.vue`.
//
// Dieselbe Bedienung wie die Suche im Graphen (`lib/graphQuery.js`): ein Buchstabe + Doppelpunkt,
// die Chips erscheinen im leeren, fokussierten Feld und tragen sich per Klick selbst ein. Zwei
// Suchsyntaxen fuer dieselbe Frage („wo steckt das?") waeren eine Bedienart zu viel.
//
// Der Unterschied zum Graphen ist der Gegenstand: dort schraenken die Praefixe ein, WAS im Bild
// getroffen wird, hier, WELCHE QUELLE ueberhaupt gefragt wird – und das entscheidet mit, ob ein
// Request rausgeht (`s:` fragt nur den Quelltext, `a:` gar nicht).

// scope -> was gesucht wird. `all` fragt jede Quelle.
const SCOPE_BY_PREFIX = {
  a: 'article',
  c: 'class',
  m: 'method',
  p: 'package',
  s: 'source',
}

// Reihenfolge = Reihenfolge der Chips im leeren Feld.
export const SEARCH_FACETS = [
  { prefix: 's:', label: 'source code', hint: 'lines inside .java files' },
  { prefix: 'm:', label: 'method', hint: 'method names' },
  { prefix: 'c:', label: 'class', hint: 'class names' },
  { prefix: 'p:', label: 'package', hint: 'package paths' },
  { prefix: 'a:', label: 'article', hint: 'wiki articles' },
]

/**
 * Eingabe -> { scope, term }.
 * Ein Praefix ohne Begriff (`s:`) ist eine angefangene Eingabe, keine Suche -> leerer `term`.
 * @returns {{ scope: 'all'|'article'|'class'|'method'|'package'|'source', term: string }}
 */
export function parseSearchQuery(input) {
  const raw = (input || '').trim()
  if (!raw) return { scope: 'all', term: '' }
  const prefixed = /^([a-zA-Z]):\s*(.*)$/.exec(raw)
  if (prefixed) {
    const scope = SCOPE_BY_PREFIX[prefixed[1].toLowerCase()]
    if (scope) return { scope, term: prefixed[2].trim() }
  }
  return { scope: 'all', term: raw }
}

// Welche Quelle beantwortet diesen Scope? Damit entscheidet die Palette, welche Requests ueberhaupt
// rausgehen – und ob die (teure) Zeilensuche im Quelltext dran ist.
export const wantsArticles = (scope) => scope === 'all' || scope === 'article'
export const wantsSymbols = (scope) => scope !== 'article' && scope !== 'source'
export const wantsCode = (scope) => scope === 'all' || scope === 'source'
