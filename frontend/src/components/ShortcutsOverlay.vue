<script setup>
// Vollstaendige Kuerzel-Uebersicht (`?`). Rendert AUS DER REGISTRY (lib/shortcuts.js) – eine
// gepflegte Liste an einer Stelle statt einer zweiten, die irgendwann danebenliegt.
import { computed } from 'vue'
import { SHORTCUTS, SHORTCUT_GROUPS, keyChips, IS_MAC } from '../lib/shortcuts.js'
import { Icon } from '../lib/icons.js'
import Modal from './ui/Modal.vue'
import SectionLabel from './ui/SectionLabel.vue'

defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const groups = computed(() =>
  SHORTCUT_GROUPS.map((g) => ({ ...g, items: SHORTCUTS.filter((s) => s.scope === g.scope) })).filter(
    (g) => g.items.length,
  ),
)
</script>

<template>
  <!-- Escape schliesst hier NICHT selbst: das macht App.vue zusammen mit Palette und
       Aktivitaets-Fenster, damit ein Druck nicht zwei Overlays gleichzeitig wegnimmt. -->
  <Modal
    :open="open"
    size="xl"
    max-height="max-h-[86vh]"
    elevation="elev-4"
    emphasis
    label="Keyboard shortcuts"
    @close="emit('close')"
  >
    <header class="flex items-center gap-3 border-b border-line px-5 py-4">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon icon="lucide:terminal" class="h-4.5 w-4.5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-bold text-ink">Keyboard shortcuts</h2>
              <p class="text-xs text-muted">
                {{ IS_MAC ? '⌘ stands for Command' : 'Ctrl works together with the keys shown' }} — press
                <kbd class="rounded border border-line px-1 font-mono text-3xs">?</kbd> anywhere to see this again.
              </p>
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-offset hover:text-ink"
              title="Close (Esc)"
              aria-label="Close"
              @click="emit('close')"
            >
              <Icon icon="lucide:x" class="h-4 w-4" />
            </button>
          </header>

    <!-- Zwei Spalten ab sm: die Gruppen sind kurz, untereinander waere es unnoetig viel
         Scrollen fuer eine Liste, die man im Blick behalten will. -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <section v-for="g in groups" :key="g.scope">
          <SectionLabel as="h3" class="mb-2">{{ g.title }}</SectionLabel>
          <ul class="space-y-1.5">
            <li v-for="s in g.items" :key="s.id" class="flex items-baseline gap-3">
              <span class="flex shrink-0 items-center gap-1">
                <template v-for="(combo, ci) in s.keys" :key="combo">
                  <!-- Tastenfolge (g dann c) statt Kombination: das „dann" gehoert sichtbar
                       dazwischen, sonst liest man es als gleichzeitig. -->
                  <span v-if="ci > 0" class="px-0.5 text-3xs text-muted">
                    {{ s.seq ? 'then' : '/' }}
                  </span>
                  <kbd
                    v-for="chip in keyChips(combo)"
                    :key="chip"
                    class="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs font-medium text-ink elev-1"
                  >{{ chip }}</kbd>
                </template>
              </span>
              <span class="min-w-0 flex-1">
                <span class="text-sm text-ink">{{ s.label }}</span>
                <span v-if="s.hint" class="block text-2xs leading-snug text-muted">{{ s.hint }}</span>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </Modal>
</template>
