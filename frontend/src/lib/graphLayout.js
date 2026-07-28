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
export function layoutFlat({ nodes = [], edges = [], nodesep = 90, ranksep = 110, edgesep = 40, scale = 1 } = {}) {
  const pos = new Map()
  if (!nodes.length) return { pos, width: 0, height: 0 }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const linked = new Set()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue
    linked.add(e.source)
    linked.add(e.target)
  }

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep, ranksep, edgesep, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))

  const orphans = []
  for (const n of nodes) {
    if (linked.has(n.id)) g.setNode(n.id, { width: n.width, height: n.height })
    else orphans.push(n)
  }
  for (const p of pairWeights(edges, (e) => byId.has(e.source) && byId.has(e.target))) {
    g.setEdge(p.source, p.target, { weight: p.weight })
  }
  // Ohne Knoten kein Layout: dagre setzt die Graph-Groesse dann auf -Infinity (Maximum ueber eine
  // leere Menge) – das ist truthy und wuerde alle folgenden Rechnungen unbrauchbar machen.
  if (g.nodeCount()) dagre.layout(g)

  const finite = (v) => (Number.isFinite(v) ? v : 0)
  let width = 0
  let height = 0
  for (const n of nodes) {
    if (!g.hasNode(n.id)) continue
    const nd = g.node(n.id)
    pos.set(n.id, { x: finite(nd?.x), y: finite(nd?.y) })
    width = Math.max(width, finite(nd?.x) + n.width / 2)
    height = Math.max(height, finite(nd?.y) + n.height / 2)
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
    // Mindestens annaehernd quadratisch – und breiter, wenn der verbundene Teil ohnehin Platz
    // vorgibt. (Andersherum gedeckelt waere falsch: eine Zone mit einer einzigen Knotenspalte
    // haette ihre uebrigen Klassen sonst zu einem endlosen Turm gestapelt.)
    let cols = Math.ceil(Math.sqrt(orphans.length))
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
 * @returns {{ pos: Map, zones: Array<{key,x,y,width,height,count}>, width, height }}
 */
export function layoutClustered({ nodes = [], edges = [], nodesep = 70, ranksep = 90, scale = 1 } = {}) {
  const padX = ZONE_PAD_X * scale
  const padTop = ZONE_PAD_TOP * scale
  const padBottom = ZONE_PAD_BOTTOM * scale

  const groups = new Map() // group -> nodes[]
  for (const n of nodes) {
    const key = n.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }
  const groupOf = new Map(nodes.map((n) => [n.id, n.group ?? '']))

  // 1) Jede Zone fuer sich layouten – nur mit ihren INTERNEN Kanten. Externe Kanten hier
  //    mitzurechnen wuerde die Box verzerren, ohne dass die Gegenseite ueberhaupt darin liegt.
  const boxes = new Map() // group -> { pos, width, height }
  for (const [key, list] of groups) {
    const inside = new Set(list.map((n) => n.id))
    const intra = edges.filter((e) => inside.has(e.source) && inside.has(e.target))
    const sub = layoutFlat({ nodes: list, edges: intra, nodesep, ranksep, edgesep: 30 * scale, scale })
    boxes.set(key, {
      pos: sub.pos,
      width: sub.width + padX * 2,
      height: sub.height + padTop + padBottom,
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
    zones.push({
      key,
      x: originX,
      y: originY,
      width: b.width,
      height: b.height,
      count: (groups.get(key) || []).length,
    })
    for (const [id, p] of b.pos) {
      pos.set(id, { x: originX + padX + p.x, y: originY + padTop + p.y })
    }
  }

  return { pos, zones, width: meta.width, height: meta.height }
}
