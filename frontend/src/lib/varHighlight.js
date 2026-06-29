// Deterministische, klick-basierte Variablen-Hervorhebung fuer Java-Code-Bloecke auf der
// Artikel-Detailseite. Reine Helfer (testbar) – die DOM-Verdrahtung liegt in `ArticleView.vue`.
//
// Idee: Jede "Variable" bekommt anhand ihres Namens (Hash) eine feste Palettenfarbe. Ein Klick
// markiert ALLE Vorkommen im selben Block in genau dieser Farbe (Toggle, mehrere gleichzeitig).
// KEIN zweiter Highlighter: die Shiki-Token-Spans bleiben, wir setzen nur zusaetzliche Klassen.

export const PALETTE_SIZE = 12

// Java-Keywords + primitive Typen + Literale -> NICHT als Variable behandeln.
export const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'var', 'record', 'sealed', 'permits', 'yield', 'true', 'false', 'null',
])

const IDENT_RE = /^[A-Za-z_$][\w$]*$/

// djb2-Hash -> Palettenindex. Gleicher Name ⇒ gleiche Farbe (deterministisch, theme-stabil).
export function hashIndex(name) {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  return Math.abs(h) % PALETTE_SIZE
}

export function varColorClass(name) {
  return `vh-${hashIndex(name)}`
}

// Heuristik "Variable": gueltiger Identifier, kein Keyword, nicht gross geschrieben
// (=> Typ/Klasse) und nicht direkt von '(' gefolgt (=> Methodenaufruf/-deklaration).
export function isHighlightableVar(span) {
  const name = (span.textContent || '').trim()
  if (!IDENT_RE.test(name)) return false
  if (JAVA_KEYWORDS.has(name)) return false
  if (/^[A-Z]/.test(name)) return false
  if (nextNonSpaceStartsWith(span, '(')) return false
  return true
}

// Erstes sichtbares Zeichen NACH dem Token (ueber Geschwister-Knoten in derselben Zeile)?
// Dient nur der Methoden-Erkennung (`name(` -> Aufruf, nicht highlightbar).
function nextNonSpaceStartsWith(span, ch) {
  let node = span.nextSibling
  while (node) {
    const trimmed = (node.textContent || '').replace(/^\s+/, '')
    if (trimmed.length) return trimmed[0] === ch
    node = node.nextSibling
  }
  return false
}
