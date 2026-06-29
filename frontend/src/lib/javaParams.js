// Parameter-Hervorhebung fuer Java-Methoden-Snippets im Edge-Panel.
//
// Reines DOM/String-Post-Processing – analog zu `lib/javaCode.js` und den Helfern im
// Edge-Panel (`addLineNumbers`/`buildCallWindow`). KEIN zweiter Highlighter: die Shiki-Farben
// bleiben an den vorhandenen Spans, wir markieren nur die Parameter-Vorkommen zusaetzlich.
//
// Aufgaben:
//  - aus einer Methodensignatur die Parameter-Bezeichner extrahieren (Generics-sicher),
//  - im aufbereiteten Shiki-HTML jedes wort-genaue Vorkommen eines Parameters mit
//    <span class="java-param" data-var="<name>"> umschliessen (fuer Faerbung + Klick-Markierung).

// Letzten Identifier aus einem Parameter-Fragment ziehen (z. B. "final String name" -> "name",
// "int[] xs" -> "xs", "String... names" -> "names").
const LAST_IDENT_RE = /([A-Za-z_$][\w$]*)\s*$/

// Bezeichner aus einem Signatur-String parsen. Beispiel:
//   "void save(String name, int count)"            -> ["name", "count"]
//   "Map<String,Integer> put(List<String> k, T v)" -> ["k", "v"]
// An Kommas wird nur auf KLAMMERTIEFE 0 getrennt, damit Generics/Arrays/verschachtelte Aufrufe
// nicht faelschlich gesplittet werden.
export function parseParamNames(signature) {
  if (!signature || typeof signature !== 'string') return []
  const open = signature.indexOf('(')
  const close = signature.lastIndexOf(')')
  if (open === -1 || close === -1 || close <= open + 1) return []
  const inner = signature.slice(open + 1, close)

  const parts = []
  let depth = 0
  let buf = ''
  for (const ch of inner) {
    if (ch === '<' || ch === '[' || ch === '(') depth++
    else if (ch === '>' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) parts.push(buf)

  const names = []
  for (const p of parts) {
    const m = LAST_IDENT_RE.exec(p.trim())
    if (m && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Im (bereits via addLineNumbers/buildCallWindow aufbereiteten) Shiki-HTML jedes wort-genaue
// Vorkommen eines Parameternamens mit <span class="java-param" data-var="…"> umschliessen.
// Es werden nur TEXT-Knoten geteilt -> die Shiki-Farbspans und die data-line-Attribute der
// .line-Zeilen bleiben unangetastet.
export function markParamOccurrences(html, names) {
  if (!html || !Array.isArray(names) || !names.length) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.querySelector('.shiki')
    if (!root) return html

    // Laengste Namen zuerst -> die Alternation matcht greedy den vollstaendigen Bezeichner.
    const sorted = [...names].sort((a, b) => b.length - a.length).map(escapeRe)
    // Eigene Wort-Grenze (Java-Identifier erlauben '$'): kein vorheriges/folgendes Identifier-Zeichen.
    const re = new RegExp(`(?<![\\w$])(${sorted.join('|')})(?![\\w$])`, 'g')

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const textNodes = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n)

    for (const node of textNodes) {
      const text = node.nodeValue
      if (!text || !re.test(text)) continue
      re.lastIndex = 0
      const frag = doc.createDocumentFragment()
      let last = 0
      let m
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
        const span = doc.createElement('span')
        span.className = 'java-param'
        span.setAttribute('data-var', m[1])
        span.textContent = m[1]
        frag.appendChild(span)
        last = m.index + m[1].length
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
      node.parentNode.replaceChild(frag, node)
    }
    return root.outerHTML
  } catch {
    return html
  }
}
