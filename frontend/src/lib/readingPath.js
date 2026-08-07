// Lesepfad: „in welcher Reihenfolge verstehe ich diesen Code?"
//
// Die übrigen Ansichten beantworten, was es gibt (`/wiki`), wie es zusammenhängt (`/code`), wie es
// darum steht (`/insights`) und was dazugehört (`/topic`). Keine davon beantwortet die erste Frage,
// die jemand vor einer fremden Codebasis hat: **wo fange ich an?**
//
// ⚠️ **Gelesen wird von unten nach oben – Fundament zuerst.** Die Kante `A → B` heißt „A benutzt
// B", also ist B das Fundament und A baut darauf auf. Der Pfad läuft deshalb GEGEN die
// Kantenrichtung: zuerst die Klassen, die nichts aus dieser Menge brauchen (Datenklassen, Typen,
// Konstanten), dann die, die auf bereits gelesenen aufbauen. Eine Klasse zu lesen, deren
// Bausteine man noch nicht kennt, ist genau die Erfahrung, die man beim Einstieg in fremden Code
// macht – und diese Reihenfolge ist ihr Gegenteil. Die Verwechslung wäre die naheliegendste
// Falschauskunft der ganzen Funktion (dieselbe Falle wie bei `impact:` in `graphPaths.js`).

import { buildGraph } from './graphPaths.js'

/** Warum eine Station an ihrer Stelle steht. Die Oberfläche macht daraus einen Satz. */
export const STATION_KIND = {
  FOUNDATION: 'foundation',
  BUILDS_ON: 'builds-on',
  CYCLE: 'cycle',
}

/**
 * Den Lesepfad durch eine Klassenmenge rechnen.
 *
 * @param {object[]} files      Klassenliste (`useJavaAnalyzer().files`) – nötig, damit `buildGraph`
 *                              die Kantennamen auf Datei-Ids auflösen kann.
 * @param {object[]} edges      Serverkanten (`useJavaGraph().edges`).
 * @param {Map}      metrics    fileId -> Insights-Kennzahl (`useInsights().byFileId`).
 * @param {number[]} scopeIds   Die Klassen, durch die der Pfad läuft.
 * @returns {{stations: object[], totals: object}}
 */
export function buildReadingPath(files, edges, metrics, scopeIds) {
  const scope = new Set(scopeIds)
  if (!scope.size) return { stations: [], totals: { classes: 0, foundations: 0, cycleBreaks: 0, depth: 0 } }

  const graph = buildGraph(files, edges)
  const nameOf = new Map(files.map((f) => [f.id, f.class_name]))
  const pkgOf = new Map(files.map((f) => [f.id, f.package || '']))

  // Nur Beziehungen INNERHALB der Menge zählen. Eine Kante nach draußen sagt nichts darüber, in
  // welcher Reihenfolge man die Klassen HIER liest – und sie als Abhängigkeit zu führen hieße, auf
  // etwas zu warten, das im Pfad nie vorkommt (der Pfad käme nie an seiner ersten Station an).
  const needs = new Map() // id -> Set(ids, die id benutzt)
  const usedBy = new Map() // id -> Set(ids, die id benutzen)
  for (const id of scope) {
    needs.set(id, new Set())
    usedBy.set(id, new Set())
  }
  for (const id of scope) {
    for (const dep of graph.out.get(id) || []) {
      if (!scope.has(dep) || dep === id) continue
      needs.get(id).add(dep)
      usedBy.get(dep).add(id)
    }
  }

  const remaining = new Set(scope)
  const open = new Map([...scope].map((id) => [id, new Set(needs.get(id))]))
  const stations = []
  let depth = 0
  let cycleBreaks = 0

  // Wichtigkeit innerhalb einer Schicht: erst was viele brauchen, dann das schwerere, dann der
  // Name. Ohne die erste Stufe stünde eine beliebige Randklasse vor der, um die sich alles dreht.
  const rank = (a, b) => {
    const ua = usedBy.get(a).size
    const ub = usedBy.get(b).size
    if (ua !== ub) return ub - ua
    const sa = metrics.get(a)?.score ?? 0
    const sb = metrics.get(b)?.score ?? 0
    if (sa !== sb) return sb - sa
    return (nameOf.get(a) || '').localeCompare(nameOf.get(b) || '')
  }

  while (remaining.size) {
    // Alles, was nichts Ungelesenes mehr braucht – eine „Schicht".
    let layer = [...remaining].filter((id) => open.get(id).size === 0)

    if (!layer.length) {
      // ⚠️ **Ein Zyklus macht den Pfad nicht unmöglich, nur den Anfang willkürlich.** Kahn bliebe
      // hier stehen; abzubrechen hieße, wegen zweier verklebter Klassen den ganzen Rest der
      // Reihenfolge zu verschweigen. Aufgebrochen wird an der Klasse mit den WENIGSTEN offenen
      // Abhängigkeiten (bei Gleichstand nach `rank`): das ist die Stelle, an der man am wenigsten
      // vorgreifen muss. Die Station wird als solche gekennzeichnet – der Leser soll wissen, dass
      // er hier auf etwas trifft, das er noch nicht gesehen hat.
      const forced = [...remaining].sort((a, b) => {
        const d = open.get(a).size - open.get(b).size
        return d !== 0 ? d : rank(a, b)
      })[0]
      layer = [forced]
      cycleBreaks++
    } else {
      depth++
    }

    const isCycleLayer = layer.length === 1 && open.get(layer[0]).size > 0
    for (const id of layer.sort(rank)) {
      const m = metrics.get(id) || {}
      const readNeeds = [...needs.get(id)]
      const unresolved = [...open.get(id)]
      stations.push({
        fileId: id,
        className: nameOf.get(id) || String(id),
        package: pkgOf.get(id) || '',
        step: stations.length + 1,
        layer: depth,
        kind: isCycleLayer
          ? STATION_KIND.CYCLE
          : readNeeds.length
            ? STATION_KIND.BUILDS_ON
            : STATION_KIND.FOUNDATION,
        // Worauf sie aufbaut (Namen, für den Satz darunter) und wer sie braucht.
        buildsOn: readNeeds.map((d) => nameOf.get(d) || String(d)).sort(),
        // Nur beim Zyklus gefüllt: was man hier noch nicht gelesen hat.
        ahead: unresolved.map((d) => nameOf.get(d) || String(d)).sort(),
        usedByCount: usedBy.get(id).size,
        score: m.score ?? null,
        driver: m.driver || null,
        inCycle: m.cycle != null,
        loc: m.loc ?? null,
      })
      remaining.delete(id)
    }
    // Erst NACH der ganzen Schicht freigeben – sonst rutschte eine Klasse, die auf eine andere
    // derselben Schicht wartet, in genau diese Schicht und die Stufen verlören ihre Bedeutung.
    for (const id of layer) {
      for (const user of usedBy.get(id) || []) open.get(user)?.delete(id)
    }
  }

  return {
    stations,
    totals: {
      classes: stations.length,
      foundations: stations.filter((s) => s.kind === STATION_KIND.FOUNDATION).length,
      cycleBreaks,
      depth,
    },
  }
}
