// Ein THEMA zu einer Menge von Klassen machen – reine Funktionen, die Verdrahtung liegt in
// `views/TopicView.vue`.
//
// Die globale Suche beantwortet „welches EINE Ding meine ich?": ein flacher Index, ↵ springt, jedes
// Strg+K beginnt bei null. Hier ist die Frage die umgekehrte – „was gehoert alles dazu?" –, und die
// Antwort ist eine MENGE, die man verfeinert und am Ende als EINEN Text mitnimmt. Deshalb ein
// eigener Ort und nicht ein siebter Chip in der Palette: dort haette ↵ zwei Bedeutungen bekommen.
//
// ⚠️ **Ein Thema hat vier Quellen, nicht eine.** Die naheliegende Fassung waere „Bedeutungssuche,
// fertig" – und die scheitert genau am haeufigsten Fall: ein Kuerzel. „jt" ist zwei Zeichen, die
// Bedeutungssuche verlangt drei und haette in einem Kuerzel ohnehin kein Signal; gefunden wird es
// ueber den NAMEN und ueber den Quelltext. Umgekehrt findet der Name nichts, wenn das Thema
// „order processing" heisst. Also alle vier, und jede sagt, was sie beigetragen hat:
//
//   name      – Klassenname oder Package enthaelt den Begriff        (Client, ohne Request)
//   source    – der Begriff steht im Quelltext                        (`/java/code-search`)
//   meaning   – die Klasse handelt davon, ohne das Wort zu enthalten  (`/java/semantic-search`)
//   neighbour – haengt an einer der obigen Klassen                    (Client, aus `java_edges`)
//
// ⚠️ **Der GRUND gehoert an den Treffer.** Eine Liste aus 30 Klassennamen ist bei einem Buendel
// unbrauchbar: man entscheidet ueber jede einzelne, ob sie mitkommt, und genau dafuer braucht man
// „source ×12" gegen „connected to JTConverter". Ohne den Grund waere die einzige moegliche
// Bedienung „alles nehmen" – und dann haette man den Vollexport nehmen koennen.

import { buildGraph } from './graphPaths.js'

// Deckel der Kandidatenliste. Darueber ist die Antwort auf „was gehoert dazu?" nicht mehr eine
// Liste, sondern eine Aufforderung, das Thema enger zu fassen – der Aufrufer schreibt es an.
export const MAX_CANDIDATES = 120

// Zeichen je Token, grob. Java-Quelltext liegt bei den gaengigen BPE-Tokenizern zwischen 3 und 4
// Zeichen je Token – die Zahl ist eine Groessenordnung fuer „passt das in ein Kontextfenster?",
// deshalb steht sie in der Oberflaeche auch mit einer Tilde und nicht als Tatsache.
const CHARS_PER_TOKEN = 3.5

/**
 * Die vier Herkuenfte in der Reihenfolge, in der sie beantworten, warum eine Klasse dazugehoert.
 *
 * `rank` ist zugleich die Gruppenreihenfolge in der Oberflaeche: der Name ist die staerkste
 * Aussage („heisst so"), die Nachbarschaft die schwaechste („haengt an etwas, das so heisst").
 * `preselect: false` bei den Nachbarn ist die eigentliche Festlegung – sie sind Beifang, und ein
 * Buendel, das ungefragt die halbe Codebasis mitnimmt, muesste man erst wieder leerraeumen.
 */
export const TOPIC_SOURCES = [
  {
    kind: 'name',
    rank: 0,
    label: 'Named after it',
    hint: 'the class name or its package contains the term',
    icon: 'lucide:braces',
    preselect: true,
  },
  {
    kind: 'source',
    rank: 1,
    label: 'Mentions it in code',
    hint: 'the term appears in the stored source',
    icon: 'lucide:code-2',
    preselect: true,
  },
  {
    kind: 'meaning',
    rank: 2,
    label: 'About the topic',
    hint: 'the class is about this, without containing the word',
    icon: 'lucide:sparkles',
    preselect: true,
  },
  {
    kind: 'neighbour',
    rank: 3,
    label: 'Connected to those',
    hint: 'one relation away from a class above',
    icon: 'lucide:share-2',
    preselect: false,
  },
]

const SOURCE_BY_KIND = Object.fromEntries(TOPIC_SOURCES.map((s) => [s.kind, s]))
export const topicSource = (kind) => SOURCE_BY_KIND[kind] || SOURCE_BY_KIND.neighbour

/** Grobe Tokenzahl eines Textes dieser Groesse. Immer mit `~` anzeigen – es ist eine Schaetzung. */
export const estimateTokens = (bytes) => Math.round((Number(bytes) || 0) / CHARS_PER_TOKEN)

/**
 * Namenstreffer aus der geladenen Klassenliste – ohne Request.
 *
 * Dieselbe Staffelung wie `rankClass` in der Palette, nur ohne Facetten: exakter Name vor Praefix
 * vor Teilstring vor Package. Der Rang wird zum `weight` des Grundes und sortiert damit die Gruppe.
 */
function nameHits(files, term) {
  const t = term.toLowerCase()
  const out = []
  for (const f of files) {
    const name = String(f.class_name || '').toLowerCase()
    const pkg = String(f.package || '').toLowerCase()
    let weight = -1
    let detail = ''
    if (name === t) { weight = 3; detail = 'exact name' }
    else if (name.startsWith(t)) { weight = 2; detail = 'name starts with it' }
    else if (name.includes(t)) { weight = 1; detail = 'in the name' }
    else if (pkg.includes(t)) { weight = 0; detail = 'in the package' }
    if (weight >= 0) out.push({ file: f, weight, detail })
  }
  return out
}

/**
 * Eingabe aller vier Quellen -> eine sortierte Kandidatenliste.
 *
 * ⚠️ Eine Klasse steht GENAU EINMAL in der Liste, auch wenn drei Quellen sie nennen – die anderen
 * Gruende haengen als Chips an ihr. Zweimal dieselbe Klasse in zwei Gruppen waere kein zweiter
 * Fund, sondern eine doppelte Zeile in einer Liste, aus der man auswaehlt.
 *
 * @param {object[]} files            Klassenliste aus dem Store (`useJavaAnalyzer().files`)
 * @param {object[]} edges            Kantenbestand (`useJavaGraph().edges`) – nur fuer `neighbours`
 * @param {string}   term             der eingegebene Begriff
 * @param {object[]} codeFiles        `files[]` aus `/java/code-search`
 * @param {object[]} meaningResults   `results[]` aus `/java/semantic-search`
 * @param {boolean}  withNeighbours   Nachbarn eine Kante weit mitnehmen
 * @returns {{ hits: object[], truncated: boolean, coreCount: number }}
 */
export function collectTopic({
  files = [],
  edges = [],
  term = '',
  codeFiles = [],
  meaningResults = [],
  withNeighbours = false,
} = {}) {
  const q = String(term || '').trim()
  if (!q) return { hits: [], truncated: false, coreCount: 0 }

  const byId = new Map(files.map((f) => [f.id, f]))
  /** fileId -> Kandidat. Die Map ist der Grund, warum eine Klasse nur einmal vorkommt. */
  const hits = new Map()
  const add = (file, kind, weight, detail) => {
    if (!file) return null
    const hit = hits.get(file.id) || {
      fileId: file.id,
      className: file.class_name,
      package: file.package || '',
      classType: file.stereotype || file.class_type || 'class',
      reasons: [],
    }
    // Dieselbe Quelle zweimal (z. B. zwei Nachbarschaften) verstaerkt den Grund, statt ihn zu
    // wiederholen: die Zeile soll „connected to 3 classes" sagen, nicht dreimal „connected".
    const existing = hit.reasons.find((r) => r.kind === kind)
    if (existing) {
      existing.weight = Math.max(existing.weight, weight)
      existing.count += 1
    } else {
      hit.reasons.push({ kind, weight, detail, count: 1 })
    }
    hits.set(file.id, hit)
    return hit
  }

  for (const { file, weight, detail } of nameHits(files, q)) add(file, 'name', weight, detail)

  for (const f of codeFiles) {
    const file = byId.get(f.fileId)
    if (file) add(file, 'source', f.matchCount || 1, `${f.matchCount || 1} line${f.matchCount === 1 ? '' : 's'}`)
  }

  for (const r of meaningResults) {
    const file = byId.get(r.fileId)
    if (file) add(file, 'meaning', r.score || 0, `score ${(r.score ?? 0).toFixed(2)}`)
  }

  // Die Nachbarn kommen ZULETZT und nur um die bis hierher gefundenen Klassen herum – sonst
  // saehen sie ihre eigenen Nachbarn und aus einer Kante wuerden zwei.
  const coreIds = [...hits.keys()]
  if (withNeighbours && coreIds.length) {
    const core = new Set(coreIds)
    const graph = buildGraph(files, edges)
    for (const id of coreIds) {
      const anchor = byId.get(id)
      if (!anchor) continue
      // Beide Richtungen: „wer benutzt JT?" und „was benutzt JT selbst?" gehoeren beide zum Thema,
      // und das Label sagt aus Sicht des NACHBARN, welche der beiden es ist.
      for (const [dir, map] of [['uses', graph.in], ['used by', graph.out]]) {
        for (const other of map.get(id) || []) {
          if (core.has(other)) continue
          add(byId.get(other), 'neighbour', 1, `${dir} ${anchor.class_name}`)
        }
      }
    }
  }

  // Der staerkste Grund bestimmt Gruppe und Platz; die uebrigen bleiben als Chips daran haengen.
  const list = [...hits.values()].map((hit) => {
    hit.reasons.sort((a, b) => topicSource(a.kind).rank - topicSource(b.kind).rank)
    const primary = hit.reasons[0]
    return { ...hit, primary, rank: topicSource(primary.kind).rank }
  })
  list.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.primary.weight - a.primary.weight ||
      b.primary.count - a.primary.count ||
      a.className.localeCompare(b.className),
  )

  return {
    hits: list.slice(0, MAX_CANDIDATES),
    truncated: list.length > MAX_CANDIDATES,
    coreCount: coreIds.length,
  }
}

/**
 * Die Vorauswahl: alles ausser den Nachbarn.
 *
 * Bewusst eine Funktion und kein Feld am Treffer – die Regel gehoert an EINE Stelle, sonst
 * entscheidet sie beim ersten Lauf anders als beim „reset selection" daneben.
 */
export const defaultSelection = (hits) =>
  new Set(hits.filter((h) => topicSource(h.primary.kind).preselect).map((h) => h.fileId))

/** Treffer nach ihrem staerksten Grund gruppieren – in der Reihenfolge von `TOPIC_SOURCES`. */
export function groupByReason(hits) {
  return TOPIC_SOURCES.map((src) => ({
    ...src,
    items: hits.filter((h) => h.primary.kind === src.kind),
  })).filter((g) => g.items.length)
}
