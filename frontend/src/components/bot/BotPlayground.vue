<script setup>
// Probelauf gegen das Modell – tokenweise, mit Durchsatz und Dauer.
//
// Der Zweck ist nicht "chatten", sondern eine Entscheidung: taugt dieses Modell mit diesen
// Parametern fuer die Doku-Laeufe? Deshalb laeuft der Test gegen das FORMULAR und nicht gegen den
// gespeicherten Stand – sonst muesste man erst speichern und damit den naechsten Massenlauf auf
// ungepruefte Werte stellen – und deshalb steht unter der Antwort, wie lange sie gedauert hat.
//
// Der Stream ist dieselbe Bauart wie ueberall hier: der Client erzeugt die jobId, oeffnet damit den
// SSE-Strom und schickt sie im Start-Body mit.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../lib/api.js'
import { Icon } from '../../lib/icons.js'
import { formatDuration } from '../../lib/format.js'

// `formatDuration` rundet auf Sekunden – fuer einen Probelauf, der 380 ms dauert, stuende dort
// „0:00", also die Auskunft, dass gar nichts gemessen wurde. Unter einer Sekunde zaehlen hier die
// Millisekunden, darueber die vertraute Minuten-Schreibweise.
const ms = (v) => (v == null ? '' : v < 1000 ? `${Math.round(v)} ms` : formatDuration(v))

const props = defineProps({
  // Der Formularstand: Host, Modell, Timeout und die Generierungsparameter.
  draft: { type: Object, default: null },
  prompts: { type: Object, default: () => ({}) },
  dirty: { type: Boolean, default: false },
})

const prompt = ref('Explain in two sentences what a Java interface is used for.')
const running = ref(false)
const output = ref('')
const error = ref('')
const stats = ref(null)
const tokenCount = ref(0)
const elapsed = ref(0)
const startedAt = ref(0)
const outputEl = ref(null)

let es = null
let jobId = ''
let clock = null

// Die Optionen gehen genau so mit, wie sie im Formular stehen – nicht gesetzte Felder bleiben weg,
// damit Ollama seine eigenen Defaults behaelt (dieselbe Regel wie serverseitig in ollamaOptions).
const options = computed(() => {
  const d = props.draft
  if (!d) return {}
  const o = {}
  if (d.temperature != null) o.temperature = d.temperature
  if (d.topP != null) o.top_p = d.topP
  if (d.numCtx != null) o.num_ctx = d.numCtx
  if (d.numPredict != null) o.num_predict = d.numPredict
  if (d.seed != null) o.seed = d.seed
  return o
})

const optionSummary = computed(() => {
  const o = options.value
  const parts = Object.entries(o).map(([k, v]) => `${k}=${v}`)
  return parts.length ? parts.join(' · ') : 'model defaults'
})

function stopClock() {
  if (clock) clearInterval(clock)
  clock = null
}

function closeStream() {
  if (es) es.close()
  es = null
}

function finish() {
  running.value = false
  stopClock()
  closeStream()
}

// Beim Streamen mitlaufen, aber nur solange der Blick ohnehin unten steht – wer nach oben gescrollt
// hat, um etwas nachzulesen, soll nicht bei jedem Token zurueckgerissen werden.
function follow() {
  const el = outputEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
}

async function run() {
  if (running.value || !prompt.value.trim()) return
  output.value = ''
  error.value = ''
  stats.value = null
  tokenCount.value = 0
  elapsed.value = 0
  running.value = true
  startedAt.value = Date.now()
  jobId = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  clock = setInterval(() => {
    elapsed.value = Date.now() - startedAt.value
  }, 100)

  es = new EventSource(api.botPlaygroundStreamUrl(jobId))
  es.onmessage = (ev) => {
    let data
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    if (data.phase === 'token') {
      output.value += data.delta || ''
      tokenCount.value = data.tokenCount || tokenCount.value
      follow()
    } else if (data.phase === 'snapshot') {
      if (data.text) output.value = data.text
    } else if (data.phase === 'done') {
      if (data.text) output.value = data.text
      stats.value = data.stats || null
      elapsed.value = data.elapsedMs ?? elapsed.value
      tokenCount.value = data.tokenCount ?? tokenCount.value
      finish()
    } else if (data.phase === 'error') {
      error.value = data.error || 'The run failed'
      elapsed.value = data.elapsedMs ?? elapsed.value
      finish()
    }
  }
  // Ein abbrechender Strom ohne Abschlussereignis: den Knopf nicht endlos drehen lassen.
  es.onerror = () => {
    if (!running.value) return
    error.value = 'The stream broke off. Is the backend still running?'
    finish()
  }

  try {
    await api.startBotPlayground({
      jobId,
      prompt: prompt.value,
      host: props.draft?.host,
      model: props.draft?.model,
      timeoutMs: props.draft?.timeoutMs,
      options: options.value,
    })
  } catch (e) {
    error.value = e?.message || 'The run could not be started'
    finish()
  }
}

async function cancel() {
  if (!running.value) return
  try {
    await api.cancelBotPlayground(jobId)
  } catch {
    /* Der Abbruch ist bereits durch – das Abschlussereignis raeumt auf. */
  }
  finish()
}

/**
 * Die echte Vorlage mit Beispieldaten fuellen. Das ist der eigentliche Prueflauf: nicht "kann das
 * Modell reden?", sondern "was macht es aus MEINEM Prompt?".
 */
const SAMPLE = {
  context: '',
  signature: 'String DocumentHelper.buildNumber(WTDocument doc, boolean withRevision)',
  javadoc: '',
  body: '\n\nImplementierung:\n```java\n{\n  String base = doc.getNumber();\n  return withRevision ? base + "-" + doc.getVersionIdentifier().getValue() : base;\n}\n```',
  className: 'DocumentHelper',
  methodName: 'buildNumber',
  returnType: 'String',
  fqn: 'com.acme.doc.DocumentHelper',
  classType: 'class',
  package: 'com.acme.doc',
  methods: 'Methoden: buildNumber, findByNumber, isReleased',
  diff: '@@ -12,6 +12,9 @@\n-  return doc.getNumber();\n+  String base = doc.getNumber();\n+  return withRevision ? base + "-" + rev : base;',
}

function loadTemplate(key) {
  const tpl = props.prompts?.[key] || ''
  prompt.value = tpl.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(SAMPLE, name) ? SAMPLE[name] : m,
  )
}

watch(
  () => props.draft?.model,
  () => {
    // Ergebnis eines anderen Modells stehen zu lassen waere eine Aussage ueber das falsche.
    if (!running.value) stats.value = null
  },
)

onBeforeUnmount(() => {
  if (running.value) cancel()
  finish()
})

defineExpose({ run })
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-2">
    <!-- Eingabe --------------------------------------------------------------->
    <div class="flex min-w-0 flex-col">
      <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p class="font-mono text-2xs uppercase tracking-[0.12em] text-muted">Prompt</p>
        <span class="ml-auto flex flex-wrap items-center gap-1">
          <span class="font-mono text-3xs text-muted">fill with:</span>
          <button
            v-for="k in ['method', 'class', 'diff']"
            :key="k"
            type="button"
            class="rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-3xs text-muted transition hover:border-line-strong hover:text-ink"
            :title="`Render the ${k} template with a sample class — this is what the queue actually sends`"
            @click="loadTemplate(k)"
          >{{ k }} template</button>
        </span>
      </div>

      <textarea
        v-model="prompt"
        class="min-h-[22rem] w-full flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink transition focus:border-accent focus:outline-none"
        spellcheck="false"
        placeholder="Ask the model something…"
        @keydown.ctrl.enter.prevent="run"
        @keydown.meta.enter.prevent="run"
      />

      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          v-if="!running"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-50"
          :disabled="!prompt.trim()"
          @click="run"
        >
          <Icon icon="lucide:play" class="h-3.5 w-3.5" />
          Run
        </button>
        <button
          v-else
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-danger/50 px-3.5 py-2 text-xs font-semibold text-danger transition hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)]"
          @click="cancel"
        >
          <Icon icon="lucide:square" class="h-3.5 w-3.5" />
          Stop
        </button>

        <span class="font-mono text-3xs text-muted">
          {{ draft?.model || '—' }} · {{ optionSummary }}
        </span>
      </div>

      <p v-if="dirty" class="mt-2 font-mono text-3xs text-muted">
        Runs against the form, including changes that are not saved yet.
      </p>
    </div>

    <!-- Ausgabe --------------------------------------------------------------->
    <div class="flex min-w-0 flex-col">
      <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p class="font-mono text-2xs uppercase tracking-[0.12em] text-muted">Answer</p>
        <span v-if="running || elapsed" class="ml-auto font-mono text-3xs tabular-nums text-muted">
          {{ ms(elapsed) }}<span v-if="tokenCount"> · {{ tokenCount }} chunks</span>
        </span>
      </div>

      <div
        ref="outputEl"
        class="min-h-[22rem] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink"
      >
        <template v-if="output">{{ output }}</template>
        <span v-else-if="running" class="text-muted">Waiting for the first token…</span>
        <span v-else class="text-muted">Nothing yet. Run a prompt to see what the model returns.</span>
        <span v-if="running" class="pg-caret">▍</span>
      </div>

      <p
        v-if="error"
        class="mt-2 rounded-lg border border-danger/40 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2 text-2xs leading-relaxed text-ink"
      >
        {{ error }}
      </p>

      <!-- Metriken erst NACH dem Lauf: waehrenddessen waeren es Zahlen ueber einen Vorgang, der
           noch nicht stattgefunden hat. -->
      <div v-if="stats" class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span class="inline-flex items-center gap-1.5 font-mono text-2xs text-muted">
          <Icon icon="lucide:zap" class="h-3.5 w-3.5 opacity-70" />
          <span class="font-semibold tabular-nums text-ink">{{ stats.tokensPerSecond }}</span> tok/s
        </span>
        <span class="inline-flex items-center gap-1.5 font-mono text-2xs text-muted">
          <Icon icon="lucide:message-square" class="h-3.5 w-3.5 opacity-70" />
          <span class="font-semibold tabular-nums text-ink">{{ stats.evalCount }}</span> out
          <span class="opacity-60">/</span>
          <span class="font-semibold tabular-nums text-ink">{{ stats.promptEvalCount }}</span> in
        </span>
        <span
          v-if="stats.loadDurationMs > 50"
          class="inline-flex items-center gap-1.5 font-mono text-2xs text-muted"
          title="Time spent loading the model into memory — only the first run after a restart pays it"
        >
          <Icon icon="lucide:clock" class="h-3.5 w-3.5 opacity-70" />
          <span class="font-semibold tabular-nums text-ink">{{ ms(stats.loadDurationMs) }}</span> load
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

/* Cursor am Ende des Streams: zeigt, dass noch etwas kommt – ohne einen Spinner, der den Blick
   vom Text wegzieht. */
.pg-caret {
  animation: pg-blink 1.1s step-end infinite;
  color: var(--color-accent);
}
@keyframes pg-blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pg-caret {
    animation: none;
  }
}
</style>
