<script setup>
// Vollstaendige Kuerzel-Uebersicht (`?`). Rendert AUS DER REGISTRY (lib/shortcuts.js) – eine
// gepflegte Liste an einer Stelle statt einer zweiten, die irgendwann danebenliegt.
import { computed } from 'vue'
import { SHORTCUTS, SHORTCUT_GROUPS, keyChips, IS_MAC } from '../lib/shortcuts.js'
import { Icon } from '../lib/icons.js'

defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const groups = computed(() =>
  SHORTCUT_GROUPS.map((g) => ({ ...g, items: SHORTCUTS.filter((s) => s.scope === g.scope) })).filter(
    (g) => g.items.length,
  ),
)
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <div class="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-2xl">
          <header class="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-4">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Icon icon="lucide:terminal" class="h-4.5 w-4.5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-bold text-[var(--color-text)]">Keyboard shortcuts</h2>
              <p class="text-xs text-[var(--color-text-muted)]">
                {{ IS_MAC ? '⌘ stands for Command' : 'Ctrl works together with the keys shown' }} — press
                <kbd class="rounded border border-[var(--color-border)] px-1 font-mono text-3xs">?</kbd> anywhere to see this again.
              </p>
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
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
                <h3 class="mb-2 font-mono text-3xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                  {{ g.title }}
                </h3>
                <ul class="space-y-1.5">
                  <li v-for="s in g.items" :key="s.id" class="flex items-baseline gap-3">
                    <span class="flex shrink-0 items-center gap-1">
                      <template v-for="(combo, ci) in s.keys" :key="combo">
                        <!-- Tastenfolge (g dann c) statt Kombination: das „dann" gehoert sichtbar
                             dazwischen, sonst liest man es als gleichzeitig. -->
                        <span v-if="ci > 0" class="px-0.5 text-3xs text-[var(--color-text-muted)]">
                          {{ s.seq ? 'then' : '/' }}
                        </span>
                        <kbd
                          v-for="chip in keyChips(combo)"
                          :key="chip"
                          class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-2xs font-medium text-[var(--color-text)] shadow-sm"
                        >{{ chip }}</kbd>
                      </template>
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="text-sm text-[var(--color-text)]">{{ s.label }}</span>
                      <span v-if="s.hint" class="block text-2xs leading-snug text-[var(--color-text-muted)]">{{ s.hint }}</span>
                    </span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
