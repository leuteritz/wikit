<script setup>
// Was per `ollama pull` auf dem Server liegt – als Karten, nicht als Auswahlliste.
//
// Der Grund ist die Entscheidung, die hier faellt: welches Modell taugt fuer die Doku-Laeufe? Dafuer
// zaehlen Parametergroesse, Quantisierung und Dateigroesse (auf einem Pi ist das die Frage, ob es
// ueberhaupt laeuft) – lauter Angaben, die in ein <option> nicht hineinpassen.
import { Icon } from '../../lib/icons.js'
import { formatRelative } from '../../lib/format.js'

defineProps({
  models: { type: Array, default: () => [] },
  active: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  host: { type: String, default: '' },
})
defineEmits(['select', 'refresh'])

function gb(bytes) {
  const n = Number(bytes || 0)
  if (!n) return ''
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
}

// „qwen2.5-coder:3b" und „qwen2.5-coder" meinen dasselbe Modell (Ollama ergaenzt :latest) – die
// Markierung muss das genauso sehen wie der Verbindungstest, sonst zeigt die Karte „nicht aktiv"
// bei einem Modell, das gerade laeuft.
function isActive(name, active) {
  if (!name || !active) return false
  return name === active || name === `${active}:latest` || name.split(':')[0] === active
}
</script>

<template>
  <div>
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
      <p class="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Installed on {{ host || 'the server' }}
      </p>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-2xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
        :disabled="loading"
        @click="$emit('refresh')"
      >
        <Icon icon="lucide:refresh-cw" class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        Refresh
      </button>
    </div>

    <p
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2.5 text-2xs leading-relaxed text-[var(--color-text)]"
    >
      {{ error }}
    </p>

    <p
      v-else-if="!models.length && !loading"
      class="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-2xs text-[var(--color-text-muted)]"
    >
      No models installed. Pull one on the server, e.g.
      <code class="rounded bg-[var(--color-surface-offset)] px-1.5 py-0.5 font-mono text-[var(--color-text)]">ollama pull qwen2.5-coder:3b</code>
    </p>

    <div v-else class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <button
        v-for="m in models"
        :key="m.name"
        type="button"
        class="group rounded-lg border px-3 py-2.5 text-left transition"
        :class="isActive(m.name, active)
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'"
        @click="$emit('select', m.name)"
      >
        <span class="flex items-center gap-2">
          <Icon
            :icon="isActive(m.name, active) ? 'lucide:check-circle' : 'lucide:cpu'"
            class="h-4 w-4 shrink-0"
            :class="isActive(m.name, active) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
          />
          <span
            class="min-w-0 flex-1 truncate font-mono text-xs font-semibold"
            :class="isActive(m.name, active) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'"
          >{{ m.name }}</span>
        </span>

        <span class="mt-2 flex flex-wrap items-center gap-1">
          <span
            v-if="m.parameterSize"
            class="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs text-[var(--color-text-muted)]"
          >{{ m.parameterSize }}</span>
          <span
            v-if="m.quantization"
            class="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs text-[var(--color-text-muted)]"
          >{{ m.quantization }}</span>
          <span v-if="gb(m.size)" class="inline-flex items-center gap-1 font-mono text-3xs text-[var(--color-text-muted)]">
            <Icon icon="lucide:hard-drive" class="h-3 w-3 opacity-70" />
            {{ gb(m.size) }}
          </span>
        </span>

        <span v-if="m.modifiedAt" class="mt-1.5 block font-mono text-3xs text-[var(--color-text-muted)]">
          pulled {{ formatRelative(m.modifiedAt) }}
        </span>
      </button>
    </div>
  </div>
</template>
