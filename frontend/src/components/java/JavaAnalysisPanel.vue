<script setup>
import { ref, computed, watch } from 'vue'
import { useJavaAnalysis } from '../../composables/useJavaAnalysis.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'

const props = defineProps({
  file: { type: Object, required: true },
  articleId: { type: Number, required: true },
})

const { userContext, summarizeMethod } = useJavaAnalyzer()
const analysis = useJavaAnalysis()

// Lokale, reaktive Kopie -> wird durch SSE-Events live aktualisiert (kein Reload).
const descriptionHtml = ref(props.file.description_html || '')
const generatedAt = ref(props.file.generated_at || null)
const methods = ref(props.file.methods.map((m) => ({ ...m })))
const reRunningId = ref(null)
const notice = ref('')
const showContext = ref(false)

watch(
  () => props.file,
  (f) => {
    descriptionHtml.value = f.description_html || ''
    generatedAt.value = f.generated_at || null
    methods.value = f.methods.map((m) => ({ ...m }))
  },
)

const total = computed(() => analysis.total.value || methods.value.length)
const steps = computed(() => total.value + 1) // Klasse + N Methoden
const completed = computed(() => (analysis.classDone.value ? 1 : 0) + analysis.methodsDone.value)
const percent = computed(() => (steps.value ? Math.round((completed.value / steps.value) * 100) : 0))

const runningLabel = computed(() => {
  if (!analysis.running.value) return ''
  return analysis.currentIndex.value <= 0
    ? 'Klassenbeschreibung…'
    : `Methode ${analysis.currentIndex.value}/${total.value}…`
})

const classState = computed(() => {
  if (analysis.running.value && analysis.currentIndex.value === 0) return 'running'
  if (analysis.classDone.value || descriptionHtml.value) return 'done'
  return 'idle'
})

function methodState(i, m) {
  if (reRunningId.value === m.id) return 'running'
  if (analysis.running.value && analysis.currentIndex.value === i + 1) return 'running'
  if (m.summary_html) return 'done'
  return 'idle'
}

const hasContent = computed(() => !!descriptionHtml.value || methods.value.some((m) => m.summary_html))

function startAnalysis() {
  notice.value = ''
  analysis.start(props.articleId, {
    userContext: userContext.value,
    onClassDone: (html) => {
      descriptionHtml.value = html
      generatedAt.value = new Date().toISOString()
    },
    onMethodDone: (content) => {
      const m = methods.value.find((x) => x.id === content.id)
      if (m) {
        m.ai_summary = content.ai_summary
        m.summary_html = content.summary_html
      }
    },
  })
}

// Einzelne Methode neu generieren (ueberschreibt nur diese Beschreibung).
async function reRun(m) {
  if (analysis.running.value) return
  reRunningId.value = m.id
  notice.value = ''
  try {
    const { method, summary_html, ollama_unavailable } = await summarizeMethod(m.id, {
      userContext: userContext.value,
    })
    m.ai_summary = method.ai_summary
    m.summary_html = summary_html
    if (ollama_unavailable) notice.value = 'Ollama nicht erreichbar – es wird der Javadoc-Text angezeigt.'
  } catch (e) {
    notice.value = e.message
  } finally {
    reRunningId.value = null
  }
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <section class="mb-8 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-accent-soft)]">
    <!-- Kopf -->
    <header class="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <span class="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-bold uppercase tracking-wide text-[var(--color-accent)]">KI-Code-Analyse</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          {{ methods.length }} Methode(n)
          <span v-if="generatedAt"> · zuletzt {{ fmtDate(generatedAt) }}</span>
          <span v-else> · noch nicht analysiert</span>
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        :disabled="analysis.running.value"
        @click="startAnalysis"
      >
        <svg v-if="analysis.running.value" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
        <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 3 14 9-14 9V3z" /></svg>
        {{ analysis.running.value ? 'Analysiere…' : (hasContent ? 'Erneut analysieren' : 'KI-Analyse starten') }}
      </button>
    </header>

    <div class="px-4 py-4">
      <!-- Kontext-Feld (einklappbar) -->
      <button
        type="button"
        class="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)] transition hover:opacity-80"
        @click="showContext = !showContext"
      >
        <svg class="h-3.5 w-3.5 transition-transform" :class="showContext ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6" /></svg>
        Projekt-Kontext (optional){{ userContext ? ' · aktiv' : '' }}
      </button>
      <textarea
        v-show="showContext"
        v-model="userContext"
        spellcheck="false"
        placeholder="z. B. Windchill-Hintergrund, Modulzweck… – fließt in jeden KI-Prompt ein."
        class="mb-4 h-20 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:bg-slate-900 dark:text-slate-200"
      />

      <!-- Fortschritt -->
      <div v-if="analysis.running.value" class="mb-4">
        <div class="mb-1.5 flex items-center justify-between text-xs">
          <span class="flex items-center gap-1.5 font-medium text-[var(--color-accent)]">
            <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
            {{ runningLabel }}
          </span>
          <span class="tabular-nums text-slate-500 dark:text-slate-400">{{ completed }}/{{ steps }}</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-accent-soft)]">
          <div class="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300" :style="{ width: percent + '%' }" />
        </div>
        <!-- Schritt-Pills -->
        <div class="mt-2 flex flex-wrap items-center gap-1">
          <span
            class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            :class="classState === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : classState === 'running' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'"
          >
            <span v-if="classState === 'done'">✓</span><span v-else-if="classState === 'running'">⟳</span>
            Klasse
          </span>
          <span
            v-for="(m, i) in methods"
            :key="m.id"
            class="inline-flex h-5 min-w-[20px] items-center justify-center rounded-md px-1 text-[10px] font-medium"
            :class="methodState(i, m) === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : methodState(i, m) === 'running' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'"
            :title="m.method_name"
          >{{ i + 1 }}</span>
        </div>
      </div>

      <p v-if="analysis.error.value" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">{{ analysis.error.value }}</p>
      <p v-if="notice" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{{ notice }}</p>

      <!-- Leerzustand -->
      <p v-if="!hasContent && !analysis.running.value" class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        Starte die KI-Analyse, um Klassen- und Methodenbeschreibungen zu generieren – sie erscheinen hier nacheinander.
      </p>

      <!-- Klassenbeschreibung -->
      <div
        v-if="descriptionHtml"
        class="prose prose-slate mb-6 max-w-none rounded-xl bg-white px-4 py-3 dark:prose-invert dark:bg-slate-900/60"
        v-html="descriptionHtml"
      />

      <!-- Methoden -->
      <ul v-if="hasContent || analysis.running.value" class="space-y-3">
        <li
          v-for="(m, i) in methods"
          :key="m.id"
          class="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60"
        >
          <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <button
              type="button"
              class="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
              :disabled="analysis.running.value"
              :title="`„${m.method_name}“ einzeln neu generieren`"
              @click="reRun(m)"
            >
              <span class="truncate font-mono text-sm font-semibold text-[var(--color-accent)] group-hover:underline disabled:no-underline">{{ m.method_name }}</span>
              <svg v-if="methodState(i, m) !== 'running'" class="h-3.5 w-3.5 shrink-0 text-slate-300 transition group-hover:text-[var(--color-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5M21 3v6h-6" /></svg>
            </button>
            <svg v-if="methodState(i, m) === 'running'" class="h-4 w-4 shrink-0 animate-spin text-[var(--color-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
            <span v-else-if="methodState(i, m) === 'done'" class="shrink-0 text-emerald-500" title="analysiert">✓</span>
          </div>

          <!-- Signatur (Shiki java, server-gerendert) -->
          <div class="java-sig px-3 pt-3" v-html="m.signature_html" />

          <!-- KI-Beschreibung -->
          <div
            v-if="m.summary_html"
            class="prose prose-sm prose-slate max-w-none px-3 pb-3 dark:prose-invert"
            v-html="m.summary_html"
          />
          <p v-else class="px-3 pb-3 text-sm italic text-slate-400">Noch keine KI-Beschreibung – Methodennamen klicken zum Generieren.</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Shiki-Codeblock der Signatur kompakt halten (globale .shiki-Styles greifen weiter). */
.java-sig :deep(pre.shiki) {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8rem;
  overflow-x: auto;
}
</style>
