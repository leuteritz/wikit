<script setup>
// Code-Analyse-Sektion: 3-Spalten-Layout (Package-Tree / Graph / Detail-Panel).
//  Spalte 1: Suche + Package-Baum aller geladenen Klassen (Datei-Explorer-Optik)
//  Spalte 2: Klassen-Abhaengigkeitsgraph (Vue Flow + dagre)
//  Spalte 3: vollstaendige Klassen-Doku + KI-Zusammenfassungen
// Datenhaltung via useJavaAnalyzer (Dateien/CRUD) + useJavaQueue (KI-Queue, Polling).
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { buildPackageTree, countClasses, filterClasses, LANGUAGES } from '../composables/useCodeAnalysis.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import JavaDependencyGraph from '../components/java/JavaDependencyGraph.vue'
import JavaClassDetail from '../components/java/JavaClassDetail.vue'
import { Icon } from '../lib/icons.js'

const { files, fetchFiles, analyzeCode, analyzing, error, userContext, lastFileId, deleteFile } =
  useJavaAnalyzer()
const { enqueueClass, enqueueMethods, queueClass, cancelJob, progressFor, ensurePolling } =
  useJavaQueue()

const source = ref('')
const filename = ref('')
const selectedFileId = ref(null)
const queueNotice = ref('')
const search = ref('')
const showNew = ref(false)
const collapsed = reactive({}) // packagePfad -> true (eingeklappt)
const pendingDelete = ref(null)
const deleting = ref(false)

let releasePolling = null
onMounted(async () => {
  releasePolling = ensurePolling()
  await fetchFiles()
  // Vorauswahl aus der Landing-Analyse uebernehmen (danach zuruecksetzen).
  if (lastFileId.value != null) {
    selectedFileId.value = lastFileId.value
    lastFileId.value = null
  }
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

async function generateClass() {
  if (!selectedFileId.value) return
  queueNotice.value = ''
  try {
    await queueClass(selectedFileId.value, { userContext: userContext.value })
  } catch (e) {
    queueNotice.value = e.message
  }
}

async function generateAllMethods() {
  if (!selectedFileId.value) return
  queueNotice.value = ''
  try {
    await enqueueMethods(selectedFileId.value, { userContext: userContext.value })
  } catch (e) {
    queueNotice.value = e.message
  }
}

async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  filename.value = f.name
  source.value = await f.text()
  showNew.value = true
}

async function analyze() {
  if (!source.value.trim()) return
  try {
    const result = await analyzeCode(source.value, filename.value)
    selectedFileId.value = result.file.id
    // KI-Queue automatisch starten: alle Methoden sequenziell beschriften.
    enqueueClass(result.file, { userContext: userContext.value })
    source.value = ''
    filename.value = ''
    showNew.value = false
  } catch {
    // Fehler steht in `error` (Composable) und wird im Template angezeigt.
  }
}

function selectFile(id) {
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
    await Promise.allSettled([cancelJob(file.id, 'class'), cancelJob(file.id, 'methods')])
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
</script>

<template>
  <div class="flex h-[calc(100vh-3.5rem)] flex-col text-[var(--color-text)]">
    <!-- Kopfzeile -->
    <div class="shrink-0 px-5 pb-3 pt-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
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
              {{ classCount }} Klasse(n)
            </span>
            <span class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-medium text-[var(--color-text-muted)]">
              {{ packageCount }} Package(s)
            </span>
          </div>
        </div>

        <!-- Aktionen + Upload-Pill -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!selectedFileId"
            :title="selectedFileId ? '' : 'Erst eine Klasse auswählen'"
            @click="generateClass"
          >
            <Icon icon="lucide:sparkles" class="h-4 w-4" />
            Klasse zusammenfassen
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent)] transition hover:bg-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!selectedFileId"
            :title="selectedFileId ? '' : 'Erst eine Klasse auswählen'"
            @click="generateAllMethods"
          >
            <Icon icon="lucide:list" class="h-4 w-4" />
            Alle Methoden
          </button>
          <RouterLink
            to="/code/queues"
            class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)]"
          >
            <Icon icon="lucide:list-checks" class="h-4 w-4" />
            Queues
          </RouterLink>
          <!-- Upload-/Analyse-Pill -->
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)]"
            :class="showNew ? 'ring-2 ring-[var(--color-accent-soft)]' : ''"
            @click="showNew = !showNew"
          >
            <span>Code analysieren</span>
            <Icon icon="lucide:upload" class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Aufklappbares Neu-Analyse-Panel -->
      <Transition name="slide">
        <section
          v-if="showNew"
          class="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
        >
          <div class="grid gap-3 lg:grid-cols-[1fr_280px]">
            <div class="min-w-0">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Java-Quelltext</h2>
                <label class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)]">
                  <Icon icon="lucide:upload" class="h-3.5 w-3.5" />
                  <span v-if="filename" class="max-w-[10rem] truncate">{{ filename }}</span>
                  <span v-else>.java-Datei</span>
                  <input type="file" accept=".java" class="hidden" @change="onFile" />
                </label>
              </div>
              <div class="h-44">
                <JavaCodeEditor v-model="source" />
              </div>
            </div>
            <div class="flex flex-col">
              <label class="mb-2 block">
                <span class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Projekt-Kontext (optional)</span>
                <textarea
                  v-model="userContext"
                  spellcheck="false"
                  rows="4"
                  placeholder="z. B. Windchill-Hintergrund, Modulzweck… – fließt in jeden KI-Prompt ein."
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
                {{ analyzing ? 'Analysiere…' : 'Analysieren' }}
              </button>
            </div>
          </div>
        </section>
      </Transition>

      <!-- Nicht-blockierendes Live-Banner fuer die gewaehlte Klasse -->
      <p v-if="queueNotice" class="mt-3 rounded-lg bg-[var(--color-surface-offset)] px-3 py-2 text-xs text-[var(--color-danger)]">{{ queueNotice }}</p>
      <div
        v-if="selectedProgress && (selectedProgress.status === 'running' || selectedProgress.status === 'queued')"
        class="mt-3 flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm text-[var(--color-accent)]"
      >
        <Icon icon="lucide:loader-2" class="h-4 w-4 shrink-0 animate-spin" />
        <span class="min-w-0 flex-1 truncate">
          Generiere Zusammenfassung
          <template v-if="selectedProgress.current"> für <code class="font-mono">{{ selectedProgress.current.name }}()</code></template>
          …
        </span>
        <span v-if="selectedProgress.total > 1" class="shrink-0 tabular-nums opacity-80">{{ selectedProgress.done }}/{{ selectedProgress.total }}</span>
      </div>
      <p
        v-else-if="selectedProgress && selectedProgress.ollamaUnavailable"
        class="mt-3 rounded-lg px-3 py-2 text-xs text-[var(--color-warning)]"
        style="background-color: color-mix(in srgb, var(--color-warning) 15%, transparent)"
      >
        Ollama war nicht erreichbar – es wurde der vorhandene Javadoc-/Fallback-Text verwendet.
      </p>
    </div>

    <!-- 3-Spalten-Layout -->
    <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 px-5 pb-5 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
      <!-- Spalte 1: Suche + Package-Tree -->
      <section class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div class="shrink-0 border-b border-[var(--color-border)] p-2">
          <div class="relative">
            <Icon icon="lucide:search" class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              v-model="search"
              type="text"
              placeholder="Klassen suchen…"
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
                  <Icon v-if="row.file.description" icon="lucide:sparkles" class="mr-0.5 inline-block h-3.5 w-3.5 align-text-bottom text-[var(--color-accent)]" title="KI-analysiert" /><template v-for="(p, i) in hl(row.file.class_name)" :key="i"><mark v-if="p.m" class="rounded-sm bg-transparent px-0 font-semibold text-[var(--color-accent)]">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template>
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
                title="Klasse löschen"
                :aria-label="`Klasse ${row.file.class_name} löschen`"
                @click.stop="askDelete(row.file)"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
              </button>
            </div>
          </li>
          <li v-if="!rows.length" class="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
            {{ searching ? 'Keine Treffer.' : 'Noch keine Klassen analysiert.' }}
          </li>
        </ul>
      </section>

      <!-- Spalte 2: Graph -->
      <div class="min-h-[55vh] lg:min-h-0">
        <JavaDependencyGraph :files="files" :selected-id="selectedFileId" @select="selectFile" />
      </div>

      <!-- Spalte 3: Detail -->
      <div class="min-h-0">
        <JavaClassDetail
          v-if="selectedFileId"
          :key="selectedFileId"
          :file-id="selectedFileId"
          @close="onDetailClose"
        />
        <div
          v-else
          class="grid h-full place-items-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-6 text-center text-sm text-[var(--color-text-muted)]"
        >
          Select a class to inspect – links in der Liste oder als Knoten im Graphen.
        </div>
      </div>
    </div>

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
              <h3 class="truncate font-semibold text-[var(--color-text)]">Klasse löschen?</h3>
              <p class="truncate font-mono text-xs text-[var(--color-text-muted)]">{{ pendingDelete.class_name }}</p>
            </div>
          </div>
          <p class="mb-4 text-sm text-[var(--color-text-muted)]">
            Alle Verknüpfungen im Graph werden entfernt. Ein eventuell verknüpfter Wiki-Artikel bleibt erhalten.
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] disabled:opacity-50"
              :disabled="deleting"
              @click="cancelDelete"
            >
              Abbrechen
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-danger)] px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
              :disabled="deleting"
              @click="confirmDelete"
            >
              <Icon v-if="deleting" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
              {{ deleting ? 'Lösche…' : 'Löschen' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Funktionale Transition fuers Neu-Analyse-Panel (kein dekoratives Spielwerk). */
.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
