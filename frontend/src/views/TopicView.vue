<script setup>
// Ein Thema einsammeln und als EINEN Text mitnehmen.
//
// Warum eine eigene Ansicht und nicht ein siebter Chip in der Suchpalette: das sind zwei
// gegenlaeufige Fragen. Die Palette beantwortet „welches EINE Ding meine ich?" – flacher Index,
// ↵ springt, jedes Strg+K beginnt bei null. Hier lautet die Frage „was gehoert alles dazu?", und
// die Antwort ist eine MENGE mit einer Groesse, die man vor dem Kopieren sehen will. In derselben
// Liste haette ↵ zwei Bedeutungen bekommen (springen vs. anhaken), und fuer die Groessenangabe
// waere im Modal ohnehin kein Platz mehr gewesen.
//
// Drei Festlegungen, die man dem Code sonst nicht ansieht:
//
// ⚠️ **Der Kopiertext kommt vom SERVER, auch beim Umhaken.** Das Format des Buendels ist genau das
// des Exports (`/java/export?ids=`) – dieselben Trenner, dieselbe Sortierung, dieselbe
// Dublettenregel –, und damit bleibt es ueber „Add code" einlesbar. Ihn im Client
// zusammenzusetzen waere ein Request weniger und eine zweite Fassung des Formats, die beim
// naechsten Trenner auseinanderlaeuft. Also holt jede Auswahlaenderung ihn neu (debounced); auf
// dieser Datenmenge ist das eine Rechnung ueber drei kleine Spalten.
//
// ⚠️ **Die Vorschau IST der Kopiertext, kein Auszug daraus.** Ein Buendel, das man nicht gesehen
// hat, bevor es in einem Chat landet, ist eine Wundertuete – und der einzige ehrliche Weg, das zu
// zeigen, ist der Text selbst. Bewusst ohne Shiki: die Frage lautet „was landet in der Ablage?",
// nicht „wie sieht Java aus", und ein Highlighter-Lauf ueber ein paar hundert Kilobyte waere
// Arbeit fuer eine Frage, die niemand gestellt hat.
//
// ⚠️ **Nachbarn sind zuschaltbar und NIE vorausgewaehlt** (s. `TOPIC_SOURCES`). Sie sind der
// Unterschied zwischen „alles was JT heisst" und „alles was mit JT zu tun hat" – aber auch der
// schnellste Weg, versehentlich die halbe Codebasis zu kopieren.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { api } from '../lib/api.js'
import { BIG_CLIPBOARD_BYTES, copyToClipboard } from '../lib/clipboard.js'
import { formatBytes } from '../lib/format.js'
import {
  MAX_CANDIDATES,
  collectTopic,
  defaultSelection,
  estimateTokens,
  groupByReason,
  topicSource,
} from '../lib/topicBundle.js'
import BusyState from '../components/BusyState.vue'
import { Icon } from '../lib/icons.js'
import { vTip } from '../lib/tooltip.js'

const route = useRoute()
const router = useRouter()
const { files, lastFileId, lastTargetLine } = useJavaAnalyzer()
const { edges, fetchEdges } = useJavaGraph()

// Dieselbe Staffelung wie in `CodeView`: das Feld reagiert sofort, die Requests folgen.
const TERM_DEBOUNCE_MS = 280
// Der Zusammenbau des Textes haengt an der Auswahl – und die aendert sich beim Durchklicken einer
// Gruppe mehrmals je Sekunde. Etwas laenger als das Feld, weil hier ein Klick und kein Anschlag
// den Anstoss gibt: wer zwei Haken setzt, meint beide.
const EXPORT_DEBOUNCE_MS = 320
// Wie viele Zeilen des Buendels die Vorschau zeigt. Darueber liest sie niemand mehr, und ein
// <pre> mit 20.000 Zeilen macht das Scrollen zaeh. Was fehlt, steht darunter.
const PREVIEW_LINES = 400
// Fuer die Bedeutungssuche gilt derselbe Mindestumfang wie in der Palette – bei zwei Zeichen hat
// ein Embedding-Modell nichts zu deuten. Name und Quelltext antworten trotzdem, und genau das ist
// der Grund, warum ein Thema hier vier Quellen hat.
const MEANING_MIN_CHARS = 3
// Wie viele Klassen die Quelltextsuche fuer ein Thema hoechstens meldet (Server-Deckel: 60). Die
// Palette nimmt dort ihre 25 – dort ist die Fundstelle die Auskunft, hier die Klasse.
const CODE_FILE_LIMIT = 60
const MEANING_LIMIT = 40

const term = ref(String(route.query.q || ''))
const applied = ref(term.value)
const withNeighbours = ref(false)
const inputEl = ref(null)

const codeFiles = ref([])
const meaningResult = ref(null)
const searching = ref(false)
const searchedAt = ref(0)
const codeNote = ref('')

let termTimer = null
let searchToken = 0
let codeAbort = null
let meaningAbort = null

function abortSearch() {
  codeAbort?.abort()
  meaningAbort?.abort()
  codeAbort = null
  meaningAbort = null
}

// --- Suchen ---------------------------------------------------------------------------------
// Die beiden Requests laufen NEBENEINANDER, nicht nacheinander: die Bedeutungssuche kostet einen
// Ollama-Aufruf und darf die Quelltextsuche nicht aufhalten. Bleibt sie aus (kein Modell, kein
// Index, Ollama weg), fehlt genau ihre Gruppe – der Rest des Buendels ist davon unberuehrt.
async function runSearch(q) {
  const token = ++searchToken
  abortSearch()
  if (!q) {
    codeFiles.value = []
    meaningResult.value = null
    codeNote.value = ''
    searching.value = false
    return
  }
  searching.value = true
  searchedAt.value = Date.now()

  const codeCtrl = new AbortController()
  codeAbort = codeCtrl
  const codeJob = api
    .searchJavaCode(q, { limit: CODE_FILE_LIMIT, context: 0 }, codeCtrl.signal)
    .then((res) => {
      if (token !== searchToken) return
      codeFiles.value = res?.files || []
      // Ein stiller Deckel liest sich wie „mehr gibt es nicht" – hier waere das die falscheste
      // aller Auskuenfte, weil das Buendel danach unvollstaendig kopiert wird.
      codeNote.value = res?.truncated
        ? `More classes mention it than fit this list — narrow the topic for the rest.`
        : ''
    })
    .catch(() => {
      if (token === searchToken) codeFiles.value = []
    })

  let meaningJob = Promise.resolve()
  if (q.length >= MEANING_MIN_CHARS) {
    const meaningCtrl = new AbortController()
    meaningAbort = meaningCtrl
    meaningJob = api
      .semanticSearchJava(q, meaningCtrl.signal, MEANING_LIMIT)
      .then((res) => {
        if (token === searchToken) meaningResult.value = res
      })
      .catch(() => {
        if (token === searchToken) meaningResult.value = null
      })
  } else {
    meaningResult.value = null
  }

  await Promise.all([codeJob, meaningJob])
  if (token === searchToken) searching.value = false
}

watch(term, (v) => {
  clearTimeout(termTimer)
  // Leeren wirkt sofort – ein Ergebnis, das nach dem Loeschen noch 280 ms stehen bleibt, sieht aus,
  // als haette das Feld die Eingabe verschluckt.
  if (!v.trim()) {
    applied.value = ''
    return
  }
  termTimer = setTimeout(() => (applied.value = v.trim()), TERM_DEBOUNCE_MS)
})

watch(applied, (q) => {
  runSearch(q)
  // Der Begriff gehoert in die URL: aus der Palette kommt man mit einem Thema hierher, und ein
  // Link auf ein Buendel ohne sein Thema waere ein leeres Blatt. `replace`, damit das Tippen
  // keinen Verlauf aus zwanzig Zwischenstaenden hinterlaesst.
  router.replace({ query: q ? { q } : {} })
})

// Der Sprung aus der Palette wechselt nur die Query, nicht die Komponente – ohne diesen Watch
// bliebe das Feld beim zweiten Mal auf dem alten Thema stehen.
watch(
  () => route.query.q,
  (q) => {
    const next = String(q || '')
    if (next === applied.value) return
    term.value = next
    applied.value = next.trim()
  },
)

// --- Die Menge ------------------------------------------------------------------------------
const topic = computed(() =>
  collectTopic({
    files: files.value,
    edges: edges.value,
    term: applied.value,
    codeFiles: codeFiles.value,
    meaningResults: meaningResult.value?.results || [],
    withNeighbours: withNeighbours.value,
  }),
)
const groups = computed(() => groupByReason(topic.value.hits))

// Warum die Bedeutungsgruppe fehlt. Ohne den Satz sieht ein leerer Abschnitt aus wie „gibt es
// nicht", obwohl in Wahrheit das Modell fehlt oder der Index nie gebaut wurde.
const MEANING_REASONS = {
  disabled: 'No embedding model set — configure one under Bot.',
  'not-indexed': 'The meaning index is empty — build it under Bot.',
  unavailable: 'Ollama did not answer — the other sources are unaffected.',
}
const meaningNote = computed(() => {
  const r = meaningResult.value
  if (!applied.value || !r || r.results?.length) return ''
  return MEANING_REASONS[r.reason] || ''
})

// --- Auswahl --------------------------------------------------------------------------------
// Das Set haelt auch Ids, die gerade nicht in der Liste stehen (abgeschaltete Nachbarn). Gefiltert
// wird erst beim Lesen – so ist ein Haken nicht weg, nur weil man den Schalter kurz umgelegt hat.
const selected = ref(new Set())
const selectedIds = computed(() => topic.value.hits.filter((h) => selected.value.has(h.fileId)).map((h) => h.fileId))

// ⚠️ Die Vorauswahl braucht ein „hat schon jemand angefasst?" und nicht die Frage „ist das Set
// leer?". Die Antworten der drei Quellen treffen NACHEINANDER ein – die Liste waechst also
// mehrmals je Suche, und an einer leeren Auswahl haette sich die Vorauswahl nur beim allerersten
// Zwischenstand gesetzt (die Klassennamen liegen im Store, sind also sofort da; Quelltext und
// Bedeutung kommen Sekunden spaeter und blieben unangehakt). Umgekehrt darf ein bewusstes „None"
// nicht dadurch verlorengehen, dass danach eine Antwort nachrutscht.
const selectionTouched = ref(false)

// Ein neues THEMA ist eine neue Frage – die Auswahl faellt zurueck auf die Vorgabe. Ein umgelegter
// Nachbarschafts-Schalter ist dagegen nur eine Erweiterung der laufenden Antwort: was schon
// angehakt war, bleibt es, und die neuen Nachbarn kommen unangehakt dazu.
watch(applied, () => {
  selectionTouched.value = false
  selected.value = new Set()
})
watch(
  () => topic.value.hits,
  (hits) => {
    if (!selectionTouched.value) selected.value = defaultSelection(hits)
  },
)

function toggle(id) {
  selectionTouched.value = true
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleGroup(group) {
  selectionTouched.value = true
  const ids = group.items.map((i) => i.fileId)
  const allOn = ids.every((id) => selected.value.has(id))
  const next = new Set(selected.value)
  for (const id of ids) {
    if (allOn) next.delete(id)
    else next.add(id)
  }
  selected.value = next
}
const groupState = (group) => {
  const on = group.items.filter((i) => selected.value.has(i.fileId)).length
  return on === 0 ? 'none' : on === group.items.length ? 'all' : 'some'
}
function selectAll() {
  selectionTouched.value = true
  selected.value = new Set(topic.value.hits.map((h) => h.fileId))
}
function selectNone() {
  selectionTouched.value = true
  selected.value = new Set()
}
// „Reset" stellt die Vorgabe her, gibt die Auswahl aber NICHT wieder frei: wer den Knopf drueckt,
// hat entschieden – eine nachrutschende Antwort darf das nicht erneut ueberschreiben.
function resetSelection() {
  selectionTouched.value = true
  selected.value = defaultSelection(topic.value.hits)
}

// --- Der Text -------------------------------------------------------------------------------
const bundle = ref(null)
const bundling = ref(false)
const bundleSince = ref(0)
let bundleTimer = null
let bundleToken = 0

watch(
  [selectedIds, applied],
  ([ids, q]) => {
    clearTimeout(bundleTimer)
    if (!ids.length || !q) {
      bundle.value = null
      bundling.value = false
      bundleToken++
      return
    }
    bundling.value = true
    bundleSince.value = Date.now()
    bundleTimer = setTimeout(async () => {
      const token = ++bundleToken
      try {
        const res = await api.exportJavaAll(ids, q)
        if (token === bundleToken) bundle.value = res
      } catch {
        if (token === bundleToken) bundle.value = null
      } finally {
        if (token === bundleToken) bundling.value = false
      }
    }, EXPORT_DEBOUNCE_MS)
  },
  { immediate: true },
)

const bundleBytes = computed(() => bundle.value?.bytes || 0)
const sizeLabel = computed(() => formatBytes(bundleBytes.value))
const tokenLabel = computed(() => {
  const t = estimateTokens(bundleBytes.value)
  return t >= 1000 ? `~${Math.round(t / 1000)}k tokens` : `~${t} tokens`
})
const isBig = computed(() => bundleBytes.value > BIG_CLIPBOARD_BYTES)

const previewLines = computed(() => (bundle.value?.text || '').split('\n'))
const previewText = computed(() => previewLines.value.slice(0, PREVIEW_LINES).join('\n'))
const previewCut = computed(() => Math.max(0, previewLines.value.length - PREVIEW_LINES))

// --- Mitnehmen ------------------------------------------------------------------------------
const copied = ref(false)
const copyFailed = ref(false)

async function copyBundle() {
  if (!bundle.value?.text) return
  copyFailed.value = false
  const ok = await copyToClipboard(bundle.value.text)
  copied.value = ok
  copyFailed.value = !ok
  if (ok) setTimeout(() => (copied.value = false), 2500)
}

// Download ohne zweiten Request: der Text liegt bereits im Speicher (gleiche Bauart wie im
// Export-Modal, das hier der Rueckfall fuer alles ist, was der Zwischenablage zu gross ist).
function downloadBundle() {
  if (!bundle.value?.text) return
  const slug = applied.value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  const url = URL.createObjectURL(new Blob([bundle.value.text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `wikit-topic-${slug || 'bundle'}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// --- Absprung -------------------------------------------------------------------------------
// Ein Buendel beantwortet „was gehoert dazu?" – die naechste Frage ist regelmaessig „und was macht
// die Klasse?". Derselbe Handoff wie aus der Palette und aus den Insights.
function openInCode(hit) {
  lastFileId.value = hit.fileId
  lastTargetLine.value = null
  router.push('/code')
}

// --- Ruhezustand ----------------------------------------------------------------------------
// Vorschlaege statt eines leeren Feldes: die haeufigsten Package-Segmente sind die Themen, die
// diese Codebasis tatsaechlich hat – und sie machen in einem Zug klar, was hier einzugeben ist.
const suggestions = computed(() => {
  const count = new Map()
  for (const f of files.value) {
    for (const part of String(f.package || '').split('.')) {
      if (part.length < 3) continue
      count.set(part, (count.get(part) || 0) + 1)
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name]) => name)
})

function useSuggestion(s) {
  term.value = s
  applied.value = s
  inputEl.value?.focus()
}

onMounted(() => {
  inputEl.value?.focus()
  // Die Kanten liegen sonst nur vor, wenn vorher `/code` offen war – ohne sie faende der
  // Nachbarschafts-Schalter nichts und saehe aus, als gaebe es keine Verbindungen.
  if (!edges.value.length) fetchEdges()
  if (applied.value) runSearch(applied.value)
})
onUnmounted(() => {
  clearTimeout(termTimer)
  clearTimeout(bundleTimer)
  abortSearch()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- ======================= Kopfzeile ======================= -->
    <header class="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-5 py-3 backdrop-blur">
      <div class="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon icon="lucide:boxes" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h1 class="text-base font-bold text-[var(--color-text)]">Topic bundle</h1>
          <!-- „Was sehe ich hier?" steht immer sichtbar, nicht in einem Tooltip – gleiche Regel
               wie in den Insights: wer nicht weiss, was er sieht, sucht auch keine Erklaerung. -->
          <p class="text-xs text-[var(--color-text-muted)]">
            Every class around one topic — collected, picked, and copied as one text.
          </p>
        </div>

        <div class="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none sm:basis-[30rem]">
          <div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3">
            <Icon icon="lucide:search" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            <input
              ref="inputEl"
              v-model="term"
              type="text"
              spellcheck="false"
              placeholder="A topic, a prefix, a name — e.g. jt"
              class="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
              @keydown.enter.prevent="applied = term.trim()"
            />
            <button
              v-if="term"
              type="button"
              class="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Clear"
              aria-label="Clear"
              @click="term = ''"
            >
              <Icon icon="lucide:x" class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- Der Schalter, der aus „heisst so" ein „hat damit zu tun" macht. Er steht neben dem
               Feld, weil er die FRAGE erweitert und nicht das Ergebnis filtert. -->
          <button
            v-tip="'Also collect classes that are one relation away from the ones found — they arrive unchecked.'"
            type="button"
            class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-2xs font-semibold transition"
            :class="withNeighbours
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
            :aria-pressed="withNeighbours"
            @click="withNeighbours = !withNeighbours"
          >
            <Icon icon="lucide:share-2" class="h-3.5 w-3.5" />
            Neighbours
          </button>
        </div>
      </div>
    </header>

    <!-- ======================= Inhalt ======================= -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <div class="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-5 py-4 lg:flex-row">
        <!-- ---------- Links: was gefunden wurde ---------- -->
        <section class="flex min-h-0 flex-col lg:w-[26rem] lg:shrink-0">
          <!-- Kein Bestand: dann ist das leere Ergebnis keine Aussage ueber das Thema. -->
          <div
            v-if="!files.length"
            class="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center"
          >
            <Icon icon="lucide:braces" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
            <p class="mt-2 text-sm text-[var(--color-text)]">No classes yet.</p>
            <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
              Import some Java in the code view first — a topic is collected from what is stored.
            </p>
            <RouterLink
              to="/code"
              class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-2xs font-semibold text-[var(--color-accent-contrast)]"
            >
              <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5" /> Go to code
            </RouterLink>
          </div>

          <!-- Ruhezustand: WAS eine Quelle beitraegt, steht hier einmal – danach sagt es der Chip
               an jedem Treffer. Ohne diese vier Zeilen ist „Named after it" nur eine Ueberschrift. -->
          <div v-else-if="!applied" class="min-h-0 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
            <p class="text-sm text-[var(--color-text)]">Type a topic above.</p>
            <p class="mt-1 text-2xs leading-relaxed text-[var(--color-text-muted)]">
              Four sources answer at once, and every hit says which one found it:
            </p>
            <ul class="mt-3 space-y-2">
              <li v-for="s in [
                { icon: 'lucide:braces', label: 'Named after it', hint: 'the class name or its package carries the term' },
                { icon: 'lucide:code-2', label: 'Mentions it in code', hint: 'the term appears somewhere in the source' },
                { icon: 'lucide:sparkles', label: 'About the topic', hint: 'the class is about this — without containing the word' },
                { icon: 'lucide:share-2', label: 'Connected to those', hint: 'one relation away, only with Neighbours on' },
              ]" :key="s.label" class="flex gap-2.5">
                <Icon :icon="s.icon" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span class="min-w-0 text-2xs leading-relaxed">
                  <span class="font-semibold text-[var(--color-text)]">{{ s.label }}</span>
                  <span class="text-[var(--color-text-muted)]"> — {{ s.hint }}</span>
                </span>
              </li>
            </ul>

            <template v-if="suggestions.length">
              <p class="mt-4 font-mono text-3xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Topics in this codebase
              </p>
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  v-for="s in suggestions"
                  :key="s"
                  type="button"
                  class="rounded-full border border-[var(--color-border)] px-2.5 py-1 font-mono text-2xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  @click="useSuggestion(s)"
                >{{ s }}</button>
              </div>
            </template>
          </div>

          <template v-else>
            <!-- Auswahlleiste: die Zahl, die unten am Knopf steht, wird hier gemacht. -->
            <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="font-mono text-2xs tabular-nums text-[var(--color-text)]">
                {{ selectedIds.length }} / {{ topic.hits.length }} selected
              </span>
              <div class="ml-auto flex items-center gap-1">
                <button
                  v-for="b in [
                    { label: 'All', fn: selectAll },
                    { label: 'None', fn: selectNone },
                    { label: 'Reset', fn: resetSelection },
                  ]"
                  :key="b.label"
                  type="button"
                  class="rounded px-1.5 py-0.5 text-2xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                  @click="b.fn()"
                >{{ b.label }}</button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <BusyState
                v-if="searching && !topic.hits.length"
                variant="panel"
                title="Collecting the topic…"
                detail="names, source lines and meaning"
                :since="searchedAt"
                :rows="5"
              />

              <div v-else-if="!topic.hits.length" class="px-4 py-10 text-center">
                <Icon icon="lucide:boxes" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
                <p class="mt-2 text-sm text-[var(--color-text)]">Nothing on “{{ applied }}”.</p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  No class carries the name, mentions it, or is about it. Try a shorter term, or turn
                  Neighbours on once you have a first hit.
                </p>
              </div>

              <template v-else>
                <section v-for="g in groups" :key="g.kind" class="border-b border-[var(--color-border)] last:border-b-0">
                  <!-- Die Gruppenzeile ist zugleich der Schalter fuer die ganze Gruppe: „alle
                       Namenstreffer, keine Nachbarn" ist die haeufigste Auswahl ueberhaupt. -->
                  <button
                    v-tip="g.hint"
                    type="button"
                    class="flex w-full items-center gap-2 bg-[var(--color-surface-offset)]/50 px-3 py-1.5 text-left transition hover:bg-[var(--color-surface-offset)]"
                    @click="toggleGroup(g)"
                  >
                    <Icon
                      :icon="groupState(g) === 'all' ? 'lucide:check-square' : 'lucide:square'"
                      class="h-3.5 w-3.5 shrink-0"
                      :class="groupState(g) === 'none' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]'"
                    />
                    <Icon :icon="g.icon" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span class="font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                      {{ g.label }}
                    </span>
                    <span class="ml-auto font-mono text-3xs tabular-nums text-[var(--color-text-muted)]">
                      {{ g.items.length }}
                    </span>
                  </button>

                  <ul>
                    <li
                      v-for="hit in g.items"
                      :key="hit.fileId"
                      class="flex items-start gap-2 border-t border-[var(--color-border)]/50 px-3 py-2 transition hover:bg-[var(--color-surface-offset)]/40"
                      :class="selected.has(hit.fileId) ? '' : 'opacity-55'"
                    >
                      <button
                        type="button"
                        class="mt-0.5 grid h-4 w-4 shrink-0 place-items-center"
                        :title="selected.has(hit.fileId) ? 'Leave it out' : 'Take it along'"
                        :aria-pressed="selected.has(hit.fileId)"
                        @click="toggle(hit.fileId)"
                      >
                        <Icon
                          :icon="selected.has(hit.fileId) ? 'lucide:check-square' : 'lucide:square'"
                          class="h-4 w-4"
                          :class="selected.has(hit.fileId) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
                        />
                      </button>

                      <button type="button" class="min-w-0 flex-1 text-left" @click="toggle(hit.fileId)">
                        <span class="block truncate text-[0.8125rem] font-semibold text-[var(--color-text)]">
                          {{ hit.className }}
                        </span>
                        <span class="block truncate font-mono text-3xs text-[var(--color-text-muted)]">
                          {{ hit.package || 'default package' }}
                        </span>
                        <!-- ⚠️ Der GRUND ist die halbe Ansicht: man entscheidet je Zeile, ob sie
                             mitkommt, und „source ×12" verlangt eine andere Antwort als
                             „connected to JTConverter". Mehrere Gruende stehen nebeneinander –
                             eine Klasse, die alle drei Quellen nennen, ist der sicherste Kandidat. -->
                        <span class="mt-1 flex flex-wrap gap-1">
                          <span
                            v-for="r in hit.reasons"
                            :key="r.kind"
                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-3xs text-[var(--color-text-muted)]"
                          >
                            <Icon :icon="topicSource(r.kind).icon" class="h-2.5 w-2.5" />
                            {{ r.detail }}<template v-if="r.count > 1"> +{{ r.count - 1 }}</template>
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-accent)]"
                        title="Open this class in the code view"
                        aria-label="Open this class in the code view"
                        @click="openInCode(hit)"
                      >
                        <Icon icon="lucide:arrow-up-right" class="h-3.5 w-3.5" />
                      </button>
                    </li>
                  </ul>
                </section>
              </template>
            </div>

            <!-- Was der Bericht NICHT gesehen hat, gehoert unter den Bericht. -->
            <p v-if="topic.truncated" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:info" class="mt-px h-3 w-3 shrink-0" />
              Showing the strongest {{ MAX_CANDIDATES }} — narrow the topic for the rest.
            </p>
            <p v-if="codeNote" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:info" class="mt-px h-3 w-3 shrink-0" />
              {{ codeNote }}
            </p>
            <p v-if="meaningNote" class="mt-1.5 flex gap-1.5 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:sparkles" class="mt-px h-3 w-3 shrink-0" />
              {{ meaningNote }}
            </p>
          </template>
        </section>

        <!-- ---------- Rechts: was in der Ablage landet ---------- -->
        <section class="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
          <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5">
            <Icon icon="lucide:clipboard-copy" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            <h2 class="text-[0.8125rem] font-semibold text-[var(--color-text)]">What lands in your clipboard</h2>
            <span
              v-if="bundle?.classes"
              v-tip="'The token count is an estimate — roughly 3.5 characters per token.'"
              class="ml-auto font-mono text-2xs tabular-nums text-[var(--color-text-muted)]"
            >
              {{ bundle.classes }} classes · {{ bundle.packages }} packages · {{ sizeLabel }} · {{ tokenLabel }}
            </span>
          </header>

          <div class="min-h-0 flex-1 overflow-auto p-4">
            <BusyState
              v-if="bundling && !bundle"
              variant="panel"
              title="Building the bundle…"
              detail="reading the selected sources"
              :since="bundleSince"
              :rows="6"
            />

            <div v-else-if="!selectedIds.length" class="grid h-full place-items-center px-4 text-center">
              <div>
                <Icon icon="lucide:clipboard-copy" class="mx-auto h-6 w-6 text-[var(--color-text-muted)]" />
                <p class="mt-2 text-sm text-[var(--color-text)]">Nothing picked.</p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  Tick the classes on the left — their full source shows up here, exactly as it will
                  be copied.
                </p>
              </div>
            </div>

            <template v-else-if="bundle?.text">
              <p v-if="isBig" class="notice-warning mb-3 flex gap-2 rounded-lg px-3 py-2 text-2xs leading-relaxed">
                <Icon icon="lucide:alert-triangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{{ sizeLabel }} is a lot for a clipboard — the download is the safer way here.</span>
              </p>
              <!-- Bewusst ohne Syntax-Highlighting: die Frage ist „was landet in der Ablage?",
                   und die Antwort ist genau dieser Text. -->
              <pre class="topic-preview text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ previewText }}</pre>
              <p v-if="previewCut" class="mt-2 font-mono text-3xs text-[var(--color-text-muted)]">
                … {{ previewCut.toLocaleString('en-US') }} more lines — all of them are copied.
              </p>
            </template>
          </div>

          <footer class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
            <p v-if="copyFailed" class="w-full text-2xs text-[var(--color-danger)]">
              The clipboard refused the text — use Download instead.
            </p>
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[0.8125rem] font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40"
              :disabled="!bundle?.text"
              title="Save the bundle as a .txt file"
              @click="downloadBundle"
            >
              <Icon icon="lucide:download" class="h-4 w-4" />
              Download
            </button>
            <button
              type="button"
              class="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[0.8125rem] font-semibold shadow-sm transition disabled:opacity-40"
              :class="copied
                ? 'bg-[var(--color-success)] text-[var(--color-accent-contrast)]'
                : 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)]'"
              :disabled="!bundle?.text"
              @click="copyBundle"
            >
              <Icon :icon="copied ? 'lucide:check' : 'lucide:clipboard-copy'" class="h-4 w-4" />
              {{ copied ? 'Copied' : `Copy ${bundle?.classes || 0} classes` }}
            </button>
          </footer>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Der Ausschnitt behaelt seine Einrueckung – Umbruch waere hier eine Falschaussage ueber den Text,
   der so und nicht anders in der Ablage landet. */
.topic-preview {
  white-space: pre;
  font-family: var(--font-mono, ui-monospace, monospace);
}
</style>
