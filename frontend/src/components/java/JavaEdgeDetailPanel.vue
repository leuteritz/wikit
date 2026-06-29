<script setup>
// Edge-Detail-Panel fuer eine Call-Kante im Klassengraphen.
// Gerichteter Informationsfluss analog zum Pfeil im Graphen (Definition -> Nutzung):
//   * Oben (Quelle): die DEFINIERENDE Klasse mit der Methodendefinition – Name, Signatur und
//     Shiki-gehighlighteter Quellcode (vom Backend, Dual-Theme via CSS-Variablen).
//   * Pfeil-Divider in Akzentfarbe.
//   * Unten (Anwender): die AUFRUFENDE Klasse mit der exakten Aufrufzeile + fokussiertem
//     Code-Snippet, in dem die Aufrufzeile farbig hervorgehoben ist.
// Navigations-Links oeffnen die jeweilige Datei zeilengenau. Schliesst per ESC, Backdrop oder
// Close-Button. HTTP nur ueber lib/api.js.
import { computed, watch, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../lib/api.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  edge: { type: Object, default: null },
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'edit', 'delete', 'edit-method', 'delete-method'])

const router = useRouter()
const { lastFileId, lastTargetLine } = useJavaAnalyzer()

// Inline-Bestätigung für „Analyse löschen" (zweistufig im Footer).
const confirmDelete = ref(false)

function close() {
  confirmDelete.value = false
  emit('close')
}

// Footer: zur Quell-/Aufruferklasse springen.
function openSourceClass() {
  navigateTo(props.edge?.fromFileId)
}

// Aufgerufene (definierte) Methoden fuer die Quell-Sektion. Bevorzugt die reichere methods-Liste
// (mit edgeId/isManual fuer Per-Methoden-Aktionen); Fallback auf callees/calleeSignatures.
const calleeList = computed(() => {
  if (!props.edge) return []
  if (props.edge.methods?.length) {
    return props.edge.methods.map((m) => ({
      name: m.name,
      signature: m.signature || '',
      edgeId: m.edgeId ?? null,
      isManual: !!m.isManual,
    }))
  }
  const sigs = new Map((props.edge.calleeSignatures || []).map((s) => [s.name, s.signature]))
  return (props.edge.callees || []).map((name) => ({ name, signature: sigs.get(name) || '', edgeId: null, isManual: false }))
})

// Buendel = mehr als eine Methode -> Per-Methoden-Aktionen im Panel, Footer-Bearbeiten ausgeblendet.
const isBundle = computed(() => calleeList.value.length > 1)

// Aufrufstellen pro aufrufende Methode gruppieren (Anwender-Sektion). Jede Site traegt ihre
// exakte Zeile + (relative) Position im Rumpf fuer das fokussierte Snippet.
const callerGroups = computed(() => {
  if (!props.edge?.callSites) return []
  const map = new Map()
  for (const cs of props.edge.callSites) {
    if (!map.has(cs.callerMethod)) {
      map.set(cs.callerMethod, { callerMethod: cs.callerMethod, sites: [] })
    }
    map.get(cs.callerMethod).sites.push(cs)
  }
  // Sites je Methode nach Zeile sortieren.
  return [...map.values()].map((g) => ({
    ...g,
    sites: [...g.sites].sort((a, b) => a.line - b.line),
  }))
})

// Shiki-Snippets der definierten Methoden (Quelle, lazy beim Oeffnen geladen).
// Ein KOMBINIERTER, leerzeilenfreier Block (Signatur + Rumpf) je Methode, vom Backend gerendert.
// methodName -> { loading, html, code, startLine, endLine, filename, signature, error }
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
        [c.name]: {
          loading: false,
          html: snip.combinedHtml ?? snip.html,
          code: snip.combinedCode ?? snip.code,
          startLine: snip.startLine,
          endLine: snip.endLine ?? snip.startLine,
          filename: snip.filename,
          signature: snip.signature,
        },
      }
    } catch (e) {
      snippets.value = { ...snippets.value, [c.name]: { loading: false, error: e.message } }
    }
  }
}

// Shiki-Snippets der aufrufenden Methoden (Verwendung, lazy beim Oeffnen geladen).
// Pro Aufrufstelle ein FOKUSSIERTES Fenster: 3 Nicht-Leerzeilen davor + Aufrufzeile + 3 danach.
// callerMethod -> { loading, filename, sites: [{ line, lineExact, calleeMethod, html }], error }
const usageSnippets = ref({})

// Anzahl Kontext-Nicht-Leerzeilen je Seite der Aufrufzeile.
const CONTEXT_LINES = 3

// Aus dem (server-gerenderten) Shiki-HTML des ganzen Aufrufer-Rumpfs ein fokussiertes Fenster um
// `siteLine` schneiden: pro `.line` die Quellzeile (data-line = base + i) bestimmen, Leerzeilen
// (whitespace-only) ueberspringen und je 3 Nicht-Leerzeilen vor/nach der Aufrufzeile behalten. Die
// Aufrufzeile bekommt `line-highlight`. Reines DOM-Post-Processing – kein zweiter Highlighter, die
// Farben kommen weiter aus den Shiki-CSS-Variablen.
function buildCallWindow(html, bodyStartLine, siteLine) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.querySelector('.shiki')
    if (!root) return html
    const base = bodyStartLine != null ? bodyStartLine : 1
    const allLines = [...root.querySelectorAll('.line')]
    // Nur Nicht-Leerzeilen, je mit ihrer Quellzeilennummer.
    const kept = allLines
      .map((el, i) => ({ el, line: base + i }))
      .filter(({ el }) => el.textContent.trim() !== '')
    if (!kept.length) return html
    // Index der Aufrufzeile in der gefilterten Liste (oder naechstgelegene).
    let hit = kept.findIndex((k) => k.line === siteLine)
    if (hit === -1) {
      let best = Infinity
      kept.forEach((k, idx) => {
        const d = Math.abs(k.line - siteLine)
        if (d < best) { best = d; hit = idx }
      })
    }
    const from = Math.max(0, hit - CONTEXT_LINES)
    const to = Math.min(kept.length - 1, hit + CONTEXT_LINES)
    const code = doc.createElement('code')
    for (let i = from; i <= to; i++) {
      const { el, line } = kept[i]
      el.setAttribute('data-line', String(line))
      if (i === hit) el.classList.add('line-highlight')
      else el.classList.remove('line-highlight')
      code.appendChild(el)
    }
    const shell = doc.createElement('div')
    shell.className = 'shiki'
    shell.appendChild(code)
    return shell.outerHTML
  } catch {
    return html
  }
}

async function loadUsageSnippets() {
  usageSnippets.value = {}
  const edge = props.edge
  if (!edge?.fromFileId) return
  for (const grp of callerGroups.value) {
    const key = grp.callerMethod
    usageSnippets.value = { ...usageSnippets.value, [key]: { loading: true } }
    try {
      const snip = await api.getJavaMethodSnippet(edge.fromFileId, key)
      const base = grp.sites[0]?.bodyStartLine ?? snip.startLine ?? null
      const sites = grp.sites.map((s) => ({
        line: s.line,
        lineExact: s.lineExact,
        calleeMethod: s.calleeMethod,
        // Pro Aufrufstelle ein eigenes Fenster aus dem ganzen Rumpf (snip.html).
        html: buildCallWindow(snip.html, base, s.line),
      }))
      usageSnippets.value = {
        ...usageSnippets.value,
        [key]: { loading: false, filename: snip.filename, sites },
      }
    } catch (e) {
      usageSnippets.value = { ...usageSnippets.value, [key]: { loading: false, error: e.message } }
    }
  }
}

// Kopier-Logik: ein gemeinsamer Zustand für alle Blöcke (Quelle 'src:<name>' / Verwendung
// 'use:<name>'). Nach 1,5 s zurücksetzen. Kein fetch – nur Clipboard-API.
const copiedKey = ref(null)
let copyTimer = null
async function copyCode(key, text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedKey.value = null
    }, 1500)
  } catch {
    /* Clipboard nicht verfügbar -> still ignorieren */
  }
}
onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer)
})

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

// „Aufgerufen in <Aufruferklasse>": zeilengenau zur ersten Aufrufstelle springen
// (Zeile liegt bereits client-seitig vor -> kein Zusatz-Request noetig).
function openUsage(c) {
  const edge = props.edge
  const site = (edge?.callSites || []).find((s) => s.calleeMethod === c.name)
  navigateTo(edge?.fromFileId, site?.line ?? null)
}

function onKeydown(e) {
  if (e.key !== 'Escape') return
  // ESC verwirft zuerst die Löschen-Bestätigung, erst danach schließt es das Modal.
  if (confirmDelete.value) confirmDelete.value = false
  else close()
}
watch(
  () => props.visible,
  (vis) => {
    if (vis) {
      confirmDelete.value = false
      window.addEventListener('keydown', onKeydown)
      loadSnippets()
      loadUsageSnippets()
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="visible && edge"
        class="fixed inset-0 z-50 grid place-items-center p-4"
        role="dialog"
        aria-modal="true"
      >
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click="close" />

        <div
          class="card relative z-10 flex max-h-[85vh] w-[90vw] max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        >
          <!-- Kopf: Definition -> Nutzung (gleiche Richtung wie der Graph-Pfeil) -->
          <header class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:share-2" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate">{{ edge.toClass }}</span>
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span class="truncate">{{ edge.fromClass }}</span>
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
            <!-- ── Quelle: definierende Klasse + Methoden-Quellcode (Shiki) ── -->
            <section class="p-4">
              <div class="mb-3 flex items-center gap-2.5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:file-code" class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                  <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Quelle · definiert</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.toClass }}</h2>
                </div>
              </div>

              <div class="space-y-3">
                <article
                  v-for="c in calleeList"
                  :key="c.name"
                  class="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-offset)]"
                >
                  <!-- Methoden-Header: Name + Datei · Zeilenbereich -->
                  <div class="flex items-center gap-2 px-3 py-2">
                    <Icon icon="lucide:braces" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                    <code class="font-mono text-sm font-semibold text-[var(--color-text)]">{{ c.name }}()</code>
                    <span
                      v-if="snippets[c.name]?.filename"
                      class="ml-auto inline-flex items-center gap-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]"
                      :title="snippets[c.name].filename"
                    >
                      <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0" />
                      {{ snippets[c.name].filename }} · Z{{ snippets[c.name].startLine }}–{{ snippets[c.name].endLine }}
                    </span>
                  </div>

                  <!-- EIN kombinierter Code-Block: Signatur + Rumpf, leerzeilenfrei (Shiki, Dual-Theme) -->
                  <div class="px-3 pb-2">
                    <div v-if="snippets[c.name]?.loading" class="flex items-center gap-2 px-1 py-3 text-xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                      Lade Quellcode…
                    </div>
                    <p v-else-if="snippets[c.name]?.error" class="px-1 py-2 text-xs text-[var(--color-danger)]">
                      {{ snippets[c.name].error }}
                    </p>
                    <div v-else-if="snippets[c.name]?.html" class="code-wrap">
                      <button
                        type="button"
                        class="code-copy inline-flex items-center gap-1"
                        :title="copiedKey === 'src:' + c.name ? 'In Zwischenablage kopiert' : 'Code kopieren'"
                        @click="copyCode('src:' + c.name, snippets[c.name].code)"
                      >
                        <Icon :icon="copiedKey === 'src:' + c.name ? 'lucide:check' : 'lucide:copy'" class="h-3.5 w-3.5" />
                        {{ copiedKey === 'src:' + c.name ? 'Kopiert' : 'Kopieren' }}
                      </button>
                      <div class="edge-code" v-html="snippets[c.name].html" />
                    </div>
                  </div>

                  <!-- Fußzeile: zur Definition springen + (bei Bündel) Per-Methoden-Aktionen -->
                  <div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-soft)] px-2 py-1 text-xs font-medium text-[var(--color-accent)] transition hover:opacity-80"
                      @click="openDefinition(c)"
                    >
                      <Icon icon="lucide:target" class="h-3.5 w-3.5" />
                      Definiert in <span class="font-semibold">{{ edge.toClass }}</span>
                    </button>
                    <template v-if="isBundle">
                      <button
                        type="button"
                        class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                        title="Methodenname dieser Kante bearbeiten"
                        @click="emit('edit-method', { edgeId: c.edgeId, name: c.name, isManual: c.isManual })"
                      >
                        <Icon icon="lucide:pencil" class="h-3.5 w-3.5" />
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-danger)] transition hover:bg-[var(--color-surface-2)]"
                        title="Diese Methoden-Kante löschen"
                        @click="emit('delete-method', { edgeId: c.edgeId, name: c.name, isManual: c.isManual })"
                      >
                        <Icon icon="lucide:trash-2" class="h-3.5 w-3.5" />
                        Löschen
                      </button>
                    </template>
                  </div>
                </article>
              </div>
            </section>

            <!-- ── Divider: Richtung Definition -> Nutzung ── -->
            <div class="flex items-center gap-3 px-4">
              <span class="h-px flex-1 bg-[var(--color-border)]" />
              <span class="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:arrow-down" class="h-4 w-4 edge-arrow" />
              </span>
              <span class="h-px flex-1 bg-[var(--color-border)]" />
            </div>

            <!-- ── Anwender: aufrufende Klasse mit exakter Aufrufzeile ── -->
            <section class="p-4">
              <div class="mb-3 flex items-center gap-2.5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:code-2" class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                  <div class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Anwender · ruft auf</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.fromClass }}</h2>
                </div>
              </div>

              <div class="space-y-4">
                <div v-for="grp in callerGroups" :key="grp.callerMethod">
                  <!-- Aufrufer-Methode als Gruppen-Überschrift -->
                  <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <code class="rounded-md bg-[var(--color-surface-offset)] px-1.5 py-0.5 font-mono font-semibold text-[var(--color-text)]">{{ grp.callerMethod }}()</code>
                  </div>

                  <div v-if="usageSnippets[grp.callerMethod]?.loading" class="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-3 text-xs text-[var(--color-text-muted)]">
                    <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                    Lade Quellcode…
                  </div>
                  <p v-else-if="usageSnippets[grp.callerMethod]?.error" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-2 text-xs text-[var(--color-danger)]">
                    {{ usageSnippets[grp.callerMethod].error }}
                  </p>

                  <!-- Pro Aufrufstelle ein eigener Block: Datei · Zeile + ±3 Zeilen Kontext -->
                  <div v-else class="space-y-3">
                    <div
                      v-for="(site, i) in usageSnippets[grp.callerMethod]?.sites || []"
                      :key="i"
                      class="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)]"
                    >
                      <div class="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-[11px]">
                        <Icon icon="lucide:corner-down-right" class="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                        <span class="truncate font-mono font-semibold text-[var(--color-accent)]">{{ site.calleeMethod }}()</span>
                        <span
                          class="ml-auto inline-flex items-center gap-1 truncate font-mono text-[var(--color-text-muted)]"
                          :title="site.lineExact ? 'Exakte Aufrufzeile' : 'Zeile geschätzt – Datei für exakte Zeile neu analysieren'"
                        >
                          <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0" />
                          {{ usageSnippets[grp.callerMethod].filename }} · {{ site.lineExact ? '' : '~' }}Z{{ site.line }}
                        </span>
                      </div>
                      <div class="code-wrap edge-usage-code">
                        <button
                          type="button"
                          class="code-copy inline-flex items-center gap-1"
                          title="Im Quellcode öffnen (zeilengenau)"
                          @click="navigateTo(edge.fromFileId, site.line)"
                        >
                          <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                          Öffnen
                        </button>
                        <div v-html="site.html" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- Footer: Aktionen auf die Kante (Klasse öffnen · Methodenname bearbeiten · löschen) -->
          <footer class="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
            <!-- Inline-Bestätigung für „Analyse löschen" -->
            <div v-if="confirmDelete" class="flex flex-wrap items-center justify-end gap-2">
              <span class="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--color-text)]">
                <Icon icon="lucide:alert-triangle" class="h-4 w-4 text-[var(--color-danger)]" />
                {{ isBundle ? `Alle ${calleeList.length} Methoden-Kanten löschen?` : 'Kante wirklich löschen?' }}
              </span>
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                @click="confirmDelete = false"
              >
                Abbrechen
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-danger)] px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
                @click="emit('delete')"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
                Löschen
              </button>
            </div>

            <!-- Standard-Aktionen -->
            <div v-else class="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                class="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
                @click="openSourceClass"
              >
                <Icon icon="lucide:file-code" class="h-4 w-4 text-[var(--color-text-muted)]" />
                Zur Klasse
              </button>
              <button
                v-if="!isBundle"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
                @click="emit('edit')"
              >
                <Icon icon="lucide:pencil" class="h-4 w-4 text-[var(--color-text-muted)]" />
                Analyse bearbeiten
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] transition hover:bg-[var(--color-surface-offset)]"
                @click="confirmDelete = true"
              >
                <Icon icon="lucide:trash-2" class="h-4 w-4" />
                Analyse löschen
              </button>
            </div>
          </footer>
        </div>
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

/* Zentriertes Einblenden: Backdrop faded, Card skaliert sanft von 0.95 auf 1. */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-active .card,
.modal-leave-active .card {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .card,
.modal-leave-to .card {
  transform: scale(0.95);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .modal-enter-active .card,
  .modal-leave-active .card {
    transition: opacity 0.18s ease;
  }
  .modal-enter-from .card,
  .modal-leave-to .card {
    transform: none;
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
