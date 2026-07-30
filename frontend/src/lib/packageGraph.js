// Aggregation des Klassengraphen auf Package-Ebene (reine Funktionen, kein Vue-Zustand).
//
// Warum: Ein Knoten je Klasse ist ab wenigen hundert Klassen nicht mehr lesbar – bei einer
// Codebasis mit tausenden Klassen ist der Graph ein Raster aus Kaesten. Statt zu zoomen wird der
// Graph deshalb HIERARCHISCH gelesen: Man beginnt bei den Packages und steigt schrittweise ab,
// bis man bei den Klassen eines Packages ankommt. Auf jeder Ebene sind es nur so viele Knoten,
// wie das Package an direkten Kindern hat.
//
// Begriffe:
//   basePath   – Pfad, in den hineingezoomt wurde ('' = oberste Ebene)
//   Gruppe     – ein direktes Sub-Package von basePath (aggregiert ALLE Klassen darunter)
//   direkte Klasse – eine Klasse, die unmittelbar in basePath liegt (kein weiteres Segment)

export const DEFAULT_PACKAGE = '(default)'

const segments = (pkg) => (pkg && pkg !== DEFAULT_PACKAGE ? pkg.split('.').filter(Boolean) : [])

// Laengster gemeinsamer Package-Praefix aller Klassen. Liegt alles unter `com.acme`, waere die
// oberste Ebene sonst ein einziger Knoten „com" – ein Klick ohne Information. Wir starten
// stattdessen dort, wo sich die Codebasis zum ersten Mal verzweigt.
export function commonPackagePrefix(files) {
  const lists = []
  for (const f of files || []) {
    const segs = segments(f.package)
    if (!segs.length) return '' // default package vorhanden -> kein gemeinsamer Praefix
    lists.push(segs)
  }
  if (!lists.length) return ''
  const first = lists[0]
  let depth = 0
  // Bis zum echten gemeinsamen Praefix laufen. Eine Klasse, die GENAU im Praefix liegt, geht
  // dabei nicht verloren: buildPackageLevel zeigt sie als direkten Klassenknoten dieser Ebene.
  // (Frueher stoppte die Schleife eine Ebene frueher – lagen Klassen direkt in `com.acme` und
  // weitere in `com.acme.billing`, war der Praefix `com` und die Startebene bestand aus einem
  // einzigen Knoten `acme`: ein Klick ohne jede Information.)
  while (depth < first.length) {
    const seg = first[depth]
    if (!lists.every((l) => l.length > depth && l[depth] === seg)) break
    depth++
  }
  return first.slice(0, depth).join('.')
}

// Gehoert `pkg` zu `basePath` (gleich oder darunter)?
function inBase(pkg, basePath) {
  if (!basePath) return true
  if (pkg === basePath) return true
  return typeof pkg === 'string' && pkg.startsWith(basePath + '.')
}

// Der Ebenen-Schluessel einer Klasse: Name des direkten Sub-Packages unter basePath, oder null,
// wenn die Klasse unmittelbar in basePath liegt.
function childSegment(pkg, basePath) {
  if (!inBase(pkg, basePath)) return undefined // ausserhalb der aktuellen Ebene
  const rest = basePath ? String(pkg).slice(basePath.length + 1) : String(pkg === DEFAULT_PACKAGE ? '' : pkg)
  if (!rest) return null // direkt in basePath
  return rest.split('.')[0]
}

// Eine Ebene des Graphen aufbauen.
//   files       – alle Klassen (Listenform: id, class_name, package, description, dependencies…)
//   classEdges  – Klassenkanten als [{ fromId, toId, kind }] (Call/Uses/Import bereits aufgeloest)
//   basePath    – aktueller Pfad
// Rueckgabe:
//   groups        – Aggregatknoten dieser Ebene
//   directFiles   – Klassen, die auf dieser Ebene als echte Klassenknoten erscheinen
//   groupEdges    – Kanten zwischen den Knoten dieser Ebene (aggregiert, mit count)
//   externalByKey – je Ebenenknoten die Zahl der Kanten, die die Ebene verlassen
export function buildPackageLevel({ files = [], classEdges = [], basePath = '' } = {}) {
  const groups = new Map() // segment -> Aggregat
  const directFiles = []
  const keyByFileId = new Map() // fileId -> Ebenen-Schluessel ('p:<path>' | 'c:<id>')

  for (const f of files) {
    const pkg = f.package || DEFAULT_PACKAGE
    const seg = childSegment(pkg, basePath)
    if (seg === undefined) continue // gehoert nicht in diese Ebene
    if (seg === null) {
      directFiles.push(f)
      keyByFileId.set(f.id, `c:${f.id}`)
      continue
    }
    const path = basePath ? `${basePath}.${seg}` : seg
    let g = groups.get(seg)
    if (!g) {
      g = {
        id: `p:${path}`,
        path,
        label: seg,
        classCount: 0,
        analyzedCount: 0,
        methodCount: 0,
        childPaths: new Set(), // direkte Sub-Packages -> „hat noch eine Ebene darunter?"
      }
      groups.set(seg, g)
    }
    g.classCount++
    if (f.description && String(f.description).trim()) g.analyzedCount++
    g.methodCount += f.method_count ?? (f.methods || []).length
    const deeper = childSegment(pkg, path)
    if (deeper) g.childPaths.add(deeper)
    keyByFileId.set(f.id, g.id)
  }

  // Kanten auf die Ebenen-Knoten hochziehen. Kanten innerhalb desselben Knotens sind auf dieser
  // Ebene keine Information (sie liegen eine Ebene tiefer) und werden nur gezaehlt.
  const groupEdges = new Map()
  const internalByKey = new Map()
  const externalByKey = new Map()
  for (const e of classEdges) {
    const a = keyByFileId.get(e.fromId)
    const b = keyByFileId.get(e.toId)
    if (!a && !b) continue
    if (!a || !b) {
      // Genau ein Endpunkt liegt in dieser Ebene -> Kante verlaesst den sichtbaren Ausschnitt.
      const key = a || b
      externalByKey.set(key, (externalByKey.get(key) || 0) + 1)
      continue
    }
    if (a === b) {
      internalByKey.set(a, (internalByKey.get(a) || 0) + 1)
      continue
    }
    // Klasse -> Klasse NICHT aggregieren: liegen beide Enden als echte Klassenknoten auf dieser
    // Ebene, zeichnet der regulaere Kantenpfad diese Verbindung bereits – und zwar mit der
    // besseren Information (Methodennamen, klickbar). Eine zusaetzliche Aggregatkante daneben
    // waere dieselbe Beziehung ein zweites Mal, nur aermer beschriftet.
    if (a.startsWith('c:') && b.startsWith('c:')) continue
    const k = `${a}->${b}`
    const cur = groupEdges.get(k)
    if (cur) cur.count++
    else groupEdges.set(k, { id: k, source: a, target: b, count: 1 })
  }

  const groupList = [...groups.values()]
    .map((g) => ({
      ...g,
      hasChildren: g.childPaths.size > 0,
      childCount: g.childPaths.size,
      internal: internalByKey.get(g.id) || 0,
      external: externalByKey.get(g.id) || 0,
      childPaths: undefined,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return {
    groups: groupList,
    directFiles,
    groupEdges: [...groupEdges.values()],
    externalByKey,
    // fileId -> Ebenen-Schluessel. Wird gebraucht, um eine AGGREGATKANTE wieder aufzuloesen:
    // „welche Klassenbeziehungen stecken in diesem Buendel?" laesst sich nur beantworten, wenn
    // man von jeder Klasse weiss, unter welchem Knoten dieser Ebene sie zusammengefasst wurde.
    keyByFileId,
  }
}

// Die Umgebung eines Ausschnitts: was liegt AUSSERHALB und haengt mit ihm zusammen?
//
// Warum: buildPackageLevel beantwortet „was steckt in diesem Package?". Jede Kante, die den
// Ausschnitt verlaesst, wird dort nur GEZAEHLT (externalByKey) – gezeichnet wird sie nie. Damit
// sieht ein geoeffnetes Package aus wie eine Insel, obwohl genau die Frage „wen benutzt es, und
// wer benutzt es?" der Grund ist, warum man es geoeffnet hat. Diese Funktion hebt jede solche
// Kante auf einen Aggregatknoten AUSSERHALB des Ausschnitts.
//
// Granularitaet: der Nachbarknoten ist der Zweig, an dem der fremde Pfad den Ausschnitt verlaesst
// (erstes abweichendes Segment). Fuer basePath `com.acme.n8n.core` landet `com.acme.n8n.util.x`
// unter `com.acme.n8n.util`, `com.acme.bom.impl` unter `com.acme.bom`. Jeder Nachbar ist damit ein
// Geschwisterzweig eines Vorfahren des Ausschnitts – lesbar benannt und in der Zahl begrenzt
// (hoechstens so viele, wie der Pfad Geschwister hat).
//
//   files       – alle Klassen
//   classEdges  – [{ fromId (Definition/Provider), toId (Nutzung/Consumer), kind }]
//   basePath    – der geoeffnete Ausschnitt ('' -> es gibt kein Aussen)
//   insideKeys  – fileId -> Ebenen-Schluessel der GEZEICHNETEN Knoten des Ausschnitts. Bewusst ein
//                 Parameter und nicht `level.keyByFileId`: auf der Package-Ebene haengt eine Klasse
//                 an ihrem Aggregatknoten, im Klassenmodus an sich selbst – die Kante muss an dem
//                 Knoten landen, der wirklich da ist.
//   rootPath    – gemeinsamer Praefix; nur fuer die Beschriftung (er steht bereits im Breadcrumb)
//   limit       – hoechstens so viele Nachbarknoten; der Rest wird gemeldet, nicht verschwiegen
export function buildNeighbourLevel({
  files = [],
  classEdges = [],
  basePath = '',
  insideKeys = new Map(),
  rootPath = '',
  limit = 8,
} = {}) {
  const empty = {
    nodes: [],
    edges: [],
    keyByFileId: new Map(),
    linkedIds: new Set(),
    hiddenPackages: 0,
    hiddenRelations: 0,
    relations: 0,
  }
  if (!basePath) return empty // der Ausschnitt ist alles -> es gibt nichts ausserhalb

  const baseSegs = segments(basePath)
  const label = (path) => {
    if (!path) return DEFAULT_PACKAGE
    if (rootPath && path === rootPath) return path
    if (rootPath && path.startsWith(rootPath + '.')) return path.slice(rootPath.length + 1)
    return path
  }

  // fileId -> Nachbarknoten. Klassen INNERHALB des Ausschnitts sind nie Nachbarn – auch die, die
  // gerade nicht gezeichnet werden (abgeschnittener Ausschnitt): sie gehoeren zum Package, nicht
  // zu seiner Umgebung, und wuerden sonst als Nachbarknoten des eigenen Pfades auftauchen.
  const keyByFileId = new Map()
  const nodes = new Map()
  for (const f of files) {
    if (insideKeys.has(f.id)) continue
    const pkg = f.package || DEFAULT_PACKAGE
    if (inBase(pkg, basePath)) continue
    const segs = segments(pkg)
    let i = 0
    while (i < baseSegs.length && i < segs.length && baseSegs[i] === segs[i]) i++
    const path = segs.slice(0, Math.min(i + 1, segs.length)).join('.')
    const key = `p:${path || DEFAULT_PACKAGE}`
    keyByFileId.set(f.id, key)
    let node = nodes.get(key)
    if (!node) {
      node = { id: key, path, label: label(path), classCount: 0, linked: new Set(), provides: 0, consumes: 0, relations: 0 }
      nodes.set(key, node)
    }
    node.classCount++
  }

  // Kanten hochziehen: genau EIN Endpunkt liegt im Ausschnitt.
  const edges = new Map()
  const linkedIds = new Set() // jede Klasse ausserhalb, die wirklich eine Beziehung zum Ausschnitt hat
  let relations = 0
  for (const e of classEdges) {
    const a = insideKeys.get(e.fromId) // Definition
    const b = insideKeys.get(e.toId) // Nutzung
    if ((a && b) || (!a && !b)) continue // ganz innen (zeichnet der Ausschnitt) bzw. ganz aussen
    const outsideId = a ? e.toId : e.fromId
    const key = keyByFileId.get(outsideId)
    if (!key) continue // ausserhalb, aber nicht gezeichnet (Ausschnitt abgeschnitten)
    const node = nodes.get(key)
    const source = a || key
    const target = a ? key : b
    const k = `${source}->${target}`
    const cur = edges.get(k)
    if (cur) cur.count++
    else edges.set(k, { id: k, source, target, count: 1 })
    node.linked.add(outsideId)
    linkedIds.add(outsideId)
    if (a) node.consumes++ // der Nachbar nutzt den Ausschnitt
    else node.provides++ // der Ausschnitt nutzt den Nachbarn
    node.relations++
    relations++
  }

  // Nachbarn ohne Beziehung sind keine Nachbarn – nur andere Packages.
  const withRelations = [...nodes.values()].filter((n) => n.relations > 0)
  const ranked = withRelations.sort((a, b) => b.relations - a.relations || a.label.localeCompare(b.label))
  const kept = ranked.slice(0, limit)
  const keptIds = new Set(kept.map((n) => n.id))
  const hidden = ranked.slice(limit)

  return {
    nodes: kept.map((n) => ({
      id: n.id,
      path: n.path,
      label: n.label,
      classCount: n.classCount,
      linkedCount: n.linked.size,
      provides: n.provides,
      consumes: n.consumes,
      relations: n.relations,
    })),
    edges: [...edges.values()].filter((e) => keptIds.has(e.source) || keptIds.has(e.target)),
    // Nur die behaltenen Knoten: das Buendel-Panel loest eine Aggregatkante ueber diese Zuordnung
    // auf und darf keine Klasse einem Knoten zuschlagen, den es gar nicht gibt.
    keyByFileId: new Map([...keyByFileId].filter(([, key]) => keptIds.has(key))),
    // Absichtlich UNGEDECKELT: die Deckelung oben begrenzt die AGGREGATKNOTEN. Sind es wenige
    // Klassen, zeigt der Graph sie einzeln (Klassenmodus) – dort waere ein Package-Deckel eine
    // willkuerliche Luecke im Bild.
    linkedIds,
    hiddenPackages: hidden.length,
    hiddenRelations: hidden.reduce((sum, n) => sum + n.relations, 0),
    relations,
  }
}

// --- Ego-Ausschnitt: EINE Klasse und alles, was an ihr haengt ---------------------------------
//
// Der Fall „ich suche eine Klasse" ist ein anderer als „ich suche ein Wort": gefragt ist nicht die
// Trefferliste, sondern DIESE Klasse mit ihren Beziehungen. Die Suche zeigte dafuer bisher nur den
// Treffer, sobald er viele Nachbarn hatte (der Kontext kam automatisch erst bis 30 Knoten) – also
// genau dann nichts, wenn es am meisten zu sehen gaebe: eine Karte ohne eine einzige Kante.
//
// Diese Funktion baut den Ausschnitt in zwei Stufen, weil eine Darstellung nicht beides kann:
//   * die staerksten `cardLimit` Nachbarn als EINZELNE Klassenkarten (ihre Kanten tragen
//     Methodennamen und fuehren bis in den Code),
//   * alle weiteren zusammengefasst je Package als Aggregatknoten mit Aggregatkante – bei 137
//     Nachbarn ist „util · 41 relations" eine Aussage, 137 Karten sind es nicht.
// „Staerkster" Nachbar = Summe der Kantengewichte: ein Aufruf wiegt mehr als eine Typnutzung, die
// mehr als ein Import. Wer im Bild bleibt, soll der sein, mit dem die Klasse wirklich arbeitet.
const EGO_KIND_WEIGHT = { call: 3, uses: 2, import: 1 }

export function buildEgoLevel({
  files = [],
  classEdges = [],
  centerId = null,
  cardLimit = 40,
  nodeLimit = 10,
  rootPath = '',
  // Packages, die der Nutzer aufgeklappt hat: ihre Klassen werden IMMER als Karten gezeichnet,
  // unabhaengig von der Rangfolge, und sie bekommen kein Aggregat mehr. So laesst sich der
  // Ausschnitt schrittweise oeffnen, statt nur zwischen „40" und „alles" zu wechseln.
  expandedPaths = null,
} = {}) {
  const empty = {
    cardIds: new Set(),
    nodes: [],
    edges: [],
    keyByFileId: new Map(),
    linkedIds: new Set(),
    neighbours: 0,
    relations: 0,
    aggregatedClasses: 0,
    hiddenPackages: 0,
    hiddenRelations: 0,
  }
  const byId = new Map(files.map((f) => [f.id, f]))
  if (centerId == null || !byId.has(centerId)) return empty

  // 1) Nachbarn sammeln und gewichten.
  // `provides`/`consumes` aus Sicht des NACHBARN – dieselbe Lesart wie bei den Umgebungs-Knoten
  // eines Packages (Pfeil nach unten = liefert an den Ausschnitt, nach oben = nutzt ihn).
  const stats = new Map() // fileId -> { weight, relations, provides, consumes }
  let relations = 0
  for (const e of classEdges) {
    const other = e.fromId === centerId ? e.toId : e.toId === centerId ? e.fromId : null
    if (other == null || other === centerId || !byId.has(other)) continue
    const s = stats.get(other) || { weight: 0, relations: 0, provides: 0, consumes: 0 }
    s.weight += EGO_KIND_WEIGHT[e.kind] ?? 1
    s.relations++
    if (e.toId === centerId) s.provides++
    else s.consumes++
    stats.set(other, s)
    relations++
  }
  if (!stats.size) return { ...empty, neighbours: 0 }

  // 2) Aufteilen: Karten vs. Aggregat. Sortiert nach Gewicht, bei Gleichstand nach Namen – damit
  //    dieselbe Datenlage immer dasselbe Bild ergibt (sonst wechselt das Bild bei jedem Aufruf).
  const ranked = [...stats.entries()].sort(
    (a, b) =>
      b[1].weight - a[1].weight ||
      b[1].relations - a[1].relations ||
      String(byId.get(a[0])?.class_name).localeCompare(String(byId.get(b[0])?.class_name)),
  )
  const expanded = expandedPaths instanceof Set ? expandedPaths : new Set(expandedPaths || [])
  const isExpanded = (id) => expanded.size > 0 && expanded.has(byId.get(id)?.package || DEFAULT_PACKAGE)
  const cardIds = new Set()
  const rest = []
  ranked.forEach(([id, s], i) => {
    // Aufgeklappte Packages zaehlen NICHT gegen das Kartenbudget: wer ein Package oeffnet, will es
    // ganz sehen – sonst waere die Haelfte davon wieder im Aggregat, das man gerade aufgeloest hat.
    if (i < cardLimit || isExpanded(id)) cardIds.add(id)
    else rest.push([id, s])
  })

  // 3) Rest je Package zusammenfassen.
  const label = (path) => {
    if (!path) return DEFAULT_PACKAGE
    if (rootPath && path === rootPath) return path
    if (rootPath && path.startsWith(rootPath + '.')) return path.slice(rootPath.length + 1)
    return path
  }
  const groups = new Map()
  const keyByFileId = new Map()
  for (const [id, s] of rest) {
    const pkg = byId.get(id)?.package || DEFAULT_PACKAGE
    const key = `p:${pkg}`
    keyByFileId.set(id, key)
    let g = groups.get(key)
    if (!g) {
      g = {
        id: key,
        path: pkg === DEFAULT_PACKAGE ? '' : pkg,
        label: label(pkg),
        classCount: 0,
        // Jede Klasse hier beruehrt die Mitte per Definition – „linked" ist deshalb identisch mit
        // `classCount`. Das Feld bleibt trotzdem, weil die Nachbar-Karte es rendert und beide
        // Herkuenfte (Package-Umgebung und Ego) dieselbe Karte benutzen.
        linkedCount: 0,
        provides: 0,
        consumes: 0,
        relations: 0,
        related: true,
      }
      groups.set(key, g)
    }
    g.classCount++
    g.linkedCount++
    g.relations += s.relations
    g.provides += s.provides
    g.consumes += s.consumes
  }

  // Nach Beziehungszahl deckeln: zehn Aggregate sind noch ein Bild, dreissig sind wieder eine
  // Wolke. Was wegfaellt, wird gezaehlt und angeschrieben – nie stillschweigend.
  const sorted = [...groups.values()].sort((a, b) => b.relations - a.relations || a.label.localeCompare(b.label))
  const kept = sorted.slice(0, nodeLimit)
  const hidden = sorted.slice(nodeLimit)
  const keptIds = new Set(kept.map((n) => n.id))

  return {
    cardIds,
    nodes: kept,
    edges: kept.map((n) => ({
      id: `ego:${centerId}:${n.id}`,
      source: `c:${centerId}`,
      target: n.id,
      count: n.relations,
    })),
    keyByFileId: new Map([...keyByFileId].filter(([, key]) => keptIds.has(key))),
    linkedIds: new Set(), // Nachbarkarten kommen im Ego-Modus aus `cardIds`, nicht von hier
    neighbours: stats.size,
    relations,
    aggregatedClasses: kept.reduce((sum, n) => sum + n.classCount, 0),
    hiddenPackages: hidden.length,
    hiddenRelations: hidden.reduce((sum, n) => sum + n.relations, 0),
    // Fuer die Bedienung: wieviele Nachbarn stehen als Karte im Bild, und welche Packages sind
    // aufgeklappt (die Leiste zeigt sie als abwaehlbare Chips).
    cardCount: cardIds.size,
    expandedPaths: [...expanded].filter((p) => ranked.some(([id]) => (byId.get(id)?.package || DEFAULT_PACKAGE) === p)),
  }
}

// Breadcrumb ab der Wurzel-Ebene: [{ label, path }]. Der erste Eintrag ist der gemeinsame
// Praefix (dort beginnt die Navigation), danach folgt je Segment darunter ein Eintrag. Die
// Segmente des Praefixes selbst tauchen NICHT einzeln auf – sie sind nicht anspringbar, weil
// oberhalb der Wurzel nichts mehr zu unterscheiden ist.
export function breadcrumbFor(basePath, rootPath = '') {
  const root = { label: rootPath || 'All packages', path: rootPath }
  if (!basePath || basePath === rootPath) return [root]
  const rest = rootPath && basePath.startsWith(rootPath + '.') ? basePath.slice(rootPath.length + 1) : basePath
  const out = [root]
  let acc = rootPath
  for (const s of rest.split('.')) {
    acc = acc ? `${acc}.${s}` : s
    out.push({ label: s, path: acc })
  }
  return out
}
