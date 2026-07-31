<script setup>
// Verbindungsstand in einer Karte: erreichbar?, welche Version, wie schnell – und ob das
// eingestellte Modell dort ueberhaupt liegt.
//
// Der letzte Punkt ist der Grund, warum die Karte mehr als einen gruenen Haken zeigt: Ollama
// antwortet auch dann bereitwillig, wenn das Modell nie gepullt wurde. Der Fehler faellt sonst
// erst mitten im Massenlauf auf, und zwar als leere Beschreibung, nicht als Meldung.
import { computed } from 'vue'
import { Icon } from '../../lib/icons.js'
import { formatRelative } from '../../lib/format.js'

const props = defineProps({
  health: { type: Object, default: null },
  checking: { type: Boolean, default: false },
  // Was gerade im Formular steht – der Test laeuft dagegen, nicht gegen den gespeicherten Stand.
  host: { type: String, default: '' },
  model: { type: String, default: '' },
  dirty: { type: Boolean, default: false },
})
defineEmits(['check'])

const state = computed(() => {
  const h = props.health
  if (!h) return 'unknown'
  if (!h.online) return 'offline'
  if (h.modelInstalled === false) return 'warn'
  return 'online'
})

const META = {
  online: { color: 'var(--color-success)', icon: 'lucide:check-circle', title: 'Connected' },
  warn: { color: 'var(--color-warning)', icon: 'lucide:alert-triangle', title: 'Model not on the server' },
  offline: { color: 'var(--color-danger)', icon: 'lucide:x', title: 'Not reachable' },
  unknown: { color: 'var(--color-text-muted)', icon: 'lucide:activity', title: 'Not checked yet' },
}
const meta = computed(() => META[state.value])

const detail = computed(() => {
  const h = props.health
  if (!h) return 'Run the test to see whether Ollama answers and whether the selected model is available.'
  if (!h.online) return h.error
  if (h.modelInstalled === false) {
    return `Ollama answers, but "${h.model}" is not among the ${h.modelCount} installed models. Pull it on the server (ollama pull ${h.model}) or pick one from the catalog below.`
  }
  if (h.modelInstalled === null) return 'Ollama answers. The model catalog could not be read, so the model could not be verified.'
  return `Ollama answers and "${h.model}" is installed.`
})

// Nur Zahlen, die es wirklich gibt – eine Zeile „latency 0 ms" ueber einer toten Verbindung waere
// eine Messung von nichts.
const facts = computed(() => {
  const h = props.health
  if (!h?.online) return []
  return [
    { label: 'latency', value: `${h.latencyMs} ms`, icon: 'lucide:gauge' },
    { label: 'version', value: h.version || 'unknown', icon: 'lucide:server' },
    { label: 'models', value: String(h.modelCount ?? 0), icon: 'lucide:cpu' },
  ]
})
</script>

<template>
  <div
    class="relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 pl-5"
  >
    <span class="absolute inset-y-0 left-0 w-1" :style="{ background: meta.color }" />

    <div class="flex flex-wrap items-start gap-3">
      <span
        class="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
        :style="{ background: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color }"
      >
        <Icon :icon="checking ? 'lucide:loader-2' : meta.icon" class="h-5 w-5" :class="checking ? 'animate-spin' : ''" />
      </span>

      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-[var(--color-text)]">
          {{ checking ? 'Testing the connection…' : meta.title }}
          <span v-if="health?.checkedAt && !checking" class="font-mono text-3xs font-normal text-[var(--color-text-muted)]">
            checked {{ formatRelative(health.checkedAt) }}
          </span>
        </p>
        <p class="mt-1 text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ detail }}</p>

        <div v-if="facts.length" class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span
            v-for="f in facts"
            :key="f.label"
            class="inline-flex items-center gap-1.5 font-mono text-2xs text-[var(--color-text-muted)]"
          >
            <Icon :icon="f.icon" class="h-3.5 w-3.5 opacity-70" />
            <span class="font-semibold tabular-nums text-[var(--color-text)]">{{ f.value }}</span>
            {{ f.label }}
          </span>
        </div>
      </div>

      <button
        type="button"
        class="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition hover:border-[var(--color-border-strong)] disabled:opacity-50"
        :disabled="checking"
        @click="$emit('check')"
      >
        <span class="inline-flex items-center gap-1.5">
          <Icon icon="lucide:plug" class="h-3.5 w-3.5" />
          Test connection
        </span>
      </button>
    </div>

    <!-- Der Test laeuft gegen das FORMULAR. Steht dort etwas anderes als gespeichert, gehoert das
         dazugesagt – sonst liest man ein gruenes Ergebnis als Aussage ueber den laufenden Betrieb. -->
    <p v-if="dirty" class="mt-3 border-t border-[var(--color-border)] pt-2 font-mono text-3xs text-[var(--color-text-muted)]">
      Tested against the form: {{ host }} · {{ model }} — not saved yet.
    </p>
  </div>
</template>
