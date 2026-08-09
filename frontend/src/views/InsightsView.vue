<script setup>
// Der Insights-Bereich: was man einer Codebasis nicht ansieht.
//
// Warum eine eigene Ansicht neben `/code`: das sind zwei verschiedene Fragen. `/code` beantwortet
// „wie haengt das zusammen?" und tut es im Bild; hier steht „wie steht es darum?", und die Antwort
// ist eine RANGLISTE. Eine Rangliste in einen Graphen zu legen hiesse, sie in einen Ausschnitt zu
// legen – aber der schlimmste Brandherd ist selten der, den man gerade ansieht.
//
// Ein Reiter je Frage: Wie ist die Lage (Overview)? Was ist verklebt (Cycles)? Wo tut es weh
// (Hotspots)? Was sichert nichts ab (Tests)? Wie sind die Schichten geschnitten (Packages)? Wo
// fange ich an (Reading path)? Was fehlt (Outside)? Und was hat der letzte Import daran geändert
// (Drift)?
//
// Jede Zeile ist ein Absprung: der Bericht endet nicht bei der Erkenntnis, sondern an der Stelle,
// an der man etwas tun kann (`/code` mit der Klasse bzw. dem Package im Bild).
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useInsights } from '../composables/useInsights.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import BusyState from '../components/BusyState.vue'
import ArchRules from '../components/insights/ArchRules.vue'
import CyclePlan from '../components/insights/CyclePlan.vue'
import DriftReport from '../components/insights/DriftReport.vue'
import SplitPlan from '../components/insights/SplitPlan.vue'
import WhatIf from '../components/insights/WhatIf.vue'
import { useWhatIf } from '../composables/useWhatIf.js'
import { Icon } from '../lib/icons.js'
import { vTip } from '../lib/tooltip.js'
import { api } from '../lib/api.js'
import { buildReadingPath, STATION_KIND } from '../lib/readingPath.js'
import { copyToClipboard, BIG_CLIPBOARD_BYTES } from '../lib/clipboard.js'
import { formatBytes } from '../lib/format.js'

const router = useRouter()
const { data, loading, ensure, reload, byFileId } = useInsights()
const { lastFileId, lastPackage, files, fetchFiles } = useJavaAnalyzer()
const { edges, fetchEdges } = useJavaGraph()

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'lucide:layout-grid', hint: 'Totals and the three headline findings' },
  { id: 'cycles', label: 'Cycles', icon: 'lucide:repeat', hint: 'Dependency loops, and where to cut them' },
  { id: 'hotspots', label: 'Hotspots', icon: 'lucide:flame', hint: 'Where size, branching and coupling meet' },
  // ⚠️ Direkt hinter den Brandherden, weil es die Anschlussfrage ist: „diese Klasse kostet dich
  // Zeit" – „und fasst sie wenigstens ein Test an?".
  { id: 'tests', label: 'Tests', icon: 'lucide:flask-conical', hint: 'Which classes no test ever touches — heaviest first' },
  { id: 'packages', label: 'Packages', icon: 'lucide:package', hint: 'Abstractness against instability' },
  // Die einzige Frage hier, die nicht „was stimmt nicht?" lautet, sondern „wo fange ich an?".
  { id: 'path', label: 'Reading path', icon: 'lucide:route', hint: 'The order that lets you read this code once' },
  // Der einzige Reiter, der über den Rand des Bestands hinaussieht – „was ist NICHT hier?".
  { id: 'outside', label: 'Outside', icon: 'lucide:import', hint: 'What this workspace pulls in from elsewhere — and what is missing from it' },
  // Und der einzige, der keinen Zustand zeigt, sondern eine BEWEGUNG.
  { id: 'drift', label: 'Drift', icon: 'lucide:history', hint: 'What the last import changed — new cycles, new dependencies, growth' },
  // ⚠️ Ganz am Ende, und zwar als einziger Reiter, in dem man etwas FESTLEGT statt abzulesen. Die
  // acht davor beantworten „wie steht es?"; dieser fragt zurück „wie soll es sein?" – und das ist
  // die Frage, die man stellt, NACHDEM man die Befunde gesehen hat.
  { id: 'rules', label: 'Rules', icon: 'lucide:scale', hint: 'What you decided this code may depend on — and where it does not' },
  // ⚠️ Und der letzte beantwortet die Frage, die nach ALLEN anderen kommt: „und was bringt es?".
  // Neun Reiter sagen, wie es steht, zwei Pläne sagen, was man tun könnte – ob es sich lohnt, sagt
  // bis hierher keiner.
  { id: 'whatif', label: 'What if', icon: 'lucide:git-fork', hint: 'Try a refactoring on paper — and see what it would do to everything else' },
]

// --- Was jeder Reiter beantwortet ---------------------------------------------------------------
// ⚠️ Ohne diese Sätze ist die Ansicht ein Zahlenfeld für Leute, die Martins Metriken schon kennen.
// Sie stehen deshalb IMMER sichtbar über dem Inhalt und nicht in einem Tooltip: wer nicht weiß,
// wofür ein Reiter da ist, sucht auch keine Erklärung dazu.
//
// ⚠️ DREI Ebenen, und die erste ist die wichtigste: `title` ist die Kernaussage des Reiters in
// einem Satz und steht GROSS – wer nur diese eine Zeile liest, hat den Reiter verstanden. `what`
// erklärt sie in einem weiteren Satz, `fixes` beantwortet „und was mache ich damit?" und bleibt
// zugeklappt (beim ersten Mal die Rettung, danach im Weg).
//
// ⚠️ Geschrieben für jemanden, der Java kann, aber keine Architekturbegriffe – dieselbe Regel wie
// beim Code-Beispiel in `CyclePlan`. „Afferent coupling" erklärt nichts, „wie viel hängt daran"
// schon. Vorher stand hier ein Absatz je Reiter in Fußnotengröße: fachlich richtig, aber wer die
// Begriffe nicht kennt, liest ihn gar nicht erst zu Ende, und wer sie kennt, braucht ihn nicht.
const EXPLAIN = {
  overview: {
    title: 'The state of your code, in numbers',
    what: 'Everything here is computed from the classes you uploaded — nothing else, and nothing leaves this machine.',
    fixes: null,
  },
  cycles: {
    title: 'Classes that need each other',
    what: 'The arrows come back: A needs B, and B needs A again. Neither one can be read, tested or changed on its own.',
    fixes: [
      ['Turn one arrow around', 'Let the class being used define an interface, and have the caller depend on that instead. The dependency stays; its direction flips.'],
      ['Move the member that closes the loop', 'Usually a single method or field is the whole reason. Move it into the class that actually needs it.'],
      ['Pull the shared part out', 'If both genuinely need the same thing, it belongs in neither — give it a third class, or its own package.'],
    ],
  },
  hotspots: {
    title: 'The classes that cost you the most time',
    what: 'Long, full of decisions, and a lot hangs on them. The score is a rank: 78 means this class weighs more than 78 % of the others.',
    fixes: [
      ['Start at the top, not at the worst file', 'The top of this list is where a change is most likely to be slow, risky, or both. A big class nobody touches is not urgent.'],
      ['Fix the driver, not the score', 'The tag on each row says what makes it heavy. Splitting a long method helps a branching problem and does nothing for a coupling one.'],
      ['Check the cycle tag', 'A heavy class inside a dependency loop is the worst combination — you cannot even test it alone.'],
      ['Click a row to see how it comes apart', 'Wikit groups the methods by the fields they touch, by who calls them, and by where the branches sit — then names the parts and shows the change as before/after code.'],
    ],
  },
  tests: {
    title: 'The code no test ever touches',
    what: 'Not “how many percent are covered” — which of the classes that already cost you the most has nothing holding it in place.',
    fixes: [
      ['The top row is the one that matters', 'A heavy class with no test is where a change is most likely to break something quietly. A small one without a test rarely is.'],
      ['“Touched” is not “tested”', 'Some test runs through the class on its way somewhere else. That catches a crash, not a wrong answer — the class still has nothing checking what it returns.'],
      ['Start with the driver, not the whole class', 'The tag says what makes it heavy. A branching class needs a test per branch; a coupled one usually needs the seam pulled out first.'],
      ['A class in a cycle cannot be tested alone', 'If the row carries a cycle tag, break the loop first — until then any test has to build both classes to build one.'],
    ],
  },
  packages: {
    title: 'Is this package cut well?',
    what: 'Two things decide it: how much depends on this package, and how much of it is interfaces. Trouble sits where the two do not match.',
    fixes: [
      ['Concrete and depended upon', 'Everything hangs on it and nothing can be extended. Extract interfaces for the parts other packages use.'],
      ['Abstract and unused', 'Interfaces nobody implements or calls. Delete what is dead, or merge it back into the package that was supposed to use it.'],
      ['Cycles first', 'A package in a loop cannot be judged on these numbers at all — break the loop, then look again.'],
    ],
  },
  path: {
    title: 'Where to start reading',
    what: 'Classes that need nothing else come first, then the ones built on them. Reading a class before its parts is what makes new code hard.',
    fixes: [
      ['Start with one package, not everything', 'A path through 400 classes is the codebase again. Pick the package you actually have to work in.'],
      ['A “needs a look ahead” step is a cycle', 'It means the order had to be broken somewhere. Those classes only make sense read together — the step says which ones.'],
      ['Take it with you', 'Copy the whole path as one text and paste it into a chat, in reading order rather than alphabetical.'],
    ],
  },
  outside: {
    title: 'What this code uses but does not have',
    what: 'Read from the import lines. Some of it is a library you never need to see. Some of it is your own code that never got uploaded.',
    fixes: [
      ['Missing classes come first', 'They sit in packages you already have. Every one of them is a hole in the graph: relations that were never drawn, because the other end is not here.'],
      ['Add them the same way as the rest', 'Paste the missing sources under “Add code” in the Code view, then recompute edges — the cycles and hotspots on the other tabs change with them.'],
      ['Third-party tells you what to learn', 'The packages at the top are the APIs this code is actually written against. That is the reading list before the code itself.'],
    ],
  },
  drift: {
    title: 'What the last import changed',
    what: 'Every other tab shows how the code stands right now. This one rebuilds an earlier state from the saved sources and compares the two.',
    fixes: [
      ['A new cycle is the one thing to act on today', 'Right now it is usually a single arrow someone added. Left alone it grows until the two classes cannot be separated at all.'],
      ['Read the arrow that closed it', 'The loop is named with the exact call or field that completed it — that is the line to look at, not the whole class.'],
      ['Growth is context, not a verdict', 'A class that gained 200 lines is not automatically worse. Check whether it also gained dependencies — that is what makes it harder to change.'],
      ['Pick an older import to widen the view', 'The default compares against the state before the last upload. Choose an earlier one to see what a whole week did.'],
    ],
  },
  rules: {
    title: 'What this code is allowed to depend on',
    what: 'Every other tab measures and has to guess what you meant by it. Here you write it down once, and Wikit checks it against every relation.',
    fixes: [
      ['Start with what you already do', 'The suggestions are not advice — each one is a direction this code keeps today. Adopting it means the next import cannot reverse it unnoticed.'],
      ['Say why, not just what', 'A line starting with # becomes the reason shown next to the rule. In six months that sentence decides whether the rule still applies.'],
      ['A rule that never applies is a typo', 'If nothing matches the name, the rule is not protecting anything — it only looks like it is. That is why it gets its own state instead of a green tick.'],
      ['Layers pay off twice', 'The layer line is also what the Cycles tab uses to pick where to break a loop. Without it, that pick is a guess from a list of common package names.'],
    ],
  },
  whatif: {
    title: 'Try the change before you make it',
    what: 'Stage a refactoring here and every number on the other tabs is recomputed as if you had done it — nothing is written.',
    fixes: [
      ['A cut is never local', 'Removing one relation can open three loops and break a rule that held before. That is the whole reason this tab exists: the side effects are the part you cannot hold in your head.'],
      ['Read the cost, not just the gain', 'Minus three cycles is worth nothing if it means rewriting forty call sites. Both numbers sit in the same card on purpose.'],
      ['Take the suggestion, then argue with it', 'Every cycle and every rule violation has a “try this” button. It stages what the report already recommends — the point is to see whether the recommendation survives being measured.'],
      ['This is a question, not an edit', 'Your code, your relations and the graph stay untouched. The way back is still: change the code, upload it, and read the Drift tab.'],
    ],
  },
}
const openFixes = ref(false)

// --- Der Sandkasten ------------------------------------------------------------------------------
// ⚠️ Die Zahl am Reiter ist ein ARBEITSSTAND, kein Befund – dieselbe Art Zahl wie beim Themen-Bündel
// und ausdrücklich nicht die der Sidebar (die zählt Zyklen und Regelverstöße, also „damit stimmt
// etwas nicht"). Ein vorgemerkter Umbau ist das Gegenteil davon: das, was man dagegen vorhat.
const whatIf = useWhatIf()
// Als eigener Verweis, weil nur oberste Refs im Template entpackt werden – `whatIf.count` wäre
// dort ein Objekt und die Zahl daneben stünde als „[object Object]".
const stagedCount = whatIf.count

// Was der Bericht ohnehin empfiehlt, als Eingriff formuliert. ⚠️ Auf PACKAGE-Ebene gibt es keine
// Kante, die man anfassen könnte – dort ist die Bruchstelle ein Bündel, und was man wirklich
// entfernt, ist die tragende KLASSENbeziehung darin (`links[0]`, dieselbe, die daneben schon
// namentlich dasteht). Ohne diese Übersetzung stünde im Sandkasten ein Eingriff über zwei Ordner.
function cutOf(weakest, level = 'class', op = 'remove-edge') {
  if (!weakest) return null
  if (level === 'package') {
    const link = weakest.links?.[0]
    return link ? { op, from: link.fromId, to: link.toId } : null
  }
  return { op, from: weakest.from, to: weakest.to }
}

// Erst vormerken, dann hinüberführen: ein Knopf, der beim zweiten Druck dasselbe noch einmal
// einsammelte, wäre eine Zeile mehr ohne Wirkung. Steht der Eingriff schon, ist der Knopf der Weg
// zum Ergebnis – sonst wäre das Vormerken ein Klick, auf den scheinbar nichts folgt.
function stageCut(change) {
  if (!change) return
  if (whatIf.has(change)) {
    tab.value = 'whatif'
    return
  }
  whatIf.add(change)
}

// Konkreter Vorschlag für GENAU diesen Zyklus – aus der Art der schwächsten Kante. Die drei
// allgemeinen Wege stehen oben; das hier sagt, welcher davon hier gemeint ist und mit welchen
// Namen. Ohne das bleibt „easiest cut: A → B" eine Feststellung ohne Handlung.
function cutAdvice(weakest, level = 'class') {
  if (!weakest) return ''
  const { fromLabel: a, toLabel: b, kind, count } = weakest
  // ⚠️ Auf Package-Ebene gibt es kein „Mitglied", das man verschiebt – dort ist die Kante eine
  // Bündelung vieler Klassenbeziehungen, und der Rat lautet entsprechend „such die paar Stellen".
  if (level === 'package') {
    const n = count === 1 ? 'A single relation holds' : `Only ${count} relations hold`
    return `${n} this direction. Search “p: ${b}” in the code view to find ${count === 1 ? 'it' : 'them'} — moving or inverting ${count === 1 ? 'it' : 'those'} breaks the whole loop.`
  }
  if (kind === 'uses') {
    return `${a} only needs ${b} as a type. An interface on the ${b} side — or moving that type somewhere both can see — turns this arrow around.`
  }
  if (kind === 'field') {
    return `${a} reads a field of ${b}. Hand the value in instead of reaching for it, and the dependency disappears.`
  }
  const many = count > 1 ? `${count} calls` : 'a single call'
  return `${a} makes ${many} into ${b}. Move that member to ${a}, or let ${b} hand the result over instead of being called back.`
}

// --- Der Plan zu EINEM Zyklus -------------------------------------------------------------------
// „Zwischen web und service liegt eine Kante" ist ein Befund. Gefragt ist: was ändere ich, was
// bringt es, und warum ausgerechnet hier – das beantwortet `CyclePlan` (vorher/nachher als zwei
// Fenster je Schritt). ⚠️ Der Schlüssel trägt die Ebene mit: Package- und Klassenzyklus 0 sind
// zwei verschiedene Karten, ein reiner Index klappte beide zugleich auf.
const openPlan = ref(null)
const togglePlan = (key) => (openPlan.value = openPlan.value === key ? null : key)

// Was eine Klasse schwer macht – und was man dagegen tut. Der Server nennt den Treiber, hier steht,
// was er bedeutet.
const DRIVER = {
  branching: { label: 'branching', hint: 'Many decisions in one place — split the longest method out first.' },
  size: { label: 'size', hint: 'Too much in one file — separate the responsibilities into their own classes.' },
  coupling: { label: 'coupling', hint: 'Many classes hang on it — narrow what it exposes, or split it in two.' },
  churn: { label: 'churn', hint: 'Heavy AND touched often — the most expensive combination, and the one that pays back first.' },
}
const tab = ref('overview')
// Der Erklärblock trägt das Icon des offenen Reiters – EINE Quelle (`TABS`), damit Leiste und Block
// nicht auseinanderlaufen, wenn dort einmal ein anderes Symbol steht.
const tabMeta = computed(() => TABS.find((t) => t.id === tab.value) || TABS[0])
const startedAt = ref(Date.now())

// Wie viele Zeilen eine Rangliste zeigt, bevor sie ausklappt. Zwanzig Brandherde sind eine
// Arbeitsliste; tausend sind wieder nur die Codebasis.
const TOP_N = 20
const showAllHotspots = ref(false)

// --- Der Aufteilungsvorschlag je Zeile ----------------------------------------------------------
// ⚠️ Die Zeile klappt auf, der KLASSENNAME springt weiter. Beides an denselben Klick zu hängen war
// nicht möglich – „zeig mir sie" und „wie teile ich sie?" sind zwei Absichten –, und ein zweiter
// Knopf in jeder Zeile wäre eine Spalte, die 19 von 20 Zeilen nicht brauchen. Aufgeklappt ist immer
// nur EINE Zeile: zwei Pläne übereinander sind zwei Aufsätze, gleiche Regel wie bei `openPlan`.
const openSplit = ref(null)
const toggleSplit = (id) => (openSplit.value = openSplit.value === id ? null : id)

const totals = computed(() => data.value?.totals || null)
const classes = computed(() => data.value?.classes || [])
const packages = computed(() => data.value?.packages || [])
const cycles = computed(() => data.value?.cycles || { classes: [], packages: [] })

const ranked = computed(() => [...classes.value].sort((a, b) => b.score - a.score || b.complexity - a.complexity))
const hotspots = computed(() => (showAllHotspots.value ? ranked.value : ranked.value.slice(0, TOP_N)))

// Das Package, das am weitesten von der Hauptsequenz weg liegt – die eine Zahl, die auf der
// Uebersicht fuer „Schichtung" steht. Ohne Beziehungen ist sie nicht definiert (null), und dann
// gibt es hier auch nichts zu melden.
const worstPackage = computed(() => {
  const withDistance = packages.value.filter((p) => p.distance != null)
  if (!withDistance.length) return null
  return withDistance.reduce((a, b) => (b.distance > a.distance ? b : a))
})

// Der Leerzustand hat drei GRUENDE, und sie sind nicht dasselbe. Ohne Klassen ist nichts zu
// analysieren; ohne berechnete Kanten sieht der Bericht aus wie „alles in Ordnung", obwohl nur
// niemand die Beziehungen berechnet hat; und ein laufender Nachtrag ist ein dritter Fall.
const emptyReason = computed(() => {
  if (!totals.value) return null
  if (!totals.value.classes) return 'no-classes'
  if (!totals.value.relations) return 'no-relations'
  return null
})

// --- Lesepfad -----------------------------------------------------------------------------------
// ⚠️ Gerechnet wird im CLIENT, aus Kanten und Kennzahlen, die ohnehin geladen sind – dieselbe
// Begruendung wie bei `path:`/`impact:` in `/code`: ein Endpunkt waere ein Roundtrip fuer eine
// Rechnung im Speicher. Die Kanten holt dieser Reiter beim ersten Oeffnen nach; auf der Uebersicht
// braucht sie niemand.
const pathScope = ref('') // '' = ganze Codebasis, sonst ein Package-Pfad
const pathEdgesLoaded = ref(false)
const pathLoading = ref(false)
const pathCopying = ref(false)
const pathCopied = ref(false)

async function ensurePathData() {
  if (pathEdgesLoaded.value || pathLoading.value) return
  pathLoading.value = true
  try {
    if (!files.value.length) await fetchFiles()
    if (!edges.value.length) await fetchEdges()
    pathEdgesLoaded.value = true
  } finally {
    pathLoading.value = false
  }
}

// Packages nach Klassenzahl – die Auswahl beginnt bei dem, in dem am meisten steht.
const pathPackages = computed(() =>
  [...packages.value].sort((a, b) => b.classes - a.classes || a.path.localeCompare(b.path)),
)

const pathScopeIds = computed(() => {
  const list = pathScope.value
    ? classes.value.filter((c) => (c.package || '(default)') === pathScope.value)
    : classes.value
  return list.map((c) => c.id)
})

const readingPath = computed(() => {
  if (!pathEdgesLoaded.value) return { stations: [], totals: { classes: 0, foundations: 0, cycleBreaks: 0, depth: 0 } }
  return buildReadingPath(files.value, edges.value, byFileId.value, pathScopeIds.value)
})

// Der Satz unter einer Station. ⚠️ Er nennt die ECHTEN Namen: „builds on the previous step" waere
// bei zwoelf Stationen keine Auskunft. Gedeckelt, weil eine Klasse mit dreissig Bausteinen die
// Zeile sonst zur Wand macht – der Rest wird gezaehlt.
const NAMES_SHOWN = 3
function stationWhy(s) {
  const list = (arr) => {
    const shown = arr.slice(0, NAMES_SHOWN).join(', ')
    const rest = arr.length - NAMES_SHOWN
    return rest > 0 ? `${shown} and ${rest} more` : shown
  }
  if (s.kind === STATION_KIND.CYCLE) {
    return `Read together with ${list(s.ahead)} — they depend on each other, so there is no order that puts either first.`
  }
  if (s.kind === STATION_KIND.FOUNDATION) {
    return s.usedByCount
      ? `Needs nothing else here, and ${s.usedByCount} ${s.usedByCount === 1 ? 'class builds' : 'classes build'} on it.`
      : 'Needs nothing else here — it stands on its own.'
  }
  return `Builds on ${list(s.buildsOn)}.`
}

const STATION_STYLE = {
  [STATION_KIND.FOUNDATION]: { label: 'foundation', icon: 'lucide:milestone', color: 'var(--color-success)' },
  [STATION_KIND.BUILDS_ON]: { label: 'builds on', icon: 'lucide:arrow-up-from-line', color: 'var(--color-accent)' },
  [STATION_KIND.CYCLE]: { label: 'needs a look ahead', icon: 'lucide:repeat', color: 'var(--color-warning)' },
}

// Den ganzen Pfad als EINEN Text – in Lesereihenfolge, nicht alphabetisch (`keepOrder`). Genau
// dafuer gibt es `order=given`: ohne den Schalter waere die Reihenfolge, die die ganze Aussage
// dieses Reiters ist, im Kopiertext wieder weg.
async function copyPath() {
  const ids = readingPath.value.stations.map((s) => s.fileId)
  if (!ids.length || pathCopying.value) return
  pathCopying.value = true
  pathCopied.value = false
  try {
    const res = await api.exportJavaAll(ids, pathScope.value ? `reading path · ${pathScope.value}` : 'reading path', true)
    const text = res?.text || ''
    if (!text) return
    // Oberhalb der Grenze fuehrt der Download – dieselbe Regel wie im Themen-Buendel.
    if (new Blob([text]).size > BIG_CLIPBOARD_BYTES) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `reading-path${pathScope.value ? `-${pathScope.value.replace(/\W+/g, '-')}` : ''}.txt`
      a.click()
      URL.revokeObjectURL(url)
    } else {
      await copyToClipboard(text)
    }
    pathCopied.value = true
    setTimeout(() => (pathCopied.value = false), 2000)
  } finally {
    pathCopying.value = false
  }
}

// --- Outside ------------------------------------------------------------------------------------
// ⚠️ Der einzige Reiter, der ueber den Rand des Bestands hinaussieht – und deshalb der einzige, der
// auf den IMPORTS rechnet statt auf den Kanten (Begruendung im Service). Nichts nachzuladen: die
// Antwort faehrt in derselben `/api/insights`-Antwort mit.
const outside = computed(() => data.value?.outside || null)

// Die drei Herkuenfte in der Reihenfolge, in der sie interessieren: erst was FEHLT (eine Aufgabe),
// dann was fremd ist (eine Leseliste), dann die Plattform. Letztere steht nicht aus Vollstaendigkeit
// da, sondern weil die Zahl oben sonst unerklaerlich waere: „340 types from outside" liest sich
// erschreckend, solange nicht danebensteht, dass 200 davon `java.util` sind.
const OUTSIDE_GROUPS = [
  {
    id: 'gap',
    label: 'Missing from this workspace',
    icon: 'lucide:puzzle',
    color: 'var(--color-warning)',
    hint: 'Their package is already here, the class itself never was. Each one is a relation the graph could not draw — the arrow simply ends.',
  },
  {
    id: 'library',
    label: 'Third-party',
    icon: 'lucide:boxes',
    color: 'var(--color-accent)',
    hint: 'Code from somewhere else entirely. Nothing to fix here — this is what you have to know to read the rest.',
  },
  {
    id: 'platform',
    label: 'Java platform',
    icon: 'lucide:coffee',
    color: 'var(--color-text-muted)',
    hint: 'The JDK and its neighbours. Counted so the totals add up, never a gap.',
  },
]

// Aufgeklappt ist immer nur EIN Package – der aufgeklappte Inhalt sind bis zu zwölf Typen mit ihren
// Nutzern, und zwei davon nebeneinander sind wieder eine Wand. Gleiche Regel wie bei `openPlan`,
// und der Schlüssel trägt aus demselben Grund die Gruppe mit.
const openOutside = ref(null)
const toggleOutside = (key) => (openOutside.value = openOutside.value === key ? null : key)

// Balkenbreite relativ zum meistbenutzten Package DERSELBEN Gruppe. Über alle Gruppen hinweg zu
// skalieren wäre die falsche Frage: `java.util` steht in jeder Codebasis ganz oben und drückte
// damit die Lücken – um die es hier geht – auf Nullbreite.
function outsideBar(groupId, usedBy) {
  const list = outside.value?.groups?.[groupId] || []
  const max = list.length ? list[0].usedBy : 0
  return max ? Math.max(4, Math.round((usedBy / max) * 100)) : 0
}

// ⚠️ Ein leerer Reiter hat hier ZWEI Gründe, und sie bedeuten das Gegenteil voneinander: gar keine
// gespeicherten Importzeilen (Altbestand – die Liste ist dann keine Aussage) gegen „alles, was
// dieser Code nennt, liegt auch hier" (das beste denkbare Ergebnis).
const outsideEmpty = computed(() => {
  const t = outside.value?.totals
  if (!t) return null
  if (!t.types && !t.internal && !t.wildcards) return 'no-imports'
  return t.types ? null : 'self-contained'
})
const outsideKpis = computed(() => {
  const t = outside.value?.totals
  if (!t) return []
  return [
    { label: 'Missing classes', value: num(t.gap.types), icon: 'lucide:puzzle', warn: t.gap.types > 0 },
    { label: 'Third-party types', value: num(t.library.types), icon: 'lucide:boxes' },
    { label: 'Platform types', value: num(t.platform.types), icon: 'lucide:coffee' },
    { label: 'Wildcard imports', value: num(t.wildcards), icon: 'lucide:asterisk' },
  ]
})

// --- Tests ---------------------------------------------------------------------------------------
// Der Testschatten faehrt in derselben `/api/insights`-Antwort mit – gerechnet wird er im Backend,
// weil er die Importzeilen braucht (dort wird die Tabelle ohnehin fuer „Outside" gelesen) und weil
// die Rangfolge auf dem Hotspot-Score beruht, der dort entsteht.
const tests = computed(() => data.value?.tests || null)

// Die drei Stufen der Abdeckung als Wort, nicht als Zahl – und mit ihrer Farbe. „touched" ist
// bewusst keine Warnfarbe: es ist die mittlere Stufe und keine Verfehlung.
const COVERAGE = {
  tested: { label: 'tested', icon: 'lucide:flask-conical', color: 'var(--color-success)' },
  touched: { label: 'only touched', icon: 'lucide:git-branch', color: 'var(--color-warning)' },
  none: { label: 'no test', icon: 'lucide:flask-conical-off', color: 'var(--color-danger)' },
}

// ⚠️ DREI Leerzustaende, und nur der letzte ist ein gutes Ergebnis:
//
//   * `no-tests` – hier liegt kein Testcode. Das ist eine Aussage ueber den BESTAND, nicht ueber
//     das Projekt: wer nur seinen Produktivcode hochlaedt, bekaeme sonst seine gesamte Codebasis
//     als Mangelliste zurueck. Deshalb steht an dieser Stelle keine Rangliste und keine Prozentzahl.
//   * `no-imports` – es gibt Klassen, aber keine gespeicherten Importzeilen (Altbestand). Dann
//     beruht die Erkennung allein auf Namen, und das muss dabeistehen.
//   * `all-covered` – jede Produktivklasse hat einen Test, der sie beim Namen nennt.
const testsEmpty = computed(() => {
  const t = tests.value?.totals
  if (!t) return null
  if (!t.tests) return t.importLines ? 'no-tests' : 'no-imports'
  return tests.value.shadow.length ? null : 'all-covered'
})

const testKpis = computed(() => {
  const t = tests.value?.totals
  if (!t) return []
  return [
    // ⚠️ Die fuehrende Zahl ist die GEWICHTETE. „62 % der Klassen" behandelt eine
    // Konstantenklasse wie den Brandherd daneben – und genau damit laesst sich die Zahl
    // schoenrechnen. Ohne Kanten ist sie nicht definiert und steht als „–" da, nicht als 0 %.
    {
      label: 'Weight covered',
      value: t.risk.pct == null ? '–' : `${t.risk.pct}%`,
      icon: 'lucide:shield',
      warn: t.risk.pct != null && t.risk.pct < 50,
      tip: 'Share of the total hotspot weight that sits in classes a test names directly — not the share of classes.',
    },
    { label: 'No test at all', value: num(t.uncovered), icon: 'lucide:flask-conical-off', warn: t.uncovered > 0, tip: 'Not one test class names them, and none reaches them over a relation.' },
    { label: 'Only touched', value: num(t.touched), icon: 'lucide:git-branch', tip: 'A test runs through them on its way somewhere else — that catches a crash, not a wrong result.' },
    { label: 'Test classes', value: num(t.tests), icon: 'lucide:flask-conical', tip: `${t.byImport} recognised by their imports, ${t.byName} by their name alone.` },
  ]
})

// Die Gegenliste bleibt zugeklappt: „was fehlt?" ist die Frage, mit der man den Reiter oeffnet.
const showTestList = ref(false)

// --- Drift ---------------------------------------------------------------------------------------
//
// Eigener Request und erst beim ersten Öffnen: der Lauf rechnet einen ZWEITEN Graphen aus alten
// Quelltexten – wer nur die Kennzahlen aufschlägt, soll ihn nicht bezahlen. Gleiche Begründung wie
// beim Aufteilungsvorschlag, nur eine Ebene höher.
const drift = ref(null)
const driftLoading = ref(false)
const driftSince = ref('')

async function loadDrift(since = '') {
  driftLoading.value = true
  try {
    drift.value = await api.getDrift(since)
    // Der Server entscheidet den Bezugspunkt, wenn keiner (oder ein unbekannter) mitkam – die
    // Auswahl muss danach zeigen, was WIRKLICH verglichen wurde, nicht was gewünscht war.
    driftSince.value = drift.value?.since || ''
  } finally {
    driftLoading.value = false
  }
}
const ensureDrift = () => (drift.value ? Promise.resolve(drift.value) : loadDrift())

// --- Architektur-Regeln ---------------------------------------------------------------------------
//
// ⚠️ Eigener Request, obwohl `data.rules` denselben Befund trägt – und der Grund steht im Editor:
// nach dem Speichern will man die Wirkung der geänderten Zeile SOFORT sehen, und dafür den ganzen
// Bericht neu zu rechnen wäre ein Lauf über alles für zwei getippte Zeichen. Der Erststand kommt
// deshalb aus der Übersicht (sie liegt bereits vor), jeder weitere aus dem eigenen Endpunkt.
const archRules = ref(null)
const archLoading = ref(false)
const archSaving = ref(false)

async function loadRules() {
  archLoading.value = true
  try {
    archRules.value = await api.getArchRules()
  } finally {
    archLoading.value = false
  }
}
// Der Bericht trägt die Regeln bereits mit – ihn beim Öffnen des Reiters zu wiederholen wäre ein
// Request für eine Antwort, die schon dasteht. Fehlt er (noch), holt der Reiter selbst.
const ensureRules = () => {
  if (archRules.value) return Promise.resolve(archRules.value)
  const fromReport = data.value?.rules
  if (fromReport) {
    archRules.value = { ...fromReport, unresolved: totals.value?.unresolved || 0 }
    return Promise.resolve(archRules.value)
  }
  return loadRules()
}

/**
 * Speichern – und danach den GANZEN Bericht nachziehen.
 *
 * ⚠️ Das ist keine Vorsicht, sondern nötig: eine `layers`-Zeile entscheidet mit, welche Kante die
 * Zyklen-Bruchstelle vorschlägt, und die Zahl neben „Insights" in der Sidebar zählt die Verstöße
 * mit. Nur den Reiter zu aktualisieren hiesse, zwei Ansichten desselben Standes auseinanderlaufen
 * zu lassen – genau das, was der geteilte Store sonst verhindert.
 */
async function saveRules(text) {
  archSaving.value = true
  try {
    archRules.value = await api.saveArchRules(text)
    await reload()
  } finally {
    archSaving.value = false
  }
}

// Kanten, Drift bzw. Regeln erst holen, wenn der Reiter zum ersten Mal offen ist.
watch(tab, (t) => {
  if (t === 'path') ensurePathData()
  if (t === 'drift') ensureDrift()
  if (t === 'rules') ensureRules()
})

onMounted(() => ensure())

function refresh() {
  startedAt.value = Date.now()
  reload()
}

// --- Absprung nach /code ------------------------------------------------------------------------
// Derselbe Hand-off, den die globale Suche benutzt: Ziel setzen, Route wechseln. Ohne mitgegebene
// Suche schlaegt CodeView das Ego der Klasse auf – genau die Antwort auf „zeig mir sie".
function openClass(id) {
  lastFileId.value = id
  router.push('/code')
}
function openPackage(path) {
  lastPackage.value = path
  router.push('/code')
}

// --- Darstellung --------------------------------------------------------------------------------

// Der Score faerbt sich, aber er faerbt sich nicht linear: die oberen zwanzig Prozent sind die
// Arbeitsliste, alles darunter ist Grundrauschen und soll auch so aussehen.
function scoreColor(score) {
  if (score >= 75) return 'var(--color-danger)'
  if (score >= 50) return 'var(--color-warning)'
  return 'var(--color-text-muted)'
}

// Instabilitaet als Wort statt als Zahl – „0.83" beantwortet die Frage nicht, „depends on others"
// schon. Die Zahl steht daneben, für alle, die sie lesen wollen.
function instabilityLabel(i) {
  if (i == null) return 'no relations'
  if (i >= 0.8) return 'depends outward'
  if (i <= 0.2) return 'depended upon'
  return 'balanced'
}

// Auf WELCHER Seite der Hauptsequenz ein Package liegt, entscheidet die Summe – nicht eine
// Schwelle je Achse. `A + I < 1` heisst konkret UND vielbenutzt (starr, "zone of pain"),
// `A + I > 1` abstrakt UND ungenutzt. Zwei getrennte Schwellen liessen genau die Faelle
// dazwischen in die falsche Diagnose fallen (gemessen: ein Package mit I = 0.33 wurde als
// „abstract and barely used" gemeldet, obwohl es das Gegenteil ist).
function offBalanceLabel(p) {
  return p.abstractness + p.instability < 1 ? 'concrete and hard to change' : 'abstract and barely used'
}

// Was an DIESEM Package zu tun ist. Dieselbe Unterscheidung wie bei `offBalanceLabel` – nur als
// Handlung statt als Diagnose, und nur dort gezeigt, wo die Abweichung wirklich groß ist.
function packageAdvice(p) {
  if (p.cycle != null) return 'In a cycle — break that first, these numbers cannot be judged until then.'
  return p.abstractness + p.instability < 1
    ? 'Everything hangs on it and it is all concrete — extract interfaces for what other packages use.'
    : 'Abstract, but barely used — delete what is dead, or merge it back where it was meant to be used.'
}

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`
const num = (n) => (n ?? 0).toLocaleString('en-US')
// Zahl mit ihrem Wort. „1 types" ist die Sorte Fehler, die eine sonst sorgfältige Ansicht billig
// aussehen lässt – und sie tritt genau dort auf, wo eine Gruppe auf einen einzigen Fund
// zusammengeschrumpft ist, also im interessantesten Fall.
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`

// --- A/I-Diagramm -------------------------------------------------------------------------------
// Punkt = Package. x = Instabilitaet (0 links: alle haengen an ihm), y = Abstraktheit (1 oben).
// Die Hauptsequenz ist die Diagonale von oben links nach unten rechts: dort ist ein Package
// entweder abstrakt UND vielbenutzt oder konkret UND von niemandem benutzt – beides ist gesund.
// Die beiden Ecken daneben sind die Diagnosen, und genau deshalb steht das als Bild und nicht als
// Spalte in einer Tabelle: „weit weg von der Diagonale" sieht man, 0.67 muss man deuten.
const PLOT = 100
// Wie weit deckungsgleiche Punkte auseinandergerueckt werden. 2,2 von 100 liegt unter der
// Ablesegenauigkeit der Achse und ueber dem Punktradius – die Position bleibt richtig, die
// Haeufung wird sichtbar.
const SPREAD = 2.2

const plotted = computed(() => {
  const base = packages.value
    .filter((p) => p.instability != null)
    .map((p) => ({
      ...p,
      x: p.instability * PLOT,
      y: (1 - p.abstractness) * PLOT,
      // Flaeche proportional zur Klassenzahl, Radius also ueber die Wurzel – sonst wirkt ein
      // Package mit viermal so vielen Klassen sechzehnmal so schwer.
      r: 1.6 + Math.sqrt(p.classes) * 0.9,
    }))

  // ⚠️ Zwei Packages mit denselben Kennzahlen liegen auf DEMSELBEN Punkt – und dann sieht man
  // einen statt zweier. Das ist kein Randfall: A = 0 gilt fuer jedes Package ohne eine einzige
  // Schnittstelle, und I nimmt bei kleinen Packages nur wenige Werte an (0, ⅓, ½, 1). Gemessen
  // an der Demo-Codebasis: 2 von 5 Punkten deckungsgleich.
  //
  // Sie werden deshalb kreisfoermig um ihren gemeinsamen Ort verteilt – nicht zufaellig, sondern
  // nach Reihenfolge, damit dasselbe Bild bei jedem Laden dasselbe ist. Der echte Ort bleibt die
  // Mitte des Rings; die Zahlen daneben stehen ohnehin in der Tabelle.
  const groups = new Map()
  for (const p of base) {
    const key = `${Math.round(p.x)}|${Math.round(p.y)}`
    const list = groups.get(key) || []
    list.push(p)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.forEach((p, i) => {
      const angle = (i / list.length) * Math.PI * 2
      p.x += Math.cos(angle) * SPREAD
      p.y += Math.sin(angle) * SPREAD
      p.stacked = list.length
    })
  }
  return base
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- ======================= Kopfzeile ======================= -->
    <header
      class="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-5 py-3 backdrop-blur"
    >
      <div class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon icon="lucide:activity" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h1 class="font-mono text-base font-semibold tracking-tight text-[var(--color-text)]">Insights</h1>
          <p class="truncate text-2xs text-[var(--color-text-muted)]">
            <template v-if="totals">
              {{ num(totals.classes) }} classes · {{ num(totals.packages) }} packages ·
              {{ num(totals.relations) }} relations
            </template>
            <template v-else>What the codebase does not tell you by reading it</template>
          </p>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <button
            v-tip="'Recompute every metric from the current data'"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-40"
            :disabled="loading"
            @click="refresh"
          >
            <Icon :icon="loading ? 'lucide:loader-2' : 'lucide:refresh-cw'" class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
            Refresh
          </button>
        </div>
      </div>

      <nav class="mx-auto mt-3 flex w-full max-w-6xl flex-wrap gap-1">
        <button
          v-for="t in TABS"
          :key="t.id"
          v-tip="t.hint"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition"
          :class="tab === t.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : 'border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)]'"
          @click="tab = t.id"
        >
          <Icon :icon="t.icon" class="h-3.5 w-3.5" />
          {{ t.label }}
          <span
            v-if="t.id === 'cycles' && totals && (totals.classCycles || totals.packageCycles)"
            class="rounded bg-[var(--color-danger)]/15 px-1 font-mono text-3xs text-[var(--color-danger)]"
          >
            {{ totals.classCycles + totals.packageCycles }}
          </span>
          <!-- ⚠️ Ein ARBEITSSTAND, kein Befund – deshalb die neutrale Akzentfarbe und keine
               Warnfarbe: „drei Eingriffe vorgemerkt" ist nichts, was schiefsteht. Und deshalb
               fehlt die Zahl bei leerer Liste ganz (gleiche Regel wie die Topic-Zahl in der
               Sidebar): eine „0" wäre die Behauptung, hier fehle etwas. -->
          <span
            v-else-if="t.id === 'whatif' && stagedCount"
            class="rounded bg-[var(--color-accent-soft)] px-1 font-mono text-3xs text-[var(--color-accent)]"
          >
            {{ stagedCount }}
          </span>
        </button>
      </nav>
    </header>

    <!-- ======================= Inhalt ======================= -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div class="mx-auto w-full max-w-6xl">
        <BusyState
          v-if="!data"
          variant="panel"
          title="Reading the dependency graph…"
          reason="Resolving relations, tracing cycles and ranking classes."
          :since="startedAt"
        />

        <template v-else>
          <!-- Ein leerer Bericht braucht seinen GRUND: ohne ihn liest er sich wie ein guter Befund. -->
          <div
            v-if="emptyReason"
            class="mb-5 flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3"
          >
            <Icon icon="lucide:alert-triangle" class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
            <div class="min-w-0 text-xs text-[var(--color-text)]">
              <p v-if="emptyReason === 'no-classes'" class="font-medium">No classes analysed yet.</p>
              <p v-else class="font-medium">No relations computed yet.</p>
              <p class="mt-0.5 text-[var(--color-text-muted)]">
                <template v-if="emptyReason === 'no-classes'">
                  Add Java code in the Code view — every number here is derived from it.
                </template>
                <template v-else>
                  Size and branching are shown below, but cycles, coupling and instability need the
                  class relations. Run “Recompute edges” in the Code view.
                </template>
              </p>
            </div>
          </div>

          <!-- ⚠️ Wofür der Reiter da ist – IMMER sichtbar, nicht im Tooltip: wer nicht weiß, was er
               sieht, sucht auch keine Erklärung dazu. Die Kernaussage steht GROSS und trägt das
               Icon des Reiters: dieselbe Marke wie in der Leiste darüber, also ist ohne ein Wort
               klar, wozu der Satz gehört. Die Handlungsanleitung bleibt zugeklappt – beim ersten
               Mal die Rettung, danach im Weg. -->
          <div class="mb-5 flex items-start gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4">
            <span class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Icon :icon="tabMeta.icon" class="h-5 w-5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-xl font-semibold leading-snug tracking-tight text-[var(--color-text)]">
                {{ EXPLAIN[tab].title }}
              </h2>
              <p class="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--color-text-muted)]">
                {{ EXPLAIN[tab].what }}
              </p>
              <template v-if="EXPLAIN[tab].fixes">
                <button
                  type="button"
                  class="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] transition hover:underline"
                  @click="openFixes = !openFixes"
                >
                  <Icon :icon="openFixes ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3.5 w-3.5" />
                  What do I do with this?
                </button>
                <ul v-if="openFixes" class="mt-2.5 space-y-2 border-l-2 border-[var(--color-border)] pl-3.5">
                  <li v-for="([title, body]) in EXPLAIN[tab].fixes" :key="title" class="max-w-3xl text-xs leading-relaxed">
                    <span class="font-semibold text-[var(--color-text)]">{{ title }}</span>
                    <span class="text-[var(--color-text-muted)]"> — {{ body }}</span>
                  </li>
                </ul>
              </template>
            </div>
          </div>

          <!-- Ein Deckel wird ANGESCHRIEBEN: eine still weggelassene Kante liest sich wie keine.
               ⚠️ Aber nur EINMAL und UNTER der Erklärung, nicht über jedem Reiter. Der Satz sagt,
               woher die Zahlen kommen – das ist eine Aussage über den Bericht als Ganzes; über
               „Cycles" oder „Packages" gestellt las er sich wie ein Befund DIESES Reiters, und er
               stand vor dem Satz, der überhaupt erst sagt, was man da sieht. -->
          <div
            v-if="tab === 'overview' && (totals.unresolved || totals.pending)"
            class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-2xs text-[var(--color-text-muted)]"
          >
            <span v-if="totals.unresolved" class="inline-flex items-center gap-1.5">
              <Icon icon="lucide:unlink" class="h-3.5 w-3.5" />
              {{ num(totals.unresolved) }} relations skipped — their class could not be identified
              (two classes share a name, and the edge predates package-aware storage).
            </span>
            <span v-if="totals.pending" class="inline-flex items-center gap-1.5">
              <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
              {{ num(totals.pending) }} classes still being measured — refresh in a moment.
            </span>
          </div>

          <!-- ==================== Overview ==================== -->
          <section v-if="tab === 'overview'" class="space-y-5">
            <!-- ⚠️ Der einzige Befund, der es VOR die Bilanz schafft – und nur, wenn es ihn gibt.
                 Ein Regelverstoß ist der stärkste Befund dieses Berichts: alles andere hat Wikit
                 selbst für auffällig befunden, dies hier hat der Betreiber ausdrücklich verboten.
                 Ein Balken, der nur bei Befund erscheint, kann auch nicht abstumpfen. -->
            <button
              v-if="data?.rules?.totals?.violations"
              type="button"
              class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-2.5 text-left transition hover:border-[var(--color-danger)]"
              @click="tab = 'rules'"
            >
              <Icon icon="lucide:scale" class="h-4 w-4 shrink-0 text-[var(--color-danger)]" />
              <span class="text-sm text-[var(--color-text)]">
                <span class="font-mono font-semibold text-[var(--color-danger)]">{{ num(data.rules.totals.violations) }}</span>
                {{ data.rules.totals.violations === 1 ? 'relation breaks' : 'relations break' }}
                a rule you wrote down.
              </span>
              <span class="text-2xs text-[var(--color-text-muted)]">
                Every other finding here is Wikit's opinion — this one is yours. →
              </span>
            </button>

            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div
                v-for="k in [
                  { label: 'Classes', value: num(totals.classes), icon: 'lucide:box' },
                  { label: 'Packages', value: num(totals.packages), icon: 'lucide:package' },
                  { label: 'Relations', value: num(totals.relations), icon: 'lucide:share-2' },
                  { label: 'Code lines', value: num(totals.loc), icon: 'lucide:code-2' },
                  { label: 'Branches', value: num(totals.complexity), icon: 'lucide:git-fork' },
                  { label: 'Cycles', value: num(totals.classCycles + totals.packageCycles), icon: 'lucide:repeat' },
                ]"
                :key="k.label"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5"
              >
                <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon :icon="k.icon" class="h-3 w-3" />
                  {{ k.label }}
                </p>
                <p class="mt-1 font-mono text-lg font-semibold text-[var(--color-text)]">{{ k.value }}</p>
              </div>
            </div>

            <div class="grid gap-3 lg:grid-cols-3">
              <!-- Zyklen -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'cycles'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:repeat" class="h-3.5 w-3.5" /> Tangles
                </p>
                <p v-if="totals.packageCycles || totals.classCycles" class="mt-2 text-sm text-[var(--color-text)]">
                  <span class="font-mono text-xl font-semibold text-[var(--color-danger)]">{{ totals.packageCycles }}</span>
                  package {{ totals.packageCycles === 1 ? 'cycle' : 'cycles' }},
                  <span class="font-mono font-semibold">{{ totals.classCycles }}</span> between classes.
                </p>
                <p v-else class="mt-2 text-sm text-[var(--color-text)]">
                  No dependency loops — every relation points one way.
                </p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  <template v-if="totals.packageCycles || totals.classCycles">
                    Each one names the easiest place to cut it. →
                  </template>
                  <template v-else>Nothing to untangle here.</template>
                </p>
              </button>

              <!-- Brandherd -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'hotspots'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:flame" class="h-3.5 w-3.5" /> Hottest class
                </p>
                <p v-if="ranked[0]" class="mt-2 truncate font-mono text-sm font-semibold text-[var(--color-text)]">
                  {{ ranked[0].className }}
                </p>
                <p v-if="ranked[0]" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  {{ num(ranked[0].loc) }} code lines · {{ num(ranked[0].complexity) }} branches ·
                  {{ ranked[0].fanIn + ranked[0].fanOut }} neighbours
                </p>
                <p v-if="ranked[0] && DRIVER[ranked[0].driver]" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  {{ DRIVER[ranked[0].driver].hint }}
                </p>
              </button>

              <!-- Hauptsequenz -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'packages'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:target" class="h-3.5 w-3.5" /> Furthest off balance
                </p>
                <template v-if="worstPackage">
                  <p class="mt-2 truncate font-mono text-sm font-semibold text-[var(--color-text)]">
                    {{ worstPackage.path }}
                  </p>
                  <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                    {{ offBalanceLabel(worstPackage) }} ({{ pct(worstPackage.distance) }} off balance).
                  </p>
                  <p class="mt-1 text-2xs text-[var(--color-text-muted)]">{{ packageAdvice(worstPackage) }}</p>
                </template>
                <p v-else class="mt-2 text-2xs text-[var(--color-text-muted)]">
                  Needs relations between packages.
                </p>
              </button>
            </div>

            <!-- Die Uebersicht endet nicht bei der Bilanz: „wo fange ich an?" ist die Frage, mit
                 der man herkommt, und fuenf Zeilen beantworten sie, ohne einen Reiter zu wechseln. -->
            <div v-if="ranked.length">
              <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                <Icon icon="lucide:flame" class="h-3.5 w-3.5" /> Where to start
              </h2>
              <ul class="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <li v-for="c in ranked.slice(0, 5)" :key="c.id">
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--color-surface-offset)]"
                    @click="openClass(c.id)"
                  >
                    <span class="w-6 shrink-0 text-right font-mono text-2xs" :style="{ color: scoreColor(c.score) }">
                      {{ c.score }}
                    </span>
                    <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                      <span class="block h-full rounded-full" :style="{ width: `${c.score}%`, background: scoreColor(c.score) }" />
                    </span>
                    <span class="min-w-0 flex-1 truncate">
                      <span class="font-mono text-xs text-[var(--color-text)]">{{ c.className }}</span>
                      <span class="ml-1.5 text-2xs text-[var(--color-text-muted)]">{{ c.package }}</span>
                    </span>
                    <span class="shrink-0 font-mono text-2xs text-[var(--color-text-muted)]">
                      {{ num(c.loc) }} lines · {{ num(c.complexity) }} branches · {{ c.fanIn + c.fanOut }} neighbours
                    </span>
                    <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  </button>
                </li>
              </ul>
            </div>
          </section>

          <!-- ==================== Cycles ==================== -->
          <section v-else-if="tab === 'cycles'" class="space-y-6">
            <div v-if="!cycles.packages.length && !cycles.classes.length" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center">
              <Icon icon="lucide:check-circle" class="mx-auto h-6 w-6 text-[var(--color-success)]" />
              <p class="mt-2 text-sm text-[var(--color-text)]">No cycles found.</p>
              <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                Every dependency points one way — packages and classes can be read in isolation.
              </p>
            </div>

            <template v-else>
              <!-- Package-Zyklen zuerst: sie treffen die Architektur, nicht eine Datei. -->
              <div v-if="cycles.packages.length">
                <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:package" class="h-3.5 w-3.5" />
                  Package cycles
                  <span class="font-mono normal-case">({{ cycles.packages.length }})</span>
                </h2>
                <div class="space-y-2">
                  <article
                    v-for="(c, i) in cycles.packages"
                    :key="`p${i}`"
                    class="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-surface-2)] p-3"
                  >
                    <div class="flex flex-wrap items-center gap-1.5">
                      <template v-for="(p, k) in c.chainLabels" :key="k">
                        <button
                          type="button"
                          class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          @click="openPackage(p)"
                        >
                          {{ p }}
                        </button>
                        <Icon v-if="k < c.chainLabels.length - 1" icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                      </template>
                    </div>
                    <!-- Nicht nur WO man schneidet, sondern WIE: „easiest cut: A → B" allein ist
                         eine Feststellung, keine Handlung. -->
                    <div v-if="c.weakest" class="mt-2 flex items-start gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                      <span class="min-w-0">
                        <span class="font-medium text-[var(--color-text)]">Easiest cut</span> —
                        <span class="font-mono">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                        <span class="opacity-70"> ({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                        <br />{{ cutAdvice(c.weakest, 'package') }}
                        <!-- ⚠️ Vorgemerkt wird die tragende KLASSENbeziehung, nicht die
                             Package-Kante: die gibt es im Code nicht, man kann sie also auch nicht
                             entfernen. Steht keine namentlich dabei, entfällt der Knopf – ein
                             Vorschlag ohne Adresse wäre einer, den der Sandkasten nicht ausführen
                             kann. -->
                        <span v-if="cutOf(c.weakest, 'package')" class="mt-1.5 flex">
                          <button
                            v-tip="'Stage removing the class relation that carries this direction'"
                            type="button"
                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-3xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                            :class="whatIf.has(cutOf(c.weakest, 'package')) ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''"
                            @click="stageCut(cutOf(c.weakest, 'package'))"
                          >
                            <Icon :icon="whatIf.has(cutOf(c.weakest, 'package')) ? 'lucide:check' : 'lucide:git-fork'" class="h-3 w-3" />
                            {{ whatIf.has(cutOf(c.weakest, 'package'))
                              ? 'Staged — open'
                              : `Try cutting ${c.weakest.links[0].from} → ${c.weakest.links[0].to}` }}
                          </button>
                        </span>
                      </span>
                    </div>
                    <p v-if="c.size > c.chainLabels.length - 1" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                      Part of a group of {{ c.size }} packages that all reach each other.
                    </p>

                    <CyclePlan
                      :cycle="c"
                      level="package"
                      :open="openPlan === `p${i}`"
                      @toggle="togglePlan(`p${i}`)"
                      @open-class="openClass"
                    />
                  </article>
                </div>
              </div>

              <div v-if="cycles.classes.length">
                <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:box" class="h-3.5 w-3.5" />
                  Class cycles
                  <span class="font-mono normal-case">({{ cycles.classes.length }})</span>
                </h2>
                <div class="space-y-2">
                  <article
                    v-for="(c, i) in cycles.classes"
                    :key="`c${i}`"
                    class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                  >
                    <div class="flex flex-wrap items-center gap-1.5">
                      <template v-for="(name, k) in c.chainLabels" :key="k">
                        <button
                          type="button"
                          class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          @click="openClass(c.chain[k])"
                        >
                          {{ name }}
                        </button>
                        <Icon v-if="k < c.chainLabels.length - 1" icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                      </template>
                    </div>
                    <!-- Nicht nur WO man schneidet, sondern WIE: „easiest cut: A → B" allein ist
                         eine Feststellung, keine Handlung. -->
                    <div v-if="c.weakest" class="mt-2 flex items-start gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                      <span class="min-w-0">
                        <span class="font-medium text-[var(--color-text)]">Easiest cut</span> —
                        <span class="font-mono">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                        <span class="opacity-70"> ({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                        <br />{{ cutAdvice(c.weakest) }}
                        <!-- ⚠️ Der Vorschlag endete bis hierher bei der Empfehlung. „Was bringt es?"
                             ist die Frage direkt dahinter – und sie ist einen Klick entfernt,
                             statt sie im Sandkasten von Hand nachzubauen. -->
                        <span class="mt-1.5 flex flex-wrap gap-1.5">
                          <button
                            v-tip="'Stage this cut and see what it does to everything else'"
                            type="button"
                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-3xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                            :class="whatIf.has(cutOf(c.weakest)) ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''"
                            @click="stageCut(cutOf(c.weakest))"
                          >
                            <Icon :icon="whatIf.has(cutOf(c.weakest)) ? 'lucide:check' : 'lucide:git-fork'" class="h-3 w-3" />
                            {{ whatIf.has(cutOf(c.weakest)) ? 'Staged — open' : 'Try cutting it' }}
                          </button>
                          <button
                            v-tip="'Stage inverting it instead — the dependency stays, its direction flips'"
                            type="button"
                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-3xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                            :class="whatIf.has(cutOf(c.weakest, 'class', 'invert-edge')) ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''"
                            @click="stageCut(cutOf(c.weakest, 'class', 'invert-edge'))"
                          >
                            <Icon :icon="whatIf.has(cutOf(c.weakest, 'class', 'invert-edge')) ? 'lucide:check' : 'lucide:rotate-ccw'" class="h-3 w-3" />
                            {{ whatIf.has(cutOf(c.weakest, 'class', 'invert-edge')) ? 'Staged — open' : 'Try turning it' }}
                          </button>
                        </span>
                      </span>
                    </div>
                    <p v-if="c.size > c.chainLabels.length - 1" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                      Part of a group of {{ c.size }} classes that all reach each other.
                    </p>

                    <CyclePlan
                      :cycle="c"
                      level="class"
                      :open="openPlan === `c${i}`"
                      @toggle="togglePlan(`c${i}`)"
                      @open-class="openClass"
                    />
                  </article>
                </div>
              </div>
            </template>
          </section>

          <!-- ==================== Hotspots ==================== -->
          <section v-else-if="tab === 'hotspots'" class="space-y-3">
            <p v-if="!totals.hasChurn" class="text-2xs text-[var(--color-text-muted)]">
              Change frequency is not counted yet — it starts once a class is imported a second time.
            </p>

            <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
              <table class="w-full min-w-[42rem] border-collapse text-xs">
                <thead>
                  <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    <th class="px-3 py-2 font-medium">Score</th>
                    <th class="px-3 py-2 font-medium">Class</th>
                    <th class="px-3 py-2 font-medium">Why</th>
                    <th class="px-3 py-2 text-right font-medium">Code lines</th>
                    <th class="px-3 py-2 text-right font-medium">Branches</th>
                    <th class="px-3 py-2 text-right font-medium">In / Out</th>
                    <th v-if="totals.hasChurn" class="px-3 py-2 text-right font-medium">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="c in hotspots" :key="c.id">
                  <tr
                    v-tip="'Show how this class could be split'"
                    class="cursor-pointer border-b border-[var(--color-border)] transition hover:bg-[var(--color-surface-offset)]"
                    :class="openSplit === c.id ? 'bg-[var(--color-surface-offset)]' : ''"
                    @click="toggleSplit(c.id)"
                  >
                    <td class="px-3 py-1.5">
                      <div class="flex items-center gap-2">
                        <!-- Der Chevron ist die einzige Ansage, dass hier etwas aufgeht – ohne ihn
                             ist die Zeile eine Zeile, und niemand klickt darauf. -->
                        <Icon
                          :icon="openSplit === c.id ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                          class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]"
                        />
                        <span class="w-6 shrink-0 text-right font-mono text-2xs" :style="{ color: scoreColor(c.score) }">
                          {{ c.score }}
                        </span>
                        <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                          <span class="block h-full rounded-full" :style="{ width: `${c.score}%`, background: scoreColor(c.score) }" />
                        </span>
                      </div>
                    </td>
                    <td class="px-3 py-1.5">
                      <!-- Der NAME bleibt der Weg nach /code: die Zeile beantwortet „wie teile ich
                           sie?", der Name „zeig mir sie". -->
                      <button
                        v-tip="'Open this class in the code view'"
                        type="button"
                        class="font-mono text-[var(--color-text)] underline-offset-2 transition hover:text-[var(--color-accent)] hover:underline"
                        @click.stop="openClass(c.id)"
                      >{{ c.className }}</button>
                      <span class="ml-1.5 text-2xs text-[var(--color-text-muted)]">{{ c.package }}</span>
                      <span
                        v-if="c.cycle != null"
                        v-tip="'This class sits in a dependency cycle'"
                        class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-3xs text-[var(--color-danger)]"
                      >
                        <Icon icon="lucide:repeat" class="h-2.5 w-2.5" /> cycle
                      </span>
                    </td>
                    <!-- ⚠️ Der Treiber ist die eigentliche Auskunft: „78" sortiert nur, „branching"
                         sagt, wo man ansetzt. Eine Rangliste ohne ihn schickt jeden auf die
                         gleiche Suche. -->
                    <td class="px-3 py-1.5">
                      <span
                        v-if="DRIVER[c.driver]"
                        v-tip="DRIVER[c.driver].hint"
                        class="rounded bg-[var(--color-surface-offset)] px-1.5 py-0.5 text-3xs text-[var(--color-text-muted)]"
                      >{{ DRIVER[c.driver].label }}</span>
                    </td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.loc) }}</td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.complexity) }}</td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ c.fanIn }} / {{ c.fanOut }}</td>
                    <td v-if="totals.hasChurn" class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ c.churn }}</td>
                  </tr>
                  <!-- ⚠️ Der Plan liegt in einer EIGENEN Zeile über die volle Breite, nicht in der
                       letzten Zelle: er trägt zwei Code-Fenster nebeneinander, und die hätten in
                       einer Spalte von 8 rem keine Chance. `v-if` statt `v-show` – ein Plan, den
                       niemand aufgeklappt hat, soll auch nicht geladen werden. -->
                  <tr v-if="openSplit === c.id">
                    <td :colspan="totals.hasChurn ? 7 : 6" class="p-0">
                      <SplitPlan
                        :file-id="c.id"
                        :driver="c.driver || ''"
                        :open="true"
                        @open-class="openClass"
                      />
                    </td>
                  </tr>
                  </template>
                </tbody>
              </table>
            </div>

            <button
              v-if="ranked.length > TOP_N"
              type="button"
              class="text-2xs text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
              @click="showAllHotspots = !showAllHotspots"
            >
              {{ showAllHotspots ? `Show top ${TOP_N} only` : `Show all ${num(ranked.length)} classes` }}
            </button>
          </section>

          <!-- ==================== Tests ==================== -->
          <section v-else-if="tab === 'tests'" class="space-y-5">
            <!-- ⚠️ Die Bilanz steht nur da, wenn es ueberhaupt Tests gibt. Ohne einen einzigen
                 waere „0 % covered" formal richtig und trotzdem eine Falschauskunft: gemessen wird
                 dann nicht das Projekt, sondern was jemand hochgeladen hat. -->
            <div v-if="tests && tests.totals.tests" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div
                v-for="k in testKpis"
                :key="k.label"
                v-tip="k.tip"
                class="rounded-lg border bg-[var(--color-surface-2)] px-3 py-2"
                :class="k.warn ? 'border-[var(--color-warning)]/40' : 'border-[var(--color-border)]'"
              >
                <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon :icon="k.icon" class="h-3 w-3" />
                  {{ k.label }}
                </p>
                <p
                  class="mt-0.5 font-mono text-lg font-semibold tabular-nums"
                  :style="{ color: k.warn ? 'var(--color-warning)' : 'var(--color-text)' }"
                >{{ k.value }}</p>
              </div>
            </div>

            <!-- ⚠️ Drei Leerzustaende, und nur der letzte ist ein Lob. -->
            <p
              v-if="testsEmpty"
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs leading-relaxed text-[var(--color-text-muted)]"
            >
              <template v-if="testsEmpty === 'all-covered'">
                Every class here has a test that names it. Nothing sits in the shadow.
              </template>
              <template v-else-if="testsEmpty === 'no-imports'">
                No import lines stored for these classes, so a test can only be recognised by its
                name — and none of these names looks like one. Re-analyse the code and this fills in.
              </template>
              <template v-else>
                No test classes in this workspace. That is a statement about what was uploaded, not
                about the project — paste the test sources under “Add code” in the Code view and
                every number here fills in.
              </template>
            </p>

            <template v-else-if="tests">
              <!-- Die Rangliste. Dieselbe Form wie die Brandherde, weil es dieselbe Frage in ihrer
                   Fortsetzung ist – nur steht hier statt „wie teile ich sie?" die Abdeckung. -->
              <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                <table class="w-full min-w-[42rem] border-collapse text-xs">
                  <thead>
                    <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                      <th class="px-3 py-2 font-medium">Weight</th>
                      <th class="px-3 py-2 font-medium">Class</th>
                      <th class="px-3 py-2 font-medium">Coverage</th>
                      <th class="px-3 py-2 font-medium">Why it is heavy</th>
                      <th class="px-3 py-2 text-right font-medium">Code lines</th>
                      <th class="px-3 py-2 text-right font-medium">Branches</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="c in tests.shadow"
                      :key="c.id"
                      class="border-b border-[var(--color-border)] transition last:border-0 hover:bg-[var(--color-surface-offset)]"
                    >
                      <td class="px-3 py-1.5">
                        <div class="flex items-center gap-2">
                          <span class="w-6 shrink-0 text-right font-mono text-2xs" :style="{ color: scoreColor(c.score) }">
                            {{ c.score }}
                          </span>
                          <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                            <span class="block h-full rounded-full" :style="{ width: `${c.score}%`, background: scoreColor(c.score) }" />
                          </span>
                        </div>
                      </td>
                      <td class="px-3 py-1.5">
                        <button
                          v-tip="'Open this class in the code view'"
                          type="button"
                          class="font-mono text-[var(--color-text)] underline-offset-2 transition hover:text-[var(--color-accent)] hover:underline"
                          @click="openClass(c.id)"
                        >{{ c.className }}</button>
                        <span class="ml-1.5 text-2xs text-[var(--color-text-muted)]">{{ c.package }}</span>
                        <!-- ⚠️ Der Zyklus-Hinweis gehoert genau hierher: eine Klasse in einer
                             Schleife laesst sich nicht allein testen, also ist er der Grund,
                             warum die Zeile ohne Test dasteht – und nicht nur eine Marke. -->
                        <span
                          v-if="c.cycle != null"
                          v-tip="'In a dependency cycle — no test can build this class on its own'"
                          class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-3xs text-[var(--color-danger)]"
                        >
                          <Icon icon="lucide:repeat" class="h-2.5 w-2.5" /> cycle
                        </span>
                      </td>
                      <td class="px-3 py-1.5">
                        <span
                          class="inline-flex items-center gap-1 text-3xs"
                          :style="{ color: COVERAGE[c.coverage].color }"
                        >
                          <Icon :icon="COVERAGE[c.coverage].icon" class="h-3 w-3" />
                          {{ COVERAGE[c.coverage].label }}
                        </span>
                        <!-- Wer sie beruehrt, ist die Anschlussfrage – und der Absprung dorthin. -->
                        <template v-if="c.by.length">
                          <span class="ml-1 text-3xs text-[var(--color-text-muted)]">by</span>
                          <button
                            v-for="t in c.by"
                            :key="t.id"
                            type="button"
                            class="ml-1 rounded bg-[var(--color-surface-offset)] px-1 py-px font-mono text-3xs text-[var(--color-text-muted)] transition hover:text-[var(--color-accent)]"
                            @click="openClass(t.id)"
                          >{{ t.className }}</button>
                          <span v-if="c.byCount > c.by.length" class="ml-1 text-3xs text-[var(--color-text-muted)]">
                            and {{ c.byCount - c.by.length }} more
                          </span>
                        </template>
                      </td>
                      <td class="px-3 py-1.5">
                        <span
                          v-if="DRIVER[c.driver]"
                          v-tip="DRIVER[c.driver].hint"
                          class="rounded bg-[var(--color-surface-offset)] px-1.5 py-0.5 text-3xs text-[var(--color-text-muted)]"
                        >{{ DRIVER[c.driver].label }}</span>
                      </td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.loc) }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.complexity) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p v-if="tests.moreShadow" class="text-3xs text-[var(--color-text-muted)]">
                … and {{ plural(tests.moreShadow, 'class') }} more without a test, each lighter than the ones above.
              </p>

              <!-- Ein Test, dessen Name auf eine Klasse zeigt, die hier nicht liegt: derselbe
                   Befund wie eine Luecke im Reiter „Outside", nur von der anderen Seite gesehen. -->
              <section v-if="tests.orphans.length" class="space-y-2">
                <header class="flex flex-wrap items-baseline gap-x-2">
                  <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-warning)]">
                    <Icon icon="lucide:puzzle" class="h-3.5 w-3.5" />
                    Tests whose subject is missing
                  </span>
                  <p class="w-full text-3xs leading-relaxed text-[var(--color-text-muted)]">
                    The test is here, the class it is named after is not. Upload it and its coverage
                    appears in the list above.
                  </p>
                </header>
                <ul class="overflow-hidden rounded-lg border border-[var(--color-border)]">
                  <li
                    v-for="o in tests.orphans"
                    :key="o.id"
                    class="flex flex-wrap items-baseline gap-x-2 border-b border-[var(--color-border)] px-3 py-1.5 last:border-0"
                  >
                    <button
                      type="button"
                      class="font-mono text-xs text-[var(--color-text)] underline-offset-2 transition hover:text-[var(--color-accent)] hover:underline"
                      @click="openClass(o.id)"
                    >{{ o.className }}</button>
                    <span class="text-3xs text-[var(--color-text-muted)]">expects</span>
                    <span class="font-mono text-2xs text-[var(--color-warning)]">{{ o.expected }}</span>
                    <span class="text-3xs text-[var(--color-text-muted)]">{{ o.package }}</span>
                  </li>
                </ul>
                <p v-if="tests.moreOrphans" class="text-3xs text-[var(--color-text-muted)]">
                  … and {{ plural(tests.moreOrphans, 'test') }} more.
                </p>
              </section>

              <!-- ⚠️ Die Gegenliste. Ein Bericht, der nur Fehlendes zeigt, wird als Noergeln
                   gelesen und irgendwann nicht mehr geoeffnet – dieselbe Ueberlegung wie beim
                   geheilten Zyklus im Drift. Zugeklappt, weil „was fehlt?" die Frage ist, mit der
                   man den Reiter oeffnet. -->
              <section class="space-y-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] transition hover:underline"
                  @click="showTestList = !showTestList"
                >
                  <Icon :icon="showTestList ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3.5 w-3.5" />
                  What is tested — {{ plural(tests.totals.tests, 'test class') }}
                </button>
                <ul v-if="showTestList" class="overflow-hidden rounded-lg border border-[var(--color-border)]">
                  <li
                    v-for="t in tests.tests"
                    :key="t.id"
                    class="flex flex-wrap items-baseline gap-x-2 border-b border-[var(--color-border)] px-3 py-1.5 last:border-0"
                  >
                    <button
                      type="button"
                      class="font-mono text-xs text-[var(--color-text)] underline-offset-2 transition hover:text-[var(--color-accent)] hover:underline"
                      @click="openClass(t.id)"
                    >{{ t.className }}</button>
                    <template v-if="t.subject">
                      <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                      <button
                        type="button"
                        class="font-mono text-2xs text-[var(--color-success)] underline-offset-2 transition hover:underline"
                        @click="openClass(t.subject.id)"
                      >{{ t.subject.className }}</button>
                    </template>
                    <span v-else class="text-3xs text-[var(--color-text-muted)]">no named subject</span>
                    <span class="text-3xs text-[var(--color-text-muted)]">
                      touches {{ plural(t.touches, 'class') }}
                    </span>
                    <!-- ⚠️ Woran erkannt wurde, gehoert an die Zeile: ein Befund, der auf einer
                         Namensregel beruht, muss als solcher lesbar sein. -->
                    <span
                      v-tip="t.evidence === 'imports'
                        ? 'Recognised by a test framework import — a hard match'
                        : 'Recognised by its name alone — no test framework import is stored for it'"
                      class="ml-auto rounded bg-[var(--color-surface-offset)] px-1 py-px text-3xs text-[var(--color-text-muted)]"
                    >by {{ t.evidence === 'imports' ? 'import' : 'name' }}</span>
                  </li>
                </ul>
                <p v-if="showTestList && tests.moreTests" class="text-3xs text-[var(--color-text-muted)]">
                  … and {{ plural(tests.moreTests, 'test class') }} more.
                </p>
              </section>

              <!-- ⚠️ Die Grenze der Auskunft gehoert unter die Liste. Ohne sie liest sich
                   „no test" als „diese Klasse ist ungeprueft" – und das ist mehr, als hier
                   gemessen werden kann. -->
              <p class="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-3xs leading-relaxed text-[var(--color-text-muted)]">
                <Icon icon="lucide:info" class="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  This reads names and relations, never a test run. A test reaching its class through
                  reflection, a Spring context or a shared helper leaves no relation behind and shows
                  up as “no test” here. And a class that <em>has</em> one is not thereby covered —
                  whether the test asserts anything is not something this can see.
                  <template v-if="tests.totals.byName">
                    {{ plural(tests.totals.byName, 'test class') }} here
                    {{ tests.totals.byName === 1 ? 'was' : 'were' }} recognised by name alone.
                  </template>
                </span>
              </p>
            </template>
          </section>

          <!-- ==================== Packages ==================== -->
          <section v-else-if="tab === 'packages'" class="space-y-5">
            <div v-if="!plotted.length" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs text-[var(--color-text-muted)]">
              Abstractness against instability needs relations between packages.
            </div>

            <div v-else class="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <!-- Das Bild: eine Diagonale und zwei Ecken. -->
              <figure class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
                <svg viewBox="-14 -10 128 128" class="w-full" role="img" aria-label="Abstractness against instability">
                  <!-- Zonen zuerst, damit die Punkte darauf liegen -->
                  <rect x="0" y="70" width="30" height="30" fill="var(--color-danger)" opacity="0.09" />
                  <rect x="70" y="0" width="30" height="30" fill="var(--color-text-muted)" opacity="0.09" />
                  <!-- Beschriftung an der INNEREN Kante ihrer Zone: an der aeusseren stand sie auf
                       der Achse, und genau dort liegen die Punkte mit A = 0 bzw. I = 1. -->
                  <text x="2" y="67" class="plot-zone" fill="var(--color-danger)">zone of pain</text>
                  <text x="98" y="36" text-anchor="end" class="plot-zone" fill="var(--color-text-muted)">zone of uselessness</text>

                  <line x1="0" y1="0" x2="100" y2="100" stroke="var(--color-border-strong)" stroke-width="0.7" stroke-dasharray="3 2" />
                  <rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--color-border)" stroke-width="0.7" />

                  <circle
                    v-for="p in plotted"
                    :key="p.path"
                    v-tip="`${p.path} — ${p.classes} classes, I=${p.instability}, A=${p.abstractness}, D=${p.distance}`"
                    :cx="p.x"
                    :cy="p.y"
                    :r="p.r"
                    :fill="p.cycle != null ? 'var(--color-danger)' : 'var(--color-accent)'"
                    fill-opacity="0.55"
                    :stroke="p.cycle != null ? 'var(--color-danger)' : 'var(--color-accent)'"
                    stroke-width="0.6"
                    class="cursor-pointer transition-[fill-opacity] hover:fill-opacity-90"
                    @click="openPackage(p.path)"
                  />

                  <text x="50" y="112" text-anchor="middle" class="plot-axis">instability →</text>
                  <text x="-6" y="50" text-anchor="middle" class="plot-axis" transform="rotate(-90 -6 50)">abstractness →</text>
                </svg>
                <figcaption class="mt-2 text-3xs leading-relaxed text-[var(--color-text-muted)]">
                  On the dashed line a package is either abstract and widely used, or concrete and
                  used by nobody. Bottom left is rigid and concrete — everything depends on it and
                  it cannot be extended. Top right is abstract with nobody to serve.
                </figcaption>
              </figure>

              <!-- Die Tabelle: dieselben Zahlen, nur lesbar. -->
              <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                <table class="w-full min-w-[30rem] border-collapse text-xs">
                  <thead>
                    <!-- ⚠️ Klartext statt „I / A / D". Die Kürzel stehen klein daneben, damit sie
                         für alle, die sie kennen, noch auffindbar sind – aber niemand muss sie
                         kennen, um die Tabelle zu lesen. -->
                    <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                      <th class="px-3 py-2 font-medium">Package</th>
                      <th class="px-3 py-2 text-right font-medium">Classes</th>
                      <th v-tip="'Classes outside that depend on this package / classes inside that depend outward'" class="px-3 py-2 text-right font-medium">
                        Used by / uses
                      </th>
                      <th v-tip="'0 = everything depends on it. 1 = it depends on everything else.'" class="px-3 py-2 text-right font-medium">
                        Depends outward <span class="normal-case opacity-60">(I)</span>
                      </th>
                      <th v-tip="'Share of interfaces, annotations and abstract classes in this package.'" class="px-3 py-2 text-right font-medium">
                        Abstract <span class="normal-case opacity-60">(A)</span>
                      </th>
                      <th v-tip="'How far the package sits from a healthy combination of the two. 0 is fine, 1 is trouble.'" class="px-3 py-2 text-right font-medium">
                        Off balance <span class="normal-case opacity-60">(D)</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="p in packages"
                      :key="p.path"
                      class="cursor-pointer border-b border-[var(--color-border)] last:border-0 transition hover:bg-[var(--color-surface-offset)]"
                      @click="openPackage(p.path)"
                    >
                      <td class="px-3 py-1.5">
                        <span class="font-mono text-[var(--color-text)]">{{ p.path }}</span>
                        <span
                          v-if="p.cycle != null"
                          v-tip="'This package sits in a cycle'"
                          class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-3xs text-[var(--color-danger)]"
                        >
                          <Icon icon="lucide:repeat" class="h-2.5 w-2.5" /> cycle
                        </span>
                        <span class="ml-1.5 text-3xs text-[var(--color-text-muted)]">{{ instabilityLabel(p.instability) }}</span>
                        <!-- Erst ab einer echten Abweichung: eine Empfehlung an jeder Zeile wäre
                             Rauschen, und die meisten Packages sind in Ordnung. -->
                        <p v-if="p.distance != null && p.distance > 0.5" class="mt-0.5 text-3xs text-[var(--color-text-muted)]">
                          {{ packageAdvice(p) }}
                        </p>
                      </td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(p.classes) }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.ca }} / {{ p.ce }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.instability ?? '–' }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.abstractness }}</td>
                      <td
                        class="px-3 py-1.5 text-right font-mono"
                        :style="{ color: p.distance != null && p.distance > 0.6 ? 'var(--color-danger)' : 'var(--color-text-muted)' }"
                      >
                        {{ p.distance ?? '–' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <!-- ==================== Reading path ==================== -->
          <section v-else-if="tab === 'path'" class="space-y-4">
            <!-- Zuschnitt + Mitnahme in EINER Zeile: „wodurch?" und „und dann?" gehoeren zusammen. -->
            <div class="flex flex-wrap items-center gap-2">
              <label class="flex items-center gap-2 text-2xs text-[var(--color-text-muted)]">
                <Icon icon="lucide:route" class="h-3.5 w-3.5" />
                Path through
                <select
                  v-model="pathScope"
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-2xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">the whole codebase ({{ num(classes.length) }} classes)</option>
                  <option v-for="p in pathPackages" :key="p.path" :value="p.path">
                    {{ p.path }} ({{ p.classes }})
                  </option>
                </select>
              </label>

              <span v-if="readingPath.totals.classes" class="text-2xs text-[var(--color-text-muted)]">
                <strong class="font-semibold text-[var(--color-text)]">{{ readingPath.totals.foundations }}</strong>
                to start from ·
                <strong class="font-semibold text-[var(--color-text)]">{{ readingPath.totals.depth }}</strong>
                {{ readingPath.totals.depth === 1 ? 'layer' : 'layers' }} deep
              </span>

              <button
                v-if="readingPath.totals.classes"
                type="button"
                class="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-2xs font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:opacity-60"
                :disabled="pathCopying"
                title="Copy every class on this path as one text — in reading order, not alphabetical"
                @click="copyPath"
              >
                <Icon
                  :icon="pathCopied ? 'lucide:check' : pathCopying ? 'lucide:loader-2' : 'lucide:clipboard-copy'"
                  class="h-3.5 w-3.5"
                  :class="pathCopying ? 'animate-spin' : ''"
                />
                {{ pathCopied ? 'Copied' : `Copy all ${readingPath.totals.classes}` }}
              </button>
            </div>

            <BusyState
              v-if="pathLoading"
              variant="panel"
              title="Loading relations…"
              detail="the stored class edges this order is built from"
              :since="startedAt"
              :rows="4"
            />

            <p
              v-else-if="!readingPath.totals.classes"
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs text-[var(--color-text-muted)]"
            >
              No classes in this scope.
            </p>

            <!-- Die Route. ⚠️ Eine Station nennt IMMER ihren Grund – eine nummerierte Liste ohne
                 „warum hier?" waere eine Sortierung, der man glauben muesste. -->
            <ol v-else class="space-y-1.5">
              <li
                v-for="s in readingPath.stations"
                :key="s.fileId"
                class="group flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 transition hover:border-[var(--color-accent)]"
                @click="openClass(s.fileId)"
              >
                <span
                  class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-3xs font-semibold tabular-nums"
                  :style="{
                    background: `color-mix(in srgb, ${STATION_STYLE[s.kind].color} 16%, transparent)`,
                    color: STATION_STYLE[s.kind].color,
                  }"
                >{{ s.step }}</span>

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span class="text-xs font-semibold text-[var(--color-text)]">{{ s.className }}</span>
                    <span v-if="!pathScope && s.package" class="truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ s.package }}</span>
                    <span
                      class="inline-flex items-center gap-1 rounded px-1 py-px text-3xs font-medium"
                      :style="{
                        background: `color-mix(in srgb, ${STATION_STYLE[s.kind].color} 12%, transparent)`,
                        color: STATION_STYLE[s.kind].color,
                      }"
                    >
                      <Icon :icon="STATION_STYLE[s.kind].icon" class="h-3 w-3" />
                      {{ STATION_STYLE[s.kind].label }}
                    </span>
                    <!-- Der Brandherd-Rang faehrt mit, wo er etwas sagt: eine schwere Klasse mitten
                         im Pfad ist die, fuer die man Zeit einplant. -->
                    <span
                      v-if="s.score != null && s.score >= 50"
                      v-tip="`Hotspot rank ${s.score} — driven by ${s.driver}`"
                      class="text-3xs font-semibold tabular-nums"
                      :style="{ color: scoreColor(s.score) }"
                    >{{ s.score }}</span>
                  </div>
                  <p class="mt-0.5 text-3xs leading-relaxed text-[var(--color-text-muted)]">{{ stationWhy(s) }}</p>
                </div>

                <Icon
                  icon="lucide:arrow-up-right"
                  class="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100"
                />
              </li>
            </ol>
          </section>

          <!-- ==================== Outside ==================== -->
          <section v-else-if="tab === 'outside'" class="space-y-5">
            <!-- Die Bilanz zuerst: die vier Zahlen erklären einander. Ohne die Plattform- und
                 Wildcard-Spalte daneben liest sich „missing" wie das ganze Bild. -->
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div
                v-for="k in outsideKpis"
                :key="k.label"
                class="rounded-lg border bg-[var(--color-surface-2)] px-3 py-2"
                :class="k.warn ? 'border-[var(--color-warning)]/40' : 'border-[var(--color-border)]'"
              >
                <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon :icon="k.icon" class="h-3 w-3" />
                  {{ k.label }}
                </p>
                <p
                  class="mt-0.5 font-mono text-lg font-semibold tabular-nums"
                  :style="{ color: k.warn ? 'var(--color-warning)' : 'var(--color-text)' }"
                >{{ k.value }}</p>
              </div>
            </div>

            <!-- ⚠️ Zwei Leerzustände, die das Gegenteil voneinander bedeuten. -->
            <p
              v-if="outsideEmpty"
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs leading-relaxed text-[var(--color-text-muted)]"
            >
              <template v-if="outsideEmpty === 'no-imports'">
                No import lines stored for these classes. They were analysed before imports were
                kept — re-analyse them in the Code view and this fills in.
              </template>
              <template v-else>
                Everything this code imports is also here. Nothing reaches outside the workspace.
              </template>
            </p>

            <template v-else>
              <template v-for="g in OUTSIDE_GROUPS" :key="g.id">
                <section v-if="outside.groups[g.id].length" class="space-y-2">
                  <header class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span class="inline-flex items-center gap-1.5 text-xs font-semibold" :style="{ color: g.color }">
                      <Icon :icon="g.icon" class="h-3.5 w-3.5" />
                      {{ g.label }}
                    </span>
                    <span class="font-mono text-3xs text-[var(--color-text-muted)]">
                      {{ plural(outside.totals[g.id].types, 'type') }} ·
                      {{ plural(outside.totals[g.id].packages, 'package') }}
                    </span>
                    <p class="w-full text-3xs leading-relaxed text-[var(--color-text-muted)]">{{ g.hint }}</p>
                  </header>

                  <ul class="overflow-hidden rounded-lg border border-[var(--color-border)]">
                    <li
                      v-for="p in outside.groups[g.id]"
                      :key="p.path"
                      class="border-b border-[var(--color-border)] last:border-0"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 px-3 py-1.5 text-left transition hover:bg-[var(--color-surface-offset)]"
                        @click="toggleOutside(`${g.id}:${p.path}`)"
                      >
                        <Icon
                          :icon="openOutside === `${g.id}:${p.path}` ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                          class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]"
                        />
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text)]">{{ p.path }}</span>
                        <span class="shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                          {{ plural(p.typeCount, 'type') }}
                        </span>
                        <!-- Der Balken beantwortet „wie tief steckt das drin?" auf einen Blick –
                             die Zahl daneben sagt es genau. -->
                        <span class="hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)] sm:block">
                          <span class="block h-full rounded-full" :style="{ width: `${outsideBar(g.id, p.usedBy)}%`, background: g.color }" />
                        </span>
                        <span
                          v-tip="`${p.usedBy} of your classes import something from here`"
                          class="w-24 shrink-0 text-right font-mono text-3xs text-[var(--color-text-muted)]"
                        >used by {{ p.usedBy }}</span>
                      </button>

                      <!-- Aufgeklappt: die Typen mit ihren Nutzern. ⚠️ Die Nutzer sind der Absprung –
                           ohne sie endet der Reiter bei der Erkenntnis. -->
                      <div v-if="openOutside === `${g.id}:${p.path}`" class="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
                        <ul class="space-y-1.5">
                          <li v-for="t in p.types" :key="t.fqcn" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span class="font-mono text-2xs font-medium text-[var(--color-text)]">{{ t.name }}</span>
                            <span class="text-3xs text-[var(--color-text-muted)]">used by</span>
                            <button
                              v-for="u in t.users"
                              :key="u.id"
                              type="button"
                              class="rounded bg-[var(--color-surface-offset)] px-1 py-px font-mono text-3xs text-[var(--color-text-muted)] transition hover:text-[var(--color-accent)]"
                              @click="openClass(u.id)"
                            >{{ u.className }}</button>
                            <span v-if="t.moreUsers" class="text-3xs text-[var(--color-text-muted)]">and {{ t.moreUsers }} more</span>
                          </li>
                        </ul>
                        <p v-if="p.moreTypes" class="mt-1.5 text-3xs text-[var(--color-text-muted)]">
                          … and {{ plural(p.moreTypes, 'type') }} more from this package.
                        </p>
                      </div>
                    </li>
                  </ul>

                  <p v-if="outside.more[g.id]" class="text-3xs text-[var(--color-text-muted)]">
                    … and {{ plural(outside.more[g.id], 'package') }} more, each used less than the ones above.
                  </p>
                </section>
              </template>

              <!-- ⚠️ Die Grenze der Auskunft gehört unter die Liste, nicht in einen Tooltip: ohne
                   sie liest sich „3 missing" als vollständige Antwort auf „was fehlt mir?". -->
              <p class="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-3xs leading-relaxed text-[var(--color-text-muted)]">
                <Icon icon="lucide:info" class="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Only import lines can be counted. A class in the <em>same</em> package needs no
                  import, and neither does anything in <code class="font-mono">java.lang</code> — a
                  gap of that kind cannot show up here.
                  <template v-if="outside.totals.wildcards">
                    {{ num(outside.totals.wildcards) }} wildcard imports name no class at all and
                    are counted, not listed.
                  </template>
                </span>
              </p>
            </template>
          </section>

          <!-- ==================== Drift ==================== -->
          <!-- Der Bericht wohnt in einer eigenen Komponente: er ist die einzige Ansicht hier, die
               ihre Daten selbst holt, und diese Datei ist lang genug. -->
          <DriftReport
            v-else-if="tab === 'drift'"
            :report="drift"
            :loading="driftLoading"
            @open-class="openClass"
            @pick-point="loadDrift"
          />

          <!-- ==================== Rules ==================== -->
          <!-- Aus demselben Grund eine eigene Komponente wie der Drift-Bericht – und hier zusätzlich,
               weil sie als einzige Ansicht des Berichts auch SCHREIBT. -->
          <ArchRules
            v-else-if="tab === 'rules'"
            :report="archRules"
            :loading="archLoading"
            :saving="archSaving"
            :started-at="startedAt"
            @open-class="openClass"
            @save="saveRules"
          />

          <!-- ==================== What if ==================== -->
          <!-- Der einzige Reiter, der den Bericht nicht LIEST, sondern ihn ein zweites Mal rechnen
               lässt – über einen Bestand, den es (noch) nicht gibt. Klassen und Packages kommen von
               hier, weil sie längst geladen sind; die Beziehungen holt er sich selbst. -->
          <WhatIf v-else :classes="classes" :packages="packages" @open-class="openClass" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Beschriftungen im SVG: die Groessen sind viewBox-Einheiten, nicht rem – das Diagramm skaliert
   als Ganzes mit seiner Breite, und eine rem-Schrift darin wuerde bei schmaler Spalte den Rahmen
   sprengen. */
.plot-axis {
  font-size: 5px;
  fill: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
}
.plot-zone {
  font-size: 4.5px;
  font-family: var(--font-mono, monospace);
}
</style>
