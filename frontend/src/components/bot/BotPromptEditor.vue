<script setup>
// Die vier Prompt-Vorlagen. Sie waren bisher hart im OllamaService verdrahtet – wer die
// Beschreibungen anders haben wollte (kuerzer, englisch, mit Hausregeln), musste den Server
// aendern und neu bauen.
//
// Drei Dinge, die der Editor ueber ein Textfeld hinaus leistet, und jedes beantwortet eine Frage,
// die man beim Umschreiben tatsaechlich hat:
//   · welche Platzhalter gibt es (Chips, die sich per Klick an der Cursorstelle eintragen),
//   · welche davon nutzt diese Vorlage GERADE nicht (gedaempfter Chip statt stiller Auslassung),
//   · und steht da ein Name, den niemand ersetzt (Tippfehler bleiben sonst woertlich im Prompt).
import { computed, ref } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  prompts: { type: Object, required: true },
  defaults: { type: Object, default: () => ({}) },
  placeholders: { type: Object, default: () => ({}) },
  placeholderHelp: { type: Object, default: () => ({}) },
  fields: { type: Array, default: () => [] },
  overrides: { type: Array, default: () => [] },
})
const emit = defineEmits(['update', 'reset'])

const active = ref('method')
const area = ref(null)

const tabs = computed(() =>
  props.fields
    .filter((f) => f.group === 'prompts')
    .map((f) => ({ key: f.path.split('.').pop(), label: f.label, hint: f.hint })),
)
const activeTab = computed(() => tabs.value.find((t) => t.key === active.value) || tabs.value[0] || null)
const text = computed(() => props.prompts?.[active.value] ?? '')
const known = computed(() => props.placeholders?.[active.value] || [])
const isDefault = computed(() => text.value === (props.defaults?.[active.value] ?? ''))
const overridden = computed(() => props.overrides.includes(`prompts.${active.value}`))

const used = computed(() => new Set([...String(text.value).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))
const unknown = computed(() => [...used.value].filter((n) => !known.value.includes(n)))
// Die geschweiften Klammern werden hier gebaut und nicht im Template: eine Interpolation, die
// selbst `}}` enthaelt, beendet der Vue-Parser an der falschen Stelle.
const ph = (name) => `{${name}}`
const unknownList = computed(() => unknown.value.map(ph).join(', '))
const missingContext = computed(() => known.value.includes('context') && !used.value.has('context'))

// Am Cursor einsetzen statt hinten anhaengen: ein Platzhalter gehoert an die Stelle im Satz, an
// der man gerade schreibt.
function insert(name) {
  const el = area.value
  const token = `{${name}}`
  if (!el) {
    emit('update', active.value, text.value + token)
    return
  }
  const start = el.selectionStart ?? text.value.length
  const end = el.selectionEnd ?? start
  const next = text.value.slice(0, start) + token + text.value.slice(end)
  emit('update', active.value, next)
  requestAnimationFrame(() => {
    el.focus()
    el.selectionStart = el.selectionEnd = start + token.length
  })
}
</script>

<template>
  <div>
    <!-- Vier Vorlagen als Segmente: beschriftet ist, was es gibt, markiert, wo man steht. -->
    <div class="mb-3 flex flex-wrap gap-1">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="relative rounded-md border px-3 py-1.5 text-xs font-medium transition"
        :class="active === t.key
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line text-muted hover:border-line-strong'"
        @click="active = t.key"
      >
        {{ t.label }}
        <span
          v-if="overrides.includes(`prompts.${t.key}`)"
          class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent"
          title="Custom template"
        />
      </button>
    </div>

    <p v-if="activeTab" class="mb-2.5 text-2xs leading-relaxed text-muted">{{ activeTab.hint }}</p>

    <!-- Platzhalter: was diese Vorlage kennt. Gedaempft = im Text gerade nicht verwendet. -->
    <div class="mb-2 flex flex-wrap items-center gap-1">
      <button
        v-for="p in known"
        :key="p"
        type="button"
        class="rounded border px-1.5 py-0.5 font-mono text-3xs transition"
        :class="used.has(p)
          ? 'border-accent/40 bg-accent-soft text-accent'
          : 'border-dashed border-line text-muted hover:border-line-strong hover:text-ink'"
        :title="placeholderHelp[p] || ''"
        @click="insert(p)"
      >{{ ph(p) }}</button>
    </div>

    <textarea
      ref="area"
      class="min-h-[16rem] w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink transition focus:border-accent focus:outline-none"
      spellcheck="false"
      :value="text"
      @input="emit('update', active, $event.target.value)"
    />

    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p v-if="missingContext" class="inline-flex items-start gap-1.5 text-2xs text-warning">
        <Icon icon="lucide:alert-triangle" class="mt-px h-3.5 w-3.5 shrink-0" />
        <span>Without <code class="font-mono">{{ ph('context') }}</code> neither the project context nor the knowledge from earlier analyses reaches the model.</span>
      </p>
      <p v-if="unknown.length" class="inline-flex items-start gap-1.5 text-2xs text-warning">
        <Icon icon="lucide:alert-triangle" class="mt-px h-3.5 w-3.5 shrink-0" />
        <span>Nothing replaces <code class="font-mono">{{ unknownList }}</code> — it stays in the prompt as literal text.</span>
      </p>

      <span class="ml-auto inline-flex items-center gap-2">
        <span class="font-mono text-3xs text-muted">{{ text.length }} chars</span>
        <button
          v-if="!isDefault"
          type="button"
          class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 font-mono text-3xs text-muted transition hover:border-line-strong hover:text-ink"
          title="Back to the template shipped with Wikit"
          @click="emit('reset', active)"
        >
          <Icon icon="lucide:rotate-ccw" class="h-3 w-3" />
          Restore default
        </button>
        <span v-else class="font-mono text-3xs text-muted">default template</span>
      </span>
    </div>
  </div>
</template>
