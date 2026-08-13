// Aufbereitung von server-gerendertem Shiki-HTML eines Java-Methodenrumpfs (`m.body_html`).
//
// Reines DOM-Post-Processing (DOMParser) – analog zu `buildCallWindow`/`addLineNumbers` im
// Edge-Panel. KEIN zweiter Highlighter: die Farben kommen weiterhin aus den inline gesetzten
// Shiki-CSS-Variablen (`--shiki-light`/`--shiki-dark`), die an den `.line`-Spans haengen und beim
// Verschieben der Knoten erhalten bleiben.
//
// `addLineNumbers` (ganze Methode mit Gutter) und `buildCallWindow` (fokussiertes Fenster um eine
// Aufrufzeile) lagen frueher in JavaEdgeDetailPanel. Sie stehen jetzt hier, weil sie ein ZWEITER
// Konsument braucht (JavaBundlePanel) – zwei Kopien wuerden zwangslaeufig auseinanderlaufen.
//
// Aufgaben von processMethodBody:
//  - eine evtl. vorangestellte Deklarationszeile (mit Modifiern) defensiv abschneiden,
//  - fuehrende/abschliessende Leerzeilen IMMER entfernen,
//  - optional (collapseBlank) ALLE Leerzeilen entfernen,
//  - optional (signatureHtml) die server-gerenderte Signatur (Shiki-HTML, inkl. Modifier wie
//    `public static`) als erste Zeile voranstellen. Die highlighteten `.line`-Token behalten ihre
//    inline `--shiki-*`-Vars beim Umziehen -> volles Java-Highlighting, kein Client-Highlighter.

const DECL_RE = /^\s*(public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\b/

function isBlank(el) {
  return el.textContent.trim() === ''
}

// Anzahl Kontext-Nicht-Leerzeilen je Seite der Aufrufzeile (buildCallWindow).
const CONTEXT_LINES = 3

// Server-gerendertes Shiki-HTML mit Gutter-Zeilennummern versehen: pro `.line` das
// `data-line`-Attribut (startLine + i) setzen, das die CSS-Gutter-Regel (`::before`) anzeigt.
// Reines DOM-Post-Processing – kein zweiter Highlighter (Farben bleiben aus Shiki-CSS-Variablen).
//
// Zwei Optionen, beide fuer die GANZE Klasse in der Suchvorschau gedacht (der Normalfall –
// Methodenrumpf im Edge-/Bundle-Panel – bleibt unveraendert):
//  * `keepBlank` – Leerzeilen stehenlassen. Bei einem Methodenrumpf sind sie Luft in einem
//    ohnehin knappen Panel; ueber eine ganze Klasse gelesen sind sie ihre Gliederung, und ohne
//    sie klebt der Import-Block am Klassenkopf.
//  * `highlight` – eine Quellzeile markieren (`line-highlight`, dieselbe Auszeichnung wie die
//    Aufrufzeile in `buildCallWindow`), damit die Klassendeklaration in 400 Zeilen auffindbar
//    bleibt.
export function addLineNumbers(html, startLine, { keepBlank = false, highlight = null } = {}) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.querySelector('.shiki')
    if (!root) return html
    const base = startLine != null ? startLine : 1
    // Pro Zeile die ECHTE Quellzeilennummer (base + i) merken und Leerzeilen verwerfen -> der
    // kombinierte Block ist leerzeilenfrei, die data-line-Nummern bleiben korrekt (Luecken = ok).
    const kept = [...root.querySelectorAll('.line')]
      .map((el, i) => ({ el, line: base + i }))
      .filter(({ el }) => keepBlank || !isBlank(el))
    if (!kept.length) return html
    // Frisches <code> mit den gehaltenen Zeilen – die `.line` werden (wie in `buildCallWindow`)
    // OHNE `\n`-Textnodes direkt aneinandergehaengt: im Original-`<pre>` (white-space: pre) wuerde
    // jedes `\n` als zusaetzliche Leerzeile rendern -> doppelter Zeilenabstand. Der Zeilenumbruch
    // kommt aus `.edge-code .line { display:block }`. Das `<pre>` (inkl. Shiki-Inline-Style mit
    // --shiki-*-Variablen) bleibt erhalten -> Hintergrund + Einrueckung stimmen.
    const code = doc.createElement('code')
    kept.forEach(({ el, line }) => {
      el.setAttribute('data-line', String(line))
      if (highlight != null) el.classList.toggle('line-highlight', line === highlight)
      code.appendChild(el)
    })
    const oldCode = root.querySelector('code')
    if (oldCode) oldCode.replaceWith(code)
    else {
      root.innerHTML = ''
      root.appendChild(code)
    }
    return root.outerHTML
  } catch {
    return html
  }
}

// Aus dem (server-gerenderten) Shiki-HTML des ganzen Aufrufer-Rumpfs ein fokussiertes Fenster um
// `siteLine` schneiden: pro `.line` die Quellzeile (data-line = base + i) bestimmen, Leerzeilen
// (whitespace-only) ueberspringen und je 3 Nicht-Leerzeilen vor/nach der Aufrufzeile behalten. Die
// Aufrufzeile bekommt `line-highlight`. Reines DOM-Post-Processing – kein zweiter Highlighter, die
// Farben kommen weiter aus den Shiki-CSS-Variablen.
export function buildCallWindow(html, bodyStartLine, siteLine) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.querySelector('.shiki')
    if (!root) return html
    const base = bodyStartLine != null ? bodyStartLine : 1
    const allLines = [...root.querySelectorAll('.line')]
    // Nur Nicht-Leerzeilen, je mit ihrer Quellzeilennummer.
    const kept = allLines.map((el, i) => ({ el, line: base + i })).filter(({ el }) => !isBlank(el))
    if (!kept.length) return html
    // Index der Aufrufzeile in der gefilterten Liste (oder naechstgelegene).
    let hit = kept.findIndex((k) => k.line === siteLine)
    if (hit === -1) {
      let best = Infinity
      kept.forEach((k, idx) => {
        const d = Math.abs(k.line - siteLine)
        if (d < best) {
          best = d
          hit = idx
        }
      })
    }
    const from = Math.max(0, hit - CONTEXT_LINES)
    const to = Math.min(kept.length - 1, hit + CONTEXT_LINES)
    const code = doc.createElement('code')
    for (let i = from; i <= to; i++) {
      const { el, line } = kept[i]
      el.setAttribute('data-line', String(line))
      if (i === hit) el.classList.add('line-highlight')
      else el.classList.remove('line-highlight')
      code.appendChild(el)
    }
    // <pre> (nicht <div>): bewahrt die fuehrende Einrueckung (white-space: pre) – gleiche
    // Element-Art wie die Quelle-Sektion. Doppelte Zeilenabstaende drohen nicht, da die `.line`
    // ohne `\n`-Textnodes angehaengt werden und per `.line { display:block }` umbrechen.
    const shell = doc.createElement('pre')
    shell.className = 'shiki'
    // Shiki-Inline-Style (die --shiki-*-Variablen) vom Original-Root uebernehmen: die Token-Spans
    // darunter lesen `--shiki-dark`, das an DIESEM Element haengt. Ohne den Uebertrag bliebe der
    // Ausschnitt einfarbig. (Den Grund liefert die `.shiki`-Klasse selbst.)
    shell.setAttribute('style', root.getAttribute('style') || '')
    shell.appendChild(code)
    return shell.outerHTML
  } catch {
    return html
  }
}

// --- Treffer im gerenderten Shiki-Block markieren ---------------------------------------------
//
// Fuer die Suche INNERHALB der Klassenvorschau (Suchpalette). Sie arbeitet auf dem gemounteten
// DOM, nicht auf einem HTML-String: die Query aendert sich bei jedem Tastendruck, und ein neuer
// `v-html`-String waere jedes Mal ein kompletter Neuaufbau von bis zu 1500 Zeilen.
//
// Der Text, den `shikiText` liefert, ist die Bezugsgroesse der Offsets – dieselben `.line`-Elemente
// in derselben Reihenfolge, mit `\n` verbunden. Damit kann die Trefferliste aus `findMatches`
// stammen (dieselbe Musterlogik wie die Suchleiste im Source-Tab) und trotzdem exakt hier landen:
// „3 von 12" kann nicht von dem abweichen, was leuchtet.
const HIT_CLASS = 'cs-hit'

export function shikiText(root) {
  if (!root) return ''
  return [...root.querySelectorAll('.line')].map((l) => l.textContent).join('\n')
}

export function clearMatches(root) {
  if (!root) return
  const parents = new Set()
  for (const mark of root.querySelectorAll(`mark.${HIT_CLASS}`)) {
    const p = mark.parentNode
    if (!p) continue
    while (mark.firstChild) p.insertBefore(mark.firstChild, mark)
    p.removeChild(mark)
    parents.add(p)
  }
  // Ohne `normalize()` zerfaellt der Text in immer mehr Knoten – jede Suche wuerde den Block
  // weiter zersplittern.
  for (const p of parents) p.normalize()
}

// `matches` = [{ from, to }] aus `findMatches` (Offsets in `shikiText(root)`).
// Ein Treffer kann ueber mehrere Shiki-Spans laufen (`repo.findById(` ist in Tokens zerlegt) und
// wird dann in mehrere <mark>-Stuecke zerlegt – sie tragen dieselbe Klasse, sehen also aus wie
// eine zusammenhaengende Markierung.
export function paintMatches(root, matches, activeIndex = -1) {
  clearMatches(root)
  if (!root || !matches?.length) return 0

  // Textknoten mit ihrem Startoffset im selben Text, den `shikiText` liefert.
  const spans = []
  let offset = 0
  const lines = [...root.querySelectorAll('.line')]
  lines.forEach((line, i) => {
    if (i > 0) offset += 1 // das `\n` zwischen zwei Zeilen
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length
      if (len) spans.push({ node, start: offset, end: offset + len })
      offset += len
    }
  })
  if (!spans.length) return 0

  // RUECKWAERTS: jedes `splitText` laesst den Originalknoten als VORDEREN Teil zurueck, damit
  // bleiben die Offsets aller frueheren Treffer gueltig. Vorwaerts waere nach dem ersten Split
  // jede weitere Zuordnung verschoben.
  let painted = 0
  for (let mi = matches.length - 1; mi >= 0; mi--) {
    const m = matches[mi]
    const pieces = spans.filter((s) => s.start < m.to && s.end > m.from)
    if (!pieces.length) continue
    painted++
    for (let pi = pieces.length - 1; pi >= 0; pi--) {
      const s = pieces[pi]
      const node = s.node
      if (!node.parentNode) continue
      const from = Math.max(m.from, s.start) - s.start
      const to = Math.min(m.to, s.end) - s.start
      if (to <= from || from > node.nodeValue.length) continue
      // Erst hinten abschneiden, dann vorne -> der mittlere Knoten IST der Treffer.
      if (to < node.nodeValue.length) node.splitText(to)
      const target = from > 0 ? node.splitText(from) : node
      const mark = document.createElement('mark')
      mark.className = mi === activeIndex ? `${HIT_CLASS} ${HIT_CLASS}--active` : HIT_CLASS
      target.parentNode.replaceChild(mark, target)
      mark.appendChild(target)
    }
  }
  return painted
}

export function processMethodBody(html, { collapseBlank = false, signatureHtml = '' } = {}) {
  if (!html) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const pre = doc.querySelector('.shiki')
    if (!pre) return html

    let lines = [...pre.querySelectorAll('.line')]
    if (!lines.length) return html

    // Defensiv: Falls die erste Nicht-Leerzeile wie eine Methodendeklaration aussieht
    // (`public static void foo(...) {`), diese Zeile abschneiden -> nur der Rumpf bleibt.
    const firstNonBlank = lines.find((el) => !isBlank(el))
    if (firstNonBlank && DECL_RE.test(firstNonBlank.textContent)) {
      const idx = lines.indexOf(firstNonBlank)
      lines = lines.slice(idx + 1)
    }

    // Optional alle internen Leerzeilen entfernen; sonst nur fuehrende/abschliessende.
    let kept = collapseBlank ? lines.filter((el) => !isBlank(el)) : lines.slice()
    while (kept.length && isBlank(kept[0])) kept.shift()
    while (kept.length && isBlank(kept[kept.length - 1])) kept.pop()

    // Signaturzeile(n) aus dem server-gerenderten Shiki-HTML extrahieren (bereits highlighted,
    // inkl. Modifier). Beim Umziehen in `doc` per importNode bleiben die inline `--shiki-*`-Vars.
    let sigLines = []
    if (signatureHtml) {
      const sdoc = new DOMParser().parseFromString(signatureHtml, 'text/html')
      sigLines = [...sdoc.querySelectorAll('.shiki .line')].map((el) => doc.importNode(el, true))
      if (sigLines.length) sigLines[0].classList.add('sig-line')
    }
    // Weder Rumpf noch Signatur -> nichts zu tun.
    if (!kept.length && !sigLines.length) return html

    // Frisches <code> mit Signaturzeile(n) + gehaltenen Rumpfzeilen – OHNE `\n`-Textnodes, genau
    // wie in `addLineNumbers`/`buildCallWindow` oben. Der Zeilenumbruch kommt aus
    // `.method-code .line { display: block }` (JavaClassDetail). Das ist die Voraussetzung dafuer,
    // dass eine zu lange Zeile mit haengendem Einzug umbrechen kann: mit `\n` dazwischen ergaebe
    // derselbe `display:block` doppelte Zeilenabstaende.
    // Kein `{` anhaengen: der Rumpf kann bereits Klammern enthalten (s. DECL_RE-Strip oben).
    const code = doc.createElement('code')
    ;[...sigLines, ...kept].forEach((el) => {
      code.appendChild(el)
    })
    const oldCode = pre.querySelector('code')
    if (oldCode) oldCode.replaceWith(code)
    else {
      pre.innerHTML = ''
      pre.appendChild(code)
    }
    return pre.outerHTML
  } catch {
    return html
  }
}
