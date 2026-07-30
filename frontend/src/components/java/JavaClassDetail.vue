<script setup>
// Vollstaendige Doku-Ansicht einer analysierten Java-Klasse (Spalte 3 im Analyzer).
// Header + KI-Status, Klassen-Zusammenfassung (description_html), Methoden-Accordion
// (summary_html, einzeln nachgenerierbar) und Quellcode-Tab (read-only CodeMirror).
// HTTP nur via lib/api.js (Composable).
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../../composables/useJavaQueue.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { useArticles } from '../../composables/useArticles.js'
import BusyState from '../BusyState.vue'
import JavaCodeEditor from './JavaCodeEditor.vue'
import JavaDiffViewer from './JavaDiffViewer.vue'
import { processMethodBody } from '../../lib/javaCode.js'
import { parseParamNames, markParamOccurrences, toggleParamHighlight as onParamClick } from '../../lib/javaParams.js'
import { reindentJava } from '../../lib/javaIndent.js'
import { findMatches, indexAtOrAfter, isIdentifier, MATCH_LIMIT } from '../../lib/codeSearch.js'
import { copyToClipboard } from '../../lib/clipboard.js'
import { parseTimestamp as parseTs, formatRelative } from '../../lib/format.js'
import { api } from '../../lib/api.js'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  fileId: { type: Number, required: true },
  // Optionale Ziel-Quellzeile: oeffnet den Quellcode-Tab und hebt die Zeile hervor
  // (Such-Sprung bzw. Edge-Panel-Navigation).
  targetLine: { type: Number, default: null },
  // Optionale Ziel-End-Zeile: ist sie gesetzt (> targetLine), wird der GESAMTE Methodenbereich
  // (targetLine..targetEndLine) markiert statt nur einer Zeile (Edge-Panel „Definiert in").
  targetEndLine: { type: Number, default: null },
  // Suche, die den Sprung ausgeloest hat (globale Suchpalette): `{ query, opts }`. Sie landet
  // unveraendert in der Suchleiste dieses Panels – wer nach einem Wort gesucht hat, sucht nach dem
  // Sprung nicht neu, sondern blaettert weiter. Der aktive Treffer ist der, auf den gesprungen
  // wurde (s. applyHandoffSearch), nicht der erste der Datei.
  handoffSearch: { type: Object, default: null },
})
const emit = defineEmits(['close', 'changed'])

const router = useRouter()
const { files, getFile, deleteFile, linkArticle, userContext, getFileVersions, getVersionSource } = useJavaAnalyzer()
const { lastEvent, progressFor, enqueueClass } = useJavaQueue()
const { create } = useArticles()
const { edges: serverEdges, highlightedCall, toggleHighlightedCall, clearHighlightedCall, highlightedDef, toggleHighlightedDef, clearHighlightedDef } = useJavaGraph()

const file = ref(null)
const loading = ref(true)
const error = ref('')
const tab = ref('doc') // 'doc' | 'source' | 'history'
const sourceEditor = ref(null) // JavaCodeEditor im Quellcode-Tab (fuer highlightLine)
const openMethod = ref(null)
const fullBusy = ref(false) // waehrend des Einreihens der Voll-Analyse
const notice = ref('')
const creating = ref(false)
const copied = ref(false)

// --- Versionsverlauf (Changelog) ----------------------------------------------
// Lazy geladen, sobald der History-Tab zum ersten Mal geoeffnet wird. Quelltext einer
// Version wird nur on-demand nachgeladen (Liste haelt nur Diff + KI-Summary).
const versions = ref([])
const versionsLoading = ref(false)
const versionsLoaded = ref(false)
const versionsError = ref('')
const openSources = ref({}) // versionId -> Quelltext (aufklappbar), null = laedt gerade

const versionsStartedAt = ref(0)

async function loadVersions() {
  versionsLoading.value = true
  versionsStartedAt.value = Date.now()
  versionsError.value = ''
  try {
    versions.value = await getFileVersions(props.fileId)
    versionsLoaded.value = true
  } catch (e) {
    versionsError.value = e.message
  } finally {
    versionsLoading.value = false
  }
}

// Quelltext einer Version aus-/einklappen (on-demand nachladen).
async function toggleSource(v) {
  if (v.id in openSources.value) {
    const next = { ...openSources.value }
    delete next[v.id]
    openSources.value = next
    return
  }
  openSources.value = { ...openSources.value, [v.id]: null }
  try {
    const { source } = await getVersionSource(props.fileId, v.id)
    openSources.value = { ...openSources.value, [v.id]: source }
  } catch (e) {
    versionsError.value = e.message
    const next = { ...openSources.value }
    delete next[v.id]
    openSources.value = next
  }
}

// Zustand der KI-Aenderungs-Zusammenfassung: 'ready' | 'initial' | 'generating' | 'unavailable'.
// Da die Generierung im Hintergrund laeuft, wird bei fehlendem Summary anhand des Alters
// unterschieden: frisch (< 2 min) -> vermutlich noch in Arbeit; sonst war Ollama nicht erreichbar.
function summaryState(v) {
  if (v.ai_summary_html) return 'ready'
  if (!v.diff) return 'initial'
  const then = parseTs(v.created_at)
  const ageSec = then ? (Date.now() - then.getTime()) / 1000 : Infinity
  return ageSec < 120 ? 'generating' : 'unavailable'
}

// History erst beim ersten Oeffnen des Tabs laden.
watch(tab, (t) => {
  if (t === 'history' && !versionsLoaded.value && !versionsLoading.value) loadVersions()
})

// --- Ladeauskunft --------------------------------------------------------------------------
// `getFile` holt Methodenrümpfe, gerendertes Markdown UND den Rohquelltext; bei einer grossen
// Klasse auf dem Pi dauert das spuerbar. Was dabei passiert, ist bekannt (die Liste kennt Name und
// Methodenzahl) – also wird es auch gesagt, statt nur zu drehen.
// Uhr, Schwellen und Form liegen in `BusyState` – hier steht nur, WAS geladen wird.
const loadStartedAt = ref(0)
const loadingLabel = computed(() => {
  const name = listEntry.value?.class_name
  return name ? `Loading ${name}…` : 'Loading class…'
})
const loadingDetail = computed(() => {
  const n = listEntry.value?.method_count
  return n ? `${n} method(s) · source · rendered docs` : 'source · methods · rendered docs'
})
// Skelett in der Groessenordnung der echten Ansicht: so viele Zeilen, wie die Klasse Methoden hat
// (gedeckelt), damit beim Eintreffen nichts springt.
const loadingSkeletonRows = computed(() => Math.min(Math.max(methodCount.value || 3, 3), 8))

async function load() {
  loading.value = true
  error.value = ''
  file.value = null
  loadStartedAt.value = Date.now()
  try {
    file.value = await getFile(props.fileId)
    // Kam der Sprung aus der globalen Suche, faehrt deren Begriff mit -> zuerst uebernehmen, damit
    // die Trefferliste steht, bevor die Zielzeile angesteuert wird.
    applyHandoffSearch()
    // Falls beim Oeffnen bereits eine Zielzeile vorliegt (Such-Sprung/Edge-Panel) -> ansteuern.
    if (props.targetLine) applyTargetLine()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Quellcode-Tab oeffnen und das Ziel hervorheben. Liegt eine End-Zeile vor (Edge-Panel
// „Definiert in") -> die KOMPLETTE Methode persistent markieren; sonst nur die eine Zeile per
// auto-fade-Glow (Such-Sprung).
async function applyTargetLine() {
  if (!props.targetLine || !file.value) return
  tab.value = 'source'
  await nextTick() // Editor erst nach Tab-Wechsel gemountet
  if (props.targetEndLine && props.targetEndLine > props.targetLine) {
    sourceEditor.value?.highlightMethod(props.targetLine, props.targetEndLine)
  } else {
    sourceEditor.value?.highlightLine(props.targetLine)
  }
}

watch(() => props.fileId, load, { immediate: true })
// Erneutes Ziel in derselben (bereits gemounteten) Datei -> direkt ansteuern.
watch(() => props.targetLine, applyTargetLine)

// Wenn die Hintergrund-Queue eine Methode dieser Klasse fertigstellt -> Daten neu laden.
watch(lastEvent, (ev) => {
  if (ev && ev.fileId === props.fileId) load()
})

const queueProgress = computed(() => progressFor(props.fileId))

// --- Code-Token <-> Graph-Edge -------------------------------------------------
// Methodennamen, die diese Klasse (als Aufrufer) ueber eine Call-Edge nutzt -> im Quellcode
// klickbar. `uses`-Edges (Typ-Nutzung) sind keine Methodenaufrufe und bleiben aussen vor.
const callableMethods = computed(() => {
  const cls = file.value?.class_name
  if (!cls) return []
  return [
    ...new Set(
      (serverEdges.value || [])
        .filter((e) => e.source_class === cls && e.kind !== 'uses')
        .map((e) => e.method_name)
        .filter(Boolean),
    ),
  ]
})

// Aktiver Call-Methodenname FUER DIESE Klasse (Editor-Prop): nur wenn das geteilte Highlight
// diese Datei als Aufrufer betrifft. `highlightedCall` ist die einzige Quelle der Wahrheit ->
// treibt reaktiv sowohl die Graph-Kante als auch die Code-Token-Markierung (kein imperatives
// Setzen mehr, kein Auto-Fade-Timer).
const activeCall = computed(() =>
  highlightedCall.value && highlightedCall.value.callerFileId === props.fileId
    ? highlightedCall.value.method
    : null,
)

// Klick (links ODER rechts) auf einen klickbaren Methodennamen im Quellcode -> Toggle: dieselbe
// Methode erneut = aus, andere = umschalten. Graph-Kante + Code-Token folgen reaktiv.
function onMethodClick({ name }) {
  if (!name) return
  clearHighlightedDef() // Consumer- und Source-Highlight schliessen sich gegenseitig aus
  toggleHighlightedCall({ callerFileId: props.fileId, method: name })
}
// Klick daneben (kein Methoden-Token / leere Editorflaeche) -> Highlight vollstaendig entfernen.
function onClearCall() {
  clearHighlightedCall()
}

// --- Code-Token <-> Graph-Edge: SOURCE-Seite (eingehende Kanten) ---------------
// Methodennamen, die diese Klasse (als DEFINITION) fuer andere bereitstellt und die per Call-Edge
// genutzt werden -> im Quellcode klickbar. `uses`-Edges (Typ-Nutzung) bleiben aussen vor.
const incomingMethods = computed(() => {
  const cls = file.value?.class_name
  if (!cls) return []
  return [
    ...new Set(
      (serverEdges.value || [])
        .filter((e) => e.target_class === cls && e.kind !== 'uses')
        .map((e) => e.method_name)
        .filter(Boolean),
    ),
  ]
})

// Aktiver Methodenbereich FUER DIESE Klasse: nur wenn das geteilte Source-Highlight diese Datei als
// Definition betrifft. Die exakte Zeilenspanne (Signatur..schliessende Klammer) liefert das Backend
// (getJavaMethodSnippet, identisch zur „Definiert in"-Funktion) -> auf Klick nachladen + cachen.
const activeDefRange = ref(null)
const defRangeCache = new Map() // methodName -> { from, to }

async function resolveDefRange(method) {
  if (defRangeCache.has(method)) return defRangeCache.get(method)
  const snip = await api.getJavaMethodSnippet(props.fileId, method)
  const range = { from: snip.startLine, to: snip.endLine ?? snip.startLine }
  defRangeCache.set(method, range)
  return range
}

// highlightedDef spiegeln: betrifft der State diese Datei -> Methodenbereich aufloesen und markieren;
// sonst Markierung entfernen. Fehlt der Snippet (Fehler) -> nur der Block bleibt aus, die Kanten
// leuchten trotzdem (reaktiv ueber den Graphen).
watch(highlightedDef, async (hd) => {
  if (!hd || hd.definerFileId !== props.fileId) {
    activeDefRange.value = null
    return
  }
  const method = hd.method
  try {
    const range = await resolveDefRange(method)
    // Nach dem await pruefen, ob der State noch gilt (kein Race bei schnellem Umschalten).
    if (highlightedDef.value?.definerFileId === props.fileId && highlightedDef.value?.method === method) {
      activeDefRange.value = range
    }
  } catch {
    activeDefRange.value = null
  }
})

// Klick auf eine klickbare Methoden-Definition -> Toggle. Graph-Kanten (eingehend) + Block-Markierung
// folgen reaktiv. Consumer-Highlight wird ausgeschlossen.
function onDefClick({ name }) {
  if (!name) return
  clearHighlightedCall()
  toggleHighlightedDef({ definerFileId: props.fileId, method: name })
}
function onClearDef() {
  clearHighlightedDef()
}

// Klassenwechsel/Unmount: beide stehengebliebenen Highlights raeumen.
function clearHighlights() {
  clearHighlightedCall()
  clearHighlightedDef()
}
watch(() => props.fileId, clearHighlights)
onBeforeUnmount(clearHighlights)

// --- Farbige Parameter im Doku-Tab (java-param, wie im Edge-Panel) -------------
// Jeder Parameter bekommt eine eigene SCHRIFTFARBE (`.java-param-c{0..5}`, in `markParamOccurrences`
// gesetzt), kein Hintergrund im Ruhezustand. Der Klick-Handler (`onParamClick`) kommt aus
// lib/javaParams.js und wird mit dem Edge-Panel geteilt.

// Charakter der Klasse (`stereotype`, s. deriveStereotype im Parser) statt des blossen
// `class_type`: „Data class" sagt etwas, „class" nicht. Altbestand ohne Stereotyp faellt auf
// class_type zurueck. Label in Worten, weil hier – anders als auf der Graph-Karte – Platz ist.
const STEREOTYPE_LABEL = {
  data: 'Data class',
  util: 'Utility',
  exception: 'Exception',
  abstract: 'Abstract',
  record: 'Record',
  interface: 'Interface',
  enum: 'Enum',
  annotation: 'Annotation',
  class: 'Class',
}
// Was schon bekannt ist, muss nicht geladen werden: die Klassenliste liegt im Store (App.vue laedt
// sie), und darin stehen Name, Package, Charakter und Methodenzahl. Waehrend `getFile` laeuft,
// rendert der Kopf daraus – statt leer zu bleiben und beim Eintreffen zu springen.
const listEntry = computed(() => files.value.find((f) => f.id === props.fileId) || null)
const head = computed(() => file.value || listEntry.value)

const classKind = computed(() => head.value?.stereotype || head.value?.class_type || '')
const classKindLabel = computed(() => STEREOTYPE_LABEL[classKind.value] || classKind.value)

const typeBadge = computed(() => ({
  class: 'badge-accent',
  data: 'badge-accent',
  util: 'badge-success',
  abstract: 'badge-muted',
  record: 'badge-accent',
  exception: 'badge-danger',
  interface: 'badge-success',
  enum: 'badge-warning',
  annotation: 'badge-danger',
}[classKind.value] || 'badge-muted'))

// Geladen: die echten Methoden. Waehrend des Ladens: die Zahl aus der Liste – dieselbe Zahl, nur
// frueher, und der Kopf springt beim Eintreffen nicht.
const methodCount = computed(() => file.value?.methods?.length ?? listEntry.value?.method_count ?? 0)
const summarizedCount = computed(() => (file.value?.methods || []).filter((m) => m.summary_html).length)

// Signatur als String (Header-Chip + Wiki-Export). Modifier voranstellen, analog zum Backend
// (SerializerService.buildSignature) -> `public static String getId(User u)`.
function signature(m) {
  const params = (m.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ')
  const mods = (m.modifiers || []).join(' ')
  return `${mods} ${m.return_type || 'void'} ${m.method_name}(${params})`.trim()
}
// Code-Block einer Methode aufbereiten: server-gerenderte Signatur (Shiki, inkl. Modifier) als
// erste Zeile, deklarationsfreier Rumpf, interne Leerzeilen IMMER entfernt (kein Toggle mehr).
function displayMethodBlock(m) {
  const html = processMethodBody(m.body_html, { collapseBlank: true, signatureHtml: m.signature_html })
  // Parameter-Vorkommen (Signatur + Rumpf) farbig + klickbar machen (wie im Edge-Panel).
  return markParamOccurrences(html, parseParamNames(signature(m)))
}
function methodStatus(m) {
  if (queueProgress.value && queueProgress.value.status === 'running' && !m.summary_html) return 'pending'
  return m.summary_html ? 'done' : 'idle'
}
function toggle(id) {
  openMethod.value = openMethod.value === id ? null : id
}

// Aktive Queue (laeuft/wartet) fuer diese Datei -> Voll-Analyse-Button deaktivieren.
const analysisBusy = computed(
  () => fullBusy.value || ['running', 'queued'].includes(queueProgress.value?.status),
)

// Vollstaendige KI-Analyse: EINE atomare Einheit einreihen (erst alle Methoden, dann die
// Klassen-Zusammenfassung). `force` -> bestehende Beschreibungen werden bedingungslos neu erzeugt.
async function fullAnalysis() {
  if (!file.value || analysisBusy.value) return
  fullBusy.value = true
  notice.value = ''
  try {
    await enqueueClass(file.value, { userContext: userContext.value, force: true })
  } catch (e) {
    notice.value = e.message
  } finally {
    fullBusy.value = false
  }
}

// Anzeige-Quelltext fuer den Source-Tab: flacher Code wird nach Klammer-Tiefe neu eingerueckt
// (bereits eingerueckter Paste bleibt unveraendert). Zeilenanzahl bleibt konstant -> Zeilen-Highlights
// (targetLine/highlightMethod) bleiben gueltig.
const displaySource = computed(() => reindentJava(file.value?.raw_source || ''))

// --- Code-Suche im Quellcode-Tab -----------------------------------------------
// Gesucht wird im ANGEZEIGTEN Quelltext (`displaySource`) – damit sind Treffer-Offsets exakt die
// Dokument-Offsets des Editors, ohne Umrechnung. Der Zustand liegt HIER und nicht im Editor:
// Zaehler, Vor/Zurueck und die Markierung im Code stammen so aus genau einer Trefferliste, „3 von
// 12" kann also nicht von dem abweichen, was leuchtet. Der Editor bekommt sie als Prop und rendert.
const search = ref('')
const searchOpts = ref({ caseSensitive: false, wholeWord: false, regex: false })
const searchCursor = ref(0) // laeuft frei weiter; der Modulo unten macht das Umlaufen daraus
const searchInput = ref(null)

const SEARCH_TOGGLES = [
  { key: 'caseSensitive', icon: 'lucide:case-sensitive', title: 'Match case' },
  { key: 'wholeWord', icon: 'lucide:whole-word', title: 'Match whole word' },
  { key: 'regex', icon: 'lucide:regex', title: 'Use regular expression' },
]

const searchResult = computed(() =>
  findMatches(displaySource.value, { query: search.value, ...searchOpts.value }),
)
const matches = computed(() => searchResult.value.matches)

// Aktiver Treffer = Modulo des freilaufenden Zaehlers: „weiter" hinter dem letzten Treffer landet
// wieder beim ersten, ohne dass die Vor-/Zurueck-Handler die Grenzen kennen muessen.
const activeMatch = computed(() => {
  const n = matches.value.length
  if (!n) return -1
  return ((searchCursor.value % n) + n) % n
})

const searchCounter = computed(() => {
  if (!search.value) return ''
  if (searchResult.value.error) return 'Invalid regex'
  if (!matches.value.length) return 'No results'
  return `${activeMatch.value + 1}/${matches.value.length}${searchResult.value.capped ? '+' : ''}`
})
const searchCounterTitle = computed(() => {
  if (searchResult.value.error) return searchResult.value.error
  if (searchResult.value.capped) return `Showing the first ${MATCH_LIMIT} matches`
  return ''
})
const searchFailed = computed(() => !!search.value && (!!searchResult.value.error || !matches.value.length))

// Jede Aenderung an Query oder Optionen beginnt wieder beim ersten Treffer. Bewusst in den Settern
// statt in einem watch: `onSelectWord` setzt Query UND Ziel-Treffer in einem Zug – ein watch wuerde
// den Cursor beim naechsten Flush wieder auf 0 ziehen und das markierte Vorkommen verlieren.
function setQuery(value) {
  search.value = value
  searchCursor.value = 0
  // Getippt wird fuer den Quelltext – die Leiste gehoert zu keinem anderen Tab.
  if (value) tab.value = 'source'
}
function toggleSearchOpt(key) {
  searchOpts.value = { ...searchOpts.value, [key]: !searchOpts.value[key] }
  searchCursor.value = 0
}
function stepMatch(delta) {
  if (matches.value.length) searchCursor.value += delta
}
function closeSearch() {
  search.value = ''
  searchCursor.value = 0
  searchInput.value?.blur()
}

// Selektion im Editor -> Suchbegriff. Ein markierter Identifier meint genau dieses Wort, also
// „Ganzes Wort" an (`id` soll nicht `valid` treffen); Regex aus, weil markierter Text woertlich
// gemeint ist. Gross-/Kleinschreibung bleibt so, wie der Nutzer sie gesetzt hat.
function onSelectWord({ text, from }) {
  const value = text.trim()
  if (!value) return
  searchOpts.value = { ...searchOpts.value, wholeWord: isIdentifier(value), regex: false }
  search.value = value
  // Das markierte Vorkommen wird zum aktiven Treffer -> „weiter" setzt dort fort, wo der Blick
  // liegt, statt am Dateianfang.
  searchCursor.value = Math.max(0, indexAtOrAfter(matches.value, from))
}

// Zeichen-Offset des Anfangs einer (1-basierten) Zeile im angezeigten Quelltext. `reindentJava`
// laesst die Zeilenzahl unveraendert, deshalb passt eine Zeilennummer aus dem Rohquelltext (Server)
// hier 1:1.
function offsetOfLine(text, line) {
  if (!line || line < 2) return 0
  let pos = 0
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return pos
    pos = nl + 1
  }
  return pos
}

// Suche aus der globalen Palette uebernehmen. Gleiche Regel wie bei `onSelectWord`: der Treffer,
// den man angeklickt hat, wird zum AKTIVEN – „weiter" setzt dort fort, wo der Blick liegt, statt
// am Dateianfang. Die Schalter kommen mit, sonst faende die Klasse etwas anderes als die Palette.
function applyHandoffSearch() {
  const handoff = props.handoffSearch
  if (!handoff?.query || !file.value) return
  searchOpts.value = { caseSensitive: false, wholeWord: false, regex: false, ...(handoff.opts || {}) }
  search.value = handoff.query
  tab.value = 'source'
  searchCursor.value = Math.max(0, indexAtOrAfter(matches.value, offsetOfLine(displaySource.value, props.targetLine)))
}
watch(() => props.handoffSearch, applyHandoffSearch)

// Ctrl/Cmd+F im offenen Klassen-Panel: Suchfeld statt Browser-Suche (die faende nur den sichtbaren
// Ausschnitt des virtualisierten Editors). Liegt der Fokus in einem ANDEREN Eingabefeld – etwa dem
// Klassenfilter der linken Spalte –, bleibt das Kuerzel unangetastet.
function onGlobalKey(e) {
  if ((e.key || '').toLowerCase() !== 'f' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
  if (!file.value) return
  const el = document.activeElement
  if (el && el !== searchInput.value && /^(input|textarea)$/i.test(el.tagName)) return
  e.preventDefault()
  focusSearch()
}
async function focusSearch() {
  tab.value = 'source'
  await nextTick()
  searchInput.value?.focus()
  searchInput.value?.select()
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

// Klassenwechsel: die Suche gehoerte zur vorherigen Datei.
watch(() => props.fileId, () => {
  search.value = ''
  searchCursor.value = 0
})

async function copySource() {
  // copyToClipboard kapselt den Secure-Context-/Fallback-Fall (Pi laeuft ueber http).
  // Kopiert wird der ANGEZEIGTE (eingerueckte) Code.
  if (!(await copyToClipboard(displaySource.value || ''))) return
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// Wiki-Artikel aus der Klasse erzeugen und verknuepfen (-> FTS-Suche).
function buildMarkdown(f) {
  const lines = [`# ${f.class_name}`, '']
  if (f.package) lines.push(`**Package:** \`${f.package}\``, '')
  // Charakter nur nennen, wenn er ueber `class_type` hinausgeht („class" ist keine Aussage).
  const kind = f.stereotype && f.stereotype !== f.class_type ? `${f.class_type} · ${STEREOTYPE_LABEL[f.stereotype] || f.stereotype}` : f.class_type
  lines.push(`**Type:** ${kind}`, '')
  if (f.extends_name) lines.push(`**Extends:** \`${f.extends_name}\``, '')
  if (f.description) lines.push('', f.description, '')
  if (f.dependencies?.length) {
    lines.push('## Dependencies', '')
    for (const d of f.dependencies) lines.push(`- \`${d}\``)
    lines.push('')
  }
  lines.push('## Methods', '')
  for (const m of f.methods || []) {
    lines.push(`### ${m.method_name}`, '', '```java', signature(m), '```', '')
    if (m.ai_summary) lines.push(m.ai_summary, '')
    else if (m.javadoc) lines.push(m.javadoc, '')
  }
  return lines.join('\n')
}

async function createArticle() {
  if (!file.value) return
  creating.value = true
  notice.value = ''
  try {
    const f = file.value
    const article = await create({
      title: f.class_name,
      summary: f.package ? `${f.package}.${f.class_name}` : f.class_name,
      content: buildMarkdown(f),
      tags: ['java', f.class_type],
    })
    await linkArticle(f.id, article.id)
    router.push(`/article/${article.slug}`)
  } catch (e) {
    notice.value = e.message
  } finally {
    creating.value = false
  }
}

async function removeFile() {
  if (!file.value) return
  await deleteFile(file.value.id)
  emit('close', { deleted: true })
}
</script>

<template>
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
    <!-- Header -->
    <header class="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded px-1.5 py-0.5 text-3xs font-semibold uppercase" :class="typeBadge">{{ classKindLabel }}</span>
          <h2 class="truncate text-xl font-bold text-[var(--color-text)]">{{ head?.class_name }}</h2>
        </div>
        <p v-if="head?.package" class="truncate font-mono text-xs text-[var(--color-text-muted)]">{{ head.package }}</p>
        <div v-if="file" class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span class="rounded-md bg-[var(--color-surface-offset)] px-1.5 py-0.5 text-3xs font-medium text-[var(--color-text-muted)]">
            {{ methodCount }} method(s)
          </span>
          <span
            class="rounded-md px-1.5 py-0.5 text-3xs font-medium"
            :class="summarizedCount === methodCount && methodCount > 0 ? 'badge-success' : 'badge-accent'"
          >
            AI {{ summarizedCount }}/{{ methodCount }}
          </span>
          <span
            v-if="queueProgress && queueProgress.status === 'running'"
            class="badge-accent inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium"
          >
            <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
            <span v-if="queueProgress.current">{{ queueProgress.current.name }}()</span>
            <span v-else>Queue running</span>
            <span v-if="queueProgress.total > 1" class="tabular-nums opacity-70">{{ queueProgress.done }}/{{ queueProgress.total }}</span>
          </span>
        </div>
      </div>
      <button
        type="button"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
        title="Close"
        @click="emit('close')"
      >
        <Icon icon="lucide:x" class="h-5 w-5" />
      </button>
    </header>

    <!-- Tabs + Code-Suche, zwei Zeilen. Die drei Tabs bilden EINE Flex-Einheit, damit sie in einer
         schmalen dritten Spalte zusammenbleiben statt „History" allein umbrechen zu lassen. -->
    <div v-if="file" class="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-4 pt-2">
      <div class="flex items-center gap-1">
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'doc' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
        @click="tab = 'doc'"
      >Documentation</button>
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'source' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
        @click="tab = 'source'"
      >Source</button>
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'history' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
        @click="tab = 'history'"
      >History</button>
      </div>

      <!-- Suche im Quelltext. Steht unter den Tabs, weil sie zu genau EINEM davon gehoert: Tippen
           wechselt deshalb in den Source-Tab, statt still ins Leere zu suchen. `w-full` gibt ihr
           eine eigene Zeile ueber die volle Panelbreite – die Leiste traegt Feld, Zaehler,
           Modus-Schalter und Navigation, und die draengen sich neben den Tabs auf jeder
           Spaltenbreite. -->
      <div
        class="mb-1 flex w-full min-w-0 flex-wrap items-center gap-0.5 rounded-lg border bg-[var(--color-surface)] px-1.5 py-0.5 transition"
        :class="searchFailed ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'"
      >
        <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
        <input
          ref="searchInput"
          :value="search"
          type="text"
          placeholder="Search source…"
          aria-label="Search source code"
          spellcheck="false"
          class="min-w-[6rem] flex-1 bg-transparent py-0.5 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
          @input="setQuery($event.target.value)"
          @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
          @keydown.esc.prevent="closeSearch"
        />
        <span
          v-if="search"
          class="shrink-0 whitespace-nowrap px-0.5 text-3xs tabular-nums"
          :class="searchFailed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
          :title="searchCounterTitle"
        >{{ searchCounter }}</span>

        <!-- Modus-Schalter (Aa / ganzes Wort / Regex) -->
        <button
          v-for="o in SEARCH_TOGGLES"
          :key="o.key"
          type="button"
          class="grid h-5 w-5 shrink-0 place-items-center rounded transition"
          :class="searchOpts[o.key]
            ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
          :title="o.title"
          :aria-pressed="searchOpts[o.key]"
          @click="toggleSearchOpt(o.key)"
        >
          <Icon :icon="o.icon" class="h-3.5 w-3.5" />
        </button>

        <!-- Navigation als EINE Einheit: in einer schmalen Spalte bricht die Leiste intern um, und
             ein einzeln abgetrennter Weiter-Pfeil waere dort ein Bedienelement ohne Zusammenhang. -->
        <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <span class="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border)]" />

        <button
          type="button"
          class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent"
          title="Previous match (Shift+Enter)"
          :disabled="!matches.length"
          @click="stepMatch(-1)"
        >
          <Icon icon="lucide:chevron-up" class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent"
          title="Next match (Enter)"
          :disabled="!matches.length"
          @click="stepMatch(1)"
        >
          <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5" />
        </button>
        <button
          v-if="search"
          type="button"
          class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
          title="Clear search (Esc)"
          @click="closeSearch"
        >
          <Icon icon="lucide:x" class="h-3.5 w-3.5" />
        </button>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <!-- Ladezustand: sagt WAS geladen wird (aus der Klassenliste ist es bereits bekannt), WIE
           LANGE schon, und zeigt die Form der kommenden Ansicht als Skelett. Ein blosses
           „Loading…" liess das Panel bei einer grossen Klasse sekundenlang leer wirken. -->
      <BusyState
        v-if="loading"
        variant="panel"
        :title="loadingLabel"
        :detail="loadingDetail"
        hint="A class carries its full source and every method body — that is what takes the time."
        :since="loadStartedAt"
        :rows="loadingSkeletonRows"
      />
      <div v-else-if="error" class="text-sm text-[var(--color-danger)]">{{ error }}</div>

      <template v-else-if="file">
        <p v-if="notice" class="notice-warning mb-3 rounded-lg px-3 py-2 text-xs">{{ notice }}</p>
        <p
          v-if="queueProgress && queueProgress.ollamaUnavailable"
          class="notice-warning mb-3 rounded-lg px-3 py-2 text-xs"
        >
          Ollama was unreachable – using the existing Javadoc/fallback text.
        </p>

        <!-- DOKU-TAB -->
        <template v-if="tab === 'doc'">
          <!-- Klassen-Zusammenfassung -->
          <section class="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] p-3">
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">Class summary</h3>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                :disabled="analysisBusy"
                title="Regenerate the class summary and all methods"
                @click="fullAnalysis"
              >
                <Icon
                  :icon="analysisBusy ? 'lucide:loader-2' : 'lucide:sparkles'"
                  class="h-3.5 w-3.5"
                  :class="analysisBusy ? 'animate-spin' : ''"
                />
                {{ analysisBusy ? 'Analyzing…' : 'Full AI analysis' }}
              </button>
            </div>
            <div v-if="file.description_html" class="prose prose-sm max-w-none dark:prose-invert" v-html="file.description_html" />
            <p v-else class="text-sm italic text-[var(--color-text-muted)]">No AI class description yet – “Generate” uses the project context.</p>
          </section>

          <!-- Methoden -->
          <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Methods ({{ methodCount }})</h3>
          <ul class="space-y-1.5">
            <li v-for="m in file.methods" :key="m.id" class="overflow-hidden rounded-lg border border-[var(--color-border)]">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--color-surface-offset)]"
                @click="toggle(m.id)"
              >
                <code class="min-w-0 flex-1 truncate text-xs text-[var(--color-text)]">{{ signature(m) }}</code>
                <span
                  class="shrink-0 rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase"
                  :class="{
                    'badge-success': methodStatus(m) === 'done',
                    'badge-accent': methodStatus(m) === 'running' || methodStatus(m) === 'pending',
                    'badge-muted': methodStatus(m) === 'idle',
                  }"
                >
                  {{ { done: 'generated', running: '…', pending: 'waiting', idle: 'open' }[methodStatus(m)] }}
                </span>
                <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform" :class="openMethod === m.id ? 'rotate-180' : ''" />
              </button>

              <div v-show="openMethod === m.id" class="border-t border-[var(--color-border)] px-3 py-2">
                <!-- 1) Java-Code-Block: Signatur als erste Zeile + deklarationsfreier Rumpf, immer
                        dunkel (Editor-Optik), Leerzeilen (fuehrend/abschliessend + intern) entfernt.
                        Parameter sind farbig (eigene Schriftfarbe); Klick auf eine Variable markiert
                        alle ihre Vorkommen (onParamClick, wie im Edge-Panel). -->
                <div
                  v-if="m.body_html"
                  class="method-code code-dark mb-2"
                  v-html="displayMethodBlock(m)"
                  @click="onParamClick"
                />

                <!-- 2) KI-Analyse / Zusammenfassung -->
                <div v-if="m.summary_html" class="prose prose-sm max-w-none dark:prose-invert" v-html="m.summary_html" />
                <p v-else class="text-sm italic text-[var(--color-text-muted)]">No AI description yet – generate it via “Full AI analysis”.</p>
              </div>
            </li>
          </ul>
        </template>

        <!-- QUELLCODE-TAB: read-only CodeMirror (Java-Syntax-Highlighting) -->
        <template v-else-if="tab === 'source'">
          <div class="code-wrap h-[60vh] min-h-[20rem]">
            <button
              type="button"
              class="code-copy z-10 opacity-100"
              @click="copySource"
            >{{ copied ? 'Copied' : 'Copy' }}</button>
            <JavaCodeEditor
              ref="sourceEditor"
              :model-value="displaySource"
              :clickable-words="callableMethods"
              :active-call="activeCall"
              :def-words="incomingMethods"
              :active-def-range="activeDefRange"
              :search-matches="matches"
              :search-active="activeMatch"
              readonly
              @method-click="onMethodClick"
              @clear-call="onClearCall"
              @def-click="onDefClick"
              @clear-def="onClearDef"
              @select-word="onSelectWord"
            />
          </div>
        </template>

        <!-- HISTORY-TAB: Versionsverlauf (Changelog) -->
        <template v-else>
          <div class="mb-3 flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Version history
            </h3>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-60"
              :disabled="versionsLoading"
              title="Reload version history"
              @click="loadVersions"
            >
              <Icon icon="lucide:refresh-cw" class="h-3.5 w-3.5" :class="versionsLoading ? 'animate-spin' : ''" />
              Refresh
            </button>
          </div>

          <p v-if="versionsError" class="notice-warning mb-3 rounded-lg px-3 py-2 text-xs">{{ versionsError }}</p>

          <!-- Gleiche Wartemeldung wie ueberall sonst (BusyState), statt eines eigenen Pulses. -->
          <BusyState
            v-if="versionsLoading && !versions.length"
            variant="panel"
            title="Loading version history…"
            detail="stored revisions with their diffs"
            hint="Each revision keeps its own source — older classes with many revisions take a moment."
            :since="versionsStartedAt"
            :rows="3"
          />

          <p
            v-else-if="versionsLoaded && !versions.length"
            class="text-sm italic text-[var(--color-text-muted)]"
          >
            No version history yet.
          </p>

          <ol v-else class="space-y-4">
            <li
              v-for="v in versions"
              :key="v.id"
              class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="rounded-md bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-accent)]">
                  Version {{ v.version_number }}
                </span>
                <span v-if="!v.diff" class="badge-muted rounded px-1.5 py-0.5 text-3xs font-semibold uppercase">
                  Initial upload
                </span>
                <span class="text-xs text-[var(--color-text-muted)]">{{ formatRelative(v.created_at) }}</span>
                <button
                  type="button"
                  class="ml-auto inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] transition hover:text-[var(--color-accent-hover)]"
                  @click="toggleSource(v)"
                >
                  <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                  {{ v.id in openSources ? 'Hide source' : 'View source' }}
                </button>
              </div>

              <!-- Diff (farbig, Java-Highlighting). Version 1 hat keinen Diff. -->
              <div v-if="v.diff" class="mb-2 h-[40vh] min-h-[14rem]">
                <JavaDiffViewer :diff="v.diff" />
              </div>

              <!-- Optional aufgeklappter Quelltext der Version -->
              <div v-if="v.id in openSources" class="mb-2 h-[40vh] min-h-[14rem]">
                <div v-if="openSources[v.id] === null" class="animate-pulse h-full rounded-xl bg-[var(--color-surface-offset)]" />
                <JavaCodeEditor v-else :model-value="openSources[v.id]" readonly />
              </div>

              <!-- KI-Zusammenfassung der Aenderung -->
              <blockquote
                v-if="summaryState(v) === 'ready'"
                class="prose prose-sm max-w-none border-l-2 border-[var(--color-accent)] pl-3 dark:prose-invert"
                v-html="v.ai_summary_html"
              />
              <p v-else-if="summaryState(v) === 'initial'" class="text-sm italic text-[var(--color-text-muted)]">
                Initial version — no change summary.
              </p>
              <p v-else-if="summaryState(v) === 'generating'" class="inline-flex items-center gap-1.5 text-sm italic text-[var(--color-text-muted)]">
                <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                Generating AI change summary… (refresh in a moment)
              </p>
              <p v-else class="text-sm italic text-[var(--color-text-muted)]">
                No AI summary available.
              </p>
            </li>
          </ol>
        </template>
      </template>
    </div>

    <!-- Footer -->
    <footer v-if="file" class="flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
      <RouterLink
        v-if="file.article_slug"
        :to="`/article/${file.article_slug}`"
        class="flex-1 rounded-lg bg-[var(--color-success)] px-3 py-2 text-center text-sm font-semibold text-white transition hover:opacity-90"
      >
        Open article
      </RouterLink>
      <button
        v-else
        type="button"
        class="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        :disabled="creating"
        @click="createArticle"
      >
        {{ creating ? 'Creating…' : 'Save to wiki' }}
      </button>
      <button
        type="button"
        class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-surface-offset)]"
        title="Delete file"
        @click="removeFile"
      >
        Delete
      </button>
    </footer>
  </aside>
</template>

<style scoped>
@reference "../../assets/style.css";

.code-wrap {
  @apply relative;
}

/* Methodenrumpf-Codeblock (server-gerenderte Shiki-HTML via v-html). Etwas kompakter als der
   globale .shiki-Default; Dual-Theme-Farben kommen weiterhin aus den inline --shiki-*-Variablen. */
.method-code :deep(.shiki) {
  @apply p-3 text-xs leading-relaxed;
}

/* Vorangestellte Signaturzeile (server-gerendertes Shiki-HTML, inkl. Modifier): nur fett als
   bewusster Snippet-Kopf – KEIN color-Override, damit die Java-Token-Farben erhalten bleiben. */
.method-code :deep(.sig-line) {
  @apply font-semibold;
}

/* Status-Badges auf Palette-Basis (warme Tints via color-mix). */
.badge-accent {
  background-color: var(--color-accent-soft);
  color: var(--color-accent);
}
.badge-success {
  background-color: color-mix(in srgb, var(--color-success) 16%, transparent);
  color: var(--color-success);
}
.badge-warning {
  background-color: color-mix(in srgb, var(--color-warning) 18%, transparent);
  color: var(--color-warning);
}
.badge-danger {
  background-color: color-mix(in srgb, var(--color-danger) 16%, transparent);
  color: var(--color-danger);
}
.badge-muted {
  background-color: var(--color-surface-offset);
  color: var(--color-text-muted);
}
.notice-warning {
  background-color: color-mix(in srgb, var(--color-warning) 14%, transparent);
  color: var(--color-warning);
}
</style>
