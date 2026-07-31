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
import { parseParamNames, markParamOccurrences, toggleParamHighlight as onParamClick } from '../../lib/javaParams.js'
// Gutter/Fenster-Aufbereitung des Shiki-HTML – geteilt mit JavaBundlePanel (s. lib/javaCode.js).
import { addLineNumbers, buildCallWindow } from '../../lib/javaCode.js'
// Identitaetsfarbe je Methode: Definition oben, Aufrufstelle unten und Token im Code teilen sie.
import { buildMethodColorMap, methodColorVars, markMethodCalls } from '../../lib/javaMethodColors.js'
import { copyToClipboard } from '../../lib/clipboard.js'
import { Icon } from '../../lib/icons.js'
import BusyState from '../BusyState.vue'

const props = defineProps({
  edge: { type: Object, default: null },
  visible: { type: Boolean, default: false },
  // Die Ruempfe beider Klassen kommen erst beim Klick (die Dateiliste traegt sie nicht mit, s.
  // `methodsOf` im Graphen). Solange sie unterwegs sind, steht das Panel schon da: Kopf und
  // Methodennamen sind aus Dateiliste und Kantendaten bereits bekannt, nur der Code fehlt.
  // Ohne das sah ein Klick auf eine Kante eine halbe Sekunde lang aus wie verschluckt.
  loading: { type: Boolean, default: false },
  // Startzeitpunkt fuer die Uhr in `BusyState` (dort laeuft sie, nicht hier).
  loadingSince: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'delete-edge'])

const router = useRouter()
const { lastFileId, lastTargetLine, lastTargetEndLine } = useJavaAnalyzer()

// edgeId der aktuell per Inline-Confirm abgefragten Methode (null = keine Bestätigung offen).
const confirmingDelete = ref(null)

// `reason` unterscheidet das Schliessen per ESC/× vom Schliessen wegen eines Sprungs in den Code
// ('navigate'). Nur dort bietet der Graph anschliessend den Rueckweg zu dieser Kante an.
function close(reason) {
  emit('close', reason)
}

// Kante einer einzelnen Methode löschen -> Parent (JavaDependencyGraph) persistiert + frischt
// das offene Panel auf (entfernte Methode raus, leer -> schließt).
function deleteMethodEdge(edgeId) {
  if (edgeId == null) return
  confirmingDelete.value = null
  emit('delete-edge', edgeId)
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
      // Unsicherer Auto-Treffer: der Aufruf nennt kein Objekt, die Zielklasse wurde ueber den
      // Methodennamen geraten (s. Erklaerung im Template).
      needsReview: !!m.needsReview,
    }))
  }
  const sigs = new Map((props.edge.calleeSignatures || []).map((s) => [s.name, s.signature]))
  return (props.edge.callees || []).map((name) => ({ name, signature: sigs.get(name) || '', edgeId: null, isManual: false, needsReview: false }))
})

// Namen der unsicher erkannten Methoden – die Aufrufstellen unten kennen nur ihren Callee-Namen.
const unverified = computed(() => new Set(calleeList.value.filter((c) => c.needsReview).map((c) => c.name)))

// Feld-Kante statt Aufruf-Kante. Dasselbe Panel, dieselbe Rechnung – nur zwei Dinge sind anders,
// und beide wären als Text falsch, wenn man sie nicht unterscheidet: ein Feld trägt keine
// Klammern (`ACCEPT`, nicht `ACCEPT()`), und es wird gelesen statt aufgerufen.
const isField = computed(() => props.edge?.kind === 'field')
const memberWord = computed(() => (isField.value ? 'field' : 'method'))
// Name eines Mitglieds dieser Kante, so wie er im Java-Quelltext steht.
const memberName = (n) => (isField.value ? n : `${n}()`)
// Der AUFRUFER ist normalerweise eine Methode – bei einem Feld-Initialisierer
// (`private String mode = Status.ACTIVE;`) aber selbst ein Feld. Dann ohne Klammern.
const callerName = (name, isFieldCaller) => (isFieldCaller ? name : `${name}()`)

// Aufrufstellen pro aufrufende Methode gruppieren (Anwender-Sektion). Jede Site traegt ihre
// exakte Zeile + (relative) Position im Rumpf fuer das fokussierte Snippet.
const callerGroups = computed(() => {
  if (!props.edge?.callSites) return []
  const map = new Map()
  for (const cs of props.edge.callSites) {
    if (!map.has(cs.callerMethod)) {
      map.set(cs.callerMethod, { callerMethod: cs.callerMethod, callerIsField: !!cs.callerIsField, sites: [] })
    }
    map.get(cs.callerMethod).sites.push(cs)
  }
  // Sites je Methode nach Zeile sortieren.
  return [...map.values()].map((g) => ({
    ...g,
    sites: [...g.sites].sort((a, b) => a.line - b.line),
  }))
})

// Farbzuordnung der Kante: jede Methode genau eine Farbe – vergeben in der Reihenfolge, in der die
// Methoden oben in der Quelle stehen. Callees, die nur an Aufrufstellen auftauchen (ohne eigene
// Definitionskarte), haengen hinten dran, damit unten nichts farblos bleibt.
const methodColors = computed(() =>
  buildMethodColorMap([
    ...calleeList.value.map((c) => c.name),
    ...(props.edge?.callSites || []).map((s) => s.calleeMethod),
  ]),
)

// Inline-Vars (`--mc` fuer Panel-Flaechen, `--mc-code` fuer den dunklen Code-Block). Alles Weitere
// erbt – im Template steht deshalb nirgends eine Farbe, nur die Zuordnung.
function mcVars(name) {
  return methodColorVars(methodColors.value.get(name))
}

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
          // Reihenfolge: erst Parameter faerben, dann den Methoden-Token – `markMethodCalls`
          // ueberspringt bereits markierte Parameter, umgekehrt gaebe es Doppel-Wrapping.
          html: markMethodCalls(
            markParamOccurrences(
              addLineNumbers(snip.combinedHtml ?? snip.html, snip.startLine),
              parseParamNames(snip.signature),
            ),
            // Nur die eigene Methode: in der Definition ist sie die Aussage, andere Callees der
            // Kante waeren hier bloss Rauschen.
            new Map([[c.name, methodColors.value.get(c.name) ?? 0]]),
          ),
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
      // Parameter der AUFRUFENDEN Methode -> in jedem Fenster faerben/markieren.
      const names = parseParamNames(snip.signature)
      const sites = grp.sites.map((s) => ({
        line: s.line,
        lineExact: s.lineExact,
        calleeMethod: s.calleeMethod,
        // Pro Aufrufstelle ein eigenes Fenster aus dem ganzen Rumpf (snip.html). Hier werden ALLE
        // Callees der Kante markiert: im Kontextfenster stehen oft weitere Aufrufe derselben
        // Kante – die tragen dann ihre eigene Farbe statt namenlos mitzulaufen.
        html: markMethodCalls(
          markParamOccurrences(buildCallWindow(snip.html, base, s.line), names),
          methodColors.value,
        ),
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
  // copyToClipboard kapselt den Secure-Context-/Fallback-Fall (Pi laeuft ueber http).
  if (!(await copyToClipboard(text))) return
  copiedKey.value = key
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copiedKey.value = null
  }, 1500)
}
onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer)
})

// Hand-off zu CodeView: Datei vorwaehlen + (optional) Zeile hervorheben, Panel schliessen.
// `endLine` gesetzt -> CodeView markiert den gesamten Methodenbereich (line..endLine) statt nur
// einer Zeile.
function navigateTo(fileId, line, endLine) {
  if (fileId == null) return
  lastFileId.value = fileId
  lastTargetLine.value = line ?? null
  lastTargetEndLine.value = endLine ?? null
  close('navigate')
  router.push('/code')
}

// „Definiert in <Zielklasse>": zur Methodendeklaration springen und die KOMPLETTE Methode
// (Signatur bis schliessende Klammer) im Quellcode markieren.
function openDefinition(c) {
  const snip = snippets.value[c.name]
  navigateTo(props.edge?.toFileId, snip?.startLine ?? null, snip?.endLine ?? null)
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
  close()
}
// Sichtbarkeit steuert nur Tastatur und Zustand.
watch(
  () => props.visible,
  (vis) => {
    confirmingDelete.value = null
    if (vis) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)

// Die DATEN steuern das Nachladen – ausdruecklich nicht `visible`.
// Grund: Das Panel oeffnet inzwischen sofort mit einem Platzhalter (`loading`), dessen `callSites`
// noch leer sind. Haengt das Laden an `visible`, laeuft es genau einmal – naemlich auf diesem
// leeren Platzhalter – und wird nie wiederholt, weil `visible` true bleibt, waehrend nur `edge`
// getauscht wird. Genau so blieb der Consumer-Abschnitt nach dem Laden leer.
watch(
  () => (props.visible && !props.loading ? props.edge : null),
  (edge) => {
    if (!edge) {
      // Neue Kante im Anflug (oder geschlossen): der Ausschnitt der alten gehoert nicht mehr dazu.
      snippets.value = {}
      usageSnippets.value = {}
      return
    }
    loadSnippets()
    loadUsageSnippets()
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
          class="card relative z-10 flex max-h-[85vh] w-max min-w-[min(92vw,42rem)] max-w-[min(92vw,1400px)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        >
          <!-- Kopf: Definition -> Nutzung (gleiche Richtung wie der Graph-Pfeil) -->
          <header class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:share-2" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate">{{ edge.toClass }}</span>
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span class="truncate">{{ edge.fromClass }}</span>
              <!-- Dasselbe Badge wie am Kanten-Label im Graph. Es steht hier, damit der Klick auf
                   eine „Please review"-Kante nicht in einem Modal endet, das aussieht wie jedes
                   andere – erklärt wird es an der betroffenen Methode weiter unten. -->
              <span
                v-if="unverified.size"
                class="review-badge shrink-0"
                :title="`${unverified.size} of ${calleeList.length} method(s) on this edge were matched by name only – see the note on the method below`"
              >
                <Icon icon="lucide:alert-triangle" class="h-3 w-3 shrink-0" />
                Please review
              </span>
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Close (ESC)"
              aria-label="Close"
              @click="close"
            >
              <Icon icon="lucide:x" class="h-5 w-5" />
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <!-- Warten hat EINE Form (`BusyState`) – und sie steht dort, wo das Ergebnis erscheinen
                 wird, nicht als Spinner irgendwo über dem Graphen. Das Skelett hat so viele Zeilen
                 wie die Kante Methoden trägt, damit das Panel beim Eintreffen nicht springt. -->
            <div v-if="loading" class="p-4">
              <BusyState
                variant="panel"
                :title="`Opening ${edge.toClass} → ${edge.fromClass}`"
                :detail="`${calleeList.length} ${memberWord}${calleeList.length === 1 ? '' : 's'} · source of both classes`"
                hint="Member bodies are fetched on click — the class list does not carry them, so this is one request per class."
                :since="loadingSince"
                :rows="Math.min(6, Math.max(2, calleeList.length * 2))"
              />
            </div>

            <template v-else>
            <!-- ── Quelle: definierende Klasse + Methoden-Quellcode (Shiki) ── -->
            <section class="p-4">
              <div class="mb-3 flex flex-wrap items-center gap-2.5">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:file-code" class="h-5 w-5" />
                </span>
                <div class="min-w-0">
                  <div class="text-3xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Source · defines</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.toClass }}</h2>
                </div>

                <!-- Farb-Legende der Kante: welche Farbe steht fuer welche Methode. Reine Anzeige,
                     erst ab zwei Methoden sinnvoll – bei einer einzigen ist die Zuordnung trivial. -->
                <div v-if="calleeList.length > 1" class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  <span v-for="c in calleeList" :key="c.name" class="mc-chip" :style="mcVars(c.name)">
                    <span class="mc-dot" />
                    <span class="truncate font-mono">{{ c.name }}</span>
                  </span>
                </div>
              </div>

              <div class="space-y-3">
                <article
                  v-for="c in calleeList"
                  :key="c.name"
                  class="method-card overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-offset)]"
                  :style="mcVars(c.name)"
                >
                  <!-- Methoden-Header: Name + „Definiert in"-Sprung + (Datei · Zeilenbereich) +
                       Kopier-Button. Der Kopier-Button sitzt bewusst hier (nicht schwebend ueber dem
                       Code), damit er die Signatur-Zeile nicht ueberdeckt und die Parameter-Variablen
                       klickbar bleiben. -->
                  <div class="flex items-center gap-2 px-3 py-2">
                    <!-- Farb-Badge = Identitaet dieser Methode; dasselbe Zeichen steht unten an
                         jeder Aufrufstelle, die sie ruft. -->
                    <span class="mc-badge">
                      <!-- Dasselbe Zeichen wie am Kanten-Label: geschweifte Klammern fuer eine
                           Methode, das Variablenzeichen fuer ein Feld. -->
                      <Icon :icon="isField ? 'lucide:variable' : 'lucide:braces'" class="h-3.5 w-3.5" />
                    </span>
                    <code class="mc-name font-mono text-sm font-semibold">{{ memberName(c.name) }}</code>
                    <span v-if="c.needsReview" class="review-badge shrink-0">
                      <Icon icon="lucide:alert-triangle" class="h-3 w-3 shrink-0" />
                      Please review
                    </span>
                    <div class="ml-auto flex min-w-0 items-center gap-1.5">
                      <!-- „Definiert in <Klasse>": springt in den Quellcode der Zielklasse und
                           markiert dort die komplette Methode. Dezent, header-konform (keine
                           grelle Hervorhebung) – Accent erst beim Hover. -->
                      <button
                        v-if="snippets[c.name]?.html"
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-accent)]"
                        :title="`Open in the source of ${edge.toClass} and highlight the method`"
                        @click="openDefinition(c)"
                      >
                        <Icon icon="lucide:target" class="h-3.5 w-3.5 shrink-0" />
                        Defined in <span class="font-semibold">{{ edge.toClass }}</span>
                      </button>
                      <span
                        v-if="snippets[c.name]?.filename"
                        class="inline-flex min-w-0 items-center gap-1 truncate font-mono text-2xs text-[var(--color-text-muted)]"
                        :title="snippets[c.name].filename"
                      >
                        <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0" />
                        {{ snippets[c.name].filename }} · L{{ snippets[c.name].startLine }}–{{ snippets[c.name].endLine }}
                      </span>
                      <button
                        v-if="snippets[c.name]?.html"
                        type="button"
                        class="grid h-7 w-7 shrink-0 place-items-center rounded-md transition hover:bg-[var(--color-surface-offset)]"
                        :class="copiedKey === 'src:' + c.name ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
                        :title="copiedKey === 'src:' + c.name ? 'Copied to clipboard' : 'Copy code'"
                        :aria-label="copiedKey === 'src:' + c.name ? 'Copied to clipboard' : 'Copy code'"
                        @click="copyCode('src:' + c.name, snippets[c.name].code)"
                      >
                        <Icon :icon="copiedKey === 'src:' + c.name ? 'lucide:check' : 'lucide:copy'" class="h-3.5 w-3.5" />
                      </button>

                      <!-- Kante dieser Methode löschen (mit Inline-Confirm). Nur, wenn die
                           Methode einer einzelnen Kante zugeordnet ist (c.edgeId bekannt). -->
                      <template v-if="c.edgeId != null">
                        <button
                          v-if="confirmingDelete !== c.edgeId"
                          type="button"
                          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-danger)]"
                          :title="`Delete connection “${c.name}()”`"
                          :aria-label="`Delete connection ${c.name}`"
                          @click="confirmingDelete = c.edgeId"
                        >
                          <Icon icon="lucide:trash-2" class="h-3.5 w-3.5" />
                        </button>
                        <span v-else class="inline-flex shrink-0 items-center gap-1">
                          <span class="text-2xs font-semibold text-[var(--color-danger)]">Delete?</span>
                          <button
                            type="button"
                            class="grid h-7 w-7 place-items-center rounded-md text-[var(--color-danger)] transition hover:bg-[var(--color-surface-offset)]"
                            title="Confirm delete"
                            aria-label="Confirm delete"
                            @click="deleteMethodEdge(c.edgeId)"
                          >
                            <Icon icon="lucide:check" class="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            class="grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                            title="Cancel"
                            aria-label="Cancel"
                            @click="confirmingDelete = null"
                          >
                            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </template>
                    </div>
                  </div>

                  <!-- Antwort auf das „Please review" am Kanten-Label: WARUM ist dieser Treffer
                       unsicher und was soll man damit tun. Ohne diesen Satz sieht das Modal
                       genauso aus wie bei einer gesicherten Kante. -->
                  <p v-if="c.needsReview" class="review-note">
                    <Icon icon="lucide:alert-triangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      <!-- Leerzeichen in DERSELBEN Zeile: Vue verwirft Whitespace-Knoten, die eine
                           Zeilenschaltung enthalten – „verified.purge()" waere zusammengeklebt. -->
                      <strong>Matched by name, not verified.</strong> <code class="font-mono">{{ c.name }}()</code> is called in {{ edge.fromClass }} without naming an
                      object in front of it, so its receiver type is unknown. It was linked to
                      <strong>{{ edge.toClass }}</strong> because that is the only analyzed class defining a method with
                      this name — it could just as well be inherited, statically imported, or defined in a class that was
                      never analyzed. Check the call site below and delete this connection if it is wrong.
                    </span>
                  </p>

                  <!-- EIN kombinierter Code-Block: Signatur + Rumpf, leerzeilenfrei (Shiki, Dual-Theme) -->
                  <div class="px-3 pb-2">
                    <div v-if="snippets[c.name]?.loading" class="flex items-center gap-2 px-1 py-3 text-xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                      Loading source…
                    </div>
                    <p v-else-if="snippets[c.name]?.error" class="px-1 py-2 text-xs text-[var(--color-danger)]">
                      {{ snippets[c.name].error }}
                    </p>
                    <div
                      v-else-if="snippets[c.name]?.html"
                      class="edge-code code-dark"
                      v-html="snippets[c.name].html"
                      @click="onParamClick"
                    />
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
                  <div class="text-3xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Consumer · {{ isField ? 'reads' : 'calls' }}</div>
                  <h2 class="truncate text-base font-bold text-[var(--color-text)]">{{ edge.fromClass }}</h2>
                </div>
              </div>

              <div class="space-y-4">
                <div v-for="grp in callerGroups" :key="grp.callerMethod">
                  <div v-if="usageSnippets[grp.callerMethod]?.loading" class="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-3 text-xs text-[var(--color-text-muted)]">
                    <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
                    Loading source…
                  </div>
                  <p v-else-if="usageSnippets[grp.callerMethod]?.error" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-2 text-xs text-[var(--color-danger)]">
                    {{ usageSnippets[grp.callerMethod].error }}
                  </p>

                  <!-- Pro Aufrufstelle ein eigener Block: Datei · Zeile + ±3 Zeilen Kontext -->
                  <div v-else class="space-y-3">
                    <div
                      v-for="(site, i) in usageSnippets[grp.callerMethod]?.sites || []"
                      :key="i"
                      class="method-card overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)]"
                      :style="mcVars(site.calleeMethod)"
                    >
                      <!-- Site-Header: Aufruf-Kette (aufrufende Methode → aufgerufene Methode) links,
                           in identischer Typo zum Quelle-Methoden-Header; (Datei · Zeile) + Öffnen-Button
                           rechts. Jeder Block nennt seinen konkreten Callee -> mehrere Aufrufe sauber
                           getrennt (kein Aneinanderreihen). Der Callee traegt die Farbe seiner
                           Definitionskarte oben – Streifen, Badge, Aufrufzeile und Code-Token ziehen
                           dieselbe Variable. -->
                      <div class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                        <span class="mc-badge">
                          <Icon icon="lucide:corner-down-right" class="h-3.5 w-3.5" />
                        </span>
                        <code class="font-mono text-sm font-semibold text-[var(--color-text)]">{{ callerName(grp.callerMethod, grp.callerIsField) }}</code>
                        <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                        <code class="mc-name font-mono text-sm font-semibold">{{ memberName(site.calleeMethod) }}</code>
                        <!-- Genau diese Zeile ist die geratene Stelle -> das Badge gehoert hierher,
                             nicht nur an die Definition oben. -->
                        <span
                          v-if="unverified.has(site.calleeMethod)"
                          class="review-badge shrink-0"
                          :title="`This call names no object, so the target class was matched by method name only – verify that it really goes to ${edge.toClass}`"
                        >
                          <Icon icon="lucide:alert-triangle" class="h-3 w-3 shrink-0" />
                          Please review
                        </span>
                        <div class="ml-auto flex min-w-0 items-center gap-1.5">
                          <span
                            class="inline-flex min-w-0 items-center gap-1 truncate font-mono text-2xs text-[var(--color-text-muted)]"
                            :title="site.lineExact ? (isField ? 'Exact line of the access' : 'Exact call line') : 'Line estimated – re-analyze the file for the exact line'"
                          >
                            <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0" />
                            {{ usageSnippets[grp.callerMethod].filename }} · {{ site.lineExact ? '' : '~' }}L{{ site.line }}
                          </span>
                          <button
                            type="button"
                            class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                            title="Open in source (jump to line)"
                            aria-label="Open in source (jump to line)"
                            @click="navigateTo(edge.fromFileId, site.line)"
                          >
                            <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div class="edge-usage-code code-dark" v-html="site.html" @click="onParamClick" />
                    </div>
                  </div>
                </div>
              </div>
            </section>
            </template>
          </div>

          <!-- Footer: zur Quell-/Aufruferklasse springen (read-only). Waehrend des Ladens weg –
               ein Sprung in eine Klasse, deren Stelle noch gar nicht feststeht, waere ein Angebot
               ins Leere. -->
          <footer v-if="!loading" class="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                class="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
                @click="openSourceClass"
              >
                <Icon icon="lucide:file-code" class="h-4 w-4 text-[var(--color-text-muted)]" />
                To class
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

/* Hinweis: Die Shiki-Optik der Quelle-Bloecke (.edge-code) wird gemeinsam mit den
   Anwender-Bloecken in assets/style.css (.edge-usage-code, .edge-code) gepflegt -> identische
   Optik. Hier nur noch Panel-spezifische Animationen + die Methoden-Faerbung.
   Alles unten liest NUR `var(--mc)`; welche Farbe das ist, entscheidet `mcVars()` am Element
   (lib/javaMethodColors.js). Ohne gesetzte Variable faellt jede Regel auf den Akzent zurueck. */

/* Karte einer Methode – oben ihre Definition, unten jede Aufrufstelle. Der linke Streifen ist der
   gemeinsame Anker: gleiche Farbe = gleiche Methode, ueber die Panel-Haelften hinweg.
   Bewusst OHNE Hover-/Fokus-Zustand: die Farbe traegt die Zuordnung allein, ein zusaetzliches
   Daempfen der uebrigen Methoden hat das Panel nur unruhig gemacht. */
.method-card {
  border-left: 3px solid var(--mc, var(--color-border));
}

.mc-badge {
  @apply grid h-6 w-6 shrink-0 place-items-center rounded-md;
  color: var(--mc, var(--color-accent));
  background-color: color-mix(in srgb, var(--mc, var(--color-accent)) 16%, transparent);
}
.mc-name {
  color: var(--mc, var(--color-accent));
}

/* Legende: Punkt + Name in der Methodenfarbe. Reine Anzeige, nicht anklickbar. */
.mc-chip {
  @apply inline-flex min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold;
  color: var(--mc, var(--color-accent));
  border: 1px solid color-mix(in srgb, var(--mc, var(--color-accent)) 40%, transparent);
  background-color: color-mix(in srgb, var(--mc, var(--color-accent)) 10%, transparent);
}
.mc-dot {
  @apply h-2 w-2 shrink-0 rounded-full;
  background-color: var(--mc, var(--color-accent));
}

/* „Please review": unsicherer Auto-Treffer. Gleiche Warnfarbe wie das Badge am Kanten-Label im
   Graph (REVIEW_COLOR = --color-warning), damit man dasselbe Zeichen wiedererkennt. */
.review-badge {
  @apply inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-bold uppercase tracking-wide;
  color: var(--color-warning);
  border: 1px solid color-mix(in srgb, var(--color-warning) 45%, transparent);
  background-color: color-mix(in srgb, var(--color-warning) 14%, transparent);
}
/* Die Erklaerung dazu – Fliesstext, bewusst nicht als Tooltip: sie beantwortet die Frage, die das
   Badge aufwirft, und muss ohne Hover lesbar sein. */
.review-note {
  @apply mx-3 mb-2 flex gap-2 rounded-lg px-2.5 py-2 text-2xs leading-relaxed;
  /* Die Karte waechst per `w-max` mit ihrem breitesten Kind – ein Fliesstext dieser Laenge wuerde
     das Modal auf Maximalbreite ziehen, obwohl der Code viel schmaler ist. Mit `width: 0` zaehlt
     der Absatz nicht in die max-content-Breite und fuellt ueber `min-width` trotzdem die Karte
     (abzueglich der eigenen mx-3-Raender), bricht also um statt zu strecken. */
  width: 0;
  min-width: calc(100% - 1.5rem);
  color: var(--color-text);
  border: 1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);
  background-color: color-mix(in srgb, var(--color-warning) 10%, transparent);
}
.review-note :where(strong) {
  color: var(--color-warning);
}
.review-note :where(code) {
  @apply rounded px-1;
  background-color: color-mix(in srgb, var(--color-warning) 16%, transparent);
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
