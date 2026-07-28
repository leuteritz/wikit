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
