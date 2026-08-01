<script setup>
// Kanten-Detail (Spalte 3 der Code-Ansicht) fuer eine Call- oder Feld-Kante des Klassengraphen.
//
// Das war einmal ein Modal ueber dem Graphen. Es verdeckte damit genau das Bild, aus dem der Klick
// kam: die Beziehung liess sich lesen ODER im Graphen verorten, nie beides. Jetzt steht sie neben
// dem Graphen – dort, wo auch der Code einer Klasse steht, denn es ist dieselbe Taetigkeit. Die
// Kante selbst bleibt derweil im Bild markiert (`pinnedEdge` in useJavaGraph).
//
// Gerichteter Informationsfluss analog zum Pfeil im Graphen (Definition -> Nutzung):
//   * Oben (Quelle): die DEFINIERENDE Klasse mit der Methodendefinition – Name, Signatur und
//     Shiki-gehighlighteter Quellcode (vom Backend, Dual-Theme via CSS-Variablen).
//   * Pfeil-Divider in Akzentfarbe.
//   * Unten (Anwender): die AUFRUFENDE Klasse mit der exakten Aufrufzeile + fokussiertem
//     Code-Snippet, in dem die Aufrufzeile farbig hervorgehoben ist.
// Navigations-Links oeffnen die jeweilige Datei zeilengenau. Geschlossen wird ueber den ×-Knopf
// oder ESC – und ESC routet CodeView, nicht dieses Panel: es ist kein Modal mehr, also darf es
// nicht jede ESC-Taste des Fensters an sich ziehen (im Klassenfilter oder im Editor meint sie
// etwas anderes). HTTP nur ueber lib/api.js.
import { computed, watch, onUnmounted, ref, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../lib/api.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { parseParamNames, markParamOccurrences, toggleParamHighlight as onParamClick } from '../../lib/javaParams.js'
// Gutter/Fenster-Aufbereitung des Shiki-HTML – geteilt mit JavaBundlePanel (s. lib/javaCode.js).
// `shikiText`/`paintMatches`/`clearMatches` tragen die Suche in diesem Panel (s. unten).
import { addLineNumbers, buildCallWindow, shikiText, paintMatches, clearMatches } from '../../lib/javaCode.js'
// Dieselbe Musterlogik wie die Suchleiste im Source-Tab und in der globalen Palette.
import { findMatches, MATCH_LIMIT } from '../../lib/codeSearch.js'
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
  // Steht unter dieser Kante noch eine Aggregatliste, aus der sie geoeffnet wurde? Dann ist ×
  // nicht „fertig", sondern „zurueck zur Liste" – und muss das auch sagen.
  back: { type: String, default: null },
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

// --- Suche IN der Beziehung -------------------------------------------------------------------
// Dieselbe Leiste und dieselbe Musterlogik wie im Source-Tab (`JavaClassDetail`) und in der
// globalen Palette: Feld, Zaehler, drei Modus-Schalter, vor/zurueck, Enter/Shift+Enter, ESC leert.
// Wer eine Beziehung liest, sucht darin dasselbe, was er im Quelltext suchen wuerde – zwei
// verschiedene Suchen ueber denselben Code waeren zwei Antworten auf eine Frage.
//
// Zwei Unterschiede zum Source-Tab, beide aus der Bauart dieses Panels:
//  * Der Untergrund ist server-gerendertes Shiki-HTML, nicht CodeMirror. Die Bruecke ist
//    `shikiText` – derselbe Text, aus dem die Offsets stammen, gelesen aus genau den
//    `.line`-Elementen, die anschliessend markiert werden (wie in der Suchvorschau der Palette).
//  * Es ist nicht EIN Text, sondern viele: je Methodendefinition ein Block (`.edge-code`) und je
//    Aufrufstelle ein Fenster (`.edge-usage-code`). Jeder Block traegt deshalb seine eigene
//    Trefferliste, und die Reihenfolge im DOM (erst Definitionen, dann Aufrufstellen) ist zugleich
//    die Reihenfolge des Zaehlers – „3 von 12" laeuft also von der Quelle zum Anwender, genau wie
//    der Pfeil im Panel. Gefiltert wird NICHT: eine Karte ohne Treffer ist Teil der Beziehung und
//    verschwindet nicht, nur weil man gerade nach etwas anderem sucht.
const bodyEl = ref(null)
const searchInput = ref(null)
const search = ref('')
const searchOpts = ref({ caseSensitive: false, wholeWord: false, regex: false })
// Freilaufender Zaehler; der Modulo unten macht das Umlaufen daraus (wie im Source-Tab).
const searchCursor = ref(0)

const SEARCH_TOGGLES = [
  { key: 'caseSensitive', icon: 'lucide:case-sensitive', title: 'Match case' },
  { key: 'wholeWord', icon: 'lucide:whole-word', title: 'Match whole word' },
  { key: 'regex', icon: 'lucide:regex', title: 'Use regular expression' },
]

// Ein Eintrag je gerendertem Code-Block: { el, side: 'source' | 'consumer', matches }.
const blocks = ref([])
const searchError = ref('')
const searchCapped = ref(false)

const hitCount = computed(() => blocks.value.reduce((n, b) => n + b.matches.length, 0))

const activeMatch = computed(() => {
  const n = hitCount.value
  if (!n) return -1
  return ((searchCursor.value % n) + n) % n
})

// Wo steht das Gesuchte – in der Definition oder an den Aufrufstellen? Die Frage stellt sich nur in
// diesem Panel, und sie ist der Grund, warum die Suche hier mehr ist als ein Textfilter: „0 in the
// definition, 5 at the call sites" beantwortet, ob ein Name zur Klasse gehoert oder nur benutzt wird.
const sideCounts = computed(() => {
  const out = { source: 0, consumer: 0 }
  for (const b of blocks.value) out[b.side] += b.matches.length
  return out
})

const searchCounter = computed(() => {
  if (!search.value) return ''
  if (searchError.value) return 'Invalid regex'
  if (!hitCount.value) return 'No results'
  return `${activeMatch.value + 1}/${hitCount.value}${searchCapped.value ? '+' : ''}`
})
const searchCounterTitle = computed(() => {
  if (searchError.value) return searchError.value
  if (searchCapped.value) return `Showing the first ${MATCH_LIMIT} matches per code block`
  return ''
})
const searchFailed = computed(() => !!search.value && (!!searchError.value || !hitCount.value))

// Treffer je Block einsammeln. Laeuft auf dem GEMOUNTETEN DOM (nach `nextTick`), nicht auf den
// HTML-Strings: die Query aendert sich bei jedem Tastendruck, und ein neuer `v-html`-String waere
// jedes Mal ein kompletter Neuaufbau saemtlicher Bloecke.
async function scanBlocks() {
  await nextTick()
  const root = bodyEl.value
  if (!root) {
    blocks.value = []
    return
  }
  const els = [...root.querySelectorAll('.edge-code, .edge-usage-code')]
  if (!search.value) {
    els.forEach(clearMatches)
    blocks.value = []
    searchError.value = ''
    searchCapped.value = false
    return
  }
  const cfg = { query: search.value, ...searchOpts.value }
  let error = ''
  let capped = false
  const next = els.map((el) => {
    const r = findMatches(shikiText(el), cfg)
    if (r.error) error = r.error
    if (r.capped) capped = true
    return { el, side: el.classList.contains('edge-usage-code') ? 'consumer' : 'source', matches: r.matches }
  })
  searchError.value = error
  searchCapped.value = capped
  blocks.value = next
}

// Markieren + den aktiven Treffer anfahren – beides aus derselben Trefferliste, sonst liefe der
// Zaehler irgendwann gegen eine andere Markierung. `paintMatches` raeumt jeden Block selbst auf,
// ein Block ohne Treffer wird also mit leerer Liste sauber zurueckgesetzt.
function paintActive() {
  let seen = 0
  for (const b of blocks.value) {
    const local = activeMatch.value - seen
    paintMatches(b.el, b.matches, local >= 0 && local < b.matches.length ? local : -1)
    seen += b.matches.length
  }
  scrollToActive()
}

// Den aktiven Treffer in den Blick holen, ohne `scrollIntoView()`: das bewegt jeden Vorfahren mit,
// also auch die Spalten daneben. Ein Drittel von oben – darueber bleibt Kontext stehen.
function scrollToActive() {
  const box = bodyEl.value
  const el = box?.querySelector('.cs-hit--active')
  if (!box || !el) return
  const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
  box.scrollTop = Math.max(0, box.scrollTop + delta - box.clientHeight / 3)
}

// EIN Watcher fuer alles, was die Markierung beeinflusst – auch fuer die nachgeladenen Snippets:
// die Bloecke entstehen erst, wenn ihr Code eintrifft, und eine Suche, die vor dem Code getippt
// wurde, muss danach trotzdem leuchten. Der Cursor loest den Scan mit aus (statt nur das Malen):
// ueber ein paar kleine Bloecke ist er billig und kann so nicht gegen einen veralteten Stand laufen.
watch([search, searchOpts, searchCursor, snippets, usageSnippets], async () => {
  await scanBlocks()
  paintActive()
})

// Jede Aenderung an Query oder Optionen beginnt wieder beim ersten Treffer.
function setQuery(value) {
  search.value = value
  searchCursor.value = 0
}
function toggleSearchOpt(key) {
  searchOpts.value = { ...searchOpts.value, [key]: !searchOpts.value[key] }
  searchCursor.value = 0
}
function stepMatch(delta) {
  if (hitCount.value) searchCursor.value += delta
}
function closeSearch() {
  search.value = ''
  searchCursor.value = 0
  searchInput.value?.blur()
}

// Klick auf eine der beiden Bilanz-Zahlen: zum ersten Treffer dieser Seite. Die Zahl allein sagt,
// DASS dort etwas steht – der Sprung dorthin ist die naheliegende naechste Frage.
function jumpToSide(side) {
  let seen = 0
  for (const b of blocks.value) {
    if (b.side === side && b.matches.length) {
      searchCursor.value = seen
      return
    }
    seen += b.matches.length
  }
}

// Ctrl+F, wenn dieses Panel vorn steht. Der Tastendruck selbst wird NICHT hier abgefangen: die
// Regel „trifft, was im Blick ist" braucht alle Kandidaten und liegt deshalb in CodeView – sonst
// entscheiden zwei window-Listener dasselbe und man kann nicht mehr sagen, welcher gewinnt.
async function focusSearch() {
  await nextTick()
  searchInput.value?.focus()
  searchInput.value?.select()
}
defineExpose({ focusSearch })

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

// Eine offene Loesch-Bestaetigung gehoert zu GENAU der Kante, an der sie aufgerufen wurde.
watch(() => props.edge, () => (confirmingDelete.value = null))

// Die Suche gehoert zu GENAU dieser Beziehung (dieselbe Regel wie beim Klassenwechsel im
// Source-Tab). Sie haengt bewusst an der IDENTITAET der Kante und nicht am `edge`-Objekt: das
// wird beim Uebergang vom Platzhalter zu den geladenen Daten ohnehin ausgetauscht, und ein
// waehrend des Ladens getippter Begriff waere sonst genau dann weg, wenn der Code eintrifft.
watch(
  () => (props.edge ? `${props.edge.fromFileId} ${props.edge.toFileId} ${props.edge.kind}` : null),
  () => {
    search.value = ''
    searchCursor.value = 0
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
</script>

<template>
  <!-- Panel der Detail-Spalte: kein Teleport, kein Backdrop. Die Hoehe kommt vom Elternteil
       (`h-full`), gescrollt wird nur der Mittelteil – Kopf und Fuss stehen fest, damit „welche
       Beziehung sehe ich hier?" auch nach 300 Zeilen Code noch beantwortet ist. -->
  <div
    v-if="visible && edge"
    class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
  >
          <!-- Kopf: Definition -> Nutzung (gleiche Richtung wie der Graph-Pfeil) -->
          <header class="shrink-0 border-b border-[var(--color-border)] px-3 py-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="ed-kind" :style="{ '--k': isField ? 'var(--color-lavender)' : 'var(--color-accent)' }">
                <Icon :icon="isField ? 'lucide:variable' : 'lucide:braces'" class="h-3 w-3 shrink-0" />
                {{ calleeList.length }} {{ memberWord }}{{ calleeList.length === 1 ? '' : 's' }}
              </span>
              <!-- Dasselbe Badge wie am Kanten-Label im Graph – erklärt wird es an der betroffenen
                   Methode weiter unten. -->
              <span
                v-if="unverified.size"
                class="review-badge shrink-0"
                :title="`${unverified.size} of ${calleeList.length} method(s) on this edge were matched by name only – see the note on the method below`"
              >
                <Icon icon="lucide:alert-triangle" class="h-3 w-3 shrink-0" />
                Please review
              </span>
              <span class="flex-1" />
              <!-- NUR der Rueckweg in die Aggregatliste, aus der diese Kante geoeffnet wurde.
                   Ein zusaetzliches × waere hier die zweite Schliessen-Schaltflaeche innerhalb von
                   zwei Zentimetern – die erste steht im Umschalter direkt darueber. -->
              <button
                v-if="back"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-2xs font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                :title="`Back to ${back}`"
                @click="close"
              >
                <Icon icon="lucide:corner-up-left" class="h-3.5 w-3.5" />
                Back
              </button>
            </div>
            <!-- Die zwei Klassen tragen die Aussage und bekommen deshalb eine eigene Zeile: in
                 einer schmalen Spalte neben Badges gedrängt blieben von beiden nur Wortanfänge. -->
            <div class="mt-1.5 flex min-w-0 items-center gap-1.5 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:share-2" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate" :title="edge.toClass">{{ edge.toClass }}</span>
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span class="truncate" :title="edge.fromClass">{{ edge.fromClass }}</span>
            </div>

            <!-- Suche IN der Beziehung. Eigene Zeile ueber die volle Panelbreite – aus demselben
                 Grund wie im Source-Tab: die Leiste traegt Feld, Zaehler, drei Modus-Schalter und
                 die Navigation, und die draengen sich neben den Klassennamen auf jeder
                 Spaltenbreite. Waehrend des Ladens gibt es keinen Code, in dem man suchen koennte –
                 ein Feld, das nichts finden kann, waere ein Angebot ins Leere. -->
            <div v-if="!loading" class="mt-2">
              <div
                class="flex w-full min-w-0 flex-wrap items-center gap-0.5 rounded-lg border bg-[var(--color-surface)] px-1.5 py-0.5 transition"
                :class="searchFailed ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'"
              >
                <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                <input
                  ref="searchInput"
                  :value="search"
                  type="text"
                  :placeholder="`Search this ${isField ? 'access' : 'call'}…`"
                  aria-label="Search the code of this relation"
                  spellcheck="false"
                  class="min-w-[5rem] flex-1 bg-transparent py-0.5 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                  @input="setQuery($event.target.value)"
                  @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
                  @keydown.esc.prevent.stop="closeSearch"
                />
                <span
                  v-if="search"
                  class="shrink-0 whitespace-nowrap px-0.5 text-3xs tabular-nums"
                  :class="searchFailed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
                  :title="searchCounterTitle"
                >{{ searchCounter }}</span>

                <!-- Modus-Schalter (Aa / ganzes Wort / Regex) – dieselben drei wie ueberall sonst. -->
                <button
                  v-for="o in SEARCH_TOGGLES"
                  :key="o.key"
                  type="button"
                  class="grid h-5 w-5 shrink-0 place-items-center rounded transition"
                  :class="searchOpts[o.key]
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
                  :title="o.title"
                  :aria-pressed="searchOpts[o.key]"
                  @click="toggleSearchOpt(o.key)"
                >
                  <Icon :icon="o.icon" class="h-3.5 w-3.5" />
                </button>

                <!-- Navigation als EINE Einheit: in einer schmalen Spalte bricht die Leiste intern
                     um, und ein einzeln abgetrennter Weiter-Pfeil waere dort ein Bedienelement
                     ohne Zusammenhang. -->
                <div class="ml-auto flex shrink-0 items-center gap-0.5">
                  <span class="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border)]" />
                  <button
                    type="button"
                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent"
                    title="Previous match (Shift+Enter)"
                    :disabled="!hitCount"
                    @click="stepMatch(-1)"
                  >
                    <Icon icon="lucide:chevron-up" class="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent"
                    title="Next match (Enter)"
                    :disabled="!hitCount"
                    @click="stepMatch(1)"
                  >
                    <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5" />
                  </button>
                  <button
                    v-if="search"
                    type="button"
                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                    title="Clear search (Esc)"
                    @click="closeSearch"
                  >
                    <Icon icon="lucide:x" class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <!-- Die Bilanz der beiden Seiten – die eine Frage, die sich NUR hier stellt: steht das
                   Gesuchte in der Definition oder an den Aufrufstellen? Ein Klick springt zum ersten
                   Treffer der Seite; eine Seite ohne Treffer ist gedaempft und nicht anklickbar,
                   denn „0" ist hier eine Aussage und kein Ziel. -->
              <div v-if="search && !searchError" class="mt-1 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  class="side-chip"
                  :class="{ 'is-empty': !sideCounts.source }"
                  :disabled="!sideCounts.source"
                  :title="sideCounts.source
                    ? `Jump to the first match in the ${memberWord} definition in ${edge.toClass}`
                    : `Not found in the ${memberWord} definition in ${edge.toClass}`"
                  @click="jumpToSide('source')"
                >
                  <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0" />
                  <span class="tabular-nums">{{ sideCounts.source }}</span>
                  defines
                </button>
                <button
                  type="button"
                  class="side-chip"
                  :class="{ 'is-empty': !sideCounts.consumer }"
                  :disabled="!sideCounts.consumer"
                  :title="sideCounts.consumer
                    ? `Jump to the first match at the ${isField ? 'access' : 'call'} sites in ${edge.fromClass}`
                    : `Not found at the ${isField ? 'access' : 'call'} sites in ${edge.fromClass}`"
                  @click="jumpToSide('consumer')"
                >
                  <Icon icon="lucide:corner-down-right" class="h-3 w-3 shrink-0" />
                  <span class="tabular-nums">{{ sideCounts.consumer }}</span>
                  {{ isField ? 'reads' : 'calls' }}
                </button>
              </div>
            </div>
          </header>

          <div ref="bodyEl" class="min-h-0 flex-1 overflow-y-auto">
            <!-- Warten hat EINE Form (`BusyState`) – und sie steht dort, wo das Ergebnis erscheinen
                 wird, nicht als Spinner irgendwo über dem Graphen. Das Skelett hat so viele Zeilen
                 wie die Kante Methoden trägt, damit das Panel beim Eintreffen nicht springt. -->
            <div v-if="loading" class="p-3">
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
            <section class="p-3">
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
            <div class="flex items-center gap-3 px-3">
              <span class="h-px flex-1 bg-[var(--color-border)]" />
              <span class="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:arrow-down" class="h-4 w-4 edge-arrow" />
              </span>
              <span class="h-px flex-1 bg-[var(--color-border)]" />
            </div>

            <!-- ── Anwender: aufrufende Klasse mit exakter Aufrufzeile ── -->
            <section class="p-3">
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
          <footer v-if="!loading" class="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                class="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
                @click="openSourceClass"
              >
                <Icon icon="lucide:file-code" class="h-4 w-4 text-[var(--color-text-muted)]" />
                To class
              </button>
            </div>
          </footer>
  </div>
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
  /* Die Methodenkarte darf mit ihrem breitesten Kind (dem Code) waagerecht wachsen. Mit `width: 0`
     zaehlt dieser Fliesstext nicht in deren max-content-Breite und fuellt ueber `min-width`
     trotzdem die Karte (abzueglich der eigenen mx-3-Raender), bricht also um statt zu strecken. */
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

/* --- Suche IN der Beziehung -------------------------------------------------------------------
   Treffer tragen die Gold-Familie von `mark` (style.css) – dieselbe Farbe wie jeder andere
   Suchtreffer in Wikit (Quelltext-Suche, Graph-Suche, Suchpalette). Aktiv vs. passiv unterscheiden
   Deckkraft und Ring, NICHT die Farbe: eine zweite Hue waere eine zweite Bedeutung.
   `color: inherit` ist Pflicht, sonst zieht der Browser-Default fuer `mark` (schwarz auf gelb) die
   Shiki-Farbe des umgebenden Tokens weg – und die Bloecke hier sind durchgehend `code-dark`. */
.edge-code :deep(mark.cs-hit),
.edge-usage-code :deep(mark.cs-hit) {
  background: color-mix(in srgb, var(--color-warning) 32%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.edge-code :deep(mark.cs-hit--active),
.edge-usage-code :deep(mark.cs-hit--active) {
  background: color-mix(in srgb, var(--color-warning) 62%, transparent);
  box-shadow: 0 0 0 1px var(--color-warning);
}

/* Bilanz je Seite der Beziehung. Traegt die Treffer-Farbe, solange es dort etwas zu holen gibt –
   damit gehoert der Chip sichtbar zur Suche und nicht zu den Kanten-Badges darueber. */
.side-chip {
  @apply inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-semibold transition;
  color: var(--color-warning);
  border: 1px solid color-mix(in srgb, var(--color-warning) 40%, transparent);
  background-color: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.side-chip:hover:not(.is-empty) {
  background-color: color-mix(in srgb, var(--color-warning) 24%, transparent);
}
/* Keine Treffer auf dieser Seite: die Zahl bleibt lesbar (sie IST die Auskunft), aber der Chip
   verliert Farbe und Klickbarkeit – ein Sprung ins Nichts waere ein Angebot ohne Ziel. */
.side-chip.is-empty {
  color: var(--color-text-muted);
  border-color: var(--color-border);
  background-color: transparent;
  cursor: default;
}

/* Art der Beziehung im Kopf: dasselbe Zeichen und dieselbe Farbe wie am Kanten-Label im Graphen
   (Aufruf = Akzent, Feldzugriff = Lavendel) – wer von dort kommt, erkennt sie wieder. */
.ed-kind {
  @apply inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-bold uppercase tracking-wide;
  color: var(--k);
  border: 1px solid color-mix(in srgb, var(--k) 40%, transparent);
  background-color: color-mix(in srgb, var(--k) 12%, transparent);
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
