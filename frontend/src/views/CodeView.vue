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
import { useJavaQueue, isFinishedStatus } from '../composables/useJavaQueue.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { buildPackageTree, countClasses, filterClasses, LANGUAGES } from '../composables/useCodeAnalysis.js'
import { usePanelResize } from '../composables/usePanelResize.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import JavaDependencyGraph from '../components/java/JavaDependencyGraph.vue'
import JavaClassDetail from '../components/java/JavaClassDetail.vue'
import JavaQueueModal from '../components/java/JavaQueueModal.vue'
import { Icon } from '../lib/icons.js'
import { detectJavaClasses } from '../lib/javaDetect.js'

const { files, fetchFiles, analyzeBatch, analyzing, error, userContext, lastFileId, lastTargetLine, lastTargetEndLine, deleteFile, resetAll } =
  useJavaAnalyzer()
const { allJobs, enqueueClass, enqueueAllUnanalyzed, cancelJob, cancelAllJobs, progressFor, ensurePolling } = useJavaQueue()
const { recomputeEdges, recomputing, resetEdges } = useJavaGraph()
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

// --- Fluechtige Rueckmeldungen als Toast (unten rechts) ------------------------------------
// Frueher schoben diese Meldungen als Banner das gesamte Grid nach unten. Als schwebender
// Toast bleibt die Arbeitsflaeche geometrisch stabil; er verschwindet von selbst.
const notice = ref(null) // { text, kind: 'info' | 'error' }
let noticeTimer = null
function setNotice(text, kind = 'info') {
  clearTimeout(noticeTimer)
  if (!text) {
    notice.value = null
    return
  }
  notice.value = { text, kind }
  noticeTimer = setTimeout(() => (notice.value = null), 8000)
}
function dismissNotice() {
  clearTimeout(noticeTimer)
  notice.value = null
}

// Kompakte Queue-Anzeige in der Command-Bar. Liest den geteilten useJavaQueue-State;
// das Polling laeuft bereits ueber ensurePolling() (onMounted).
const finishedQueueCount = computed(() => allJobs.value.filter((j) => isFinishedStatus(j.status)).length)
const runningQueueJob = computed(() => allJobs.value.find((j) => j.status === 'running') || null)
const queuedQueueCount = computed(() => allJobs.value.filter((j) => j.status === 'queued').length)

// Klasse aus dem Queue-Modal heraus oeffnen: direkt auswaehlen + Modal schliessen (wir sind im View).
function onQueueSelect(fileId) {
  selectFile(fileId)
  queueOpen.value = false
}

// Live-Vorschau der im Editor erkannten Klassen (rein clientseitig, nicht autoritativ).
const detectedClasses = computed(() => detectJavaClasses(source.value))

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

// ESC schliesst das Overflow-Menue (Modals bringen ihre eigenen Handler mit).
function onKeydown(e) {
  if (e.key === 'Escape' && menuOpen.value) menuOpen.value = false
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
  clearTimeout(noticeTimer)
})

// --- Metriken (Command-Bar) ---
const classCount = computed(() => files.value.length)
const packageCount = computed(() => new Set(files.value.map((f) => f.package || '(default)')).size)
const analyzedCount = computed(() => files.value.filter((f) => f.description).length)

// --- Package-Baum (gefiltert) -> flache Zeilenliste fuer iteratives Rendern ---
const filteredFiles = computed(() => filterClasses(files.value, search.value))
const tree = computed(() => buildPackageTree(filteredFiles.value))
const searching = computed(() => search.value.trim().length > 0)

function flatten(nodes, depth, out) {
  for (const n of nodes) {
    const open = searching.value ? true : !collapsed[n.fullPath]
    out.push({ kind: 'folder', id: n.id, label: n.label, fullPath: n.fullPath, depth, count: countClasses(n), open })
    if (open) {
      flatten(n.children, depth + 1, out)
      for (const f of n.classes) out.push({ kind: 'class', id: `c:${f.id}`, file: f, depth: depth + 1 })
    }
  }
  return out
}
const rows = computed(() => flatten(tree.value, 0, []))

function toggleFolder(path) {
  collapsed[path] = !collapsed[path]
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

// Erfolgreichen Batch abschliessen: erste Klasse vorwaehlen, je Klasse KI-Queue starten,
// Warnungen anzeigen, Panel zuruecksetzen.
function finishBatch(res) {
  if (res.saved?.length) {
    selectedFileId.value = res.saved[0].id
    for (const f of res.saved) enqueueClass(f, { userContext: userContext.value })
  }
  const parts = []
  if (res.saved?.length) parts.push(`${res.saved.length} class(es) analyzed.`)
  if (res.overwritten?.length) parts.push(`${res.overwritten.length} overwritten.`)
  if (res.warnings?.length) parts.push(...res.warnings)
  setNotice(parts.join(' '), res.warnings?.length ? 'error' : 'info')
  source.value = ''
  filename.value = ''
  showNew.value = false
}

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
  try {
    const res = await analyzeBatch(source.value, { overwrite: true })
    pendingConflicts.value = null
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
  selectedFileId.value = id
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
  try {
    await cancelAllJobs() // laufende/abgeschlossene KI-Jobs stoppen + leeren
    await resetAll() // alle Klassen aus der DB loeschen, Dateiliste -> []
    resetEdges() // Frontend-Kanten-Spiegel sofort leeren
    // Lokalen View-State auf "frisch geoeffnet" zuruecksetzen.
    selectedFileId.value = null
    activeTargetLine.value = null
    activeTargetEndLine.value = null
    source.value = ''
    filename.value = ''
    search.value = ''
    dismissNotice()
    pendingDelete.value = null
    pendingConflicts.value = null
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    showNew.value = true // Neu-Panel einladend wieder aufklappen
    pendingReset.value = false
  } catch (e) {
    setNotice(e.message, 'error')
  } finally {
    resetting.value = false
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
          <h1 class="truncate font-mono text-[15px] font-semibold tracking-tight">Code Analysis</h1>
        </div>

        <!-- Live-Metriken: monospace + gedaempft. Zahlen tragen die Information, nicht die Farbe. -->
        <div v-if="files.length" class="hidden items-center gap-2.5 font-mono text-[11px] text-[var(--color-text-muted)] md:flex">
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
          <!-- AI-Queue: Chip mit Live-Status; nur bei Aktivitaet farbig, sonst dezent. -->
          <button
            type="button"
            class="action-btn inline-flex h-9 items-center gap-2 rounded-lg border px-2.5 text-[13px] font-medium transition"
            :class="runningQueueJob || queuedQueueCount
              ? 'border-[color-mix(in_srgb,var(--color-lavender)_40%,transparent)] bg-[var(--color-lavender-soft)] text-[var(--color-lavender)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
            :title="runningQueueJob ? `Analyzing ${runningQueueJob.className}` : 'Open the AI analysis queue'"
            @click="queueOpen = true"
          >
            <Icon
              :icon="runningQueueJob ? 'lucide:loader-2' : 'lucide:list-checks'"
              class="h-4 w-4 shrink-0"
              :class="runningQueueJob ? 'animate-spin' : ''"
            />
            <span class="hidden sm:inline">AI Queue</span>
            <span v-if="runningQueueJob" class="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
              <span class="max-w-[10rem] truncate opacity-90">{{ runningQueueJob.className }}</span>
              <span class="shrink-0 tabular-nums opacity-70">{{ runningQueueJob.done }}/{{ runningQueueJob.total }}</span>
            </span>
            <span v-else-if="queuedQueueCount" class="rounded-full bg-[color-mix(in_srgb,var(--color-lavender)_22%,transparent)] px-1.5 font-mono text-[11px] tabular-nums">
              {{ queuedQueueCount }}
            </span>
            <span v-else-if="finishedQueueCount" class="font-mono text-[11px] tabular-nums opacity-70">{{ finishedQueueCount }}</span>
          </button>

          <!-- KI-Sammellauf ueber alle noch nicht analysierten Klassen. -->
          <button
            v-if="files.length"
            type="button"
            class="action-btn inline-flex h-9 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-accent-soft)] px-2.5 text-[13px] font-semibold text-[var(--color-accent)] transition hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
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
            class="action-btn inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[13px] font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)]"
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
          @click.self="analyzing ? null : (showNew = false)"
        >
          <section
            class="w-full max-w-3xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 shadow-xl"
          >
            <div class="mb-3 flex items-center justify-between gap-2">
              <h2 class="flex items-center gap-2 text-lg font-bold text-[var(--color-text)]">
                <Icon icon="lucide:sparkles" class="h-5 w-5 text-[var(--color-accent)]" />
                Analyze code
              </h2>
              <button
                type="button"
                class="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40"
                :disabled="analyzing"
                title="Close"
                @click="showNew = false"
              >
                <Icon icon="lucide:x" class="h-5 w-5" />
              </button>
            </div>
            <div class="grid gap-3 lg:grid-cols-[1fr_280px]">
              <div class="min-w-0">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <!-- Eingabemodus: Code einfuegen vs. .java-Datei(en) hochladen (beide fuellen `source`). -->
                  <div class="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition"
                      :class="inputMode === 'paste' ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
                      @click="inputMode = 'paste'"
                    >
                      <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                      Paste code
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition"
                      :class="inputMode === 'file' ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
                      @click="inputMode = 'file'"
                    >
                      <Icon icon="lucide:upload" class="h-3.5 w-3.5" />
                      Upload file
                    </button>
                  </div>
                  <label
                    v-if="inputMode === 'file'"
                    class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)]"
                  >
                    <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                    <span v-if="filename" class="max-w-[10rem] truncate">{{ filename }}</span>
                    <span v-else>Choose .java file(s)</span>
                    <input type="file" accept=".java" multiple class="hidden" @change="onFile" />
                  </label>
                </div>
                <div class="h-44">
                  <JavaCodeEditor v-model="source" />
                </div>
                <!-- Live-Vorschau der erkannten Klassen (Name · Package), bevor gespeichert wird. -->
                <div v-if="detectedClasses.length" class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span class="text-[11px] font-medium text-[var(--color-text-muted)]">
                    {{ detectedClasses.length }} class(es) detected:
                  </span>
                  <span
                    v-for="c in detectedClasses"
                    :key="(c.package || '') + '.' + c.class_name"
                    class="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
                    :title="c.package ? c.package + '.' + c.class_name : c.class_name"
                  >
                    <Icon icon="lucide:box" class="h-3 w-3 shrink-0" />
                    <span class="font-mono"><span v-if="c.package" class="opacity-70">{{ c.package }}·</span>{{ c.class_name }}</span>
                  </span>
                </div>
              </div>
              <div class="flex flex-col">
                <label class="mb-2 block">
                  <span class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Project context (optional)</span>
                  <textarea
                    v-model="userContext"
                    spellcheck="false"
                    rows="4"
                    placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
                    class="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                  />
                </label>
                <p v-if="error" class="mb-2 text-xs text-[var(--color-danger)]">{{ error }}</p>
                <button
                  type="button"
                  class="mt-auto inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                  :disabled="analyzing || !source.trim()"
                  @click="analyze"
                >
                  <Icon v-if="analyzing" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
                  {{ analyzing ? 'Analyzing…' : 'Analyze' }}
                </button>
              </div>
            </div>
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
          <p v-if="searching" class="mt-1.5 px-1 font-mono text-[10px] text-[var(--color-text-muted)]">
            {{ filteredFiles.length }} of {{ classCount }} match
          </p>
        </div>

        <ul class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <li v-for="row in rows" :key="row.id">
            <!-- Package-Ordner -->
            <button
              v-if="row.kind === 'folder'"
              type="button"
              class="tree-row group/f flex w-full items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-left text-[11px] font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              @click="toggleFolder(row.fullPath)"
            >
              <span v-for="d in row.depth" :key="d" class="tree-guide" />
              <Icon icon="lucide:chevron-down" class="h-3 w-3 shrink-0 opacity-70 transition-transform" :class="row.open ? '' : '-rotate-90'" />
              <Icon icon="lucide:package" class="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span class="min-w-0 flex-1 truncate font-mono">{{ row.label }}</span>
              <span class="shrink-0 font-mono text-[10px] tabular-nums opacity-60">{{ row.count }}</span>
            </button>

            <!-- Klasse -->
            <div v-else class="group relative">
              <button
                type="button"
                class="tree-row flex w-full items-center gap-1.5 rounded-md py-1.5 pl-1 pr-8 text-left transition"
                :class="selectedFileId === row.file.id
                  ? 'is-selected bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-surface-offset)]'"
                @click="selectFile(row.file.id)"
              >
                <span v-for="d in row.depth" :key="d" class="tree-guide" />
                <Icon
                  icon="lucide:braces"
                  class="h-3.5 w-3.5 shrink-0"
                  :class="selectedFileId === row.file.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
                />
                <span class="min-w-0 flex-1 truncate text-[13px]" :class="selectedFileId === row.file.id ? 'font-semibold' : ''">
                  <template v-for="(p, i) in hl(row.file.class_name)" :key="i"><mark v-if="p.m" class="rounded-sm bg-transparent px-0 font-semibold text-[var(--color-accent)]">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
                </span>
                <!-- Status rechts: laufende Queue schlaegt den ruhenden AI-Punkt. -->
                <span
                  v-if="progressFor(row.file.id)"
                  class="shrink-0 rounded-full px-1.5 font-mono text-[10px] font-semibold tabular-nums transition group-hover:opacity-0"
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
                  v-if="row.file.methods?.length"
                  class="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-60 transition group-hover:opacity-0"
                >
                  {{ row.file.methods.length }}
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
        <JavaDependencyGraph :files="files" :selected-id="selectedFileId" @select="selectFile" />
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
      <div class="min-h-0">
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

    <!-- Toast (unten rechts): kurze Rueckmeldungen, ohne das Grid zu verschieben. -->
    <Teleport to="body">
      <Transition name="toast">
        <div
          v-if="notice"
          class="fixed bottom-5 right-5 z-[70] flex max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl backdrop-blur"
          :class="notice.kind === 'error'
            ? 'border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_14%,var(--color-surface-2))] text-[var(--color-danger)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]'"
          role="status"
        >
          <Icon
            :icon="notice.kind === 'error' ? 'lucide:alert-triangle' : 'lucide:check-circle'"
            class="mt-px h-4 w-4 shrink-0"
            :class="notice.kind === 'error' ? '' : 'text-[var(--color-success)]'"
          />
          <span class="min-w-0 flex-1">{{ notice.text }}</span>
          <button
            type="button"
            class="-mr-1 shrink-0 rounded p-0.5 opacity-60 transition hover:opacity-100"
            title="Dismiss"
            aria-label="Dismiss"
            @click="dismissNotice"
          >
            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
          </button>
        </div>
      </Transition>
    </Teleport>

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
          <p class="mb-4 text-sm text-[var(--color-text-muted)]">
            All analyzed classes, edges and AI summaries will be
            <span class="font-semibold text-[var(--color-text)]">permanently deleted</span>.
            Linked wiki articles are kept.
          </p>
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

/* Toast: schiebt sich von rechts ein. */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}

/* Eintraege des Overflow-Menues (gleiche Geometrie, Farbe unterscheidet nur die Gefahr). */
.menu-item {
  @apply flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition;
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

/* Klick-Feedback der Aktions-Buttons: gedrueckt 0.96, federt in 150ms auf 1.0 zurueck. */
.action-btn {
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.action-btn:not(:disabled):active {
  transform: scale(0.96);
}
</style>
