<script setup>
// Live-Vorschau der im Editor erkannten Klassen (Quelle: lib/javaDetect.js, rein clientseitig).
//
// Kernproblem, das diese Komponente loest: ein einzelner Paste kann Hunderte Klassen enthalten
// (15k Zeilen, 500 Typen). Eine flache Chip-Liste waechst dann ins Unendliche und schiebt alles
// darunter aus dem Modal. Deshalb:
//   - feste Hoehe mit eigenem Scroller (das Modal-Layout bleibt geometrisch stabil),
//   - ab AUTO_COLLAPSE_FROM Klassen automatisch nach Package gruppiert UND eingeklappt
//     -> gerendert wird dann eine Zeile je Package statt 500 Chips (lesbar + schnell),
//   - Filterfeld: tippen klappt Treffer automatisch auf.
import { ref, reactive, computed, watch } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  classes: { type: Array, default: () => [] },
})

const AUTO_COLLAPSE_FROM = 40 // ab hier lohnt die Package-Uebersicht mehr als die Chip-Wand
const FILTER_FROM = 12 // darunter braucht niemand ein Suchfeld

// Typ -> Icon + Farbton. Vier klar unterscheidbare Toene aus der Palette (style.css).
const TYPE_META = {
  class: { icon: 'lucide:box', tone: 'var(--color-accent)' },
  interface: { icon: 'lucide:braces', tone: 'var(--color-cyan)' },
  enum: { icon: 'lucide:list', tone: 'var(--color-thistle)' },
  record: { icon: 'lucide:package', tone: 'var(--color-lavender)' },
}
const metaFor = (t) => TYPE_META[t] || TYPE_META.class

const filter = ref('')
const overrides = reactive({}) // package -> bool (manuelles Auf-/Zuklappen schlaegt den Default)

const dense = computed(() => props.classes.length > AUTO_COLLAPSE_FROM)
const filtering = computed(() => filter.value.trim().length > 0)

// Neuer Paste -> Filter + manuelle Zustaende verwerfen (sonst zeigt die Vorschau alten Kontext).
watch(
  () => props.classes,
  () => {
    filter.value = ''
    for (const k of Object.keys(overrides)) delete overrides[k]
  },
)

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const map = new Map()
  for (const c of props.classes) {
    const pkg = c.package || '(default package)'
    if (q && !c.class_name.toLowerCase().includes(q) && !pkg.toLowerCase().includes(q)) continue
    if (!map.has(pkg)) map.set(pkg, [])
    map.get(pkg).push(c)
  }
  return [...map.entries()]
    .map(([pkg, items]) => ({ pkg, items }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
})

const matchCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

// Typ-Bilanz (nur wenn der Paste gemischt ist): Punkt + Zahl + Wort, damit die Chip-Farben
// unten eine Legende haben – Identitaet haengt nie an der Farbe allein.
const typeBreakdown = computed(() => {
  const counts = new Map()
  for (const c of props.classes) counts.set(c.type, (counts.get(c.type) || 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => ({ type, n, tone: metaFor(type).tone }))
})
const packageCount = computed(() => new Set(props.classes.map((c) => c.package || '')).size)

// Im Filtermodus immer offen – sonst greift der Default (dicht = zu) bzw. die manuelle Wahl.
function isOpen(pkg) {
  if (filtering.value) return true
  if (pkg in overrides) return overrides[pkg]
  return !dense.value
}
function toggle(pkg) {
  overrides[pkg] = !isOpen(pkg)
}
const allOpen = computed(() => groups.value.every((g) => isOpen(g.pkg)))
function toggleAll() {
  const next = !allOpen.value
  for (const g of groups.value) overrides[g.pkg] = next
}
</script>

<template>
  <div
    v-if="classes.length"
    class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
  >
    <!-- Kopfzeile: Bilanz links, Werkzeuge rechts. Bleibt beim Scrollen stehen. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
      <Icon icon="lucide:package" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span class="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">
        <b class="font-semibold tabular-nums text-[var(--color-text)]">{{ classes.length }}</b> detected
        <span class="opacity-40">·</span>
        <b class="font-semibold tabular-nums text-[var(--color-text)]">{{ packageCount }}</b> pkg
      </span>

      <div v-if="classes.length >= FILTER_FROM" class="relative ml-auto min-w-0 max-w-[13rem] flex-1">
        <Icon
          icon="lucide:search"
          class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          v-model="filter"
          type="text"
          placeholder="Filter detected…"
          class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] py-1 pl-7 pr-2 font-mono text-[11px] text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
        />
      </div>
      <button
        type="button"
        class="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40"
        :class="classes.length < FILTER_FROM ? 'ml-auto' : ''"
        :disabled="filtering"
        :title="allOpen ? 'Collapse all packages' : 'Expand all packages'"
        @click="toggleAll"
      >
        <Icon :icon="allOpen ? 'lucide:fold-vertical' : 'lucide:unfold-vertical'" class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- Legende der Chip-Farben, nur bei gemischten Pastes. -->
    <div
      v-if="typeBreakdown.length > 1"
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--color-border)] px-2.5 py-1"
    >
      <span v-for="t in typeBreakdown" :key="t.type" class="inline-flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ background: t.tone }" />
        <b class="font-semibold tabular-nums text-[var(--color-text)]">{{ t.n }}</b>{{ t.type }}
      </span>
    </div>

    <!-- Scroller: waechst mit dem Inhalt, deckelt aber bei ~11rem -> darunter bleibt Platz. -->
    <div class="min-h-0 max-h-44 overflow-y-auto overscroll-contain p-1.5">
      <p v-if="!groups.length" class="px-1 py-2 text-center font-mono text-[11px] text-[var(--color-text-muted)]">
        No class matches “{{ filter }}”.
      </p>
      <div v-for="g in groups" :key="g.pkg" class="mb-0.5 last:mb-0">
        <button
          type="button"
          class="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:bg-[var(--color-surface-offset)]"
          @click="toggle(g.pkg)"
        >
          <Icon
            icon="lucide:chevron-right"
            class="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
            :class="isOpen(g.pkg) ? 'rotate-90' : ''"
          />
          <span class="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{{ g.pkg }}</span>
          <span
            class="ml-auto shrink-0 rounded-full bg-[var(--color-surface-offset)] px-1.5 font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]"
          >
            {{ g.items.length }}
          </span>
        </button>
        <div v-if="isOpen(g.pkg)" class="flex flex-wrap gap-1 py-1 pl-5 pr-1">
          <span
            v-for="c in g.items"
            :key="c.class_name"
            class="chip"
            :style="{ '--tone': metaFor(c.type).tone }"
            :title="`${c.type} ${g.pkg === '(default package)' ? '' : g.pkg + '.'}${c.class_name}`"
          >
            <Icon :icon="metaFor(c.type).icon" class="h-3 w-3 shrink-0" />
            <span class="truncate font-mono">{{ c.class_name }}</span>
          </span>
        </div>
      </div>
    </div>

    <!-- Fusszeile nur im Filtermodus: sagt, wie viel gerade ausgeblendet ist. -->
    <div
      v-if="filtering"
      class="shrink-0 border-t border-[var(--color-border)] px-2.5 py-1 font-mono text-[10px] text-[var(--color-text-muted)]"
    >
      {{ matchCount }} of {{ classes.length }} shown
    </div>
  </div>
</template>

<style scoped>
/* Chip: Farbton kommt je Typ per --tone von aussen; Light/Dark loest color-mix auf. */
.chip {
  display: inline-flex;
  max-width: 14rem;
  align-items: center;
  gap: 0.25rem;
  border-radius: 0.375rem;
  border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  padding: 0.0625rem 0.375rem;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--tone);
}
</style>
