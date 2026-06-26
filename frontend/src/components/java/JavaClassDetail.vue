<script setup>
import { ref, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useArticles } from '../../composables/useArticles.js'

const props = defineProps({
  fileId: { type: Number, required: true },
})
const emit = defineEmits(['close'])

const router = useRouter()
const { getFile, summarizeMethod, deleteFile, linkArticle } = useJavaAnalyzer()
const { create } = useArticles()

const file = ref(null)
const loading = ref(true)
const error = ref('')
const openMethod = ref(null)
const summarizing = ref(null) // method id while running
const notice = ref('')
const creating = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  file.value = null
  try {
    file.value = await getFile(props.fileId)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.fileId, load, { immediate: true })

const typeColor = computed(() => ({
  class: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  interface: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  enum: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  annotation: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
}[file.value?.class_type] || 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'))

function signature(m) {
  const params = (m.parameters || []).map(p => `${p.type} ${p.name}`.trim()).join(', ')
  return `${m.return_type || 'void'} ${m.method_name}(${params})`
}

function toggle(id) {
  openMethod.value = openMethod.value === id ? null : id
}

async function summarize(m) {
  summarizing.value = m.id
  notice.value = ''
  try {
    const { method, ollama_unavailable } = await summarizeMethod(m.id)
    Object.assign(m, method)
    if (ollama_unavailable) notice.value = 'Ollama nicht erreichbar – es wird der Javadoc-Text angezeigt.'
  } catch (e) {
    notice.value = e.message
  } finally {
    summarizing.value = null
  }
}

// Wiki-Artikel aus der Klasse erzeugen und mit der Java-Datei verknuepfen (-> FTS-Suche).
function buildMarkdown(f) {
  const lines = [`# ${f.class_name}`, '']
  if (f.package) lines.push(`**Package:** \`${f.package}\``, '')
  lines.push(`**Typ:** ${f.class_type}`, '')
  if (f.dependencies?.length) {
    lines.push('## Abhängigkeiten', '')
    for (const d of f.dependencies) lines.push(`- \`${d}\``)
    lines.push('')
  }
  lines.push('## Methoden', '')
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
  <aside class="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
    <header class="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="typeColor">{{ file?.class_type }}</span>
          <h2 class="truncate text-lg font-bold text-slate-900 dark:text-white">{{ file?.class_name }}</h2>
        </div>
        <p v-if="file?.package" class="truncate text-xs text-slate-500 dark:text-slate-400">{{ file.package }}</p>
      </div>
      <button
        type="button"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Schließen"
        @click="emit('close')"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div v-if="loading" class="text-sm text-slate-400">Wird geladen…</div>
      <div v-else-if="error" class="text-sm text-rose-500">{{ error }}</div>
      <template v-else-if="file">
        <p v-if="notice" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{{ notice }}</p>

        <div v-if="file.dependencies.length" class="mb-4">
          <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Imports</h3>
          <ul class="space-y-0.5">
            <li v-for="d in file.dependencies" :key="d" class="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{{ d }}</li>
          </ul>
        </div>

        <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Methoden ({{ file.methods.length }})
        </h3>
        <ul class="space-y-1.5">
          <li v-for="m in file.methods" :key="m.id" class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
              @click="toggle(m.id)"
            >
              <code class="min-w-0 flex-1 truncate text-xs text-slate-800 dark:text-slate-200">{{ signature(m) }}</code>
              <svg class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform" :class="openMethod === m.id ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
            </button>

            <div v-show="openMethod === m.id" class="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
              <p v-if="m.ai_summary" class="mb-2 text-sm text-slate-700 dark:text-slate-300">{{ m.ai_summary }}</p>
              <p v-else class="mb-2 text-sm italic text-slate-400">Noch keine Zusammenfassung.</p>

              <details v-if="m.javadoc" class="mb-2">
                <summary class="cursor-pointer text-xs text-slate-500 dark:text-slate-400">Javadoc</summary>
                <pre class="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">{{ m.javadoc }}</pre>
              </details>

              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60 dark:bg-indigo-500/15 dark:text-indigo-300"
                :disabled="summarizing === m.id"
                @click="summarize(m)"
              >
                <svg v-if="summarizing === m.id" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
                <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
                {{ summarizing === m.id ? 'Generiere…' : 'KI-Zusammenfassung erzeugen' }}
              </button>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <footer v-if="file" class="flex items-center gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
      <RouterLink
        v-if="file.article_slug"
        :to="`/article/${file.article_slug}`"
        class="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-semibold text-white transition hover:bg-emerald-500"
      >
        Artikel öffnen
      </RouterLink>
      <button
        v-else
        type="button"
        class="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
        :disabled="creating"
        @click="createArticle"
      >
        {{ creating ? 'Erstelle…' : 'Wiki-Artikel erstellen' }}
      </button>
      <button
        type="button"
        class="rounded-lg border border-slate-200 px-3 py-2 text-sm text-rose-600 transition hover:bg-rose-50 dark:border-slate-700 dark:hover:bg-rose-500/10"
        title="Datei löschen"
        @click="removeFile"
      >
        Löschen
      </button>
    </footer>
  </aside>
</template>
