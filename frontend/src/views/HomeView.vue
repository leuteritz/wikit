<script setup>
// Code-first Landing: eine zentrierte „+ Java hochladen"-Hero-Karte.
// Drag&Drop ODER Datei-Picker ODER Paste-Editor -> Analysieren -> Sprung in den Analyzer.
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { WIKI_TITLE } from '../config.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'

const router = useRouter()
const { files, fetchFiles, analyzeCode, analyzing, error, userContext, lastFileId } = useJavaAnalyzer()
const { enqueueClass } = useJavaQueue()

const source = ref('')
const filename = ref('')
const dragging = ref(false)
const showPaste = ref(false)
const showContext = ref(false)

onMounted(fetchFiles)

const recent = computed(() => [...files.value].slice(0, 6))

async function readJavaFile(file) {
  if (!file) return
  filename.value = file.name
  source.value = await file.text()
  showPaste.value = true
}

async function onFile(e) {
  await readJavaFile(e.target.files?.[0])
}

function onDrop(e) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file && file.name.endsWith('.java')) readJavaFile(file)
}

async function analyze() {
  if (!source.value.trim()) return
  try {
    const result = await analyzeCode(source.value, filename.value)
    enqueueClass(result.file, { userContext: userContext.value })
    lastFileId.value = result.file.id
    router.push('/code')
  } catch {
    // Fehler steht in `error` (Composable) und wird unten angezeigt.
  }
}

function openClass(id) {
  lastFileId.value = id
  router.push('/code')
}
</script>

<template>
  <div class="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-2xl flex-col items-center justify-center px-5 py-12">
    <!-- Hero-Text -->
    <div class="mb-7 text-center">
      <h1 class="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
        Code verstehen mit {{ WIKI_TITLE }}
      </h1>
      <p class="mx-auto mt-2 max-w-md text-slate-500 dark:text-slate-400">
        Java-Klasse hochladen – lokal geparst, als Package-Graph dargestellt und pro Methode KI-dokumentiert.
      </p>
    </div>

    <!-- Upload-Karte -->
    <div class="w-full">
      <div
        class="group relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition"
        :class="dragging
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-slate-300 bg-white hover:border-[var(--color-accent)] dark:border-slate-700 dark:bg-slate-900'"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <label class="flex cursor-pointer flex-col items-center">
          <span class="grid h-16 w-16 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] transition group-hover:scale-105">
            <svg class="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          <span class="mt-4 text-base font-semibold text-slate-800 dark:text-slate-100">
            <span class="text-[var(--color-accent)]">.java</span> ablegen oder auswählen
          </span>
          <span class="mt-1 text-xs text-slate-400">Drag &amp; Drop oder Klick · alles bleibt lokal</span>
          <input type="file" accept=".java" class="hidden" @change="onFile" />
        </label>

        <p v-if="filename" class="mt-3 truncate text-sm font-medium text-slate-600 dark:text-slate-300">
          📄 {{ filename }}
        </p>
      </div>

      <!-- Code einfügen (einklappbar) -->
      <button
        type="button"
        class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-accent)] transition hover:opacity-80"
        @click="showPaste = !showPaste"
      >
        <svg class="h-3.5 w-3.5 transition-transform" :class="showPaste ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6" /></svg>
        oder Code einfügen
      </button>
      <div v-show="showPaste" class="mt-2 h-60">
        <JavaCodeEditor v-model="source" />
      </div>

      <!-- Projekt-Kontext (einklappbar) -->
      <button
        type="button"
        class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        @click="showContext = !showContext"
      >
        <svg class="h-3.5 w-3.5 transition-transform" :class="showContext ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6" /></svg>
        Projekt-Kontext (optional){{ userContext ? ' · aktiv' : '' }}
      </button>
      <textarea
        v-show="showContext"
        v-model="userContext"
        spellcheck="false"
        rows="2"
        placeholder="z. B. Windchill-Hintergrund, Modulzweck… – fließt in jeden KI-Prompt ein."
        class="mt-2 w-full resize-y rounded-lg border border-slate-200 bg-white p-2.5 text-sm text-slate-700 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      />

      <p v-if="error" class="mt-3 text-sm text-rose-500">{{ error }}</p>

      <!-- Analysieren -->
      <button
        type="button"
        class="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        :disabled="analyzing || !source.trim()"
        @click="analyze"
      >
        <svg v-if="analyzing" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
        {{ analyzing ? 'Analysiere…' : 'Analysieren' }}
      </button>
    </div>

    <!-- Zuletzt analysiert -->
    <div v-if="recent.length" class="mt-8 w-full">
      <p class="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-400">Zuletzt analysiert</p>
      <div class="flex flex-wrap justify-center gap-2">
        <button
          v-for="f in recent"
          :key="f.id"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          @click="openClass(f.id)"
        >
          <span v-if="f.description">✨</span>
          {{ f.class_name }}
        </button>
      </div>
    </div>

    <!-- Sekundaere Einstiege -->
    <div class="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-slate-500 dark:text-slate-400">
      <RouterLink to="/wiki" class="transition hover:text-[var(--color-accent)]">📚 Wiki durchstöbern</RouterLink>
      <RouterLink to="/graph" class="transition hover:text-[var(--color-accent)]">🕸️ Zusammenhang-Graph</RouterLink>
      <RouterLink to="/new" class="transition hover:text-[var(--color-accent)]">+ Neuer Artikel</RouterLink>
    </div>
  </div>
</template>
