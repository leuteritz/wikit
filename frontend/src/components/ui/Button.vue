<script setup>
// Die echten AKTIONS-Knoepfe: Modal-Fuesse, Kopfleisten, Bestaetigungen.
//
// ⚠️ Bewusst NICHT fuer alles: von den ~250 <button> der Anwendung sind die meisten Icon-Schalter,
// Reiter oder Chips mit eigenen Zustandsklassen (`is-on`, `is-open`) und scoped Styles. Die hier
// durchzuzwingen hiesse, jedem von ihnen eine Prop-Variante zu spendieren – die Komponente waere
// dann die Summe aller Sonderfaelle statt die eine gemeinsame Form.
//
// `text-accent-contrast` statt `text-white` auf gefuellten Flaechen: der Token dreht sich mit dem
// Theme (#fbfaf6 hell / #17160f dunkel). Auf dem dunklen Theme ist `--color-danger` ein HELLES
// Rosé – weisse Schrift darauf war dort kaum zu lesen.
import { computed } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  variant: { type: String, default: 'secondary' }, // primary | danger | secondary | ghost
  size: { type: String, default: 'md' }, // sm | md
  type: { type: String, default: 'button' },
  disabled: { type: Boolean, default: false },
  /** Laeuft gerade: Spinner statt Icon, Knopf gesperrt, `busyLabel` statt Beschriftung. */
  busy: { type: Boolean, default: false },
  busyLabel: { type: String, default: '' },
  icon: { type: String, default: '' },
})

const VARIANTS = {
  primary: 'bg-accent text-accent-contrast elev-1 hover:bg-accent-hover',
  danger: 'bg-danger text-accent-contrast elev-1 hover:opacity-90',
  secondary: 'border border-line text-muted hover:bg-surface-offset hover:text-ink',
  ghost: 'text-muted hover:bg-surface-offset hover:text-ink',
}
const SIZES = {
  sm: 'gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem]',
  md: 'gap-1.5 rounded-lg px-3 py-2 text-sm',
}

const classes = computed(() => [
  'inline-flex items-center justify-center font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
  VARIANTS[props.variant] || VARIANTS.secondary,
  SIZES[props.size] || SIZES.md,
])
const shownIcon = computed(() => (props.busy ? 'lucide:loader-2' : props.icon))
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || busy">
    <Icon v-if="shownIcon" :icon="shownIcon" class="h-4 w-4 shrink-0" :class="busy ? 'animate-spin' : ''" />
    <!-- Waehrend eines Laufs sagt der Knopf, WAS laeuft („Deleting…"), nicht mehr, was er tut. -->
    <span v-if="busy && busyLabel">{{ busyLabel }}</span>
    <span v-else><slot /></span>
  </button>
</template>
