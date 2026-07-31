<script setup>
// EIN Eingabefeld fuer EINE Einstellung – gezeichnet aus der Feldbeschreibung, die der Server
// mitliefert (Typ, Grenzen, Erklaerung). Deshalb steht hier keine einzige Zahl: waeren die Grenzen
// im Client wiederholt, boete das Formular irgendwann etwas an, das der Server ablehnt.
//
// Drei Dinge, die das Feld ueber den nackten Wert hinaus sagt:
//   · woher der aktuelle Wert stammt (Default aus Env/Code vs. eigene Einstellung),
//   · was der Default WAERE (als Knopf, nicht als Fussnote – zuruecksetzen ist ein Klick),
//   · und bei „auto"-faehigen Feldern, dass „leer" eine Aussage ist: das Modell entscheidet.
import { computed } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  spec: { type: Object, required: true },
  modelValue: { type: [String, Number, null], default: null },
  defaultValue: { type: [String, Number, null], default: null },
  // Steht der Wert als Zeile in der Datenbank? Dann ist er eine bewusste Einstellung.
  overridden: { type: Boolean, default: false },
  // Kommt der Default aus einer Env-Variablen? Dann wird sie benannt.
  envName: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const isNumber = computed(() => props.spec.type === 'int' || props.spec.type === 'float')

// Ein Regler lohnt nur bei einer Spanne, die man auch trifft. `num_ctx` reicht von 256 bis 131072:
// die 8192, die man eigentlich will, liegen dort im ersten Zwanzigstel der Bahn, und jeder Pixel
// verschiebt sie um Hunderte. Gemessen an den Feldern hier trennt die Grenze genau richtig –
// Temperature (40 Rasterschritte) und Top P (20) bekommen den Regler, Kontextfenster (511),
// Timeout (599) und Retry-Delay (240) das Zahlenfeld, das man in solchen Faellen ohnehin nutzt.
const RANGE_STEPS_MAX = 100
const hasRange = computed(() => {
  const s = props.spec
  if (!isNumber.value || s.min == null || s.max == null) return false
  return (s.max - s.min) / (s.step || 1) <= RANGE_STEPS_MAX
})
const isAuto = computed(() => props.spec.nullable && (props.modelValue == null || props.modelValue === ''))

// Millisekunden lesen sich ab einer Sekunde schlecht – die Umrechnung steht daneben, nicht
// anstelle des Werts: eingegeben wird weiter das, was der Server speichert.
const asSeconds = computed(() => {
  if (!isNumber.value || !/Ms$/.test(props.spec.path.split('.').pop())) return ''
  const n = Number(props.modelValue)
  if (!Number.isFinite(n) || n < 1000) return ''
  return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} s`
})

const changed = computed(() => JSON.stringify(props.modelValue ?? null) !== JSON.stringify(props.defaultValue ?? null))

function onNumber(raw) {
  if (raw === '' || raw == null) {
    emit('update:modelValue', props.spec.nullable ? null : props.defaultValue)
    return
  }
  const n = Number(raw)
  emit('update:modelValue', Number.isFinite(n) ? n : props.modelValue)
}

// Der „auto"-Schalter setzt null (Feld nicht mitschicken) bzw. faellt auf einen brauchbaren Wert
// zurueck: die Mitte der Spanne, sonst der Default. Ein leeres Zahlenfeld waere kein Startpunkt.
function toggleAuto() {
  if (isAuto.value) {
    const fallback =
      props.defaultValue ?? (hasRange.value ? Number(((props.spec.min + props.spec.max) / 2).toFixed(2)) : 0)
    emit('update:modelValue', fallback)
  } else {
    emit('update:modelValue', null)
  }
}
</script>

<template>
  <div class="bot-field">
    <div class="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <label class="text-sm font-medium text-[var(--color-text)]">{{ spec.label }}</label>

      <span
        v-if="overridden"
        class="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-1.5 py-px font-mono text-3xs uppercase tracking-wide text-[var(--color-accent)]"
      >custom</span>
      <span
        v-else-if="envName"
        class="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs uppercase tracking-wide text-[var(--color-text-muted)]"
        :title="`Default comes from the ${envName} environment variable`"
      >{{ envName }}</span>
      <span
        v-else
        class="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs uppercase tracking-wide text-[var(--color-text-muted)]"
      >default</span>

      <button
        v-if="changed"
        type="button"
        class="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-3xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
        :title="`Back to the default (${defaultValue == null ? 'auto' : defaultValue})`"
        @click="emit('update:modelValue', defaultValue ?? null)"
      >
        <Icon icon="lucide:rotate-ccw" class="h-3 w-3" />
        default
      </button>
    </div>

    <!-- Auswahl aus wenigen Werten: Segmente statt Dropdown – beschriftet ist, was es gibt,
         markiert, wo man steht. -->
    <div v-if="spec.type === 'enum'" class="flex flex-wrap gap-1">
      <button
        v-for="v in spec.values"
        :key="v"
        type="button"
        class="rounded-md border px-3 py-1.5 font-mono text-xs uppercase tracking-wide transition"
        :class="modelValue === v
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]'"
        @click="emit('update:modelValue', v)"
      >{{ v }}</button>
    </div>

    <!-- Zahl mit Spanne: Regler UND Zahlenfeld. Der Regler ist zum Ausprobieren da, das Feld fuer
         den Wert, den man schon kennt – eines von beiden allein waere fuer den jeweils anderen
         Fall die falsche Bedienung. -->
    <div v-else-if="isNumber" class="flex items-center gap-2.5">
      <button
        v-if="spec.nullable"
        type="button"
        class="shrink-0 rounded-md border px-2 py-1.5 font-mono text-2xs uppercase tracking-wide transition"
        :class="isAuto
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]'"
        title="Leave it to the model — the option is not sent at all"
        @click="toggleAuto"
      >auto</button>

      <input
        v-if="hasRange && !isAuto"
        type="range"
        class="bot-range min-w-0 flex-1"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step || 1"
        :value="modelValue ?? spec.min"
        @input="onNumber($event.target.value)"
      />
      <div v-else-if="!isAuto" class="flex-1" />

      <input
        v-if="!isAuto"
        type="number"
        class="w-28 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-right font-mono text-sm tabular-nums text-[var(--color-text)] transition focus:border-[var(--color-accent)] focus:outline-none"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step || 1"
        :value="modelValue ?? ''"
        @input="onNumber($event.target.value)"
      />
      <span v-else class="flex-1 text-sm text-[var(--color-text-muted)]">Left to the model</span>
      <span v-if="asSeconds" class="w-12 shrink-0 font-mono text-2xs text-[var(--color-text-muted)]">{{ asSeconds }}</span>
    </div>

    <!-- Mehrzeiliger Freitext (Projekt-Kontext). Prompt-Vorlagen haben ihren eigenen Editor. -->
    <textarea
      v-else-if="spec.type === 'text'"
      class="min-h-[7rem] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] transition focus:border-[var(--color-accent)] focus:outline-none"
      spellcheck="false"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', $event.target.value)"
    />

    <input
      v-else
      type="text"
      class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-text)] transition focus:border-[var(--color-accent)] focus:outline-none"
      spellcheck="false"
      autocomplete="off"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', $event.target.value)"
    />

    <p class="mt-1.5 text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ spec.hint }}</p>
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Der Regler traegt die Akzentfarbe der App statt der Browser-Voreinstellung – ohne `filter`,
   also ohne Offscreen-Textur (dieselbe Regel wie im Graphen). */
.bot-range {
  appearance: none;
  height: 4px;
  border-radius: 999px;
  background: var(--color-surface-offset);
  border: 1px solid var(--color-border);
}
.bot-range::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--color-accent);
  cursor: pointer;
  border: 2px solid var(--color-surface);
}
.bot-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 2px solid var(--color-surface);
  border-radius: 999px;
  background: var(--color-accent);
  cursor: pointer;
}
</style>
