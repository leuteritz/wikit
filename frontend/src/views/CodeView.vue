<script setup>
// Code-Analyse-Sektion: 3-Spalten-Layout (Package-Tree / Graph / Detail-Panel).
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
const queueNotice = ref('')
const search = ref('')
const showNew = ref(false)
const collapsed = reactive({}) // packagePfad -> true (eingeklappt)
const pendingDelete = ref(null)
const deleting = ref(false)
const pendingConflicts = ref(null) // FQCN-Liste vorhandener Klassen -> Ueberschreiben-Dialog
const confirming = ref(false)
const analyzingAll = ref(false) // Spinner fuer "Alle analysieren"
const pendingReset = ref(false) // Komplett-Reset-Dialog offen?
const resetting = ref(false) // Spinner waehrend des Komplett-Resets
const queueOpen = ref(false) // KI-Queue-Modal offen?

// Kompakte Queue-Anzeige im Header (loest den frueheren Queues-Tab ab). Liest den geteilten
// useJavaQueue-State; das Polling laeuft bereits ueber ensurePolling() (onMounted).
const FINISHED = ['done', 'done-with-errors', 'failed', 'cancelled']
const activeQueueCount = computed(() => allJobs.value.filter((j) => !FINISHED.includes(j.status)).length)
const finishedQueueCount = computed(() => allJobs.value.filter((j) => FINISHED.includes(j.status)).length)
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

let releasePolling = null
onMounted(async () => {
  releasePolling = ensurePolling()
  await fetchFiles()
  consumeHandoff()
  // Beim ersten Laden noch nichts vorhanden -> Neu-Panel aufklappen.
  if (!files.value.length) showNew.value = true
})
onUnmounted(() => releasePolling?.())

// --- Statistik (Header-Tags) ---
const classCount = computed(() => files.value.length)
const packageCount = computed(() => new Set(files.value.map((f) => f.package || '(default)')).size)

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

// Live-Fortschritt der Queue fuer die aktuell gewaehlte Klasse (Banner unter der Kopfzeile).
const selectedProgress = computed(() =>
  selectedFileId.value ? progressFor(selectedFileId.value) : null,
)

// Alle Auto-Call-Edges serverseitig neu berechnen + persistieren. Der Graph rendert aus dem
// geteilten useJavaGraph()-edges-Ref und aktualisiert sich nach recomputeEdges() automatisch.
async function onRecomputeEdges() {
  queueNotice.value = ''
  try {
    const res = await recomputeEdges()
    queueNotice.value = `${res?.count ?? 0} edge(s) recomputed.`
  } catch (e) {
    queueNotice.value = e.message
  }
}

// Alle noch nicht KI-analysierten Klassen als atomare Einheit (Methoden -> Klasse) einreihen –
// topologisch sortiert (Abhaengigkeiten zuerst). Live-Fortschritt zeigt die Queue-Anzeige; hier
// nur kurzes Inline-Feedback.
async function analyzeAll() {
  if (analyzingAll.value) return
  analyzingAll.value = true
  queueNotice.value = ''
  try {
    const res = await enqueueAllUnanalyzed({ userContext: userContext.value })
    const c = res?.queuedClasses ?? 0
    queueNotice.value = c
      ? `Queued: ${c} class(es) for full analysis (methods → summary).`
      : 'Everything already analyzed – nothing to queue.'
  } catch (e) {
    queueNotice.value = e.message
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
  if (res.overwritten?.length) parts.push(`${res.overwritten.length} overwritten.`)
  if (res.warnings?.length) parts.push(...res.warnings)
  queueNotice.value = parts.join(' ')
  source.value = ''
  filename.value = ''
  showNew.value = false
}

async function analyze() {
  if (!source.value.trim()) return
  queueNotice.value = ''
  try {
    const res = await analyzeBatch(source.value)
    // DB-Duplikate -> erst nachfragen, dann ggf. mit overwrite erneut senden.
    if (res.needsConfirm) {
      pendingConflicts.value = res.conflicts
      return
    }
    finishBatch(res)
  } catch {
    // Fehler steht in `error` (Composable) und wird im Template angezeigt.
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
    queueNotice.value = e.message
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
    queueNotice.value = ''
    pendingDelete.value = null
    pendingConflicts.value = null
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    showNew.value = true // Neu-Panel einladend wieder aufklappen
    pendingReset.value = false
  } catch (e) {
    queueNotice.value = e.message
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-3.5rem)] flex-col text-[var(--color-text)]">
    <!-- Kopfzeile -->
    <div class="shrink-0 px-5 pb-3 pt-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-bold tracking-tight text-[var(--color-text)]">Code Analysis</h1>
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span
              v-for="lang in LANGUAGES"
              :key="lang.id"
              class="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent-soft)] px-2 py-0.5 font-semibold text-[var(--color-accent)]"
            >
              <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />{{ lang.label }}
            </span>
            <span class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-medium text-[var(--color-text-muted)]">
              {{ classCount }} class(es)
            </span>
            <span class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-medium text-[var(--color-text-muted)]">
              {{ packageCount }} package(s)
            </span>
          </div>

          <!-- Globale Aktionen: einheitliche Button-Reihe (1 Icon + 1 Wort), links ausgerichtet.
               Gleicher Stil/Form, nur die Akzentfarbe unterscheidet die Aktionen. -->
          <div v-if="files.length" class="action-bar mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="action-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]"
              :disabled="analyzingAll"
              title="Queue every not-yet-analyzed class and method for AI analysis"
              @click="analyzeAll"
            >
              <Icon
                :icon="analyzingAll ? 'lucide:loader-2' : 'lucide:sparkles'"
                class="h-4 w-4"
                :class="analyzingAll ? 'animate-spin' : ''"
              />
              {{ analyzingAll ? 'Analyzing…' : 'Analyze' }}
            </button>
            <button
              type="button"
              class="action-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[var(--color-success)] hover:bg-[color-mix(in_srgb,var(--color-success)_20%,transparent)]"
              :disabled="recomputing"
              title="Recompute all class relationships (edges) – useful after bulk imports"
              @click="onRecomputeEdges"
            >
              <Icon :icon="recomputing ? 'lucide:loader-2' : 'lucide:git-branch'" class="h-4 w-4" :class="recomputing ? 'animate-spin' : ''" />
              Simulate
            </button>
            <button
              type="button"
              class="action-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_20%,transparent)]"
              :disabled="resetting"
              title="Permanently remove all analyzed classes, edges and AI summaries"
              @click="askReset"
            >
              <Icon icon="lucide:trash-2" class="h-4 w-4" />
              Reset
            </button>
            <button
              type="button"
              class="action-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] hover:bg-[color-mix(in_srgb,var(--color-text-muted)_18%,transparent)]"
              :disabled="!isWide || !panelsDirty"
              title="Restore the column widths to the default layout"
              @click="resetPanels"
            >
              <Icon icon="lucide:layout-grid" class="h-4 w-4" />
              Layout
            </button>
          </div>
        </div>

        <!-- Kompakte KI-Queue-Anzeige (loest den frueheren Queues-Tab ab) -> oeffnet das Queue-Modal.
             Immer sichtbar als Einstiegspunkt; zeigt den laufenden Job bzw. Warte-/Fertig-Zaehler. -->
        <button
          type="button"
          class="queue-chip group flex shrink-0 items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-offset)]"
          :title="runningQueueJob ? `Analyzing ${runningQueueJob.className}` : 'Open the AI analysis queue'"
          @click="queueOpen = true"
        >
          <span
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition"
            :class="activeQueueCount ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-surface-offset)] text-[var(--color-text-muted)]'"
          >
            <Icon
              :icon="runningQueueJob ? 'lucide:loader-2' : 'lucide:list-checks'"
              class="h-4 w-4"
              :class="runningQueueJob ? 'animate-spin' : ''"
            />
          </span>
          <span class="min-w-0">
            <span class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              AI Queue
              <Icon icon="lucide:chevron-right" class="h-3 w-3 opacity-0 transition group-hover:opacity-100" />
            </span>
            <!-- Laufender Job: Klassenname + Fortschritt -->
            <span v-if="runningQueueJob" class="mt-0.5 flex items-center gap-2">
              <span class="max-w-[11rem] truncate text-sm font-medium text-[var(--color-text)]">{{ runningQueueJob.className }}</span>
              <span class="shrink-0 tabular-nums text-xs text-[var(--color-accent)]">{{ runningQueueJob.done }}/{{ runningQueueJob.total }}</span>
            </span>
            <!-- Sonst: wartende, dann fertige, sonst Ruhezustand -->
            <span v-else-if="queuedQueueCount" class="mt-0.5 block text-sm font-medium text-[var(--color-text)]">{{ queuedQueueCount }} queued</span>
            <span v-else-if="finishedQueueCount" class="mt-0.5 flex items-center gap-1.5 text-sm font-medium text-[var(--color-success)]">
              <Icon icon="lucide:check-circle" class="h-3.5 w-3.5" />
              {{ finishedQueueCount }} done
            </span>
            <span v-else class="mt-0.5 block text-sm text-[var(--color-text-muted)]">Idle</span>
          </span>
          <!-- Mini-Fortschrittsbalken nur fuer den laufenden Job -->
          <span
            v-if="runningQueueJob && runningQueueJob.total"
            class="ml-1 hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)] sm:block"
          >
            <span
              class="block h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
              :style="{ width: Math.round(((runningQueueJob.done + runningQueueJob.failed) / runningQueueJob.total) * 100) + '%' }"
            />
          </span>
        </button>
      </div>

      <!-- Neu-Analyse als Modal (ausgeloest vom prominenten Sidebar-Button). -->
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

      <!-- Nicht-blockierendes Live-Banner fuer die gewaehlte Klasse -->
      <p v-if="queueNotice" class="mt-3 rounded-lg bg-[var(--color-surface-offset)] px-3 py-2 text-xs text-[var(--color-text-muted)]">{{ queueNotice }}</p>
      <div
        v-if="selectedProgress && (selectedProgress.status === 'running' || selectedProgress.status === 'queued')"
        class="mt-3 flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm text-[var(--color-accent)]"
      >
        <Icon icon="lucide:loader-2" class="h-4 w-4 shrink-0 animate-spin" />
        <span class="min-w-0 flex-1 truncate">
          Generating summary
          <template v-if="selectedProgress.current"> for <code class="font-mono">{{ selectedProgress.current.name }}()</code></template>
          …
        </span>
        <span v-if="selectedProgress.total > 1" class="shrink-0 tabular-nums opacity-80">{{ selectedProgress.done }}/{{ selectedProgress.total }}</span>
      </div>
      <p
        v-else-if="selectedProgress && selectedProgress.ollamaUnavailable"
        class="mt-3 rounded-lg px-3 py-2 text-xs text-[var(--color-warning)]"
        style="background-color: color-mix(in srgb, var(--color-warning) 15%, transparent)"
      >
        Ollama was unreachable – the existing Javadoc/fallback text was used.
      </p>
    </div>

    <!-- 3-Spalten-Layout (ab lg per Drag verschiebbar; darunter einspaltig gestapelt). -->
    <div
      class="grid min-h-0 flex-1 px-5 pb-5"
      :class="isWide ? '' : 'grid-cols-1 gap-4'"
      :style="isWide ? { gridTemplateColumns: gridTemplate } : null"
    >
      <!-- Spalte 1: Suche + Package-Tree -->
      <section class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div class="shrink-0 space-y-2 border-b border-[var(--color-border)] p-2">
          <!-- Prominenter Einstieg: neue .java-Quellen analysieren (oeffnet das Modal). -->
          <button
            type="button"
            class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)]"
            @click="showNew = true"
          >
            <Icon icon="lucide:plus" class="h-4 w-4" />
            Analyze code
          </button>
          <div class="relative">
            <Icon icon="lucide:search" class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              v-model="search"
              type="text"
              placeholder="Search classes…"
              class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5 pl-8 pr-7 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
            <button
              v-if="search"
              type="button"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              @click="search = ''"
            >
              <Icon icon="lucide:x" class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <ul class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <li v-for="row in rows" :key="row.id">
            <!-- Package-Ordner -->
            <button
              v-if="row.kind === 'folder'"
              type="button"
              class="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)]"
              :style="{ paddingLeft: row.depth * 12 + 6 + 'px' }"
              @click="toggleFolder(row.fullPath)"
            >
              <Icon icon="lucide:chevron-down" class="h-3 w-3 shrink-0 transition-transform" :class="row.open ? '' : '-rotate-90'" />
              <span class="min-w-0 flex-1 truncate font-mono normal-case tracking-normal">{{ row.label }}</span>
              <span class="shrink-0 text-[10px] tabular-nums opacity-70">{{ row.count }}</span>
            </button>

            <!-- Klasse -->
            <div v-else class="group relative">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md py-1.5 pr-8 text-left transition"
                :style="{ paddingLeft: row.depth * 12 + 10 + 'px' }"
                :class="selectedFileId === row.file.id ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                @click="selectFile(row.file.id)"
              >
                <Icon icon="lucide:braces" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                <span class="min-w-0 flex-1 truncate text-sm">
                  <Icon v-if="row.file.description" icon="lucide:sparkles" class="mr-0.5 inline-block h-3.5 w-3.5 align-text-bottom text-[var(--color-accent)]" title="AI-analyzed" /><template v-for="(p, i) in hl(row.file.class_name)" :key="i"><mark v-if="p.m" class="rounded-sm bg-transparent px-0 font-semibold text-[var(--color-accent)]">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
                </span>
                <span
                  v-if="progressFor(row.file.id)"
                  class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition group-hover:opacity-0"
                  :class="progressFor(row.file.id).status === 'running'
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'text-[var(--color-success)]'"
                  style="background-color: color-mix(in srgb, var(--color-success) 14%, transparent)"
                >
                  {{ progressFor(row.file.id).done }}/{{ progressFor(row.file.id).total }}
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
          <li v-if="!rows.length" class="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
            {{ searching ? 'No results.' : 'No classes analyzed yet.' }}
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
          class="grid h-full place-items-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-6 text-center text-sm text-[var(--color-text-muted)]"
        >
          Select a class to inspect – from the list or as a node in the graph.
        </div>
      </div>
    </div>

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

    <!-- KI-Queue-Modal (breit/langgezogen): aus der Header-Anzeige geoeffnet. -->
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
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.action-btn:not(:disabled):active {
  transform: scale(0.96);
}
</style>
