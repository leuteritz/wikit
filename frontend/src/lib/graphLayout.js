// Platzierung der Knoten im Klassen-Abhaengigkeitsgraph (reine Funktionen, kein Vue-Zustand).
//
// Warum eine eigene Datei: die Komponente (JavaDependencyGraph.vue) baut die Kanten und rendert –
// WO ein Knoten landet, ist eine abgeschlossene Rechnung darueber. Sie hier zu halten, macht sie
// nachvollziehbar und die ohnehin grosse Komponente nicht noch groesser.
//
// Zwei Verfahren:
//   layoutFlat      – ein dagre-Lauf ueber alles (bisheriges Verhalten). Bleibt der Weg fuer die
//                     Package-Ebene und fuer Ausschnitte, in denen es nur EIN Package gibt.
//   layoutClustered – ZWEISTUFIG: erst je Package ein eigenes dagre-Layout (nur mit den Kanten
//                     INNERHALB des Packages), dann ein Meta-Layout ueber die so entstandenen
//                     Boxen. Ergebnis: Klassen eines Packages stehen garantiert beieinander, die
//                     Packages selbst sind nach ihrer Abhaengigkeitsrichtung geschichtet. Das ist
//                     die Hierarchie, die ein flacher Lauf nicht liefern kann – dort mischen sich
//                     Klassen aus fuenf Packages in einer Reihe, und jede Kante muss quer.
//
// Alle Positionen sind – wie bei dagre – MITTELPUNKTE. Vue Flow will die obere linke Ecke; das
// rechnet der Aufrufer um (er kennt die Knotengroesse ohnehin).
import dagre from '@dagrejs/dagre'

// Kantengewicht fuer dagre: je hoeher, desto staerker zieht die Kante zwei Knoten in dieselbe
// Spalte und desto eher wird sie kurz und kreuzungsfrei gefuehrt. Genau die Reihenfolge, in der
// die Kantentypen etwas aussagen: ein Methodenaufruf ist eine harte Kopplung, ein blosser Import
// fast nichts. Vorher zaehlte jede Kante gleich – der Graph richtete sich nach den Imports aus.
export const EDGE_WEIGHT = { call: 6, uses: 3, import: 1, aggregate: 4 }

// Innenabstaende der Package-Zone. Oben mehr, weil dort die Kopfzeile der Zone sitzt.
// Basiswerte bei 16px-Root; der `scale`-Parameter der Layouts zieht sie mit der Root-
// Schriftgroesse mit (s. composables/useRootScale.js) – sonst waechst die Zonen-Kopfzeile,
// ihr Platz aber nicht.
const ZONE_PAD_X = 26
const ZONE_PAD_TOP = 40
const ZONE_PAD_BOTTOM = 24

const weightOf = (kind) => EDGE_WEIGHT[kind] || 1

// Mehrfachkanten zwischen demselben Paar zu EINER dagre-Kante verdichten (dagre kennt ohne
// `name` nur eine Kante je Paar – ohne Verdichtung gewinnt schlicht die zuletzt gesetzte).
function pairWeights(edges, keep = () => true) {
  const out = new Map() // "a b" -> { source, target, weight }
  for (const e of edges) {
    if (!keep(e)) continue
    if (e.source === e.target) continue
    const k = `${e.source} ${e.target}`
    const cur = out.get(k)
    if (cur) cur.weight += weightOf(e.kind)
    else out.set(k, { source: e.source, target: e.target, weight: weightOf(e.kind) })
  }
  return [...out.values()]
}

/**
 * Ein dagre-Lauf ueber die uebergebenen Knoten.
 *
 * Verbindungslose Knoten werden dabei bewusst AUS dagre herausgehalten: dagre legt sie sonst als
 * eine einzige, endlos breite Reihe ab – der Graph zoomt auf Briefmarkengroesse und der Canvas
 * bleibt vertikal leer. Sie bekommen stattdessen ein kompaktes Raster unter dem verbundenen Teil.
 *
 * @returns {{ pos: Map<string,{x:number,y:number}>, width: number, height: number }}
 *          Positionen sind Mittelpunkte, normalisiert auf den Ursprung (0,0) oben links.
 */
export function layoutFlat({ nodes = [], edges = [], nodesep = 90, ranksep = 110, edgesep = 40, scale = 1, orphanAspect = 1 } = {}) {
  const pos = new Map()
  if (!nodes.length) return { pos, width: 0, height: 0 }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const linked = new Set()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    linked.add(e.source)
    linked.add(e.target)
  }

  const orphans = nodes.filter((n) => !linked.has(n.id))
  const finite = (v) => (Number.isFinite(v) ? v : 0)
  let width = 0
  let height = 0

  // Zusammenhaengende TEILE getrennt layouten und nebeneinander legen. Warum nicht ein Lauf ueber
  // alles: dagre kennt keine Komponenten und reiht unverbundene Teilgraphen in EINER Zeile
  // aneinander. Eine Suche mit 26 Treffern, von denen jeder an seinen eigenen zwei Nachbarn haengt,
  // ergab so ein 8000 px breites Band aus 26 Sternchen – fitView zoomte es auf Briefmarkengroesse.
  // Bei genau einer Komponente aendert sich nichts (derselbe eine dagre-Lauf wie zuvor).
  const parent = new Map(nodes.map((n) => [n.id, n.id]))
  const find = (id) => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(id) !== r) {
      const next = parent.get(id)
      parent.set(id, r)
      id = next
    }
    return r
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    const a = find(e.source)
    const b = find(e.target)
    if (a !== b) parent.set(a, b)
  }
  const components = new Map() // Wurzel -> Knoten[]
  for (const n of nodes) {
    if (!linked.has(n.id)) continue
    const root = find(n.id)
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(n)
  }

  // Je Komponente ein dagre-Lauf -> lokale Positionen + Boxmass.
  const boxes = []
  for (const list of components.values()) {
    const inside = new Set(list.map((n) => n.id))
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep, ranksep, edgesep, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of list) g.setNode(n.id, { width: n.width, height: n.height })
    for (const p of pairWeights(edges, (e) => inside.has(e.source) && inside.has(e.target))) {
      g.setEdge(p.source, p.target, { weight: p.weight })
    }
    // Ohne Knoten kein Layout: dagre setzt die Graph-Groesse dann auf -Infinity (Maximum ueber eine
    // leere Menge) – das ist truthy und wuerde alle folgenden Rechnungen unbrauchbar machen.
    if (g.nodeCount()) dagre.layout(g)
    let w = 0
    let h = 0
    const local = new Map()
    for (const n of list) {
      if (!g.hasNode(n.id)) continue
      const nd = g.node(n.id)
      local.set(n.id, { x: finite(nd?.x), y: finite(nd?.y) })
      w = Math.max(w, finite(nd?.x) + n.width / 2)
      h = Math.max(h, finite(nd?.y) + n.height / 2)
    }
    boxes.push({ local, w, h })
  }

  if (boxes.length === 1) {
    const b = boxes[0]
    for (const [id, p] of b.local) pos.set(id, p)
    width = b.w
    height = b.h
  } else if (boxes.length > 1) {
    // Regalpackung: groesste Komponente zuerst (sie traegt die meiste Information und gehoert nach
    // oben links), danach zeilenweise auffuellen bis zur Zielbreite. Die Zielbreite ist so gewaehlt,
    // dass die Gesamtflaeche etwa die Form eines Bildschirms bekommt – ein Band waere so breit,
    // dass fitView alles unlesbar klein zoomt, ein Turm genauso hoch.
    const gapX = 70 * scale
    const gapY = 70 * scale
    boxes.sort((a, b) => b.w * b.h - a.w * a.h)
    const area = boxes.reduce((sum, b) => sum + (b.w + gapX) * (b.h + gapY), 0)
    const targetW = Math.max(boxes[0].w, Math.sqrt(area * 1.6))
    let x = 0
    let y = 0
    let shelfH = 0
    for (const b of boxes) {
      if (x > 0 && x + b.w > targetW) {
        x = 0
        y += shelfH + gapY
        shelfH = 0
      }
      for (const [id, p] of b.local) pos.set(id, { x: x + p.x, y: y + p.y })
      x += b.w + gapX
      shelfH = Math.max(shelfH, b.h)
      width = Math.max(width, x - gapX)
      height = Math.max(height, y + b.h)
    }
  }

  // Raster der verbindungslosen Knoten: annaehernd quadratisch, unter dem verbundenen Teil. Die
  // Spaltenzahl orientiert sich zusaetzlich an dessen Breite, damit die Box nicht ploetzlich
  // doppelt so breit wird wie der eigentliche Graph.
  if (orphans.length) {
    const ow = Math.max(...orphans.map((n) => n.width))
    const oh = Math.max(...orphans.map((n) => n.height))
    const gapX = 48 * scale
    const colStep = ow + gapX
    const rowStep = oh + 40 * scale
    // Annaehernd quadratisch – aber in PIXELN, nicht in Knoten. Eine Karte ist gut dreimal so
    // breit wie hoch; `sqrt(n)` Spalten ergaben deshalb eine Box im Verhaeltnis 3:1, und fitView
    // musste sie auf die Breite herunterzoomen, bis die Klassennamen nicht mehr zu lesen waren
    // (26 Treffer einer Suche: 6 Spalten, Zoom 0.46). Ueber das Seitenverhaeltnis gerechnet sind
    // es 4 Spalten und fast volle Groesse – dieselbe Flaeche, nur in der Form des Bildschirms.
    // Breiter wird das Raster weiterhin, wenn der verbundene Teil ohnehin Platz vorgibt.
    // (Andersherum gedeckelt waere falsch: eine Zone mit einer einzigen Knotenspalte haette ihre
    // uebrigen Klassen sonst zu einem endlosen Turm gestapelt.)
    // `orphanAspect` verschiebt dieses Ziel: INNERHALB einer Package-Zone soll breit-flach heraus-
    // kommen, nicht quadratisch. Zwei Klassen desselben Packages ohne Kante zwischen ihnen ergaben
    // sonst eine Spalte – also untereinander, obwohl sie zusammengehoeren –, und weil das
    // Meta-Layout die Zonen ohnehin uebereinander schichtet, wuchs damit nur die Gesamthoehe.
    let cols = Math.max(1, Math.ceil(Math.sqrt((orphans.length * rowStep * orphanAspect) / colStep)))
    if (width > 0) cols = Math.max(cols, Math.floor(width / colStep))
    const rows = Math.ceil(orphans.length / cols)
    const gridW = cols * colStep - gapX
    const originX = width > 0 ? (width - gridW) / 2 : 0
    const originY = height > 0 ? height + rowStep - oh / 2 : 0
    orphans.forEach((n, i) => {
      pos.set(n.id, {
        x: originX + (i % cols) * colStep + n.width / 2,
        y: originY + Math.floor(i / cols) * rowStep + n.height / 2,
      })
    })
    width = Math.max(width, originX + gridW)
    height = Math.max(height, originY + rows * rowStep - (rowStep - oh))
  }

  // Auf den Ursprung normalisieren: der Aufrufer (bzw. das Meta-Layout) setzt die Box irgendwohin,
  // deshalb darf hier kein negativer Rand uebrig bleiben.
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    minX = Math.min(minX, p.x - n.width / 2)
    minY = Math.min(minY, p.y - n.height / 2)
  }
  if (Number.isFinite(minX) && (minX !== 0 || minY !== 0)) {
    for (const [id, p] of pos) pos.set(id, { x: p.x - minX, y: p.y - minY })
    width -= minX
    height -= minY
  }

  return { pos, width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * Zweistufiges Layout mit Package-Zonen.
 *
 * @param nodes  [{ id, width, height, group }] – `group` ist der Package-Pfad
 * @param edges  [{ source, target, kind }]
 * @param minGroupSize  ab wie vielen Knoten eine Gruppe eine EIGENE Zone bekommt (Default 1 = jede).
 *   Alles darunter wandert in eine gemeinsame, rahmenlose Restgruppe. Gedacht für Ausschnitte, die
 *   quer über die Codebasis liegen (Suchtreffer): dort ist eine Zone um eine einzelne Karte ein
 *   Rahmen ohne Aussage – und kostet trotzdem einen eigenen dagre-Lauf plus einen Meta-Knoten.
 * @returns {{ pos: Map, zones: Array<{key,x,y,width,height,count}>, width, height }}
 */
// Schlüssel der rahmenlosen Restgruppe. Ein NUL-Zeichen kann in keinem Package-Pfad vorkommen,
// die Gruppe kann also nie mit einer echten kollidieren.
const MISC_GROUP = ' misc'

export function layoutClustered({ nodes = [], edges = [], nodesep = 70, ranksep = 90, scale = 1, minGroupSize = 1 } = {}) {
  const padX = ZONE_PAD_X * scale
  const padTop = ZONE_PAD_TOP * scale
  const padBottom = ZONE_PAD_BOTTOM * scale

  const groups = new Map() // group -> nodes[]
  for (const n of nodes) {
    const key = n.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }

  // Zu kleine Gruppen einsammeln: EIN Layout-Durchgang für alle statt einer je Einzelgänger.
  if (minGroupSize > 1) {
    const misc = []
    for (const [key, list] of [...groups]) {
      if (list.length < minGroupSize) {
        misc.push(...list)
        groups.delete(key)
      }
    }
    if (misc.length) groups.set(MISC_GROUP, misc)
  }

  // Zuordnung NACH dem Umgruppieren: die Meta-Kanten müssen auf die Restgruppe zeigen, nicht auf
  // die aufgelösten Einzelgruppen.
  const groupOf = new Map()
  for (const [key, list] of groups) for (const n of list) groupOf.set(n.id, key)

  // 1) Jede Zone fuer sich layouten – nur mit ihren INTERNEN Kanten. Externe Kanten hier
  //    mitzurechnen wuerde die Box verzerren, ohne dass die Gegenseite ueberhaupt darin liegt.
  const boxes = new Map() // group -> { pos, width, height, padX, padTop }
  for (const [key, list] of groups) {
    const inside = new Set(list.map((n) => n.id))
    const intra = edges.filter((e) => inside.has(e.source) && inside.has(e.target))
    // orphanAspect: Klassen einer Zone, die untereinander keine Kante haben, sollen NEBENeinander
    // stehen (s. Begruendung in layoutFlat) – „gleiches Package" ist genau die Aussage der Zone.
    const sub = layoutFlat({ nodes: list, edges: intra, nodesep, ranksep, edgesep: 30 * scale, scale, orphanAspect: 3 })
    // Die Restgruppe wird nicht gerahmt und braucht deshalb weder Innenabstand noch Platz für eine
    // Kopfzeile – sonst stünde ihr Inhalt gegenüber den echten Zonen versetzt.
    const framed = key !== MISC_GROUP
    const px = framed ? padX : 0
    const pt = framed ? padTop : 0
    const pb = framed ? padBottom : 0
    boxes.set(key, {
      pos: sub.pos,
      width: sub.width + px * 2,
      height: sub.height + pt + pb,
      padX: px,
      padTop: pt,
    })
  }

  // 2) Meta-Layout ueber die Boxen: jede Zone ist EIN Knoten in ihrer tatsaechlichen Groesse,
  //    die Kanten sind die zwischen den Packages gebuendelten Klassenbeziehungen. dagre schichtet
  //    damit die Packages so, wie die Abhaengigkeiten laufen (Definition oben, Nutzung unten).
  const metaNodes = [...boxes].map(([key, b]) => ({ id: key, width: b.width, height: b.height }))
  const metaEdges = []
  for (const e of edges) {
    const a = groupOf.get(e.source)
    const b = groupOf.get(e.target)
    if (a == null || b == null || a === b) continue
    metaEdges.push({ source: a, target: b, kind: e.kind })
  }
  // Zonen sind gross – zwischen ihnen braucht es mehr Luft als zwischen Knoten, sonst laufen die
  // Kanten der einen Zone durch die Kopfzeile der naechsten.
  const meta = layoutFlat({
    nodes: metaNodes,
    edges: metaEdges,
    nodesep: 80 * scale,
    ranksep: 110 * scale,
    edgesep: 60 * scale,
    scale,
  })

  // 3) Zonen absolut setzen und die lokalen Knotenpositionen hineinschieben.
  const pos = new Map()
  const zones = []
  for (const [key, b] of boxes) {
    const mp = meta.pos.get(key) || { x: b.width / 2, y: b.height / 2 }
    const originX = mp.x - b.width / 2
    const originY = mp.y - b.height / 2
    // Die Restgruppe ist nur eine Platzierungshilfe, keine Aussage -> sie liefert keine Zone.
    if (key !== MISC_GROUP) {
      zones.push({
        key,
        x: originX,
        y: originY,
        width: b.width,
        height: b.height,
        count: (groups.get(key) || []).length,
      })
    }
    for (const [id, p] of b.pos) {
      pos.set(id, { x: originX + b.padX + p.x, y: originY + b.padTop + p.y })
    }
  }

  return { pos, zones, width: meta.width, height: meta.height }
}
