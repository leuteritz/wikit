<script setup>
// Vollstaendige Doku-Ansicht einer analysierten Java-Klasse (Spalte 3 im Analyzer).
// Header + KI-Status, Klassen-Zusammenfassung (description_html), Methoden-Accordion
// (summary_html, einzeln nachgenerierbar) und Quellcode-Tab. HTTP nur via lib/api.js (Composable).
import { ref, watch, computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../../composables/useJavaQueue.js'
import { useArticles } from '../../composables/useArticles.js'

const props = defineProps({
  fileId: { type: Number, required: true },
})
const emit = defineEmits(['close', 'changed'])

const router = useRouter()
const { getFile, summarizeMethod, summarizeClass, deleteFile, linkArticle, userContext } = useJavaAnalyzer()
const { lastEvent, progressFor } = useJavaQueue()
const { create } = useArticles()

const file = ref(null)
const loading = ref(true)
const error = ref('')
const tab = ref('doc') // 'doc' | 'source'
const openMethod = ref(null)
const summarizing = ref(null) // method id while running
const classBusy = ref(false)
const notice = ref('')
const creating = ref(false)
const copied = ref(false)

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

// Wenn die Hintergrund-Queue eine Methode dieser Klasse fertigstellt -> Daten neu laden.
watch(lastEvent, (ev) => {
  if (ev && ev.fileId === props.fileId) load()
})

const queueProgress = computed(() => progressFor(props.fileId))

const typeBadge = computed(() => ({
  class: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  interface: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  enum: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  annotation: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
}[file.value?.class_type] || 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'))

const methodCount = computed(() => file.value?.methods?.length || 0)
const summarizedCount = computed(() => (file.value?.methods || []).filter((m) => m.summary_html).length)

function signature(m) {
  const params = (m.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ')
  return `${m.return_type || 'void'} ${m.method_name}(${params})`
}
function methodStatus(m) {
  if (summarizing.value === m.id) return 'running'
  if (queueProgress.value && queueProgress.value.status === 'running' && !m.summary_html) return 'pending'
  return m.summary_html ? 'done' : 'idle'
}
function toggle(id) {
  openMethod.value = openMethod.value === id ? null : id
}

async function summarize(m) {
  summarizing.value = m.id
  notice.value = ''
  try {
    const { method, summary_html, ollama_unavailable } = await summarizeMethod(m.id, { userContext: userContext.value })
    Object.assign(m, method, { summary_html })
    if (ollama_unavailable) notice.value = 'Ollama nicht erreichbar – es wird der Javadoc-Text angezeigt.'
  } catch (e) {
    notice.value = e.message
  } finally {
    summarizing.value = null
  }
}

async function generateClassSummary() {
  if (!file.value) return
  classBusy.value = true
  notice.value = ''
  try {
    const { description_html, ollama_unavailable } = await summarizeClass(file.value.id, { userContext: userContext.value })
    file.value.description_html = description_html
    if (ollama_unavailable) notice.value = 'Ollama nicht erreichbar – Klassen-Zusammenfassung unverändert.'
    emit('changed')
  } catch (e) {
    notice.value = e.message
  } finally {
    classBusy.value = false
  }
}

async function copySource() {
  try {
    await navigator.clipboard.writeText(file.value?.raw_source || '')
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch { /* Clipboard evtl. gesperrt */ }
}

// Wiki-Artikel aus der Klasse erzeugen und verknuepfen (-> FTS-Suche).
function buildMarkdown(f) {
  const lines = [`# ${f.class_name}`, '']
  if (f.package) lines.push(`**Package:** \`${f.package}\``, '')
  lines.push(`**Typ:** ${f.class_type}`, '')
  if (f.description) lines.push('', f.description, '')
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
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
    <!-- Header -->
    <header class="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="typeBadge">{{ file?.class_type }}</span>
          <h2 class="truncate text-lg font-bold text-slate-900 dark:text-white">{{ file?.class_name }}</h2>
        </div>
        <p v-if="file?.package" class="truncate font-mono text-xs text-[var(--color-text-muted)]">{{ file.package }}</p>
        <div v-if="file" class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span class="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {{ methodCount }} Methode(n)
          </span>
          <span
            class="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            :class="summarizedCount === methodCount && methodCount > 0
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
              : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'"
          >
            KI {{ summarizedCount }}/{{ methodCount }}
          </span>
          <span
            v-if="queueProgress && queueProgress.status === 'running'"
            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
          >
            <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
            Queue läuft
          </span>
        </div>
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

    <!-- Tabs -->
    <div v-if="file" class="flex shrink-0 gap-1 border-b border-slate-200 px-4 pt-2 dark:border-slate-800">
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'doc' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'"
        @click="tab = 'doc'"
      >Dokumentation</button>
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'source' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'"
        @click="tab = 'source'"
      >Quellcode</button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div v-if="loading" class="text-sm text-slate-400">Wird geladen…</div>
      <div v-else-if="error" class="text-sm text-rose-500">{{ error }}</div>

      <template v-else-if="file">
        <p v-if="notice" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{{ notice }}</p>

        <!-- DOKU-TAB -->
        <template v-if="tab === 'doc'">
          <!-- Klassen-Zusammenfassung -->
          <section class="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] p-3">
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">Klassen-Zusammenfassung</h3>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                :disabled="classBusy"
                @click="generateClassSummary"
              >
                <svg v-if="classBusy" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
                {{ classBusy ? 'Generiere…' : (file.description_html ? 'Neu generieren' : 'Generieren') }}
              </button>
            </div>
            <div v-if="file.description_html" class="prose prose-sm prose-slate max-w-none dark:prose-invert" v-html="file.description_html" />
            <p v-else class="text-sm italic text-slate-500 dark:text-slate-400">Noch keine KI-Klassenbeschreibung – „Generieren" nutzt den Projekt-Kontext.</p>
          </section>

          <!-- Imports -->
          <div v-if="file.dependencies.length" class="mb-4">
            <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Imports ({{ file.dependencies.length }})</h3>
            <ul class="space-y-0.5">
              <li v-for="d in file.dependencies" :key="d" class="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{{ d }}</li>
            </ul>
          </div>

          <!-- Methoden -->
          <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Methoden ({{ methodCount }})</h3>
          <ul class="space-y-1.5">
            <li v-for="m in file.methods" :key="m.id" class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
                @click="toggle(m.id)"
              >
                <code class="min-w-0 flex-1 truncate text-xs text-slate-800 dark:text-slate-200">{{ signature(m) }}</code>
                <span
                  class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  :class="{
                    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300': methodStatus(m) === 'done',
                    'bg-[var(--color-accent-soft)] text-[var(--color-accent)]': methodStatus(m) === 'running' || methodStatus(m) === 'pending',
                    'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500': methodStatus(m) === 'idle',
                  }"
                >
                  {{ { done: 'generiert', running: '…', pending: 'wartet', idle: 'offen' }[methodStatus(m)] }}
                </span>
                <svg class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform" :class="openMethod === m.id ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
              </button>

              <div v-show="openMethod === m.id" class="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                <div v-if="m.summary_html" class="prose prose-sm prose-slate mb-2 max-w-none dark:prose-invert" v-html="m.summary_html" />
                <p v-else class="mb-2 text-sm italic text-slate-400">Noch keine KI-Beschreibung.</p>

                <details v-if="m.javadoc" class="mb-2">
                  <summary class="cursor-pointer text-xs text-slate-500 dark:text-slate-400">Javadoc</summary>
                  <pre class="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">{{ m.javadoc }}</pre>
                </details>

                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition hover:opacity-80 disabled:opacity-60"
                  :disabled="summarizing === m.id"
                  @click="summarize(m)"
                >
                  <svg v-if="summarizing === m.id" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
                  {{ summarizing === m.id ? 'Generiere…' : (m.summary_html ? 'Neu generieren' : 'KI-Zusammenfassung erzeugen') }}
                </button>
              </div>
            </li>
          </ul>
        </template>

        <!-- QUELLCODE-TAB -->
        <template v-else>
          <div class="code-wrap">
            <button
              type="button"
              class="absolute right-2 top-2 z-10 rounded-md border border-slate-300/60 bg-white/80 px-2 py-1 text-xs font-medium text-slate-600 backdrop-blur transition hover:bg-white dark:border-slate-600/60 dark:bg-slate-800/80 dark:text-slate-300"
              @click="copySource"
            >{{ copied ? 'Kopiert ✓' : 'Kopieren' }}</button>
            <pre class="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"><code class="language-java">{{ file.raw_source }}</code></pre>
          </div>
        </template>
      </template>
    </div>

    <!-- Footer -->
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
        class="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        :disabled="creating"
        @click="createArticle"
      >
        {{ creating ? 'Erstelle…' : 'In Wiki speichern' }}
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

<style scoped>
@reference "../../assets/style.css";

.code-wrap {
  @apply relative;
}
</style>
