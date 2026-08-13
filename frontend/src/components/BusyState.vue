<script setup>
// EINE Wartemeldung fuer die ganze App.
//
// Vorher hatte jede Stelle ihre eigene: mal „Loading…" in Fliesstext, mal ein Icon ohne Text, mal
// nichts (der Graph blockierte den Hauptthread und zeigte einfach das alte Bild weiter). Damit war
// dieselbe Situation an jeder Stelle anders zu lesen – und die eigentliche Frage („was passiert
// gerade, und wie lange noch?") nirgends beantwortet.
//
// Diese Komponente haelt drei Dinge an EINER Stelle:
//  * die Form  – Spinner, Titel, Begruendung, optionales Skelett, drei Varianten,
//  * die Zeit  – die Uhr laeuft hier, nicht in fuenf Komponenten (`since` genuegt),
//  * die Schwellen – ab wann eine Zeit ueberhaupt angezeigt wird.
//
// Varianten:
//  * `inline`  – in einer Liste/Spalte, ohne Rahmen (Suchpalette, Artikel-Liste).
//  * `panel`   – als Block mit Skelett darunter (Klassen-Panel, Versionsliste).
//  * `overlay` – ueber einer laufenden Ansicht, deckend genug zum Lesen (Graph). Bewusst OHNE
//    `backdrop-filter`: im Graphen zeichnet der Compositor damit schwarz (s. CLAUDE.md).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({
  // Was passiert. Ein Satz im Imperativ der Situation: „Opening com.acme.rules…"
  title: { type: String, required: true },
  // Warum es dauert bzw. woran gearbeitet wird: „771 classes · 12 packages".
  detail: { type: String, default: '' },
  // Zusatzzeile, die erst nach `slowAfter` erscheint (Erklaerung, Deckelhinweis).
  hint: { type: String, default: '' },
  // Startzeitpunkt (Date.now()). Gesetzt -> die verstrichene Zeit erscheint ab `timeAfter`.
  since: { type: Number, default: 0 },
  variant: { type: String, default: 'inline' }, // 'inline' | 'panel' | 'overlay'
  // Skelettzeilen unter der Meldung (nur `panel`): so viele, wie die fertige Ansicht traegt.
  rows: { type: Number, default: 0 },
  // Ab hier steht eine Zeit dran. Darunter ist sie Zappeln, keine Auskunft.
  timeAfter: { type: Number, default: 900 },
  // Ab hier ist es „lange" -> `hint` wird gezeigt.
  slowAfter: { type: Number, default: 1500 },
})

// Eine Uhr fuer alle: 100 ms sind fein genug fuer eine Zehntelsekunde und grob genug, um im
// Hauptthread nicht aufzufallen. Sie laeuft nur, solange die Komponente steht – wer sie ausblendet,
// haelt sie damit an.
const now = ref(Date.now())
let timer = null
watch(
  () => props.since,
  (since) => {
    clearInterval(timer)
    timer = null
    if (!since) return
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), 100)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))

const elapsed = computed(() => (props.since ? Math.max(0, now.value - props.since) : 0))
const elapsedLabel = computed(() =>
  elapsed.value >= props.timeAfter ? `${(elapsed.value / 1000).toFixed(1)}s` : '',
)
const showHint = computed(() => !!props.hint && elapsed.value >= props.slowAfter)
const skeletonRows = computed(() => (props.variant === 'panel' ? Math.min(Math.max(props.rows, 0), 10) : 0))
</script>

<template>
  <div
    class="busy"
    :class="[`busy--${variant}`]"
    role="status"
    aria-live="polite"
  >
    <div class="busy-card">
      <div class="busy-row">
        <Icon icon="lucide:loader-2" class="busy-spinner" />
        <span class="busy-title">{{ title }}</span>
        <span v-if="elapsedLabel" class="busy-time">{{ elapsedLabel }}</span>
      </div>
      <p v-if="detail" class="busy-detail">{{ detail }}</p>
      <!-- Die Erklaerung kommt erst, wenn das Warten auffaellt: davor waere sie eine Entschuldigung
           fuer etwas, das noch niemand bemerkt hat. -->
      <Transition name="busy-fade">
        <p v-if="showHint" class="busy-hint">{{ hint }}</p>
      </Transition>
      <ul v-if="skeletonRows" class="busy-skeleton">
        <li v-for="n in skeletonRows" :key="n" :style="{ animationDelay: `${n * 60}ms` }" />
      </ul>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

.busy-row {
  @apply flex items-center gap-2;
}
.busy-spinner {
  @apply h-4 w-4 shrink-0 animate-spin;
  color: var(--color-accent);
}
.busy-title {
  @apply min-w-0 truncate text-sm font-medium;
  color: var(--color-text);
}
.busy-time {
  @apply ml-auto shrink-0 font-mono text-3xs tabular-nums;
  color: var(--color-text-muted);
  opacity: 0.75;
}
.busy-detail {
  @apply mt-1 truncate font-mono text-2xs;
  color: var(--color-text-muted);
}
.busy-hint {
  @apply mt-1.5 text-2xs leading-snug;
  color: var(--color-text-muted);
  opacity: 0.85;
}

/* --- Varianten ------------------------------------------------------------------------- */
/* inline: reiht sich in eine Liste ein, kein Rahmen, keine Flaeche. */
.busy--inline .busy-card {
  @apply px-1 py-2;
}
.busy--inline .busy-title {
  @apply text-xs font-normal;
  color: var(--color-text-muted);
}

/* panel: eigener Block, darunter das Skelett der kommenden Ansicht. */
.busy--panel .busy-card {
  @apply py-1;
}

/* overlay: liegt ueber der laufenden Ansicht. Deckende Karte statt `backdrop-filter` – im
   Graphen zwingt jeder Filter den Compositor zu einer Offscreen-Textur ueber die gesamte
   Layoutflaeche und faerbt ganze Fenster schwarz (s. CLAUDE.md, Stolperfallen). */
.busy--overlay {
  @apply pointer-events-none absolute inset-0 z-20 grid place-items-center;
}
.busy--overlay .busy-card {
  @apply max-w-[22rem] rounded-xl border px-4 py-3 elev-2;
  border-color: var(--color-border);
  background: var(--color-surface-2);
}
.busy--overlay .busy-title {
  @apply text-[0.9375rem];
}

/* --- Skelett: wandernder Schimmer statt pulsierendem Block ------------------------------ */
.busy-skeleton {
  @apply mt-3 space-y-2;
}
.busy-skeleton li {
  @apply block h-7 rounded-lg;
  background-image: linear-gradient(
    90deg,
    var(--color-surface-offset) 0%,
    color-mix(in srgb, var(--color-accent) 10%, var(--color-surface-offset)) 50%,
    var(--color-surface-offset) 100%
  );
  background-size: 200% 100%;
  animation: busy-shimmer 1.4s ease-in-out infinite;
}
@keyframes busy-shimmer {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}

.busy-fade-enter-active {
  transition: opacity 0.2s ease;
}
.busy-fade-enter-from {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .busy-skeleton li {
    animation: none;
  }
}
</style>
