<script setup>
// Die echten AKTIONS-Knoepfe: Modal-Fuesse, Kopfleisten, Bestaetigungen.
//
// ⚠️ Bewusst NICHT fuer alles: von den ~250 <button> der Anwendung sind die meisten Icon-Schalter,
// Reiter oder Chips mit eigenen Zustandsklassen (`is-on`, `is-open`) und scoped Styles. Die hier
// durchzuzwingen hiesse, jedem von ihnen eine Prop-Variante zu spendieren – die Komponente waere
// dann die Summe aller Sonderfaelle statt die eine gemeinsame Form.
//
// ⚠️ Aber „nicht fuer alles" hiess eine Zeit lang „fuer nichts": die Komponente stand da und wurde
// von KEINER Datei importiert, waehrend derselbe Primaerknopf in fuenf Fassungen im Markup lag
// (fuenf Radien, fuenf Polsterungen, vier Schriftgroessen fuer eine Sache). Wer einen echten
// Aktionsknopf braucht, nimmt diesen hier. Eine Ausnahme bleibt ausdruecklich `App.vue`: dort
// faellt der Knopf in der schmalen Sidebar auf sein Icon zusammen, und dieser Kollaps ist ein
// Sonderfall EINER Stelle – er gehoert nicht als Prop in die gemeinsame Form.
//
// `text-accent-contrast` statt `text-white` auf gefuellten Flaechen: der Token dreht sich mit dem
// Theme (#fbfaf6 hell / #17160f dunkel). Auf dem dunklen Theme ist `--color-danger` ein HELLES
// Rosé – weisse Schrift darauf war dort kaum zu lesen.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  variant: { type: String, default: 'secondary' }, // primary | danger | secondary | ghost
  size: { type: String, default: 'md' }, // xs | sm | md
  type: { type: String, default: 'button' },
  disabled: { type: Boolean, default: false },
  /** Laeuft gerade: Spinner statt Icon, Knopf gesperrt, `busyLabel` statt Beschriftung. */
  busy: { type: Boolean, default: false },
  busyLabel: { type: String, default: '' },
  icon: { type: String, default: '' },
  /**
   * Gesetzt -> die Aktion ist ein ORTSWECHSEL und wird als `RouterLink` gerendert.
   *
   * Ohne diese Prop war die Komponente fuer die Haelfte ihrer Faelle unbrauchbar: „New article"
   * und „Go to code" sehen aus wie Primaerknoepfe, fuehren aber woandershin – und ein `<button>`
   * mit `router.push` im Klick nimmt dem Ziel die Adresse (kein Mittelklick, kein „in neuem Tab
   * oeffnen", kein Ziel in der Statuszeile). Deshalb ein echter Link mit dem Aussehen des Knopfs,
   * nicht ein Knopf, der navigiert.
   */
  to: { type: [String, Object], default: null },
})

const VARIANTS = {
  primary: 'bg-accent text-accent-contrast elev-1 hover:bg-accent-hover',
  danger: 'bg-danger text-accent-contrast elev-1 hover:opacity-90',
  secondary: 'border border-line text-muted hover:bg-surface-offset hover:text-ink',
  ghost: 'text-muted hover:bg-surface-offset hover:text-ink',
  // Zerstoerend, aber nicht laut: derselbe Umriss wie `secondary`, nur in der Warnfarbe. Fuer
  // Loeschknoepfe, die dauerhaft neben ihrem Gegenstand stehen – eine gefuellte rote Flaeche, die
  // immer im Bild ist, wiegt schwerer als die Aktion dahinter und faerbt am Ende das ganze Panel.
  // Gefuellt (`danger`) bleibt der Bestaetigung vorbehalten, wo die Entscheidung tatsaechlich faellt.
  'danger-soft': 'border border-line text-danger hover:bg-surface-offset',
}
const SIZES = {
  xs: 'gap-1.5 rounded-lg px-3 py-1.5 text-xs',
  sm: 'gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem]',
  md: 'gap-1.5 rounded-lg px-3 py-2 text-sm',
}
// Das Icon folgt der Groesse mit, sonst sitzt in einem `xs`-Knopf ein Icon aus einem `md`.
const ICON_SIZES = { xs: 'h-3.5 w-3.5', sm: 'h-4 w-4', md: 'h-4 w-4' }

const classes = computed(() => [
  'inline-flex items-center justify-center font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
  VARIANTS[props.variant] || VARIANTS.secondary,
  SIZES[props.size] || SIZES.md,
])
const shownIcon = computed(() => (props.busy ? 'lucide:loader-2' : props.icon))
const iconClass = computed(() => ICON_SIZES[props.size] || ICON_SIZES.md)
</script>

<template>
  <!-- Ein Ziel -> Link, sonst Knopf. `disabled` gibt es am Link nicht: was nicht gilt, wird nicht
       als Weg angeboten – der Aufrufer laesst ihn dann weg. -->
  <RouterLink v-if="to" :to="to" :class="classes">
    <Icon v-if="shownIcon" :icon="shownIcon" class="shrink-0" :class="[iconClass, busy ? 'animate-spin' : '']" />
    <span><slot /></span>
  </RouterLink>
  <button v-else :type="type" :class="classes" :disabled="disabled || busy">
    <Icon v-if="shownIcon" :icon="shownIcon" class="shrink-0" :class="[iconClass, busy ? 'animate-spin' : '']" />
    <!-- Waehrend eines Laufs sagt der Knopf, WAS laeuft („Deleting…"), nicht mehr, was er tut. -->
    <span v-if="busy && busyLabel">{{ busyLabel }}</span>
    <span v-else><slot /></span>
  </button>
</template>
