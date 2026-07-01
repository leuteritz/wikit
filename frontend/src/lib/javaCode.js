// Aufbereitung von server-gerendertem Shiki-HTML eines Java-Methodenrumpfs (`m.body_html`).
//
// Reines DOM-Post-Processing (DOMParser) – analog zu `buildCallWindow`/`addLineNumbers` im
// Edge-Panel. KEIN zweiter Highlighter: die Farben kommen weiterhin aus den inline gesetzten
// Shiki-CSS-Variablen (`--shiki-light`/`--shiki-dark`), die an den `.line`-Spans haengen und beim
// Verschieben der Knoten erhalten bleiben.
//
// Aufgaben:
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

    // Frisches <code> mit Signaturzeile(n) + gehaltenen Rumpfzeilen (durch `\n`-Textnodes getrennt).
    // Kein `{` anhaengen: der Rumpf kann bereits Klammern enthalten (s. DECL_RE-Strip oben).
    const code = doc.createElement('code')
    ;[...sigLines, ...kept].forEach((el, i) => {
      if (i > 0) code.appendChild(doc.createTextNode('\n'))
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
