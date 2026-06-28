<script setup>
// Statusseite aller KI-Generierungs-Queues (Klassen- & Methoden-Queues) der Java-Analyse.
// Der Zustand liegt im Backend; hier wird er per HTTP-Polling (3 s) ueber das gemeinsame
// useJavaQueue-Composable gespiegelt. Kein direktes fetch(), kein WebSocket.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { allJobs, liveByKey, ensurePolling, cancelJob, cancelAllJobs } = useJavaQueue()
const { lastFileId } = useJavaAnalyzer()

// Klick auf einen Queue-Eintrag -> in den Code-Analyzer wechseln und die Klasse direkt oeffnen.
// Wiederverwendung des bestehenden lastFileId-Hand-offs: CodeView selektiert sie beim Mount.
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

// Aktive Jobs: laufender Job IMMER ganz oben, darunter die wartenden – neueste zuerst
// (absteigend nach Einreih-Zeitpunkt). Bei einem sequentiellen Worker laeuft hoechstens einer.
const active = computed(() => {
  const running = allJobs.value.filter((j) => j.status === 'running')
  const queued = allJobs.value
    .filter((j) => j.status === 'queued')
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
  return [...running, ...queued]
})
const finished = computed(() =>
  allJobs.value.filter((j) => j.status !== 'running' && j.status !== 'queued'),
)

// Job-Key + Live-Daten (SSE-Puffer, Fallback auf das Polling-Snapshot nach einem Reload).
function jobKey(j) {
  return j.fileId + ':' + j.kind
}
function liveFor(j) {
  const k = jobKey(j)
  return liveByKey.value[k] || { text: j.liveText || '', tokens: j.tokenCount || 0, phase: j.status }
}

// Genau ein laufender Job -> dessen Live-Text fuer Auto-Scroll beobachten.
const runningJob = computed(() => active.value.find((j) => j.status === 'running') || null)
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
  queued: { label: 'In Warteschlange', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  running: { label: 'Aktiv', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  done: { label: 'Fertig', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  'done-with-errors': { label: 'Fertig (mit Fehlern)', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  failed: { label: 'Fehlgeschlagen', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
  cancelled: { label: 'Abgebrochen', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
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
function percent(j) {
  if (!j.total) return j.status === 'done' ? 100 : 0
  return Math.round(((j.done + j.failed) / j.total) * 100)
}
function fmtTime(s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? '' : d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Cancel-Handler: Fehler still schlucken (z. B. wenn der Job serverseitig schon weg ist) –
// das optimistische Entfernen im Composable hat die UI ohnehin bereits aktualisiert.
async function onCancel(j) {
  try {
    await cancelJob(j.fileId, j.kind)
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
</script>

<template>
  <div class="mx-auto max-w-4xl px-5 py-6">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">KI-Queues</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          Klassen- &amp; Methoden-Zusammenfassungen laufen im Hintergrund – aktualisiert alle 3&nbsp;Sekunden.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="allJobs.length"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          title="Alle Jobs abbrechen und die Liste leeren"
          @click="onCancelAll"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Alle abbrechen
        </button>
        <RouterLink
          to="/code"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Icon icon="lucide:chevron-left" class="h-4 w-4" />
          Zum Analyzer
        </RouterLink>
      </div>
    </div>

    <!-- Aktive Queues -->
    <section class="mb-8">
      <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <span class="relative flex h-2 w-2">
          <span v-if="active.length" class="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-75" />
          <span class="relative inline-flex h-2 w-2 rounded-full" :class="active.length ? 'bg-[var(--color-accent)]' : 'bg-slate-300 dark:bg-slate-600'" />
        </span>
        Aktiv ({{ active.length }})
      </h2>
      <div v-if="active.length" class="space-y-3">
        <article
          v-for="j in active"
          :key="j.fileId + ':' + j.kind"
          class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
        >
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="j.kind === 'class' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'">
              {{ j.kind === 'class' ? 'Klasse' : 'Methoden' }}
            </span>
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left font-semibold text-slate-800 transition hover:text-[var(--color-accent)] dark:text-slate-100"
              :title="`${j.className} im Analyzer öffnen`"
              @click="openClass(j)"
            >{{ j.className }}</button>
            <span class="rounded-md px-2 py-0.5 text-[11px] font-semibold" :class="statusInfo(j.status).cls">{{ statusInfo(j.status).label }}</span>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
              title="Job abbrechen"
              aria-label="Job abbrechen"
              @click.stop="onCancel(j)"
            >
              <Icon icon="lucide:x" class="h-4 w-4" />
            </button>
          </div>
          <p v-if="j.package" class="mb-2 truncate font-mono text-[11px] text-slate-400">{{ j.package }}</p>

          <div class="mb-1.5 flex items-center justify-between text-xs">
            <span class="flex min-w-0 items-center gap-1.5 text-[var(--color-accent)]">
              <Icon v-if="j.status === 'running'" icon="lucide:loader-2" class="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span class="truncate">
                <template v-if="j.current">{{ j.current.name }}()</template>
                <template v-else>vorbereiten…</template>
              </span>
            </span>
            <span class="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{{ j.done }}/{{ j.total }}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div class="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300" :style="{ width: percent(j) + '%' }" />
          </div>

          <!-- Live-Terminal: Token-by-Token-Ausgabe von Ollama (nur fuer den laufenden Job) -->
          <div v-if="j.status === 'running'" class="mt-3">
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <Icon icon="lucide:terminal" class="h-3.5 w-3.5" />
                Live-Ausgabe
              </span>
              <span class="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-[var(--color-accent)]">
                <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
                {{ liveFor(j).tokens }} Tokens generiert…
              </span>
            </div>
            <pre ref="logEl" class="queue-log">{{ liveFor(j).text || 'Warte auf Ollama…' }}</pre>
            <!-- Indeterminierte Fortschritts-Bar: Ollama liefert keinen numerischen Fortschritt -->
            <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div class="queue-indeterminate h-full w-2/5 rounded-full bg-[var(--color-accent)]" />
            </div>
          </div>

          <p v-if="j.ollamaUnavailable" class="mt-2 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
            Ollama nicht erreichbar – Fallback-Text wird verwendet.
          </p>
        </article>
      </div>
      <p v-else class="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400 dark:border-slate-800">
        Keine laufenden Queues.
      </p>
    </section>

    <!-- Abgeschlossene Queues -->
    <section v-if="finished.length">
      <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Abgeschlossen ({{ finished.length }})
      </h2>
      <div class="space-y-2">
        <article
          v-for="j in finished"
          :key="j.fileId + ':' + j.kind"
          class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <Icon :icon="finishedIcon(j.status).icon" class="h-4 w-4 shrink-0" :class="finishedIcon(j.status).cls" />
          <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="j.kind === 'class' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'">
            {{ j.kind === 'class' ? 'Klasse' : 'Methoden' }}
          </span>
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left font-medium text-slate-700 transition hover:text-[var(--color-accent)] dark:text-slate-200"
            :title="`${j.className} im Analyzer öffnen`"
            @click="openClass(j)"
          >{{ j.className }}</button>
          <span class="shrink-0 tabular-nums text-xs text-slate-400">{{ j.done }}/{{ j.total }}<template v-if="j.failed"> · {{ j.failed }} Fehler</template></span>
          <span v-if="j.finishedAt" class="shrink-0 text-[11px] text-slate-400">{{ fmtTime(j.finishedAt) }}</span>
          <span class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold" :class="statusInfo(j.status).cls">{{ statusInfo(j.status).label }}</span>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
            title="Aus der Liste entfernen"
            aria-label="Aus der Liste entfernen"
            @click.stop="onCancel(j)"
          >
            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
          </button>
        </article>
      </div>
    </section>

    <p v-if="!active.length && !finished.length" class="mt-10 text-center text-sm text-slate-400">
      Noch keine Queues gestartet. Wähle im Analyzer eine Klasse und starte eine Zusammenfassung.
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
