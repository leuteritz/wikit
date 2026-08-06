<script setup>
// Ein Thema einsammeln und als EINEN Text mitnehmen.
//
// Warum eine eigene Ansicht und nicht ein siebter Chip in der Suchpalette: das sind zwei
// gegenlaeufige Fragen. Die Palette beantwortet „welches EINE Ding meine ich?" – flacher Index,
// ↵ springt, jedes Strg+K beginnt bei null. Hier lautet die Frage „was gehoert alles dazu?", und
// die Antwort ist eine MENGE mit einer Groesse, die man vor dem Kopieren sehen will. In derselben
// Liste haette ↵ zwei Bedeutungen bekommen (springen vs. anhaken), und fuer die Groessenangabe
// waere im Modal ohnehin kein Platz mehr gewesen.
//
// Drei Festlegungen, die man dem Code sonst nicht ansieht:
//
// ⚠️ **Der Kopiertext kommt vom SERVER, auch beim Umhaken.** Das Format des Buendels ist genau das
// des Exports (`/java/export?ids=`) – dieselben Trenner, dieselbe Sortierung, dieselbe
// Dublettenregel –, und damit bleibt es ueber „Add code" einlesbar. Ihn im Client
// zusammenzusetzen waere ein Request weniger und eine zweite Fassung des Formats, die beim
// naechsten Trenner auseinanderlaeuft. Also holt jede Auswahlaenderung ihn neu (debounced); auf
// dieser Datenmenge ist das eine Rechnung ueber drei kleine Spalten.
//
// ⚠️ **Die Vorschau IST der Kopiertext, kein Auszug daraus.** Ein Buendel, das man nicht gesehen
// hat, bevor es in einem Chat landet, ist eine Wundertuete – und der einzige ehrliche Weg, das zu
// zeigen, ist der Text selbst. Bewusst ohne Shiki: die Frage lautet „was landet in der Ablage?",
// nicht „wie sieht Java aus", und ein Highlighter-Lauf ueber ein paar hundert Kilobyte waere
// Arbeit fuer eine Frage, die niemand gestellt hat.
//
// ⚠️ **Nachbarn sind zuschaltbar und NIE vorausgewaehlt** (s. `TOPIC_SOURCES`). Sie sind der
// Unterschied zwischen „alles was JT heisst" und „alles was mit JT zu tun hat" – aber auch der
// schnellste Weg, versehentlich die halbe Codebasis zu kopieren.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { api } from '../lib/api.js'
import { BIG_CLIPBOARD_BYTES, copyToClipboard } from '../lib/clipboard.js'
import { buildSearchRegex, findMatches, MATCH_LIMIT } from '../lib/codeSearch.js'
import { addLineNumbers, clearMatches, paintMatches } from '../lib/javaCode.js'
import { buildMethodColorMap, methodColorVars } from '../lib/javaMethodColors.js'
import { formatBytes } from '../lib/format.js'
import {
  MAX_CANDIDATES,
  collectTopic,
  defaultSelection,
  estimateTokens,
  groupByReason,
  topicSource,
} from '../lib/topicBundle.js'
import BusyState from '../components/BusyState.vue'
import { Icon } from '../lib/icons.js'
import { vTip } from '../lib/tooltip.js'

const route = useRoute()
const router = useRouter()
const { files, lastFileId, lastTargetLine } = useJavaAnalyzer()
const { edges, fetchEdges } = useJavaGraph()

// Dieselbe Staffelung wie in `CodeView`: das Feld reagiert sofort, die Requests folgen.
const TERM_DEBOUNCE_MS = 280
// Der Zusammenbau des Textes haengt an der Auswahl – und die aendert sich beim Durchklicken einer
// Gruppe mehrmals je Sekunde. Etwas laenger als das Feld, weil hier ein Klick und kein Anschlag
// den Anstoss gibt: wer zwei Haken setzt, meint beide.
const EXPORT_DEBOUNCE_MS = 320
// Fuer die Bedeutungssuche gilt derselbe Mindestumfang wie in der Palette – bei zwei Zeichen hat
// ein Embedding-Modell nichts zu deuten. Name und Quelltext antworten trotzdem, und genau das ist
// der Grund, warum ein Thema hier vier Quellen hat.
const MEANING_MIN_CHARS = 3
// Wie viele Klassen die Quelltextsuche fuer ein Thema hoechstens meldet (Server-Deckel: 60). Die
// Palette nimmt dort ihre 25 – dort ist die Fundstelle die Auskunft, hier die Klasse.
const CODE_FILE_LIMIT = 60
const MEANING_LIMIT = 40

// Dieselben drei Schalter, dieselben Icons und dieselbe Bedeutung wie in der Suchleiste des
// Source-Tabs und in der Palette – wer hier sucht, sucht nach denselben Regeln wie dort.
//
// `tip` gilt der Leiste OBEN und sagt zusaetzlich, was der Schalter am Thema bewirkt: dort fragen
// vier Quellen zugleich, und ohne den Satz waere „Match case" eine Behauptung ueber alle vier.
// `title` bleibt der kurze Text der Buendelleiste – dort gibt es nur einen Text zu durchsuchen.
const SEARCH_TOGGLES = [
  {
    key: 'caseSensitive',
    icon: 'lucide:case-sensitive',
    title: 'Match case',
    label: 'Match case',
    tip: 'Match case — applies to names and source. Meaning is unaffected.',
  },
  {
    key: 'wholeWord',
    icon: 'lucide:whole-word',
    title: 'Match whole word',
    label: 'Whole word',
    tip: 'Whole word — “Order” stops matching OrderService. Applies to names and source.',
  },
  {
    key: 'regex',
    icon: 'lucide:regex',
    title: 'Use regular expression',
    label: 'Regex',
    tip: 'Regular expression — e.g. ^Jt.*(Repo|Dao)$. Meaning search stays out while it is on.',
  },
]

// Die Schalter stehen in der URL neben dem Begriff: aus der Palette kommt man mit einem Thema
// hierher, und ein geteilter Link, der `^Jt.*` als gewoehnlichen Text sucht, zeigt etwas anderes
// als das, was der Absender vor sich hatte.
const flagsOf = (query) => ({
  caseSensitive: query?.case === '1',
  wholeWord: query?.word === '1',
  regex: query?.re === '1',
})
const sameFlags = (a, b) =>
  a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord && a.regex === b.regex

const term = ref(String(route.query.q || ''))
const applied = ref(term.value)
const termOpts = ref(flagsOf(route.query))
const withNeighbours = ref(false)
const inputEl = ref(null)

// Ungueltige Regex ist ein Bedienfehler, kein Absturz: derselbe Umgang wie in der Palette und in
// der Buendelleiste – das Feld faerbt sich, und der Request geht gar nicht erst raus (sonst
// beantwortete der Server jeden Zwischenstand einer halb getippten Klammer mit einer 400).
const patternError = computed(() =>
  applied.value && termOpts.value.regex
    ? buildSearchRegex({ query: applied.value, ...termOpts.value }).error
    : '',
)
const activeToggles = computed(() => SEARCH_TOGGLES.filter((o) => termOpts.value[o.key]))

const codeFiles = ref([])
const meaningResult = ref(null)
const searching = ref(false)
const searchedAt = ref(0)
const codeNote = ref('')

let termTimer = null
let searchToken = 0
let codeAbort = null
let meaningAbort = null

function abortSearch() {
  codeAbort?.abort()
  meaningAbort?.abort()
  codeAbort = null
  meaningAbort = null
}

// --- Suchen ---------------------------------------------------------------------------------
// Die beiden Requests laufen NEBENEINANDER, nicht nacheinander: die Bedeutungssuche kostet einen
// Ollama-Aufruf und darf die Quelltextsuche nicht aufhalten. Bleibt sie aus (kein Modell, kein
// Index, Ollama weg), fehlt genau ihre Gruppe – der Rest des Buendels ist davon unberuehrt.
//
// ⚠️ Die drei Schalter gehen an die QUELLTEXTSUCHE mit; den Namen beantwortet `collectTopic` im
// Client nach derselben Regel. Die Bedeutungssuche bekommt sie nicht – und bei aktivem Regex
// laeuft sie gar nicht: ein Muster ist kein Satz, es einzubetten ergaebe einen Vektor ohne Sinn
// und damit eine Trefferliste, die schlechter ist als keine.
async function runSearch(q, opts) {
  const token = ++searchToken
  abortSearch()
  const broken = !!opts.regex && !!buildSearchRegex({ query: q, ...opts }).error
  if (!q || broken) {
    codeFiles.value = []
    meaningResult.value = null
    codeNote.value = ''
    searching.value = false
    return
  }
  searching.value = true
  searchedAt.value = Date.now()

  const codeCtrl = new AbortController()
  codeAbort = codeCtrl
  const codeJob = api
    .searchJavaCode(q, { ...opts, limit: CODE_FILE_LIMIT, context: 0 }, codeCtrl.signal)
    .then((res) => {
      if (token !== searchToken) return
      codeFiles.value = res?.files || []
      // Ein stiller Deckel liest sich wie „mehr gibt es nicht" – hier waere das die falscheste
      // aller Auskuenfte, weil das Buendel danach unvollstaendig kopiert wird.
      codeNote.value = res?.truncated
        ? `More classes mention it than fit this list — narrow the topic for the rest.`
        : ''
    })
    .catch(() => {
      if (token === searchToken) codeFiles.value = []
    })

  let meaningJob = Promise.resolve()
  if (!opts.regex && q.length >= MEANING_MIN_CHARS) {
    const meaningCtrl = new AbortController()
    meaningAbort = meaningCtrl
    meaningJob = api
      .semanticSearchJava(q, meaningCtrl.signal, MEANING_LIMIT)
      .then((res) => {
        if (token === searchToken) meaningResult.value = res
      })
      .catch(() => {
        if (token === searchToken) meaningResult.value = null
      })
  } else {
    meaningResult.value = null
  }

  await Promise.all([codeJob, meaningJob])
  if (token === searchToken) searching.value = false
}

watch(term, (v) => {
  clearTimeout(termTimer)
  // Leeren wirkt sofort – ein Ergebnis, das nach dem Loeschen noch 280 ms stehen bleibt, sieht aus,
  // als haette das Feld die Eingabe verschluckt.
  if (!v.trim()) {
    applied.value = ''
    return
  }
  termTimer = setTimeout(() => (applied.value = v.trim()), TERM_DEBOUNCE_MS)
})

// Begriff UND Schalter sind zusammen die Frage – also stossen beide dieselbe Antwort an. Ein
// umgelegter Schalter wirkt dabei sofort: er ist ein Klick und keine Eingabe, und wer ihn drueckt,
// hat entschieden (gleiche Regel wie beim Nachbarschafts-Schalter daneben).
watch([applied, termOpts], ([q, opts]) => {
  runSearch(q, opts)
  // Der Begriff gehoert in die URL: aus der Palette kommt man mit einem Thema hierher, und ein
  // Link auf ein Buendel ohne sein Thema waere ein leeres Blatt. `replace`, damit das Tippen
  // keinen Verlauf aus zwanzig Zwischenstaenden hinterlaesst. Ein NICHT gesetzter Schalter steht
  // gar nicht erst drin – eine URL voller Nullen liest sich, als haette jemand etwas eingestellt.
  router.replace({
    query: q
      ? {
          q,
          ...(opts.caseSensitive ? { case: '1' } : {}),
          ...(opts.wholeWord ? { word: '1' } : {}),
          ...(opts.regex ? { re: '1' } : {}),
        }
      : {},
  })
})

// Der Sprung aus der Palette wechselt nur die Query, nicht die Komponente – ohne diesen Watch
// bliebe das Feld beim zweiten Mal auf dem alten Thema stehen. Die Schalter kommen mit: ein Link
// traegt sie, und sie danach zu ignorieren waere dasselbe, als staenden sie nicht drin.
watch(
  () => route.query,
  (query) => {
    const next = String(query.q || '')
    const flags = flagsOf(query)
    if (next === applied.value && sameFlags(flags, termOpts.value)) return
    term.value = next
    applied.value = next.trim()
    termOpts.value = flags
  },
)

// --- Die Menge ------------------------------------------------------------------------------
const topic = computed(() =>
  collectTopic({
    files: files.value,
    edges: edges.value,
    term: applied.value,
    codeFiles: codeFiles.value,
    meaningResults: meaningResult.value?.results || [],
    withNeighbours: withNeighbours.value,
    opts: termOpts.value,
  }),
)

// Ein Klick ist eine Entscheidung – er wendet zugleich an, was gerade im Feld steht, statt den
// angefangenen Anschlag noch auszusitzen.
function toggleTermOpt(key) {
  clearTimeout(termTimer)
  termOpts.value = { ...termOpts.value, [key]: !termOpts.value[key] }
  applied.value = term.value.trim()
  inputEl.value?.focus()
}
const groups = computed(() => groupByReason(topic.value.hits))

// Warum die Bedeutungsgruppe fehlt. Ohne den Satz sieht ein leerer Abschnitt aus wie „gibt es
// nicht", obwohl in Wahrheit das Modell fehlt oder der Index nie gebaut wurde.
const MEANING_REASONS = {
  disabled: 'No embedding model set — configure one under Bot.',
  'not-indexed': 'The meaning index is empty — build it under Bot.',
  unavailable: 'Ollama did not answer — the other sources are unaffected.',
}
const meaningNote = computed(() => {
  if (!applied.value) return ''
  // Der Regex-Fall ist kein Ausfall, sondern eine Festlegung – und er gehoert genauso angeschrieben
  // wie ein fehlendes Modell: eine fehlende Gruppe ohne Grund sieht aus wie ein leeres Ergebnis.
  if (termOpts.value.regex) return 'Meaning is out while the pattern switch is on — a regex is not a sentence.'
  const r = meaningResult.value
  if (!r || r.results?.length) return ''
  return MEANING_REASONS[r.reason] || ''
})

// --- Auswahl --------------------------------------------------------------------------------
// Das Set haelt auch Ids, die gerade nicht in der Liste stehen (abgeschaltete Nachbarn). Gefiltert
// wird erst beim Lesen – so ist ein Haken nicht weg, nur weil man den Schalter kurz umgelegt hat.
const selected = ref(new Set())
const selectedIds = computed(() => topic.value.hits.filter((h) => selected.value.has(h.fileId)).map((h) => h.fileId))

// ⚠️ Die Vorauswahl braucht ein „hat schon jemand angefasst?" und nicht die Frage „ist das Set
// leer?". Die Antworten der drei Quellen treffen NACHEINANDER ein – die Liste waechst also
// mehrmals je Suche, und an einer leeren Auswahl haette sich die Vorauswahl nur beim allerersten
// Zwischenstand gesetzt (die Klassennamen liegen im Store, sind also sofort da; Quelltext und
// Bedeutung kommen Sekunden spaeter und blieben unangehakt). Umgekehrt darf ein bewusstes „None"
// nicht dadurch verlorengehen, dass danach eine Antwort nachrutscht.
const selectionTouched = ref(false)

// Ein neues THEMA ist eine neue Frage – die Auswahl faellt zurueck auf die Vorgabe. Ein umgelegter
// Nachbarschafts-Schalter ist dagegen nur eine Erweiterung der laufenden Antwort: was schon
// angehakt war, bleibt es, und die neuen Nachbarn kommen unangehakt dazu.
watch(applied, () => {
  selectionTouched.value = false
  selected.value = new Set()
  // Eine aufgeschlagene Klasse gehoert zum alten Thema – sie stehenzulassen zeigte neben der neuen
  // Liste einen Quelltext, der mit ihr nichts zu tun hat.
  pane.value = 'bundle'
  openClass.value = null
  bundleQuery.value = ''
  bundleCursor.value = 0
  // Ein neues Thema ist eine neue Frage – auch fuer das, was noch aufgeschlagen festgehalten war.
  releaseHold()
})
watch(
  () => topic.value.hits,
  (hits) => {
    if (!selectionTouched.value) selected.value = defaultSelection(hits)
  },
)

function toggle(id) {
  selectionTouched.value = true
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleGroup(group) {
  selectionTouched.value = true
  const ids = group.items.map((i) => i.fileId)
  const allOn = ids.every((id) => selected.value.has(id))
  const next = new Set(selected.value)
  for (const id of ids) {
    if (allOn) next.delete(id)
    else next.add(id)
  }
  selected.value = next
}
const groupState = (group) => {
  const on = group.items.filter((i) => selected.value.has(i.fileId)).length
  return on === 0 ? 'none' : on === group.items.length ? 'all' : 'some'
}
function selectAll() {
  selectionTouched.value = true
  selected.value = new Set(topic.value.hits.map((h) => h.fileId))
}
function selectNone() {
  selectionTouched.value = true
  selected.value = new Set()
}
// „Reset" stellt die Vorgabe her, gibt die Auswahl aber NICHT wieder frei: wer den Knopf drueckt,
// hat entschieden – eine nachrutschende Antwort darf das nicht erneut ueberschreiben.
function resetSelection() {
  selectionTouched.value = true
  selected.value = defaultSelection(topic.value.hits)
}

// --- Der Text -------------------------------------------------------------------------------
const bundle = ref(null)
const bundling = ref(false)
const bundleSince = ref(0)
let bundleTimer = null
let bundleToken = 0

watch(
  [selectedIds, applied],
  ([ids, q]) => {
    clearTimeout(bundleTimer)
    if (!ids.length || !q) {
      bundle.value = null
      bundling.value = false
      bundleToken++
      return
    }
    bundling.value = true
    bundleSince.value = Date.now()
    bundleTimer = setTimeout(async () => {
      const token = ++bundleToken
      try {
        const res = await api.exportJavaAll(ids, q)
        if (token === bundleToken) bundle.value = res
      } catch {
        if (token === bundleToken) bundle.value = null
      } finally {
        if (token === bundleToken) bundling.value = false
      }
    }, EXPORT_DEBOUNCE_MS)
  },
  { immediate: true },
)

const bundleBytes = computed(() => bundle.value?.bytes || 0)
const sizeLabel = computed(() => formatBytes(bundleBytes.value))
const tokenLabel = computed(() => {
  const t = estimateTokens(bundleBytes.value)
  return t >= 1000 ? `~${Math.round(t / 1000)}k tokens` : `~${t} tokens`
})
const isBig = computed(() => bundleBytes.value > BIG_CLIPBOARD_BYTES)

// Wo im Text welche Klasse steht (vom Server, s. `exportAll`). Ohne diese Landkarte koennte der
// Hover nirgends hinspringen, und die Liste wuesste nicht, wie schwer eine Klasse wiegt.
const spanById = computed(() => new Map((bundle.value?.files || []).map((f) => [f.fileId, f])))

// ⚠️ Der Umfang je Klasse wird GEMERKT, nicht nur angezeigt. Er kommt aus dem Export, und der
// kennt nur die ausgewaehlten Klassen – eine abgewaehlte haette ihre Zahl also sofort wieder
// verloren, ausgerechnet in dem Moment, in dem man sie mit den anderen vergleichen will. Die
// Zahlen aendern sich ohnehin nicht, solange der Quelltext derselbe ist.
const sizeById = ref(new Map())
watch(
  () => bundle.value?.files,
  (list) => {
    if (!list?.length) return
    const next = new Map(sizeById.value)
    for (const f of list) next.set(f.fileId, { lines: f.lines, bytes: f.bytes })
    sizeById.value = next
  },
)
watch(applied, () => {
  sizeById.value = new Map()
})

// --- Die Vorschau ist ein FENSTER auf den Text -----------------------------------------------
// ⚠️ Den ganzen Text zu rendern geht nicht: zwanzig Klassen sind schnell ein paar tausend Zeilen,
// und die entstehen bei JEDEM Haken neu. Also ein Fenster fester Groesse – aber eines, das dem
// Interesse folgt statt stur bei Zeile 1 zu stehen: der Hover ueber einer Klasse zieht es zu ihr,
// der aktive Suchtreffer ebenso. Gezaehlt und gesucht wird trotzdem im GANZEN Text (sonst waere
// „3 von 47" eine Aussage ueber den Ausschnitt statt ueber das Buendel).
const WINDOW_LINES = 600
// So viele Zeilen bleiben ueber der angefahrenen Stelle stehen – ein Sprung, der die Zeile an den
// oberen Rand setzt, verliert den Zusammenhang davor.
const WINDOW_LEAD = 12
const windowStart = ref(0)
const previewBody = ref(null)

const allLines = computed(() => (bundle.value?.text || '').split('\n'))
// Zeichen-Offset jeder Zeile im vollen Text – die Bruecke zwischen der Suche (rechnet auf dem
// ganzen Text) und dem gerenderten Fenster (kennt nur seinen Ausschnitt).
const lineOffsets = computed(() => {
  const offs = new Array(allLines.value.length)
  let o = 0
  allLines.value.forEach((l, i) => {
    offs[i] = o
    o += l.length + 1
  })
  return offs
})
const lineOfOffset = (off) => {
  const offs = lineOffsets.value
  let lo = 0
  let hi = offs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offs[mid] <= off) lo = mid
    else hi = mid - 1
  }
  return lo
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// --- Eine Farbe je Klasse, links wie rechts --------------------------------------------------
// ⚠️ Der Hover beantwortet „wo steckt DIESE Klasse?" – aber nur für eine, und nur solange man
// zeigt. Die Frage davor lautet „welcher Block ist überhaupt welche Klasse?", und ein Text aus
// zwanzig aneinandergehängten Quelltexten beantwortet sie von sich aus gar nicht: zwischen zwei
// Klassen steht eine Leerzeile, sonst nichts. Also bekommt jede Klasse eine Identitätsfarbe und
// trägt sie an BEIDEN Stellen – dieselbe Mechanik und dieselben Tokens wie die Methodenfarben im
// Kanten-Panel (`--mc-*`), also keine neue Farbsprache.
//
// Die Reihenfolge kommt aus `bundle.files`, nicht aus der Trefferliste: das ist die Reihenfolge
// im TEXT, und nur so unterscheiden sich zwei untereinander stehende Blöcke sicher.
const colorByFile = computed(() =>
  buildMethodColorMap((bundle.value?.files || []).map((f) => f.fileId)),
)

// Farbindex je ABSOLUTER Zeile. Kopf, Package-Trenner und die Leerzeilen dazwischen gehören zu
// keiner Klasse und bleiben neutral – ein durchgehend gefärbter Text hätte keine Gliederung mehr,
// sondern nur noch Farbe.
const colorByLine = computed(() => {
  const arr = new Int8Array(allLines.value.length).fill(-1)
  for (const f of bundle.value?.files || []) {
    const idx = colorByFile.value.get(f.fileId)
    if (idx == null) continue
    for (let l = f.startLine; l < f.startLine + f.lines && l <= arr.length; l++) arr[l - 1] = idx
  }
  return arr
})

// --- Syntaxfarben, aber nur dort, wo man hinsieht -------------------------------------------
// ⚠️ **Der Fokus zeigt sich am CODE selbst, nicht nur an seinem Grund.** Ein Bündel ist erst
// einmal eine Wand aus Text; ihn durchgehend einzufärben macht sie bunt, nicht lesbar (und wäre
// ein Shiki-Lauf über hunderte Kilobyte bei jedem Haken). Also bekommt genau der Abschnitt, auf
// den man zeigt, seine Syntaxfarben – Keywords, Typen, Strings –, und alles andere bleibt ruhig.
// Das ist derselbe Gedanke wie beim Dämpfen im Graphen, nur andersherum: statt das Umfeld
// wegzunehmen, wird das Gemeinte reicher.
//
// ⚠️ **Gehighlightet wird auf dem SERVER** (`source-window?raw=1`) – kein zweiter Highlighter im
// Client, dieselbe Regel wie überall. `raw=1` ist dabei Pflicht: der Bündeltext kommt aus
// `raw_source`, die übliche Antwort ist eingerückt (`reindentJava`), und eingesetzt in einen
// nicht eingerückten Text spränge die Einrückung beim Hover um und die Suchoffsets lägen daneben.
// Gemerkt wird je Klasse – ein zweiter Hover auf dieselbe kostet nichts.
const shikiByFile = ref(new Map())
let shikiToken = 0

async function ensureShiki(fileId) {
  if (!fileId || shikiByFile.value.has(fileId)) return
  const token = ++shikiToken
  try {
    const win = await api.getJavaSourceWindow(fileId, 1, { full: true, raw: true })
    // Nur der INHALT jeder Zeile wird übernommen: die Token-Spans tragen die Shiki-Variablen,
    // die Zeilenhülle stellen wir selbst (mit `data-line` und der Klassenfarbe).
    const doc = new DOMParser().parseFromString(win.html || '', 'text/html')
    const lines = [...doc.querySelectorAll('.shiki .line')].map((el) => el.innerHTML)
    if (!lines.length || token !== shikiToken) return
    const next = new Map(shikiByFile.value)
    next.set(fileId, lines)
    shikiByFile.value = next
  } catch {
    /* Ohne Syntaxfarben bleibt der Abschnitt einfarbig – das ist kein Fehler, nur weniger. */
  }
}
watch(applied, () => {
  shikiByFile.value = new Map()
})

// Das Fenster als EIN HTML-String, Zeile für Zeile als `.line` – dieselbe Struktur, die Shiki
// liefert. Damit gelten `shikiText`/`paintMatches` unveraendert (ein zweiter Markierungsweg fuer
// denselben Zweck waere genau die Doppelung, gegen die die Helfer einmal gebaut wurden).
// `v-html` statt `v-for`: `paintMatches` zerschneidet Textknoten, und Vue darf sie danach nicht
// mehr als seine eigenen betrachten.
//
// Die Hervorhebung des gehoverten Abschnitts entsteht HIER mit, nicht in einem zweiten Durchgang
// am DOM: seit die Syntaxfarben am selben Zustand hängen, wäre ein getrennter Weg dieselbe
// Rechnung zweimal – und die beiden könnten auseinanderlaufen.
const windowHtml = computed(() => {
  const from = windowStart.value
  const lines = allLines.value.slice(from, from + WINDOW_LINES)
  if (!lines.length) return ''
  const colors = colorByLine.value
  const lit = spanById.value.get(litId.value) || null
  const litCode = lit ? shikiByFile.value.get(lit.fileId) : null
  return lines
    .map((l, i) => {
      const abs = from + i + 1
      const c = colors[from + i]
      // Die Farbe steht als KLASSE am Element, nicht als Inline-Style: sechs CSS-Regeln gegen
      // sechshundert Style-Attribute, und der Ton bleibt damit an einer Stelle definiert.
      const tint = c >= 0 ? ` tp-cc tp-c${c}` : ''
      const inLit = lit && abs >= lit.startLine && abs < lit.startLine + lit.lines
      // Die Shiki-Zeile wird über den Abstand zum Klassenanfang zugeordnet – beide Seiten zählen
      // denselben `raw_source`, also ist der Index verlässlich. Fehlt sie (noch nicht geladen,
      // Zeile jenseits des Deckels), bleibt es beim einfachen Text.
      const code = inLit && litCode ? litCode[abs - lit.startLine] : null
      const body = code != null ? code : escapeHtml(l)
      return `<span class="line${tint}${inLit ? ' tp-lit' : ''}" data-line="${abs}">${body}</span>`
    })
    .join('')
})
const windowOffset = computed(() => lineOffsets.value[windowStart.value] ?? 0)
const windowEndLine = computed(() => Math.min(allLines.value.length, windowStart.value + WINDOW_LINES))
const hiddenBefore = computed(() => windowStart.value)
const hiddenAfter = computed(() => Math.max(0, allLines.value.length - windowEndLine.value))

// Eine Zeile ins Bild holen. Das Fenster wandert nur, wenn sie ausserhalb liegt – sonst spraenge
// es bei jedem Hover, obwohl schon alles zu sehen ist.
async function revealLine(line1) {
  const idx = Math.max(0, line1 - 1)
  if (idx < windowStart.value || idx >= windowStart.value + WINDOW_LINES - 2) {
    windowStart.value = Math.max(0, idx - WINDOW_LEAD)
  }
  await nextTick()
  scrollToLine(idx + 1)
}
function scrollToLine(line1) {
  const box = previewBody.value
  const el = box?.querySelector(`.line[data-line="${line1}"]`)
  if (!box || !el) return
  const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
  box.scrollTop = Math.max(0, box.scrollTop + delta - box.clientHeight / 4)
}

// Neuer Text -> zurueck an den Anfang. Ein Fenster, das nach einem Haken irgendwo mitten im alten
// Stand stehen bleibt, zeigt eine Stelle, nach der niemand gefragt hat.
watch(
  () => bundle.value?.text,
  () => {
    windowStart.value = 0
    if (previewBody.value) previewBody.value.scrollTop = 0
  },
)

// --- Hover: die Klasse im Buendel zeigen ------------------------------------------------------
// ⚠️ Der Hover WECHSELT NICHTS – er fuehrt hin. Die rechte Spalte beantwortet „was landet in der
// Ablage?", und eine Klasse einzeln daraufzulegen hiesse, diese Antwort bei jeder Mausbewegung
// gegen eine andere zu tauschen. Stattdessen faehrt das Fenster zu ihrem Abschnitt und markiert
// ihn: dieselbe Frage, nur an der richtigen Stelle. Wer die Klasse fuer sich sehen will, klickt.
// Verweildauer wie im Graphen und in der Palette: Hover ist eine Absicht, keine Beruehrung.
//
// ⚠️ **Der Weg IN den Text ist selbst eine Geste – dort wird aus „zeig mir wo" ein „ich lese das
// jetzt".** Ein Hover, der genau in dem Moment erlischt, in dem man ihn benutzen will, ist die
// Sackgasse dieser Ansicht gewesen: hingezeigt, hingefahren, Markierung weg, und der Abschnitt
// ist in einem Text aus zwanzig Quelltexten nicht wiederzufinden. Also wandert der Hover beim
// Uebertritt in die Vorschau in einen GEHALTENEN Zustand (`heldId`) – gemalt wird `litId`, also
// dasselbe eine Ziel, dieselbe Farbe, derselbe Weg. Zwei Festlegungen:
//   (1) Zwischen Zeile und Text liegen ein paar Pixel Nichts. Deshalb erlischt `hoverId` beim
//       Verlassen nicht sofort, sondern nach `HANDOVER_MS` – ohne die Schonfrist waere die
//       Bewegung ein Flackern, und die Uebergabe haette nie stattgefunden.
//   (2) Losgelassen wird nur auf ANSAGE: eine andere Zeile hovern, Esc, oder das „×" am Chip.
//       Die Vorschau zu verlassen beendet nichts – der Weg zum Kopierknopf oder in die
//       Buendelsuche darf nicht kosten, was man sich gerade aufgeschlagen hat.
const HOVER_INTENT_MS = 180
const HANDOVER_MS = 300
const hoverId = ref(null)
const heldId = ref(null)
let hoverTimer = null
let handoverTimer = null

// Was leuchtet: der Zeiger schlaegt das Gehaltene. Eine Quelle fuer beide Faelle – der gehaltene
// Zustand ist derselbe Fokus, nur ohne Zeiger darauf, und braucht deshalb keine zweite Darstellung.
const litId = computed(() => hoverId.value ?? heldId.value)
const heldHit = computed(() =>
  heldId.value ? topic.value.hits.find((h) => h.fileId === heldId.value) || null : null,
)

function hoverHit(hit) {
  clearTimeout(hoverTimer)
  clearTimeout(handoverTimer)
  // Eine Klasse, die nicht ausgewaehlt ist, steht nicht im Text – dorthin zu springen gaebe es
  // nichts. Ihr Weg ist der Knopf in der Zeile.
  if (!spanById.value.has(hit.fileId)) return
  hoverTimer = setTimeout(() => {
    const span = spanById.value.get(hit.fileId)
    if (!span || pane.value !== 'bundle') return
    hoverId.value = hit.fileId
    // Eine neue Absicht ersetzt die alte – auch eine gehaltene. Das steht IM Timeout und nicht
    // davor: ein Wischen ueber die Liste ist keine Absicht und darf nichts loslassen.
    heldId.value = null
    // Erst hinfahren, dann einfärben: der Sprung ist sofort da, die Syntaxfarben tropfen nach,
    // sobald der Server geantwortet hat. Umgekehrt stünde man vor einem Ladezustand für etwas,
    // das man ohnehin schon lesen kann.
    revealLine(span.startLine)
    ensureShiki(hit.fileId)
  }, HOVER_INTENT_MS)
}
function leaveHits() {
  clearTimeout(hoverTimer)
  if (!hoverId.value) return
  clearTimeout(handoverTimer)
  handoverTimer = setTimeout(() => {
    hoverId.value = null
  }, HANDOVER_MS)
}

// Die Vorschau faengt den Hover ein, der gerade unterwegs zu ihr ist. Verschoben statt kopiert:
// `litId` aendert sich dabei um kein Bit, die Uebergabe ist im Bild also gar nicht zu sehen –
// genau das ist der Punkt.
function catchHover() {
  if (pane.value !== 'bundle' || !hoverId.value) return
  clearTimeout(handoverTimer)
  heldId.value = hoverId.value
  hoverId.value = null
}
function releaseHold() {
  clearTimeout(handoverTimer)
  heldId.value = null
  hoverId.value = null
}

// Eine abgewaehlte Klasse steht nicht mehr im Text – ein Chip, der auf einen Abschnitt zeigt, den
// es nicht gibt, ist eine Falschauskunft.
watch(spanById, (map) => {
  if (heldId.value && !map.has(heldId.value)) heldId.value = null
})

// ⚠️ **Esc hat hier zwei Bedeutungen und genau EINE Reihenfolge** – entschieden an dieser einen
// Stelle, nicht in zwei Listenern (gleiche Regel wie `Ctrl+F` in der Code-Ansicht: das Kuerzel
// trifft, was im Blick ist). Gemessen war die falsche Reihenfolge kein Schoenheitsfehler: der
// Fokus liegt nach dem Laden im Suchfeld, also fing dessen eigener Esc-Handler den Griff nach dem
// Loslassen ab – und loeschte das ganze THEMA, waehrend man gerade eine Klasse las.
//   1. etwas gehalten? -> loslassen
//   2. sonst, im Themenfeld -> Begriff leeren
// `defaultPrevented` laesst der Buendel-Suchleiste ihr eigenes Esc: sie hat den Tastendruck dann
// schon beantwortet, und zweimal zu antworten ist keine Staffelung, sondern ein Nebeneffekt.
function onKeydown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (heldId.value) {
    e.preventDefault()
    releaseHold()
    return
  }
  if (e.target === inputEl.value && term.value) {
    e.preventDefault()
    term.value = ''
  }
}

// --- Suche ueber das ganze Buendel ------------------------------------------------------------
// Dieselbe Leiste und dieselbe Musterlogik wie im Source-Tab und in der Suchpalette
// (`findMatches`): wer ein Buendel vor sich hat, sucht darin dasselbe, was er in einer Klasse
// suchen wuerde – nur eben ueber alle ausgewaehlten auf einmal. Genau das kann die Einzelansicht
// nicht, und deshalb sitzt die Suche hier und nicht dort.
const bundleQuery = ref('')
const bundleOpts = ref({ caseSensitive: false, wholeWord: false, regex: false })
const bundleCursor = ref(0)

const bundleResult = computed(() =>
  bundle.value?.text
    ? findMatches(bundle.value.text, { query: bundleQuery.value, ...bundleOpts.value })
    : { matches: [], capped: false, error: '' },
)
const bundleMatches = computed(() => bundleResult.value.matches)
const bundleActive = computed(() => {
  const n = bundleMatches.value.length
  if (!n) return -1
  return ((bundleCursor.value % n) + n) % n
})
const bundleCounter = computed(() => {
  if (!bundleQuery.value) return ''
  if (bundleResult.value.error) return 'Invalid regex'
  if (!bundleMatches.value.length) return 'No results'
  return `${bundleActive.value + 1}/${bundleMatches.value.length}${bundleResult.value.capped ? '+' : ''}`
})
const bundleCounterTitle = computed(() => {
  if (bundleResult.value.error) return bundleResult.value.error
  if (bundleResult.value.capped) return `Showing the first ${MATCH_LIMIT} matches`
  return ''
})
const bundleFailed = computed(
  () => !!bundleQuery.value && (!!bundleResult.value.error || !bundleMatches.value.length),
)

function setBundleQuery(v) {
  bundleQuery.value = v
  bundleCursor.value = 0
}
function toggleBundleOpt(key) {
  bundleOpts.value = { ...bundleOpts.value, [key]: !bundleOpts.value[key] }
  bundleCursor.value = 0
}
function stepBundleMatch(delta) {
  if (bundleMatches.value.length) bundleCursor.value += delta
}

// Der aktive Treffer zieht das Fenster mit – ein Zaehler, der auf eine Stelle zeigt, die man nicht
// sehen kann, ist keine Auskunft.
watch(bundleActive, async (i) => {
  const m = bundleMatches.value[i]
  if (!m || pane.value !== 'bundle') return
  await revealLine(lineOfOffset(m.from) + 1)
})

// Markieren: die Offsets gelten im GANZEN Text, das gerenderte Fenster kennt nur seinen Ausschnitt
// – also werden sie um den Fensteranfang verschoben und alles ausserhalb faellt weg. Der aktive
// Treffer behaelt dabei seine Kennzeichnung, sofern er im Bild ist.
watch([bundleMatches, bundleActive, windowHtml], async () => {
  await nextTick()
  const box = previewBody.value
  if (!box) return
  if (!bundleMatches.value.length) {
    clearMatches(box)
    return
  }
  const from = windowOffset.value
  const to = from + (allLines.value.slice(windowStart.value, windowEndLine.value).join('\n').length || 0)
  const local = []
  let activeLocal = -1
  bundleMatches.value.forEach((m, i) => {
    if (m.to <= from || m.from >= to) return
    if (i === bundleActive.value) activeLocal = local.length
    local.push({ from: m.from - from, to: m.to - from })
  })
  paintMatches(box, local, activeLocal)
  if (activeLocal >= 0) {
    const hit = box.querySelector('.cs-hit--active')
    if (hit) {
      const delta = hit.getBoundingClientRect().top - box.getBoundingClientRect().top
      box.scrollTop = Math.max(0, box.scrollTop + delta - box.clientHeight / 3)
    }
  }
})

// --- Eine Klasse fuer sich --------------------------------------------------------------------
// Der zweite Modus derselben Spalte (Umschalter „Bundle · Class", `v-show` – dieselbe Bauart wie
// „Class · Relation" in der Code-Ansicht). Er beantwortet die andere Frage: nicht „was nehme ich
// mit?", sondern „was ist das ueberhaupt?". Fuer eine Klasse, die gerade NICHT ausgewaehlt ist,
// ist er der einzige Weg – sie steht im Buendeltext ja nicht drin.
const pane = ref('bundle')
const openClass = ref(null)
const classLoading = ref(false)
const classSince = ref(0)
let classToken = 0

async function showClass(hit) {
  clearTimeout(hoverTimer)
  hoverId.value = null
  pane.value = 'class'
  const token = ++classToken
  openClass.value = { ...hit, html: '', totalLines: null }
  classLoading.value = true
  classSince.value = Date.now()
  try {
    // `line: 1` + `full` = die ganze Klasse; markiert wird nichts, es ist keine Fundstelle gemeint.
    const win = await api.getJavaSourceWindow(hit.fileId, hit.classLine || 1, { full: true })
    if (token !== classToken) return
    openClass.value = {
      ...hit,
      html: addLineNumbers(win.html, win.startLine, { keepBlank: true, highlight: win.hitLine }),
      totalLines: win.totalLines,
      truncated: win.truncated,
    }
  } catch {
    if (token === classToken) openClass.value = { ...hit, html: '', failed: true }
  } finally {
    if (token === classToken) classLoading.value = false
  }
}
function backToBundle() {
  pane.value = 'bundle'
}

// --- Mitnehmen ------------------------------------------------------------------------------
const copied = ref(false)
const copyFailed = ref(false)

async function copyBundle() {
  if (!bundle.value?.text) return
  copyFailed.value = false
  const ok = await copyToClipboard(bundle.value.text)
  copied.value = ok
  copyFailed.value = !ok
  if (ok) setTimeout(() => (copied.value = false), 2500)
}

// Download ohne zweiten Request: der Text liegt bereits im Speicher (gleiche Bauart wie im
// Export-Modal, das hier der Rueckfall fuer alles ist, was der Zwischenablage zu gross ist).
function downloadBundle() {
  if (!bundle.value?.text) return
  const slug = applied.value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  const url = URL.createObjectURL(new Blob([bundle.value.text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `wikit-topic-${slug || 'bundle'}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// --- Absprung -------------------------------------------------------------------------------
// Ein Buendel beantwortet „was gehoert dazu?" – die naechste Frage ist regelmaessig „und was macht
// die Klasse?". Derselbe Handoff wie aus der Palette und aus den Insights.
function openInCode(hit) {
  lastFileId.value = hit.fileId
  lastTargetLine.value = hit.classLine || null
  router.push('/code')
}

// --- Ruhezustand ----------------------------------------------------------------------------
// Vorschlaege statt eines leeren Feldes: die haeufigsten Package-Segmente sind die Themen, die
// diese Codebasis tatsaechlich hat – und sie machen in einem Zug klar, was hier einzugeben ist.
const suggestions = computed(() => {
  const count = new Map()
  for (const f of files.value) {
    for (const part of String(f.package || '').split('.')) {
      if (part.length < 3) continue
      count.set(part, (count.get(part) || 0) + 1)
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name]) => name)
})

function useSuggestion(s) {
  term.value = s
  applied.value = s
  inputEl.value?.focus()
}

onMounted(() => {
  inputEl.value?.focus()
  // Die Kanten liegen sonst nur vor, wenn vorher `/code` offen war – ohne sie faende der
  // Nachbarschafts-Schalter nichts und saehe aus, als gaebe es keine Verbindungen.
  if (!edges.value.length) fetchEdges()
  if (applied.value) runSearch(applied.value, termOpts.value)
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  clearTimeout(termTimer)
  clearTimeout(bundleTimer)
  clearTimeout(hoverTimer)
  clearTimeout(handoverTimer)
  window.removeEventListener('keydown', onKeydown)
  abortSearch()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- ======================= Kopfzeile ======================= -->
    <header class="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-5 py-3 backdrop-blur">
      <div class="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon icon="lucide:boxes" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h1 class="text-base font-bold text-[var(--color-text)]">Topic bundle</h1>
          <!-- „Was sehe ich hier?" steht immer sichtbar, nicht in einem Tooltip – gleiche Regel
               wie in den Insights: wer nicht weiss, was er sieht, sucht auch keine Erklaerung. -->
          <p class="text-xs text-[var(--color-text-muted)]">
            Every class around one topic — collected, picked, and copied as one text.
          </p>
        </div>

        <div class="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none sm:basis-[34rem]">
          <!-- Die drei Schalter stehen IM Feld, nicht daneben: sie ändern nicht das Ergebnis,
               sondern wie der Begriff gelesen wird – dieselbe Bauart und dieselben Icons wie in
               der Suchpalette, im Source-Tab und in der Bündelleiste weiter unten. -->
          <div
            class="flex min-w-0 flex-1 items-center gap-1 rounded-lg border bg-[var(--color-surface-2)] pl-3 pr-1 transition"
            :class="patternError
              ? 'border-[var(--color-danger)]'
              : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'"
          >
            <Icon
              icon="lucide:search"
              class="h-4 w-4 shrink-0"
              :class="patternError ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]'"
            />
            <input
              ref="inputEl"
              v-model="term"
              type="text"
              spellcheck="false"
              :aria-invalid="!!patternError"
              :placeholder="termOpts.regex ? 'A pattern — e.g. ^Jt.*(Repo|Dao)$' : 'A topic, a prefix, a name — e.g. jt'"
              class="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
              @keydown.enter.prevent="applied = term.trim()"
            />
            <!-- Kurz im Feld, ausführlich am Zeiger und im leeren Ergebnis – dieselbe Staffelung
                 wie in der Bündelleiste. -->
            <span
              v-if="patternError"
              v-tip="patternError"
              class="shrink-0 whitespace-nowrap px-0.5 font-mono text-3xs text-[var(--color-danger)]"
            >Invalid</span>
            <button
              v-if="term"
              type="button"
              class="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Clear"
              aria-label="Clear"
              @click="term = ''"
            >
              <Icon icon="lucide:x" class="h-3.5 w-3.5" />
            </button>
            <span class="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border)]" />
            <button
              v-for="o in SEARCH_TOGGLES"
              :key="o.key"
              v-tip="o.tip"
              type="button"
              class="grid h-6 w-6 shrink-0 place-items-center rounded transition"
              :class="termOpts[o.key]
                ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
              :aria-label="o.label"
              :aria-pressed="termOpts[o.key]"
              @click="toggleTermOpt(o.key)"
            >
              <Icon :icon="o.icon" class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- Der Schalter, der aus „heisst so" ein „hat damit zu tun" macht. Er steht neben dem
               Feld, weil er die FRAGE erweitert und nicht das Ergebnis filtert. -->
          <button
            v-tip="'Also collect classes that are one relation away from the ones found — they arrive unchecked.'"
            type="button"
            class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-2xs font-semibold transition"
            :class="withNeighbours
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
            :aria-pressed="withNeighbours"
            @click="withNeighbours = !withNeighbours"
          >
            <Icon icon="lucide:share-2" class="h-3.5 w-3.5" />
            Neighbours
          </button>
        </div>
      </div>
    </header>

    <!-- ======================= Inhalt ======================= -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <div class="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-5 py-4 lg:flex-row">
        <!-- ---------- Links: was gefunden wurde ---------- -->
        <section class="flex min-h-0 flex-col lg:w-[26rem] lg:shrink-0">
          <!-- Kein Bestand: dann ist das leere Ergebnis keine Aussage ueber das Thema. -->
          <div
            v-if="!files.length"
            class="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center"
          >
            <Icon icon="lucide:braces" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
            <p class="mt-2 text-sm text-[var(--color-text)]">No classes yet.</p>
            <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
              Import some Java in the code view first — a topic is collected from what is stored.
            </p>
            <RouterLink
              to="/code"
              class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-2xs font-semibold text-[var(--color-accent-contrast)]"
            >
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5" /> Go to code
            </RouterLink>
          </div>

          <!-- Ruhezustand: WAS eine Quelle beitraegt, steht hier einmal – danach sagt es der Chip
               an jedem Treffer. Ohne diese vier Zeilen ist „Named after it" nur eine Ueberschrift. -->
          <div v-else-if="!applied" class="min-h-0 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
            <p class="text-sm text-[var(--color-text)]">Type a topic above.</p>
            <p class="mt-1 text-2xs leading-relaxed text-[var(--color-text-muted)]">
              Four sources answer at once, and every hit says which one found it:
            </p>
            <ul class="mt-3 space-y-2">
              <li v-for="s in [
                { icon: 'lucide:braces', label: 'Named after it', hint: 'the class name or its package carries the term' },
                { icon: 'lucide:code-2', label: 'Mentions it in code', hint: 'the term appears somewhere in the source' },
                { icon: 'lucide:sparkles', label: 'About the topic', hint: 'the class is about this — without containing the word' },
                { icon: 'lucide:share-2', label: 'Connected to those', hint: 'one relation away, only with Neighbours on' },
              ]" :key="s.label" class="flex gap-2.5">
                <Icon :icon="s.icon" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span class="min-w-0 text-2xs leading-relaxed">
                  <span class="font-semibold text-[var(--color-text)]">{{ s.label }}</span>
                  <span class="text-[var(--color-text-muted)]"> — {{ s.hint }}</span>
                </span>
              </li>
            </ul>

            <!-- Die Schalter sind im Ruhezustand die einzige Stelle, an der jemand liest, was sie
                 tun – und vor allem, worauf sie NICHT wirken. -->
            <p class="mt-3 flex gap-2 text-2xs leading-relaxed text-[var(--color-text-muted)]">
              <Icon icon="lucide:regex" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                The three switches in the field decide how the term is read — case, whole word, and
                regular expression. Names and source follow them; meaning cannot.
              </span>
            </p>

            <template v-if="suggestions.length">
              <p class="mt-4 font-mono text-3xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Topics in this codebase
              </p>
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  v-for="s in suggestions"
                  :key="s"
                  type="button"
                  class="rounded-full border border-[var(--color-border)] px-2.5 py-1 font-mono text-2xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  @click="useSuggestion(s)"
                >{{ s }}</button>
              </div>
            </template>
          </div>

          <template v-else>
            <!-- Auswahlleiste: die Zahl, die unten am Knopf steht, wird hier gemacht. -->
            <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="font-mono text-2xs tabular-nums text-[var(--color-text)]">
                {{ selectedIds.length }} / {{ topic.hits.length }} selected
              </span>
              <div class="ml-auto flex items-center gap-1">
                <button
                  v-for="b in [
                    { label: 'All', fn: selectAll },
                    { label: 'None', fn: selectNone },
                    { label: 'Reset', fn: resetSelection },
                  ]"
                  :key="b.label"
                  type="button"
                  class="rounded px-1.5 py-0.5 text-2xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                  @click="b.fn()"
                >{{ b.label }}</button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <BusyState
                v-if="searching && !topic.hits.length"
                variant="panel"
                title="Collecting the topic…"
                detail="names, source lines and meaning"
                :since="searchedAt"
                :rows="5"
              />

              <!-- Ein kaputtes Muster ist kein leeres Ergebnis: „nichts gefunden" wäre hier eine
                   Aussage über die Codebasis, und die ist nicht gedeckt. -->
              <div v-else-if="patternError" class="px-4 py-10 text-center">
                <Icon icon="lucide:regex" class="mx-auto h-6 w-6 text-[var(--color-danger)]" />
                <p class="mt-2 text-sm text-[var(--color-text)]">That pattern does not parse.</p>
                <p class="mt-1 font-mono text-3xs leading-relaxed text-[var(--color-danger)]">{{ patternError }}</p>
                <p class="mt-2 text-2xs text-[var(--color-text-muted)]">
                  Fix it, or switch the regex button off to search for the text itself.
                </p>
              </div>

              <div v-else-if="!topic.hits.length" class="px-4 py-10 text-center">
                <Icon icon="lucide:boxes" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
                <p class="mt-2 text-sm text-[var(--color-text)]">Nothing on “{{ applied }}”.</p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  No class carries the name, mentions it, or is about it. Try a shorter term, or turn
                  Neighbours on once you have a first hit.
                </p>
                <!-- Ein aktiver Schalter ist die häufigste Erklärung für ein leeres Ergebnis –
                     und der einzige Teil der Frage, den man beim Lesen der Liste nicht sieht. -->
                <p v-if="activeToggles.length" class="mt-2 text-2xs text-[var(--color-text-muted)]">
                  <span class="font-semibold text-[var(--color-text)]">
                    {{ activeToggles.map((o) => o.label).join(' · ') }}
                  </span>
                  {{ activeToggles.length === 1 ? 'is' : 'are' }} on — turning
                  {{ activeToggles.length === 1 ? 'it' : 'them' }} off widens the search.
                </p>
              </div>

              <template v-else>
                <section v-for="g in groups" :key="g.kind" class="border-b border-[var(--color-border)] last:border-b-0">
                  <!-- Die Gruppenzeile ist zugleich der Schalter fuer die ganze Gruppe: „alle
                       Namenstreffer, keine Nachbarn" ist die haeufigste Auswahl ueberhaupt. -->
                  <button
                    v-tip="g.hint"
                    type="button"
                    class="flex w-full items-center gap-2 bg-[var(--color-surface-offset)]/50 px-3 py-1.5 text-left transition hover:bg-[var(--color-surface-offset)]"
                    @click="toggleGroup(g)"
                  >
                    <Icon
                      :icon="groupState(g) === 'all' ? 'lucide:check-square' : 'lucide:square'"
                      class="h-3.5 w-3.5 shrink-0"
                      :class="groupState(g) === 'none' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]'"
                    />
                    <Icon :icon="g.icon" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span class="font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                      {{ g.label }}
                    </span>
                    <span class="ml-auto font-mono text-3xs tabular-nums text-[var(--color-text-muted)]">
                      {{ g.items.length }}
                    </span>
                  </button>

                  <ul>
                    <!-- ⚠️ Der Hover fuehrt rechts HIN, er tauscht nichts aus: das Fenster faehrt
                         zum Abschnitt dieser Klasse und markiert ihn. Die gehoverte Zeile traegt
                         denselben Balken wie ihre Zeilen im Text – sonst ist nicht zu sehen, wer
                         von beiden gemeint ist. -->
                    <li
                      v-for="hit in g.items"
                      :key="hit.fileId"
                      class="tp-row flex items-start gap-2 border-t border-[var(--color-border)]/50 py-2 pl-2.5 pr-3 transition"
                      :style="methodColorVars(colorByFile.get(hit.fileId))"
                      :class="[
                        selected.has(hit.fileId) ? '' : 'opacity-55',
                        colorByFile.has(hit.fileId) ? 'tp-row--c' : '',
                        litId === hit.fileId ? 'tp-row--lit' : 'hover:bg-[var(--color-surface-offset)]/40',
                      ]"
                      @mouseenter="hoverHit(hit)"
                      @mouseleave="leaveHits()"
                    >
                      <button
                        type="button"
                        class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center"
                        :title="selected.has(hit.fileId) ? 'Leave it out' : 'Take it along'"
                        :aria-pressed="selected.has(hit.fileId)"
                        @click="toggle(hit.fileId)"
                      >
                        <Icon
                          :icon="selected.has(hit.fileId) ? 'lucide:check-square' : 'lucide:square'"
                          class="h-4 w-4"
                          :class="selected.has(hit.fileId) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
                        />
                      </button>

                      <button type="button" class="min-w-0 flex-1 text-left" @click="toggle(hit.fileId)">
                        <span class="block truncate text-[0.8125rem] font-semibold text-[var(--color-text)]">
                          {{ hit.className }}
                        </span>
                        <span class="block truncate font-mono text-3xs text-[var(--color-text-muted)]">
                          {{ hit.package || 'default package' }}
                        </span>
                        <!-- ⚠️ Der GRUND ist die halbe Ansicht: man entscheidet je Zeile, ob sie
                             mitkommt, und „source ×12" verlangt eine andere Antwort als
                             „connected to JTConverter". Mehrere Gruende stehen nebeneinander –
                             eine Klasse, die alle drei Quellen nennen, ist der sicherste Kandidat. -->
                        <span class="mt-1 flex flex-wrap gap-1">
                          <span
                            v-for="r in hit.reasons"
                            :key="r.kind"
                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs text-[var(--color-text-muted)]"
                          >
                            <Icon :icon="topicSource(r.kind).icon" class="h-2.5 w-2.5" />
                            {{ r.detail }}<template v-if="r.count > 1"> +{{ r.count - 1 }}</template>
                          </span>
                        </span>
                        <!-- Der Umfang der Klasse: die Zahl, an der man entscheidet, wen man
                             wieder abwählt, wenn das Bündel zu schwer wird. Echte Zeilen und Bytes
                             aus dem Export – eine Schätzung wäre hier wertlos. -->
                        <span
                          v-if="sizeById.get(hit.fileId)"
                          class="mt-1 block font-mono text-3xs tabular-nums text-[var(--color-text-muted)] opacity-80"
                        >
                          {{ sizeById.get(hit.fileId).lines }} lines ·
                          {{ formatBytes(sizeById.get(hit.fileId).bytes) }}
                        </span>
                      </button>

                      <span class="mt-0.5 flex shrink-0 flex-col gap-0.5">
                        <!-- Die Klasse für sich ansehen: der einzige Weg für eine, die gerade nicht
                             ausgewählt ist – sie steht im Bündeltext nicht drin. -->
                        <button
                          type="button"
                          class="grid h-5 w-5 place-items-center rounded transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-accent)]"
                          :class="openClass?.fileId === hit.fileId && pane === 'class'
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text-muted)]'"
                          title="Show this class on its own"
                          aria-label="Show this class on its own"
                          @click="showClass(hit)"
                        >
                          <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          class="grid h-5 w-5 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-accent)]"
                          title="Open this class in the code view"
                          aria-label="Open this class in the code view"
                          @click="openInCode(hit)"
                        >
                          <Icon icon="lucide:arrow-up-right" class="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </li>
                  </ul>
                </section>
              </template>
            </div>

            <!-- Was der Bericht NICHT gesehen hat, gehoert unter den Bericht. -->
            <p v-if="topic.truncated" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:info" class="mt-px h-3 w-3 shrink-0" />
              Showing the strongest {{ MAX_CANDIDATES }} — narrow the topic for the rest.
            </p>
            <p v-if="codeNote" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:info" class="mt-px h-3 w-3 shrink-0" />
              {{ codeNote }}
            </p>
            <p v-if="meaningNote" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:sparkles" class="mt-px h-3 w-3 shrink-0" />
              {{ meaningNote }}
            </p>
          </template>
        </section>

        <!-- ---------- Rechts: was in der Ablage landet ---------- -->
        <!-- ZWEI Modi, EINE Spalte (`v-show`, damit Scrollstand und Suchposition des Bündels einen
             Abstecher in eine Klasse überleben – dieselbe Bauart wie „Class · Relation" in der
             Code-Ansicht). Der Umschalter erscheint erst, wenn es etwas zu schalten gibt. -->
        <!-- ⚠️ `mouseenter` auf der GANZEN Spalte, nicht nur auf dem Text: der Hover, der gerade
             von links unterwegs ist, wird hier eingefangen (`catchHover`) und damit gehalten.
             Wer über den Kopf oder die Suchleiste einfährt, meint dieselbe Klasse. -->
        <section
          class="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
          @mouseenter="catchHover()"
        >
          <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5">
            <template v-if="openClass">
              <div class="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5">
                <button
                  v-for="p in [
                    { id: 'bundle', label: 'Bundle', icon: 'lucide:clipboard-copy' },
                    { id: 'class', label: 'Class', icon: 'lucide:file-code' },
                  ]"
                  :key="p.id"
                  type="button"
                  class="inline-flex h-6 items-center gap-1 rounded px-2 text-2xs font-semibold transition"
                  :class="pane === p.id
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
                  :aria-pressed="pane === p.id"
                  @click="pane = p.id"
                >
                  <Icon :icon="p.icon" class="h-3 w-3" />
                  {{ p.label }}
                </button>
              </div>
            </template>
            <Icon v-else icon="lucide:clipboard-copy" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />

            <h2 v-if="pane === 'bundle'" class="min-w-0 truncate text-[0.8125rem] font-semibold text-[var(--color-text)]">
              What lands in your clipboard
            </h2>
            <h2 v-else class="flex min-w-0 items-baseline gap-2">
              <span class="truncate text-[0.8125rem] font-semibold text-[var(--color-text)]">{{ openClass?.className }}</span>
              <span class="truncate font-mono text-3xs text-[var(--color-text-muted)]">
                {{ openClass?.package || 'default package' }}
              </span>
            </h2>

            <!-- Der gehaltene Zustand ist SICHTBAR und hat einen Weg hinaus – ein Modus, den man
                 nur an der Färbung erkennt und nicht beenden kann, ist eine Falle. Der Punkt
                 trägt die Identitätsfarbe der Klasse: dieselbe wie ihr Balken links und rechts. -->
            <button
              v-if="pane === 'bundle' && heldHit"
              v-tip="'Kept in view while you read it. Hover another class to move on, Esc to let go.'"
              type="button"
              class="tp-held inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full border px-2 text-2xs transition"
              :style="methodColorVars(colorByFile.get(heldHit.fileId))"
              aria-label="Stop keeping this class in view"
              @click="releaseHold()"
            >
              <span class="tp-held-dot h-1.5 w-1.5 shrink-0 rounded-full" />
              <span class="min-w-0 truncate font-semibold text-[var(--color-text)]">{{ heldHit.className }}</span>
              <Icon icon="lucide:x" class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
            </button>

            <span
              v-if="pane === 'bundle' && bundle?.classes"
              v-tip="'The token count is an estimate — roughly 3.5 characters per token.'"
              class="ml-auto shrink-0 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]"
            >
              {{ bundle.classes }} classes · {{ bundle.packages }} packages · {{ sizeLabel }} · {{ tokenLabel }}
            </span>
            <span
              v-else-if="pane === 'class' && openClass?.totalLines"
              class="ml-auto shrink-0 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]"
            >
              {{ openClass.totalLines }} lines
            </span>
          </header>

          <!-- Suchleiste des Bündels: gleiche Bauart wie im Source-Tab, aber sie durchsucht ALLE
               ausgewählten Klassen auf einmal. Genau das kann die Einzelansicht nicht, und deshalb
               sitzt sie hier und nicht dort. -->
          <div
            v-show="pane === 'bundle' && bundle?.text"
            class="flex w-full min-w-0 flex-wrap items-center gap-0.5 border-b border-[var(--color-border)] px-4 py-1.5"
          >
            <div
              class="flex w-full min-w-0 flex-wrap items-center gap-0.5 rounded-lg border bg-[var(--color-surface)] px-1.5 py-0.5 transition"
              :class="bundleFailed ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'"
            >
              <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <input
                :value="bundleQuery"
                type="text"
                placeholder="Search across every selected class…"
                aria-label="Search the bundle"
                spellcheck="false"
                class="min-w-[8rem] flex-1 bg-transparent py-0.5 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                @input="setBundleQuery($event.target.value)"
                @keydown.enter.prevent="stepBundleMatch($event.shiftKey ? -1 : 1)"
                @keydown.esc.prevent="setBundleQuery('')"
              />
              <span
                v-if="bundleCounter"
                :title="bundleCounterTitle"
                class="shrink-0 whitespace-nowrap px-0.5 font-mono text-3xs tabular-nums"
                :class="bundleFailed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
              >{{ bundleCounter }}</span>
              <button
                v-for="o in SEARCH_TOGGLES"
                :key="o.key"
                type="button"
                class="grid h-5 w-5 shrink-0 place-items-center rounded transition"
                :class="bundleOpts[o.key]
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
                :title="o.title"
                :aria-pressed="bundleOpts[o.key]"
                @click="toggleBundleOpt(o.key)"
              >
                <Icon :icon="o.icon" class="h-3 w-3" />
              </button>
              <span class="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--color-border)]" />
              <button
                v-for="n in [
                  { icon: 'lucide:chevron-up', delta: -1, title: 'Previous match (Shift+Enter)' },
                  { icon: 'lucide:chevron-down', delta: 1, title: 'Next match (Enter)' },
                ]"
                :key="n.delta"
                type="button"
                class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-30"
                :disabled="!bundleMatches.length"
                :title="n.title"
                @click="stepBundleMatch(n.delta)"
              >
                <Icon :icon="n.icon" class="h-3 w-3" />
              </button>
            </div>
          </div>

          <!-- ===== Modus 1: das Bündel ===== -->
          <div v-show="pane === 'bundle'" ref="previewBody" class="min-h-0 flex-1 overflow-auto p-4">
            <BusyState
              v-if="bundling && !bundle"
              variant="panel"
              title="Building the bundle…"
              detail="reading the selected sources"
              :since="bundleSince"
              :rows="6"
            />

            <div v-else-if="!selectedIds.length" class="grid h-full place-items-center px-4 text-center">
              <div>
                <Icon icon="lucide:clipboard-copy" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
                <p class="mt-2 text-sm text-[var(--color-text)]">Nothing picked.</p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  Tick the classes on the left — their full source shows up here, exactly as it will
                  be copied. Hovering a class jumps to its part.
                </p>
              </div>
            </div>

            <template v-else-if="bundle?.text">
              <p v-if="isBig" class="notice-warning mb-3 flex gap-2 rounded-lg px-3 py-2 text-2xs leading-relaxed">
                <Icon icon="lucide:alert-triangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{{ sizeLabel }} is a lot for a clipboard — the download is the safer way here.</span>
              </p>
              <!-- Was oberhalb des Fensters liegt, wird angeschrieben – sonst liest sich der obere
                   Rand wie der Anfang des Textes. -->
              <p v-if="hiddenBefore" class="mb-1 font-mono text-3xs text-[var(--color-text-muted)] opacity-70">
                ↑ {{ hiddenBefore.toLocaleString('en-US') }} lines above — all of them are copied.
              </p>
              <!-- Bewusst ohne Syntax-Highlighting: die Frage ist „was landet in der Ablage?",
                   und die Antwort ist genau dieser Text. -->
              <pre class="topic-preview text-2xs leading-relaxed text-[var(--color-text-muted)]" v-html="windowHtml" />
              <p v-if="hiddenAfter" class="mt-1 font-mono text-3xs text-[var(--color-text-muted)] opacity-70">
                ↓ {{ hiddenAfter.toLocaleString('en-US') }} lines below — all of them are copied.
              </p>
            </template>
          </div>

          <!-- ===== Modus 2: eine Klasse für sich ===== -->
          <div v-show="pane === 'class'" class="min-h-0 flex-1 overflow-auto p-4">
            <BusyState
              v-if="classLoading"
              variant="panel"
              title="Opening the class…"
              :detail="openClass?.className || ''"
              :since="classSince"
              :rows="6"
            />
            <p v-else-if="openClass?.failed" class="notice-warning rounded-lg px-3 py-2 text-xs">
              This class could not be read.
            </p>
            <template v-else-if="openClass?.html">
              <div class="topic-class edge-code" v-html="openClass.html" />
              <p v-if="openClass.truncated" class="mt-2 font-mono text-3xs text-[var(--color-text-muted)]">
                Shown up to the cap — open it in the code view for the rest.
              </p>
            </template>
          </div>

          <footer class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
            <p v-if="copyFailed" class="w-full text-2xs text-[var(--color-danger)]">
              The clipboard refused the text — use Download instead.
            </p>
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[0.8125rem] font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40"
              :disabled="!bundle?.text"
              title="Save the bundle as a .txt file"
              @click="downloadBundle"
            >
              <Icon icon="lucide:download" class="h-4 w-4" />
              Download
            </button>
            <button
              type="button"
              class="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[0.8125rem] font-semibold shadow-sm transition disabled:opacity-40"
              :class="copied
                ? 'bg-[var(--color-success)] text-[var(--color-accent-contrast)]'
                : 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)]'"
              :disabled="!bundle?.text"
              @click="copyBundle"
            >
              <Icon :icon="copied ? 'lucide:check' : 'lucide:clipboard-copy'" class="h-4 w-4" />
              {{ copied ? 'Copied' : `Copy ${bundle?.classes || 0} classes` }}
            </button>
          </footer>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Der Ausschnitt behaelt seine Einrueckung – Umbruch waere hier eine Falschaussage ueber den Text,
   der so und nicht anders in der Ablage landet. */
.topic-preview {
  white-space: pre;
  font-family: var(--font-mono, ui-monospace, monospace);
}
/* Jede Zeile ist ein eigenes Element – die Bezugsgroesse fuer `paintMatches` und die einzige
   Moeglichkeit, den Abschnitt EINER Klasse zu markieren. `min-height` ist Pflicht: ein leeres
   `<span>` mit `display:block` waere 0 px hoch, und der Text haette an jeder Leerzeile einen
   Sprung, den der Original-Text nicht hat. */
.topic-preview :deep(.line) {
  display: block;
  min-height: 1.5em;
  border-left: 2px solid transparent;
  padding-left: 0.4rem;
}
/* --- Identitaetsfarbe je Klasse -------------------------------------------------------------
   Dieselben Tokens wie die Methodenfarben im Kanten-Panel (`--mc-0..5`), also keine zweite
   Farbsprache. Die sechs Regeln setzen nur die Variable; Balken und Grund erben sie – so steht
   jeder Ton genau einmal im Projekt. */
.topic-preview :deep(.tp-c0) { --mc: var(--mc-0); }
.topic-preview :deep(.tp-c1) { --mc: var(--mc-1); }
.topic-preview :deep(.tp-c2) { --mc: var(--mc-2); }
.topic-preview :deep(.tp-c3) { --mc: var(--mc-3); }
.topic-preview :deep(.tp-c4) { --mc: var(--mc-4); }
.topic-preview :deep(.tp-c5) { --mc: var(--mc-5); }
/* Ruhezustand: der Text ist gegliedert, ohne laut zu werden. Kopf, Package-Trenner und die
   Leerzeilen zwischen zwei Klassen tragen KEINE Farbe – sonst waere alles gefaerbt und damit
   nichts unterschieden.
   ⚠️ Der Balken traegt die Aussage, nicht der Grund. Gemessen: bei 5 % Grund und einem Balken auf
   40 % waren die vier Bloecke im dunklen Theme nicht auseinanderzuhalten – eine Farbe, die man
   nicht als verschieden erkennt, ist keine Zuordnung, sondern nur Rauschen. Der Grund bleibt
   trotzdem zart: er faerbt die ganze Blockflaeche, und was dort laut wird, konkurriert mit dem
   Text darauf. */
.topic-preview :deep(.tp-cc) {
  border-left-color: color-mix(in srgb, var(--mc) 85%, transparent);
  background: color-mix(in srgb, var(--mc) 7%, transparent);
}
/* Der Abschnitt der gerade gehoverten Klasse: DERSELBE Ton, nur in voller Staerke. Eine zweite
   Farbe dafuer waere eine zweite Bedeutung – gemeint ist ja dieselbe Klasse, nur eben die, auf
   die man gerade zeigt. Der Fallback greift fuer Zeilen ohne Klassenfarbe.
   Der Grund ist hier bewusst SCHWAECHER als der Balken vermuten laesst (10 %): auf ihm liegen
   gleich die Syntaxfarben, und zwei kraeftige Ebenen uebereinander liest niemand. */
.topic-preview :deep(.tp-lit) {
  background: color-mix(in srgb, var(--mc, var(--color-accent)) 10%, transparent);
  border-left-color: var(--mc, var(--color-accent));
  border-left-width: 3px;
  padding-left: calc(0.4rem - 1px);
}

/* --- Syntaxfarben NUR im gehoverten Abschnitt ------------------------------------------------
   Die Token-Spans kommen server-gerendert von Shiki und tragen ihre Farben als Inline-Variablen
   (`--shiki-light` / `--shiki-dark`, `defaultColor: false`). Die globale Regel dafuer haengt an
   einem `.shiki`-Vorfahren, den dieser Block bewusst NICHT hat: so bleibt der uebrige Text
   einfarbig und ruhig, und die Farbe ist selbst die Fokus-Anzeige.
   ⚠️ Gesetzt wird ausschliesslich `color` – kein `background-color` wie in der globalen
   Shiki-Regel. Sonst uebermalte der Token-Hintergrund genau den Klassenton, um dessentwillen der
   Abschnitt hervorgehoben ist. */
.topic-preview :deep(.tp-lit span) {
  color: var(--shiki-light);
}
html.dark .topic-preview :deep(.tp-lit span) {
  color: var(--shiki-dark);
}

/* --- Dieselbe Farbe an der Zeile links ------------------------------------------------------
   Der Balken ist die ganze Verbindung: er steht links am Eintrag und links am Abschnitt, und die
   beiden Enden derselben Aussage sehen damit gleich aus. */
.tp-row {
  border-left: 3px solid transparent;
}
.tp-row--c {
  border-left-color: color-mix(in srgb, var(--mc) 85%, transparent);
}
.tp-row--lit {
  background: color-mix(in srgb, var(--mc, var(--color-accent)) 14%, transparent);
  border-left-color: var(--mc, var(--color-accent));
}

/* --- Der gehaltene Zustand im Kopf der Vorschau ---------------------------------------------
   Derselbe Ton wie der Balken der Klasse links und rechts – der Chip ist keine dritte Aussage,
   sondern dieselbe an der Stelle, an der man sie beenden kann. Bewusst NUR getoent und nicht
   akzentfarben: er benennt, was ohnehin schon leuchtet, und darf dem Text daneben nicht die
   Aufmerksamkeit nehmen. */
.tp-held {
  border-color: color-mix(in srgb, var(--mc, var(--color-accent)) 45%, transparent);
  background: color-mix(in srgb, var(--mc, var(--color-accent)) 12%, transparent);
}
.tp-held:hover {
  background: color-mix(in srgb, var(--mc, var(--color-accent)) 22%, transparent);
}
.tp-held-dot {
  background: var(--mc, var(--color-accent));
}
/* Suchtreffer im Buendel – dieselbe Gold-Familie und dieselbe Trennung aktiv/passiv wie in der
   Palette und im Source-Tab. `color: inherit`, sonst gewinnt der Browser-Default fuer `mark`. */
.topic-preview :deep(mark.cs-hit) {
  background: color-mix(in srgb, var(--color-warning) 32%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.topic-preview :deep(mark.cs-hit--active) {
  background: color-mix(in srgb, var(--color-warning) 62%, transparent);
  box-shadow: 0 0 0 1px var(--color-warning);
}
</style>
