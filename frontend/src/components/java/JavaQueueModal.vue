<script setup>
// Breites Modal aller KI-Analyse-Einheiten (eine Einheit pro Klasse: Methoden -> Klasse) der
// Java-Analyse. Loest den frueheren eigenstaendigen Queue-Tab ab und sitzt jetzt im Code-View.
// Der Zustand liegt im Backend; hier wird er per HTTP-Polling (3 s) ueber das gemeinsame
// useJavaQueue-Composable gespiegelt (Singleton). Kein direktes fetch(), kein WebSocket.
//
// Layout: langgezogenes Querformat. Links die sortierte Jobliste (abgeschlossen -> aktiv ->
// wartend), rechts grossflaechig das Live-Terminal des laufenden Jobs.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useJavaQueue } from '../../composables/useJavaQueue.js'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'select'])

const { allJobs, liveByKey, cancelJob, cancelAllJobs, markAllRead } = useJavaQueue()

// Klick auf einen Queue-Eintrag -> Klasse im Analyzer oeffnen (wir sind schon im Code-View).
function openClass(j) {
  if (j.fileId == null) return
  emit('select', j.fileId)
}

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

// ESC schliesst das Modal, solange es offen ist.
function onKey(e) {
  if (e.key === 'Escape') emit('close')
}
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKey)
    else window.removeEventListener('keydown', onKey)
  },
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="queue-modal">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <section
          class="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
        >
          <!-- Kopfzeile: Titel + Zaehler + globale Aktionen + Schliessen -->
          <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:list-checks" class="h-5 w-5" />
              </span>
              <div class="min-w-0">
                <h2 class="text-lg font-bold leading-tight tracking-tight text-[var(--color-text)]">AI Queue</h2>
                <p class="truncate text-xs text-[var(--color-text-muted)]">
                  One unit per class: methods first, then the class summary – refreshes every 3&nbsp;seconds.
                </p>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                v-if="finishedCount"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                title="Mark all finished entries as read and hide them"
                @click="onMarkAllRead"
              >
                <Icon icon="lucide:check-circle" class="h-4 w-4" />
                Mark all read ({{ finishedCount }})
              </button>
              <button
                v-if="allJobs.length"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
                title="Cancel all jobs and clear the list"
                @click="onCancelAll"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
                Cancel all
              </button>
              <button
                type="button"
                class="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                title="Close"
                aria-label="Close"
                @click="emit('close')"
              >
                <Icon icon="lucide:x" class="h-5 w-5" />
              </button>
            </div>
          </header>

          <!-- Koerper: links Jobliste, rechts Live-Terminal (langgezogenes Querformat) -->
          <div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.1fr_0.9fr]">
            <!-- Linke Spalte: sortierte Jobliste -->
            <div class="flex min-h-0 flex-col border-b border-[var(--color-border)] lg:border-b-0 lg:border-r">
              <div v-if="ordered.length" class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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

                  <p v-if="j.ollamaUnavailable" class="mt-2 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                    <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
                    Ollama unreachable – using fallback text.
                  </p>
                </article>
              </div>

              <div v-else class="grid min-h-[14rem] flex-1 place-items-center px-6 text-center">
                <p class="text-sm text-slate-400">
                  No analysis started yet. Pick a class in the analyzer and start a summary,
                  or use “Analyze”.
                </p>
              </div>

              <p v-if="ordered.length" class="shrink-0 border-t border-[var(--color-border)] px-4 py-2 text-center text-xs text-slate-400">
                {{ activeCount }} active · {{ finishedCount }} finished
              </p>
            </div>

            <!-- Rechte Spalte: grossflaechiges Live-Terminal des laufenden Jobs -->
            <div class="flex min-h-0 flex-col p-4">
              <div class="mb-2 flex items-center justify-between gap-2">
                <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <Icon icon="lucide:terminal" class="h-3.5 w-3.5" />
                  Live output
                </span>
                <span
                  v-if="runningJob"
                  class="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-[var(--color-accent)]"
                >
                  <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
                  {{ runningLive ? runningLive.tokens : 0 }} tokens generated…
                </span>
              </div>

              <template v-if="runningJob">
                <div class="mb-2 flex min-w-0 items-center gap-2 text-sm">
                  <span class="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--color-accent)]">{{ phaseLabel(runningJob) }}</span>
                  <span class="min-w-0 flex-1 truncate font-semibold text-[var(--color-text)]">{{ runningJob.className }}</span>
                  <span class="shrink-0 tabular-nums text-xs text-[var(--color-text-muted)]">{{ runningJob.done }}/{{ runningJob.total }}</span>
                </div>
                <pre ref="logEl" class="queue-log min-h-0 flex-1">{{ (runningLive && runningLive.text) || 'Waiting for Ollama…' }}</pre>
                <!-- Indeterminierte Fortschritts-Bar: Ollama liefert keinen numerischen Fortschritt -->
                <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div class="queue-indeterminate h-full w-2/5 rounded-full bg-[var(--color-accent)]" />
                </div>
              </template>

              <div v-else class="grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/40 px-6 text-center">
                <p class="flex flex-col items-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <Icon icon="lucide:terminal" class="h-6 w-6 opacity-60" />
                  No analysis running. Live tokens appear here while a class is being summarized.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Funktionale Transition fuers Modal (Fade + leichtes Anheben). */
.queue-modal-enter-active,
.queue-modal-leave-active {
  transition: opacity 0.18s ease;
}
.queue-modal-enter-active section,
.queue-modal-leave-active section {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.queue-modal-enter-from,
.queue-modal-leave-to {
  opacity: 0;
}
.queue-modal-enter-from section,
.queue-modal-leave-to section {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

/* Abgedunkelter Terminal-/Log-Bereich: scrollbar, monospace. Auch im Light-Mode ein Terminal. */
.queue-log {
  @apply overflow-y-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-[11px] leading-relaxed;
  background-color: #0f172a; /* slate-900 */
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
