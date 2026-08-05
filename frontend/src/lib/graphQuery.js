// Die Abfragesprache der Code-Ansicht. REINE Funktionen (testbar) – die Verdrahtung liegt in
// CodeView (das Suchfeld, der Baum), JavaDependencyGraph (Knoten) und ManagedEdge (Kanten).
//
// Es gibt genau EINE Suche: das Feld links im Kopf der Klassenliste. Sie filtert den Baum, stellt
// den Graphen auf die Treffer samt Umgebung und markiert sie dort. Frueher war das zweierlei – ein
// Filter links und ein zweites Feld im Bild –, und beide beantworteten dieselbe Frage
// unterschiedlich: der Filter unscharf (Rang + Fuzzy), das Bild woertlich. Bei einem
// Tippfehler-Treffer zeichnete der Graph deshalb Karten, die er selbst nicht markierte.
//
// `parseGraphQuery` liest die Eingabe, `queryFiles` beantwortet sie ueber den BESTAND (Klassen und
// gespeicherte Kanten), `matchNode`/`matchEdge` beantworten sie im BILD. Der Unterschied ist keine
// Geschmacksfrage: eine Rolle (`r:`) entsteht erst im gezeichneten Ausschnitt – siehe `queryFiles`.

import { indexFilesByName, resolveClassByName, endsOf } from './packageGraph.js'

// Praefixe: ein Buchstabe + Doppelpunkt. Kurz genug, um sie zu tippen, statt sie zu suchen.
const FIELD_BY_PREFIX = {
  m: 'method',
  c: 'class',
  p: 'package',
  t: 'type',
  r: 'role',
}

// Zustands-Filter ohne Suchbegriff: beantworten eine Frage, die kein Name beantwortet.
// `cycle:` und `hotspot:` kommen aus dem Insights-Bereich – dieselbe Antwort, nur an der Stelle
// gestellt, an der man ohnehin sucht. Sie brauchen als einzige eine dritte Quelle (die gerechneten
// Kennzahlen), und ohne sie finden sie nichts; `queryFiles` sagt das ueber `needsInsights`.
const FLAGS = new Set(['review', 'manual', 'cycle', 'hotspot'])

// Ab welchem Score `hotspot:` ohne Zahl greift. Die oberen Raenge sind eine Arbeitsliste; ein
// niedrigerer Schnitt gaebe die halbe Codebasis zurueck und damit keine Auswahl.
const HOTSPOT_DEFAULT = 60

export const GRAPH_QUERY_HELP =
  'Search classes, packages and relations: type any name and the list, the graph and its highlights ' +
  'follow it. Prefixes narrow it down — m: method, c: class, p: package, t: type (interface, enum, ' +
  'data…), r: role (hub, provider, consumer — within the drawn graph). review: shows every uncertain ' +
  'edge, manual: every hand-made one. cycle: shows classes caught in a dependency loop, ' +
  'hotspot: the heaviest ones (hotspot: 80 raises the bar).'

// Die Facetten als Liste: EINE Quelle für die Chips unter dem Suchfeld und die Hilfe darüber.
export const QUERY_FACETS = [
  { prefix: 'c:', label: 'class' },
  { prefix: 'p:', label: 'package' },
  { prefix: 'm:', label: 'method' },
  { prefix: 't:', label: 'type' },
  { prefix: 'r:', label: 'role' },
  { prefix: 'review:', label: 'uncertain edges' },
  { prefix: 'manual:', label: 'hand-made edges' },
  { prefix: 'cycle:', label: 'in a cycle' },
  { prefix: 'hotspot:', label: 'heaviest classes' },
]

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

/** Passt eine KLASSE (Eintrag der Klassenliste) auf eine Namensfacette? */
function matchFile(f, q) {
  const term = q.term
  switch (q.field) {
    case 'class':
      return String(f.class_name || '').toLowerCase().includes(term)
    case 'package':
      return String(f.package || '').toLowerCase().includes(term)
    case 'type':
      return String(f.stereotype || f.class_type || '').toLowerCase().includes(term)
    default:
      return false
  }
}

// Server-Kante (`java_edges`) in die Form bringen, die `matchEdge` liest. Die gezeichnete Kante
// traegt ihre Methoden gebuendelt (`methods[]`), die gespeicherte genau eine – gemeint ist beide
// Male dasselbe, deshalb eine Uebersetzung statt einer zweiten Matcher-Fassung.
const serverEdgeData = (e) => ({
  method: e.method_name || '',
  isManual: !!e.is_manual,
  needsReview: !e.is_manual && Number(e.confidence ?? 1) < 1,
})

/**
 * Die Abfrage gegen den BESTAND beantworten (alle Klassen, alle gespeicherten Kanten) – nicht
 * gegen das Bild. `m: lookup` findet damit auch, was gerade nicht gezeichnet ist.
 *
 * @returns {{ fileIds: Set<number>|null, edges: number, scope: 'names'|'files'|'picture' }}
 *   fileIds === null      – reine NAMENSsuche: der Aufrufer nimmt seine eigene Trefferliste
 *                           (`filterClasses`, Rang + Fuzzy statt woertlich).
 *   scope === 'picture'   – nur der gezeichnete Ausschnitt kann sie beantworten (`r:`, s. u.).
 *   edges                 – wie viele gespeicherte Kanten die Abfrage trifft (Bilanz im Feld).
 */
export function queryFiles({ files = [], serverEdges = [], insights = null } = {}, q) {
  if (!q) return { fileIds: null, edges: 0, scope: 'names' }

  // ⚠️ `r:` ist die einzige Facette, die der Bestand NICHT beantworten kann: die Rolle einer Klasse
  // (hub/provider/consumer/isolated) entsteht aus den Beziehungen des gezeichneten Ausschnitts.
  // Sie global zu rechnen waere eine zweite Wahrheit neben der Karte, und den Ausschnitt danach neu
  // zu zeichnen liefe im Kreis: neu gezeichnet -> andere Rollen -> andere Treffer.
  if (q.field === 'role') return { fileIds: null, edges: 0, scope: 'picture' }

  // Kennzahlen-Facetten: die Antwort steht in der gerechneten Uebersicht, nicht im Bild und nicht
  // in den Kanten. Fehlt sie noch, ist das KEIN leeres Ergebnis, sondern ein Ladezustand –
  // `needsInsights` sagt dem Aufrufer, dass er sie holen soll (und die Leerzeile sagt es dem Leser).
  if (q.flag === 'cycle' || q.flag === 'hotspot') {
    if (!insights) return { fileIds: new Set(), edges: 0, scope: 'files', needsInsights: true }
    const term = q.term
    const fileIds = new Set()
    // `hotspot: 80` hebt die Latte, `hotspot:` allein nimmt die Voreinstellung. Eine Zahl im
    // Begriff ist die einzige Stelle, an der eine Facette eine Schwelle traegt – sie ist der
    // Unterschied zwischen „die schwersten" und „die zwanzig schwersten".
    const bar = q.flag === 'hotspot' ? (/^\d+$/.test(term) ? Number(term) : HOTSPOT_DEFAULT) : 0
    for (const c of insights.classes || []) {
      if (q.flag === 'cycle') {
        if (c.cycle == null) continue
        // Ein Begriff hinter `cycle:` grenzt weiter ein – wie bei `review:`, nur ueber den Namen
        // statt ueber die Methode (eine Klasse in einem Zyklus hat keine Methode, die ihn traegt).
        if (term && !`${c.className} ${c.package}`.toLowerCase().includes(term)) continue
      } else if (c.score < bar) continue
      fileIds.add(c.id)
    }
    return { fileIds, edges: 0, scope: 'files' }
  }

  // Kantenfacetten: die Antwort steht in den Kanten, gefragt sind die Klassen daran.
  if (q.flag || q.field === 'method') {
    const index = indexFilesByName(files)
    const resolve = (name, consumer, pkg) => resolveClassByName(index, name, consumer, pkg)
    const fileIds = new Set()
    let edges = 0
    for (const e of serverEdges) {
      if (!matchEdge(serverEdgeData(e), q)) continue
      edges++
      const { consumer, provider } = endsOf(e, resolve)
      if (consumer) fileIds.add(consumer.id)
      if (provider) fileIds.add(provider.id)
    }
    return { fileIds, edges, scope: 'files' }
  }

  if (q.field === 'class' || q.field === 'package' || q.field === 'type') {
    const fileIds = new Set()
    for (const f of files) if (matchFile(f, q)) fileIds.add(f.id)
    return { fileIds, edges: 0, scope: 'files' }
  }

  // Freier Text: die Klassen sucht der Aufrufer (unscharf, als Tippfehler-Netz), die Kanten werden
  // nur gezaehlt – sonst zoege ein Methodenname stillschweigend fremde Klassen in die Trefferliste.
  let edges = 0
  for (const e of serverEdges) if (matchEdge(serverEdgeData(e), q)) edges++
  return { fileIds: null, edges, scope: 'names' }
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
