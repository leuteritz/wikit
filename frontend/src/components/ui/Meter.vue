<script setup>
// Ein Wert auf seiner Skala – die Form, in der eine gerechnete Zahl hier lesbar wird.
//
// Es gab sie schon vier Mal, jedes Mal als `<span class="h-1.5 w-16 …">` mit einem inneren `span`
// auf `width: n%`. Das Mass ist der Punkt: 64 px breit und 1,5 px hoch, in einer Tabelle von rund
// 42 rem – Rang 78 und Rang 71 liegen darin VIER Pixel auseinander, neben einem Chevron, der
// groesser ist als der Balken. Eine Rangliste, deren Rangfolge man nicht sieht, ist eine Liste.
//
// ⚠️ Die Farbe kommt aus `lib/insightsScale.js` und wird hier NICHT nachgerechnet. Dieselbe Zahl
// traegt im Bericht, im Graphen und in der Legende dieselbe Farbe – ein Brandherd, der hier gelb
// und dort rot ist, ist keine Auskunft mehr, sondern eine Frage.
//
// ⚠️ `max` ist nicht immer 100. Wo gegen den GROESSTEN Wert des Laufs verglichen wird („was war
// der grosse Umbau?"), ist der Bestand der Massstab und nicht die Skala – deshalb eine Prop und
// keine Annahme.
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, required: true },
  max: { type: Number, default: 100 },
  /** Volle Farbe des Balkens. Fehlt sie, traegt er die Akzentfarbe. */
  color: { type: String, default: 'var(--color-accent)' },
  /** `sm` in Tabellenzeilen, `md` wenn der Balken die Aussage traegt. */
  size: { type: String, default: 'sm' }, // sm | md
  /** Vergleichsmarke auf derselben Skala – etwa der Durchschnitt des Bestands. */
  mark: { type: Number, default: null },
  markLabel: { type: String, default: '' },
  label: { type: String, default: '' },
})

const pct = computed(() => {
  const m = props.max || 1
  // Ein Wert, der nicht null ist, bekommt eine sichtbare Breite: sonst liest sich „sehr wenig"
  // wie „nichts", und das sind zwei verschiedene Auskuenfte.
  const raw = (Math.abs(props.value) / m) * 100
  return raw > 0 ? Math.max(2, Math.min(100, raw)) : 0
})
const markPct = computed(() =>
  props.mark == null ? null : Math.max(0, Math.min(100, (props.mark / (props.max || 1)) * 100)),
)
</script>

<template>
  <span
    class="meter"
    :class="size === 'md' ? 'meter--md' : 'meter--sm'"
    role="img"
    :aria-label="label || `${value} of ${max}`"
  >
    <span class="meter-fill" :style="{ width: `${pct}%`, background: color }" />
    <!-- Die Marke liegt UEBER der Fuellung: sie sagt „hier steht der Rest", und das bleibt auch
         dann die Aussage, wenn der Wert sie ueberholt hat. -->
    <span
      v-if="markPct !== null"
      v-tip="markLabel"
      class="meter-mark"
      :style="{ left: `${markPct}%` }"
    />
  </span>
</template>

<style scoped>
@reference "../../assets/style.css";

.meter {
  @apply relative block shrink-0 overflow-hidden rounded-full bg-surface-offset;
}
/* Breit genug, dass benachbarte Raenge sich unterscheiden – der alte Balken war 64 px. */
.meter--sm {
  @apply h-1.5 w-28;
}
.meter--md {
  @apply h-2.5 w-full;
}
.meter-fill {
  @apply block h-full rounded-full;
  transition: width var(--dur-base) var(--ease-out);
}
.meter-mark {
  @apply absolute inset-y-0 w-px;
  background: var(--color-text-muted);
  opacity: 0.7;
}
</style>
