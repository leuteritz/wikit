<script setup>
// „Ask the codebase" (`/ask`): eine Frage in Prosa, eine belegte Antwort.
//
// ⚠️ **Die Quellen stehen VOR der Antwort, nicht darunter.** Wer fragt, sieht zuerst, worauf die
// Antwort sich stuetzen wird – und erkennt eine falsche Auswahl, bevor er einen Text liest, der auf
// ihr aufbaut. Umgekehrt (erst der Text, dann die Fussnote) haette man den Text bereits geglaubt.
//
// ⚠️ **Ein Beleg, der nicht aufloest, wird nicht angezeigt wie einer, der aufloest** (s.
// `lib/askCitations.js`): ein Sprachmodell erfindet in einer fremden Codebasis plausible
// Klassennamen, und ein erfundener Beleg in Chip-Form laedt zum Nachsehen ein und fuehrt ins Leere.
// Aufgeloest = Chip mit Sprung, nicht aufgeloest = gewoehnlicher Text.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Icon } from '../lib/icons.js'
import { api } from '../lib/api.js'
import { renderClientMarkdown } from '../lib/clientMarkdown.js'
import { buildCiteIndex, CITE_CLASS, paintCitations } from '../lib/askCitations.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { isTypingTarget } from '../lib/shortcuts.js'
import BusyState from '../components/BusyState.vue'

const route = useRoute()
const router = useRouter()
const { files, fetchFiles, lastFileId, lastTargetLine } = useJavaAnalyzer()

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

// Ohne Klassen im Bestand gibt es nichts zu fragen – und der Leerzustand sagt das, statt eine
// Bedeutungssuche ins Leere laufen zu lassen.
const hasClasses = computed(() => files.value.length > 0)

const answerHtml = computed(() => (answer.value ? renderClientMarkdown(answer.value) : ''))

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
    hint: 'The classes are here, but their vectors are not. Build the index once in Bot → Embedding index.',
    action: { label: 'Open Bot', to: '/bot' },
  },
  unavailable: {
    title: 'Ollama did not answer',
    hint: 'The question could not be embedded. Check that Ollama is running and the model is pulled.',
    action: { label: 'Open Bot', to: '/bot' },
  },
  'no-match': {
    title: 'Nothing in this codebase matches',
    hint: 'No class came close enough to answer. Try naming a concept that appears in the code — or search the source directly.',
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

// Klick auf einen Beleg -> Klasse in `/code` aufschlagen, auf der zitierten Zeile.
// Event-Delegation, weil die Chips per DOM entstehen und keine Vue-Handler tragen.
function onAnswerClick(ev) {
  const chip = ev.target.closest?.(`.${CITE_CLASS}`)
  if (!chip) return
  const fileId = Number(chip.dataset.fileId)
  const line = Number(chip.dataset.line)
  if (!fileId) return
  lastFileId.value = fileId
  lastTargetLine.value = Number.isFinite(line) && line > 0 ? line : null
  router.push('/code')
}

function openSource(s) {
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
      <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">
        <Icon icon="lucide:help-circle" class="h-6 w-6 text-[var(--color-accent)]" />
        Ask the codebase
      </h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Ask in plain words. The meaning index picks the classes that fit, and the answer is built
        from those alone — every claim carries the class it came from.
      </p>
    </header>

    <!-- Fragefeld -->
    <form
      class="flex items-center gap-2 rounded-xl border bg-[var(--color-surface)] px-3 py-2 transition"
      :class="error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]'"
      @submit.prevent="ask"
    >
      <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      <input
        ref="inputEl"
        v-model="question"
        type="text"
        placeholder="How does an order get placed?"
        aria-label="Ask a question about the codebase"
        spellcheck="false"
        :disabled="!hasClasses"
        class="min-w-0 flex-1 bg-transparent py-1 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-50"
      />
      <button
        v-if="asking"
        type="button"
        class="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
        @click="cancel"
      >
        Stop
      </button>
      <button
        v-else
        type="submit"
        class="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        :disabled="!question.trim() || !hasClasses"
      >
        Ask
      </button>
    </form>

    <p v-if="!hasClasses" class="rounded-lg bg-[var(--color-surface-offset)] px-3 py-2 text-sm text-[var(--color-text-muted)]">
      No classes analysed yet — add some code first, then ask about it.
    </p>

    <p v-if="error" class="notice-warning rounded-lg px-3 py-2 text-sm">{{ error }}</p>

    <!-- ⚠️ Die Quellen stehen VOR der Antwort: sie sind die Grundlage, nicht die Fussnote. -->
    <section v-if="sources.length" class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h2 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        <Icon icon="lucide:quote" class="h-3.5 w-3.5" />
        Answering from {{ sources.length }} {{ sources.length === 1 ? 'class' : 'classes' }}
      </h2>
      <ul class="flex flex-wrap gap-1.5">
        <li v-for="s in sources" :key="s.fileId">
          <button
            type="button"
            class="ask-source"
            :title="`${s.package ? s.package + '.' : ''}${s.className} — open in Code`"
            @click="openSource(s)"
          >
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
      title="Finding the classes that fit…"
      detail="embedding the question · comparing vectors"
      hint="The first question after a restart also loads the model — that is the slow one."
      :since="startedAt"
      :rows="2"
    />

    <!-- Antwort -->
    <section
      v-if="answer || (asking && phase === 'answering')"
      class="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Answer</h2>
        <Icon v-if="asking" icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />
        <span class="ml-auto flex items-center gap-2 text-3xs tabular-nums text-[var(--color-text-muted)]">
          <!-- Die Zahl der aufgeloesten Belege steht da, weil „0 belegt" bei einer langen Antwort
               die wichtigste Auskunft ueber sie ist. -->
          <span v-if="citeCount" :title="`${citeCount} citation(s) resolved to a class`">
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
      class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5 text-center"
    >
      <Icon icon="lucide:info" class="mx-auto mb-2 h-5 w-5 text-[var(--color-text-muted)]" />
      <p class="text-sm font-semibold text-[var(--color-text)]">{{ emptyInfo.title }}</p>
      <p class="mx-auto mt-1 max-w-md text-xs text-[var(--color-text-muted)]">{{ emptyInfo.hint }}</p>
      <RouterLink
        :to="emptyInfo.action.to"
        class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
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
  @apply inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-2 py-1 text-xs text-[var(--color-text)] transition;
}
.ask-source:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* Beleg im Fliesstext. Bewusst als Chip und nicht als Link: er fuehrt nicht auf eine Seite,
   sondern schlaegt eine Klasse an einer Zeile auf – und er ist die einzige Stelle im Text, der man
   ansieht, dass sie geprueft ist. */
.ask-answer :deep(.ask-cite) {
  @apply mx-px inline-flex items-baseline rounded border px-1 py-px font-mono text-2xs font-medium transition;
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background-color: var(--color-accent-soft);
  color: var(--color-accent);
  cursor: pointer;
}
.ask-answer :deep(.ask-cite:hover) {
  background-color: var(--color-accent);
  color: var(--color-accent-contrast);
}

.notice-warning {
  background-color: color-mix(in srgb, var(--color-warning) 14%, transparent);
  color: var(--color-warning);
}
</style>
