<script setup>
// Vollstaendige Doku-Ansicht einer analysierten Java-Klasse (Spalte 3 im Analyzer).
// Header + KI-Status, Klassen-Zusammenfassung (description_html), Methoden-Accordion
// (summary_html, einzeln nachgenerierbar) und Quellcode-Tab (read-only CodeMirror).
// HTTP nur via lib/api.js (Composable).
import { ref, watch, computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../../composables/useJavaQueue.js'
import { useArticles } from '../../composables/useArticles.js'
import JavaCodeEditor from './JavaCodeEditor.vue'
import { Icon } from '../../lib/icons.js'

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
  class: 'badge-accent',
  interface: 'badge-success',
  enum: 'badge-warning',
  annotation: 'badge-danger',
}[file.value?.class_type] || 'badge-muted'))

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
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
    <!-- Header -->
    <header class="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="typeBadge">{{ file?.class_type }}</span>
          <h2 class="truncate text-xl font-bold text-[var(--color-text)]">{{ file?.class_name }}</h2>
        </div>
        <p v-if="file?.package" class="truncate font-mono text-xs text-[var(--color-text-muted)]">{{ file.package }}</p>
        <div v-if="file" class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span class="rounded-md bg-[var(--color-surface-offset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
            {{ methodCount }} Methode(n)
          </span>
          <span
            class="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            :class="summarizedCount === methodCount && methodCount > 0 ? 'badge-success' : 'badge-accent'"
          >
            KI {{ summarizedCount }}/{{ methodCount }}
          </span>
          <span
            v-if="queueProgress && queueProgress.status === 'running'"
            class="badge-accent inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
          >
            <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
            <span v-if="queueProgress.current">{{ queueProgress.current.name }}()</span>
            <span v-else>Queue läuft</span>
            <span v-if="queueProgress.total > 1" class="tabular-nums opacity-70">{{ queueProgress.done }}/{{ queueProgress.total }}</span>
          </span>
        </div>
      </div>
      <button
        type="button"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
        title="Schließen"
        @click="emit('close')"
      >
        <Icon icon="lucide:x" class="h-5 w-5" />
      </button>
    </header>

    <!-- Tabs -->
    <div v-if="file" class="flex shrink-0 gap-1 border-b border-[var(--color-border)] px-4 pt-2">
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'doc' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
        @click="tab = 'doc'"
      >Dokumentation</button>
      <button
        type="button"
        class="border-b-2 px-3 py-1.5 text-sm font-medium transition"
        :class="tab === 'source' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
        @click="tab = 'source'"
      >Quellcode</button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div v-if="loading" class="text-sm text-[var(--color-text-muted)]">Wird geladen…</div>
      <div v-else-if="error" class="text-sm text-[var(--color-danger)]">{{ error }}</div>

      <template v-else-if="file">
        <p v-if="notice" class="notice-warning mb-3 rounded-lg px-3 py-2 text-xs">{{ notice }}</p>
        <p
          v-if="queueProgress && queueProgress.ollamaUnavailable"
          class="notice-warning mb-3 rounded-lg px-3 py-2 text-xs"
        >
          Ollama war nicht erreichbar – es wird vorhandener Javadoc-/Fallback-Text verwendet.
        </p>

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
                <Icon v-if="classBusy" icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                {{ classBusy ? 'Generiere…' : (file.description_html ? 'Neu generieren' : 'Generate Class Summary') }}
              </button>
            </div>
            <div v-if="file.description_html" class="prose prose-sm max-w-none dark:prose-invert" v-html="file.description_html" />
            <p v-else class="text-sm italic text-[var(--color-text-muted)]">Noch keine KI-Klassenbeschreibung – „Generieren" nutzt den Projekt-Kontext.</p>
          </section>

          <!-- Methoden -->
          <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Methoden ({{ methodCount }})</h3>
          <ul class="space-y-1.5">
            <li v-for="m in file.methods" :key="m.id" class="overflow-hidden rounded-lg border border-[var(--color-border)]">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--color-surface-offset)]"
                @click="toggle(m.id)"
              >
                <code class="min-w-0 flex-1 truncate text-xs text-[var(--color-text)]">{{ signature(m) }}</code>
                <span
                  class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  :class="{
                    'badge-success': methodStatus(m) === 'done',
                    'badge-accent': methodStatus(m) === 'running' || methodStatus(m) === 'pending',
                    'badge-muted': methodStatus(m) === 'idle',
                  }"
                >
                  {{ { done: 'generiert', running: '…', pending: 'wartet', idle: 'offen' }[methodStatus(m)] }}
                </span>
                <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform" :class="openMethod === m.id ? 'rotate-180' : ''" />
              </button>

              <div v-show="openMethod === m.id" class="border-t border-[var(--color-border)] px-3 py-2">
                <div v-if="m.summary_html" class="prose prose-sm mb-2 max-w-none dark:prose-invert" v-html="m.summary_html" />
                <p v-else class="mb-2 text-sm italic text-[var(--color-text-muted)]">Noch keine KI-Beschreibung.</p>

                <button
                  type="button"
                  class="badge-accent inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition hover:opacity-80 disabled:opacity-60"
                  :disabled="summarizing === m.id"
                  @click="summarize(m)"
                >
                  <Icon v-if="summarizing === m.id" icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                  {{ summarizing === m.id ? 'Generiere…' : (m.summary_html ? 'Neu generieren' : 'Generate Summary') }}
                </button>
              </div>
            </li>
          </ul>
        </template>

        <!-- QUELLCODE-TAB: read-only CodeMirror (Java-Syntax-Highlighting) -->
        <template v-else>
          <div class="code-wrap h-[60vh] min-h-[20rem]">
            <button
              type="button"
              class="code-copy z-10 opacity-100"
              @click="copySource"
            >{{ copied ? 'Kopiert' : 'Kopieren' }}</button>
            <JavaCodeEditor :model-value="file.raw_source" readonly />
          </div>
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
        class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-surface-offset)]"
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
