<script setup>
// Die kleine Mono-Versalie ueber einem Abschnitt („NAVIGATE", „KNOWLEDGE BASE", „SOURCES").
// Sie stand 17-mal im Markup – in drei verschiedenen Laufweiten (0.08/0.12/0.14/0.16em) fuer
// dieselbe Aussage. Hier ist eine davon uebrig; die Groesse bleibt waehlbar, weil sie sich nach
// dem Rang des Abschnitts richtet, nicht nach der Datei.
import { computed } from 'vue'

const props = defineProps({
  size: { type: String, default: '3xs' }, // 3xs | 2xs | xs
  as: { type: String, default: 'p' },
})
const SIZES = { '3xs': 'text-3xs', '2xs': 'text-2xs', xs: 'text-xs' }
const cls = computed(() => [
  'font-mono font-semibold uppercase tracking-[0.12em] text-muted',
  SIZES[props.size] || SIZES['3xs'],
])
</script>

<template>
  <component :is="as" :class="cls"><slot /></component>
</template>
