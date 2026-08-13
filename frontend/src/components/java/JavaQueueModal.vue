<script setup>
// Breites Modal aller KI-Analyse-Einheiten (eine Einheit pro Klasse: Methoden -> Klasse) der
// Java-Analyse. Loest den frueheren eigenstaendigen Queue-Tab ab und sitzt jetzt im Code-View.
// Der Zustand liegt im Backend; hier wird er per HTTP-Polling (3 s) ueber das gemeinsame
// useJavaQueue-Composable gespiegelt (Singleton). Kein direktes fetch(), kein WebSocket.
//
// Layout: langgezogenes Querformat. Links die sortierte Jobliste (abgeschlossen -> aktiv ->
// wartend), rechts grossflaechig das Live-Terminal des laufenden Jobs.
import { computed, nextTick, ref, watch } from 'vue'
import { useJavaQueue, isFinishedStatus as isFinished } from '../../composables/useJavaQueue.js'
import { Icon } from '../../lib/icons.js'
import { formatEta } from '../../lib/format.js'
import Modal from '../ui/Modal.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'select'])

const { allJobs, summary, liveByKey, cancelJob, cancelAllJobs, markAllRead, ensurePolling } = useJavaQueue()

// Solange das Modal offen ist, wird die VOLLE Job-Liste gepollt – sie ist hier die Hauptanzeige.
// Geschlossen laeuft nur die kompakte Bilanz (bei 1000 Jobs waeren das sonst ~390 KB alle 3 s).
let releaseDetail = null
watch(
  () => props.open,
  (open) => {
    if (open && !releaseDetail) releaseDetail = ensurePolling({ detail: true })
    else if (!open && releaseDetail) {
      releaseDetail()
      releaseDetail = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => releaseDetail?.())

// Gesamtfortschritt (Server-Bilanz): Klassen-Quote + Restzeit. Bei hunderten Klassen ist das die
// eigentliche Information – die Einzelliste sagt nur, was gerade passiert.
const overall = computed(() => {
  const s = summary.value
  if (!s || !s.total) return null
  return {
    total: s.total,
    finished: s.finished,
    percent: s.unitsTotal ? Math.min(100, Math.round((s.unitsDone / s.unitsTotal) * 100)) : 0,
    eta: formatEta(s.etaMs),
    active: s.running > 0 || s.queued > 0,
  }
})

// Klick auf einen Queue-Eintrag -> Klasse im Analyzer oeffnen (wir sind schon im Code-View).
function openClass(j) {
  if (j.fileId == null) return
  emit('select', j.fileId)
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
  queued: { label: 'Queued', cls: 'badge-muted' },
  running: { label: 'Active', cls: 'badge-accent' },
  done: { label: 'Done', cls: 'badge-success' },
  'done-with-errors': { label: 'Done (with errors)', cls: 'badge-warning' },
  failed: { label: 'Failed', cls: 'badge-danger' },
  cancelled: { label: 'Cancelled', cls: 'badge-muted' },
}
function statusInfo(s) {
  return STATUS[s] || { label: s, cls: 'badge-muted' }
}
// Kompaktes Erfolgs-/Status-Icon fuer abgeschlossene Jobs.
const FINISHED_ICON = {
  done: { icon: 'lucide:check-circle', cls: 'text-success' },
  'done-with-errors': { icon: 'lucide:alert-triangle', cls: 'text-warning' },
  failed: { icon: 'lucide:alert-triangle', cls: 'text-danger' },
  cancelled: { icon: 'lucide:x', cls: 'text-muted' },
}
function finishedIcon(s) {
  return FINISHED_ICON[s] || { icon: 'lucide:check-circle', cls: 'text-muted' }
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

// ESC liegt jetzt an `ui/Modal` (`close-on-escape`) – derselbe Listener, nur nicht mehr hier.
</script>

<template>
  <!-- `close-on-escape`: dieses Modal brachte seinen eigenen Escape-Listener mit und behaelt das
       Verhalten. Es gehoert keiner uebergeordneten Vorrangordnung an – anders als das
       Analyse-Modal in CodeView, das erst schliessen darf, wenn kein Konflikt-Dialog darueber
       liegt. -->
  <Modal
    :open="open"
    size="full"
    max-height="max-h-[85vh]"
    label="AI queue"
    close-on-escape
    @close="emit('close')"
  >
    <!-- Kopfzeile: Titel + Zaehler + globale Aktionen + Schliessen -->
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
      <div class="flex min-w-0 items-center gap-2.5">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon icon="lucide:list-checks" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h2 class="text-lg font-bold leading-tight tracking-tight text-ink">AI Queue</h2>
          <p class="truncate text-xs text-muted">
            One unit per class: methods first, then the class summary – refreshes every 3&nbsp;seconds.
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="finishedCount"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-success transition hover:bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)]"
          title="Mark all finished entries as read and hide them"
          @click="onMarkAllRead"
        >
          <Icon icon="lucide:check-circle" class="h-4 w-4" />
          Mark all read ({{ finishedCount }})
        </button>
        <button
          v-if="allJobs.length"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-danger transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]"
          title="Cancel all jobs and clear the list"
          @click="onCancelAll"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Cancel all
        </button>
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface-offset hover:text-ink"
          title="Close"
          aria-label="Close"
          @click="emit('close')"
        >
          <Icon icon="lucide:x" class="h-5 w-5" />
        </button>
      </div>
    </header>

    <!-- Gesamtfortschritt: bei hunderten Klassen laeuft die Queue lange – wie weit sie ist
         und wie lange es noch dauert, gehoert deshalb ueber die Einzelliste, nicht hinein. -->
    <div v-if="overall" class="shrink-0 border-b border-line bg-surface px-5 py-3">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="font-mono text-sm font-semibold tabular-nums text-ink">
          {{ overall.finished }}<span class="text-muted">/{{ overall.total }}</span>
        </span>
        <span class="text-xs text-muted">classes analyzed</span>
        <span class="font-mono text-xs tabular-nums text-muted">{{ overall.percent }}%</span>
        <span v-if="overall.eta" class="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-lavender">
          <Icon icon="lucide:clock" class="h-3.5 w-3.5" />
          {{ overall.eta }} remaining
        </span>
        <span v-else-if="!overall.active" class="ml-auto inline-flex items-center gap-1.5 text-xs text-success">
          <Icon icon="lucide:check-circle" class="h-3.5 w-3.5" />
          All done
        </span>
      </div>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-offset">
        <div
          class="h-full rounded-full transition-[width] duration-500 ease-out"
          :class="overall.active ? 'bg-lavender' : 'bg-success'"
          :style="{ width: Math.max(overall.percent, overall.finished ? 2 : 0) + '%' }"
        />
      </div>
    </div>

    <!-- Koerper: links Jobliste, rechts Live-Terminal (langgezogenes Querformat) -->
    <div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.1fr_0.9fr]">
      <!-- Linke Spalte: sortierte Jobliste -->
      <div class="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
        <div v-if="ordered.length" class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <article
            v-for="j in ordered"
            :key="j.fileId"
            class="rounded-2xl border border-line bg-surface p-4 transition"
            :class="j.status === 'running' ? 'ring-1 ring-accent/40' : ''"
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
                class="h-4 w-4 shrink-0 animate-spin text-accent"
              />
              <Icon v-else icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-muted" />

              <span class="badge-lavender rounded px-1.5 py-0.5 text-3xs font-semibold uppercase">
                AI analysis
              </span>
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left font-semibold text-ink transition hover:text-accent"
                :title="`Open ${j.className} in the analyzer`"
                @click="openClass(j)"
              >{{ j.className }}</button>
              <span class="rounded-md px-2 py-0.5 text-2xs font-semibold" :class="statusInfo(j.status).cls">{{ statusInfo(j.status).label }}</span>
              <span v-if="j.finishedAt && isFinished(j.status)" class="shrink-0 text-2xs text-muted">{{ fmtTime(j.finishedAt) }}</span>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-muted transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] hover:text-danger"
                :title="isFinished(j.status) ? 'Remove from list' : 'Cancel job'"
                :aria-label="isFinished(j.status) ? 'Remove from list' : 'Cancel job'"
                @click.stop="onCancel(j)"
              >
                <Icon icon="lucide:x" class="h-4 w-4" />
              </button>
            </div>
            <p v-if="j.package" class="mb-2 truncate font-mono text-2xs text-muted">{{ j.package }}</p>

            <div class="mb-1.5 flex items-center justify-between text-xs">
              <span class="flex min-w-0 items-center gap-1.5" :class="j.status === 'running' ? 'text-accent' : 'text-muted'">
                <template v-if="j.status === 'running'">
                  <span class="rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-semibold uppercase text-accent">{{ phaseLabel(j) }}</span>
                  <span class="truncate">
                    <template v-if="j.current">{{ j.current.name }}<template v-if="j.phase !== 'class'">()</template></template>
                    <template v-else>preparing…</template>
                  </span>
                </template>
                <template v-else-if="j.status === 'queued'">waiting…</template>
                <template v-else>{{ j.done }}/{{ j.total }} steps<template v-if="j.failed"> · {{ j.failed }} errors</template></template>
              </span>
              <span class="shrink-0 tabular-nums text-muted">{{ j.done }}/{{ j.total }}</span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-surface-offset">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="j.status === 'failed' ? 'bg-danger' : j.status === 'done-with-errors' ? 'bg-warning' : isFinished(j.status) ? 'bg-success' : 'bg-accent'"
                :style="{ width: percent(j) + '%' }"
              />
            </div>

            <p v-if="j.ollamaUnavailable" class="mt-2 flex items-center gap-1 text-2xs text-warning">
              <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
              Ollama unreachable – using fallback text.
            </p>
          </article>
        </div>

        <div v-else class="grid min-h-[14rem] flex-1 place-items-center px-6 text-center">
          <p class="text-sm text-muted">
            No analysis started yet. Pick a class in the analyzer and start a summary,
            or use “Analyze”.
          </p>
        </div>

        <p v-if="ordered.length" class="shrink-0 border-t border-line px-4 py-2 text-center text-xs text-muted">
          {{ activeCount }} active · {{ finishedCount }} finished
        </p>
      </div>

      <!-- Rechte Spalte: grossflaechiges Live-Terminal des laufenden Jobs -->
      <div class="flex min-h-0 flex-col p-4">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
            <Icon icon="lucide:terminal" class="h-3.5 w-3.5" />
            Live output
          </span>
          <span
            v-if="runningJob"
            class="flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-accent"
          >
            <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
            {{ runningLive ? runningLive.tokens : 0 }} tokens generated…
          </span>
        </div>

        <template v-if="runningJob">
          <div class="mb-2 flex min-w-0 items-center gap-2 text-sm">
            <span class="rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-semibold uppercase text-accent">{{ phaseLabel(runningJob) }}</span>
            <span class="min-w-0 flex-1 truncate font-semibold text-ink">{{ runningJob.className }}</span>
            <span class="shrink-0 tabular-nums text-xs text-muted">{{ runningJob.done }}/{{ runningJob.total }}</span>
          </div>
          <pre ref="logEl" class="queue-log min-h-0 flex-1">{{ (runningLive && runningLive.text) || 'Waiting for Ollama…' }}</pre>
          <!-- Indeterminierte Fortschritts-Bar: Ollama liefert keinen numerischen Fortschritt -->
          <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-offset">
            <div class="queue-indeterminate h-full w-2/5 rounded-full bg-accent" />
          </div>
        </template>

        <div v-else class="grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed border-line bg-surface/40 px-6 text-center">
          <p class="flex flex-col items-center gap-2 text-sm text-muted">
            <Icon icon="lucide:terminal" class="h-6 w-6 opacity-60" />
            No analysis running. Live tokens appear here while a class is being summarized.
          </p>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
@reference "../../assets/style.css";
/* Die eigene `queue-modal`-Transition ist entfallen – sie steht jetzt in `ui/Modal.vue`. */

/* Abgedunkelter Terminal-/Log-Bereich: scrollbar, monospace. Auch im Light-Mode ein Terminal. */
.queue-log {
  @apply overflow-y-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-2xs leading-relaxed;
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
