<script setup>
// Code-Analyse-Sektion: schlanke Command-Bar + 3-Spalten-Arbeitsflaeche.
//  Command-Bar: Titel + Live-Metriken links, Aktionen rechts (Primaer "Add code",
//               AI-Queue-Chip, Overflow-Menue fuer selten genutzte/destruktive Aktionen).
//  Spalte 1: Suche + Package-Baum aller geladenen Klassen (Datei-Explorer-Optik)
//  Spalte 2: Klassen-Abhaengigkeitsgraph (Vue Flow + dagre)
//  Spalte 3: vollstaendige Klassen-Doku + KI-Zusammenfassungen
// Datenhaltung via useJavaAnalyzer (Dateien/CRUD) + useJavaQueue (KI-Queue, Polling).
import { ref, reactive, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { useActivity } from '../composables/useActivity.js'
import { buildPackageTree, countClasses, filterClasses, LANGUAGES } from '../composables/useCodeAnalysis.js'
import { usePanelResize } from '../composables/usePanelResize.js'
import { useInsights } from '../composables/useInsights.js'
import { useNotifications } from '../composables/useNotifications.js'
import BusyState from '../components/BusyState.vue'
import ActivityProgress from '../components/ActivityProgress.vue'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import JavaDependencyGraph from '../components/java/JavaDependencyGraph.vue'
import JavaClassDetail from '../components/java/JavaClassDetail.vue'
// Kanten-Detail und Aggregat-Aufloesung: gerechnet werden sie im Graphen (er allein kennt Kanten,
// Dateiliste und Ebenen-Schluessel), gezeigt werden sie hier – neben dem Bild, nicht darueber.
import JavaEdgeDetailPanel from '../components/java/JavaEdgeDetailPanel.vue'
import JavaBundlePanel from '../components/java/JavaBundlePanel.vue'
import JavaExportModal from '../components/java/JavaExportModal.vue'
import JavaQueueModal from '../components/java/JavaQueueModal.vue'
import JavaDetectedClasses from '../components/java/JavaDetectedClasses.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import Modal from '../components/ui/Modal.vue'
import { Icon } from '../lib/icons.js'
import { detectJavaClasses } from '../lib/javaDetect.js'
import { formatEta, formatDuration } from '../lib/format.js'
import { isTypingTarget } from '../lib/shortcuts.js'
import { codeState, patchCodeState, clearCodeState } from '../lib/codeState.js'
import { parseGraphQuery, queryFiles, QUERY_FACETS, GRAPH_QUERY_HELP } from '../lib/graphQuery.js'
import { buildGraph, MAX_PATHS, MAX_IMPACT } from '../lib/graphPaths.js'

// Die gerechneten Kennzahlen (Zyklen, Brandherde) – geteilt mit dem Insights-Bereich, damit Bild
// und Bericht nie zwei Staende zeigen. Geholt wird erst, wenn jemand danach fragt.
const { data: insightsData, ensure: ensureInsights, refreshIfLoaded: refreshInsights, clear: clearInsights } = useInsights()

const { files, loading: filesLoading, fetchFiles, analyzeBatch, analyzing, error, userContext, lastFileId, lastPackage, lastTargetLine, lastTargetEndLine, lastSearchQuery, lastSearchOpts, openAddCode, deleteFile, resetAll } =
  useJavaAnalyzer()
// Startzeitpunkt fuer die Wartemeldung der Klassenliste (die Uhr laeuft in BusyState).
const filesStartedAt = ref(Date.now())
const { summary: queueSummary, enqueueMany, enqueueAllUnanalyzed, cancelJob, cancelAllJobs, progressFor, ensurePolling } =
  useJavaQueue()
// `edges` sind die gespeicherten Klassenbeziehungen: die Suche beantwortet `m:`/`review:`/`manual:`
// daraus (s. queryFiles) – aus dem BESTAND, nicht aus dem gerade gezeichneten Ausschnitt.
const { edges: serverEdges, recomputeEdges, recomputing, recomputeProgress, resetEdges } = useJavaGraph()
const { push, clearAll: clearNotifications } = useNotifications()
// Verschiebbare Spaltenbreiten des 3-Spalten-Layouts (Drag-to-Resize + Reset).
const {
  gridTemplate,
  isWide,
  isDragging,
  activeKey,
  isDirty: panelsDirty,
  isFocused: panelsFocused,
  wide: panelsWide,
  centerHidden,
  startDrag,
  focusRight,
  releaseFocus,
  toggleWide,
  reset: resetPanels,
} = usePanelResize()

const source = ref('')
const filename = ref('')
const inputMode = ref('paste') // 'paste' = Editor | 'file' = .java-Datei(en) hochladen
// Ziele der Tastenkuerzel: Suchfeld (/, Ctrl+Shift+F), Graph (0, Alt+←) sowie Klassen- bzw.
// Kanten-Panel (Ctrl+F). Sie liegen hier, weil CodeView die Kuerzel routet – s. onKeydown.
const filterInput = ref(null)
function focusFilter() {
  filterInput.value?.focus()
  filterInput.value?.select()
}
const graphRef = ref(null)
const detailRef = ref(null)
// --- Der Arbeitsstand ueberlebt den Reload ----------------------------------------------------
// Wer sich in einen Ausschnitt hineingearbeitet hat (Filter gesetzt, Package geoeffnet, Klasse
// aufgeschlagen), verliert das bisher bei jedem F5 und bei jedem Ausflug ins Wiki – und muss den
// Weg dorthin noch einmal gehen, obwohl er ihn schon kennt. Gemerkt wird deshalb der ORT, nicht
// die Handlung: Filter, offene Klasse und Baumfaltung hier, Ebene/Kontextstufe/Bildsuche im
// Graphen (beides ueber `lib/codeState.js`, dort steht warum ein gemeinsamer Schluessel).
// Die refs starten direkt mit dem gemerkten Wert – nicht in `onMounted`: der Graph liest seinen
// Teil beim eigenen Setup, und ein Filter, der erst nach dem ersten Bild nachrutscht, waere ein
// zweites Layout fuer denselben Zustand.
const savedState = codeState()
// ⚠️ Die gemerkte KLASSE ist der eine Wert, der nicht sofort gesetzt werden darf: das Detail-Panel
// laedt sie, sobald es sie sieht – also bevor die Dateiliste ueberhaupt da ist. Ist sie inzwischen
// geloescht, ist das ein 404, und ein fehlgeschlagener Request meldet sich in diesem Programm
// selbst (globaler Toast). Der Nutzer bekaeme beim blossen Oeffnen der Ansicht einen Fehler
// serviert, den er nicht verursacht hat. Gesetzt wird sie deshalb erst nach `fetchFiles`, wenn es
// sie noch gibt (s. onMounted).
const selectedFileId = ref(null)
const activeTargetLine = ref(null) // Ziel-Quellzeile fuer das Detail-Panel (Such-Sprung)
const activeTargetEndLine = ref(null) // Ziel-End-Zeile -> markiert den gesamten Methodenbereich
// Suchbegriff + Schalter aus der globalen Suche: gehen unveraendert an die Suchleiste des
// Klassen-Panels weiter, damit man dort weitersucht, statt neu anzufangen.
const handoffSearch = ref(null)

// --- Spalte 3: Klasse ODER Beziehung -----------------------------------------------------------
// Ein Klick auf eine Kante im Graphen landet hier, nicht mehr in einem Modal darueber. Beides ist
// dieselbe Taetigkeit – Code lesen –, also derselbe Ort; was gerade zu sehen ist, entscheidet ein
// Umschalter. Er ersetzt zugleich den frueheren „Back to relation"-Knopf: der war noetig, weil das
// Modal beim Sprung in den Code zuklappte und die Beziehung mitnahm. Jetzt bleibt sie einfach
// stehen, und ein Klick fuehrt zurueck.
const relation = ref(null) // vom Graphen gemeldet: { kind: 'edge' | 'bundle', … } | null
const detailTab = ref('class') // 'class' | 'relation'
const showRelation = computed(() => !!relation.value && detailTab.value === 'relation')
// Nur die Einzelbeziehung traegt eine eigene Suchleiste (die Aggregatliste zeigt keinen Code, in
// dem man suchen koennte) – Ctrl+F darf also nur dort dorthin gehen.
const edgeDetailRef = ref(null)
const relationSearchable = computed(() => showRelation.value && relation.value?.kind === 'edge')
// Der Klassen-Reiter traegt den Namen der geoeffneten Klasse: „Class" allein liesse offen, wohin
// er zurueckfuehrt – und genau das ist die Frage, wenn man aus einer Beziehung heraus schaut.
const selectedFile = computed(() => files.value.find((f) => f.id === selectedFileId.value) || null)

// Der Graph rechnet, diese Ansicht zeigt. Das Detail oeffnet SOFORT (mit dem, was ohne Request
// bekannt ist) und meldet sich waehrend des Ladens erneut – deshalb kommen hier mehrere Meldungen
// zu einem Klick, und nur die erste darf Platz nehmen.
// Eine VORSCHAU (`preview`) ist dasselbe Panel, nur weil die Maus gerade darauf zeigt. Sie darf
// deshalb zwei Dinge nicht: sich Spaltenbreite leihen (das Layout waehrend eines Hovers umzustellen
// waere eine Bewegung, die niemand ausgeloest hat) und den Umschalter dauerhaft umlegen. Der Reiter
// wird nur voruebergehend nach vorn geholt und danach genau dorthin zurueckgestellt, wo er stand.
let tabBeforePreview = null
let lastPick = 0
function onRelation(payload) {
  const wasOpen = !!relation.value
  relation.value = payload
  if (!payload) {
    detailTab.value = 'class'
    tabBeforePreview = null
    releaseFocus()
    return
  }
  // Gewaehlt oder bloss angeschaut? Steigt der Zaehler, war es ein Klick – dann bleibt die
  // Beziehung vorn, auch wenn zuvor der Klassen-Reiter offen war.
  const picked = payload.pick !== lastPick
  lastPick = payload.pick ?? lastPick
  if (payload.preview) {
    if (tabBeforePreview === null) tabBeforePreview = detailTab.value
    detailTab.value = 'relation'
    return
  }
  // Vorschau vorbei, ohne dass jemand geklickt hat -> zurueck auf den gemerkten Reiter.
  if (!picked && tabBeforePreview !== null) {
    detailTab.value = tabBeforePreview
    tabBeforePreview = null
    return
  }
  tabBeforePreview = null
  detailTab.value = 'relation'
  if (wasOpen && !picked) return
  // Zwei Codebloecke uebereinander (Definition + Aufrufstelle) brauchen Breite – dieselbe geliehene
  // Aufteilung wie beim Sprung aus der globalen Suche, samt Rueckgabe beim Schliessen. Ein Klick auf
  // eine Nachbarkarte laeuft ueber `selectFile`, und das gibt die Breite zuerst zurueck – deshalb
  // wird sie hier auch dann wieder geliehen, wenn schon eine Beziehung offen war.
  // Die Kamera zieht nur beim ERSTEN Mal nach: sonst faehrt sie bei jedem Schritt entlang der
  // Kanten neu, obwohl sich an der Flaeche nichts mehr aendert.
  const grew = focusRight()
  if (grew && !wasOpen) refitGraphSoon(300)
}

// ×/ESC/Klick ins Leere: fertig mit der Beziehung. Der Zustand liegt im Graphen (dort entsteht er),
// also wird er auch dort geloescht – die Meldung kommt als `relation: null` zurueck.
function closeRelation() {
  graphRef.value?.closeRelation?.()
}
function onRelationClose(reason) {
  // Sprung in den Quellcode: die Beziehung bleibt offen, nur nach hinten. Wer den Code gelesen hat,
  // will oft zurueck – und findet sie im Umschalter, statt sie im Graphen neu suchen zu muessen.
  if (reason === 'navigate') {
    detailTab.value = 'class'
    return
  }
  // Kante aus einer Aggregatliste: × fuehrt zurueck in die Liste, nicht ins Nichts.
  if (relation.value?.kind === 'edge' && relation.value.back) {
    graphRef.value?.closeEdgeDetail?.()
    return
  }
  closeRelation()
}
const search = ref(savedState.search || '') // was im Feld steht – reagiert sofort auf jeden Tastendruck
// …und was daraus tatsaechlich gefiltert wird. Getrennt, weil an EINEM Tastendruck der halbe
// Bildschirm haengt: Trefferliste, Package-Baum, alle Baumzeilen und der Graph (der bei wenigen
// Treffern sein dagre-Layout neu rechnet). Bei einigen tausend Klassen kostet das mehr Zeit, als
// zwischen zwei Anschlaegen liegt – die Eingabe fuehlt sich dann zaeh an, obwohl nur die Folge
// davon teuer ist. Der Ruecklauf auf „leer" laeuft ohne Verzoegerung: Filter loeschen soll sich
// nicht anfuehlen wie ein Nachladen.
const appliedSearch = ref(savedState.search || '')
const SEARCH_DEBOUNCE_MS = 160
let searchTimer = null
watch(search, (v, prev) => {
  clearTimeout(searchTimer)
  if (!v.trim()) {
    appliedSearch.value = ''
    // Den Filter zu loeschen heisst „zeig mir wieder alles" – und genau das tat der Graph nicht:
    // er blieb in der Ebene stehen, in der die Suche ihn zuletzt abgesetzt hatte. Gemessen ein
    // Package mit 4 Klassen, waehrend die Codebasis 937 hat, also ausgerechnet der Ausschnitt,
    // den man mit dem Loeschen loswerden wollte. Nur beim Uebergang „war etwas, ist jetzt leer":
    // ein leeres Feld, das leer bleibt, ist keine Handlung.
    if (prev && prev.trim()) showGraphOverview()
    return
  }
  searchTimer = setTimeout(() => {
    appliedSearch.value = v
  }, SEARCH_DEBOUNCE_MS)
})
const showNew = ref(false)
const collapsed = reactive({ ...(savedState.tree || {}) }) // packagePfad -> true (eingeklappt)
const pendingDelete = ref(null)
const deleting = ref(false)
const pendingConflicts = ref(null) // FQCN-Liste vorhandener Klassen -> Ueberschreiben-Dialog
const confirming = ref(false)
const analyzingAll = ref(false) // Spinner fuer "Run AI"
const pendingReset = ref(false) // Komplett-Reset-Dialog offen?
const resetting = ref(false) // Spinner waehrend des Komplett-Resets
const queueOpen = ref(false) // KI-Queue-Modal offen?
const exportOpen = ref(false) // Export-Modal (alle Klassen als ein Text) offen?

// Gemerkt wird der ANGEWENDETE Filter, nicht der Feldinhalt: nur er hat den Ausschnitt bestimmt,
// den man wiederhaben will (dieselbe Trennung wie bei `hl()` und dem Graphen).
watch([appliedSearch, selectedFileId], () =>
  patchCodeState({ search: appliedSearch.value, fileId: selectedFileId.value }),
)
// `collapsed` ist reactive -> der Watcher ist automatisch tief. Gespeichert wird eine flache
// Kopie: das reactive Objekt selbst laesst sich nicht serialisieren, ohne den Proxy mitzunehmen.
watch(collapsed, () => patchCodeState({ tree: { ...collapsed } }))

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
  // „Add code" von der Landing-Seite: dort gibt es keine Drop-Zone mehr, der Verweis fuehrt
  // hierher – und zwar bis ins Modal, nicht nur bis zum Knopf, der es oeffnet.
  if (openAddCode.value) {
    openAddCode.value = false
    showNew.value = true
  }
  // Sprung aus dem Insights-Bereich auf ein PACKAGE: er meint die Ebene, nicht eine Klasse darin.
  // Deshalb kein stellvertretend gewaehltes Mitglied – der Graph stellt sich auf das Package, der
  // Baum deckt seinen Pfad auf, und rechts bleibt offen, was offen war.
  if (lastPackage.value != null) {
    const path = lastPackage.value
    lastPackage.value = null
    handoffNavigating = true
    focusGraphOnPackage(path)
    openPathInTree(path)
    nextTick(() => scrollTreeTo(`[data-path="${path}"]`))
  }
  if (lastFileId.value == null) return
  selectedFileId.value = lastFileId.value
  // Der Sprung gilt einer KLASSE – auch wenn er aus einem Kanten-Detail kam. Die Beziehung bleibt
  // im Umschalter erreichbar, sie tritt nur zurueck.
  detailTab.value = 'class'
  activeTargetLine.value = lastTargetLine.value
  activeTargetEndLine.value = lastTargetEndLine.value
  // Die Suche gehoert zum Sprung: ein neues Objekt je Hand-off, damit das Panel auch dann reagiert,
  // wenn zweimal hintereinander nach demselben Wort gesprungen wird.
  handoffSearch.value = lastSearchQuery.value
    ? { query: lastSearchQuery.value, opts: { ...(lastSearchOpts.value || {}) } }
    : null
  // Ein Treffer ist ein ORT, nicht nur eine Datei: der Graph faehrt die Klasse an und der Baum
  // deckt ihren Pfad auf. Vorher stand rechts das Panel, waehrend Graph und Baum weiter irgendwo
  // anders standen – man wusste, WAS man gefunden hatte, aber nicht, wo es liegt. Gilt fuer beide
  // Eingaenge gleich (Strg+K und das Suchfeld der Landing Page laufen ueber denselben Hand-off).
  const target = files.value.find((f) => f.id === selectedFileId.value)
  if (target) {
    // Der Graph meldet den Ebenenwechsel als `navigate` zurueck – und DAS wuerde die eben
    // geliehene Panelbreite sofort wieder abgeben (dort steht „wer im Graphen navigiert, ist beim
    // Bild"). Diese eine Meldung gehoert aber zum Sprung selbst, nicht zu einer Handlung des
    // Nutzers: dieselbe Unterscheidung wie `treeDrivenPath` weiter unten.
    handoffNavigating = true
    // Kam der Sprung aus einer Trefferliste (nur die Palette schickt eine Suche mit), gilt er der
    // KLASSE, nicht nur ihrem Quelltext: der Filter links stellt sich auf ihren Namen, und der
    // Graph zeigt sie mit ihrer ganzen Umgebung. Queue, Edge-Panel und Landing-„Add code" kommen
    // dagegen aus dem Bild selbst – dort waere ein gesetzter Filter eine Einschraenkung, um die
    // niemand gebeten hat (dieselbe Grenze wie bei der geliehenen Panelbreite weiter unten).
    //
    // Die Ebene DARUNTER ist in beiden Faellen das Package der Klasse: wer den Filter spaeter
    // leert, landet dort, wo die Klasse liegt – und nicht wieder in dem Ausschnitt, den er vor der
    // Suche ansah. Nur den Knoten anfahren muss der Ego-Fall nicht: das Ego-Layout stellt die
    // Klasse selbst in die Mitte, und der Fokus-Zweig des Graphen passt auf EINEN Knoten ein
    // (`padding 1.6`) – gemessen ein Ausschnitt, der die halbe Umgebung aus dem Bild schob.
    if (handoffSearch.value) {
      focusGraphOnPackage(target.package || '')
      focusSearchOnFile(target)
    } else {
      focusGraphOnFile(target)
    }
    openPathInTree(target.package || '(default)')
    nextTick(() => scrollTreeTo(`[data-fid="${target.id}"]`))
  }
  // Kam der Sprung aus der globalen Suche (nur die schickt eine Suche mit), will man den CODE
  // lesen – dafuer macht das Panel vorübergehend auf. Zurueckgegeben wird beim Schliessen oder
  // beim naechsten Klick in Graph/Baum (s. selectFile/onDetailClose).
  if (handoffSearch.value) {
    focusRight()
    // …und der Graph muss den Ausschnitt nachziehen: die geliehene Breite nimmt ihm ein knappes
    // Viertel seiner Flaeche, und zwar ANIMIERT – sein eigenes Einpassen laeuft da laengst.
    // Gemessen blieb der Ausschnitt sonst zur alten Breite passend: Karten 67 statt 125 px und die
    // halbe Umgebung links ausserhalb des Canvas.
    refitGraphSoon(300)
  }
  lastFileId.value = null
  lastTargetLine.value = null
  lastTargetEndLine.value = null
  lastSearchQuery.value = null
  lastSearchOpts.value = null
}

// Reagiert auch, wenn /code bereits gemountet ist (z. B. Klick auf einen Edge-Panel-Link).
watch(lastFileId, (v) => {
  if (v != null) consumeHandoff()
})
watch(lastPackage, (v) => {
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
    if (showNew.value && !pendingConflicts.value) {
      showNew.value = false
      return
    }
    // Das Kanten-Detail ist kein Modal mehr – ESC gehoert deshalb hierher und nicht in das Panel:
    // wer im Klassenfilter oder im Editor tippt, meint mit ESC etwas anderes (dieselbe Regel wie
    // bei allen uebrigen Kuerzeln dieser Ansicht).
    if (relation.value && !isTypingTarget(document.activeElement)) closeRelation()
    return
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && showNew.value && !analyzing.value && !pendingConflicts.value) {
    e.preventDefault()
    analyze()
    return
  }

  const mod = e.ctrlKey || e.metaKey
  const key = (e.key || '').toLowerCase()
  const typing = isTypingTarget(document.activeElement)

  // --- Suchen: EINE Regel, an EINER Stelle ----------------------------------------------------
  // Ctrl+F trifft, was im Blick ist: steht eine Beziehung vorn, deren Code; sonst die offene
  // Klasse; sonst die Suche links (Klassen, Packages, Beziehungen). Die Beziehung geht vor, weil
  // sie den Klassen-Reiter gerade verdeckt – eine Suche in etwas, das man nicht sieht, waere die
  // falsche Antwort auf denselben Tastendruck. Ctrl+Shift+F meint immer die Suche links.
  // `preventDefault` schaltet dabei Chromes eigene Suche ab – die faende im virtualisierten Editor
  // ohnehin nur den sichtbaren Ausschnitt und im Graphen (SVG/Canvas-Karten) praktisch nichts.
  if (mod && key === 'f' && !e.altKey) {
    e.preventDefault()
    if (e.shiftKey) focusFilter()
    else if (relationSearchable.value) edgeDetailRef.value?.focusSearch?.()
    else if (detailRef.value?.isReady?.()) detailRef.value.focusSearch()
    else focusFilter()
    return
  }

  if (typing || mod || e.altKey) {
    // Alt+Pfeil-links geht eine Package-Ebene hoch – auch das nur, wenn niemand tippt.
    if (!typing && e.altKey && !mod && e.key === 'ArrowLeft') {
      e.preventDefault()
      graphRef.value?.drillUp?.()
    }
    // Alt+W macht die Detailspalte breit (und wieder schmal). Bewusst mit Alt: Ctrl+Shift+W
    // schliesst im Browser das Fenster, und ein blosses `w` verschluckte die Folge „g, w".
    // `e.code` statt `e.key`, weil Alt auf dem Mac Sonderzeichen erzeugt.
    if (!typing && e.altKey && !mod && e.code === 'KeyW') {
      e.preventDefault()
      onToggleWide()
    }
    return
  }

  // `/` springt in die Suche (wie in GitHub/GitLab). Ohne Modifier – deshalb erst hier, hinter der
  // Tipp-Pruefung.
  if (e.key === '/') {
    e.preventDefault()
    focusFilter()
    return
  }
  // `0` passt den Graphen ins Bild.
  if (e.key === '0') {
    e.preventDefault()
    graphRef.value?.fitToView?.()
  }
}

let releasePolling = null
onMounted(async () => {
  releasePolling = ensurePolling()
  window.addEventListener('keydown', onKeydown)
  await fetchFiles()
  // Der gemerkte Stand ist eine Erinnerung, keine Garantie: die Klasse kann seit dem letzten Besuch
  // geloescht worden sein, und ein Filter ohne jede Klasse dahinter zeigte links „no matches" statt
  // der Einladung, welche hinzuzufuegen. Erst PRUEFEN, dann der Hand-off – der sticht beides, weil
  // er eine Absicht von JETZT ist (Sprung aus der globalen Suche, Landing-„Add code").
  if (savedState.fileId != null && files.value.some((f) => f.id === savedState.fileId)) {
    selectedFileId.value = savedState.fileId
  } else if (savedState.fileId != null) {
    patchCodeState({ fileId: null })
  }
  if (!files.value.length && search.value) {
    clearTimeout(searchTimer)
    search.value = ''
    appliedSearch.value = ''
  }
  consumeHandoff()
  // Beim ersten Laden noch nichts vorhanden -> Neu-Panel aufklappen.
  if (!files.value.length) showNew.value = true
})
onUnmounted(() => {
  releasePolling?.()
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(detectTimer)
  // Die Uhr des laufenden Imports wird hier BEWUSST nicht mehr gestoppt: sie gehoert `useActivity`
  // und traegt die Sidebar-Karte weiter, waehrend diese Ansicht schon weg ist. Genau daran haengt
  // der ganze Umbau – sie hier abzuraeumen hiesse, den Fortschritt wieder an die Ansicht zu binden.
  // Beide Sucheingaben-Timer: ein spaeter feuernder Timer schriebe in Refs einer Ansicht, die es
  // nicht mehr gibt.
  clearTimeout(searchTimer)
  clearTimeout(graphSearchTimer)
})

// --- Metriken (Command-Bar) ---
const classCount = computed(() => files.value.length)
const packageCount = computed(() => new Set(files.value.map((f) => f.package || '(default)')).size)
const analyzedCount = computed(() => files.value.filter((f) => f.description).length)

// --- Die EINE Suche der Ansicht ---------------------------------------------------------------
// Ein Feld, eine Trefferliste, drei Darstellungen: der Baum zeigt sie, der Graph zeichnet sie samt
// Umgebung, und dort sind sie markiert. Frueher war das zweierlei (Filter hier, zweites Feld im
// Bild) – zwei Antworten auf dieselbe Frage, die bei einem Fuzzy-Treffer sichtbar auseinanderliefen.
//
// Gelesen wird die Abfrage in lib/graphQuery.js: `parseGraphQuery` versteht die Facetten,
// `queryFiles` beantwortet sie ueber den Bestand. Zwei Faelle bleiben hier:
//   * `scope: 'names'` – freier Text. Die Klassen sucht `filterClasses` (Rang + Fuzzy), weil ein
//     Tippfehler sonst kein Ergebnis haette.
//   * `scope: 'picture'` – `r:`. Nur der Graph kennt Rollen; er meldet seine Treffer (`find-result`),
//     der Baum filtert darauf, und das Bild bleibt stehen (s. `graphMatchIds`).
//   * `cycle:`/`hotspot:` – die Antwort steht in den gerechneten Kennzahlen. Sie werden NICHT
//     beim Betreten der Ansicht geholt (wer nie danach fragt, soll dafuer nicht zahlen), sondern
//     genau dann, wenn eine dieser Facetten getippt wird – `needsInsights` ist das Signal.
//   * `path:`/`impact:` – die Antwort ist eine STRECKE im Graphen. Der gerichtete Klassengraph
//     wird deshalb EINMAL je Kantenbestand gebaut und nicht je Tastendruck: das Aufloesen aller
//     Kanten auf Datei-Ids ist der teure Teil, die Suche darin ist es nicht.
const classGraph = computed(() => buildGraph(files.value, serverEdges.value))
const parsedQuery = computed(() => parseGraphQuery(appliedSearch.value))
const queryResult = computed(() =>
  queryFiles(
    {
      files: files.value,
      serverEdges: serverEdges.value,
      insights: insightsData.value,
      graph: classGraph.value,
    },
    parsedQuery.value,
  ),
)
// Was die Abfrage ueber die Trefferzahl hinaus zu sagen hat („3 routes, shortest 4 steps").
const queryDetail = computed(() => queryResult.value.detail || null)
watch(
  () => queryResult.value.needsInsights,
  (needs) => {
    if (needs) ensureInsights()
  },
)
// Treffer, die nur der gezeichnete Graph bestimmen kann (`r:`).
const pictureIds = ref([])
function onFindResult(ids) {
  pictureIds.value = ids || []
}
const filteredFiles = computed(() => {
  const q = parsedQuery.value
  if (!q) return files.value
  const { fileIds, scope } = queryResult.value
  if (scope === 'picture') {
    const ids = new Set(pictureIds.value)
    return files.value.filter((f) => ids.has(f.id))
  }
  if (fileIds) return files.value.filter((f) => fileIds.has(f.id))
  return filterClasses(files.value, q.term)
})
// „Es wird gesucht" heisst: die Eingabe IST eine Abfrage. Ein angefangenes `m:` ohne Begriff ist
// keine – sonst stuende „0 of 25 match", waehrend der Nutzer noch tippt.
const searching = computed(() => !!parsedQuery.value)
// Kanten sind bei `m:`/`review:`/`manual:` das eigentliche Ergebnis – die Klassenzahl allein
// verschwiege, wie viele Beziehungen dahinterstehen.
const queryEdges = computed(() => queryResult.value.edges)

// --- Bedienung des Feldes ---------------------------------------------------------------------
// Die Facetten stehen nicht in einem Tooltip, den niemand oeffnet: sie erscheinen im leeren,
// fokussierten Feld und tragen sich per Klick selbst ein (dieselbe Bauart wie in SearchPalette).
const searchFocused = ref(false)
// Eine Abfrage, die aus dem Klassen-Panel kommt (die Fan-in-Zahl). Sie landet im EINEN Suchfeld –
// dann filtert der Baum, der Graph stellt sich darauf ein, und die Bilanz steht an derselben
// Stelle wie bei jeder anderen Suche. Das Feld bekommt den Fokus mit: die Abfrage ist eine
// Ausgangslage („wer benutzt das?"), von der aus man weitertippt.
function applyQueryFromPanel(query) {
  search.value = query
  nextTick(() => filterInput.value?.focus())
}
function applyFacet(prefix) {
  search.value = prefix
  filterInput.value?.focus()
}
// Von Treffer zu Treffer faehrt der GRAPH – er hat die Kamera. Hier liegt die Taste und die
// Folge daraus: der angefahrene Treffer wird auch rechts aufgeschlagen. „Hinfahren, aber die
// Klasse nicht zeigen" waere derselbe halbe Schritt wie vorher beim Tippen.
function stepMatch(delta) {
  const fileId = graphRef.value?.stepFind?.(delta)
  if (fileId == null || fileId === selectedFileId.value) return
  activeTargetLine.value = null
  activeTargetEndLine.value = null
  selectedFileId.value = fileId
}
const hasMatches = computed(() => searching.value && (filteredFiles.value.length > 0 || queryEdges.value > 0))
// Esc im Feld leert die Suche. `stop`, weil ESC sonst zugleich die offene Beziehung schliesst –
// zwei Wirkungen auf einen Tastendruck, von denen man nur eine gemeint hat.
function onSearchEsc(e) {
  if (!search.value) return
  e.stopPropagation()
  search.value = ''
}
// Bei aktiver Suche steht JEDER Treffer-Ordner offen (s. folderOpen) – „a" in einer Codebasis mit
// tausenden Klassen hiesse also tausende Zeilen, jede mit eigenen Icon-Komponenten. Das rendert
// niemand mehr, und lesen kann man es auch nicht. Der Baum zeigt deshalb die ersten Treffer und
// schreibt an, dass es mehr sind – wer eine bestimmte Klasse sucht, tippt ohnehin weiter.
const TREE_MATCH_LIMIT = 300
const treeFiles = computed(() => {
  const list = filteredFiles.value
  return searching.value && list.length > TREE_MATCH_LIMIT ? list.slice(0, TREE_MATCH_LIMIT) : list
})
const treeTruncated = computed(() => filteredFiles.value.length - treeFiles.value.length)
const tree = computed(() => buildPackageTree(treeFiles.value))
// Treffer-IDs der Suche -> der Graph zeigt bei aktiver Suche genau diese Klassen (plus ihre
// direkten Nachbarn als Kontext) statt weiter die volle Ebene. Bewusst aus der VOLLEN Trefferliste:
// der Graph hat seinen eigenen Deckel und nennt die echte Trefferzahl, wenn sie zu gross ist.
//
// ZWEITE Stufe der Verzoegerung: die Liste ist billig, der Graph nicht – er legt fuer jedes neue
// Ergebnis ein dagre-Layout neu auf. Waehrend man noch tippt, ist jedes Zwischenergebnis ohnehin
// nicht das gesuchte; der Graph wartet deshalb, bis die Eingabe wirklich steht. Das Loslassen
// (Filter leer) wirkt sofort – dort gibt es nichts zu berechnen, nur etwas wegzunehmen.
const GRAPH_SEARCH_DELAY_MS = 240
const graphMatchIds = ref([])
const graphQuery = ref('')
let graphSearchTimer = null
// Sprung aus der globalen Suche: dort ist GENAU EINE Klasse gemeint, der Filter links trifft aber
// oft mehrere Namen („Doa" -> DoaAddForm, DoaUtil, DoaHelper). Der Graph zeigt deshalb das Ego der
// gesprungenen Klasse, solange der Filter noch der ist, den der Sprung gesetzt hat; jeder weitere
// Tastendruck loest die Ausnahme auf. Gemerkt wird die ANFRAGE mit, nicht nur ein Schalter: der
// Watcher laeuft nicht, wenn der Filter schon denselben Wert trug (zweimal derselbe Sprung), und
// ein einmaliges Ueberspringen bliebe dann haengen und verschluckte den naechsten echten Lauf.
let egoOverride = null // { query, id }
// Filter links UND Graph in einem Zug auf die gesprungene Klasse stellen. Beide Debounces bleiben
// aussen vor: sie sind gegen das Tippen gebaut (an einem Anschlag haengt der halbe Bildschirm), hier
// gibt es aber genau eine Aenderung – und ein Sprung, der erst 400 ms spaeter im Bild ankommt, sieht
// aus wie ein verschluckter Klick.
function focusSearchOnFile(file) {
  const name = String(file.class_name || '')
  if (!name) return
  clearTimeout(searchTimer)
  search.value = name
  appliedSearch.value = name
  clearTimeout(graphSearchTimer)
  egoOverride = { query: name, id: file.id }
  graphMatchIds.value = [file.id]
  graphQuery.value = name
}

// Dasselbe Ego, aber OHNE das Suchfeld anzufassen: der Klick im Baum (und der auf eine Karte, s.
// selectFileFromGraph) meint genau diese eine Klasse – die Trefferliste links, aus der man sie
// gerade ausgewaehlt hat, ist damit aber nicht erledigt. Wer „Order" getippt hat, will nach
// OrderService die naechste Zeile derselben Liste anklicken koennen; ein Feld, das sich beim
// Klicken selbst umschreibt, nimmt ihm genau das.
// Gemerkt wird als `query` der ANGEWENDETE Filter (nicht der Klassenname): daran erkennt der
// Watcher unten, dass sich seither nichts getippt hat – tippt man weiter, gilt wieder die Liste.
function focusClassInGraph(file) {
  if (!file) return
  clearTimeout(graphSearchTimer)
  egoOverride = { query: appliedSearch.value, id: file.id }
  graphMatchIds.value = [file.id]
  // Der Graph braucht eine nicht-leere Anfrage, um in den Trefferbetrieb zu gehen (searchActive).
  // Der Klassenname ist dabei die ehrliche Ortsangabe fuer die Leiste links im Bild: dort steht
  // dann genau das, was gezeigt wird – nicht der Filter, der auch fuenf andere Klassen trifft.
  graphQuery.value = String(file.class_name || '')
  centerGraphOnFile(file.id)
}

// Das „×" in der Leiste des Graphen: es raeumt den AUSSCHNITT, und der kann zwei Ursachen haben –
// den Filter links oder eine einzelne Klasse (Ego). Nur `search = ''` liesse ein Ego ohne Filter
// stehen: das Kreuz haette dann sichtbar keine Wirkung.
function clearGraphScope() {
  search.value = ''
  appliedSearch.value = ''
  releaseEgoOverride()
}

// Zurueck zur Regel „Graph zeigt die Trefferliste" – ohne Verzoegerung, es wird nur weggenommen.
function releaseEgoOverride() {
  if (!egoOverride) return
  egoOverride = null
  clearTimeout(graphSearchTimer)
  graphMatchIds.value = searching.value ? filteredFiles.value.map((f) => f.id) : []
  graphQuery.value = searching.value ? appliedSearch.value : ''
}
watch([searching, filteredFiles], ([on, list]) => {
  clearTimeout(graphSearchTimer)
  if (!on) {
    egoOverride = null
    pictureIds.value = []
    graphMatchIds.value = []
    graphQuery.value = ''
    return
  }
  // `r:` fragt das BILD: der Graph markiert und meldet, was er gefunden hat – gezeichnet wird
  // nichts Neues. Traege er die Treffer auch als Ausschnitt, liefe es im Kreis (anderer Ausschnitt
  // -> andere Rollen -> andere Treffer). Ohne Verzoegerung, weil kein Layout entsteht.
  if (queryResult.value.scope === 'picture') {
    egoOverride = null
    graphMatchIds.value = []
    graphQuery.value = appliedSearch.value
    return
  }
  // Der Sprung hat den Graphen bereits auf diese eine Klasse gestellt – der Filter, den er dabei
  // gesetzt hat, laeuft hier als eigene Aenderung ein und wuerde sie sofort wieder durch die volle
  // Trefferliste ersetzen.
  if (egoOverride && egoOverride.query === appliedSearch.value) {
    graphMatchIds.value = [egoOverride.id]
    graphQuery.value = appliedSearch.value
    return
  }
  egoOverride = null
  graphSearchTimer = setTimeout(() => {
    graphMatchIds.value = list.map((f) => f.id)
    graphQuery.value = appliedSearch.value
    // Der beste Treffer wird GEZEIGT, nicht nur markiert: rechts aufgeschlagen und im Bild
    // angefahren. Vorher passierte das nur bei genau einem Treffer – bei drei Treffern stand die
    // Antwort im Bild, die rechte Spalte blieb leer, und man musste die Klasse, die man gerade
    // gefunden hatte, noch einmal anklicken. `list[0]` ist bei freiem Text der bestgerankte Treffer
    // (`filterClasses`: Praefix > enthaelt > Package), bei den Facetten der erste der Liste.
    // Weiterblaettern mit ↵ / ↑ ↓ schlaegt die naechste Klasse genauso auf (s. stepMatch).
    // Kamera und Auswahl nur bei einem WECHSEL – wer weitertippt und dieselbe Klasse behaelt, soll
    // nicht bei jedem Anschlag noch einmal angefahren werden.
    const best = list[0]
    if (best && selectedFileId.value !== best.id) {
      activeTargetLine.value = null
      activeTargetEndLine.value = null
      selectedFileId.value = best.id
      centerGraphOnFile(best.id)
    }
  }, GRAPH_SEARCH_DELAY_MS)
})

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

// `here` = der Ordner, dessen Ebene der Graph gerade zeigt (s. activeFolderPath). Die Einordnung
// entsteht HIER und nicht im Template: sie haengt an drei Werten, die sich alle drei selten
// aendern (Baum, Faltung, Graph-Ebene), waehrend das Template bei jedem Tastendruck neu laeuft.
//   trail  – der Weg dorthin (Vorfahren)
//   here   – genau diese Ebene liegt im Graphen
//   inside – Inhalt dieser Ebene (Unterordner + Klassen), also das, was im Graphen zu sehen ist
function flatten(nodes, depth, out, here, inZone) {
  for (const n of nodes) {
    const open = folderOpen(n, depth)
    const isHere = here != null && n.fullPath === here
    const state = isHere ? 'here' : here != null && here.startsWith(n.fullPath + '.') ? 'trail' : inZone ? 'inside' : null
    out.push({ kind: 'folder', id: n.id, label: n.label, fullPath: n.fullPath, depth, count: countClasses(n), open, state })
    if (open) {
      flatten(n.children, depth + 1, out, here, inZone || isHere)
      const state = inZone || isHere ? 'inside' : null
      for (const f of n.classes) out.push({ kind: 'class', id: `c:${f.id}`, file: f, depth: depth + 1, state })
    }
  }
  return out
}
const rows = computed(() => flatten(tree.value, 0, [], activeFolderPath.value, false))

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

// Merkt sich den Pfad, den der BAUM gerade an den Graphen geschickt hat. Der Graph meldet jede
// Ebene zurueck (auch die, die er von hier bekommen hat) – ohne diese Notiz wuerde ein Zuklappen
// im Baum als Graph-Navigation zurueckkommen und den Ordner sofort wieder aufklappen.
let treeDrivenPath = null
// Der Graph faehrt beim Sprung aus der Suche die gefundene Klasse an und meldet das als
// `navigate`. Diese eine Meldung stammt vom Sprung, nicht vom Nutzer – s. consumeHandoff.
let handoffNavigating = false

function focusGraphOnPackage(path) {
  // Ein Package ist eine EBENE, eine Klasse ein Ausschnitt daraus: wer die Ebene waehlt, hat die
  // eine Klasse losgelassen. Ohne diese Zeile bliebe das Ego stehen und der gewaehlte Ordner haette
  // im Bild keine Wirkung.
  releaseEgoOverride()
  graphFocusFileId.value = null
  graphFocusPath.value = path
  treeDrivenPath = path
  graphFocusToken.value = ++focusSeq
}
function focusGraphOnFile(file) {
  releaseEgoOverride() // Ebene + Kamera, also kein Ego mehr (gleiche Regel wie oben)
  graphFocusPath.value = file?.package || ''
  graphFocusFileId.value = file?.id ?? null
  treeDrivenPath = graphFocusPath.value
  graphFocusToken.value = ++focusSeq
}
// Nur die KAMERA auf eine Klasse, ohne die Ebene zu verstellen (`focusPath` bleibt null, der
// Fokus-Watcher im Graphen ueberspringt den Ebenenteil dann). Gebraucht fuer die Suche: dort
// zeichnet der Graph ohnehin die Treffer – ein Ebenenwechsel obendrauf waere eine zweite Bewegung
// und liesse den Ausschnitt nach dem Leeren des Feldes woanders stehen.
function centerGraphOnFile(fileId) {
  graphFocusPath.value = null
  graphFocusFileId.value = fileId ?? null
  graphFocusToken.value = ++focusSeq
}

// Die Kamera nachziehen, wenn sich die Graphflaeche gerade noch aendert: die Panelbreite laeuft
// als Animation (220 ms, s. `.panel-grid`), das Einpassen des Graphen haengt dagegen am Layout und
// ist da laengst gelaufen – der Ausschnitt passt dann zur Flaeche von vorhin. Der Nachzieher sitzt
// hinter der Uebergangszeit UND hinter dem zweiten Einpassen des Graphen (280 ms). Bewusst ein
// ruhiger Schwenk statt eines Sprungs: hier raeumt die Ansicht auf, das darf man sehen.
const GRAPH_REFIT_DELAY_MS = 400
let refitTimer = null
function refitGraphSoon(duration = 420) {
  clearTimeout(refitTimer)
  refitTimer = setTimeout(() => graphRef.value?.fitToView?.({ duration }), GRAPH_REFIT_DELAY_MS)
}

// Breit-Modus umschalten. Beim ZURUECK kommt der Graph aus `display:none` – dort hat Vue Flow keine
// Flaeche gesehen, und der Ausschnitt von vorhin passt nicht mehr zu der, die er jetzt bekommt.
// Beim Ausblenden gibt es dagegen nichts einzupassen.
function onToggleWide() {
  const was = panelsWide.value
  toggleWide()
  if (was && !panelsWide.value) refitGraphSoon()
}

// „Zeig mir wieder alles": oberste Ebene + eingepasste Kamera. Der leere Pfad landet im Graphen
// auf `rootPath` (dessen Fokus-Watcher faengt jeden Pfad ab, der nicht zur Wurzel passt) – hier
// muss also niemand wissen, wie der gemeinsame Praefix der Codebasis gerade heisst.
function showGraphOverview() {
  focusGraphOnPackage('')
  refitGraphSoon()
}

function toggleFolder(path, open) {
  collapsed[path] = open
  // Auf-/Zuklappen ist zugleich eine Ortsangabe: der Graph zeigt dieses Package.
  focusGraphOnPackage(path)
}

// --- Jeder Ordner des Baums, in Reihenfolge ----------------------------------------------------
// Gebraucht fuer „du bist hier" (der Baum klappt den Weg zur Graph-Ebene auf) und fuer die
// Zuordnung kompaktierter Knoten. Ein Knopf „alles auf-/zuklappen" hing frueher auch daran; er ist
// entfallen, weil er neben dem Suchfeld stand und ihm Breite nahm, obwohl er waehrend einer Suche
// gar nicht bedienbar war (dort steht ohnehin jeder Treffer-Ordner offen).
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
// --- Graph -> Baum: „du bist hier" -----------------------------------------------------------
// Der Graph zeigt immer genau eine Ebene. Welche das ist, beantwortete bisher nur sein eigenes
// Breadcrumb – wer sich per Zonenkopf und Package-Knoten drei Ebenen tief geklickt hatte, fand den
// Ort links im Baum nicht wieder, obwohl der Baum die Navigation ist. Der Baum folgt deshalb jeder
// Ebene, die der Graph meldet: Weg aufklappen, Ebene markieren, Zeile in den Blick holen.
// Bewusst NUR aufdecken – nichts zuklappen: was man selbst geoeffnet hat, soll ein Klick im
// Graphen nicht wegnehmen.
const activePath = ref(null) // Package-Pfad, den der Graph gerade zeigt
const treeListEl = ref(null)

// Der Baum zieht leere Zwischen-Packages zusammen (`buildPackageTree`), der Graph kennt jede
// Ebene einzeln: `com.acme` kann dort eine Ebene sein, die es im Baum nur als Teil des Knotens
// `com.acme.util` gibt. Deshalb erst der exakte Knoten – und sonst der kompaktierte, der ihn
// enthaelt (der kuerzeste, der mit dem Pfad beginnt; Kompaktierung gibt es nur bei genau einem
// Kind, also ist er eindeutig).
const activeFolderPath = computed(() => {
  const path = activePath.value
  if (!path) return null
  const all = folderPaths.value
  if (all.includes(path)) return path
  let best = null
  for (const p of all) if (p.startsWith(path + '.') && (best === null || p.length < best.length)) best = p
  return best
})

// Sichtbar machen, ohne den Blick zu verreissen: `nearest` scrollt nur, wenn die Zeile wirklich
// ausserhalb liegt. Ein Tick Wartezeit, weil die Zeile durch das Aufklappen erst entstehen muss.
async function scrollTreeTo(selector) {
  await nextTick()
  treeListEl.value?.querySelector(selector)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

// Den Pfad selbst und jeden Vorfahren oeffnen (der Knoten mit genau diesem Pfad traegt die
// Klassen, seine Vorfahren den Weg dorthin).
function openPathInTree(path) {
  if (!path) return
  for (const p of folderPaths.value) if (p === path || path.startsWith(p + '.')) collapsed[p] = false
}

function onGraphNavigate(path) {
  activePath.value = path || null
  // Wer im Graphen eine Ebene wechselt (Package-Karte, Zonenkopf, Breadcrumb), arbeitet wieder mit
  // dem Bild – die fuer einen Suchtreffer geliehene Panelbreite gehoert dann zurueck. Kam die
  // Meldung dagegen vom Sprung selbst (der Graph faehrt die gefundene Klasse an), ist sie KEINE
  // Handlung des Nutzers und darf die Breite nicht wieder einkassieren.
  //
  // Und der Sprung meldet sich MEHRFACH: er setzt Ebene und Suchmodus zugleich, und der
  // Ebenenwechsel laeuft im Graphen verzoegert (withLayoutBusy malt erst die Wartemeldung). Ein
  // einmaliger Vermerk waere vom ersten `navigate` aufgebraucht und das zweite gaebe die Breite
  // sofort wieder ab. Im Suchmodus meldet der Graph `null` – der Vermerk gilt deshalb, solange
  // genau das kommt, und endet mit der ersten echten Ebene: DAS ist wieder eine Handlung des
  // Nutzers (Filter geleert, Ebene gewechselt).
  if (handoffNavigating && !path) return
  handoffNavigating = false
  releaseFocus()
  // Kam die Ebene aus dem Baum, ist dessen Zustand bereits die Absicht des Nutzers – dann nur die
  // Markierung nachziehen, nicht die Faltung.
  const fromTree = treeDrivenPath !== null && treeDrivenPath === path
  treeDrivenPath = null
  if (fromTree) return
  const key = activeFolderPath.value
  if (!key) return
  openPathInTree(key)
  scrollTreeTo(`[data-path="${key}"]`)
}

// Klick auf eine Karte im Graphen: die Klasse ist ausgewaehlt (Spalte 3) – dann soll sie auch
// links stehen, sonst zeigt der Baum weiter irgendeinen anderen Ort.
function selectFileFromGraph(id) {
  // Steht das Bild gerade auf EINER Klasse (Ego – aus dem Baum, aus der globalen Suche), dann
  // WANDERT es beim Klick auf eine Nachbarkarte mit, statt zu verschwinden: man laeuft die Kante
  // entlang. Ohne das fiele der Graph bei genau dieser Geste auf die Package-Ebene zurueck – ein
  // Sprung, den niemand ausgeloest hat (`selectFile` gibt das Ego frei, s. dort).
  const wasEgo = !!egoOverride
  selectFile(id)
  const file = files.value.find((f) => f.id === id)
  if (!file) return
  if (wasEgo) focusClassInGraph(file)
  openPathInTree(file.package || '(default)')
  scrollTreeTo(`[data-fid="${id}"]`)
}

// Treffer-Hervorhebung (Substring, ohne v-html). Am ANGEWENDETEN Filter, nicht am Feldinhalt:
// sonst markierte die Zeile schon das nächste Zeichen, nach dem noch gar nicht gefiltert wurde.
function hl(name) {
  const q = appliedSearch.value.trim().toLowerCase()
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

// Fortschritt des Recompute in der Kopfzeile. `null`, solange nichts gemeldet wurde (der Balken
// bleibt dann weg, statt bei 0 % zu stehen und Stillstand zu behaupten).
const recomputePercent = computed(() => {
  const p = recomputeProgress.value
  if (!p || !p.total) return null
  return Math.min(100, Math.round((p.done / p.total) * 100))
})
const recomputeTitle = computed(() => {
  const p = recomputeProgress.value
  if (!p || !p.total) return 'Recomputing class relations…'
  return `Recomputing class relations – ${p.done} of ${p.total} classes read`
})

// Alle Auto-Call-Edges serverseitig neu berechnen + persistieren. Der Graph rendert aus dem
// geteilten useJavaGraph()-edges-Ref und aktualisiert sich nach recomputeEdges() automatisch.
async function onRecomputeEdges() {
  try {
    const res = await recomputeEdges()
    // Zyklen, Kopplung und Instabilitaet stehen und fallen mit den Kanten: was hier neu entsteht,
    // macht jede vorher gerechnete Kennzahl ungueltig.
    refreshInsights()
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

// Dateien uebernehmen – aus dem Waehler im Modal wie aus einem Drop auf die Ansicht. Beide Wege
// enden gleich: Quelltext im Editor, Modal offen, der Nutzer sieht VOR dem Speichern, was ankommt.
async function acceptFiles(list) {
  const java = list.filter((f) => f.name.toLowerCase().endsWith('.java'))
  if (!java.length) {
    if (list.length) setNotice('Only .java files can be added here.', 'error')
    return
  }
  if (java.length < list.length) {
    setNotice(`${list.length - java.length} non-Java file(s) ignored.`, 'info')
  }
  filename.value = java.length === 1 ? java[0].name : `${java.length} files`
  const texts = await Promise.all(java.map((f) => f.text()))
  // Mehrere Dateien zusammenfuegen -> das Backend trennt sie wieder (package-/Typ-Grenzen).
  source.value = texts.join('\n\n')
  showNew.value = true
}

async function onFile(e) {
  await acceptFiles([...(e.target.files || [])])
}

// --- Datei ziehen und fallen lassen, irgendwo auf dieser Ansicht ----------------------------
// Die Landing-Seite hatte einmal eine Drop-Zone; seit sie nur noch Suche und Bilanz ist, gab es
// im ganzen Programm keine mehr – der Dateiwaehler im Modal nimmt keinen Drop an. Statt eine
// kleine Zone irgendwo hinzustellen, nimmt die GANZE Code-Ansicht die Datei: man zielt beim
// Ziehen nicht, man laesst los.
const dropActive = ref(false)
let dragDepth = 0 // dragenter/-leave feuern auch fuer Kindelemente – ohne Zaehler flackert das Overlay

// Nur echte Dateien, kein Text aus dem Editor: sonst legt sich das Overlay ueber jede Auswahl,
// die man im Quelltext verschiebt.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

function onDragEnter(e) {
  if (!hasFiles(e)) return
  dragDepth++
  dropActive.value = true
}
function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault() // ohne das lehnt der Browser den Drop ab und oeffnet die Datei selbst
  e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e) {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dropActive.value = false
}
async function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dropActive.value = false
  await acceptFiles([...(e.dataTransfer?.files || [])])
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
    // Neue Klassen heissen neue Groessen, neue Kanten und damit andere Kennzahlen. Nachgezogen
    // wird nur, was schon jemand offen hat (s. refreshIfLoaded).
    refreshInsights()
  }
  // ZWEI Karten, weil es zwei Aussagen sind: was ankam, und was dabei auffiel. Aneinander-
  // gereiht ergaben sie einen Fliesstext, in dem schon bei einer Handvoll Hinweise weder das
  // Ergebnis noch die Hinweise zu erfassen waren – und das Ganze in Rot, obwohl der Import
  // gelungen ist. Die Hinweise sind eine Warnung, kein Fehler: der Rest ist importiert.
  const parts = []
  if (res.overwritten?.length) parts.push(`${res.overwritten.length} overwritten.`)
  // Was ein Re-Upload behalten hat, gehoert dazu: es ist die Antwort auf „muss ich jetzt alles
  // noch mal analysieren lassen?" – und auf einem Pi ist das die Frage nach Stunden Rechenzeit.
  if (res.keptSummaries) parts.push(`${res.keptSummaries} AI description(s) kept.`)
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
// Der Apparat dahinter (Phasen, gemessene Gewichte, Uhr, Prozent, Restzeit) liegt in
// `useActivity` – er wird an ZWEI Stellen gebraucht: hier im Import-Modal und in der
// Sidebar-Karte, die den Lauf auch dann noch zeigt, wenn man diese Ansicht verlassen hat.
// Zweimal gerechnet waere zweimal die Gelegenheit, auseinanderzulaufen.
// Die Aufschluesselung (Phasenkette, Zaehler, Zeiten) rendert `ActivityProgress`; hier bleiben nur
// die Werte, die das Reset-Overlay dieser Ansicht selbst anschreibt.
const { progress, elapsedMs, runPercent, runRemainingMs, runPhaseLabel } = useActivity()

async function analyze() {
  if (!source.value.trim()) return
  try {
    const res = await analyzeBatch(source.value)
    // DB-Duplikate -> erst nachfragen, dann ggf. mit overwrite erneut senden.
    if (res.needsConfirm) {
      pendingConflicts.value = res.conflicts
      return
    }
    finishBatch(res)
  } catch {
    // Fehler steht in `error` (Composable) und wird im Modal angezeigt.
  }
}

async function confirmOverwrite() {
  confirming.value = true
  pendingConflicts.value = null // Dialog schliessen -> der Fortschritt im Modal wird sichtbar
  try {
    const res = await analyzeBatch(source.value, { overwrite: true })
    finishBatch(res)
  } catch {
    // Fehler steht in `error` (Composable).
  } finally {
    confirming.value = false
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
  // Der Sprung aus der globalen Suche haelt den Graphen auf EINER Klasse fest. Wer daneben eine
  // andere waehlt, meint nicht mehr sie – dann gilt wieder der Filter, sonst zeigte der Graph das
  // Umfeld einer Klasse, die rechts gar nicht mehr offen ist.
  if (egoOverride && egoOverride.id !== id) releaseEgoOverride()
  // …und die geliehene Panelbreite zurueckgeben: wer im Graphen oder im Baum weiterklickt,
  // arbeitet wieder mit dem Bild, nicht mit dem Code eines Suchtreffers.
  releaseFocus()
  handoffSearch.value = null
  selectedFileId.value = id
  // Wer eine Klasse waehlt, meint die Klasse. Eine offene Beziehung wird davon nicht ungueltig –
  // sie tritt nur hinter den Umschalter zurueck (und gibt dabei ihre Markierung im Graphen ab).
  detailTab.value = 'class'
}

// Klick im Baum: Klasse rechts aufschlagen UND im Graphen genau sie zeigen – mit allen Klassen,
// mit denen sie verbunden ist, und den Kanten dazwischen (`focusClassInGraph`).
// Vorher fuehrte der Klick nur in ihr PACKAGE und zentrierte die Karte: in einem Package mit
// hundert Klassen war die gewaehlte damit eine Karte unter hundert, und ihre Nachbarn ausserhalb
// des Packages standen bestenfalls als Aggregat daneben. Gefragt ist aber „was haengt an DIESER
// Klasse?" – dieselbe Frage, die der Sprung aus der globalen Suche schon so beantwortet.
// Die Ebene bleibt dabei unangetastet (kein `focusGraphOnFile`): sie ist der Stand, auf den das
// Bild zurueckfaellt, sobald man das Ego loslaesst – ein Ebenenwechsel obendrauf waere eine zweite
// Bewegung und liesse den Ausschnitt danach woanders stehen.
function selectFileFromTree(file) {
  selectFile(file.id)
  focusClassInGraph(file)
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
  if (payload?.deleted) {
    await fetchFiles()
    refreshInsights()
  }
  // Panel zu -> geliehene Breite zurueck in die Ursprungsposition.
  releaseFocus()
  handoffSearch.value = null
  selectedFileId.value = null
}

// --- Komplett-Reset: alle Klassen + Kanten + Queue dauerhaft entfernen ---
function askReset() {
  pendingReset.value = true
}
function cancelReset() {
  if (resetting.value) return
  pendingReset.value = false
}
async function confirmReset() {
  if (resetting.value) return
  resetting.value = true
  // Derselbe Fortschritts-Apparat wie beim Analysieren (in `useActivity`): bei tausenden Klassen
  // dauert auch das Loeschen spuerbar, und ein stummer Dialog laesst offen, ob etwas passiert.
  try {
    await cancelAllJobs() // laufende/abgeschlossene KI-Jobs stoppen + leeren
    await resetAll() // alle Klassen aus der DB loeschen
    resetEdges() // Frontend-Kanten-Spiegel sofort leeren
    // Lokalen View-State auf "frisch geoeffnet" zuruecksetzen.
    selectedFileId.value = null
    activeTargetLine.value = null
    activeTargetEndLine.value = null
    source.value = ''
    filename.value = ''
    search.value = ''
    clearNotifications()
    pendingDelete.value = null
    pendingConflicts.value = null
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    // Es gibt keine Klassen mehr, also auch keinen Ort, an dem man stehen koennte: der gemerkte
    // Stand faellt mit ihnen weg (auch der Teil, den der Graph geschrieben hat – ein Schluessel).
    clearCodeState()
    clearInsights()
    showNew.value = true // Neu-Panel einladend wieder aufklappen
    pendingReset.value = false
  } catch (e) {
    setNotice(e.message, 'error')
  } finally {
    resetting.value = false
  }
}

function onResetPanels() {
  resetPanels()
}
</script>

<template>
  <div
    class="relative flex h-full flex-col text-ink"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Ziel ist die ganze Ansicht, nicht ein Kaestchen darin: beim Ziehen zielt niemand, man
         laesst los. Das Overlay sagt deshalb nur, DASS hier losgelassen werden darf – es ist keine
         Flaeche, die man treffen muss. `pointer-events-none`, damit es den Drop nicht selbst
         abfaengt; die Handler sitzen am Wurzelelement. -->
    <Transition name="dropfade">
      <div v-if="dropActive" class="drop-overlay pointer-events-none">
        <div class="drop-card">
          <Icon icon="lucide:upload" class="drop-icon" />
          <p class="drop-title">Drop <span class="font-mono">.java</span> files to add</p>
          <p class="drop-sub">Several types in one file are split automatically</p>
        </div>
      </div>
    </Transition>

    <!-- ── Command-Bar: eine Zeile, damit die Arbeitsflaeche darunter den Raum bekommt ── -->
    <header class="shrink-0 border-b border-line px-5 py-2.5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <Icon icon="lucide:git-fork" class="h-[18px] w-[18px]" />
          </span>
          <h1 class="truncate font-mono text-[0.9375rem] font-semibold tracking-tight">Code Analysis</h1>
        </div>

        <!--
          Hier stand der Fortschritts-Chip des laufenden Imports (Phasenleiste, Prozent, Restzeit).
          Er ist ENTFALLEN: dieselbe Auskunft steht seit der Aktivitaets-Karte in der Sidebar, also
          auf JEDER Ansicht – und ein Lauf, der auf dem Server weiterlaeuft, gehoert nicht in die
          Kopfzeile einer einzelnen Ansicht. Zwei Anzeigen desselben Laufs waeren ausserdem zwei
          Stellen, an denen man dieselbe Zahl pflegen muss. Die Einzelheiten (Phasenkette, Zaehler,
          Zeiten) liegen einen Klick auf die Karte entfernt; die Bestandsmetriken unten bleiben
          waehrend eines Laufs stehen, statt dem Chip Platz zu machen.
        -->

        <!-- Live-Metriken: monospace + gedaempft. Zahlen tragen die Information, nicht die Farbe. -->
        <div v-if="files.length" class="hidden items-center gap-2.5 font-mono text-2xs text-muted md:flex">
          <span v-for="lang in LANGUAGES" :key="lang.id" class="inline-flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 rounded-full bg-accent" />{{ lang.label }}
          </span>
          <span class="opacity-40">·</span>
          <span><b class="font-semibold tabular-nums text-ink">{{ classCount }}</b> classes</span>
          <span class="opacity-40">·</span>
          <span><b class="font-semibold tabular-nums text-ink">{{ packageCount }}</b> packages</span>
          <span class="opacity-40">·</span>
          <span class="inline-flex items-center gap-1">
            <Icon icon="lucide:sparkles" class="h-3 w-3 text-accent" />
            <b class="font-semibold tabular-nums text-ink">{{ analyzedCount }}</b>/{{ classCount }} analyzed
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
              ? 'border-[color-mix(in_srgb,var(--color-lavender)_40%,transparent)] bg-lavender-soft text-lavender'
              : 'border-line text-muted hover:bg-surface-offset hover:text-ink'"
            v-tip="runningQueueJob
              ? { title: `Analyzing ${runningQueueJob.className}`, hint: `${finishedQueueCount} of ${queueSummary?.total ?? 0} classes done${queueEta ? ` · ${queueEta} remaining` : ''}` }
              : { title: 'AI queue', hint: 'What is queued, running or finished — cancel single jobs or all of them.' }"
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
            class="action-btn inline-flex h-9 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-accent-soft px-2.5 text-[0.8125rem] font-semibold text-accent transition hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="analyzingAll"
            v-tip="{ title: 'Run AI on everything new', hint: 'Queues every class and method that has no summary yet — runs in the background, you can keep working.' }"
            @click="analyzeAll"
          >
            <Icon
              :icon="analyzingAll ? 'lucide:loader-2' : 'lucide:sparkles'"
              class="h-4 w-4"
              :class="analyzingAll ? 'animate-spin' : ''"
            />
            <span class="hidden sm:inline">{{ analyzingAll ? 'Queueing…' : 'Run AI' }}</span>
          </button>

          <!-- Primaeraktion: neue Quellen einlesen. Seit die Startseite keine Drop-Zone mehr hat,
               ist dies der einzige Eingang fuer neuen Code – er traegt deshalb sichtbar mehr
               Gewicht als die uebrigen Knoepfe (Verlauf, Akzentschatten, Anheben beim Hover) und
               antwortet auf eine gezogene Datei, indem er aufleuchtet (`is-armed`). -->
          <button
            type="button"
            class="add-btn action-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[0.8125rem] font-semibold text-accent-contrast"
            :class="{ 'is-armed': dropActive }"
            v-tip="{ title: 'Add code', hint: 'Paste sources — or drop .java files anywhere on this view. Several classes at once are split automatically.' }"
            @click="showNew = true"
          >
            <Icon icon="lucide:plus" class="h-4 w-4" />
            Add code
          </button>

          <!-- Werkzeuge der Ansicht als EINE Gruppe: sie standen hinter einem ⋯-Menue, das man
               erst oeffnen musste, um zu sehen, was es ueberhaupt gibt. Sichtbar, aber als ein
               Element gesetzt (ein Rahmen, Haarlinien dazwischen) – drei einzelne Knoepfe neben
               „Run AI" und „Add code" haetten sechs gleichrangige Bedienelemente ergeben. -->
          <div class="tool-group inline-flex h-9 items-stretch overflow-hidden rounded-lg border border-line">
            <!-- Laeuft es, traegt der Knopf seinen Zustand als Text: der Lauf dauert bei grossen
                 Codebasen (erster Lauf, kalter Parse-Cache) deutlich laenger als ein Klick-Feedback. -->
            <button
              type="button"
              class="tool-btn relative isolate overflow-hidden"
              :class="recomputing ? 'is-busy' : ''"
              :disabled="recomputing || !files.length"
              v-tip="recomputing
                ? { title: 'Recomputing…', hint: recomputeTitle }
                : { title: 'Recompute relations', hint: 'Re-reads every stored source and rebuilds the automatic call, uses and import edges. Manual and dismissed edges stay.' }"
              aria-label="Recompute edges"
              @click="onRecomputeEdges"
            >
              <!-- Fuellbalken hinter dem Inhalt – dieselbe Sprache wie der AI-Queue-Chip: der
                   Knopf IST die Anzeige, kein zweites Element daneben. -->
              <span
                v-if="recomputePercent !== null"
                class="absolute inset-y-0 left-0 -z-10 bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] transition-[width] duration-300 ease-out"
                :style="{ width: recomputePercent + '%' }"
              />
              <Icon :icon="recomputing ? 'lucide:loader-2' : 'lucide:git-branch'" class="h-4 w-4 shrink-0" :class="recomputing ? 'animate-spin' : ''" />
              <!-- Das Wort erst ab 2xl: darunter wuerde der wachsende Knopf die Kopfzeile in eine
                   zweite Zeile drucken – ein Layoutsprung mitten im Lauf. Die Zahl daneben sagt
                   ohnehin mehr, und der Tooltip nennt den ganzen Satz. -->
              <span v-if="recomputing" class="hidden whitespace-nowrap text-[0.8125rem] font-medium 2xl:inline">
                Recomputing<template v-if="!recomputeProgress">…</template>
              </span>
              <!-- Zahl wie Wort erst ab 2xl. Der Grund ist gemessen und nicht verhandelbar: bei
                   1280 hat die Zeile null Reserve – schon +28 px (das blosse Prozent) drucken sie
                   in eine zweite Zeile, und ein Layoutsprung mitten im Lauf ist teurer als die
                   Zahl. Darunter traegt der Fuellbalken „es laeuft und wie weit", die Zahlen
                   stehen im Tooltip. `tabular-nums`, damit die Breite nicht bei jedem Tick springt. -->
              <span v-if="recomputeProgress" class="hidden shrink-0 font-mono text-2xs tabular-nums opacity-80 2xl:inline">
                {{ recomputeProgress.done }}/{{ recomputeProgress.total }}
              </span>
            </button>
            <!-- Export steht bei den Werkzeugen, nicht bei den Primaeraktionen: er aendert nichts,
                 er gibt nur heraus. Direkt neben „Delete all data" ist er ausserdem dort, wo man
                 ihn braucht – vor dem Loeschen. -->
            <button
              type="button"
              class="tool-btn"
              :disabled="!files.length"
              v-tip="{ title: 'Export all classes', hint: 'One text with every stored source — copy or download it, paste it back to restore everything.' }"
              aria-label="Export all classes"
              @click="exportOpen = true"
            >
              <Icon icon="lucide:clipboard-copy" class="h-4 w-4 shrink-0" />
            </button>
            <!-- Breit lesen. Steht direkt vor „Reset layout", weil beide dieselbe Sache regeln –
                 wie viel Platz welche Spalte bekommt. -->
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-on': panelsWide }"
              :disabled="!isWide"
              :aria-pressed="panelsWide"
              v-tip="panelsWide
                ? { title: 'Back to the normal layout', hint: 'Brings the graph back (Alt+W).' }
                : { title: 'Wide code panel', hint: 'Hides the graph and gives its width to the detail column (Alt+W).' }"
              aria-label="Wide code panel"
              @click="onToggleWide"
            >
              <Icon :icon="panelsWide ? 'lucide:minimize-2' : 'lucide:maximize-2'" class="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              class="tool-btn"
              :disabled="!isWide || !panelsDirty"
              v-tip="panelsDirty
                ? { title: 'Reset layout', hint: 'Puts the three columns back to their default widths.' }
                : { title: 'Layout is at its default', hint: 'Drag a divider to change the column widths.' }"
              aria-label="Reset layout"
              @click="onResetPanels"
            >
              <Icon icon="lucide:layout-grid" class="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              class="tool-btn tool-btn--danger"
              :disabled="resetting || !files.length"
              v-tip="{ title: 'Delete all data', hint: 'Removes every analyzed class, relation and queue entry. Export first if you want them back.' }"
              aria-label="Delete all data"
              @click="askReset"
            >
              <Icon :icon="resetting ? 'lucide:loader-2' : 'lucide:trash-2'" class="h-4 w-4 shrink-0" :class="resetting ? 'animate-spin' : ''" />
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- Neu-Analyse als Modal (ausgeloest vom Primaerbutton der Command-Bar). -->
    <!--
      Feste Modalhoehe (Header / scrollender Body / verankerter Footer). Damit bleibt der
      Analyze-Button auch bei 500 erkannten Klassen an derselben Stelle sichtbar – frueher
      schob ihn die Chip-Liste aus dem Viewport.

      ⚠️ `close-on-escape` bleibt AUS: Escape hat in dieser Ansicht eine Vorrangordnung
      (s. onKeydown) – dieses Modal schliesst nur, wenn kein Konflikt-Dialog darueber liegt.
    -->
    <Modal
      :open="showNew"
      size="wide"
      max-height="max-h-[min(88vh,860px)]"
      elevation="elev-4"
      label="Add code"
      @close="showNew = false"
    >
      <header class="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 class="flex items-center gap-2 text-base font-bold text-ink">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <Icon icon="lucide:sparkles" class="h-[18px] w-[18px]" />
          </span>
          Analyze code
        </h2>
        <!-- Eingabemodus: Code einfuegen vs. .java-Datei(en) hochladen (beide fuellen `source`). -->
        <div class="ml-auto inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition"
            :class="inputMode === 'paste' ? 'bg-accent text-accent-contrast elev-1' : 'text-muted hover:text-ink'"
            @click="inputMode = 'paste'"
          >
            <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
            Paste code
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition"
            :class="inputMode === 'file' ? 'bg-accent text-accent-contrast elev-1' : 'text-muted hover:text-ink'"
            @click="inputMode = 'file'"
          >
            <Icon icon="lucide:upload" class="h-3.5 w-3.5" />
            Upload file
          </button>
        </div>
        <!-- Waehrend eines Laufs ist das kein Abbrechen, sondern ein Wegstellen: der Import
             laeuft weiter, die Sidebar-Karte traegt ihn sichtbar. Icon + Titel
             sagen das auch – ein "×" an dieser Stelle laese "abbrechen" erwarten. -->
        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-offset hover:text-ink"
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
      <!-- Ring, Phasenkette und Zeiten stehen in `ActivityProgress` – derselben Komponente,
           die auch das Detailfenster der Sidebar-Karte zeigt. Zwei Abschriften waeren zwei
           Gelegenheiten, verschiedene Prozentzahlen ueber denselben Lauf zu behaupten. -->
      <ActivityProgress v-if="analyzing && progress">
        <template #note>You can close this – the run continues and stays visible in the sidebar.</template>
      </ActivityProgress>

      <!-- Arbeitsflaeche: ab lg zweispaltig und in sich scrollend, darunter gestapelt. -->
      <div v-else class="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden">
        <div class="flex min-h-0 min-w-0 flex-col gap-2">
          <label
            v-if="inputMode === 'file'"
            class="flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-3 py-2 text-xs text-muted transition hover:border-accent hover:bg-surface-offset"
          >
            <Icon icon="lucide:file-code" class="h-4 w-4 shrink-0 text-accent" />
            <span v-if="filename" class="truncate font-mono text-ink">{{ filename }}</span>
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
            <div v-for="s in inputTiles" :key="s.label" class="rounded-xl border border-line bg-surface px-2.5 py-2">
              <div class="font-mono text-[1.0625rem] font-semibold leading-none tabular-nums text-ink">{{ s.value }}</div>
              <div class="mt-1.5 text-3xs font-medium uppercase tracking-wide text-muted">{{ s.label }}</div>
            </div>
          </div>
          <label class="flex min-h-0 flex-1 flex-col">
            <span class="mb-1 block text-2xs font-semibold uppercase tracking-wide text-muted">Project context (optional)</span>
            <textarea
              v-model="userContext"
              spellcheck="false"
              placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
              class="min-h-[6rem] w-full flex-1 resize-none rounded-xl border border-line bg-surface p-2.5 text-xs text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft"
            />
          </label>
        </aside>
      </div>

      <!-- Footer: verankert, traegt die Primaeraktion. Scrollt nie weg. -->
      <footer class="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-surface px-4 py-3">
        <p v-if="error" class="min-w-0 flex-1 text-xs text-danger">{{ error }}</p>
        <p v-else class="min-w-0 flex-1 font-mono text-2xs text-muted">
          {{ sourceStats ? 'Parsed server-side – every type becomes its own class.' : 'Paste one or many Java types – they are split automatically.' }}
        </p>
        <span class="hidden shrink-0 items-center gap-1 text-2xs text-muted sm:inline-flex">
          <kbd class="kbd">Ctrl</kbd><span class="opacity-50">+</span><kbd class="kbd">↵</kbd>
        </span>
        <button
          type="button"
          class="action-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-offset hover:text-ink"
          @click="showNew = false"
        >
          <Icon v-if="analyzing" icon="lucide:minimize-2" class="h-4 w-4" />
          {{ analyzing ? 'Run in background' : 'Cancel' }}
        </button>
        <button
          type="button"
          class="action-btn inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-semibold text-accent-contrast elev-1 transition hover:bg-accent-hover disabled:opacity-50"
          :disabled="analyzing || !source.trim()"
          @click="analyze"
        >
          <Icon :icon="analyzing ? 'lucide:loader-2' : 'lucide:sparkles'" class="h-4 w-4" :class="analyzing ? 'animate-spin' : ''" />
          {{ analyzing ? 'Analyzing…' : detectedClasses.length ? `Analyze ${detectedClasses.length} class(es)` : 'Analyze' }}
        </button>
      </footer>
    </Modal>

    <!-- 3-Spalten-Layout (ab lg per Drag verschiebbar; darunter einspaltig gestapelt). -->
    <!-- `panel-grid` animiert die Spaltenbreiten – aber NUR, wenn nicht gezogen wird: waehrend
         eines Drags muss die Kante an der Maus kleben, eine Uebergangszeit machte daraus ein
         Nachziehen. Gebraucht wird die Animation fuer das Aufmachen nach einem Suchtreffer. -->
    <div
      class="grid min-h-0 flex-1 p-4"
      :class="[isWide ? 'panel-grid' : 'grid-cols-1 gap-4', isDragging ? 'is-dragging' : '']"
      :style="isWide ? { gridTemplateColumns: gridTemplate } : null"
    >
      <!-- Spalte 1: Suche + Package-Tree -->
      <section class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-2">
        <div class="relative z-20 shrink-0 border-b border-line p-2">
          <!-- DIE Suche der Ansicht: sie filtert diesen Baum, stellt den Graphen auf die Treffer
               und markiert sie dort. Im Graphen stand dafuer frueher ein zweites Feld – zwei
               Eingaben fuer dieselbe Frage, von denen man die richtige erst kennen musste.
               Das Feld hat die ganze Zeile: neben ihm stand der Falt-Umschalter des Baums und nahm
               ihm ein Sechstel der Breite – ausgerechnet ein Knopf, der waehrend einer Suche
               deaktiviert ist. Gefaltet wird jetzt am Ordner selbst. -->
          <div class="relative">
            <Icon icon="lucide:search" class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              ref="filterInput"
              v-model="search"
              type="text"
              spellcheck="false"
              placeholder="Search classes…  /"
              :title="GRAPH_QUERY_HELP"
              class="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-7 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft"
              @focus="searchFocused = true"
              @blur="searchFocused = false"
              @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
              @keydown.esc="onSearchEsc"
            />
            <button
              v-if="search"
              type="button"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition hover:text-ink"
              title="Clear search (Esc)"
              @click="search = ''"
            >
              <Icon icon="lucide:x" class="h-3.5 w-3.5" />
            </button>
          </div>
          <!-- Facetten: erscheinen im leeren, fokussierten Feld und tragen sich per Klick selbst
               ein. In einem Tooltip wuerde sie niemand finden. Sie liegen UEBER dem Baum, nicht im
               Fluss darueber: sonst rutschte er bei jedem Klick ins Feld um ihre Hoehe nach unten. -->
          <div
            v-if="searchFocused && !search"
            class="absolute left-2 right-2 top-full z-30 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface-2 p-1.5 elev-2"
          >
            <span class="font-mono text-3xs uppercase tracking-[0.12em] text-muted">Narrow it down</span>
            <button
              v-for="f in QUERY_FACETS"
              :key="f.prefix"
              type="button"
              class="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-3xs text-muted transition hover:border-accent hover:text-ink"
              @mousedown.prevent="applyFacet(f.prefix)"
            >
              <code class="font-mono text-accent">{{ f.prefix }}</code>{{ f.label }}
            </button>
          </div>
          <!-- Trefferbilanz. Ist die Liste gedeckelt, steht es DANEBEN – ein Baum, der nur einen
               Teil zeigt, darf nicht aussehen wie das vollstaendige Ergebnis. Kanten stehen dabei,
               wo sie die eigentliche Antwort sind (`m:`, `review:`, `manual:`). -->
          <p v-if="searching" class="mt-1.5 flex items-center gap-1.5 px-1 font-mono text-3xs text-muted">
            <!-- „classes" und „relations" ausschreiben: die Leiste im Graphen zaehlt daneben die
                 Beziehungen des AUSSCHNITTS. Zwei Zahlen unter demselben Wort waeren eine
                 Verwechslung, die niemand aufloest. -->
            <span>{{ filteredFiles.length }}/{{ classCount }} classes</span>
            <span
              v-if="queryEdges"
              :title="`${queryEdges} stored relation${queryEdges === 1 ? '' : 's'} match — the classes at their ends are the list above`"
            >· {{ queryEdges }} relation{{ queryEdges === 1 ? '' : 's' }}</span>
            <span
              v-if="treeTruncated > 0"
              class="rounded bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] px-1 text-warning"
              :title="`Only the first ${TREE_MATCH_LIMIT} are listed – keep typing to narrow it down`"
            >first {{ TREE_MATCH_LIMIT }}</span>
            <!-- Von Treffer zu Treffer faehrt der GRAPH. Die Knoepfe stehen in DIESER Zeile und
                 nicht neben dem Feld: dort nahmen sie ihm ein Drittel seiner Breite, und die Zeile
                 gibt es ohnehin nur, solange gesucht wird. -->
            <span class="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                class="grid h-5 w-5 place-items-center rounded transition hover:bg-surface-offset hover:text-ink disabled:pointer-events-none disabled:opacity-35"
                title="Previous match (Shift+↵) — the graph moves to it"
                :disabled="!hasMatches"
                @click="stepMatch(-1)"
              >
                <Icon icon="lucide:chevron-up" class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                class="grid h-5 w-5 place-items-center rounded transition hover:bg-surface-offset hover:text-ink disabled:pointer-events-none disabled:opacity-35"
                title="Next match (↵) — the graph moves to it"
                :disabled="!hasMatches"
                @click="stepMatch(1)"
              >
                <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5" />
              </button>
            </span>
          </p>

          <!-- ⚠️ Bei `path:`/`impact:` ist die Trefferzahl die SCHWAECHERE Haelfte der Antwort:
               gefragt war eine Strecke („wie kommt A an B?"), und „7 classes" beantwortet das
               nicht. Diese Zeile sagt, WAS gefunden wurde – und wenn nichts, warum nicht. -->
          <div
            v-if="queryDetail"
            class="mt-1.5 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-3xs text-muted"
          >
            <template v-if="queryDetail.state === 'incomplete'">
              <span v-if="queryDetail.kind === 'path'">
                Type <code class="font-mono text-accent">path: Source &gt; Target</code> — two class names.
              </span>
              <span v-else>Type a class name — everything that would break if it changes.</span>
            </template>

            <template v-else-if="queryDetail.state === 'unknown'">
              No class by that name{{ queryDetail.side ? ` (${queryDetail.side})` : '' }}.
            </template>

            <template v-else-if="queryDetail.state === 'ambiguous'">
              <p class="text-ink">
                Several classes share that name{{ queryDetail.side ? ` (${queryDetail.side})` : '' }} — add the package:
              </p>
              <div class="mt-1 flex flex-wrap gap-1">
                <span v-for="c in queryDetail.candidates" :key="c.id" class="font-mono">
                  {{ c.package }}.{{ c.class_name }}
                </span>
              </div>
            </template>

            <template v-else-if="queryDetail.kind === 'path'">
              <template v-if="queryDetail.state === 'none'">
                <span class="text-warning">No route</span> from
                <span class="font-mono">{{ queryDetail.from.class_name }}</span> to
                <span class="font-mono">{{ queryDetail.to.class_name }}</span> — nothing it uses ever
                reaches it. Both are in the picture.
              </template>
              <template v-else>
                <p>
                  {{ queryDetail.paths.length }}{{ queryDetail.paths.length === MAX_PATHS ? '+' : '' }}
                  route{{ queryDetail.paths.length === 1 ? '' : 's' }} · shortest
                  {{ queryDetail.paths[0].length - 1 }} step{{ queryDetail.paths[0].length === 2 ? '' : 's' }}
                </p>
                <!-- Die kürzeste Kette ausgeschrieben: sie IST die Antwort, alles Weitere ist
                     Variation. Die Namen sind Knöpfe – ein Weg, den man nicht begehen kann, ist
                     eine Behauptung. -->
                <div class="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <template v-for="(id, i) in queryDetail.paths[0]" :key="i">
                    <button
                      type="button"
                      class="font-mono text-ink underline-offset-2 hover:text-accent hover:underline"
                      @click="selectFile(id)"
                    >{{ queryDetail.names[0][i] }}</button>
                    <Icon
                      v-if="i < queryDetail.paths[0].length - 1"
                      icon="lucide:arrow-right"
                      class="h-2.5 w-2.5 shrink-0"
                    />
                  </template>
                </div>
              </template>
            </template>

            <template v-else>
              <p>
                <span class="font-mono text-ink">{{ queryDetail.target.class_name }}</span>
                affects <span class="text-ink">{{ queryDetail.total }}</span>
                class{{ queryDetail.total === 1 ? '' : 'es' }}
                <template v-if="queryDetail.total">
                  · {{ queryDetail.direct }} directly · up to {{ queryDetail.maxDepth }} hop{{ queryDetail.maxDepth === 1 ? '' : 's' }} away
                </template>
              </p>
              <p v-if="!queryDetail.total" class="mt-0.5">
                Nothing uses it — changing it breaks nobody else.
              </p>
              <p v-if="queryDetail.truncated" class="mt-0.5 text-warning">
                Stopped at {{ MAX_IMPACT }} — the real reach is larger.
              </p>
            </template>
          </div>
        </div>

        <ul ref="treeListEl" class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <!-- Die Kante links am Eintrag klammert zusammen, was im Graphen zu sehen ist: kraeftig
               an der offenen Ebene selbst, blass an deren Inhalt. -->
          <li
            v-for="row in rows"
            :key="row.id"
            class="tree-li"
            :class="row.state === 'here' ? 'tree-zone tree-zone--head' : row.state === 'inside' ? 'tree-zone' : ''"
          >
            <!-- Package-Ordner -->
            <button
              v-if="row.kind === 'folder'"
              type="button"
              class="tree-row group/f flex w-full items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-left text-2xs font-semibold text-muted transition hover:bg-surface-offset hover:text-ink"
              :class="row.state === 'here' ? 'is-here' : row.state === 'trail' ? 'is-trail' : ''"
              :data-path="row.fullPath"
              @click="toggleFolder(row.fullPath, row.open)"
            >
              <span v-for="d in row.depth" :key="d" class="tree-guide" />
              <Icon icon="lucide:chevron-down" class="h-3 w-3 shrink-0 opacity-70 transition-transform" :class="row.open ? '' : '-rotate-90'" />
              <Icon :icon="row.state === 'here' ? 'lucide:package-open' : 'lucide:package'" class="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span class="min-w-0 flex-1 truncate font-mono">{{ row.label }}</span>
              <!-- Der Punkt sagt „genau diese Ebene steht gerade im Graphen" – ein Wort dafuer
                   passt in eine schmale Spalte nicht, der Titel traegt es nach. -->
              <span v-if="row.state === 'here'" class="tree-here shrink-0" title="Currently open in the graph" />
              <span class="shrink-0 font-mono text-3xs tabular-nums opacity-60">{{ row.count }}</span>
            </button>

            <!-- Klasse -->
            <div v-else class="group relative" :data-fid="row.file.id">
              <button
                type="button"
                class="tree-row flex w-full items-center gap-1.5 rounded-md py-1.5 pl-1 pr-8 text-left transition"
                :class="selectedFileId === row.file.id
                  ? 'is-selected bg-accent-soft text-accent'
                  : 'hover:bg-surface-offset'"
                @click="selectFileFromTree(row.file)"
              >
                <span v-for="d in row.depth" :key="d" class="tree-guide" />
                <Icon
                  icon="lucide:braces"
                  class="h-3.5 w-3.5 shrink-0"
                  :class="selectedFileId === row.file.id ? 'text-accent' : 'text-muted'"
                />
                <span class="min-w-0 flex-1 truncate text-[0.8125rem]" :class="selectedFileId === row.file.id ? 'font-semibold' : ''">
                  <template v-for="(p, i) in hl(row.file.class_name)" :key="i"><mark v-if="p.m" class="rounded-sm bg-transparent px-0 font-semibold text-accent">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
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
                  class="h-3.5 w-3.5 shrink-0 text-accent transition group-hover:opacity-0"
                  title="AI-analyzed"
                />
                <span
                  v-if="row.file.method_count"
                  class="shrink-0 font-mono text-3xs tabular-nums text-muted opacity-60 transition group-hover:opacity-0"
                >
                  {{ row.file.method_count }}
                </span>
              </button>
              <button
                type="button"
                class="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-danger opacity-0 transition hover:bg-surface-offset focus:opacity-100 group-hover:opacity-100"
                title="Delete class"
                :aria-label="`Delete class ${row.file.class_name}`"
                @click.stop="askDelete(row.file)"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
              </button>
            </div>
          </li>

          <!-- Erster Aufbau der Liste: dieselbe Wartemeldung wie ueberall sonst. Bei einigen
               tausend Klassen kommt die Antwort nicht sofort, und ein leerer Baum sieht aus wie
               „keine Klassen" – also genau die falsche Auskunft. -->
          <li v-if="filesLoading && !files.length" class="px-3 py-4">
            <BusyState
              variant="panel"
              title="Loading classes…"
              detail="names, packages and relations"
              hint="A large codebase takes a moment — the list carries every class with its package and dependencies."
              :since="filesStartedAt"
              :rows="5"
            />
          </li>

          <!-- Leerzustand: getrennt fuer "nichts geladen" und "Filter ohne Treffer". -->
          <li v-else-if="!rows.length" class="px-3 py-10 text-center">
            <template v-if="searching">
              <Icon icon="lucide:search" class="mx-auto mb-2 h-6 w-6 text-muted opacity-40" />
              <p class="text-xs text-muted">No class matches “{{ appliedSearch }}”.</p>
              <!-- `r:` fragt den gezeichneten Graphen. Zeigt der gerade Packages, gibt es dort keine
                   Rollen zu finden – ohne diesen Satz sieht das aus wie „es gibt keine Hubs". -->
              <p v-if="queryResult.scope === 'picture'" class="mt-1.5 text-3xs text-muted">
                A role belongs to a class in the drawn graph — open a package or switch to Classes.
              </p>
            </template>
            <!-- Ohne Klassen ist „Add code" die einzige sinnvolle Handlung – und seit die
                 Startseite ihre Drop-Zone abgegeben hat, ist dies der Ort, an dem man sie erwartet.
                 Deshalb hier keine Fussnote unter einem grauen Icon, sondern die Einladung selbst:
                 dieselbe gestrichelte Flaeche, die auch beim Ziehen erscheint. -->
            <template v-else>
              <div class="empty-drop">
                <span class="empty-icon"><Icon icon="lucide:upload" class="h-5 w-5" /></span>
                <p class="empty-title">Drop <span class="font-mono">.java</span> files here</p>
                <p class="empty-sub">anywhere on this view — or paste sources</p>
                <button type="button" class="add-btn empty-btn" @click="showNew = true">
                  <Icon icon="lucide:plus" class="h-3.5 w-3.5" />
                  Add code
                </button>
              </div>
            </template>
          </li>
        </ul>
      </section>

      <!-- Divider 1↔2 (Drag). Im Breit-Modus gibt es nichts zu teilen: die Mitte ist weg, und die
           eine verbleibende Kante wuerde eine andere Frage beantworten als die, fuer die dieser
           Griff da ist. -->
      <div
        v-if="isWide && !centerHidden"
        class="panel-resizer"
        :class="{ 'is-active': activeKey === 'left' }"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="startDrag('left', $event)"
      >
        <span class="panel-resizer__grip" />
      </div>

      <!-- Spalte 2: Graph. Im Breit-Modus ausgeblendet – `v-show`, nicht `v-if`: Zoom, Ausschnitt
           und Auswahl von Vue Flow duerfen dabei nicht verworfen werden. Beim Zurueckschalten holt
           `refitGraphSoon()` die Kamera nach, denn aus `display:none` kommt eine Flaeche ohne Masse. -->
      <div v-show="!centerHidden" class="min-h-[55vh] lg:min-h-0">
        <JavaDependencyGraph
          ref="graphRef"
          :files="files"
          :selected-id="selectedFileId"
          :focus-path="graphFocusPath"
          :focus-file-id="graphFocusFileId"
          :focus-token="graphFocusToken"
          :match-ids="graphMatchIds"
          :search-query="graphQuery"
          :relation-visible="showRelation"
          @select="selectFileFromGraph"
          @navigate="onGraphNavigate"
          @pane-click="releaseFocus"
          @clear-search="clearGraphScope"
          @find-result="onFindResult"
          @relation="onRelation"
        />
      </div>

      <!-- Divider 2↔3 (Drag) -->
      <div
        v-if="isWide && !centerHidden"
        class="panel-resizer"
        :class="{ 'is-active': activeKey === 'right' }"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        @mousedown.prevent="startDrag('right', $event)"
      >
        <span class="panel-resizer__grip" />
      </div>

      <!-- Spalte 3: Detail – wahlweise die geoeffnete Klasse oder die angeklickte Beziehung.
           `code-soft-wrap` gilt fuer die ganze Spalte und damit fuer alle drei Panels auf einmal:
           hier wird Code GELESEN, also bricht er um, statt sich waagerecht wegzuschieben (s.
           style.css). Eine Klasse an einer Stelle – kein Schalter, kein Zustand. -->
      <div class="code-soft-wrap flex min-h-0 flex-col gap-2">
        <!-- Umschalter, nur solange eine Beziehung offen ist. Ohne sie gibt es nichts zu waehlen,
             und eine Leiste mit einem einzigen, immer aktiven Knopf waere blosse Dekoration. -->
        <Transition name="pop">
          <div v-if="relation" class="detail-tabs">
            <button
              type="button"
              class="detail-tab"
              :class="{ 'is-active': detailTab === 'class' }"
              @click="detailTab = 'class'"
            >
              <Icon icon="lucide:box" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">{{ selectedFile ? selectedFile.class_name : 'Class' }}</span>
            </button>
            <button
              type="button"
              class="detail-tab"
              :class="{ 'is-active': detailTab === 'relation' }"
              @click="detailTab = 'relation'"
            >
              <Icon icon="lucide:share-2" class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">Relation</span>
            </button>
            <button
              type="button"
              class="detail-tab-x"
              title="Close relation (ESC)"
              aria-label="Close relation"
              @click="closeRelation()"
            >
              <Icon icon="lucide:x" class="h-4 w-4" />
            </button>
          </div>
        </Transition>

        <!-- min-h-0 + flex-1: der Detailbereich behaelt seine eigene Scrollflaeche, auch wenn der
             Umschalter darueber Platz belegt.
             `v-show` statt `v-if`: das Klassen-Panel traegt einen CodeMirror, eine Suchposition und
             eine Scrollstelle. Ein Blick auf die Beziehung und zurueck wuerde all das verwerfen und
             die Klasse neu laden – bei einem Umschalter, der zum Hin- und Herschauen da ist, waere
             das genau die falsche Antwort. -->
        <div v-show="!showRelation" class="min-h-0 flex-1">
          <JavaClassDetail
            ref="detailRef"
            v-if="selectedFileId"
            :key="selectedFileId"
            :file-id="selectedFileId"
            :target-line="activeTargetLine"
            :target-end-line="activeTargetEndLine"
            :handoff-search="handoffSearch"
            @close="onDetailClose"
            @query="applyQueryFromPanel"
          />
          <div
            v-else
            class="grid h-full place-items-center rounded-xl border border-dashed border-line px-6 text-center"
          >
            <div class="max-w-[15rem]">
              <span class="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface-offset text-muted">
                <Icon icon="lucide:mouse-pointer-click" class="h-5 w-5" />
              </span>
              <p class="mb-1 text-sm font-semibold text-ink">No class selected</p>
              <p class="text-xs leading-relaxed text-muted">
                Pick one from the list or click a node in the graph to see its methods, AI summaries and source.
              </p>
            </div>
          </div>
        </div>

        <!-- Die angeklickte Kante: Einzelbeziehung (Definition -> Aufrufstellen) oder die
             Aufloesung einer Aggregatkante. Beide sind hier Panels der Spalte, keine Modals –
             der Graph, aus dem der Klick kam, bleibt daneben sichtbar und markiert die Linie. -->
        <div v-if="relation" v-show="showRelation" class="min-h-0 flex-1">
          <JavaEdgeDetailPanel
            v-if="relation.kind === 'edge'"
            :edge="relation.edge"
            :visible="true"
            :loading="relation.loading"
            :loading-since="relation.since"
            :back="relation.back"
            ref="edgeDetailRef"
            @close="onRelationClose"
            @delete-edge="(id) => graphRef?.deleteRelationEdge?.(id)"
          />
          <JavaBundlePanel
            v-else
            :visible="true"
            :bundle="relation.bundle"
            :load-detail="relation.loadDetail"
            @close="onRelationClose"
            @open="relation.openRelation"
          />
        </div>
      </div>
    </div>

    <!-- Toasts rendert global NotificationHost (App.vue) – hier steht deshalb keiner mehr. -->

    <!-- Drag-Overlay: erzwingt col-resize global und haelt mousemove vom Vue-Flow-Canvas fern. -->
    <div v-if="isDragging" class="fixed inset-0 z-[60] cursor-col-resize select-none" />

    <!-- Bestaetigungs-Dialog: Klasse loeschen -->
    <ConfirmDialog
      :open="!!pendingDelete"
      tone="danger"
      icon="lucide:trash-2"
      title="Delete class?"
      confirm-label="Delete"
      :busy="deleting"
      busy-label="Deleting…"
      @cancel="cancelDelete"
      @confirm="confirmDelete"
    >
      <template #subtitle><span class="font-mono">{{ pendingDelete?.class_name }}</span></template>
      All graph connections will be removed. A linked wiki article (if any) is kept.
    </ConfirmDialog>

    <!-- Bestaetigungs-Dialog: vorhandene Klassen ueberschreiben -->
    <ConfirmDialog
      :open="!!pendingConflicts"
      tone="warning"
      size="md"
      title="Overwrite class(es)?"
      :subtitle="`${pendingConflicts?.length ?? 0} class(es) already analyzed.`"
      confirm-label="Overwrite"
      :busy="confirming"
      busy-label="Overwriting…"
      @cancel="cancelOverwrite"
      @confirm="confirmOverwrite"
    >
      <ul class="mb-4 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-2">
        <li
          v-for="fqcn in pendingConflicts || []"
          :key="fqcn"
          class="flex items-center gap-1.5 truncate font-mono text-xs text-ink"
        >
          <Icon icon="lucide:box" class="h-3.5 w-3.5 shrink-0 text-muted" />
          {{ fqcn }}
        </li>
      </ul>
      Overwriting replaces the existing records (including AI descriptions).
    </ConfirmDialog>

    <!-- Bestaetigungs-Dialog: alle Klassen zuruecksetzen (destruktiv) -->
    <ConfirmDialog
      :open="!!pendingReset"
      tone="danger"
      title="Reset everything?"
      :subtitle="`${classCount} class(es) affected`"
      confirm-label="Delete all"
      :busy="resetting"
      busy-label="Deleting…"
      @cancel="cancelReset"
      @confirm="confirmReset"
    >
      <template v-if="!resetting">
        All analyzed classes, edges and AI summaries will be
        <span class="font-semibold text-ink">permanently deleted</span>.
        Linked wiki articles are kept.
      </template>

      <!-- Laufender Reset: derselbe Fortschritt wie beim Analysieren, nur kompakt – der
           Dialog ist schmal, ein grosser Ring waere hier fehl am Platz. -->
      <div v-else>
        <div class="mb-1.5 flex items-baseline justify-between gap-2">
          <!-- Vor dem eigentlichen Loeschen laeuft `cancelAllJobs()` – dort gibt es noch keinen
               Lauf, und `runPhaseLabel` faellt ohne ihn auf die Analyse-Phasen zurueck. Ein
               „Splitting sources" im Loesch-Dialog waere eine Falschauskunft. -->
          <span class="text-sm font-semibold text-ink">{{ progress ? runPhaseLabel : 'Stopping AI queue' }}</span>
          <span v-if="progress" class="font-mono text-xs tabular-nums text-muted">{{ runPercent }}%</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-surface-offset">
          <div
            class="h-full rounded-full bg-danger transition-[width] duration-300 ease-out"
            :style="{ width: runPercent + '%' }"
          />
        </div>
        <div class="mt-2 flex items-baseline justify-between gap-2 font-mono text-2xs tabular-nums text-muted">
          <span v-if="progress?.total">
            <b class="font-semibold text-ink">{{ nf.format(progress.done || 0) }}</b>/{{ nf.format(progress.total) }} removed
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
    </ConfirmDialog>

    <!-- KI-Queue-Modal (breit/langgezogen): aus der Command-Bar geoeffnet. -->
    <JavaQueueModal :open="queueOpen" @close="queueOpen = false" @select="onQueueSelect" />
    <JavaExportModal :open="exportOpen" @close="exportOpen = false" />
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Die eigene `modal`-Transition ist entfallen – sie steht jetzt in `ui/Modal.vue`. */

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

/* Umschalter der Detail-Spalte: Klasse | Beziehung. Ein Segment, kein Stapel aus zwei Karten –
   die beiden schliessen einander aus, und was gerade gilt, soll man an einer Stelle sehen. Er
   erscheint erst, wenn es wirklich zwei Dinge gibt (s. Template) und ersetzt den frueheren
   „Back to relation"-Knopf: derselbe Rueckweg, aber in beide Richtungen. */
.detail-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 0.75rem;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 3px;
}
.detail-tab {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  padding: 0.3rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.detail-tab:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
/* Der aktive Reiter traegt Flaeche, nicht nur Farbe: bei zwei gleich breiten Knoepfen nebeneinander
   ist eine Textfarbe allein zu leise, um „hier stehe ich" zu sagen. */
.detail-tab.is-active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent);
}
.detail-tab-x {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.detail-tab-x:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
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
/* --- Spaltenbreiten: Uebergang beim Aufmachen, hart beim Ziehen ------------------------- */
.panel-grid {
  transition: grid-template-columns 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.panel-grid.is-dragging {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .panel-grid {
    transition: none;
  }
}

/* --- Werkzeug-Gruppe der Command-Bar --------------------------------------------------- *
 * Ein Rahmen, Haarlinien dazwischen: die drei Aktionen lesen sich als EIN Element und nicht
 * als drei weitere Knoepfe neben den Primaeraktionen. Die Trennlinie sitzt an den Knoepfen
 * (border-left ab dem zweiten), damit die Gruppe ohne Zusatz-Markup auskommt. */
.tool-btn {
  @apply inline-flex items-center gap-2 px-2.5 transition;
  color: var(--color-text-muted);
}
.tool-btn + .tool-btn {
  border-left: 1px solid var(--color-border);
}
.tool-btn:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* Laufender Vorgang: der Knopf traegt den Akzent, solange er arbeitet – „disabled + grau" sieht
   aus wie „geht nicht", nicht wie „laeuft gerade". */
.tool-btn.is-busy,
.tool-btn.is-busy:disabled {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  opacity: 1;
  cursor: progress;
}
/* Eingeschaltet (Breit-Modus): derselbe Akzent wie beim laufenden Vorgang, aber ohne dessen
   Cursor – das hier ist kein Zustand, der von selbst endet, sondern einer, den man zuruecknimmt.
   Der Hover-Fall steht ausdruecklich dabei: `.tool-btn:hover:not(:disabled)` hat die hoehere
   Spezifitaet und faerbte den eingeschalteten Knopf ausgerechnet dann zurueck, wenn der Zeiger
   darauf steht – also genau im Moment des Umschaltens. */
.tool-btn.is-on,
.tool-btn.is-on:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
/* Destruktiv erst beim Hover: in Ruhe ist sie so gedaempft wie ihre Nachbarn, weil Rot als
   Dauerzustand in der Kopfzeile eine Warnung waere, die niemanden mehr erreicht. */
.tool-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
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

/* --- „Du bist hier": der Baum zeigt die Ebene, die im Graphen offen ist ----------------- *
 * Drei Staerken statt einer Markierung, weil drei verschiedene Aussagen zu treffen sind und
 * sie gleichzeitig im Bild stehen: der WEG dorthin (trail, nur eingefaerbt), die EBENE selbst
 * (here, volle Markierung) und ihr INHALT (zone, Kante am linken Rand). Die Kante laeuft ueber
 * mehrere Zeilen durch und macht damit sichtbar, wo der Ausschnitt anfaengt und aufhoert –
 * eine Hervorhebung nur an einer Zeile beantwortet „wo bin ich", nicht „was sehe ich". */
.tree-li {
  position: relative;
}
.tree-zone::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 50%, transparent);
}
.tree-zone--head::before {
  width: 3px;
  background: var(--color-accent);
}

/* Flaeche statt `--color-accent-soft`: der Token ist im Light-Theme deckend und im Dark-Theme
   halbtransparent – die Markierung waere je nach Theme unterschiedlich stark. Ein color-mix auf
   dem Akzent traegt in beiden gleich weit. */
.tree-row.is-here {
  color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
}
.tree-row.is-here:hover {
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
}
.tree-row.is-here .tree-guide {
  border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
}
/* Der Weg dorthin bleibt Text – eine zweite Flaeche waere ein zweiter „hier". */
.tree-row.is-trail {
  color: color-mix(in srgb, var(--color-accent) 85%, var(--color-text));
}
.tree-row.is-trail .tree-guide {
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
}
/* Die Icons der markierten Zeilen tragen die Akzentfarbe voll – gedaempft (Tailwind opacity-70)
   verlieren sie im Light-Theme genau den Unterschied, der die Zeile ausmacht. */
.tree-row.is-here svg,
.tree-row.is-trail svg {
  opacity: 1;
}

/* Der Punkt an der offenen Ebene atmet, damit er sich vom ruhenden AI-Punkt der Klassenzeilen
   unterscheidet: der eine ist ein Zustand der Klasse, der andere sagt „hier stehst du gerade". */
.tree-here {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-accent);
  animation: tree-here-pulse 2.4s ease-in-out infinite;
}
@keyframes tree-here-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 40%, transparent);
  }
  50% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 8%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .tree-here {
    animation: none;
  }
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

/* Der Live-Chip des laufenden Imports und sein Puls sind mit dem Chip selbst entfallen – der Lauf
   steht jetzt in der Sidebar-Karte, die ihre eigene, ruhigere Auszeichnung traegt. */

/* Klick-Feedback der Aktions-Buttons: gedrueckt 0.96, federt in 150ms auf 1.0 zurueck. */
.action-btn {
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.action-btn:not(:disabled):active {
  transform: scale(0.96);
}

/* --- „Add code": der einzige Eingang fuer neuen Code ----------------------------------------
   Seit die Startseite nur noch Suche und Bilanz ist, kommt aller Quelltext hier herein. Der Knopf
   traegt deshalb mehr Gewicht als die uebrigen: Verlauf statt Flaeche, ein Schatten in der
   AKZENTFARBE statt eines grauen (er hebt das Element aus der Leiste, ohne einen zweiten Rahmen zu
   brauchen), und ein leichtes Anheben beim Hover. Keine Dauer-Animation: ein Knopf, der von selbst
   pulsiert, ist nach zwei Minuten Arbeit nur noch Unruhe. */
.add-btn {
  background-image: linear-gradient(
    135deg,
    var(--color-accent) 0%,
    color-mix(in srgb, var(--color-accent) 78%, var(--color-warning)) 100%
  );
  box-shadow:
    0 1px 2px rgb(0 0 0 / 12%),
    0 4px 12px -4px color-mix(in srgb, var(--color-accent) 65%, transparent);
  transition:
    transform 0.15s ease,
    box-shadow 0.2s ease,
    filter 0.15s ease;
}
.add-btn:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
  box-shadow:
    0 2px 4px rgb(0 0 0 / 14%),
    0 8px 20px -6px color-mix(in srgb, var(--color-accent) 75%, transparent);
}
.add-btn:not(:disabled):active {
  transform: translateY(0) scale(0.97);
}
/* Eine gezogene Datei ist eine Frage an genau diesen Knopf – er antwortet, indem er aufleuchtet.
   Der Ring liegt als `box-shadow` an, damit sich die Groesse nicht aendert und die Kopfzeile
   waehrend des Ziehens nicht umbricht. */
.add-btn.is-armed {
  transform: translateY(-1px);
  box-shadow:
    0 0 0 3px var(--color-accent-soft),
    0 8px 22px -6px color-mix(in srgb, var(--color-accent) 85%, transparent);
}

/* --- Drop-Overlay: die ganze Ansicht ist das Ziel ------------------------------------------
   Kein `backdrop-filter` (s. Stolperfalle „kein filter im Graphen"): das Overlay liegt ueber der
   gesamten Flaeche inklusive Canvas und waere damit die groesste Offscreen-Textur im Bild. Eine
   halbdeckende Flaeche tut dasselbe, ohne den Compositor zu zwingen. */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: color-mix(in srgb, var(--color-surface) 82%, transparent);
}
.drop-card {
  display: flex;
  max-width: 26rem;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border-radius: 1rem;
  border: 2px dashed var(--color-accent);
  background: var(--color-surface-2);
  padding: 1.75rem 2.5rem;
  text-align: center;
  box-shadow: 0 12px 40px -12px color-mix(in srgb, var(--color-accent) 60%, transparent);
}
.drop-icon {
  height: 2rem;
  width: 2rem;
  margin-bottom: 0.5rem;
  color: var(--color-accent);
}
.drop-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text);
}
.drop-sub {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
.dropfade-enter-active,
.dropfade-leave-active {
  transition: opacity 0.12s ease;
}
.dropfade-enter-from,
.dropfade-leave-to {
  opacity: 0;
}

/* --- Leerzustand der Klassenliste: dieselbe Einladung, nur ruhend --------------------------- */
.empty-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border-radius: 0.875rem;
  border: 1px dashed var(--color-border-strong);
  padding: 1.25rem 0.75rem;
}
.empty-icon {
  display: grid;
  height: 2.25rem;
  width: 2.25rem;
  place-items: center;
  border-radius: 999px;
  margin-bottom: 0.5rem;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.empty-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
}
.empty-sub {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
.empty-btn {
  margin-top: 0.75rem;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  padding: 0.4375rem 0.875rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-accent-contrast);
}
@media (prefers-reduced-motion: reduce) {
  .add-btn,
  .add-btn:hover {
    transition: none;
    transform: none;
  }
}
</style>
