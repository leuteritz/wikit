<script setup>
// Eine Kurve ohne Achsen: die Form einer Entwicklung, nicht ihre Zahlen.
//
// Das Projekt hatte GENAU EIN Diagramm (den A/I-Plot in den Packages) auf zehn Insights-Reitern und
// vier Wiki-Modi. Alles andere waren Zahlen in Kacheln – auch dort, wo die Aussage selbst eine
// Bewegung ist. Eine Sparkline sagt „steigt seit vier Laeufen" in dem Platz, den eine Zahl braucht.
//
// ⚠️ Handgeschriebenes SVG, keine Bibliothek. `lib/icons.js` verbietet Inline-SVG ausdruecklich –
// aber fuer IKONEN, und aus dem Grund, dass die offline gebuendelt sein muessen. Ein Datenbild ist
// kein Icon: seine Form kommt aus den Daten, es kann gar nicht aus einem Paket kommen. Der A/I-Plot
// ist aus demselben Grund von Hand gezeichnet.
//
// ⚠️ `preserveAspectRatio="none"`: die Kurve soll die Breite fuellen, die sie bekommt. Die Punkte
// werden deshalb in einem festen viewBox-Raster gerechnet und vom Browser gestreckt – eine Kurve,
// die ihr Seitenverhaeltnis haelt, laesst in einer Tabellenzeile rechts Platz stehen.
import { computed } from 'vue'

const props = defineProps({
  /** Die Werte in ihrer zeitlichen Reihenfolge. Weniger als zwei ergeben keine Kurve. */
  values: { type: Array, required: true },
  color: { type: String, default: 'var(--color-accent)' },
  /** Faerbt die Flaeche unter der Kurve. Aus, wenn mehrere Kurven uebereinanderliegen. */
  fill: { type: Boolean, default: true },
  label: { type: String, default: '' },
})

const W = 100
const H = 28

const pts = computed(() => {
  const v = props.values.filter((n) => typeof n === 'number' && Number.isFinite(n))
  if (v.length < 2) return null
  const min = Math.min(...v)
  const max = Math.max(...v)
  // ⚠️ Eine waagerechte Linie ist eine AUSSAGE („nichts bewegt sich") und darf nicht durch Null
  // geteilt in der Mitte oder am Rand landen: bei max === min liegt sie mittig.
  const span = max - min || 1
  const step = W / (v.length - 1)
  return v.map((n, i) => {
    const x = i * step
    const y = max === min ? H / 2 : H - ((n - min) / span) * (H - 2) - 1
    return [x, y]
  })
})

const line = computed(() => (pts.value ? pts.value.map(([x, y]) => `${x},${y}`).join(' ') : ''))
const area = computed(() =>
  pts.value ? `0,${H} ${pts.value.map(([x, y]) => `${x},${y}`).join(' ')} ${W},${H}` : '',
)
const last = computed(() => (pts.value ? pts.value[pts.value.length - 1] : null))
</script>

<template>
  <svg
    v-if="pts"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    class="block h-7 w-full overflow-visible"
    role="img"
    :aria-label="label"
  >
    <polygon v-if="fill" :points="area" :fill="color" opacity="0.12" />
    <polyline
      :points="line"
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <!-- Der letzte Punkt bekommt eine Marke: er ist der Stand, alles davor ist der Weg dorthin. -->
    <circle v-if="last" :cx="last[0]" :cy="last[1]" r="2" :fill="color" vector-effect="non-scaling-stroke" />
  </svg>
</template>
