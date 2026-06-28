<script setup>
// Edge-Detail-Panel fuer eine Call-Kante im Klassengraphen.
// Zeigt die Abhaengigkeit als Parent -> Target: oben die aufrufende Klasse mit dem
// verwendenden Methodenrumpf (read-only CodeMirror via JavaCodeEditor), ein Pfeil-Divider
// in Akzentfarbe, unten die aufgerufene Klasse mit prominent dargestellten Ziel-Methoden
// (inkl. Signatur, falls bekannt). Schliesst per ESC oder Close-Button.
// Reines Praesentations-Panel: alle Daten kommen aus `edge` (kein Request, kein Pinia).
import { computed, watch, onUnmounted } from 'vue'
import { Icon } from '../../lib/icons.js'
import JavaCodeEditor from './JavaCodeEditor.vue'

const props = defineProps({
  edge: { type: Object, default: null },
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

function close() {
  emit('close')
}

// Pro aufrufende Methode gruppieren -> jeder Methodenrumpf nur einmal anzeigen.
const callerGroups = computed(() => {
  if (!props.edge?.callSites) return []
  const map = new Map()
  for (const cs of props.edge.callSites) {
    if (!map.has(cs.callerMethod)) {
      map.set(cs.callerMethod, { callerMethod: cs.callerMethod, callerBody: cs.callerBody, callees: new Set() })
    }
    map.get(cs.callerMethod).callees.add(cs.calleeMethod)
  }
  return [...map.values()].map((g) => ({ ...g, callees: [...g.callees] }))
})

// Aufgerufene Methoden mit (optionaler) Signatur fuer die Target-Sektion.
const calleeList = computed(() => {
  if (!props.edge) return []
  const sigs = new Map((props.edge.calleeSignatures || []).map((s) => [s.name, s.signature]))
  return (props.edge.callees || []).map((name) => ({ name, signature: sigs.get(name) || '' }))
})

function onKeydown(e) {
  if (e.key === 'Escape') close()
}
watch(
  () => props.visible,
  (vis) => {
    if (vis) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="panel">
      <div
        v-if="visible && edge"
        class="fixed inset-0 z-50 flex items-end justify-center md:items-stretch md:justify-end"
      >
        <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="close" />

        <aside
          class="sheet relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl md:max-h-none md:h-full md:max-w-xl md:rounded-t-none md:rounded-l-2xl md:border-l md:border-t-0"
        >
          <!-- Kopf -->
          <header class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div class="flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:share-2" class="h-4 w-4 text-[var(--color-accent)]" />
              Abhängigkeit
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Schließen (ESC)"
              aria-label="Schließen"
              @click="close"
            >
              <Icon icon="lucide:x" class="h-5 w-5" />
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <!-- ── Parent: aufrufende Klasse ── -->
            <section class="p-4">
              <div class="mb-3 flex items-center gap-2.5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:code-2" class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                  <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Aufrufende Klasse</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.fromClass }}</h2>
                </div>
              </div>

              <div v-for="grp in callerGroups" :key="grp.callerMethod" class="mb-3 last:mb-0">
                <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <code class="rounded-md bg-[var(--color-surface-offset)] px-1.5 py-0.5 font-mono font-semibold text-[var(--color-text)]">{{ grp.callerMethod }}()</code>
                  <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                  <code
                    v-for="c in grp.callees"
                    :key="c"
                    class="rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[var(--color-accent)]"
                  >{{ c }}()</code>
                </div>
                <div class="h-60 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)]">
                  <JavaCodeEditor :model-value="grp.callerBody" readonly />
                </div>
              </div>
            </section>

            <!-- ── Divider: Abhaengigkeitsrichtung ── -->
            <div class="flex items-center gap-3 px-4">
              <span class="h-px flex-1 bg-[var(--color-border)]" />
              <span class="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:arrow-down" class="h-4 w-4 edge-arrow" />
              </span>
              <span class="h-px flex-1 bg-[var(--color-border)]" />
            </div>

            <!-- ── Target: aufgerufene Klasse ── -->
            <section class="p-4">
              <div class="mb-3 flex items-center gap-2.5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:target" class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                  <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Aufgerufene Klasse</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.toClass }}</h2>
                </div>
              </div>

              <div class="space-y-2">
                <div
                  v-for="c in calleeList"
                  :key="c.name"
                  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-2"
                >
                  <div class="flex items-center gap-2">
                    <Icon icon="lucide:braces" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                    <code class="font-mono text-sm font-semibold text-[var(--color-text)]">{{ c.name }}()</code>
                  </div>
                  <code v-if="c.signature" class="mt-1 block truncate font-mono text-[11px] text-[var(--color-text-muted)]">{{ c.signature }}</code>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Slide-in: mobil als Bottom-Sheet (translateY), ab md als Side-Panel (translateX). */
.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.18s ease;
}
.panel-enter-active .sheet,
.panel-leave-active .sheet {
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
}
.panel-enter-from .sheet,
.panel-leave-to .sheet {
  transform: translateY(100%);
}
@media (min-width: 768px) {
  .panel-enter-from .sheet,
  .panel-leave-to .sheet {
    transform: translateX(100%);
  }
}

/* Dezente Richtungsanimation des Divider-Pfeils. */
.edge-arrow {
  animation: edge-arrow-bounce 1.8s ease-in-out infinite;
}
@keyframes edge-arrow-bounce {
  0%, 100% { transform: translateY(-1px); opacity: 0.7; }
  50% { transform: translateY(2px); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .edge-arrow { animation: none; }
}
</style>
