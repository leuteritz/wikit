<script setup>
// Was gerade laeuft – in der Sidebar, also auf JEDER Ansicht.
//
// Der Grund fuer diese Karte: Import, Reset, Kanten-Neuberechnung und die KI-Queue laufen auf dem
// SERVER. Wer waehrend eines Massen-Imports ins Wiki wechselt, hat den Lauf nicht abgebrochen – er
// sah ihn nur nicht mehr, denn der Fortschritt hing an der Code-Ansicht. Die Sidebar ist der eine
// Ort, der ueberall steht.
//
// Drei Festlegungen:
//
// 1. **Fester Platz, kein Auf- und Zuklappen.** Frueher trat sie an die Stelle der Kuerzel-Liste
//    und verschwand danach wieder – damit sprang beim Start und beim Ende eines Laufs der ganze
//    untere Teil der Sidebar. Ein Bereich, der genau dann erscheint, wenn man ihn sucht, ist
//    ausserdem nur zu finden, wenn man ihn schon kennt. Sie steht jetzt immer, und im Ruhezustand
//    beantwortet sie die dort zutreffende Frage: was liegt da, und wie ging der letzte Lauf aus?
//
// 2. **Die Karte IST der Knopf.** Auf 13 rem passen Phase, Quote und zwei Zeiten – mehr nicht.
//    Alles Weitere (Phasenkette, Zaehler, Queue-Details, letztes Ergebnis) steht im Detailfenster,
//    und der Weg dorthin ist ein Klick auf das, was man ohnehin ansieht.
//
// 3. **ALLE Zahlen stammen aus `useActivity`** und werden hier NICHT nachgerechnet: Detailfenster
//    und Import-Modal zeigen denselben Lauf, und zwei Rechnungen ueber denselben Stand sind zwei
//    Gelegenheiten, verschiedene Prozentzahlen zu behaupten.
import { computed } from 'vue'
import { Icon } from '../lib/icons.js'
import { formatDuration, formatEta } from '../lib/format.js'
import { useActivity } from '../composables/useActivity.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'

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
  lastRun,
  lastRunAgo,
  openDetail,
} = useActivity()
const { files } = useJavaAnalyzer()

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

const classCount = computed(() => (files.value || []).length)

// Was der Knopf beim Ueberfahren ansagt. Im Ruhezustand ist das eine andere Auskunft als im Lauf –
// „Show details" allein liesse offen, wovon.
const hint = computed(() => {
  if (run.value) return `${runTitle.value} — ${runPercent.value}% done. Click for phases and timings.`
  if (queue.value) return `AI analysis — ${queue.value.percent}% done. Click for details.`
  return 'Nothing running. Click to see what is stored and how the last run went.'
})
</script>

<template>
  <!-- Nur im breiten Layout: in der 4-rem-Spalte waere eine Phasenleiste unlesbar. Dort tritt der
       Ring am Code-Symbol an ihre Stelle (App.vue). -->
  <button
    type="button"
    class="act-card mb-3 hidden w-full text-left lg:block"
    :class="busy ? 'is-busy' : ''"
    :title="hint"
    @click="openDetail"
  >
    <!-- ===================== Laufender Server-Lauf ===================== -->
    <div v-if="run" class="act-body">
      <div class="act-head">
        <Icon :icon="runIcon" class="h-3.5 w-3.5 shrink-0" />
        <span class="act-title">{{ runTitle }}</span>
        <span class="act-pct">{{ runPercent }}%</span>
      </div>

      <!-- Gesamtquote -->
      <div class="act-bar">
        <div class="act-bar-fill" :style="{ width: runPercent + '%' }" />
      </div>

      <!-- Was gerade passiert, und woran es sich bemisst -->
      <p class="act-line">{{ runPhaseLabel }}</p>
      <p v-if="counter" class="act-sub">{{ counter }}</p>

      <!-- Ein Segment je Phase: der Lauf hat mehrere Abschnitte, und „63 %" allein sagt nicht,
           wieviel davon noch aussteht. Die Breite folgt dem GEMESSENEN Zeitanteil, nicht der
           Anzahl – sonst sieht die laengste Phase aus wie die kuerzeste. -->
      <div class="act-phases">
        <div
          v-for="(p, i) in activePhases"
          :key="p.key"
          class="act-seg"
          :style="{ flexGrow: p.weight }"
        >
          <div
            class="act-seg-fill"
            :style="{
              width: phaseFill(i) * 100 + '%',
              backgroundColor: i < phaseIndex ? 'var(--color-success)' : 'var(--color-accent)',
            }"
          />
        </div>
      </div>

      <div class="act-times">
        <span>{{ formatDuration(elapsedMs) }} <span class="opacity-60">elapsed</span></span>
        <span v-if="runRemainingMs != null">~{{ formatDuration(runRemainingMs) }} <span class="opacity-60">left</span></span>
      </div>
    </div>

    <!-- ===================== KI-Queue ===================== -->
    <!-- Eigener Block statt einer zweiten Prozentzahl im selben: Import und KI-Analyse laufen
         nach einem Paste GLEICHZEITIG (CodeView reiht die frisch importierten Klassen ein), und
         es sind zwei verschiedene Arbeiten mit zwei verschiedenen Enden. Eine gemeinsame Quote
         waere eine erfundene Zahl. -->
    <div v-if="queue" class="act-body act-body--ai" :class="run ? 'act-body--stacked' : ''">
      <div class="act-head act-head--ai">
        <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 shrink-0" />
        <span class="act-title">AI analysis</span>
        <span class="act-pct">{{ queue.percent }}%</span>
      </div>

      <div class="act-bar">
        <div class="act-bar-fill act-bar-fill--ai" :style="{ width: queue.percent + '%' }" />
      </div>

      <p class="act-line">{{ queueDetail }}</p>
      <div class="act-times">
        <span>{{ nf.format(queue.done) }} / {{ nf.format(queue.total) }} <span class="opacity-60">steps</span></span>
        <span v-if="formatEta(queue.etaMs)">{{ formatEta(queue.etaMs) }}</span>
      </div>
      <!-- Die Parallelitaet steht nur da, wenn sie vom Normalfall abweicht: bei 1 waere sie eine
           Zahl ohne Aussage. Sie erklaert, warum die Restzeit kleiner ist als Schritte × Dauer. -->
      <p v-if="queue.parallel > 1" class="act-sub">{{ queue.parallel }} in parallel</p>
    </div>

    <!-- ===================== Ruhezustand ===================== -->
    <!-- Steht auch dann, wenn nichts laeuft – das ist der Preis und der Zweck des festen Platzes.
         Frisch abgeschlossene Laeufe faerben ihn kurz (RESULT_LINGER_MS in useActivity), danach
         bleibt die kurze Bilanz: Bestand plus Ausgang des letzten Laufs. -->
    <div v-if="!busy" class="act-body act-body--idle" :class="result ? (result.ok ? 'is-ok' : 'is-bad') : ''">
      <div class="act-head act-head--idle">
        <span class="act-dot" :class="result ? (result.ok ? 'is-ok' : 'is-bad') : ''" />
        <span class="act-title">{{ result ? (result.ok ? 'Finished' : 'Failed') : 'Idle' }}</span>
        <span v-if="classCount" class="act-pct act-pct--idle">{{ nf.format(classCount) }}</span>
      </div>

      <!-- Frisch fertig: die Meldung selbst. Danach: der letzte Lauf mit seinem Alter. `title`,
           weil eine Fehlermeldung laenger sein kann als die Spalte breit ist. -->
      <template v-if="result">
        <p class="act-line" :title="result.message">{{ result.message }}</p>
      </template>
      <template v-else-if="lastRun">
        <p class="act-line" :title="lastRun.message">{{ lastRun.message }}</p>
        <p class="act-sub">{{ lastRunAgo }}</p>
      </template>
      <template v-else>
        <p class="act-line act-line--muted">No server run active</p>
        <p class="act-sub">{{ classCount ? `${nf.format(classCount)} classes stored` : 'Nothing imported yet' }}</p>
      </template>
    </div>

    <!-- Die Affordanz gehoert zur KARTE, nicht zu einem ihrer Zustaende: dass hinter dem
         Fortschritt Phasen, Zaehler und Zeiten liegen, muss gerade dann zu sehen sein, wenn
         etwas laeuft – sonst sucht man die Einzelheiten dort, wo sie frueher standen (Kopfzeile
         der Code-Ansicht). -->
    <span class="act-more">
      Details
      <Icon icon="lucide:arrow-up-right" class="h-3 w-3" />
    </span>
  </button>
</template>

<style scoped>
@reference "../assets/style.css";

/* Der Rahmen sitzt am Knopf, nicht an den Bloecken: laufen Server-Lauf UND Queue gleichzeitig,
   sind es zwei Bloecke in EINER Karte – zwei getrennt gerahmte Kaesten waeren zwei Meldungen fuer
   eine Sache. */
.act-card {
  @apply rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 transition;
}
.act-card:hover {
  @apply border-[var(--color-border-strong)] bg-[var(--color-surface-offset)];
}
/* Im Lauf traegt die Karte den Akzent – sie ist dann die einzige Stelle der Oberflaeche, an der
   sich etwas bewegt. Der Verlauf ist bewusst flach: ein kraeftiger Kasten in der Seitenspalte
   zieht ueber Minuten hinweg zuviel Aufmerksamkeit von der Arbeit ab. */
.act-card.is-busy {
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--color-accent) 12%, var(--color-surface)) 0%,
    var(--color-surface) 100%
  );
}

.act-body {
  @apply px-0.5 py-0.5;
}
.act-body--stacked {
  @apply mt-2 border-t border-[var(--color-border)] pt-2;
}

.act-head {
  @apply mb-1.5 flex items-center gap-1.5 text-[var(--color-accent)];
}
.act-head--ai {
  @apply text-[var(--color-lavender)];
}
.act-head--idle {
  @apply text-[var(--color-text-muted)];
}
.act-title {
  @apply min-w-0 flex-1 truncate font-mono text-[0.59375rem] font-semibold uppercase tracking-[0.14em];
}
.act-pct {
  @apply shrink-0 font-mono text-2xs font-semibold tabular-nums;
}
.act-pct--idle {
  @apply text-[var(--color-text-muted)];
}

.act-bar {
  @apply h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-offset)];
}
.act-bar-fill {
  @apply h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out;
}
.act-bar-fill--ai {
  @apply bg-[var(--color-lavender)];
}

.act-line {
  @apply mt-2 truncate text-xs font-medium text-[var(--color-text)];
}
.act-line--muted {
  @apply text-[var(--color-text-muted)];
}
.act-sub {
  @apply mt-0.5 truncate font-mono text-2xs tabular-nums text-[var(--color-text-muted)];
}

.act-phases {
  @apply mt-2 flex gap-px;
}
.act-seg {
  @apply h-1 overflow-hidden rounded-sm bg-[var(--color-surface-offset)];
}
.act-seg-fill {
  @apply h-full rounded-sm transition-[width] duration-300 ease-out;
}

.act-times {
  @apply mt-1.5 flex items-baseline justify-between gap-2 font-mono text-2xs tabular-nums text-[var(--color-text-muted)];
}

/* Ruhezustand: der Punkt traegt die Aussage, nicht die Flaeche. Gruen/rot erscheinen nur, solange
   ein frisches Ergebnis steht – ein dauerhaft gefaerbter Kasten in der Seitenspalte laese sich
   nach zehn Minuten wie eine offene Meldung. */
.act-dot {
  @apply h-2 w-2 shrink-0 rounded-full bg-[var(--color-text-muted)] opacity-50;
}
.act-dot.is-ok {
  background: var(--color-success);
  @apply opacity-100;
}
.act-dot.is-bad {
  background: var(--color-danger);
  @apply opacity-100;
}
.act-body--idle.is-ok {
  color: var(--color-success);
}
.act-body--idle.is-ok .act-head,
.act-body--idle.is-bad .act-head {
  color: inherit;
}
.act-body--idle.is-bad {
  color: var(--color-danger);
}

/* „Details ↗" ist die Affordanz des Knopfes – es sagt, dass hinter der Karte noch etwas liegt.
   Beim Ueberfahren tritt es hervor; dauerhaft kraeftig waere es ein zweites Bedienelement in einer
   Karte, die selbst schon eines ist. */
.act-more {
  @apply mt-2 flex items-center justify-end gap-1 border-t border-[var(--color-border)] px-0.5 pt-1.5 font-mono text-[0.59375rem] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)] opacity-60 transition;
}
.act-card:hover .act-more {
  @apply text-[var(--color-accent)] opacity-100;
}
</style>
