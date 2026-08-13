<script setup>
// „Ask your project" (`/ask`): eine Frage in Prosa, eine belegte Antwort.
//
// ⚠️ **Die Quellen stehen VOR der Antwort, nicht darunter.** Wer fragt, sieht zuerst, worauf die
// Antwort sich stuetzen wird – und erkennt eine falsche Auswahl, bevor er einen Text liest, der auf
// ihr aufbaut. Umgekehrt (erst der Text, dann die Fussnote) haette man den Text bereits geglaubt.
//
// ⚠️ **Ein Beleg, der nicht aufloest, wird nicht angezeigt wie einer, der aufloest** (s.
// `lib/askCitations.js`): ein Sprachmodell erfindet in einer fremden Codebasis plausible
// Klassennamen, und ein erfundener Beleg in Chip-Form laedt zum Nachsehen ein und fuehrt ins Leere.
// Aufgeloest = Chip mit Sprung, nicht aufgeloest = gewoehnlicher Text.
//
// ⚠️ **Gefragt werden BEIDE Wissensspeicher: Klassen und Wiki-Artikel.** Der Code sagt, WAS
// geschieht, der Artikel WARUM – und „warum laeuft der Import zweistufig?" hat im Quelltext keine
// Antwort. Die Quellenliste bleibt trotzdem EINE Liste in Rangfolge und wird nicht nach Herkunft
// gruppiert: die Reihenfolge ist die Aussage der Bedeutungssuche („das passt am besten"), und in
// zwei Bloecke zerlegt waere sie genau weg. Woher eine Quelle kommt, sagt ihr Chip; wie die
// Auswahl insgesamt aussieht, sagt die Zeile darueber.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Icon } from '../lib/icons.js'
import { api } from '../lib/api.js'
import { renderClientMarkdown } from '../lib/clientMarkdown.js'
import { buildCiteIndex, CITE_CLASS, paintCitations } from '../lib/askCitations.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useEmbeddings } from '../composables/useEmbeddings.js'
import { isTypingTarget } from '../lib/shortcuts.js'
import BusyState from '../components/BusyState.vue'

const route = useRoute()
const router = useRouter()
const { files, fetchFiles, lastFileId, lastTargetLine } = useJavaAnalyzer()
// Nur fuer die Frage „gibt es hier ueberhaupt etwas zu fragen?" – der Stand kennt beide Bestaende.
const { articles: articleIndex, ensure: ensureEmbeddings } = useEmbeddings()

const question = ref('')
const asking = ref(false)
const phase = ref('') // '' | 'searching' | 'answering'
const answer = ref('')
const sources = ref([])
const emptyReason = ref('')
const error = ref('')
const startedAt = ref(0)
const elapsed = ref(0)
const citeCount = ref(0)

const inputEl = ref(null)
const answerEl = ref(null)
let es = null
let jobId = ''
let clock = null

// Ohne Bestand gibt es nichts zu fragen – und der Leerzustand sagt das, statt eine Bedeutungssuche
// ins Leere laufen zu lassen.
//
// ⚠️ Gezaehlt werden BEIDE Herkuenfte. An den Klassen allein zu haengen hiess, ein Wiki ohne
// hochgeladenen Code mit einem gesperrten Eingabefeld zu empfangen – obwohl genau seine Artikel
// die Frage beantworten koennten.
const hasSources = computed(() => files.value.length > 0 || (articleIndex.value?.total ?? 0) > 0)

const answerHtml = computed(() => (answer.value ? renderClientMarkdown(answer.value) : ''))

// Die Bilanz der Auswahl. Sie steht ueber der Liste, weil die Liste selbst nach Rang sortiert ist
// und die Aufteilung dort nur noch abzaehlbar waere.
const sourceMix = computed(() => {
  const classes = sources.value.filter((s) => s.kind !== 'article').length
  const wiki = sources.value.length - classes
  const parts = []
  if (classes) parts.push(`${classes} ${classes === 1 ? 'class' : 'classes'}`)
  if (wiki) parts.push(`${wiki} ${wiki === 1 ? 'article' : 'articles'}`)
  return parts.join(' · ')
})

// Warum die Antwort leer blieb. Jeder Grund hat einen eigenen naechsten Schritt – „nichts gefunden"
// fuer alle vier waere die Behauptung, die Codebasis gebe nichts her.
const EMPTY_TEXT = {
  disabled: {
    title: 'Meaning-based search is off',
    hint: 'Ask needs it to find the classes behind a question. Set an embedding model in Bot → Connection.',
    action: { label: 'Open Bot', to: '/bot' },
  },
  'not-indexed': {
    title: 'No meaning index yet',
    hint: 'Your classes and articles are here, but their vectors are not. Build the index once in Bot → Meaning index.',
    action: { label: 'Open Bot', to: '/bot' },
  },
  unavailable: {
    title: 'Ollama did not answer',
    hint: 'The question could not be embedded. Check that Ollama is running and the model is pulled.',
    action: { label: 'Open Bot', to: '/bot' },
  },
  'no-match': {
    title: 'Nothing here matches',
    hint: 'Neither a class nor an article came close enough to answer. Try naming a concept that appears in the project — or search the source directly.',
    action: { label: 'Open Code', to: '/code' },
  },
}
const emptyInfo = computed(() => EMPTY_TEXT[emptyReason.value] || null)

function stopClock() {
  if (clock) clearInterval(clock)
  clock = null
}

function closeStream() {
  if (es) es.close()
  es = null
}

function finish() {
  asking.value = false
  phase.value = ''
  stopClock()
  closeStream()
}

// Beim Streamen mitlaufen – aber nur solange der Blick ohnehin unten steht (gleiche Regel wie im
// Playground): wer nach oben gescrollt hat, um einen Beleg nachzulesen, soll nicht bei jedem Token
// zurueckgerissen werden.
function follow() {
  const el = answerEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
}

async function ask() {
  const q = question.value.trim()
  if (!q || asking.value) return
  answer.value = ''
  sources.value = []
  emptyReason.value = ''
  error.value = ''
  citeCount.value = 0
  asking.value = true
  phase.value = 'searching'
  startedAt.value = Date.now()
  elapsed.value = 0
  jobId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Der Begriff faehrt in der URL mit – eine Frage ist etwas, das man verlinkt.
  router.replace({ path: '/ask', query: { q } })

  clock = setInterval(() => {
    elapsed.value = Date.now() - startedAt.value
  }, 100)

  // Erst den Strom oeffnen, dann starten: die Quellen gehen VOR dem ersten Token raus, und ein
  // spaeter geoeffneter Strom haette genau die Auskunft verpasst, an der die Antwort haengt.
  es = new EventSource(api.askStreamUrl(jobId))
  es.onmessage = (ev) => {
    let data
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    if (data.phase === 'searching') {
      phase.value = 'searching'
    } else if (data.phase === 'sources') {
      sources.value = data.sources || []
      phase.value = 'answering'
    } else if (data.phase === 'start') {
      phase.value = 'answering'
      if (data.sources) sources.value = data.sources
    } else if (data.phase === 'token') {
      answer.value += data.delta || ''
      follow()
    } else if (data.phase === 'snapshot') {
      if (data.text) answer.value = data.text
      if (data.sources?.length) sources.value = data.sources
    } else if (data.phase === 'done') {
      if (data.text) answer.value = data.text
      if (data.sources) sources.value = data.sources
      emptyReason.value = data.reason || ''
      elapsed.value = data.elapsedMs ?? elapsed.value
      finish()
    } else if (data.phase === 'error') {
      error.value = data.error || 'The run failed'
      finish()
    }
  }
  // Ein abbrechender Strom ohne Abschlussereignis: den Knopf nicht endlos drehen lassen.
  es.onerror = () => {
    if (!asking.value) return
    error.value = 'The stream broke off. Is the backend still running?'
    finish()
  }

  try {
    await api.startAsk({ jobId, question: q })
  } catch (e) {
    error.value = e.message
    finish()
  }
}

async function cancel() {
  if (!asking.value) return
  try {
    await api.cancelAsk(jobId)
  } catch {
    /* der Strom meldet den Abschluss ohnehin */
  }
  finish()
}

// --- Belege ---------------------------------------------------------------------------------
// Nach jedem Render die Zitate einfaerben. Waehrend des Streams laeuft das bei jedem Token – das
// ist billig (nur Textknoten mit `[`) und die Alternative waere ein Text, dessen Belege erst am
// Ende erscheinen, also genau dann, wenn man ihn schon gelesen hat.
const citeIndex = computed(() => buildCiteIndex(sources.value))

watch([answerHtml, citeIndex], async () => {
  await nextTick()
  citeCount.value = paintCitations(answerEl.value, citeIndex.value)
})

// Klick auf einen Beleg -> Klasse in `/code` auf der zitierten Zeile, Artikel unter seinem Slug.
// Event-Delegation, weil die Chips per DOM entstehen und keine Vue-Handler tragen.
function onAnswerClick(ev) {
  const chip = ev.target.closest?.(`.${CITE_CLASS}`)
  if (!chip) return
  if (chip.dataset.slug) {
    router.push(`/article/${chip.dataset.slug}`)
    return
  }
  const fileId = Number(chip.dataset.fileId)
  const line = Number(chip.dataset.line)
  if (!fileId) return
  lastFileId.value = fileId
  lastTargetLine.value = Number.isFinite(line) && line > 0 ? line : null
  router.push('/code')
}

// Dasselbe Ziel aus der Quellenliste. Die Fallunterscheidung steht an beiden Stellen, weil es zwei
// Gesten sind – aber sie liest dasselbe Feld (`kind`), also gibt es nur eine Regel.
function openSource(s) {
  if (s.kind === 'article') {
    router.push(`/article/${s.slug}`)
    return
  }
  lastFileId.value = s.fileId
  lastTargetLine.value = s.classLine || null
  router.push('/code')
}

// Strg+F / „/" gehoert hier dem Fragefeld – es ist das einzige Eingabefeld der Ansicht.
function onKeydown(e) {
  if (isTypingTarget(e.target)) return
  if ((e.key === 'f' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
    e.preventDefault()
    inputEl.value?.focus()
  }
}

onMounted(() => {
  if (!files.value.length) fetchFiles().catch(() => {})
  // Sagt, ob es ueberhaupt Artikel gibt – und damit, ob das Feld benutzbar ist.
  ensureEmbeddings().catch(() => {})
  window.addEventListener('keydown', onKeydown)
  // Eine Frage in der URL ist eine Ansage – sie wird sofort gestellt, nicht nur eingesetzt.
  const q = (route.query.q || '').toString().trim()
  if (q) {
    question.value = q
    ask()
  } else {
    inputEl.value?.focus()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopClock()
  closeStream()
})

const seconds = computed(() => (elapsed.value / 1000).toFixed(1))
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto px-4 py-6 lg:px-8">
    <!-- Kopf: was diese Ansicht beantwortet. Steht IMMER sichtbar da (gleiche Regel wie in
         /insights): wer nicht weiss, was er sieht, sucht auch keine Erklaerung dazu. -->
    <header>
      <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
        <Icon icon="lucide:help-circle" class="h-6 w-6 text-accent" />
        <!-- ⚠️ Nicht mehr „Ask the codebase": seit auch die Artikel gelesen werden, waere der
             Titel eine Aussage ueber die Quellen, die nicht mehr stimmt – und ausgerechnet in
             einer Ansicht, deren ganzer Wert an der Nachpruefbarkeit ihrer Quellen haengt. -->
        Ask your project
      </h1>
      <p class="mt-1 text-sm text-muted">
        Ask in plain words. The meaning index picks the classes and wiki articles that fit, and the
        answer is built from those alone — every claim carries the source it came from. The code
        says what happens, an article says why.
      </p>
    </header>

    <!-- Fragefeld -->
    <form
      class="flex items-center gap-2 rounded-xl border bg-surface px-3 py-2 transition"
      :class="error ? 'border-danger' : 'border-line focus-within:border-accent'"
      @submit.prevent="ask"
    >
      <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-muted" />
      <input
        ref="inputEl"
        v-model="question"
        type="text"
        placeholder="How does an order get placed?"
        aria-label="Ask a question about the codebase"
        spellcheck="false"
        :disabled="!hasSources"
        class="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-muted disabled:opacity-50"
      />
      <button
        v-if="asking"
        type="button"
        class="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:bg-surface-offset hover:text-ink"
        @click="cancel"
      >
        Stop
      </button>
      <button
        v-else
        type="submit"
        class="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-50"
        :disabled="!question.trim() || !hasSources"
      >
        Ask
      </button>
    </form>

    <p v-if="!hasSources" class="rounded-lg bg-surface-offset px-3 py-2 text-sm text-muted">
      Nothing to ask about yet — add some code or write a wiki article first.
    </p>

    <p v-if="error" class="notice-warning rounded-lg px-3 py-2 text-sm">{{ error }}</p>

    <!-- ⚠️ Die Quellen stehen VOR der Antwort: sie sind die Grundlage, nicht die Fussnote. -->
    <section v-if="sources.length" class="rounded-xl border border-line bg-surface p-3">
      <h2 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon icon="lucide:quote" class="h-3.5 w-3.5" />
        Answering from {{ sources.length }} {{ sources.length === 1 ? 'source' : 'sources' }}
        <span class="font-normal normal-case tracking-normal opacity-70">— {{ sourceMix }}, best match first</span>
      </h2>
      <!-- Eine Liste in RANGFOLGE, nicht zwei Bloecke nach Herkunft: die Reihenfolge ist die
           Aussage der Bedeutungssuche, und gruppiert waere sie verschwunden. Die Herkunft steht
           am Chip. -->
      <ul class="flex flex-wrap gap-1.5">
        <li v-for="s in sources" :key="s.kind === 'article' ? `a${s.articleId}` : `c${s.fileId}`">
          <button
            v-if="s.kind === 'article'"
            type="button"
            class="ask-source ask-source--wiki"
            :title="`“${s.title}” — open in the wiki`"
            @click="openSource(s)"
          >
            <Icon icon="lucide:book-open" class="h-3 w-3 shrink-0 opacity-70" />
            <span class="font-medium">{{ s.title }}</span>
            <span v-if="s.category" class="opacity-60">{{ s.category }}</span>
            <span class="tabular-nums opacity-50">{{ s.score }}</span>
          </button>
          <button
            v-else
            type="button"
            class="ask-source"
            :title="`${s.package ? s.package + '.' : ''}${s.className} — open in Code`"
            @click="openSource(s)"
          >
            <Icon icon="lucide:file-code" class="h-3 w-3 shrink-0 opacity-70" />
            <span class="font-medium">{{ s.className }}</span>
            <span class="opacity-60">{{ s.type }}</span>
            <span class="tabular-nums opacity-50">{{ s.score }}</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- Warten: dieselbe Form wie ueberall (BusyState). Die Suche ist eine eigene Phase, weil sie
         einen eigenen Ollama-Aufruf kostet und ohne Auskunft wie ein haengender Knopf aussaehe. -->
    <BusyState
      v-if="asking && phase === 'searching'"
      variant="panel"
      title="Finding the sources that fit…"
      detail="embedding the question · comparing vectors across code and wiki"
      hint="The first question after a restart also loads the model — that is the slow one."
      :since="startedAt"
      :rows="2"
    />

    <!-- Antwort -->
    <section
      v-if="answer || (asking && phase === 'answering')"
      class="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface"
    >
      <div class="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Answer</h2>
        <Icon v-if="asking" icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin text-accent" />
        <span class="ml-auto flex items-center gap-2 text-3xs tabular-nums text-muted">
          <!-- Die Zahl der aufgeloesten Belege steht da, weil „0 belegt" bei einer langen Antwort
               die wichtigste Auskunft ueber sie ist. -->
          <span v-if="citeCount" :title="`${citeCount} citation(s) resolved to a class or article`">
            {{ citeCount }} linked
          </span>
          <span>{{ seconds }}s</span>
        </span>
      </div>
      <div
        ref="answerEl"
        class="prose prose-sm ask-answer max-w-none overflow-y-auto px-4 py-3 dark:prose-invert"
        v-html="answerHtml"
        @click="onAnswerClick"
      />
    </section>

    <!-- Leerzustand mit Grund UND naechstem Schritt -->
    <section
      v-else-if="emptyInfo && !asking"
      class="rounded-xl border border-line bg-surface px-4 py-5 text-center"
    >
      <Icon icon="lucide:info" class="mx-auto mb-2 h-5 w-5 text-muted" />
      <p class="text-sm font-semibold text-ink">{{ emptyInfo.title }}</p>
      <p class="mx-auto mt-1 max-w-md text-xs text-muted">{{ emptyInfo.hint }}</p>
      <RouterLink
        :to="emptyInfo.action.to"
        class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-offset"
      >
        {{ emptyInfo.action.label }}
        <Icon icon="lucide:arrow-up-right" class="h-3.5 w-3.5" />
      </RouterLink>
    </section>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Quelle als Chip: dieselbe Sprache wie die Belege im Text, nur ohne den Akzentrahmen – die
   Quellenliste sagt „daraus entsteht die Antwort", der Beleg im Text „hierher gehoert dieser Satz". */
.ask-source {
  @apply inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-offset px-2 py-1 text-xs text-ink transition;
}
.ask-source:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* Der Artikel-Chip in der Quellenliste. Dieselbe Form wie der Klassen-Chip – es sind zwei Quellen
   derselben Antwort, keine zwei Ränge –, unterschieden durch das Icon und durch den nicht
   monospacen Titel: ein Klassenname IST Code, ein Artikeltitel ist Prosa. */
.ask-source--wiki .font-medium {
  font-style: italic;
}

/* Beleg im Fliesstext. Bewusst als Chip und nicht als Link: er fuehrt nicht auf eine Seite,
   sondern schlaegt eine Klasse an einer Zeile auf – und er ist die einzige Stelle im Text, der man
   ansieht, dass sie geprueft ist. */
.ask-answer :deep(.ask-cite) {
  @apply mx-px inline-flex items-baseline gap-1 rounded border px-1 py-px font-mono text-2xs font-medium transition;
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background-color: var(--color-accent-soft);
  color: var(--color-accent);
  cursor: pointer;
}
.ask-answer :deep(.ask-cite:hover) {
  background-color: var(--color-accent);
  color: var(--color-accent-contrast);
}

/* ⚠️ Ein Artikel-Beleg sagt seine Herkunft als WORT, nicht als zweiter Farbton: Grün heißt in
   dieser Oberfläche „erfolgreich" und Gold „prüfen", und ein Icon hieße ein inline-SVG an einer
   Stelle, an der kein Vue läuft (die Chips baut `askCitations.js` direkt im DOM). Der Titel steht
   dafür in der Fließtextschrift – er ist Prosa, kein Bezeichner. */
.ask-answer :deep(.ask-cite--wiki) {
  @apply font-sans;
}
.ask-answer :deep(.ask-cite-kind) {
  @apply rounded-sm px-1 font-mono text-3xs uppercase tracking-wide opacity-70;
  background-color: color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.notice-warning {
  background-color: color-mix(in srgb, var(--color-warning) 14%, transparent);
  color: var(--color-warning);
}
</style>
