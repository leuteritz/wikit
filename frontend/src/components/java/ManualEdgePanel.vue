<script setup>
// Slide-over (rechter Rand) zum manuellen Anlegen einer Klassen-Kante im Code-Graphen.
// Ausgeloest durch Drag-to-Connect zwischen zwei Klassen-Knoten (JavaDependencyGraph).
//
// Gerichteter Fluss analog zum Graph-Pfeil (Definition -> Nutzung):
//   * Oben „Quelle · definiert": die Klasse, DEREN Methode aufgerufen wird (Definition).
//   * Mitte: deren Methoden als Single-Select-Pills (Pflicht, falls Methoden vorhanden).
//   * Unten „Anwender · ruft auf": die nutzende Klasse.
// „Richtung tauschen" vertauscht oben/unten (falls der Nutzer verkehrt herum gezogen hat) –
// die Methodenliste folgt immer der OBEN gezeigten (Definitions-)Klasse.
//
// Persistenz laeuft im Parent ueber useJavaGraph().createEdge (HTTP nur via lib/api.js).
// Dieses Panel ist reines UI: es emittiert nur save/close/swap.
import { ref, computed, watch, onUnmounted } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  sourceFile: { type: Object, default: null }, // oben: Definition (deren Methode genutzt wird)
  targetFile: { type: Object, default: null }, // unten: Anwender (ruft auf)
})
const emit = defineEmits(['save', 'close', 'swap'])

const selectedMethod = ref(null)

// Eindeutige, sortierte Methodennamen der oben gezeigten (Definitions-)Klasse.
const methods = computed(() => {
  const seen = new Set()
  const out = []
  for (const m of props.sourceFile?.methods || []) {
    const name = m.method_name
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort((a, b) => a.localeCompare(b))
})

const hasMethods = computed(() => methods.value.length > 0)
// Speichern erlaubt, sobald eine Methode gewaehlt ist – oder wenn die Klasse gar keine
// Methoden hat (dann entsteht eine label-lose manuelle Kante; Backend akzeptiert method=null).
const canSave = computed(() => !hasMethods.value || !!selectedMethod.value)

function pick(name) {
  selectedMethod.value = selectedMethod.value === name ? null : name
}

function save() {
  if (!canSave.value) return
  emit('save', { methodName: selectedMethod.value || null })
}

function close() {
  emit('close')
}

function onKeydown(e) {
  if (e.key === 'Escape') close()
}

// Bei jedem Oeffnen / Klassentausch die Auswahl zuruecksetzen + ESC-Handler verwalten.
watch(
  () => props.visible,
  (vis) => {
    if (vis) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)
watch(
  () => [props.sourceFile?.id, props.targetFile?.id],
  () => {
    selectedMethod.value = null
  },
)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="slideover">
      <div
        v-if="visible && sourceFile && targetFile"
        class="fixed inset-0 z-50"
        role="dialog"
        aria-modal="true"
        aria-label="Manuelle Verbindung anlegen"
      >
        <!-- Dezenter Backdrop: klick schliesst -->
        <div class="slideover-backdrop absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="close" />

        <!-- Panel am rechten Rand -->
        <aside
          class="slideover-panel absolute right-0 top-0 flex h-full w-[min(92vw,26rem)] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        >
          <header class="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <h2 class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:link" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate">Verbindung anlegen</span>
            </h2>
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

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <!-- ── Quelle: definierende Klasse (oben) ── -->
            <div class="flex items-start gap-2.5">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:file-code" class="h-5 w-5" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Quelle · definiert</div>
                <h3 class="truncate text-base font-bold text-[var(--color-text)]">{{ sourceFile.class_name }}</h3>
                <p class="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{{ sourceFile.filename }}</p>
              </div>
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                title="Richtung tauschen"
                aria-label="Richtung tauschen"
                @click="emit('swap')"
              >
                <Icon icon="lucide:arrow-up-down" class="h-4 w-4" />
              </button>
            </div>

            <!-- ── Methoden-Auswahl (Pflicht, falls vorhanden) ── -->
            <div class="mt-4">
              <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                <Icon icon="lucide:braces" class="h-3.5 w-3.5" />
                Aufgerufene Methode
                <span v-if="hasMethods" class="text-[var(--color-danger)]">*</span>
              </div>
              <div v-if="hasMethods" class="flex flex-wrap gap-1.5">
                <button
                  v-for="name in methods"
                  :key="name"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition"
                  :class="selectedMethod === name
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'"
                  @click="pick(name)"
                >
                  <Icon v-if="selectedMethod === name" icon="lucide:check" class="h-3 w-3 shrink-0" />
                  {{ name }}()
                </button>
              </div>
              <p v-else class="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
                Diese Klasse hat keine analysierten Methoden – die Verbindung wird ohne Methodennamen angelegt.
              </p>
            </div>

            <!-- ── Richtungs-Divider ── -->
            <div class="my-4 flex items-center gap-3">
              <span class="h-px flex-1 bg-[var(--color-border)]" />
              <span class="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:arrow-down" class="h-4 w-4" />
              </span>
              <span class="h-px flex-1 bg-[var(--color-border)]" />
            </div>

            <!-- ── Anwender: nutzende Klasse (unten) ── -->
            <div class="flex items-start gap-2.5">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:code-2" class="h-5 w-5" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Anwender · ruft auf</div>
                <h3 class="truncate text-base font-bold text-[var(--color-text)]">{{ targetFile.class_name }}</h3>
                <p class="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{{ targetFile.filename }}</p>
              </div>
            </div>
          </div>

          <!-- Footer: speichern -->
          <footer class="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
            <button
              type="button"
              class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSave"
              @click="save"
            >
              <Icon icon="lucide:link" class="h-4 w-4" />
              Verbindung speichern
            </button>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Slide-over: Backdrop faded, Panel faehrt von rechts ein. */
.slideover-enter-active,
.slideover-leave-active {
  transition: opacity 0.2s ease;
}
.slideover-enter-active .slideover-panel,
.slideover-leave-active .slideover-panel {
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}
.slideover-enter-from,
.slideover-leave-to {
  opacity: 0;
}
.slideover-enter-from .slideover-panel,
.slideover-leave-to .slideover-panel {
  transform: translateX(100%);
}
@media (prefers-reduced-motion: reduce) {
  .slideover-enter-active .slideover-panel,
  .slideover-leave-active .slideover-panel {
    transition: none;
  }
  .slideover-enter-from .slideover-panel,
  .slideover-leave-to .slideover-panel {
    transform: none;
  }
}
</style>
