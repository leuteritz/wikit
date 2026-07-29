// Suche IM gezeichneten Graphen. REINE Funktionen (testbar) – die Verdrahtung liegt in
// JavaDependencyGraph (Knoten, Suchfeld) und ManagedEdge (Kanten).
//
// Bewusst etwas anderes als der Klassenfilter der linken Spalte: DER bestimmt, was ueberhaupt
// gezeichnet wird (und rechnet dafuer ein neues Layout). Diese Suche laesst das Bild unveraendert
// und beantwortet „wo ist das hier drin?" – deshalb kostet sie keinen dagre-Lauf und die Karten
// springen beim Tippen nicht.

// Praefixe: ein Buchstabe + Doppelpunkt. Kurz genug, um sie zu tippen, statt sie zu suchen.
const FIELD_BY_PREFIX = {
  m: 'method',
  c: 'class',
  p: 'package',
  t: 'type',
  r: 'role',
}

// Zustands-Filter ohne Suchbegriff: beantworten eine Frage, die kein Name beantwortet.
const FLAGS = new Set(['review', 'manual'])

export const GRAPH_QUERY_HELP =
  'Find in the drawn graph: type any name (class, package or called method). ' +
  'Prefixes narrow it down — m: method, c: class, p: package, t: type (interface, enum, data…), ' +
  'r: role (hub, provider, consumer). review: shows every uncertain edge, manual: every hand-made one.'

/**
 * Eingabe -> Abfrage oder null (leer / nur ein Praefix ohne Begriff).
 * @returns {{ field: string, term: string, flag: string|null }|null}
 */
export function parseGraphQuery(input) {
  const raw = (input || '').trim().toLowerCase()
  if (!raw) return null

  const flagged = /^([a-z]+):\s*(.*)$/.exec(raw)
  if (flagged && FLAGS.has(flagged[1])) {
    return { field: 'any', term: flagged[2].trim(), flag: flagged[1] }
  }
  const prefixed = /^([a-z]):\s*(.*)$/.exec(raw)
  if (prefixed && FIELD_BY_PREFIX[prefixed[1]]) {
    const term = prefixed[2].trim()
    // „m:" allein ist eine angefangene Eingabe, keine Suche – sonst blitzt bei jedem Praefix
    // kurz der ganze Graph als Treffer auf.
    if (!term) return null
    return { field: FIELD_BY_PREFIX[prefixed[1]], term, flag: null }
  }
  return { field: 'any', term: raw, flag: null }
}

// Methodennamen einer Kante als ein Text – eine Call-Kante traegt oft mehrere.
function edgeMethods(data) {
  const out = []
  for (const m of data?.methods || []) {
    const name = m?.method || m?.method_name
    if (name) out.push(name)
  }
  if (data?.method) out.push(data.method)
  return out.join(' ').toLowerCase()
}

/** Passt eine KARTE (Klasse oder Package-Aggregat) auf die Abfrage? */
export function matchNode(data, q) {
  if (!q || !data) return false
  // Zustands-Filter betreffen Beziehungen, nicht Klassen – sonst waere „review:" ein Bild, in dem
  // alles leuchtet ausser den Kanten, um die es geht.
  if (q.flag) return false
  const term = q.term
  if (!term) return false
  const cls = (data.className || '').toLowerCase()
  const pkg = (data.pkg || data.path || '').toLowerCase()
  switch (q.field) {
    case 'class':
      return cls.includes(term)
    case 'package':
      return pkg.includes(term)
    case 'type':
      return (data.type || '').toLowerCase().includes(term)
    case 'role':
      return (data.role || '').toLowerCase().includes(term)
    case 'method':
      return false
    default:
      return cls.includes(term) || pkg.includes(term)
  }
}

/** Passt eine KANTE auf die Abfrage? */
export function matchEdge(data, q) {
  if (!q || !data) return false
  if (q.flag === 'review') return !!data.needsReview && (!q.term || edgeMethods(data).includes(q.term))
  if (q.flag === 'manual') return !!data.isManual && (!q.term || edgeMethods(data).includes(q.term))
  const term = q.term
  if (!term) return false
  if (q.field === 'method' || q.field === 'any') return edgeMethods(data).includes(term)
  return false
}
