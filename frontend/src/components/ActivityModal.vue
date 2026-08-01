<script setup>
// Das Detailfenster hinter der Sidebar-Karte.
//
// Die Karte beantwortet „laeuft etwas, und wie weit?" – auf 13 rem Breite. Alles Weitere (welche
// Phase, wie lange schon, wie lange noch, was die KI-Queue gerade tut, wie der letzte Lauf ausging)
// passt dort nicht hin und stand vorher NUR in der Kopfzeile der Code-Ansicht. Wer waehrend eines
// Imports ins Wiki wechselte, kam an diese Zahlen gar nicht mehr heran.
//
// Der Fortschritt selbst kommt aus `ActivityProgress` – derselben Komponente, die auch das
// „Add code"-Modal zeigt. Zwei Abschriften waeren zwei Gelegenheiten, verschiedene Prozentzahlen zu
// behaupten.
import { computed } from 'vue'
import { Icon } from '../lib/icons.js'
import { formatDuration, formatEta } from '../lib/format.js'
import { useActivity } from '../composables/useActivity.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import ActivityProgress from './ActivityProgress.vue'

const {
  run,
  runTitle,
  runIcon,
  queue,
  busy,
  detailOpen,
  closeDetail,
  lastRun,
  lastRunAgo,
  lastRunTitle,
  lastRunIcon,
} = useActivity()
const { files } = useJavaAnalyzer()

const nf = new Intl.NumberFormat()

// Bestand. Dieselbe Rechnung wie die Metriken der Code-Ansicht – im Ruhezustand ist „was liegt
// ueberhaupt da?" die Frage, die an die Stelle des Fortschritts tritt.
const stock = computed(() => {
  const list = files.value || []
  return {
    classes: list.length,
    packages: new Set(list.map((f) => f.package || '(default)')).size,
    analyzed: list.filter((f) => f.description).length,
  }
})

// Woran die KI gerade arbeitet (gleiche Regel wie in der Karte: `current` bleibt auch dann besetzt,
// wenn bei grossen Queues die Detailliste wegfaellt).
const queueDetail = computed(() => {
  const q = queue.value
  if (!q) return ''
  if (q.className) return q.phase === 'class' ? `${q.className} · class summary` : `${q.className} · methods`
  return `${q.classesLeft} class(es) left`
})

const headTitle = computed(() => (run.value ? runTitle.value : queue.value ? 'AI analysis' : 'Activity'))
const headIcon = computed(() => (run.value ? runIcon.value : queue.value ? 'lucide:sparkles' : 'lucide:activity'))
</script>

<template>
  <Teleport to="body">
    <Transition name="act-modal">
      <div
        v-if="detailOpen"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="closeDetail"
      >
        <section
          class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-xl"
          role="dialog"
          aria-label="Activity"
        >
          <!-- Kopf: was laeuft, nicht wo man ist -->
          <header class="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
            <span
              class="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              :class="busy ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-surface-offset)] text-[var(--color-text-muted)]'"
            >
              <Icon :icon="headIcon" class="h-[18px] w-[18px]" :class="run ? 'animate-pulse' : ''" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="truncate font-mono text-[0.9375rem] font-semibold tracking-tight text-[var(--color-text)]">{{ headTitle }}</h2>
              <p class="truncate text-2xs text-[var(--color-text-muted)]">
                {{ busy ? 'Runs on the server — it continues while you work elsewhere.' : 'Nothing is running on the server right now.' }}
              </p>
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Close"
              aria-label="Close"
              @click="closeDetail"
            >
              <Icon icon="lucide:x" class="h-5 w-5" />
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <!-- ============ Laufender Server-Lauf ============ -->
            <ActivityProgress v-if="run">
              <template #note>Closing this window does not stop anything.</template>
            </ActivityProgress>

            <!-- ============ KI-Queue ============ -->
            <!-- Eigener Abschnitt statt einer zweiten Prozentzahl im selben: Import und KI-Analyse
                 laufen nach einem Paste gleichzeitig und enden zu verschiedenen Zeitpunkten. Eine
                 gemeinsame Quote waere eine erfundene Zahl. -->
            <div v-if="queue" class="border-t border-[var(--color-border)] px-5 py-4" :class="run ? '' : 'border-t-0'">
              <div class="mb-2 flex items-center gap-2">
                <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-[var(--color-lavender)]" />
                <span class="font-mono text-2xs font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">AI analysis</span>
                <span class="ml-auto font-mono text-sm font-semibold tabular-nums text-[var(--color-lavender)]">{{ queue.percent }}%</span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                <div
                  class="h-full rounded-full bg-[var(--color-lavender)] transition-[width] duration-500 ease-out"
                  :style="{ width: queue.percent + '%' }"
                />
              </div>
              <p class="mt-2.5 truncate text-sm font-medium text-[var(--color-text)]">{{ queueDetail }}</p>
              <div class="mt-3 grid grid-cols-3 gap-2">
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-center">
                  <div class="font-mono text-base font-semibold tabular-nums text-[var(--color-text)]">{{ nf.format(queue.done) }}<span class="text-[var(--color-text-muted)]">/{{ nf.format(queue.total) }}</span></div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">steps</div>
                </div>
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-center">
                  <div class="font-mono text-base font-semibold tabular-nums text-[var(--color-text)]">{{ formatEta(queue.etaMs) || '–' }}</div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">remaining</div>
                </div>
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-center">
                  <div class="font-mono text-base font-semibold tabular-nums text-[var(--color-text)]">{{ queue.classesLeft }}</div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">classes left</div>
                </div>
              </div>
              <!-- Die Parallelitaet steht nur da, wenn sie vom Normalfall abweicht: bei 1 waere sie
                   eine Zahl ohne Aussage. Sie erklaert, warum die Restzeit kleiner ist als
                   Schritte × Dauer. -->
              <p v-if="queue.parallel > 1" class="mt-2 text-2xs text-[var(--color-text-muted)]">
                {{ queue.parallel }} classes in parallel — the topological order softens up while they overlap.
              </p>
            </div>

            <!-- ============ Ruhezustand ============ -->
            <div v-if="!busy" class="px-5 py-6">
              <div class="grid grid-cols-3 gap-2">
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-center">
                  <div class="font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]">{{ nf.format(stock.classes) }}</div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">classes</div>
                </div>
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-center">
                  <div class="font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]">{{ nf.format(stock.packages) }}</div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">packages</div>
                </div>
                <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-center">
                  <div class="font-mono text-xl font-semibold tabular-nums text-[var(--color-text)]">{{ nf.format(stock.analyzed) }}</div>
                  <div class="mt-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">summarized</div>
                </div>
              </div>

              <!-- Der letzte Lauf. Ohne ihn waere „nichts laeuft" die ganze Auskunft – und wer
                   waehrend eines Imports die Ansicht gewechselt hat, erfuehre nie, wie er ausging. -->
              <div
                v-if="lastRun"
                class="mt-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3"
                :style="{
                  borderColor: `color-mix(in srgb, ${lastRun.ok ? 'var(--color-success)' : 'var(--color-danger)'} 35%, transparent)`,
                  backgroundColor: `color-mix(in srgb, ${lastRun.ok ? 'var(--color-success)' : 'var(--color-danger)'} 8%, transparent)`,
                }"
              >
                <Icon
                  :icon="lastRun.ok ? 'lucide:check-circle' : 'lucide:alert-triangle'"
                  class="mt-0.5 h-4 w-4 shrink-0"
                  :style="{ color: lastRun.ok ? 'var(--color-success)' : 'var(--color-danger)' }"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-[var(--color-text)]">{{ lastRun.message }}</p>
                  <p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-2xs text-[var(--color-text-muted)]">
                    <Icon :icon="lastRunIcon" class="h-3 w-3" />
                    <span>{{ lastRunTitle }}</span>
                    <span class="opacity-40">·</span>
                    <span>{{ lastRunAgo }}</span>
                    <template v-if="lastRun.durationMs">
                      <span class="opacity-40">·</span>
                      <span>took {{ formatDuration(lastRun.durationMs) }}</span>
                    </template>
                  </p>
                </div>
              </div>
              <p v-else class="mt-4 text-xs text-[var(--color-text-muted)]">
                Imports, resets, edge recomputes and AI runs show up here — including the ones you started
                in another view.
              </p>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../assets/style.css";

/* Funktionale Transition (Fade + leichtes Anheben) – dieselbe Sprache wie die uebrigen Modals. */
.act-modal-enter-active,
.act-modal-leave-active {
  transition: opacity 0.16s ease;
}
.act-modal-enter-from,
.act-modal-leave-to {
  opacity: 0;
}
.act-modal-enter-active section,
.act-modal-leave-active section {
  transition: transform 0.16s ease;
}
.act-modal-enter-from section,
.act-modal-leave-to section {
  transform: translateY(8px) scale(0.99);
}
</style>
