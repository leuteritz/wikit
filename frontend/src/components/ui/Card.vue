<script setup>
// Die abgesetzte Flaeche: Rahmen, hellerer Grund, Radius.
//
// `rounded-xl border border-line bg-surface-2 p-4` stand woertlich dutzendfach im Markup – in
// InsightsView, BotView, AskView, TopicView, WikiHealth. Jede Abschrift war eine Gelegenheit,
// einen anderen Radius oder eine andere Polsterung zu nehmen, und die Anwendung hat sie genutzt:
// `rounded-md`, `-lg`, `-xl`, `-2xl` und vier Polsterungen fuer dieselbe Sorte Kasten.
//
// Damit gilt jetzt EINE Regel fuer Radien:
//   md  ... Chip, Badge, kbd            (das Kleine, das in einer Zeile sitzt)
//   lg  ... Knopf, Eingabefeld, Reiter  (das Bedienbare)
//   xl  ... Karte                       (die Flaeche) ....... hier
//   2xl ... Modal                       (was ueber allem liegt)
//
// ⚠️ KEINE Variante fuer „Karte mit farbigem Rand". Ein Befund faerbt sich ueber `class`
// (`border-warning/40`), und das bleibt sichtbar am Ort – eine Prop `tone="warning"` verstecken
// hiesse, die Aussage in die Komponente zu schieben, wo sie niemand liest, der die Karte anschaut.
import { computed } from 'vue'

const props = defineProps({
  // Der Innenabstand. `none` fuer Karten, die eine Tabelle oder Liste randlos tragen.
  pad: { type: String, default: 'md' }, // none | sm | md | lg
  as: { type: String, default: 'section' },
  /** Hebt sich beim Ueberfahren an – nur fuer Karten, die auch ein Ziel sind. */
  interactive: { type: Boolean, default: false },
})

const PADS = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' }

const cls = computed(() => [
  'rounded-xl border border-line bg-surface-2',
  PADS[props.pad] ?? PADS.md,
  props.interactive ? 'card--interactive' : '',
])
</script>

<template>
  <component :is="as" :class="cls">
    <!-- Der Kopf traegt seine eigene Trennlinie NICHT: die meisten Karten der Anwendung setzen
         ihre Ueberschrift ohne Linie ab, und eine Linie laesst sich ergaenzen, waehrend eine
         ueberzaehlige nur mit einer zweiten Prop wieder wegzubekommen waere. -->
    <header v-if="$slots.header" class="mb-3">
      <slot name="header" />
    </header>
    <slot />
    <footer v-if="$slots.footer" class="mt-3">
      <slot name="footer" />
    </footer>
  </component>
</template>

<style scoped>
@reference "../../assets/style.css";

.card--interactive {
  transition:
    transform var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.card--interactive:hover {
  @apply -translate-y-0.5 border-accent elev-2;
}
</style>
