<script setup>
// EINE Form fuer „wie weit ist der Lauf?" – Ring, Phasenkette, verstrichene und geschaetzte Zeit.
//
// Sie stand woertlich im Import-Modal der Code-Ansicht. Seit die Sidebar-Karte ein eigenes
// Detailfenster oeffnet, gibt es zwei Stellen, die denselben Lauf ausfuehrlich zeigen – und zwei
// Abschriften derselben Anzeige waeren zwei Gelegenheiten, verschiedene Zahlen zu behaupten
// (dieselbe Begruendung wie bei `BusyState`).
//
// ALLE Werte stammen aus `useActivity`; hier wird nichts nachgerechnet.
import { Icon } from '../lib/icons.js'
import { formatDuration } from '../lib/format.js'
import { useActivity } from '../composables/useActivity.js'

const {
  progress,
  activePhases,
  phaseIndex,
  runPercent,
  runPhaseLabel,
  runPhaseUnit,
  runRemainingMs,
  elapsedMs,
} = useActivity()

const nf = new Intl.NumberFormat()
</script>

<template>
  <div v-if="progress" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-8">
    <!-- Ring: Gesamtquote aus den gewichteten Server-Phasen. -->
    <div class="relative grid h-44 w-44 shrink-0 place-items-center">
      <svg class="h-44 w-44 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="54" fill="none" stroke="var(--color-surface-offset)" stroke-width="8" />
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="8"
          stroke-linecap="round"
          :stroke-dasharray="339.29"
          :stroke-dashoffset="339.29 * (1 - runPercent / 100)"
          style="transition: stroke-dashoffset 0.4s ease"
        />
      </svg>
      <div class="absolute grid place-items-center">
        <span class="font-mono text-3xl font-bold tabular-nums text-ink">{{ runPercent }}<span class="text-lg text-muted">%</span></span>
        <!-- Zaehler nur, solange er auch zaehlt: die Schreibphase kann keinen liefern
             (synchrone Transaktion), ein stehendes „0/5.000" waere irrefuehrend.
             Die Einheit steht dabei: je Phase zaehlt er etwas anderes, und ohne das Wort
             liest sich „2.000/2.680" wie die Grundlage der Prozentzahl darueber – die es
             nicht ist (die Phase ist nur EIN Abschnitt des Laufs). -->
        <!-- Breite gedeckelt und die Einheit auf einer eigenen Zeile: „2.000/2.680 classes scanned"
             ist laenger als der Kreis innen breit ist und lief sonst ueber dessen untere Linie. -->
        <span v-if="progress.total && progress.done" class="mt-0.5 block max-w-[7.5rem] text-center font-mono text-2xs leading-tight tabular-nums text-muted">
          {{ nf.format(progress.done) }}/{{ nf.format(progress.total) }}
          <span v-if="runPhaseUnit" class="block opacity-70">{{ runPhaseUnit }}</span>
        </span>
      </div>
    </div>

    <div class="text-center">
      <p class="text-sm font-semibold text-ink">{{ runPhaseLabel }}</p>
      <!-- Der Satz darunter haengt am Ort: im Import-Modal heisst er „du kannst das schliessen",
           im Detailfenster der Sidebar etwas anderes. Deshalb ein Slot statt eines festen Textes. -->
      <p v-if="$slots.note" class="mt-1 text-xs text-muted"><slot name="note" /></p>
    </div>

    <!-- Phasenkette: zeigt, was schon durch ist und was noch kommt. -->
    <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
      <template v-for="(p, i) in activePhases" :key="p.key">
        <span v-if="i" class="h-px w-4 bg-line" />
        <span
          class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition"
          :class="i < phaseIndex
            ? 'border-[color-mix(in_srgb,var(--color-success)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-success'
            : i === phaseIndex
              ? 'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-accent-soft text-accent'
              : 'border-line text-muted opacity-60'"
        >
          <Icon v-if="i < phaseIndex" icon="lucide:check" class="h-3 w-3" />
          <Icon v-else-if="i === phaseIndex" icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
          <span v-else class="h-1 w-1 rounded-full bg-current" />
          {{ p.label }}
        </span>
      </template>
    </div>

    <!-- Die zwei Zeiten: verstrichen und geschaetzte Restzeit. -->
    <div class="flex items-stretch gap-3">
      <div class="min-w-[8.5rem] rounded-xl border border-line bg-surface px-4 py-2.5 text-center">
        <div class="font-mono text-xl font-semibold tabular-nums text-ink">{{ formatDuration(elapsedMs) }}</div>
        <div class="mt-1 text-3xs font-medium uppercase tracking-wide text-muted">elapsed</div>
      </div>
      <div class="min-w-[8.5rem] rounded-xl border border-line bg-surface px-4 py-2.5 text-center">
        <div class="font-mono text-xl font-semibold tabular-nums text-ink">
          {{ runRemainingMs != null ? formatDuration(runRemainingMs) : '–:––' }}
        </div>
        <div class="mt-1 text-3xs font-medium uppercase tracking-wide text-muted">remaining</div>
      </div>
    </div>
  </div>
</template>
