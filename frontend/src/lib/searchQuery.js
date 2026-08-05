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
  // ⚠️ Der einzige Praefix, der kein Buchstabe ist. Die Tilde steht in Suchsyntaxen seit jeher fuer
  // „ungefaehr" (Lucene, Elasticsearch), und genau das ist diese Quelle: sie findet die Klasse, in
  // der das gesuchte Wort NICHT steht. Ein Buchstabe dafuer waere entweder belegt oder beliebig.
  '~': 'meaning',
}

// Reihenfolge = Reihenfolge der Chips (leeres Feld im Modal, dauerhafte Leiste auf der Landing).
// Sortiert nach Haeufigkeit der Frage: „wie heisst die Klasse" steht vor „wo steht das im Code".
//
// `scope` ist die Umkehrung von SCOPE_BY_PREFIX und wird von der dauerhaften Facettenleiste
// gebraucht: sie muss den AKTIVEN Chip markieren, und dafuer vergleicht sie gegen den Scope aus
// `parseSearchQuery` – nicht gegen den Praefix, der im Feld auch fehlen kann (`all`).
// `short` ist die Beschriftung dieser Leiste (ein Wort, Grossschreibung), `label` bleibt die
// erklaerende Fassung der Chips im leeren Feld. `icon` ist ein Name aus `lib/icons.js`.
export const SEARCH_FACETS = [
  { prefix: 'c:', scope: 'class', short: 'Classes', label: 'class', hint: 'class names', icon: 'lucide:braces' },
  { prefix: 'm:', scope: 'method', short: 'Methods', label: 'method', hint: 'method names', icon: 'lucide:file-code' },
  { prefix: 's:', scope: 'source', short: 'Source', label: 'source code', hint: 'lines inside .java files', icon: 'lucide:code-2' },
  { prefix: 'p:', scope: 'package', short: 'Packages', label: 'package', hint: 'package paths', icon: 'lucide:package' },
  { prefix: 'a:', scope: 'article', short: 'Articles', label: 'article', hint: 'wiki articles', icon: 'lucide:file-text' },
  { prefix: '~:', scope: 'meaning', short: 'Meaning', label: 'meaning', hint: 'classes about a topic, by what they do', icon: 'lucide:sparkles' },
]

// „Alles" ist keine Facette (es gibt keinen Praefix dafuer), aber in einer dauerhaften Leiste ist es
// der Ruhezustand und muss anklickbar sein – sonst kaeme man aus einer Einschraenkung nur durch
// Loeschen des Praefixes im Feld wieder heraus.
export const SEARCH_SCOPE_ALL = {
  prefix: '',
  scope: 'all',
  short: 'All',
  label: 'everything',
  hint: 'articles, classes, methods and source lines',
  icon: 'lucide:layout-grid',
}

/**
 * Eingabe -> { scope, term }.
 * Ein Praefix ohne Begriff (`s:`) ist eine angefangene Eingabe, keine Suche -> leerer `term`.
 * @returns {{ scope: 'all'|'article'|'class'|'method'|'package'|'source', term: string }}
 */
export function parseSearchQuery(input) {
  const raw = (input || '').trim()
  if (!raw) return { scope: 'all', term: '' }
  const prefixed = /^([a-zA-Z~]):\s*(.*)$/.exec(raw)
  if (prefixed) {
    const scope = SCOPE_BY_PREFIX[prefixed[1].toLowerCase()]
    if (scope) return { scope, term: prefixed[2].trim() }
  }
  return { scope: 'all', term: raw }
}

// Welche Quelle beantwortet diesen Scope? Damit entscheidet die Palette, welche Requests ueberhaupt
// rausgehen – und ob die (teure) Zeilensuche im Quelltext dran ist.
export const wantsArticles = (scope) => scope === 'all' || scope === 'article'
export const wantsSymbols = (scope) => scope !== 'article' && scope !== 'source' && scope !== 'meaning'
export const wantsCode = (scope) => scope === 'all' || scope === 'source'
// Die Bedeutungssuche kostet einen Ollama-Aufruf JE ANFRAGE – sie laeuft deshalb nur mit, wo nichts
// anderes ausdruecklich gemeint ist, und antwortet auf `~:` allein.
export const wantsMeaning = (scope) => scope === 'all' || scope === 'meaning'
