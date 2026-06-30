<script setup>
// Statusseite aller KI-Analyse-Einheiten (eine Einheit pro Klasse: Methoden -> Klasse) der
// Java-Analyse. Der Zustand liegt im Backend; hier wird er per HTTP-Polling (3 s) ueber das
// gemeinsame useJavaQueue-Composable gespiegelt. Kein direktes fetch(), kein WebSocket.
//
// Sortierung (Spec): ABGESCHLOSSEN zuerst (neueste oben, zum Lesen / "als gelesen markieren"),
// dann IN BEARBEITUNG, dann WARTEND. Der laufende Job behaelt sein Live-Terminal.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { allJobs, liveByKey, ensurePolling, cancelJob, cancelAllJobs, markAllRead } = useJavaQueue()
const { lastFileId } = useJavaAnalyzer()

// Klick auf einen Queue-Eintrag -> in den Code-Analyzer wechseln und die Klasse direkt oeffnen.
function openClass(j) {
  if (j.fileId == null) return
  lastFileId.value = j.fileId
  router.push('/code')
}

let releasePolling = null
onMounted(() => {
  releasePolling = ensurePolling()
})
onUnmounted(() => releasePolling?.())

const FINISHED = ['done', 'done-with-errors', 'failed', 'cancelled']
function isFinished(s) {
  return FINISHED.includes(s)
}

// Eine sortierte Liste: abgeschlossen (neueste finishedAt zuerst) -> laufend -> wartend (neueste
// queuedAt zuerst). Bei einem sequentiellen Worker laeuft hoechstens einer.
const ordered = computed(() => {
  const rank = (s) => (isFinished(s) ? 0 : s === 'running' ? 1 : 2)
  return [...allJobs.value].sort((a, b) => {
    const ra = rank(a.status)
    const rb = rank(b.status)
    if (ra !== rb) return ra - rb
    if (ra === 0) return (b.finishedAt || '').localeCompare(a.finishedAt || '')
    return (b.queuedAt || '').localeCompare(a.queuedAt || '')
  })
})
const finishedCount = computed(() => allJobs.value.filter((j) => isFinished(j.status)).length)
const activeCount = computed(() => allJobs.value.filter((j) => !isFinished(j.status)).length)

// Live-Daten (SSE-Puffer, Fallback auf das Polling-Snapshot nach einem Reload). Key = fileId.
function jobKey(j) {
  return String(j.fileId)
}
function liveFor(j) {
  const k = jobKey(j)
  return liveByKey.value[k] || { text: j.liveText || '', tokens: j.tokenCount || 0, phase: j.status }
}

// Genau ein laufender Job -> dessen Live-Text fuer Auto-Scroll beobachten.
const runningJob = computed(() => allJobs.value.find((j) => j.status === 'running') || null)
const runningLive = computed(() => (runningJob.value ? liveFor(runningJob.value) : null))
const logEl = ref(null)
watch(
  () => runningLive.value?.text,
  () => {
    nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    })
  },
)

const STATUS = {
  queued: { label: 'Queued', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  running: { label: 'Active', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  done: { label: 'Done', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  'done-with-errors': { label: 'Done (with errors)', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  failed: { label: 'Failed', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
}
function statusInfo(s) {
  return STATUS[s] || { label: s, cls: 'bg-slate-100 text-slate-600' }
}
// Kompaktes Erfolgs-/Status-Icon fuer abgeschlossene Jobs.
const FINISHED_ICON = {
  done: { icon: 'lucide:check-circle', cls: 'text-emerald-500' },
  'done-with-errors': { icon: 'lucide:alert-triangle', cls: 'text-amber-500' },
  failed: { icon: 'lucide:alert-triangle', cls: 'text-rose-500' },
  cancelled: { icon: 'lucide:x', cls: 'text-slate-400' },
}
function finishedIcon(s) {
  return FINISHED_ICON[s] || { icon: 'lucide:check-circle', cls: 'text-slate-400' }
}
// Phasen-Hinweis fuer den laufenden Job (Methoden zuerst, dann Klassen-Text).
function phaseLabel(j) {
  return j.phase === 'class' ? 'Class text' : 'Methods'
}
function percent(j) {
  if (!j.total) return j.status === 'done' ? 100 : 0
  return Math.round(((j.done + j.failed) / j.total) * 100)
}
function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Cancel-/Entfernen-Handler: Fehler still schlucken (z. B. wenn der Job serverseitig schon weg
// ist) – das optimistische Entfernen im Composable hat die UI ohnehin bereits aktualisiert.
async function onCancel(j) {
  try {
    await cancelJob(j.fileId)
  } catch {
    /* ignorieren */
  }
}
async function onCancelAll() {
  try {
    await cancelAllJobs()
  } catch {
    /* ignorieren */
  }
}
async function onMarkAllRead() {
  try {
    await markAllRead()
  } catch {
    /* ignorieren */
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-5 py-6">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">AI Queue</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          One unit per class: methods first, then the class summary – refreshes every 3&nbsp;seconds.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="finishedCount"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
          title="Mark all finished entries as read and hide them"
          @click="onMarkAllRead"
        >
          <Icon icon="lucide:check-circle" class="h-4 w-4" />
          Mark all read ({{ finishedCount }})
        </button>
        <button
          v-if="allJobs.length"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          title="Cancel all jobs and clear the list"
          @click="onCancelAll"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Cancel all
        </button>
        <RouterLink
          to="/code"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Icon icon="lucide:chevron-left" class="h-4 w-4" />
          To analyzer
        </RouterLink>
      </div>
    </div>

    <!-- Eine sortierte Liste: abgeschlossen -> aktiv -> wartend -->
    <div v-if="ordered.length" class="space-y-3">
      <article
        v-for="j in ordered"
        :key="j.fileId"
        class="rounded-2xl border border-slate-200 bg-white p-4 transition dark:border-slate-800 dark:bg-slate-900"
        :class="j.status === 'running' ? 'ring-1 ring-[var(--color-accent)]/40' : ''"
      >
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <Icon
            v-if="isFinished(j.status)"
            :icon="finishedIcon(j.status).icon"
            class="h-4 w-4 shrink-0"
            :class="finishedIcon(j.status).cls"
          />
          <Icon
            v-else-if="j.status === 'running'"
            icon="lucide:loader-2"
            class="h-4 w-4 shrink-0 animate-spin text-[var(--color-accent)]"
          />
          <Icon v-else icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-slate-400" />

          <span class="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
            AI analysis
          </span>
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left font-semibold text-slate-800 transition hover:text-[var(--color-accent)] dark:text-slate-100"
            :title="`Open ${j.className} in the analyzer`"
            @click="openClass(j)"
          >{{ j.className }}</button>
          <span class="rounded-md px-2 py-0.5 text-[11px] font-semibold" :class="statusInfo(j.status).cls">{{ statusInfo(j.status).label }}</span>
          <span v-if="j.finishedAt && isFinished(j.status)" class="shrink-0 text-[11px] text-slate-400">{{ fmtTime(j.finishedAt) }}</span>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
            :title="isFinished(j.status) ? 'Remove from list' : 'Cancel job'"
            :aria-label="isFinished(j.status) ? 'Remove from list' : 'Cancel job'"
            @click.stop="onCancel(j)"
          >
            <Icon icon="lucide:x" class="h-4 w-4" />
          </button>
        </div>
        <p v-if="j.package" class="mb-2 truncate font-mono text-[11px] text-slate-400">{{ j.package }}</p>

        <div class="mb-1.5 flex items-center justify-between text-xs">
          <span class="flex min-w-0 items-center gap-1.5" :class="j.status === 'running' ? 'text-[var(--color-accent)]' : 'text-slate-500 dark:text-slate-400'">
            <template v-if="j.status === 'running'">
              <span class="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--color-accent)]">{{ phaseLabel(j) }}</span>
              <span class="truncate">
                <template v-if="j.current">{{ j.current.name }}<template v-if="j.phase !== 'class'">()</template></template>
                <template v-else>preparing…</template>
              </span>
            </template>
            <template v-else-if="j.status === 'queued'">waiting…</template>
            <template v-else>{{ j.done }}/{{ j.total }} steps<template v-if="j.failed"> · {{ j.failed }} errors</template></template>
          </span>
          <span class="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{{ j.done }}/{{ j.total }}</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="j.status === 'failed' ? 'bg-rose-400' : j.status === 'done-with-errors' ? 'bg-amber-400' : isFinished(j.status) ? 'bg-emerald-400' : 'bg-[var(--color-accent)]'"
            :style="{ width: percent(j) + '%' }"
          />
        </div>

        <!-- Live-Terminal: Token-by-Token-Ausgabe von Ollama (nur fuer den laufenden Job) -->
        <div v-if="j.status === 'running'" class="mt-3">
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <Icon icon="lucide:terminal" class="h-3.5 w-3.5" />
              Live output
            </span>
            <span class="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-[var(--color-accent)]">
              <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
              {{ liveFor(j).tokens }} tokens generated…
            </span>
          </div>
          <pre ref="logEl" class="queue-log">{{ liveFor(j).text || 'Waiting for Ollama…' }}</pre>
          <!-- Indeterminierte Fortschritts-Bar: Ollama liefert keinen numerischen Fortschritt -->
          <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div class="queue-indeterminate h-full w-2/5 rounded-full bg-[var(--color-accent)]" />
          </div>
        </div>

        <p v-if="j.ollamaUnavailable" class="mt-2 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
          Ollama unreachable – using fallback text.
        </p>
      </article>
    </div>

    <p v-else class="mt-10 text-center text-sm text-slate-400">
      No analysis started yet. Pick a class in the analyzer and start a summary,
      or use “Analyze”.
    </p>

    <p v-if="ordered.length" class="mt-4 text-center text-xs text-slate-400">
      {{ activeCount }} active · {{ finishedCount }} finished
    </p>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Abgedunkelter Terminal-/Log-Bereich: ~7 Zeilen sichtbar, scrollbar, monospace. */
.queue-log {
  @apply max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-[11px] leading-relaxed;
  background-color: #0f172a; /* slate-900, bewusst dunkel – auch im Light-Mode ein Terminal */
  color: #cbd5e1; /* slate-300 */
  border: 1px solid rgba(148, 163, 184, 0.18);
}
html.dark .queue-log {
  background-color: #0b1220;
  color: #d4dbe5;
}

/* Indeterminierte Progress-Bar: laeuft endlos hin und her (kein numerischer Fortschritt). */
.queue-indeterminate {
  animation: queue-indeterminate 1.4s ease-in-out infinite;
}
@keyframes queue-indeterminate {
  0% {
    margin-left: -40%;
  }
  100% {
    margin-left: 100%;
  }
}
</style>
