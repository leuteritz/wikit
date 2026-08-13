// Identitaetsfarbe fuer eine Menge von Dingen, die an mehreren Stellen zugleich auftauchen.
//
// Problem (Ursprung, Edge-Detail-Panel): Eine Kante traegt oft MEHRERE aufgerufene Methoden. Oben
// stehen deren Definitionen (Quelle), unten die Aufrufstellen (Anwender) – wer zu wem gehoert,
// musste man bisher ueber den Namen zusammensuchen. Loesung: jede Methode bekommt EINE Farbe und
// traegt sie an jeder Stelle, an der sie auftaucht – Definitionskarte, Legenden-Chip,
// Aufrufstellen-Karte, markierte Aufrufzeile und der Methoden-Token im Code selbst.
//
// ⚠️ Dieselbe Frage stellt das Themen-Buendel (`/topic`), nur ueber KLASSEN: links eine Liste,
// rechts ein Text aus zwanzig aneinandergehaengten Quelltexten – „welcher Block ist welche Klasse?"
// ist dort die Orientierungsfrage, und der Hover beantwortet sie nur fuer eine. `buildMethodColorMap`
// und `methodColorVars` sind deshalb bewusst generisch: sie kennen nur „eine stabile Reihenfolge
// von Schluesseln" (Methodenname dort, Datei-Id hier). Nur `markMethodCalls` ist methodenspezifisch.
//
// Reines DOM/String-Post-Processing – wie `lib/javaCode.js` und `lib/javaParams.js`. KEIN zweiter
// Highlighter: die Shiki-Farben bleiben an ihren Spans, wir markieren zusaetzlich.
//
// Farbwerte stehen als Tokens in `assets/style.css`:
//   `--mc-{0..5}`  – fuer UI auf Panel-Grund (theme-abhaengig, Light kraeftiger)
//   `--mc-{0..5}c` – fuer den Code-Block (`--color-code`, in beiden Themes dunkel)
// `methodColorVars` liefert beide als Inline-Vars (`--mc` / `--mc-code`), die restliche Faerbung
// laeuft ueber Vererbung – so kennt das Template keine einzige Farbe.

// Anzahl distinkter Methodenfarben (siehe `--mc-*` in style.css).
export const METHOD_PALETTE = 6

// Stabiler Farbindex je Schluessel. Die REIHENFOLGE der Eingabe entscheidet – so bleibt die
// Zuordnung beim erneuten Oeffnen derselben Kante (bzw. beim selben Buendel) identisch, und
// benachbarte Eintraege bekommen verschiedene Farben.
export function buildMethodColorMap(names) {
  const map = new Map()
  let i = 0
  for (const n of names || []) {
    if (!n || map.has(n)) continue
    map.set(n, i % METHOD_PALETTE)
    i += 1
  }
  return map
}

// Inline-Style-Objekt fuer ein Element, das die Farbe einer Methode tragen soll.
// Unbekannter Name -> leeres Objekt, die CSS-Fallbacks (`var(--mc, …)`) greifen auf den Akzent.
export function methodColorVars(idx) {
  if (idx == null) return {}
  return { '--mc': `var(--mc-${idx})`, '--mc-code': `var(--mc-${idx}c)` }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Im (bereits aufbereiteten) Shiki-HTML jeden Methoden-Token faerben: Vorkommen eines Namens, dem
// eine oeffnende Klammer folgt (`foo(`, `svc.foo(`, auch die Signaturzeile der Definition), wird mit
// <span class="java-call java-call-c{idx}"> umschlossen. Nur TEXT-Knoten werden geteilt -> Shiki-
// Farbspans und die `data-line`-Attribute bleiben unangetastet.
// Bereits als Parameter markierte Tokens werden uebersprungen: `markParamOccurrences` laeuft
// vorher, und eine Variable, die genauso heisst wie eine Methode, soll ihre Parameterfarbe behalten.
export function markMethodCalls(html, colorMap) {
  if (!html || !colorMap?.size) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.querySelector('.shiki')
    if (!root) return html

    const names = [...colorMap.keys()].filter(Boolean)
    if (!names.length) return html
    // Laengste zuerst -> die Alternation matcht den vollstaendigen Bezeichner.
    const sorted = [...names].sort((a, b) => b.length - a.length).map(escapeRe)
    // Eigene Wortgrenze (Java-Identifier erlauben '$'); '.' davor ist erlaubt (`svc.foo(`).
    const re = new RegExp(`(?<![\\w$])(${sorted.join('|')})(?![\\w$])`, 'g')
    // Aufruf statt Feld: nach dem Namen muss eine oeffnende Klammer stehen. Sie steht oft NICHT im
    // selben Textknoten – Shiki zerlegt `repo.findById(id)` in mehrere Farbspans, der Name endet
    // dann genau am Knotenende. Deshalb wird ueber die Knotengrenze hinweg weitergelesen.
    const CALL_RE = /^\s*\(/

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const all = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) all.push(n)

    // Text, der im Dokument NACH Knoten `idx` folgt (ein paar Zeichen genuegen fuer `\s*\(`).
    // Wird vor jeder Ersetzung gelesen; spaetere Knoten sind zu dem Zeitpunkt unveraendert.
    const following = (idx) => {
      let s = ''
      for (let j = idx + 1; j < all.length && s.length < 8; j++) s += all[j].nodeValue || ''
      return s
    }

    all.forEach((node, idx) => {
      // Bereits als Parameter markiert -> Parameterfarbe behalten (eine Variable kann so heissen
      // wie eine Methode; `markParamOccurrences` laeuft vorher).
      if (node.parentElement?.closest('.java-param')) return
      const text = node.nodeValue
      if (!text) return
      re.lastIndex = 0
      const frag = doc.createDocumentFragment()
      let last = 0
      let hit = false
      let m
      while ((m = re.exec(text))) {
        const end = m.index + m[1].length
        const rest = text.slice(end)
        const isCall = CALL_RE.test(rest) || (rest.trim() === '' && CALL_RE.test(rest + following(idx)))
        if (!isCall) continue
        hit = true
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
        const span = doc.createElement('span')
        span.className = `java-call java-call-c${colorMap.get(m[1]) ?? 0}`
        span.setAttribute('data-call', m[1])
        span.textContent = m[1]
        frag.appendChild(span)
        last = end
      }
      if (!hit) return
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
      node.parentNode.replaceChild(frag, node)
    })
    return root.outerHTML
  } catch {
    return html
  }
}
