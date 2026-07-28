<script setup>
// Slide-over (rechter Rand): loest eine AGGREGATKANTE des Package-Graphen auf.
//
// Auf der Package-Ebene steht eine Kante fuer viele Klassenbeziehungen und traegt nur deren Zahl
// („17 class relations"). Das ist eine Behauptung, die man nicht nachpruefen kann – man musste
// erst in beide Packages hineinzoomen und die Kanten selbst suchen. Dieses Panel zeigt die Paare
// direkt, gruppiert nach Klassenpaar und sortiert nach Aussagekraft (Aufruf > Typbezug > Import).
//
// Der zweite Klick fuehrt weiter: Paare mit erkannten Methodenaufrufen oeffnen das bestehende
// Edge-Detail-Panel MIT der Aufrufstelle im Code (`open`), alle anderen springen wenigstens zur
// Klasse (`select`) – fuer einen reinen Import gibt es keine Codestelle, die man zeigen koennte.
//
// Reines UI: Datenbeschaffung und Panel-Wechsel liegen im Parent (JavaDependencyGraph).
import { ref, computed, watch, onUnmounted } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // { fromLabel, toLabel, fromIsClass, toIsClass, count, relations: [{ key, provider, consumer, kind, methods }] }
  bundle: { type: Object, default: null },
})
const emit = defineEmits(['close', 'open', 'select'])

const query = ref('')

// Kantenart -> Beschriftung/Farbe. Spiegelt exakt das Vokabular des Graphen; eine eigene
// Benennung an dieser Stelle waere eine zweite Sprache fuer dieselbe Sache.
const KIND_META = {
  call: { label: 'calls', color: 'var(--color-accent)', icon: 'lucide:arrow-right' },
  uses: { label: 'uses type', color: 'var(--color-cyan)', icon: 'lucide:box' },
  import: { label: 'imports', color: 'var(--color-text-muted)', icon: 'lucide:link' },
}

const relations = computed(() => props.bundle?.relations || [])
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return relations.value
  return relations.value.filter(
    (r) =>
      r.provider.class_name.toLowerCase().includes(q) ||
      r.consumer.class_name.toLowerCase().includes(q) ||
      (r.methods || []).some((m) => (m.method || '').toLowerCase().includes(q)),
  )
})
// Bilanz im Kopf: wieviele der Beziehungen sind echte Aufrufe, wieviele nur Imports?
const tally = computed(() => {
  const t = { call: 0, uses: 0, import: 0 }
  for (const r of relations.value) t[r.kind] = (t[r.kind] || 0) + 1
  return t
})

const methodsOf = (r) => (r.methods || []).filter((m) => m && m.method)

function pick(r) {
  if (methodsOf(r).length) emit('open', r)
  else emit('select', r.provider.id)
}

function close() {
  emit('close')
}
function onKeydown(e) {
  if (e.key === 'Escape') close()
}
watch(
  () => props.visible,
  (vis) => {
    if (vis) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
    query.value = ''
  },
)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="slideover">
      <div
        v-if="visible && bundle"
        class="fixed inset-0 z-50"
        role="dialog"
        aria-modal="true"
        aria-label="Bundled class relations"
      >
        <div class="slideover-backdrop absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="close" />

        <aside
          class="slideover-panel absolute right-0 top-0 flex h-full w-[min(94vw,30rem)] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        >
          <header class="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
            <div class="flex items-center justify-between gap-3">
              <h2 class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
                <Icon icon="lucide:git-fork" class="h-4 w-4 shrink-0 text-[var(--color-thistle)]" />
                <span class="truncate">Bundled relations</span>
              </h2>
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                title="Close (ESC)"
                aria-label="Close"
                @click="close"
              >
                <Icon icon="lucide:x" class="h-5 w-5" />
              </button>
            </div>

            <!-- Richtung des Buendels: definierende Seite -> nutzende Seite, wie der Pfeil im Graph. -->
            <div class="mt-2 flex items-center gap-2 text-[13px]">
              <span class="bundle-end">
                <Icon :icon="bundle.fromIsClass ? 'lucide:box' : 'lucide:folder'" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ bundle.fromLabel }}</span>
              </span>
              <Icon icon="lucide:arrow-right" class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
              <span class="bundle-end">
                <Icon :icon="bundle.toIsClass ? 'lucide:box' : 'lucide:folder'" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ bundle.toLabel }}</span>
              </span>
            </div>
            <!-- Bilanz als Label/Wert-Paare statt als Satz: „1 relations" oder „8 with a method
                 calls" waere sonst kaum grammatisch sauber zu bekommen. -->
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span v-if="tally.call" class="tally" style="--k: var(--color-accent)">calls <b>{{ tally.call }}</b></span>
              <span v-if="tally.uses" class="tally" style="--k: var(--color-cyan)">type usage <b>{{ tally.uses }}</b></span>
              <span v-if="tally.import" class="tally" style="--k: var(--color-text-muted)">import-only <b>{{ tally.import }}</b></span>
              <span class="tally tally--total">total <b>{{ relations.length }}</b></span>
            </div>
            <p class="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Arrows read “defines → uses”.</p>

            <label v-if="relations.length > 8" class="mt-2 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
              <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <input
                v-model="query"
                type="text"
                placeholder="Filter by class or method…"
                class="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
              />
            </label>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <p v-if="!filtered.length" class="px-1 py-6 text-center text-xs text-[var(--color-text-muted)]">
              Nothing matches “{{ query }}”.
            </p>

            <ul v-else class="flex flex-col gap-1.5">
              <li v-for="r in filtered" :key="r.key">
                <button
                  type="button"
                  class="rel-row"
                  :class="{ 'rel-row--code': methodsOf(r).length }"
                  :style="{ '--kind': KIND_META[r.kind].color }"
                  :title="methodsOf(r).length ? 'Show the calling code' : 'Open this class — no call site to show'"
                  @click="pick(r)"
                >
                  <span class="rel-kind">{{ KIND_META[r.kind].label }}</span>
                  <span class="rel-pair">
                    <span class="rel-class">{{ r.provider.class_name }}</span>
                    <Icon icon="lucide:arrow-right" class="h-3 w-3 shrink-0 opacity-50" />
                    <span class="rel-class">{{ r.consumer.class_name }}</span>
                  </span>
                  <span v-if="methodsOf(r).length" class="rel-methods">
                    <span v-for="m in methodsOf(r).slice(0, 3)" :key="m.edgeId ?? m.method" class="rel-method">{{ m.method }}()</span>
                    <span v-if="methodsOf(r).length > 3" class="rel-more">+{{ methodsOf(r).length - 3 }}</span>
                  </span>
                  <Icon
                    :icon="methodsOf(r).length ? 'lucide:code-2' : 'lucide:arrow-right'"
                    class="rel-go h-4 w-4 shrink-0"
                  />
                </button>
              </li>
            </ul>
          </div>

          <footer class="shrink-0 border-t border-[var(--color-border)] px-4 py-2.5 text-[11px] text-[var(--color-text-muted)]">
            Rows with methods open the calling code — the rest jump to the class.
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/style.css";

.bundle-end {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  border-radius: 8px;
  background: var(--color-surface-offset);
  padding: 2px 8px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

/* Zaehler im Kopf: Kategorie + Zahl, in der Farbe der jeweiligen Kantenart. */
.tally {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--k) 32%, transparent);
  background: color-mix(in srgb, var(--k) 12%, transparent);
  padding: 1px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--k);
}
.tally b {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}
.tally--total {
  --k: var(--color-text-muted);
  border-style: dashed;
  background: none;
}

/* Eine Zeile = ein Klassenpaar. Der farbige Balken links traegt die Kantenart, damit sich die
   Liste in derselben Sprache liest wie der Graph. */
.rel-row {
  display: grid;
  width: 100%;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 4px 8px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--kind);
  background: var(--color-surface);
  padding: 7px 9px;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
}
.rel-row:hover {
  border-color: color-mix(in srgb, var(--kind) 60%, var(--color-border));
  border-left-color: var(--kind);
  background: var(--color-surface-2);
}
.rel-row:active {
  transform: translateY(1px);
}
.rel-kind {
  grid-column: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--kind) 16%, transparent);
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 700;
  color: var(--kind);
  white-space: nowrap;
}
.rel-pair {
  display: flex;
  min-width: 0;
  grid-column: 2;
  align-items: center;
  gap: 5px;
}
.rel-class {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}
.rel-methods {
  display: flex;
  min-width: 0;
  grid-column: 2;
  flex-wrap: wrap;
  gap: 3px;
}
.rel-method {
  border-radius: 5px;
  background: var(--color-surface-offset);
  padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--color-text-muted);
}
.rel-more {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-muted);
}
.rel-go {
  grid-column: 3;
  grid-row: 1 / span 2;
  color: var(--color-text-muted);
  opacity: 0.5;
  transition: opacity 0.15s ease, color 0.15s ease;
}
.rel-row:hover .rel-go {
  opacity: 1;
  color: var(--kind);
}
/* Zeilen mit Code dahinter duerfen sich staerker anfuehlen als reine Sprungmarken. */
.rel-row--code {
  cursor: pointer;
}
</style>
