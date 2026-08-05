// Zwei Fragen, die ein Beziehungsgraph beantworten kann und eine Trefferliste nicht:
//
//   „Wie kommt A überhaupt an B?"        -> `findPaths`   (`path: A > B`)
//   „Wenn ich A ändere, wen trifft es?"  -> `impactSet`   (`impact: A`)
//
// Beides läuft im CLIENT. Der vollständige Kantenbestand liegt dort ohnehin (`useJavaGraph().edges`
// plus die Dateiliste), und ein BFS über einige zehntausend Kanten kostet Millisekunden – ein
// Endpunkt dafür wäre ein Roundtrip für eine Rechnung, deren Eingabe schon im Speicher steht.
//
// Gerichtet ist hier alles: `A -> B` heißt „A benutzt B". Die Wirkung einer Änderung läuft deshalb
// GEGEN die Kantenrichtung (wer B benutzt, ist betroffen) – das ist der ganze Unterschied zwischen
// den beiden Funktionen, und die Verwechslung wäre die naheliegendste Falschauskunft überhaupt.

import { indexFilesByName, resolveClassByName, endsOf } from './packageGraph.js'

// Wie viele verschiedene Wege gezeigt werden. Zwischen zwei Klassen eines dicht verdrahteten
// Systems gibt es schnell hunderte; der zwanzigste erklärt nichts mehr, was der dritte nicht schon
// gesagt hat.
export const MAX_PATHS = 6
// Ab welcher Länge ein Weg keine Erklärung mehr ist. Ein Pfad über zwölf Klassen beantwortet
// „wie hängen die zusammen?" nicht mehr mit Ja.
export const MAX_PATH_LEN = 12
// Deckel der Wirkungsmenge. Bei einer Kernklasse ist die Antwort „praktisch alles" – dann ist die
// Zahl die Auskunft, nicht die Liste (der Aufrufer schreibt den Deckel an).
export const MAX_IMPACT = 400

/**
 * Gerichteter Klassengraph aus dem gespeicherten Kantenbestand.
 *
 * Import-Kanten bleiben draußen – aus demselben Grund wie im Insights-Bereich: eine Import-Zeile
 * nennt eine Klasse, benutzt sie aber nicht, und ein Weg über einen vergessenen Import ist keiner.
 *
 * @returns {{ out: Map<number, Set<number>>, in: Map<number, Set<number>> }}
 */
export function buildGraph(files = [], serverEdges = []) {
  const index = indexFilesByName(files)
  const resolve = (name, consumer, pkg) => resolveClassByName(index, name, consumer, pkg)
  const out = new Map()
  const inn = new Map()
  const link = (map, a, b) => {
    const set = map.get(a) || new Set()
    set.add(b)
    map.set(a, set)
  }
  for (const e of serverEdges) {
    if (e.dismissed) continue
    const { consumer, provider } = endsOf(e, resolve)
    if (!consumer || !provider || consumer.id === provider.id) continue
    link(out, consumer.id, provider.id)
    link(inn, provider.id, consumer.id)
  }
  return { out, in: inn }
}

/**
 * Klasse über ihren Namen finden – so, wie man sie tippt.
 *
 * `OrderService` genügt, `shop.OrderService` und der volle FQCN gehen auch. Mehrdeutig heißt
 * mehrdeutig: der Aufrufer bekommt alle Kandidaten und sagt es, statt einen zu raten.
 *
 * @returns {{ file: object|null, candidates: object[] }}
 */
export function findClassByTerm(files = [], term = '') {
  const q = String(term || '').trim().toLowerCase()
  if (!q) return { file: null, candidates: [] }
  const fqcn = (f) => (f.package ? `${f.package}.${f.class_name}` : f.class_name).toLowerCase()

  const exactFqcn = files.filter((f) => fqcn(f) === q)
  if (exactFqcn.length) return { file: exactFqcn[0], candidates: exactFqcn }

  const exactName = files.filter((f) => String(f.class_name).toLowerCase() === q)
  if (exactName.length) return { file: exactName.length === 1 ? exactName[0] : null, candidates: exactName }

  const suffix = files.filter((f) => fqcn(f).endsWith(`.${q}`))
  if (suffix.length) return { file: suffix.length === 1 ? suffix[0] : null, candidates: suffix }

  const loose = files.filter((f) => String(f.class_name).toLowerCase().includes(q))
  return { file: loose.length === 1 ? loose[0] : null, candidates: loose.slice(0, 8) }
}

/**
 * Die kürzesten Wege von `fromId` nach `toId`, kürzeste zuerst.
 *
 * BFS über Pfade statt über Knoten: gesucht sind mehrere VERSCHIEDENE Wege, und ein
 * Knoten-BFS kennt am Ende nur einen Vorgänger je Knoten. Der Preis ist eine Warteschlange aus
 * Pfaden – gedeckelt über `MAX_PATH_LEN` und `MAX_PATHS`, und zusätzlich über einen Zähler
 * besuchter Pfade, damit ein dicht verdrahteter Ausschnitt die Oberfläche nicht anhält.
 *
 * ⚠️ Ein Knoten darf in MEHREREN Wegen vorkommen, aber nicht zweimal im selben – sonst liefe die
 * Suche im Kreis, und genau Kreise gibt es hier (s. Insights).
 *
 * @returns {number[][]} Pfade als Listen von Datei-Ids, jeweils inklusive Start und Ziel.
 */
export function findPaths(adj, fromId, toId, { maxPaths = MAX_PATHS, maxLen = MAX_PATH_LEN } = {}) {
  if (fromId == null || toId == null) return []
  if (fromId === toId) return [[fromId]]
  const found = []
  const queue = [[fromId]]
  // Wie oft ein Knoten schon auf einem gefundenen Weg lag. Ohne diese Bremse liefert ein Hub
  // dieselbe Kette mit je einem anderen Anhängsel, bis der Deckel greift – sechs Wege, die
  // dieselbe Auskunft geben.
  let steps = 0
  const STEP_LIMIT = 200000

  while (queue.length && found.length < maxPaths) {
    const path = queue.shift()
    if (++steps > STEP_LIMIT) break
    const last = path[path.length - 1]
    if (path.length > maxLen) continue
    for (const next of adj.get(last) || []) {
      if (next === toId) {
        found.push([...path, next])
        if (found.length >= maxPaths) break
        continue
      }
      if (path.includes(next)) continue
      queue.push([...path, next])
    }
  }
  return found
}

/**
 * Alles, was `id` (transitiv) benutzt – die Wirkungsmenge einer Änderung.
 *
 * Läuft über die EINGEHENDEN Kanten. Die Tiefe kommt mit: „direkt betroffen" und „über fünf Ecken
 * betroffen" sind nicht dieselbe Nachricht, und ohne die Zahl wäre die Menge nur eine große Liste.
 *
 * @returns {{ depths: Map<number, number>, truncated: boolean }}
 */
export function impactSet(radj, id, { max = MAX_IMPACT } = {}) {
  const depths = new Map()
  if (id == null) return { depths, truncated: false }
  let frontier = [id]
  let depth = 0
  let truncated = false
  while (frontier.length) {
    depth++
    const next = []
    for (const cur of frontier) {
      for (const user of radj.get(cur) || []) {
        if (user === id || depths.has(user)) continue
        if (depths.size >= max) {
          truncated = true
          continue
        }
        depths.set(user, depth)
        next.push(user)
      }
    }
    if (truncated) break
    frontier = next
  }
  return { depths, truncated }
}
