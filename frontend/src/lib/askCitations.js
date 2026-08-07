// Belege in einer Ask-Antwort: `[OrderService]` bzw. `[OrderService#place]` im gerenderten Text
// werden zu anklickbaren Chips, die in `/code` genau diese Klasse (und Zeile) aufschlagen.
//
// ⚠️ **Die eine Regel dieser Datei: Nur ein Zitat, das zu einer GELIEFERTEN Quelle passt, wird zum
// Chip.** Alles andere bleibt gewoehnlicher Text. Ein Sprachmodell erfindet in einer fremden
// Codebasis plausible Klassennamen – und ein erfundener Beleg, der aussieht wie ein echter, ist
// schlimmer als gar keiner: er laedt zum Nachsehen ein und fuehrt ins Leere. Was hier nicht
// aufgeloest wird, ist damit auch sichtbar nicht belegt.
//
// Gearbeitet wird auf TEXTKNOTEN des gerenderten Markdowns, nicht auf dem HTML-String: eine Regex
// ueber `<p>…</p>` trifft irgendwann in einem Attribut, und markdown-it laeuft hier mit
// `html:false` – der Text ist bereits escaped, ein zweiter Durchgang auf der Zeichenkette wuerde
// genau diese Escapes wieder aufbrechen. Dasselbe Vorgehen wie `paintMatches` in `javaCode.js`.

export const CITE_CLASS = 'ask-cite'

// `[Name]` oder `[Name#member]`. Bewusst eng: Buchstaben, Ziffern, `_`, `$` (Java-Identifier) und
// `.` fuer den Fall, dass das Modell den vollen FQCN zitiert. Ein `[` mitten in Prosa („[siehe
// oben]") faellt damit nicht in die Erkennung.
const CITE_RE = /\[([A-Za-z_$][\w$.]*)(?:#([A-Za-z_$][\w$]*))?\]/g

/**
 * Nachschlagewerk aus den Quellen des Laufs.
 *
 * Geschluesselt wird kleingeschrieben: das Modell schreibt `[orderservice]`, wenn es den Namen aus
 * dem Fliesstext uebernimmt, und ein Beleg, der nur an der Grossschreibung scheitert, waere eine
 * Falschauskunft ueber die eigene Antwort. Der FQCN zeigt auf dieselbe Quelle wie der einfache
 * Name – zwei Schreibweisen derselben Klasse sind nicht zwei Klassen.
 */
export function buildCiteIndex(sources) {
  const byName = new Map()
  for (const s of sources || []) {
    const fqn = s.package ? `${s.package}.${s.className}` : s.className
    byName.set(s.className.toLowerCase(), s)
    byName.set(fqn.toLowerCase(), s)
  }
  return byName
}

/**
 * Ein Zitat aufloesen – oder `null`, wenn es zu keiner Quelle gehoert.
 *
 * Ein unbekanntes MITGLIED laesst die Klasse gelten und faellt auf ihre Kopfzeile zurueck: die
 * Klasse ist belegt, nur die Methode hat das Modell danebengegriffen. Der Chip zeigt dann den
 * Klassennamen, nicht den erfundenen Methodennamen – sonst stuende ein Name im Bild, den es
 * nirgends gibt.
 */
export function resolveCite(index, className, member) {
  const source = index.get((className || '').toLowerCase())
  if (!source) return null
  if (member) {
    const hit = source.members?.find((m) => m.name === member)
    if (hit) return { source, member: hit.name, line: hit.line ?? source.classLine ?? 1 }
  }
  return { source, member: null, line: source.classLine ?? 1 }
}

/**
 * Zitate im gerenderten Antwort-HTML durch Chips ersetzen.
 *
 * @param {HTMLElement} root  Container mit dem via v-html eingesetzten Markdown.
 * @param {Map} index         aus `buildCiteIndex`.
 * @returns {number}          Anzahl aufgeloester Belege (die Oberflaeche schreibt sie an).
 */
export function paintCitations(root, index) {
  if (!root || !index?.size) return 0

  // Erst einsammeln, dann ersetzen: der TreeWalker haelt sich nicht an einen Baum, der sich
  // waehrend des Laufs unter ihm aendert.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  let node
  while ((node = walker.nextNode())) {
    if (node.nodeValue.includes('[')) nodes.push(node)
  }

  let painted = 0
  for (const textNode of nodes) {
    if (!textNode.parentNode) continue
    // Code-Spans bleiben unberuehrt: `[Foo]` in einem Code-Beispiel ist Code, kein Beleg.
    if (textNode.parentElement?.closest('code, pre, .ask-cite')) continue

    const text = textNode.nodeValue
    CITE_RE.lastIndex = 0
    const hits = []
    let m
    while ((m = CITE_RE.exec(text))) {
      const resolved = resolveCite(index, m[1], m[2])
      if (resolved) hits.push({ from: m.index, to: m.index + m[0].length, resolved })
    }
    if (!hits.length) continue

    // RUECKWAERTS ersetzen – wie in `paintMatches`: jedes `splitText` laesst den Originalknoten als
    // vorderen Teil zurueck, damit bleiben die Offsets der frueheren Treffer gueltig.
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i]
      let target = textNode
      if (h.to < target.nodeValue.length) target.splitText(h.to)
      if (h.from > 0) target = target.splitText(h.from)
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = CITE_CLASS
      chip.dataset.fileId = String(h.resolved.source.fileId)
      chip.dataset.line = String(h.resolved.line)
      chip.title = h.resolved.member
        ? `Open ${h.resolved.source.className}.${h.resolved.member}() in Code`
        : `Open ${h.resolved.source.className} in Code`
      chip.textContent = h.resolved.member
        ? `${h.resolved.source.className}.${h.resolved.member}`
        : h.resolved.source.className
      target.parentNode.replaceChild(chip, target)
      painted++
    }
  }
  return painted
}
