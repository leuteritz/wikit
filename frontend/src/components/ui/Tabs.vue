<script setup>
// Die Reiterleiste – EINE Fassung fuer die drei, die es gab.
//
// Insights (10 Reiter) und Bot (5) trugen dieselbe Klassenkette, aber als Abschrift, nicht geteilt;
// Wiki hatte ein Segmented Control im eigenen Rahmen; die Code-Ansicht eine dritte, scoped Fassung.
// Die Code-Ansicht behaelt ihre: dort sind die Reiter Teil eines dichten Panels, nicht der
// Seitenstruktur – sie gehoeren zum Inhalt der dritten Spalte, nicht zur Navigation der Seite.
//
// ⚠️ Der eigentliche Gewinn ist nicht das Aussehen, sondern die TASTATUR. Keine der drei Fassungen
// hatte `role="tablist"`, `role="tab"` oder `aria-selected`; die Pfeiltasten taten nichts. In einer
// Anwendung, die sonst jedes Kuerzel in einer Registry fuehrt und ihre Palette tastaturzentriert
// baut, waren die Reiter die Stelle, an der man zur Maus greifen musste.
//
// Die Tastenordnung folgt dem ARIA Authoring Practices Guide:
//   ← / →  ein Reiter weiter, umlaufend
//   Home / End  erster / letzter
// Bewusst „automatic activation": der Reiter wechselt beim Fokussieren, nicht erst mit ↵. Das ist
// die richtige Wahl, wenn der Inhalt sofort dasteht – und das tut er hier, alle zehn Reiter kommen
// aus EINER bereits geladenen Antwort.
import { computed, ref } from 'vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'

const props = defineProps({
  /**
   * Die Reiter. Ein Eintrag: `{ id, label, icon?, hint?, badge?, badgeTone? }`.
   * `badge` ist bewusst schon der fertige Wert und keine Zahl: die Ansicht entscheidet, ob eine
   * Null dasteht oder fehlt – „0 vorgemerkt" waere die Behauptung, es fehle etwas.
   */
  tabs: { type: Array, required: true },
  modelValue: { type: String, required: true },
  /** `pills` steht frei unter einer Kopfzeile, `segmented` sitzt in einem eigenen Rahmen. */
  variant: { type: String, default: 'pills' },
  ariaLabel: { type: String, default: 'Sections' },
})
const emit = defineEmits(['update:modelValue'])

// ⚠️ Per Index eingetragen, nicht ueber `ref="…"` im `v-for`: dort sammelt Vue zwar ein Array,
// sagt aber ausdruecklich nichts ueber dessen Reihenfolge zu – und die Reihenfolge IST hier die
// ganze Aussage (welcher Knopf liegt links vom aktiven?).
const btns = ref([])
const setBtn = (i) => (el) => {
  btns.value[i] = el
}

const BADGE_TONES = {
  danger: 'bg-danger/15 text-danger',
  accent: 'bg-accent-soft text-accent',
  warning: 'bg-warning/15 text-warning',
}

const index = computed(() => props.tabs.findIndex((t) => t.id === props.modelValue))

function select(id) {
  if (id !== props.modelValue) emit('update:modelValue', id)
}

// Der Fokus wandert MIT der Auswahl: sonst steht die Umrandung auf einem Reiter, waehrend ein
// anderer aktiv ist – zwei Behauptungen darueber, wo man ist.
function move(to) {
  const n = props.tabs.length
  if (!n) return
  const i = ((to % n) + n) % n
  select(props.tabs[i].id)
  btns.value[i]?.focus()
}

function onKeydown(e) {
  const i = index.value
  if (i < 0) return
  if (e.key === 'ArrowRight') move(i + 1)
  else if (e.key === 'ArrowLeft') move(i - 1)
  else if (e.key === 'Home') move(0)
  else if (e.key === 'End') move(props.tabs.length - 1)
  else return
  e.preventDefault()
}
</script>

<template>
  <div
    role="tablist"
    :aria-label="ariaLabel"
    class="flex items-center"
    :class="variant === 'segmented' ? 'rounded-lg border border-line p-0.5' : 'flex-wrap gap-1'"
    @keydown="onKeydown"
  >
    <!-- ⚠️ `tabindex`: genau EIN Reiter ist tabbierbar (Roving Tabindex). Sonst kostet eine
         zehnteilige Leiste zehn Tabstopps auf dem Weg zum Inhalt; innerhalb geht man mit den
         Pfeilen weiter. -->
    <button
      v-for="(t, i) in tabs"
      :key="t.id"
      :ref="setBtn(i)"
      v-tip="t.hint"
      type="button"
      role="tab"
      :aria-selected="modelValue === t.id"
      :aria-controls="t.panel || undefined"
      :tabindex="modelValue === t.id ? 0 : -1"
      class="tab"
      :class="[
        variant === 'segmented' ? 'tab--segmented' : 'tab--pill',
        modelValue === t.id ? 'is-on' : '',
      ]"
      @click="select(t.id)"
    >
      <Icon v-if="t.icon" :icon="t.icon" class="h-3.5 w-3.5 shrink-0" />
      {{ t.label }}
      <span v-if="t.badge" class="tab-badge" :class="BADGE_TONES[t.badgeTone] || BADGE_TONES.accent">
        {{ t.badge }}
      </span>
    </button>
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

.tab {
  @apply inline-flex items-center gap-1.5 font-medium;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/* pills: steht frei, der aktive traegt einen Rand. */
.tab--pill {
  @apply rounded-lg border border-transparent px-3 py-1.5 text-xs text-muted;
}
.tab--pill:hover {
  @apply bg-surface-offset;
}
.tab--pill.is-on {
  @apply border-accent bg-accent-soft text-accent;
}

/* segmented: sitzt im gemeinsamen Rahmen, der aktive ist die gefuellte Kachel. */
.tab--segmented {
  @apply rounded-md px-2.5 py-1.5 font-mono text-3xs font-semibold text-muted;
}
.tab--segmented:hover {
  @apply text-ink;
}
.tab--segmented.is-on {
  @apply bg-accent-soft text-accent;
}

.tab-badge {
  @apply rounded px-1 font-mono text-3xs tabular-nums;
}
</style>
