<script setup>
// Code-Intelligence-Analyzer: 3-Spalten-Layout.
//  Spalte 1: Upload (Datei/CodeMirror) + Projekt-Kontext + Liste analysierter Klassen (Queue-Badge)
//  Spalte 2: Package-Dependency-Graph (Vue Flow)
//  Spalte 3: vollstaendige Klassen-Doku
import { ref, onMounted, computed } from 'vue'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { WIKI_TITLE } from '../config.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import JavaDependencyGraph from '../components/java/JavaDependencyGraph.vue'
import JavaClassDetail from '../components/java/JavaClassDetail.vue'

const { files, fetchFiles, analyzeCode, analyzing, error, userContext } = useJavaAnalyzer()
const { enqueueClass, progressFor } = useJavaQueue()

const source = ref('')
const filename = ref('')
const selectedFileId = ref(null)

onMounted(fetchFiles)

const sortedFiles = computed(() =>
  [...files.value].sort((a, b) => a.class_name.localeCompare(b.class_name)),
)

async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  filename.value = f.name
  source.value = await f.text()
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
  } catch {
    // Fehler steht in `error` (Composable) und wird im Template angezeigt.
  }
}

function selectFile(id) {
  selectedFileId.value = id
}
async function onDetailClose(payload) {
  if (payload?.deleted) await fetchFiles()
  selectedFileId.value = null
}
</script>

<template>
  <div class="flex h-[calc(100vh-3.5rem)] flex-col">
    <!-- Kopfzeile -->
    <div class="shrink-0 px-5 pb-3 pt-5">
      <h1 class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Code-Intelligence
      </h1>
      <p class="text-sm text-slate-500 dark:text-slate-400">
        Java lokal geparst · Package-Graph · KI-Dokumentation pro Klasse &amp; Methode in {{ WIKI_TITLE }}.
      </p>
    </div>

    <!-- 3-Spalten-Layout -->
    <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 px-5 pb-5 lg:grid-cols-[300px_1fr_400px]">
      <!-- Spalte 1: Upload + Klassenliste -->
      <div class="flex min-h-0 flex-col gap-4">
        <section class="shrink-0 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Neue Analyse</h2>
            <label class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M5 11l7-7 7 7M5 20h14" /></svg>
              .java
              <input type="file" accept=".java" class="hidden" @change="onFile" />
            </label>
          </div>
          <p v-if="filename" class="mb-2 truncate text-xs text-slate-500 dark:text-slate-400">{{ filename }}</p>

          <div class="mb-2 h-48">
            <JavaCodeEditor v-model="source" />
          </div>

          <label class="mb-2 block">
            <span class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Projekt-Kontext (optional)</span>
            <textarea
              v-model="userContext"
              spellcheck="false"
              rows="2"
              placeholder="z. B. Windchill-Hintergrund, Modulzweck… – fließt in jeden KI-Prompt ein."
              class="w-full resize-y rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
          </label>

          <p v-if="error" class="mb-2 text-xs text-rose-500">{{ error }}</p>

          <button
            type="button"
            class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            :disabled="analyzing || !source.trim()"
            @click="analyze"
          >
            <svg v-if="analyzing" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
            {{ analyzing ? 'Analysiere…' : 'Analysieren' }}
          </button>
        </section>

        <!-- Klassenliste -->
        <section class="flex min-h-0 flex-1 flex-col rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <h2 class="shrink-0 border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Klassen ({{ sortedFiles.length }})
          </h2>
          <ul class="min-h-0 flex-1 overflow-y-auto p-2">
            <li v-for="f in sortedFiles" :key="f.id">
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition"
                :class="selectedFileId === f.id ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-slate-50 dark:hover:bg-slate-800'"
                @click="selectFile(f.id)"
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    <span v-if="f.description" title="KI-analysiert">✨ </span>{{ f.class_name }}
                  </div>
                  <div class="truncate font-mono text-[10px] text-slate-400">{{ f.package || '(default)' }}</div>
                </div>
                <span
                  v-if="progressFor(f.id)"
                  class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="progressFor(f.id).status === 'running'
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'"
                >
                  {{ progressFor(f.id).done }}/{{ progressFor(f.id).total }}
                </span>
              </button>
            </li>
            <li v-if="!sortedFiles.length" class="px-3 py-6 text-center text-xs text-slate-400">
              Noch keine Klassen analysiert.
            </li>
          </ul>
        </section>
      </div>

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
          class="grid h-full place-items-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-6 text-center text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900/40"
        >
          Wähle eine Klasse – links in der Liste oder als Knoten im Graphen.
        </div>
      </div>
    </div>
  </div>
</template>
