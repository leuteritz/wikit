// Praesentations-Helfer fuer die Code-Analyse-Sektion (kein eigener Daten-Store!).
// Datenhaltung bleibt in useJavaAnalyzer (Dateien/CRUD) + useJavaQueue (KI-Queue).
// Hier nur: Package-Baum aufbauen + Klassen-Sofortsuche (Fuse). Ausbaufaehig fuer
// weitere Sprachen ueber LANGUAGES.
import Fuse from 'fuse.js'

// Sprach-Registry (aktuell nur Java; Platzhalter fuer kuenftige Parser).
export const LANGUAGES = [{ id: 'java', label: 'Java', active: true }]

const DEFAULT_PKG = '(default)'

// Baut aus der flachen Dateiliste einen verschachtelten Package-Baum (Datei-Explorer-Optik).
// Leere Zwischen-Pakete werden kompaktiert (a.b.c statt drei Ebenen), sodass Pakete mit nur
// einer Klasse nicht unnoetig tief verschachtelt erscheinen.
export function buildPackageTree(files = []) {
  const root = { children: new Map(), classes: [] }
  for (const f of files) {
    const segs = (f.package || DEFAULT_PKG).split('.')
    let node = root
    for (const seg of segs) {
      if (!node.children.has(seg)) node.children.set(seg, { children: new Map(), classes: [] })
      node = node.children.get(seg)
    }
    node.classes.push(f)
  }

  const build = (name, node, parentPath) => {
    let label = name
    let path = parentPath ? `${parentPath}.${name}` : name
    let cur = node
    // Kompaktieren: solange ein Knoten keine eigenen Klassen und genau ein Kind hat -> zusammenziehen.
    while (cur.classes.length === 0 && cur.children.size === 1) {
      const [childName, childNode] = [...cur.children.entries()][0]
      label = `${label}.${childName}`
      path = `${path}.${childName}`
      cur = childNode
    }
    const children = [...cur.children.entries()]
      .map(([n, c]) => build(n, c, path))
      .sort((a, b) => a.label.localeCompare(b.label))
    const classes = [...cur.classes].sort((a, b) => a.class_name.localeCompare(b.class_name))
    return { id: `pkg:${path}`, label, fullPath: path, children, classes }
  }

  return [...root.children.entries()]
    .map(([n, c]) => build(n, c, ''))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// Anzahl Klassen unterhalb eines Baumknotens (rekursiv) – fuer Folder-Badges.
export function countClasses(node) {
  let n = node.classes.length
  for (const c of node.children) n += countClasses(c)
  return n
}

// Fuzzy-Filter ueber Klassennamen (+ Package). Leeres Query -> unveraendert.
export function filterClasses(files = [], query = '') {
  const q = query.trim()
  if (!q) return files
  const lower = q.toLowerCase()

  // Erst woertlich, dann unscharf. Grund: Fuse allein ist bei gleichfoermigen Namen unbrauchbar –
  // in einer Codebasis mit tausend Klassen `Thing1`…`Thing999` liefert die Suche nach „Thing100"
  // mit threshold 0.4 praktisch ALLE zurueck. Wer einen Namen tippt, meint aber genau diesen.
  // Rangfolge: Klassenname beginnt damit > Klassenname enthaelt es > Package enthaelt es.
  const ranked = []
  const others = []
  for (const f of files) {
    const name = String(f.class_name || '').toLowerCase()
    const pkg = String(f.package || '').toLowerCase()
    if (name.startsWith(lower)) ranked.push({ f, rank: 0 })
    else if (name.includes(lower)) ranked.push({ f, rank: 1 })
    else if (pkg.includes(lower)) ranked.push({ f, rank: 2 })
    else others.push(f)
  }
  if (ranked.length) {
    return ranked
      .sort((a, b) => a.rank - b.rank || String(a.f.class_name).localeCompare(String(b.f.class_name)))
      .map((r) => r.f)
  }

  // Nichts passt woertlich -> unscharfe Suche als Tippfehler-Netz.
  const fuse = new Fuse(others, { keys: ['class_name', 'package'], threshold: 0.4, ignoreLocation: true })
  return fuse.search(q).map((r) => r.item)
}
