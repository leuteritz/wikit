<script setup>
// Edge-Detail-Panel fuer eine Call-Kante im Klassengraphen (Aufrufer -> Definitionsklasse).
//   * Oben: aufrufende Klasse mit dem verwendenden Methodenrumpf (read-only CodeMirror).
//   * Pfeil-Divider in Akzentfarbe (Abhaengigkeitsrichtung).
//   * Unten: aufgerufene Methode(n) der Zielklasse – Signatur + Shiki-gehighlighteter
//     Quellcode (vom Backend, Dual-Theme via CSS-Variablen) + Navigations-Links
//     („Definiert in" / „Aufgerufen in") die die jeweilige Datei zeilengenau oeffnen.
// Schliesst per ESC, Backdrop oder Close-Button. HTTP nur ueber lib/api.js.
import { computed, watch, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../lib/api.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { Icon } from '../../lib/icons.js'
import JavaCodeEditor from './JavaCodeEditor.vue'

const props = defineProps({
  edge: { type: Object, default: null },
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const router = useRouter()
const { lastFileId, lastTargetLine } = useJavaAnalyzer()

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

// Shiki-Snippets der aufgerufenen Methoden (lazy beim Oeffnen geladen).
// methodName -> { loading, html, startLine, signature, error }
const snippets = ref({})

async function loadSnippets() {
  snippets.value = {}
  const edge = props.edge
  if (!edge?.toFileId) return
  for (const c of calleeList.value) {
    snippets.value = { ...snippets.value, [c.name]: { loading: true } }
    try {
      const snip = await api.getJavaMethodSnippet(edge.toFileId, c.name)
      snippets.value = {
        ...snippets.value,
        [c.name]: { loading: false, html: snip.html, startLine: snip.startLine, signature: snip.signature },
      }
    } catch (e) {
      snippets.value = { ...snippets.value, [c.name]: { loading: false, error: e.message } }
    }
  }
}

// Hand-off zu CodeView: Datei vorwaehlen + (optional) Zeile hervorheben, Panel schliessen.
function navigateTo(fileId, line) {
  if (fileId == null) return
  lastFileId.value = fileId
  lastTargetLine.value = line ?? null
  close()
  router.push('/code')
}

// „Definiert in <Zielklasse>": zur Methodendeklaration springen.
function openDefinition(c) {
  navigateTo(props.edge?.toFileId, snippets.value[c.name]?.startLine ?? null)
}

// „Aufgerufen in <Aufruferklasse>": Zeile der ersten aufrufenden Methode holen, dann springen.
async function openUsage(c) {
  const edge = props.edge
  const site = (edge?.callSites || []).find((s) => s.calleeMethod === c.name)
  let line = null
  if (edge?.fromFileId && site?.callerMethod) {
    try {
      const snip = await api.getJavaMethodSnippet(edge.fromFileId, site.callerMethod)
      line = snip.startLine
    } catch {
      /* Zeile optional -> Klasse trotzdem oeffnen */
    }
  }
  navigateTo(edge?.fromFileId, line)
}

function onKeydown(e) {
  if (e.key === 'Escape') close()
}
watch(
  () => props.visible,
  (vis) => {
    if (vis) {
      window.addEventListener('keydown', onKeydown)
      loadSnippets()
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
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
            <div class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:share-2" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate">{{ edge.fromClass }}</span>
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span class="truncate">{{ edge.toClass }}</span>
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

            <!-- ── Target: aufgerufene Klasse + Methoden-Quellcode (Shiki) ── -->
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

              <div class="space-y-3">
                <article
                  v-for="c in calleeList"
                  :key="c.name"
                  class="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-offset)]"
                >
                  <!-- Methoden-Header: Name + Signatur -->
                  <div class="flex items-center gap-2 px-3 py-2">
                    <Icon icon="lucide:braces" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                    <code class="font-mono text-sm font-semibold text-[var(--color-text)]">{{ c.name }}()</code>
                  </div>
                  <code
                    v-if="snippets[c.name]?.signature || c.signature"
                    class="block truncate px-3 pb-1.5 font-mono text-[11px] text-[var(--color-text-muted)]"
                  >{{ snippets[c.name]?.signature || c.signature }}</code>

                  <!-- Code-Block (Shiki, Dual-Theme) -->
                  <div class="px-3 pb-2">
                    <div v-if="snippets[c.name]?.loading" class="flex items-center gap-2 px-1 py-3 text-xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                      Lade Quellcode…
                    </div>
                    <p v-else-if="snippets[c.name]?.error" class="px-1 py-2 text-xs text-[var(--color-danger)]">
                      {{ snippets[c.name].error }}
                    </p>
                    <div v-else-if="snippets[c.name]?.html" class="edge-code" v-html="snippets[c.name].html" />
                  </div>

                  <!-- Fußzeile: Navigations-Links (Definiert in / Aufgerufen in) -->
                  <div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-soft)] px-2 py-1 text-xs font-medium text-[var(--color-accent)] transition hover:opacity-80"
                      @click="openDefinition(c)"
                    >
                      <Icon icon="lucide:target" class="h-3.5 w-3.5" />
                      Definiert in <span class="font-semibold">{{ edge.toClass }}</span>
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                      @click="openUsage(c)"
                    >
                      <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                      Aufgerufen in <span class="font-semibold">{{ edge.fromClass }}</span>
                    </button>
                  </div>
                </article>
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

/* Shiki-Codeblock im Panel kompakter halten (die Farbgebung kommt aus global .shiki). */
.edge-code :deep(.shiki) {
  margin: 0;
  max-height: 18rem;
  overflow: auto;
  font-size: 12px;
}

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
