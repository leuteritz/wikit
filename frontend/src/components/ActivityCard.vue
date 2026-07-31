<script setup>
// Was gerade laeuft – in der Sidebar, also auf JEDER Ansicht.
//
// Der Grund fuer diese Karte: Import, Reset, Kanten-Neuberechnung und die KI-Queue laufen auf dem
// SERVER. Wer waehrend eines Massen-Imports ins Wiki wechselt, hat den Lauf nicht abgebrochen – er
// sah ihn nur nicht mehr, denn der Fortschritt hing an der Code-Ansicht. Die Sidebar ist der eine
// Ort, der ueberall steht.
//
// Sie ersetzt im Lauf die Kuerzel-Liste darunter (Platz ist dort ohnehin fuer eine Sache) und
// verschwindet danach wieder – ein Fortschrittsbereich, der dauerhaft leer herumsteht, ist keine
// Auskunft, sondern nur eine Zeile weniger fuer die Kuerzel.
//
// ALLE Zahlen stammen aus `useActivity` und werden hier NICHT nachgerechnet: der Ring im
// Import-Modal zeigt denselben Lauf, und zwei Rechnungen ueber denselben Stand sind zwei
// Gelegenheiten, verschiedene Prozentzahlen zu behaupten.
import { computed } from 'vue'
import { Icon } from '../lib/icons.js'
import { formatDuration, formatEta } from '../lib/format.js'
import { useActivity } from '../composables/useActivity.js'

const {
  run,
  progress,
  elapsedMs,
  activePhases,
  phaseIndex,
  phaseFill,
  runPercent,
  runRemainingMs,
  runPhaseLabel,
  runPhaseUnit,
  runTitle,
  runIcon,
  queue,
  result,
  busy,
  anything,
} = useActivity()

const nf = new Intl.NumberFormat()

// Der Zaehler zaehlt nur dort, wo die Phase einen liefert (die Schreibphase kann keinen – die
// SQLite-Transaktion blockiert bis zum Commit). Eine „0/0" waere dort eine Aussage ueber den
// Deckel, nicht ueber den Lauf.
const counter = computed(() => {
  const p = progress.value
  if (!p?.total) return ''
  return `${nf.format(p.done || 0)} / ${nf.format(p.total)}${runPhaseUnit.value ? ` ${runPhaseUnit.value}` : ''}`
})

// Woran die KI gerade arbeitet. Bei grossen Queues faellt die Detailliste weg, `current` bleibt
// besetzt – deshalb haengt die Auskunft daran.
const queueDetail = computed(() => {
  const q = queue.value
  if (!q) return ''
  if (q.className) return q.phase === 'class' ? `${q.className} · summary` : q.className
  return `${q.classesLeft} class(es) left`
})
</script>

<template>
  <!-- Nur im breiten Layout: in der 4-rem-Spalte waere eine Phasenleiste unlesbar. Dort tritt der
       Ring am Code-Symbol an ihre Stelle (App.vue). -->
  <div v-if="anything" class="mb-3 hidden lg:block">
    <!-- ===================== Abgeschlossen ===================== -->
    <!-- Das Ergebnis bleibt kurz stehen (useActivity: RESULT_LINGER_MS). Das Erfolgs-Toast
         erscheint dort, wo der Lauf gestartet wurde – also genau in der Ansicht, die man
         verlassen hat. Ohne diese Zeile erfaehrt man den Ausgang gar nicht. -->
    <div
      v-if="!busy && result"
      class="rounded-lg border px-2.5 py-2"
      :style="{
        borderColor: `color-mix(in srgb, ${result.ok ? 'var(--color-success)' : 'var(--color-danger)'} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${result.ok ? 'var(--color-success)' : 'var(--color-danger)'} 10%, transparent)`,
      }"
    >
      <div class="flex items-center gap-2">
        <Icon
          :icon="result.ok ? 'lucide:check-circle' : 'lucide:alert-triangle'"
          class="h-4 w-4 shrink-0"
          :style="{ color: result.ok ? 'var(--color-success)' : 'var(--color-danger)' }"
        />
        <!-- `title`, weil eine Fehlermeldung laenger sein kann als die Spalte breit ist – und dann
             steht dort ein abgeschnittener Grund. Der volle Text kommt zusaetzlich als Toast. -->
        <span class="min-w-0 flex-1 truncate text-2xs font-medium text-[var(--color-text)]" :title="result.message">{{ result.message }}</span>
      </div>
    </div>

    <template v-else>
      <!-- ===================== Laufender Server-Lauf ===================== -->
      <div
        v-if="run"
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
      >
        <div class="mb-1.5 flex items-center gap-1.5">
          <Icon :icon="runIcon" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span class="min-w-0 flex-1 truncate font-mono text-[0.59375rem] font-semibold uppercase tracking-[0.14em] text-[var(--color-accent)]">
            {{ runTitle }}
          </span>
          <span class="shrink-0 font-mono text-2xs font-semibold tabular-nums text-[var(--color-accent)]">{{ runPercent }}%</span>
        </div>

        <!-- Gesamtquote -->
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
          <div
            class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out"
            :style="{ width: runPercent + '%' }"
          />
        </div>

        <!-- Was gerade passiert, und woran es sich bemisst -->
        <p class="mt-2 truncate text-xs font-medium text-[var(--color-text)]">{{ runPhaseLabel }}</p>
        <p v-if="counter" class="mt-0.5 truncate font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">
          {{ counter }}
        </p>

        <!-- Ein Segment je Phase: der Lauf hat mehrere Abschnitte, und „63 %" allein sagt nicht,
             wieviel davon noch aussteht. Die Breite folgt dem GEMESSENEN Zeitanteil, nicht der
             Anzahl – sonst sieht die laengste Phase aus wie die kuerzeste. -->
        <div class="mt-2 flex gap-px" :title="activePhases.map((p) => p.label).join(' → ')">
          <div
            v-for="(p, i) in activePhases"
            :key="p.key"
            class="h-1 overflow-hidden rounded-sm bg-[var(--color-surface-offset)]"
            :style="{ flexGrow: p.weight }"
          >
            <div
              class="h-full rounded-sm transition-[width] duration-300 ease-out"
              :style="{
                width: phaseFill(i) * 100 + '%',
                backgroundColor: i < phaseIndex ? 'var(--color-success)' : 'var(--color-accent)',
              }"
            />
          </div>
        </div>

        <div class="mt-1.5 flex items-baseline justify-between gap-2 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">
          <span>{{ formatDuration(elapsedMs) }} <span class="opacity-60">elapsed</span></span>
          <span v-if="runRemainingMs != null">~{{ formatDuration(runRemainingMs) }} <span class="opacity-60">left</span></span>
        </div>
      </div>

      <!-- ===================== KI-Queue ===================== -->
      <!-- Eigener Block statt einer zweiten Prozentzahl im selben: Import und KI-Analyse laufen
           nach einem Paste GLEICHZEITIG (CodeView reiht die frisch importierten Klassen ein), und
           es sind zwei verschiedene Arbeiten mit zwei verschiedenen Enden. Eine gemeinsame Quote
           waere eine erfundene Zahl. -->
      <div
        v-if="queue"
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
        :class="run ? 'mt-1.5' : ''"
      >
        <div class="mb-1.5 flex items-center gap-1.5">
          <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span class="min-w-0 flex-1 truncate font-mono text-[0.59375rem] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
            AI analysis
          </span>
          <span class="shrink-0 font-mono text-2xs font-semibold tabular-nums text-[var(--color-text-muted)]">{{ queue.percent }}%</span>
        </div>

        <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
          <div
            class="h-full rounded-full bg-[var(--color-accent)] opacity-70 transition-[width] duration-300 ease-out"
            :style="{ width: queue.percent + '%' }"
          />
        </div>

        <p class="mt-2 truncate text-xs font-medium text-[var(--color-text)]" :title="queueDetail">{{ queueDetail }}</p>
        <div class="mt-0.5 flex items-baseline justify-between gap-2 font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">
          <span>{{ nf.format(queue.done) }} / {{ nf.format(queue.total) }} <span class="opacity-60">steps</span></span>
          <span v-if="formatEta(queue.etaMs)">{{ formatEta(queue.etaMs) }}</span>
        </div>
        <!-- Die Parallelitaet steht nur da, wenn sie vom Normalfall abweicht: bei 1 waere sie eine
             Zahl ohne Aussage. Sie erklaert, warum die Restzeit kleiner ist als Schritte × Dauer. -->
        <p v-if="queue.parallel > 1" class="mt-0.5 truncate text-2xs text-[var(--color-text-muted)]">
          {{ queue.parallel }} in parallel
        </p>
      </div>
    </template>
  </div>
</template>
