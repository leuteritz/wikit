<script setup>
// Code-Analyse-Sektion: schlanke Command-Bar + 3-Spalten-Arbeitsflaeche.
//  Command-Bar: Titel + Live-Metriken links, Aktionen rechts (Primaer "Add code",
//               AI-Queue-Chip, Overflow-Menue fuer selten genutzte/destruktive Aktionen).
//  Spalte 1: Suche + Package-Baum aller geladenen Klassen (Datei-Explorer-Optik)
//  Spalte 2: Klassen-Abhaengigkeitsgraph (Vue Flow + dagre)
//  Spalte 3: vollstaendige Klassen-Doku + KI-Zusammenfassungen
// Datenhaltung via useJavaAnalyzer (Dateien/CRUD) + useJavaQueue (KI-Queue, Polling).
import { ref, reactive, onMounted, onUnmounted, computed, watch } from 'vue'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { buildPackageTree, countClasses, filterClasses, LANGUAGES } from '../composables/useCodeAnalysis.js'
import { usePanelResize } from '../composables/usePanelResize.js'
import { useNotifications } from '../composables/useNotifications.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import JavaDependencyGraph from '../components/java/JavaDependencyGraph.vue'
import JavaClassDetail from '../components/java/JavaClassDetail.vue'
import JavaQueueModal from '../components/java/JavaQueueModal.vue'
import JavaDetectedClasses from '../components/java/JavaDetectedClasses.vue'
import { Icon } from '../lib/icons.js'
import { detectJavaClasses } from '../lib/javaDetect.js'
import { formatEta, formatDuration } from '../lib/format.js'

const { files, fetchFiles, analyzeBatch, analyzing, error, userContext, lastFileId, lastTargetLine, lastTargetEndLine, deleteFile, resetAll } =
  useJavaAnalyzer()
const { summary: queueSummary, enqueueMany, enqueueAllUnanalyzed, cancelJob, cancelAllJobs, progressFor, ensurePolling } =
  useJavaQueue()
const { recomputeEdges, recomputing, resetEdges, edgeReturn, requestEdgeReturn, clearEdgeReturn } = useJavaGraph()
const { push, clearAll: clearNotifications } = useNotifications()
// Verschiebbare Spaltenbreiten des 3-Spalten-Layouts (Drag-to-Resize + Reset).
const {
  gridTemplate,
  isWide,
  isDragging,
  activeKey,
  isDirty: panelsDirty,
  startDrag,
  reset: resetPanels,
} = usePanelResize()

const source = ref('')
const filename = ref('')
const inputMode = ref('paste') // 'paste' = Editor | 'file' = .java-Datei(en) hochladen
const selectedFileId = ref(null)
const activeTargetLine = ref(null) // Ziel-Quellzeile fuer das Detail-Panel (Such-Sprung)
const activeTargetEndLine = ref(null) // Ziel-End-Zeile -> markiert den gesamten Methodenbereich
const search = ref('')
const showNew = ref(false)
const collapsed = reactive({}) // packagePfad -> true (eingeklappt)
const pendingDelete = ref(null)
const deleting = ref(false)
const pendingConflicts = ref(null) // FQCN-Liste vorhandener Klassen -> Ueberschreiben-Dialog
const confirming = ref(false)
const analyzingAll = ref(false) // Spinner fuer "Run AI"
const pendingReset = ref(false) // Komplett-Reset-Dialog offen?
const resetting = ref(false) // Spinner waehrend des Komplett-Resets
const queueOpen = ref(false) // KI-Queue-Modal offen?
const menuOpen = ref(false) // Overflow-Menue der Command-Bar

// --- Fluechtige Rueckmeldungen ---------------------------------------------------------------
// Laufen ueber den GLOBALEN Toast-Stapel (useNotifications + NotificationHost in App.vue). Vorher
// hatte diese Ansicht einen eigenen; damit blieb der Rest der App bei Fehlern stumm, und es gab
// zwei Stellen, an denen dasselbe gebaut war.
function setNotice(text, kind = 'info') {
  if (!text) return
  push({ kind: kind === 'error' ? 'error' : 'success', message: text })
}

// Kompakte Queue-Anzeige in der Command-Bar. Quelle ist die Server-Bilanz (useJavaQueue.summary),
// nicht mehr die volle Job-Liste – die wird bei grossen Queues gar nicht mehr dauergepollt.
const finishedQueueCount = computed(() => queueSummary.value?.finished ?? 0)
const runningQueueJob = computed(() => queueSummary.value?.current || null)
const queuedQueueCount = computed(() => queueSummary.value?.queued ?? 0)
// Gesamtfortschritt der KI-Analyse: Klassen fuer die Zahl, Einheiten (Methoden + Klassenschritt)
// fuer den Balken – Klassen haben sehr unterschiedlich viele Methoden, der Balken laeuft dadurch
// deutlich gleichmaessiger als eine reine Klassen-Quote.
const queueActive = computed(() => {
  const s = queueSummary.value
  return !!s && (s.running > 0 || s.queued > 0)
})
const queuePercent = computed(() => {
  const s = queueSummary.value
  if (!s?.unitsTotal) return 0
  return Math.min(100, Math.round((s.unitsDone / s.unitsTotal) * 100))
})
const queueEta = computed(() => formatEta(queueSummary.value?.etaMs))

// Klasse aus dem Queue-Modal heraus oeffnen: direkt auswaehlen + Modal schliessen (wir sind im View).
function onQueueSelect(fileId) {
  selectFile(fileId)
  queueOpen.value = false
}

// Live-Vorschau der im Editor erkannten Klassen (rein clientseitig, nicht autoritativ).
// Entkoppelt vom Tippen: bei einem 15k-Zeilen-Paste kostet der Scan + das Neuzeichnen der
// Vorschau spuerbar Zeit – 200 ms Ruhe reichen voellig, die Vorschau ist kein Editor-Feedback.
const detectSource = ref('')
let detectTimer = null
watch(
  source,
  (v) => {
    clearTimeout(detectTimer)
    if (!v) {
      detectSource.value = ''
      return
    }
    detectTimer = setTimeout(() => (detectSource.value = v), 200)
  },
  { immediate: true },
)
const detectedClasses = computed(() => detectJavaClasses(detectSource.value))

// Kennzahlen des eingefuegten Quelltexts (Footer des Modals) – ebenfalls auf dem debounced Wert.
const nf = new Intl.NumberFormat('en-US')
const sourceStats = computed(() => {
  const s = detectSource.value
  if (!s.trim()) return null
  let lines = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++
  return { lines, kb: s.length / 1024 }
})

// Kennzahl-Kacheln neben dem Editor: die vier Zahlen, die vor dem Klick auf "Analyze" zaehlen.
const inputTiles = computed(() => [
  { label: 'classes', value: nf.format(detectedClasses.value.length) },
  { label: 'packages', value: nf.format(new Set(detectedClasses.value.map((c) => c.package || '')).size) },
  { label: 'lines', value: nf.format(sourceStats.value?.lines ?? 0) },
  { label: 'kilobytes', value: (sourceStats.value?.kb ?? 0).toFixed(1) },
])

// Hand-off aus Landing-Analyse / Suche / Edge-Panel uebernehmen: Datei vorwaehlen und
// (optional) die Ziel-Quellzeile ans Detail-Panel durchreichen. Danach zuruecksetzen.
function consumeHandoff() {
  if (lastFileId.value == null) return
  selectedFileId.value = lastFileId.value
  activeTargetLine.value = lastTargetLine.value
  activeTargetEndLine.value = lastTargetEndLine.value
  lastFileId.value = null
  lastTargetLine.value = null
  lastTargetEndLine.value = null
}

// Reagiert auch, wenn /code bereits gemountet ist (z. B. Klick auf einen Edge-Panel-Link).
watch(lastFileId, (v) => {
  if (v != null) consumeHandoff()
})

// ESC schliesst Overflow-Menue bzw. das Analyse-Modal; Strg/Cmd+Enter startet die Analyse
// direkt aus dem Editor heraus (der Primaerbutton bleibt trotzdem sichtbar im Modal-Footer).
//
// Waehrend eines Laufs schliesst ESC das Modal ebenfalls – es MINIMIERT dann nur (s. runChip
// in der Command-Bar). Der Lauf haengt an keinem Dialog: die Anfrage laeuft im Composable,
// der Fortschritt kommt per SSE. Das Modal offenhalten zu MUESSEN war eine Einschraenkung
// ohne technischen Grund – bei einem Import, der Minuten braucht, eine ziemlich teure.
function onKeydown(e) {
  if (e.key === 'Escape') {
    if (menuOpen.value) {
      menuOpen.value = false
      return
    }
    if (showNew.value && !pendingConflicts.value) showNew.value = false
    return
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && showNew.value && !analyzing.value && !pendingConflicts.value) {
    e.preventDefault()
    analyze()
  }
}

let releasePolling = null
onMounted(async () => {
  releasePolling = ensurePolling()
  window.addEventListener('keydown', onKeydown)
  await fetchFiles()
  consumeHandoff()
  // Beim ersten Laden noch nichts vorhanden -> Neu-Panel aufklappen.
  if (!files.value.length) showNew.value = true
})
onUnmounted(() => {
  releasePolling?.()
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(detectTimer)
  clearInterval(elapsedTimer)
})

// --- Metriken (Command-Bar) ---
const classCount = computed(() => files.value.length)
const packageCount = computed(() => new Set(files.value.map((f) => f.package || '(default)')).size)
const analyzedCount = computed(() => files.value.filter((f) => f.description).length)

// --- Package-Baum (gefiltert) -> flache Zeilenliste fuer iteratives Rendern ---
const filteredFiles = computed(() => filterClasses(files.value, search.value))
const tree = computed(() => buildPackageTree(filteredFiles.value))
const searching = computed(() => search.value.trim().length > 0)
// Treffer-IDs der Suche -> der Graph zeigt bei aktiver Suche genau diese Klassen (plus ihre
// direkten Nachbarn als Kontext) statt weiter die volle Ebene.
const searchMatchIds = computed(() => (searching.value ? filteredFiles.value.map((f) => f.id) : []))

// Ab dieser Klassenzahl ist der Baum standardmaessig EINGEKLAPPT (nur die oberste Ebene offen).
// Bei einer grossen Codebasis waeren es sonst tausende offene Zeilen – weder lesbar noch billig
// zu rendern. Ein manuelles Auf-/Zuklappen (collapsed[path]) schlaegt den Default immer.
const AUTO_COLLAPSE_FROM = 150
const denseTree = computed(() => files.value.length >= AUTO_COLLAPSE_FROM)

function folderOpen(node, depth) {
  if (searching.value) return true
  if (node.fullPath in collapsed) return !collapsed[node.fullPath]
  return !denseTree.value || depth === 0
}

function flatten(nodes, depth, out) {
  for (const n of nodes) {
    const open = folderOpen(n, depth)
    out.push({ kind: 'folder', id: n.id, label: n.label, fullPath: n.fullPath, depth, count: countClasses(n), open })
    if (open) {
      flatten(n.children, depth + 1, out)
      for (const f of n.classes) out.push({ kind: 'class', id: `c:${f.id}`, file: f, depth: depth + 1 })
    }
  }
  return out
}
const rows = computed(() => flatten(tree.value, 0, []))

// `open` kommt aus der gerenderten Zeile: der Default haengt von der Groesse der Codebasis ab
// (s. folderOpen), ein blosses Invertieren von collapsed[path] wuerde beim ersten Klick auf einen
// per Default geschlossenen Ordner ins Leere laufen.
// --- Baum -> Graph: der Graph folgt der Navigation links -------------------------------------
// Der Baum ist die Navigation, der Graph die Ansicht. Ein Klick auf ein Package oeffnet dort die
// passende Ebene, ein Klick auf eine Klasse springt in ihr Package und zentriert sie. Ohne diese
// Kopplung waeren die beiden Spalten bei tausenden Klassen zwei getrennte Welten.
const graphFocusPath = ref(null) // Package-Pfad, den der Graph oeffnen soll
const graphFocusFileId = ref(null) // Klasse, die der Graph zentrieren soll
let focusSeq = 0
const graphFocusToken = ref(0) // erzwingt eine Reaktion auch bei gleichem Ziel (erneuter Klick)

function focusGraphOnPackage(path) {
  graphFocusFileId.value = null
  graphFocusPath.value = path
  graphFocusToken.value = ++focusSeq
}
function focusGraphOnFile(file) {
  graphFocusPath.value = file?.package || ''
  graphFocusFileId.value = file?.id ?? null
  graphFocusToken.value = ++focusSeq
}

function toggleFolder(path, open) {
  collapsed[path] = open
  // Auf-/Zuklappen ist zugleich eine Ortsangabe: der Graph zeigt dieses Package.
  focusGraphOnPackage(path)
}

// --- Alles auf-/zuklappen ---------------------------------------------------------------------
// Einzeln zuklappen ist bei tiefen Paketbaeumen keine Option: wer sich durch `com.acme.a.b.c`
// gearbeitet hat, muesste denselben Weg rueckwaerts klicken, um wieder Ueberblick zu bekommen.
// Ein Knopf, ZWEI Richtungen: was er tut, haengt daran, ob ueberhaupt noch etwas offen ist –
// zwei getrennte Knoepfe waeren einer zuviel, von dem immer nur einer sinnvoll ist.
const folderPaths = computed(() => {
  const out = []
  const walk = (nodes) => {
    for (const n of nodes) {
      out.push(n.fullPath)
      walk(n.children)
    }
  }
  walk(tree.value)
  return out
})
// Ein offener Ordner ist immer auch sichtbar (seine Vorfahren sind es dann ebenfalls) -> die
// gerenderten Zeilen reichen als Antwort, der Baum muss dafuer nicht zweimal durchlaufen werden.
const anyFolderOpen = computed(() => rows.value.some((r) => r.kind === 'folder' && r.open))
// Bewusst OHNE focusGraphOnPackage: „alles zuklappen" ist eine Aussage ueber den Baum, keine
// Ortsangabe – der Graph soll dabei stehen bleiben, wo er ist.
function setAllFolders(open) {
  for (const p of folderPaths.value) collapsed[p] = !open
}

// Treffer-Hervorhebung (Substring, ohne v-html).
function hl(name) {
  const q = search.value.trim().toLowerCase()
  if (!q) return [{ t: name, m: false }]
  const lower = name.toLowerCase()
  const parts = []
  let i = 0
  while (i < name.length) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) { parts.push({ t: name.slice(i), m: false }); break }
    if (idx > i) parts.push({ t: name.slice(i, idx), m: false })
    parts.push({ t: name.slice(idx, idx + q.length), m: true })
    i = idx + q.length
  }
  return parts
}

// Alle Auto-Call-Edges serverseitig neu berechnen + persistieren. Der Graph rendert aus dem
// geteilten useJavaGraph()-edges-Ref und aktualisiert sich nach recomputeEdges() automatisch.
async function onRecomputeEdges() {
  menuOpen.value = false
  try {
    const res = await recomputeEdges()
    setNotice(`${res?.count ?? 0} edge(s) recomputed.`)
  } catch (e) {
    setNotice(e.message, 'error')
  }
}

// Alle noch nicht KI-analysierten Klassen als atomare Einheit (Methoden -> Klasse) einreihen –
// topologisch sortiert (Abhaengigkeiten zuerst). Live-Fortschritt zeigt die Queue-Anzeige; hier
// nur kurzes Toast-Feedback.
async function analyzeAll() {
  if (analyzingAll.value) return
  analyzingAll.value = true
  try {
    const res = await enqueueAllUnanalyzed({ userContext: userContext.value })
    const c = res?.queuedClasses ?? 0
    setNotice(
      c
        ? `Queued: ${c} class(es) for full analysis (methods → summary).`
        : 'Everything already analyzed – nothing to queue.',
    )
  } catch (e) {
    setNotice(e.message, 'error')
  } finally {
    analyzingAll.value = false
  }
}

async function onFile(e) {
  const list = [...(e.target.files || [])]
  if (!list.length) return
  filename.value = list.length === 1 ? list[0].name : `${list.length} files`
  const texts = await Promise.all(list.map((f) => f.text()))
  // Mehrere Dateien zusammenfuegen -> das Backend trennt sie wieder (package-/Typ-Grenzen).
  source.value = texts.join('\n\n')
  showNew.value = true
}

// Erfolgreichen Batch abschliessen. Reihenfolge ist hier die eigentliche Funktion: Der GRAPH
// steht bereits (analyzeBatch hat die Dateien geladen) – die KI-Queue wird nur noch angestossen
// und NICHT abgewartet. Frueher lief hier pro Klasse ein eigener Request samt Nachladen der
// gesamten Queue-Liste; bei 1000 Klassen blockierte das die Oberflaeche minutenlang, bevor
// ueberhaupt etwas zu sehen war.
function finishBatch(res) {
  const saved = res.saved || []
  if (saved.length) {
    selectedFileId.value = saved[0].id
    enqueueMany(saved, { userContext: userContext.value }).catch((e) => setNotice(e.message, 'error'))
  }
  // ZWEI Karten, weil es zwei Aussagen sind: was ankam, und was dabei auffiel. Aneinander-
  // gereiht ergaben sie einen Fliesstext, in dem schon bei einer Handvoll Hinweise weder das
  // Ergebnis noch die Hinweise zu erfassen waren – und das Ganze in Rot, obwohl der Import
  // gelungen ist. Die Hinweise sind eine Warnung, kein Fehler: der Rest ist importiert.
  const parts = []
  if (res.overwritten?.length) parts.push(`${res.overwritten.length} overwritten.`)
  if (saved.length) parts.push('Graph is ready – AI analysis runs in the background.')
  push({
    kind: 'success',
    title: `${saved.length} class(es) parsed`,
    message: parts.join(' '),
  })
  if (res.warnings?.length) {
    // Eine Zeile je Hinweis (die Karte rendert Umbrueche). Gedeckelt ist die Liste bereits
    // serverseitig – hier kommen nie hunderte Zeilen an.
    push({
      kind: 'warning',
      title: `${res.warnings.length} note(s) about this import`,
      message: res.warnings.join('\n'),
    })
  }
  source.value = ''
  filename.value = ''
  showNew.value = false
}

// --- Fortschritt des Parse-/Speicher-Laufs ---------------------------------------------------
// Ein Paste mit 150.000 Zeilen ist EIN Request, der je nach Maschine zehn Sekunden bis Minuten
// laeuft. Der Server meldet seine Phasen per SSE; hier werden sie zu einer Gesamtquote verrechnet.
// Die Gewichte sind gemessene Anteile (Parsen dominiert), keine Schaetzung ins Blaue.
// Gewichte = gemessene Zeitanteile eines 5000-Klassen-Laufs (Parsen ~6 s, Schreiben + Kanten ~9 s).
const PHASES = [
  { key: 'split', label: 'Splitting sources', weight: 0.03 },
  { key: 'parse', label: 'Parsing classes', weight: 0.42 },
  { key: 'check', label: 'Checking duplicates', weight: 0.1 },
  { key: 'save', label: 'Writing to database', weight: 0.33 },
  { key: 'edges', label: 'Computing call edges', weight: 0.12 },
]
// Der Komplett-Reset laeuft durch denselben Apparat, hat aber eigene Phasen.
const RESET_PHASES = [
  { key: 'delete', label: 'Removing classes', weight: 0.85 },
  { key: 'edges', label: 'Clearing edges', weight: 0.15 },
]
const progress = ref(null) // { phase, done, total }
const elapsedMs = ref(0)
const phaseStartedAt = ref(0)
let elapsedTimer = null
let runStartedAt = 0

// Fortschrittsereignis uebernehmen und den Phasenwechsel stempeln (fuer die Zeit-Interpolation
// in Phasen, die keinen Zaehler liefern koennen).
function onRunProgress(ev) {
  if (!ev) return
  if (ev.phase !== progress.value?.phase) phaseStartedAt.value = Date.now()
  progress.value = ev
}

function startRunClock() {
  runStartedAt = Date.now()
  phaseStartedAt.value = runStartedAt
  elapsedMs.value = 0
  clearInterval(elapsedTimer)
  // 250 ms: fluessig genug fuer eine Sekundenanzeige, ohne unnoetige Renders.
  elapsedTimer = setInterval(() => (elapsedMs.value = Date.now() - runStartedAt), 250)
}
function stopRunClock() {
  clearInterval(elapsedTimer)
  elapsedTimer = null
  progress.value = null
}

// Welche Phasenkette gerade gilt (Analyse oder Reset).
const activePhases = computed(() => (resetting.value ? RESET_PHASES : PHASES))
const phaseIndex = computed(() => {
  const list = activePhases.value
  const i = list.findIndex((p) => p.key === progress.value?.phase)
  return i === -1 ? (progress.value?.phase === 'done' ? list.length : 0) : i
})
// Anteil erledigter Phasen + Bruchteil der laufenden.
//
// Die Schreibphase kann keinen Zaehler liefern: better-sqlite3 arbeitet synchron, waehrend der
// Transaktion kommt vom Server nichts. Statt den Ring dort minutenlang einfrieren zu lassen,
// naehert er sich in solchen Phasen ZEITBASIERT dem Phasenende (asymptotisch, erreicht es nie) –
// die Anzeige bleibt lebendig, ohne einen Fortschritt zu behaupten, der schon erreicht waere.
const PHASE_TAU_MS = 9000
// Fuellgrad der LAUFENDEN Phase (0..1). Eigene Groesse, weil zwei Anzeigen sie brauchen: der
// Ring im Modal (als Teil der Gesamtquote) und die Phasenleiste im Header. Zweimal gerechnet
// waere zweimal die Gelegenheit, auseinanderzulaufen.
const currentPhaseFraction = computed(() => {
  const p = progress.value
  if (!p) return 0
  if (p.phase === 'done') return 1
  // `now` aus dem tickenden elapsedMs ableiten – so ist die Interpolation reaktiv.
  const now = runStartedAt + elapsedMs.value
  // Zeitkurve laeuft IMMER mit (deckelt bei 90 % der Phase, erreicht sie also nie von selbst);
  // meldet der Server einen weiteren Zaehlerstand, gewinnt der.
  const byTime = (1 - Math.exp(-Math.max(0, now - phaseStartedAt.value) / PHASE_TAU_MS)) * 0.9
  const byCount = p.total ? Math.min(1, (p.done || 0) / p.total) : 0
  return Math.max(0, Math.min(1, Math.max(byTime, byCount)))
})
const runPercent = computed(() => {
  const p = progress.value
  if (!p) return 0
  if (p.phase === 'done') return 100
  let acc = 0
  const list = activePhases.value
  for (let i = 0; i < phaseIndex.value; i++) acc += list[i].weight
  const cur = list[phaseIndex.value]
  if (cur) acc += cur.weight * currentPhaseFraction.value
  return Math.max(1, Math.min(99, Math.round(acc * 100)))
})
// Fuellgrad EINER Phase fuer die Segmentleiste: durch = 1, laufend = ihr Bruchteil, offen = 0.
const phaseFill = (i) => (i < phaseIndex.value ? 1 : i === phaseIndex.value ? currentPhaseFraction.value : 0)
// Restzeit aus der bisher gemessenen Rate. Erst ab etwas Fortschritt, sonst schwankt sie wild.
const runRemainingMs = computed(() => {
  const pct = runPercent.value
  if (pct < 5 || pct >= 100 || elapsedMs.value < 1500) return null
  return Math.round((elapsedMs.value / pct) * (100 - pct))
})
const runPhaseLabel = computed(() => activePhases.value[phaseIndex.value]?.label || 'Finishing up')

async function analyze() {
  if (!source.value.trim()) return
  startRunClock()
  progress.value = { phase: 'split', done: 0, total: 0 }
  try {
    const res = await analyzeBatch(source.value, { onProgress: onRunProgress })
    // DB-Duplikate -> erst nachfragen, dann ggf. mit overwrite erneut senden.
    if (res.needsConfirm) {
      pendingConflicts.value = res.conflicts
      return
    }
    finishBatch(res)
  } catch {
    // Fehler steht in `error` (Composable) und wird im Modal angezeigt.
  } finally {
    stopRunClock()
  }
}

async function confirmOverwrite() {
  confirming.value = true
  pendingConflicts.value = null // Dialog schliessen -> der Fortschritt im Modal wird sichtbar
  startRunClock()
  progress.value = { phase: 'split', done: 0, total: 0 }
  try {
    const res = await analyzeBatch(source.value, {
      overwrite: true,
      onProgress: onRunProgress,
    })
    finishBatch(res)
  } catch {
    // Fehler steht in `error` (Composable).
  } finally {
    confirming.value = false
    stopRunClock()
  }
}
function cancelOverwrite() {
  if (confirming.value) return
  pendingConflicts.value = null
}

function selectFile(id) {
  // Manuelle Auswahl -> evtl. ausstehende Such-Zielzeile verwerfen (kein Fehl-Highlight).
  activeTargetLine.value = null
  activeTargetEndLine.value = null
  selectedFileId.value = id
}

// Klick im Baum: Klasse auswaehlen UND den Graph dorthin fuehren (Package oeffnen + zentrieren).
function selectFileFromTree(file) {
  selectFile(file.id)
  focusGraphOnFile(file)
}

// --- Klasse loeschen (Hover-Button -> Bestaetigung) ---
function askDelete(file) {
  pendingDelete.value = file
}
function cancelDelete() {
  if (deleting.value) return
  pendingDelete.value = null
}
async function confirmDelete() {
  const file = pendingDelete.value
  if (!file) return
  deleting.value = true
  try {
    await cancelJob(file.id).catch(() => {})
    await deleteFile(file.id)
    if (selectedFileId.value === file.id) selectedFileId.value = null
    pendingDelete.value = null
  } catch (e) {
    setNotice(e.message, 'error')
  } finally {
    deleting.value = false
  }
}
async function onDetailClose(payload) {
  if (payload?.deleted) await fetchFiles()
  selectedFileId.value = null
}

// --- Komplett-Reset: alle Klassen + Kanten + Queue dauerhaft entfernen ---
function askReset() {
  menuOpen.value = false
  pendingReset.value = true
}
function cancelReset() {
  if (resetting.value) return
  pendingReset.value = false
}
async function confirmReset() {
  if (resetting.value) return
  resetting.value = true
  // Derselbe Fortschritts-Apparat wie beim Analysieren: bei tausenden Klassen dauert auch das
  // Loeschen spuerbar, und ein stummer Dialog laesst offen, ob ueberhaupt etwas passiert.
  startRunClock()
  progress.value = { phase: 'delete', done: 0, total: classCount.value }
  try {
    await cancelAllJobs() // laufende/abgeschlossene KI-Jobs stoppen + leeren
    await resetAll({ onProgress: onRunProgress }) // alle Klassen aus der DB loeschen
    resetEdges() // Frontend-Kanten-Spiegel sofort leeren
    // Lokalen View-State auf "frisch geoeffnet" zuruecksetzen.
    selectedFileId.value = null
    activeTargetLine.value = null
    activeTargetEndLine.value = null
    source.value = ''
    filename.value = ''
    search.value = ''
    clearNotifications()
    clearEdgeReturn()
    pendingDelete.value = null
    pendingConflicts.value = null
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    showNew.value = true // Neu-Panel einladend wieder aufklappen
    pendingReset.value = false
  } catch (e) {
    setNotice(e.message, 'error')
  } finally {
    resetting.value = false
    stopRunClock()
  }
}

function onResetPanels() {
  menuOpen.value = false
  resetPanels()
}
</script>

<template>
  <div class="flex h-full flex-col text-[var(--color-text)]">
    <!-- ── Command-Bar: eine Zeile, damit die Arbeitsflaeche darunter den Raum bekommt ── -->
    <header class="shrink-0 border-b border-[var(--color-border)] px-5 py-2.5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            <Icon icon="lucide:git-fork" class="h-[18px] w-[18px]" />
          </span>
          <h1 class="truncate font-mono text-[0.9375rem] font-semibold tracking-tight">Code Analysis</h1>
        </div>

        <!--
          Laufender Import: die Command-Bar wird zur Live-Anzeige. Sie steht an der Stelle der
          Bestandsmetriken, weil beides dieselbe Frage beantwortet ("was ist gerade da?") und
          waehrend eines Laufs die laufende Zahl die interessantere ist – nebeneinander waeren
          es zwei Zahlenreihen, die um denselben Blick konkurrieren.

          Aufgeschluesselt heisst: je Server-Phase ein Segment, dessen BREITE dem Zeitgewicht
          der Phase entspricht (PHASES[].weight). Damit zeigt die Leiste nicht nur "62 %",
          sondern auch, welcher Abschnitt gerade laeuft und wie viel Weg er noch hat – bei
          einem Import, der Minuten braucht, ist das der Unterschied zwischen "es tut sich
          etwas" und "es haengt". Klick stellt das Modal wieder her.
        -->
        <button
          v-if="analyzing && progress"
          type="button"
          class="run-chip group flex min-w-0 items-center gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-accent-soft)] py-1.5 pl-2.5 pr-3 text-left transition hover:border-[var(--color-accent)]"
          :title="`${runPhaseLabel} – ${runPercent}% done, ${formatDuration(elapsedMs)} elapsed${
            runRemainingMs != null ? `, about ${formatDuration(runRemainingMs)} left` : ''
          }. Click to reopen the progress dialog.`"
          @click="showNew = true"
        >
          <Icon icon="lucide:loader-2" class="h-4 w-4 shrink-0 animate-spin text-[var(--color-accent)]" />
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex min-w-0 items-baseline gap-2">
              <span class="truncate text-2xs font-semibold text-[var(--color-accent)]">{{ runPhaseLabel }}</span>
              <span class="shrink-0 font-mono text-2xs font-semibold tabular-nums text-[var(--color-accent)]">{{ runPercent }}%</span>
              <span class="hidden shrink-0 font-mono text-2xs tabular-nums text-[var(--color-text-muted)] sm:inline">
                {{ formatDuration(elapsedMs) }}
                <template v-if="runRemainingMs != null">
                  <span class="opacity-40">·</span> {{ formatDuration(runRemainingMs) }}<span class="opacity-60"> left</span>
                </template>
              </span>
            </div>
            <!-- Segmentleiste: eine Spalte je Phase, Spaltenbreite = Gewicht der Phase. -->
            <div
              class="grid h-1 w-[13rem] gap-px lg:w-[17rem]"
              :style="{ gridTemplateColumns: activePhases.map((p) => `${p.weight}fr`).join(' ') }"
            >
              <span
                v-for="(p, i) in activePhases"
                :key="p.key"
                class="relative overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
              >
                <span
                  class="absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)] transition-[width] duration-500 ease-out"
                  :style="{ width: phaseFill(i) * 100 + '%' }"
                />
              </span>
            </div>
          </div>
          <!-- Nur als Affordanz: das Modal ist einen Klick entfernt, nicht weg. -->
          <Icon
            icon="lucide:maximize-2"
            class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)] opacity-0 transition group-hover:opacity-70"
          />
        </button>

        <!-- Live-Metriken: monospace + gedaempft. Zahlen tragen die Information, nicht die Farbe. -->
        <div v-else-if="files.length" class="hidden items-center gap-2.5 font-mono text-2xs text-[var(--color-text-muted)] md:flex">
          <span v-for="lang in LANGUAGES" :key="lang.id" class="inline-flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />{{ lang.label }}
          </span>
          <span class="opacity-40">·</span>
          <span><b class="font-semibold tabular-nums text-[var(--color-text)]">{{ classCount }}</b> classes</span>
          <span class="opacity-40">·</span>
          <span><b class="font-semibold tabular-nums text-[var(--color-text)]">{{ packageCount }}</b> packages</span>
          <span class="opacity-40">·</span>
          <span class="inline-flex items-center gap-1">
            <Icon icon="lucide:sparkles" class="h-3 w-3 text-[var(--color-accent)]" />
            <b class="font-semibold tabular-nums text-[var(--color-text)]">{{ analyzedCount }}</b>/{{ classCount }} analyzed
          </span>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <!-- AI-Queue: Chip mit Live-Status. Bei laufender Analyse traegt er den Gesamtfortschritt
               als Fuellbalken im Hintergrund + Restzeit-Schaetzung – bei 1000 Klassen laeuft die
               Queue stundenlang, da ist "wie weit / wie lange noch" die eigentliche Information. -->
          <button
            type="button"
            class="action-btn relative isolate inline-flex h-9 items-center gap-2 overflow-hidden rounded-lg border px-2.5 text-[0.8125rem] font-medium transition"
            :class="queueActive
              ? 'border-[color-mix(in_srgb,var(--color-lavender)_40%,transparent)] bg-[var(--color-lavender-soft)] text-[var(--color-lavender)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
            :title="runningQueueJob
              ? `Analyzing ${runningQueueJob.className} – ${finishedQueueCount}/${queueSummary?.total ?? 0} classes done${queueEta ? `, ${queueEta} remaining` : ''}`
              : 'Open the AI analysis queue'"
            @click="queueOpen = true"
          >
            <!-- Fuellbalken: liegt hinter dem Inhalt, waechst mit den erledigten Einheiten. -->
            <span
              v-if="queueActive"
              class="absolute inset-y-0 left-0 -z-10 bg-[color-mix(in_srgb,var(--color-lavender)_22%,transparent)] transition-[width] duration-500 ease-out"
              :style="{ width: queuePercent + '%' }"
            />
            <Icon
              :icon="runningQueueJob ? 'lucide:loader-2' : 'lucide:list-checks'"
              class="h-4 w-4 shrink-0"
              :class="runningQueueJob ? 'animate-spin' : ''"
            />
            <span class="hidden sm:inline">AI Queue</span>
            <span v-if="queueActive" class="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
              <span v-if="runningQueueJob" class="hidden max-w-[9rem] truncate opacity-90 lg:inline">{{ runningQueueJob.className }}</span>
              <span class="shrink-0 font-semibold tabular-nums">{{ finishedQueueCount }}/{{ queueSummary?.total ?? 0 }}</span>
              <span v-if="queueEta" class="shrink-0 tabular-nums opacity-70">{{ queueEta }}</span>
            </span>
            <span v-else-if="finishedQueueCount" class="font-mono text-2xs tabular-nums opacity-70">{{ finishedQueueCount }}</span>
          </button>

          <!-- KI-Sammellauf ueber alle noch nicht analysierten Klassen. -->
          <button
            v-if="files.length"
            type="button"
            class="action-btn inline-flex h-9 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-accent-soft)] px-2.5 text-[0.8125rem] font-semibold text-[var(--color-accent)] transition hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="analyzingAll"
            title="Queue every not-yet-analyzed class and method for AI analysis"
            @click="analyzeAll"
          >
            <Icon
              :icon="analyzingAll ? 'lucide:loader-2' : 'lucide:sparkles'"
              class="h-4 w-4"
              :class="analyzingAll ? 'animate-spin' : ''"
            />
            <span class="hidden sm:inline">{{ analyzingAll ? 'Queueing…' : 'Run AI' }}</span>
          </button>

          <!-- Primaeraktion: neue Quellen einlesen. -->
          <button
            type="button"
            class="action-btn inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[0.8125rem] font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)]"
            title="Parse new .java sources"
            @click="showNew = true"
          >
            <Icon icon="lucide:plus" class="h-4 w-4" />
            Add code
          </button>

          <!-- Overflow: selten genutzt + destruktiv, damit die Bar ruhig bleibt. -->
          <div class="relative">
            <button
              type="button"
              class="action-btn grid h-9 w-9 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              :class="menuOpen ? 'bg-[var(--color-surface-offset)] text-[var(--color-text)]' : ''"
              title="More actions"
              aria-label="More actions"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <Icon icon="lucide:more-horizontal" class="h-4 w-4" />
            </button>
            <!-- Klick-ausserhalb faengt ein transparenter Backdrop ab (kein globaler Listener). -->
            <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />
            <Transition name="pop">
              <div
                v-if="menuOpen"
                class="absolute right-0 top-11 z-50 w-60 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 shadow-xl"
              >
                <button type="button" class="menu-item" :disabled="recomputing || !files.length" @click="onRecomputeEdges">
                  <Icon :icon="recomputing ? 'lucide:loader-2' : 'lucide:git-branch'" class="h-4 w-4 shrink-0" :class="recomputing ? 'animate-spin' : ''" />
                  <span class="flex-1 text-left">Recompute edges</span>
                </button>
                <button type="button" class="menu-item" :disabled="!isWide || !panelsDirty" @click="onResetPanels">
                  <Icon icon="lucide:layout-grid" class="h-4 w-4 shrink-0" />
                  <span class="flex-1 text-left">Reset layout</span>
                </button>
                <div class="my-1 h-px bg-[var(--color-border)]" />
                <button type="button" class="menu-item menu-item--danger" :disabled="resetting || !files.length" @click="askReset">
                  <Icon icon="lucide:trash-2" class="h-4 w-4 shrink-0" />
                  <span class="flex-1 text-left">Delete all data</span>
                </button>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </header>

    <!-- Neu-Analyse als Modal (ausgeloest vom Primaerbutton der Command-Bar). -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showNew"
          class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
          @click.self="showNew = false"
        >
          <!--
            Feste Modalhoehe (Header / scrollender Body / verankerter Footer). Damit bleibt der
            Analyze-Button auch bei 500 erkannten Klassen an derselben Stelle sichtbar – frueher
            schob ihn die Chip-Liste aus dem Viewport.
          -->
          <section
            class="flex max-h-[min(88vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
          >
            <header class="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
              <h2 class="flex items-center gap-2 text-base font-bold text-[var(--color-text)]">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:sparkles" class="h-[18px] w-[18px]" />
                </span>
                Analyze code
              </h2>
              <!-- Eingabemodus: Code einfuegen vs. .java-Datei(en) hochladen (beide fuellen `source`). -->
              <div class="ml-auto inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition"
                  :class="inputMode === 'paste' ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
                  @click="inputMode = 'paste'"
                >
                  <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                  Paste code
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition"
                  :class="inputMode === 'file' ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
                  @click="inputMode = 'file'"
                >
                  <Icon icon="lucide:upload" class="h-3.5 w-3.5" />
                  Upload file
                </button>
              </div>
              <!-- Waehrend eines Laufs ist das kein Abbrechen, sondern ein Wegstellen: der Import
                   laeuft weiter, die Command-Bar traegt ihn sichtbar (run-chip). Icon + Titel
                   sagen das auch – ein "×" an dieser Stelle laese "abbrechen" erwarten. -->
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                :title="analyzing ? 'Minimize – the run keeps going' : 'Close'"
                :aria-label="analyzing ? 'Minimize' : 'Close'"
                @click="showNew = false"
              >
                <Icon :icon="analyzing ? 'lucide:minimize-2' : 'lucide:x'" class="h-5 w-5" />
              </button>
            </header>

            <!-- Laufender Durchgang: der Editor weicht der Fortschrittsanzeige. Bei 150.000 Zeilen
                 laeuft dieser eine Request minutenlang – „wie weit" und „wie lange noch" sind dann
                 die einzigen Fragen, die zaehlen. -->
            <div v-if="analyzing && progress" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-8">
              <!-- Ring: Gesamtquote aus den gewichteten Server-Phasen. -->
              <div class="relative grid h-44 w-44 shrink-0 place-items-center">
                <svg class="h-44 w-44 -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="54" fill="none" stroke="var(--color-surface-offset)" stroke-width="8" />
                  <circle
                    cx="60"
                    cy="60"
                    r="54"
                    fill="none"
                    stroke="var(--color-accent)"
                    stroke-width="8"
                    stroke-linecap="round"
                    :stroke-dasharray="339.29"
                    :stroke-dashoffset="339.29 * (1 - runPercent / 100)"
                    style="transition: stroke-dashoffset 0.4s ease"
                  />
                </svg>
                <div class="absolute grid place-items-center">
                  <span class="font-mono text-3xl font-bold tabular-nums text-[var(--color-text)]">{{ runPercent }}<span class="text-lg text-[var(--color-text-muted)]">%</span></span>
                  <!-- Zaehler nur, solange er auch zaehlt: die Schreibphase kann keinen liefern
                       (synchrone Transaktion), ein stehendes „0/5.000" waere irrefuehrend. -->
                  <span v-if="progress.total && progress.done" class="mt-0.5 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">
                    {{ nf.format(progress.done) }}/{{ nf.format(progress.total) }}
                  </span>
                </div>
              </div>

              <div class="text-center">
                <p class="text-sm font-semibold text-[var(--color-text)]">{{ runPhaseLabel }}</p>
                <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                  You can close this – the run continues and stays visible in the top bar.
                </p>
              </div>

              <!-- Phasenkette: zeigt, was schon durch ist und was noch kommt. -->
              <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
                <template v-for="(p, i) in PHASES" :key="p.key">
                  <span v-if="i" class="h-px w-4 bg-[var(--color-border)]" />
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition"
                    :class="i < phaseIndex
                      ? 'border-[color-mix(in_srgb,var(--color-success)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[var(--color-success)]'
                      : i === phaseIndex
                        ? 'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                        : 'border-[var(--color-border)] text-[var(--color-text-muted)] opacity-60'"
                  >
                    <Icon
                      v-if="i < phaseIndex"
                      icon="lucide:check"
                      class="h-3 w-3"
                    />
                    <Icon v-else-if="i === phaseIndex" icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
                    <span v-else class="h-1 w-1 rounded-full bg-current" />
                    {{ p.label }}
                  </span>
                </template>
              </div>

              <!-- Die zwei Zeiten: verstrichen und geschaetzte Restzeit. -->
              <div class="flex items-stretch gap-3">
                <div class="min-w-[8.5rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-center">
                  <div class="font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]">{{ formatDuration(elapsedMs) }}</div>
                  <div class="mt-1 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">elapsed</div>
                </div>
                <div class="min-w-[8.5rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-center">
                  <div class="font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]">
                    {{ runRemainingMs != null ? formatDuration(runRemainingMs) : '–:––' }}
                  </div>
                  <div class="mt-1 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">remaining</div>
                </div>
              </div>
            </div>

            <!-- Arbeitsflaeche: ab lg zweispaltig und in sich scrollend, darunter gestapelt. -->
            <div v-else class="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden">
              <div class="flex min-h-0 min-w-0 flex-col gap-2">
                <label
                  v-if="inputMode === 'file'"
                  class="flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-offset)]"
                >
                  <Icon icon="lucide:file-code" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                  <span v-if="filename" class="truncate font-mono text-[var(--color-text)]">{{ filename }}</span>
                  <span v-else>Choose .java file(s) – multiple files are merged and split again by the parser.</span>
                  <input type="file" accept=".java" multiple class="hidden" @change="onFile" />
                </label>
                <div class="h-56 shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
                  <JavaCodeEditor v-model="source" />
                </div>
                <!-- Live-Vorschau der erkannten Klassen: eigener Scroller, feste Deckelung. -->
                <JavaDetectedClasses :classes="detectedClasses" class="shrink-0" />
              </div>

              <aside class="flex min-h-0 min-w-0 flex-col gap-3">
                <!-- Kacheln erst, wenn es etwas zu zaehlen gibt – vier Nullen sagen nichts. -->
                <div v-if="sourceStats" class="grid shrink-0 grid-cols-2 gap-2">
                  <div v-for="s in inputTiles" :key="s.label" class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2">
                    <div class="font-mono text-[1.0625rem] font-semibold leading-none tabular-nums text-[var(--color-text)]">{{ s.value }}</div>
                    <div class="mt-1.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{{ s.label }}</div>
                  </div>
                </div>
                <label class="flex min-h-0 flex-1 flex-col">
                  <span class="mb-1 block text-2xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Project context (optional)</span>
                  <textarea
                    v-model="userContext"
                    spellcheck="false"
                    placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
                    class="min-h-[6rem] w-full flex-1 resize-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                  />
                </label>
              </aside>
            </div>

            <!-- Footer: verankert, traegt die Primaeraktion. Scrollt nie weg. -->
            <footer class="flex shrink-0 flex-wrap items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <p v-if="error" class="min-w-0 flex-1 text-xs text-[var(--color-danger)]">{{ error }}</p>
              <p v-else class="min-w-0 flex-1 font-mono text-2xs text-[var(--color-text-muted)]">
                {{ sourceStats ? 'Parsed server-side – every type becomes its own class.' : 'Paste one or many Java types – they are split automatically.' }}
              </p>
              <span class="hidden shrink-0 items-center gap-1 text-2xs text-[var(--color-text-muted)] sm:inline-flex">
                <kbd class="kbd">Ctrl</kbd><span class="opacity-50">+</span><kbd class="kbd">↵</kbd>
              </span>
              <button
                type="button"
                class="action-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                @click="showNew = false"
              >
                <Icon v-if="analyzing" icon="lucide:minimize-2" class="h-4 w-4" />
                {{ analyzing ? 'Run in background' : 'Cancel' }}
              </button>
              <button
                type="button"
                class="action-btn inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-6 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                :disabled="analyzing || !source.trim()"
                @click="analyze"
              >
                <Icon :icon="analyzing ? 'lucide:loader-2' : 'lucide:sparkles'" class="h-4 w-4" :class="analyzing ? 'animate-spin' : ''" />
                {{ analyzing ? 'Analyzing…' : detectedClasses.length ? `Analyze ${detectedClasses.length} class(es)` : 'Analyze' }}
              </button>
            </footer>
          </section>
        </div>
      </Transition>
    </Teleport>

    <!-- 3-Spalten-Layout (ab lg per Drag verschiebbar; darunter einspaltig gestapelt). -->
    <div
      class="grid min-h-0 flex-1 p-4"
      :class="isWide ? '' : 'grid-cols-1 gap-4'"
      :style="isWide ? { gridTemplateColumns: gridTemplate } : null"
    >
      <!-- Spalte 1: Suche + Package-Tree -->
      <section class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div class="shrink-0 border-b border-[var(--color-border)] p-2">
          <div class="relative">
            <Icon icon="lucide:search" class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              v-model="search"
              type="text"
              placeholder="Filter classes…"
              class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5 pl-8 pr-7 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
            <button
              v-if="search"
              type="button"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
              title="Clear filter"
              @click="search = ''"
            >
              <Icon icon="lucide:x" class="h-3.5 w-3.5" />
            </button>
          </div>
          <!-- Baum-Werkzeugzeile: links, was der Baum gerade zeigt, rechts der Falt-Umschalter.
               Er gehoert hierher und nicht an die Ordnerzeilen: er wirkt auf den GANZEN Baum. -->
          <div v-if="rows.length" class="mt-1.5 flex items-center justify-between gap-2 pl-1">
            <!-- Links nur die Trefferbilanz der Suche. KEINE Package-Zahl: der Baum zieht leere
                 Zwischenebenen zusammen (`com.acme` als ein Knoten), seine Knotenzahl weicht damit
                 von der Package-Zahl in der Kommandozeile ab – zwei Zahlen fuer dasselbe Wort. -->
            <p class="min-w-0 truncate font-mono text-3xs text-[var(--color-text-muted)]">
              <template v-if="searching">{{ filteredFiles.length }} of {{ classCount }} match</template>
            </p>
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:pointer-events-none disabled:opacity-40"
              :disabled="searching || !folderPaths.length"
              :title="searching
                ? 'While filtering, every matching package stays open'
                : anyFolderOpen
                  ? 'Collapse every package in the tree'
                  : 'Expand every package in the tree'"
              @click="setAllFolders(!anyFolderOpen)"
            >
              <Icon :icon="anyFolderOpen ? 'lucide:fold-vertical' : 'lucide:unfold-vertical'" class="h-3.5 w-3.5" />
              {{ anyFolderOpen ? 'Collapse all' : 'Expand all' }}
            </button>
          </div>
        </div>

        <ul class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <li v-for="row in rows" :key="row.id">
            <!-- Package-Ordner -->
            <button
              v-if="row.kind === 'folder'"
              type="button"
              class="tree-row group/f flex w-full items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-left text-2xs font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              @click="toggleFolder(row.fullPath, row.open)"
            >
              <span v-for="d in row.depth" :key="d" class="tree-guide" />
              <Icon icon="lucide:chevron-down" class="h-3 w-3 shrink-0 opacity-70 transition-transform" :class="row.open ? '' : '-rotate-90'" />
              <Icon icon="lucide:package" class="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span class="min-w-0 flex-1 truncate font-mono">{{ row.label }}</span>
              <span class="shrink-0 font-mono text-3xs tabular-nums opacity-60">{{ row.count }}</span>
            </button>

            <!-- Klasse -->
            <div v-else class="group relative">
              <button
                type="button"
                class="tree-row flex w-full items-center gap-1.5 rounded-md py-1.5 pl-1 pr-8 text-left transition"
                :class="selectedFileId === row.file.id
                  ? 'is-selected bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-surface-offset)]'"
                @click="selectFileFromTree(row.file)"
              >
                <span v-for="d in row.depth" :key="d" class="tree-guide" />
                <Icon
                  icon="lucide:braces"
                  class="h-3.5 w-3.5 shrink-0"
                  :class="selectedFileId === row.file.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
                />
                <span class="min-w-0 flex-1 truncate text-[0.8125rem]" :class="selectedFileId === row.file.id ? 'font-semibold' : ''">
                  <template v-for="(p, i) in hl(row.file.class_name)" :key="i"><mark v-if="p.m" class="rounded-sm bg-transparent px-0 font-semibold text-[var(--color-accent)]">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
                </span>
                <!-- Status rechts: laufende Queue schlaegt den ruhenden AI-Punkt. -->
                <span
                  v-if="progressFor(row.file.id)"
                  class="shrink-0 rounded-full px-1.5 font-mono text-3xs font-semibold tabular-nums transition group-hover:opacity-0"
                  :class="progressFor(row.file.id).status === 'running' ? 'badge-accent' : 'badge-success'"
                >
                  {{ progressFor(row.file.id).done }}/{{ progressFor(row.file.id).total }}
                </span>
                <Icon
                  v-else-if="row.file.description"
                  icon="lucide:sparkles"
                  class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)] transition group-hover:opacity-0"
                  title="AI-analyzed"
                />
                <span
                  v-if="row.file.method_count"
                  class="shrink-0 font-mono text-3xs tabular-nums text-[var(--color-text-muted)] opacity-60 transition group-hover:opacity-0"
                >
                  {{ row.file.method_count }}
                </span>
              </button>
              <button
                type="button"
                class="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[var(--color-danger)] opacity-0 transition hover:bg-[var(--color-surface-offset)] focus:opacity-100 group-hover:opacity-100"
                title="Delete class"
                :aria-label="`Delete class ${row.file.class_name}`"
                @click.stop="askDelete(row.file)"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
              </button>
            </div>
          </li>

          <!-- Leerzustand: getrennt fuer "nichts geladen" und "Filter ohne Treffer". -->
          <li v-if="!rows.length" class="px-3 py-10 text-center">
            <template v-if="searching">
              <Icon icon="lucide:search" class="mx-auto mb-2 h-6 w-6 text-[var(--color-text-muted)] opacity-40" />
              <p class="text-xs text-[var(--color-text-muted)]">No class matches “{{ search }}”.</p>
            </template>
            <template v-else>
              <Icon icon="lucide:braces" class="mx-auto mb-2 h-6 w-6 text-[var(--color-text-muted)] opacity-40" />
              <p class="mb-3 text-xs text-[var(--color-text-muted)]">No classes analyzed yet.</p>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-accent)] transition hover:bg-[var(--color-surface-offset)]"
                @click="showNew = true"
              >
                <Icon icon="lucide:plus" class="h-3.5 w-3.5" />
                Add code
              </button>
            </template>
          </li>
        </ul>
      </section>

      <!-- Divider 1↔2 (Drag) -->
      <div
        v-if="isWide"
        class="panel-resizer"
        :class="{ 'is-active': activeKey === 'left' }"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="startDrag('left', $event)"
      >
        <span class="panel-resizer__grip" />
      </div>

      <!-- Spalte 2: Graph -->
      <div class="min-h-[55vh] lg:min-h-0">
        <JavaDependencyGraph
          :files="files"
          :selected-id="selectedFileId"
          :focus-path="graphFocusPath"
          :focus-file-id="graphFocusFileId"
          :focus-token="graphFocusToken"
          :match-ids="searchMatchIds"
          :search-query="searching ? search : ''"
          @select="selectFile"
          @clear-search="search = ''"
        />
      </div>

      <!-- Divider 2↔3 (Drag) -->
      <div
        v-if="isWide"
        class="panel-resizer"
        :class="{ 'is-active': activeKey === 'right' }"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="startDrag('right', $event)"
      >
        <span class="panel-resizer__grip" />
      </div>

      <!-- Spalte 3: Detail -->
      <div class="flex min-h-0 flex-col gap-2">
        <!-- Rueckweg zur Kante, ueber die man hier gelandet ist. Steht UEBER dem Detail und nicht
             im Graphen: hierher schaut der Nutzer nach dem Sprung, und hier stellt sich die Frage
             „und wie komme ich zurueck?". -->
        <Transition name="pop">
          <button v-if="edgeReturn" type="button" class="edge-back" @click="requestEdgeReturn()">
            <span class="edge-back-ic"><Icon icon="lucide:corner-up-left" class="h-4 w-4" /></span>
            <span class="min-w-0 flex-1 text-left">
              <span class="block text-2xs font-semibold uppercase tracking-[0.12em] opacity-70">Back to relation</span>
              <span class="block truncate font-mono text-[0.8125rem] font-semibold">{{ edgeReturn.label }}</span>
            </span>
            <Icon icon="lucide:git-fork" class="h-4 w-4 shrink-0 opacity-60" />
          </button>
        </Transition>

        <!-- min-h-0 + flex-1: der Detailbereich behaelt seine eigene Scrollflaeche, auch wenn der
             Zurueck-Knopf darueber Platz belegt. -->
        <div class="min-h-0 flex-1">
          <JavaClassDetail
            v-if="selectedFileId"
            :key="selectedFileId"
            :file-id="selectedFileId"
            :target-line="activeTargetLine"
            :target-end-line="activeTargetEndLine"
            @close="onDetailClose"
          />
          <div
            v-else
            class="grid h-full place-items-center rounded-xl border border-dashed border-[var(--color-border)] px-6 text-center"
          >
            <div class="max-w-[15rem]">
              <span class="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-surface-offset)] text-[var(--color-text-muted)]">
                <Icon icon="lucide:mouse-pointer-click" class="h-5 w-5" />
              </span>
              <p class="mb-1 text-sm font-semibold text-[var(--color-text)]">No class selected</p>
              <p class="text-xs leading-relaxed text-[var(--color-text-muted)]">
                Pick one from the list or click a node in the graph to see its methods, AI summaries and source.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Toasts rendert global NotificationHost (App.vue) – hier steht deshalb keiner mehr. -->

    <!-- Drag-Overlay: erzwingt col-resize global und haelt mousemove vom Vue-Flow-Canvas fern. -->
    <div v-if="isDragging" class="fixed inset-0 z-[60] cursor-col-resize select-none" />

    <!-- Bestaetigungs-Dialog: Klasse loeschen -->
    <Teleport to="body">
      <div
        v-if="pendingDelete"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="cancelDelete"
      >
        <div class="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 shadow-xl">
          <div class="mb-3 flex items-center gap-3">
            <span
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--color-danger)]"
              style="background-color: color-mix(in srgb, var(--color-danger) 16%, transparent)"
            >
              <Icon icon="lucide:trash-2" class="h-5 w-5" />
            </span>
            <div class="min-w-0">
              <h3 class="truncate font-semibold text-[var(--color-text)]">Delete class?</h3>
              <p class="truncate font-mono text-xs text-[var(--color-text-muted)]">{{ pendingDelete.class_name }}</p>
            </div>
          </div>
          <p class="mb-4 text-sm text-[var(--color-text-muted)]">
            All graph connections will be removed. A linked wiki article (if any) is kept.
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] disabled:opacity-50"
              :disabled="deleting"
              @click="cancelDelete"
            >
              Cancel
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-danger)] px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
              :disabled="deleting"
              @click="confirmDelete"
            >
              <Icon v-if="deleting" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
              {{ deleting ? 'Deleting…' : 'Delete' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bestaetigungs-Dialog: vorhandene Klassen ueberschreiben -->
    <Teleport to="body">
      <div
        v-if="pendingConflicts"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="cancelOverwrite"
      >
        <div class="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 shadow-xl">
          <div class="mb-3 flex items-center gap-3">
            <span
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--color-warning)]"
              style="background-color: color-mix(in srgb, var(--color-warning) 16%, transparent)"
            >
              <Icon icon="lucide:alert-triangle" class="h-5 w-5" />
            </span>
            <div class="min-w-0">
              <h3 class="truncate font-semibold text-[var(--color-text)]">Overwrite class(es)?</h3>
              <p class="text-xs text-[var(--color-text-muted)]">
                {{ pendingConflicts.length }} class(es) already analyzed.
              </p>
            </div>
          </div>
          <ul class="mb-4 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
            <li
              v-for="fqcn in pendingConflicts"
              :key="fqcn"
              class="flex items-center gap-1.5 truncate font-mono text-xs text-[var(--color-text)]"
            >
              <Icon icon="lucide:box" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              {{ fqcn }}
            </li>
          </ul>
          <p class="mb-4 text-sm text-[var(--color-text-muted)]">
            Overwriting replaces the existing records (including AI descriptions).
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] disabled:opacity-50"
              :disabled="confirming"
              @click="cancelOverwrite"
            >
              Cancel
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              :disabled="confirming"
              @click="confirmOverwrite"
            >
              <Icon v-if="confirming" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
              {{ confirming ? 'Overwriting…' : 'Overwrite' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bestaetigungs-Dialog: alle Klassen zuruecksetzen (destruktiv) -->
    <Teleport to="body">
      <div
        v-if="pendingReset"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="cancelReset"
      >
        <div class="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5 shadow-xl">
          <div class="mb-3 flex items-center gap-3">
            <span
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--color-danger)]"
              style="background-color: color-mix(in srgb, var(--color-danger) 16%, transparent)"
            >
              <Icon icon="lucide:alert-triangle" class="h-5 w-5" />
            </span>
            <div class="min-w-0">
              <h3 class="truncate font-semibold text-[var(--color-text)]">Reset everything?</h3>
              <p class="text-xs text-[var(--color-text-muted)]">{{ classCount }} class(es) affected</p>
            </div>
          </div>
          <p v-if="!resetting" class="mb-4 text-sm text-[var(--color-text-muted)]">
            All analyzed classes, edges and AI summaries will be
            <span class="font-semibold text-[var(--color-text)]">permanently deleted</span>.
            Linked wiki articles are kept.
          </p>

          <!-- Laufender Reset: derselbe Fortschritt wie beim Analysieren, nur kompakt – der
               Dialog ist schmal, ein grosser Ring waere hier fehl am Platz. -->
          <div v-else class="mb-4">
            <div class="mb-1.5 flex items-baseline justify-between gap-2">
              <span class="text-sm font-semibold text-[var(--color-text)]">{{ runPhaseLabel }}</span>
              <span class="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">{{ runPercent }}%</span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
              <div
                class="h-full rounded-full bg-[var(--color-danger)] transition-[width] duration-300 ease-out"
                :style="{ width: runPercent + '%' }"
              />
            </div>
            <div class="mt-2 flex items-baseline justify-between gap-2 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">
              <span v-if="progress?.total">
                <b class="font-semibold text-[var(--color-text)]">{{ nf.format(progress.done || 0) }}</b>/{{ nf.format(progress.total) }} removed
              </span>
              <span v-else>working…</span>
              <span>
                {{ formatDuration(elapsedMs) }}
                <span class="opacity-50">elapsed</span>
                <template v-if="runRemainingMs != null">
                  <span class="opacity-40"> · </span>{{ formatDuration(runRemainingMs) }}<span class="opacity-50"> left</span>
                </template>
              </span>
            </div>
          </div>

          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] disabled:opacity-50"
              :disabled="resetting"
              @click="cancelReset"
            >
              Cancel
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-danger)] px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
              :disabled="resetting"
              @click="confirmReset"
            >
              <Icon v-if="resetting" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
              {{ resetting ? 'Deleting…' : 'Delete all' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- KI-Queue-Modal (breit/langgezogen): aus der Command-Bar geoeffnet. -->
    <JavaQueueModal :open="queueOpen" @close="queueOpen = false" @select="onQueueSelect" />
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Funktionale Transition fuers Neu-Analyse-Modal (kein dekoratives Spielwerk). */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-active section,
.modal-leave-active section {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from section,
.modal-leave-to section {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

/* Overflow-Menue: kurzes Aufklappen aus der Button-Kante. */
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
  transform-origin: top right;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

/* Rueckweg zur Kante (Spalte 3, ueber dem Detail). Bewusst gross und in Akzentfarbe: er ist die
   Antwort auf „wie komme ich zu der Beziehung zurueck, aus der ich hier gelandet bin?" – und ein
   Weg, den man nicht findet, gibt es nicht. Volle Breite, damit der Kantenname (mono, kann lang
   werden) Platz hat und der Knopf nicht neben dem Detail zu suchen ist. */
.edge-back {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.625rem;
  border-radius: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  background: var(--color-accent-soft);
  padding: 0.5rem 0.75rem;
  color: var(--color-accent);
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.edge-back:hover {
  border-color: var(--color-accent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--color-accent) 26%, transparent);
  transform: translateY(-1px);
}
.edge-back:active {
  transform: translateY(0);
}
.edge-back-ic {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
}

/* Tastenkappe fuer den Shortcut-Hinweis im Modal-Footer. */
.kbd {
  display: inline-block;
  min-width: 1.25rem;
  border-radius: 0.3rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface-2);
  padding: 0.05rem 0.3rem;
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.625rem;
  line-height: 1.4;
  text-align: center;
}

/* Eintraege des Overflow-Menues (gleiche Geometrie, Farbe unterscheidet nur die Gefahr). */
.menu-item {
  @apply flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] font-medium transition;
  color: var(--color-text);
}
.menu-item:hover:not(:disabled) {
  background: var(--color-surface-offset);
}
.menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.menu-item--danger {
  color: var(--color-danger);
}
.menu-item--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
}

/* --- Package-Baum: Einrueckung ueber echte Fuehrungslinien statt padding-left ---------- *
 * Jede Ebene rendert einen 12px-Spacer mit linker Haarlinie – dadurch ist die Hierarchie
 * auch bei langen, abgeschnittenen Namen ablesbar. */
.tree-guide {
  flex: 0 0 12px;
  align-self: stretch;
  border-left: 1px solid var(--color-border);
  margin-left: 5px;
}
.tree-row.is-selected .tree-guide {
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
}

/* --- Resizer-Divider zwischen den drei Panels ---------------------------- *
 * 8px breiter Grid-Track (Klickflaeche); die sichtbare Linie ist das ::before.
 * Ruhezustand dezent (Border-Farbe), Hover/Drag deutlich (Akzent + breiter). */
.panel-resizer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
}
.panel-resizer::before {
  content: '';
  width: 2px;
  height: 100%;
  border-radius: 999px;
  background: var(--color-border);
  transition: background 0.15s ease, width 0.15s ease;
}
.panel-resizer:hover::before,
.panel-resizer.is-active::before {
  width: 4px;
  background: var(--color-accent);
}
/* Mittiger Griff (3 Punkte), erst beim Hover/Drag sichtbar -> klare Affordance. */
.panel-resizer__grip {
  position: absolute;
  width: 4px;
  height: 26px;
  border-radius: 999px;
  background-image: radial-gradient(currentColor 1px, transparent 1.4px);
  background-size: 4px 6px;
  background-repeat: repeat-y;
  background-position: center;
  color: var(--color-accent-contrast);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.panel-resizer:hover .panel-resizer__grip,
.panel-resizer.is-active .panel-resizer__grip {
  opacity: 0.9;
}

/* Der Live-Chip eines laufenden Imports. Er atmet leicht – nicht als Zierde: waehrend der
   Schreibphase kann der Server minutenlang keinen Zaehler liefern, und eine vollkommen
   stehende Anzeige liest sich dann wie ein Absturz. Der Puls sitzt auf der Randfarbe
   (box-shadow), nicht auf der Groesse: nichts darf in der Command-Bar wandern. */
.run-chip {
  animation: run-chip-pulse 2.4s ease-in-out infinite;
}
@keyframes run-chip-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 26%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-accent) 6%, transparent);
  }
}
/* Wer Bewegung abbestellt hat, bekommt den Chip ruhig – die Zahlen tragen die Aussage ohnehin. */
@media (prefers-reduced-motion: reduce) {
  .run-chip {
    animation: none;
  }
}

/* Klick-Feedback der Aktions-Buttons: gedrueckt 0.96, federt in 150ms auf 1.0 zurueck. */
.action-btn {
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.action-btn:not(:disabled):active {
  transform: scale(0.96);
}
</style>
