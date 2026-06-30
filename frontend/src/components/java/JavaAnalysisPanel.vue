<script setup>
import { ref, computed, watch } from 'vue'
import { useJavaAnalysis } from '../../composables/useJavaAnalysis.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { Icon } from '../../lib/icons.js'

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
const classAiGenerated = ref(null) // true = KI-Text, false = Fallback, null = unbekannt

watch(
  () => props.file,
  (f) => {
    descriptionHtml.value = f.description_html || ''
    generatedAt.value = f.generated_at || null
    methods.value = f.methods.map((m) => ({ ...m }))
    classAiGenerated.value = null
  },
)

const total = computed(() => analysis.total.value || methods.value.length)
const steps = computed(() => total.value + 1) // Klasse + N Methoden
const completed = computed(() => (analysis.classDone.value ? 1 : 0) + analysis.methodsDone.value)
const percent = computed(() => (steps.value ? Math.round((completed.value / steps.value) * 100) : 0))

const runningLabel = computed(() => {
  if (!analysis.running.value) return ''
  return analysis.currentIndex.value <= 0
    ? 'Class description…'
    : `Method ${analysis.currentIndex.value}/${total.value}…`
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
  classAiGenerated.value = null
  analysis.start(props.articleId, {
    userContext: userContext.value,
    onClassDone: (html, aiGenerated) => {
      descriptionHtml.value = html
      generatedAt.value = new Date().toISOString()
      classAiGenerated.value = aiGenerated ?? null
    },
    onMethodDone: (content, aiGenerated) => {
      const m = methods.value.find((x) => x.id === content.id)
      if (m) {
        m.ai_summary = content.ai_summary
        m.summary_html = content.summary_html
        m.ai_generated = aiGenerated ?? null
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
    if (ollama_unavailable) notice.value = 'Ollama unreachable – showing the Javadoc text.'
  } catch (e) {
    notice.value = e.message
  } finally {
    reRunningId.value = null
  }
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Dauer als mm:ss.
function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="mb-8 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-accent-soft)]">
    <!-- Kopf -->
    <header class="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
      <span class="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm">
        <Icon icon="lucide:sparkles" class="h-5 w-5" />
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-bold uppercase tracking-wide text-[var(--color-accent)]">AI code analysis</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          {{ methods.length }} method(s)
          <span v-if="generatedAt"> · last {{ fmtDate(generatedAt) }}</span>
          <span v-else> · not analyzed yet</span>
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        :disabled="analysis.running.value"
        @click="startAnalysis"
      >
        <Icon v-if="analysis.running.value" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
        <Icon v-else icon="lucide:play" class="h-4 w-4" />
        {{ analysis.running.value ? 'Analyzing…' : (hasContent ? 'Re-analyze' : 'Start AI analysis') }}
      </button>
    </header>

    <div class="px-4 py-4">
      <!-- Kontext-Feld (einklappbar) -->
      <button
        type="button"
        class="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)] transition hover:opacity-80"
        @click="showContext = !showContext"
      >
        <Icon icon="lucide:chevron-right" class="h-3.5 w-3.5 transition-transform" :class="showContext ? 'rotate-90' : ''" />
        Project context (optional){{ userContext ? ' · active' : '' }}
      </button>
      <textarea
        v-show="showContext"
        v-model="userContext"
        spellcheck="false"
        placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
        class="mb-4 h-20 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:bg-slate-900 dark:text-slate-200"
      />

      <!-- Fortschritt -->
      <div v-if="analysis.running.value" class="mb-4">
        <div class="mb-1.5 flex items-center justify-between text-xs">
          <span class="flex items-center gap-1.5 font-medium text-[var(--color-accent)]">
            <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
            {{ runningLabel }}
            <span class="tabular-nums font-normal text-[var(--color-text-muted)]">{{ fmtDur(analysis.stepElapsedMs.value) }}</span>
          </span>
          <span class="tabular-nums text-slate-500 dark:text-slate-400">{{ completed }}/{{ steps }}</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-accent-soft)]">
          <div class="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300" :style="{ width: percent + '%' }" />
        </div>
        <div class="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
          <span class="tabular-nums">
            Total {{ fmtDur(analysis.totalElapsedMs.value) }}
            <span v-if="completed < steps"> · ~{{ fmtDur(analysis.etaMs.value) }} left</span>
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2 py-0.5 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
            :disabled="analysis.cancelling.value"
            @click="analysis.cancel(articleId)"
          >
            <Icon icon="lucide:x" class="h-3 w-3" />
            {{ analysis.cancelling.value ? 'Cancelling…' : 'Cancel' }}
          </button>
        </div>
        <!-- Schritt-Pills -->
        <div class="mt-2 flex flex-wrap items-center gap-1">
          <span
            class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            :class="classState === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : classState === 'running' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'"
          >
            <Icon v-if="classState === 'done'" icon="lucide:check" class="h-3 w-3" /><Icon v-else-if="classState === 'running'" icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
            Class
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

      <!-- Stall-Watchdog: keine Antwort vom Server -->
      <div v-if="analysis.stalled.value" class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
        <span class="flex-1">No response from the server – the local AI may be stuck. The local AI on the Pi is slow (about 30–90 s per step).</span>
        <button
          v-if="analysis.running.value"
          type="button"
          class="rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15"
          :disabled="analysis.cancelling.value"
          @click="analysis.cancel(articleId)"
        >Cancel</button>
        <button
          type="button"
          class="rounded-md border border-amber-300 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15"
          @click="startAnalysis"
        >Restart</button>
      </div>

      <p v-if="analysis.error.value" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">{{ analysis.error.value }}</p>
      <p v-if="notice" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{{ notice }}</p>

      <!-- Leerzustand -->
      <div v-if="!hasContent && !analysis.running.value" class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <p>Start the AI analysis to generate class and method descriptions – they appear here one by one.</p>
        <p class="mt-1.5 text-xs text-slate-400 dark:text-slate-500">Note: The local AI runs on the Pi and is slow – expect about 30–90 s per step.</p>
      </div>

      <!-- Klassenbeschreibung -->
      <div v-if="descriptionHtml" class="mb-6">
        <div
          class="prose prose-slate max-w-none rounded-xl bg-white px-4 py-3 dark:prose-invert dark:bg-slate-900/60"
          v-html="descriptionHtml"
        />
        <span
          v-if="classAiGenerated !== null"
          class="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
          :class="classAiGenerated ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'"
        ><Icon :icon="classAiGenerated ? 'lucide:check' : 'lucide:alert-triangle'" class="h-3 w-3" />{{ classAiGenerated ? 'AI text generated' : 'Fallback: existing description' }}</span>
      </div>

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
              :title="`Regenerate “${m.method_name}” individually`"
              @click="reRun(m)"
            >
              <span class="truncate font-mono text-sm font-semibold text-[var(--color-accent)] group-hover:underline disabled:no-underline">{{ m.method_name }}</span>
              <Icon v-if="methodState(i, m) !== 'running'" icon="lucide:refresh-cw" class="h-3.5 w-3.5 shrink-0 text-slate-300 transition group-hover:text-[var(--color-accent)]" />
            </button>
            <span
              v-if="m.ai_generated === false"
              class="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
              title="Ollama returned no text – showing Javadoc as fallback"
            >Fallback: Javadoc</span>
            <span
              v-else-if="m.ai_generated === true"
              class="shrink-0 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              title="AI text generated"
            >AI text</span>
            <Icon v-if="methodState(i, m) === 'running'" icon="lucide:loader-2" class="h-4 w-4 shrink-0 animate-spin text-[var(--color-accent)]" />
            <Icon v-else-if="methodState(i, m) === 'done'" icon="lucide:check" class="h-4 w-4 shrink-0 text-emerald-500" title="analyzed" />
          </div>

          <!-- Signatur (Shiki java, server-gerendert) -->
          <div class="java-sig px-3 pt-3" v-html="m.signature_html" />

          <!-- KI-Beschreibung -->
          <div
            v-if="m.summary_html"
            class="prose prose-sm prose-slate max-w-none px-3 pb-3 dark:prose-invert"
            v-html="m.summary_html"
          />
          <p v-else class="px-3 pb-3 text-sm italic text-slate-400">No AI description yet – click the method name to generate.</p>
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
