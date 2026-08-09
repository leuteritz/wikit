// Belege in einer Ask-Antwort: `[OrderService]` bzw. `[OrderService#place]` im gerenderten Text
// werden zu anklickbaren Chips, die in `/code` genau diese Klasse (und Zeile) aufschlagen –
// `[wiki:mein-slug]` entsprechend zu einem Chip, der den Wiki-Artikel oeffnet.
//
// ⚠️ **Die eine Regel dieser Datei: Nur ein Zitat, das zu einer GELIEFERTEN Quelle passt, wird zum
// Chip.** Alles andere bleibt gewoehnlicher Text. Ein Sprachmodell erfindet in einer fremden
// Codebasis plausible Klassennamen – und ein erfundener Beleg, der aussieht wie ein echter, ist
// schlimmer als gar keiner: er laedt zum Nachsehen ein und fuehrt ins Leere. Was hier nicht
// aufgeloest wird, ist damit auch sichtbar nicht belegt.
//
// ⚠️ **Ein Artikel wird ueber `wiki:` + SLUG zitiert, nicht ueber seinen Titel.** Zwei Gruende, und
// beide sind zwingend: ein Titel traegt Leerzeichen und Satzzeichen (die Erkennung muesste raten,
// wo das Zitat endet), und ein exportierter Klassenartikel heisst genau so wie seine Klasse –
// `[OrderService]` waere ohne Praefix zwei verschiedene Sprungziele. Der Slug steht dem Modell im
// Quellenblock als fertiges Zitat zur Verfuegung (s. `articleBlock` im AskService).
//
// Gearbeitet wird auf TEXTKNOTEN des gerenderten Markdowns, nicht auf dem HTML-String: eine Regex
// ueber `<p>…</p>` trifft irgendwann in einem Attribut, und markdown-it laeuft hier mit
// `html:false` – der Text ist bereits escaped, ein zweiter Durchgang auf der Zeichenkette wuerde
// genau diese Escapes wieder aufbrechen. Dasselbe Vorgehen wie `paintMatches` in `javaCode.js`.

export const CITE_CLASS = 'ask-cite'

// Zwei Alternativen in EINER Regex, damit die Reihenfolge der Treffer im Text erhalten bleibt.
// Links: `[wiki:slug]` – Slugs sind kebab-case, also zusaetzlich `-` (und `.`, falls jemand einen
// Punkt im Slug hat). Rechts: `[Name]` / `[Name#member]`, bewusst eng auf Java-Identifier plus `.`
// fuer den vollen FQCN. Ein `[` mitten in Prosa („[siehe oben]") faellt damit durch beide.
const CITE_RE = /\[(?:wiki:([\w-][\w.-]*)|([A-Za-z_$][\w$.]*)(?:#([A-Za-z_$][\w$]*))?)\]/g

/**
 * Nachschlagewerk aus den Quellen des Laufs.
 *
 * Geschluesselt wird kleingeschrieben: das Modell schreibt `[orderservice]`, wenn es den Namen aus
 * dem Fliesstext uebernimmt, und ein Beleg, der nur an der Grossschreibung scheitert, waere eine
 * Falschauskunft ueber die eigene Antwort. Der FQCN zeigt auf dieselbe Quelle wie der einfache
 * Name – zwei Schreibweisen derselben Klasse sind nicht zwei Klassen.
 *
 * Artikel liegen im selben Map, aber in einem eigenen Namensraum (`wiki:`) – so kann eine Klasse
 * und ein gleichnamiger Artikel nebeneinander stehen, ohne dass einer den anderen verdeckt.
 */
export function buildCiteIndex(sources) {
  const byName = new Map()
  for (const s of sources || []) {
    if (s.kind === 'article') {
      byName.set(`wiki:${(s.slug || '').toLowerCase()}`, s)
      continue
    }
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
 *
 * @param {Map} index    aus `buildCiteIndex`.
 * @param {object} cite  `{ slug }` fuer einen Artikel, sonst `{ className, member }`.
 */
export function resolveCite(index, cite) {
  if (cite.slug) {
    const source = index.get(`wiki:${cite.slug.toLowerCase()}`)
    return source ? { source, member: null, line: null } : null
  }
  const source = index.get((cite.className || '').toLowerCase())
  if (!source) return null
  if (cite.member) {
    const hit = source.members?.find((m) => m.name === cite.member)
    if (hit) return { source, member: hit.name, line: hit.line ?? source.classLine ?? 1 }
  }
  return { source, member: null, line: source.classLine ?? 1 }
}

/**
 * Der fertige Chip zu einem aufgeloesten Beleg.
 *
 * ⚠️ Die Herkunft steht als WORT im Chip (`wiki`), nicht als zweiter Farbton. Eine Farbe muesste
 * hier eine Bedeutung tragen, die im Rest der Oberflaeche schon vergeben ist (Gruen heisst
 * „erfolgreich", Gold „pruefen"), und ein Icon hiesse ein inline-SVG an einer Stelle, an der kein
 * Vue laeuft – beides fuer eine Auskunft, die ein Wort direkt hinschreiben kann. Der Klassen-Chip
 * bleibt dafuer Monospace: ein Klassenname IST Code, ein Artikeltitel ist Prosa.
 */
function buildChip({ source, member, line }) {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = CITE_CLASS

  if (source.kind === 'article') {
    chip.classList.add(`${CITE_CLASS}--wiki`)
    chip.dataset.slug = source.slug
    chip.title = `Open “${source.title}” in the wiki`
    const kind = document.createElement('span')
    kind.className = `${CITE_CLASS}-kind`
    kind.textContent = 'wiki'
    chip.append(kind, document.createTextNode(source.title))
    return chip
  }

  chip.dataset.fileId = String(source.fileId)
  chip.dataset.line = String(line)
  chip.title = member
    ? `Open ${source.className}.${member}() in Code`
    : `Open ${source.className} in Code`
  chip.textContent = member ? `${source.className}.${member}` : source.className
  return chip
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
      const resolved = resolveCite(index, { slug: m[1], className: m[2], member: m[3] })
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
      target.parentNode.replaceChild(buildChip(h.resolved), target)
      painted++
    }
  }
  return painted
}
