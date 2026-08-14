<script setup>
// Der Bot-Bereich: alles, was die lokale KI betrifft, an EINER Stelle.
//
// Vorher war das ueber drei Orte verstreut, an denen man es nicht vermutet: Host, Modell und
// Timeout lagen ausschliesslich in Env-Variablen (Aenderung = Server neu starten), der
// Projekt-Kontext in einem Feld im Add-Code-Modal, das seinen Inhalt bei jedem Reload verlor, und
// die Prompts standen hart im Quelltext des OllamaService. Die Generierungsparameter gab es
// ueberhaupt nicht – es galt, was Ollama voreingestellt hat.
//
// Vier Abschnitte, weil es vier Fragen sind: Antwortet der Server (Connection)? Wie soll das
// Modell antworten (Generation)? Was fragen wir es (Prompts)? Und taugt das Ergebnis (Playground)?
//
// Zwei Staende nebeneinander (siehe useBot): `config` ist gespeichert, `draft` ist das Formular.
// Deshalb kann der Probelauf gegen ungespeicherte Werte laufen – genau dafuer ist er da.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useBot } from '../composables/useBot.js'
import { useNotifications } from '../composables/useNotifications.js'
import BotField from '../components/bot/BotField.vue'
import BotHealthCard from '../components/bot/BotHealthCard.vue'
import BotModelPicker from '../components/bot/BotModelPicker.vue'
import BotPlayground from '../components/bot/BotPlayground.vue'
import BotPromptEditor from '../components/bot/BotPromptEditor.vue'
import BotEmbedIndex from '../components/bot/BotEmbedIndex.vue'
import BusyState from '../components/BusyState.vue'
import Button from '../components/ui/Button.vue'
import { Icon } from '../lib/icons.js'

const { state, dirty, dirtyPaths, status, statusLabel, load, save, revert, resetPaths, checkHealth, loadModels, getPath, setPath } =
  useBot()
const { push } = useNotifications()

const TABS = [
  { id: 'connection', label: 'Connection', icon: 'lucide:server', hint: 'Server, model and timeout' },
  { id: 'generation', label: 'Generation', icon: 'lucide:sliders-horizontal', hint: 'How the model answers, and how the queue runs' },
  { id: 'prompts', label: 'Prompts', icon: 'lucide:message-square', hint: 'Project context and the four templates' },
  // Der eine Reiter, der NICHTS mit Ollama zu tun hat. Er steht hier, weil /bot die einzige
  // Einstellungsseite ist – und er steht getrennt, damit ihn auch niemand für eine KI-Einstellung
  // hält. Der Statuspunkt oben betrifft ihn nicht.
  { id: 'wiki', label: 'Wiki', icon: 'lucide:book-open', hint: 'Settings that are not about the AI' },
  { id: 'playground', label: 'Playground', icon: 'lucide:zap', hint: 'Try a prompt before a mass run' },
]
const tab = ref('connection')
const playground = ref(null)
const startedAt = ref(Date.now())

const draft = computed(() => state.draft)
const fieldsOf = (group) => state.fields.filter((f) => f.group === group)

// Welche Env-Variable hinter dem Default steht – die Oberflaeche benennt sie am Feld, statt einen
// Wert zu zeigen, den niemand einordnen kann.
const ENV_NAMES = {
  host: 'OLLAMA_URL',
  model: 'OLLAMA_MODEL',
  timeoutMs: 'OLLAMA_TIMEOUT_MS',
  embedModel: 'OLLAMA_EMBED_MODEL',
  embedTimeoutMs: 'OLLAMA_EMBED_TIMEOUT_MS',
  'wiki.historyKeep': 'WIKI_HISTORY_KEEP',
}
const envNameFor = (path) => (state.env?.[path] ? ENV_NAMES[path] || '' : '')

const DOT = {
  online: 'var(--color-success)',
  warn: 'var(--color-warning)',
  offline: 'var(--color-danger)',
  unknown: 'var(--color-text-muted)',
}

onMounted(async () => {
  await load()
  // Der Katalog haengt am Host, den das Formular kennt – erst laden, dann fragen.
  loadModels(state.draft?.host || '')
  checkHealth()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// Ungespeicherte Aenderungen sind hier folgenreich: sie betreffen jeden kuenftigen KI-Lauf. Ein
// stilles Verwerfen beim Wegklicken waere der teuerste Verlust, den diese Seite anrichten kann.
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return window.confirm('You have unsaved bot settings. Leave the page and discard them?')
})

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    doSave()
    return
  }
  // Ctrl+Enter gehoert dem Playground – aber nur, wenn er auch zu sehen ist.
  if (mod && e.key === 'Enter' && tab.value === 'playground') {
    e.preventDefault()
    playground.value?.run()
  }
}

async function doSave() {
  if (!dirty.value || state.saving) return
  const n = dirtyPaths.value.length
  try {
    await save()
    push({ kind: 'success', message: `Saved ${n} ${n === 1 ? 'setting' : 'settings'}. They apply to the next AI run.` })
    checkHealth()
  } catch {
    /* lib/api.js hat den Grund bereits als Toast gezeigt */
  }
}

async function resetAll() {
  if (!window.confirm('Reset every bot setting to its default? Stored values are removed, and the environment variables apply again.')) {
    return
  }
  try {
    await resetPaths(null)
    push({ kind: 'success', message: 'All bot settings are back to their defaults.' })
    checkHealth()
  } catch {
    /* Toast kam bereits aus lib/api.js */
  }
}

function updateField(path, value) {
  if (state.draft) setPath(state.draft, path, value)
}

function updatePrompt(key, value) {
  updateField(`prompts.${key}`, value)
}

function resetPrompt(key) {
  updateField(`prompts.${key}`, getPath(state.defaults, `prompts.${key}`))
}

function pickModel(name) {
  updateField('model', name)
}

// Wechselt der Host im Formular, ist der bisherige Katalog eine Aussage ueber einen anderen Server.
let hostTimer = null
watch(
  () => state.draft?.host,
  (host) => {
    if (!host) return
    clearTimeout(hostTimer)
    // Nicht bei jedem Tastendruck einen fremden Server anfragen – der Host wird zeichenweise getippt.
    hostTimer = setTimeout(() => loadModels(host), 600)
  },
)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- ======================= Kopfzeile ======================= -->
    <header
      class="sticky top-0 z-20 border-b border-line bg-surface/95 px-5 py-3 backdrop-blur"
    >
      <div class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon icon="lucide:bot" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h1 class="font-mono text-base font-semibold tracking-tight text-ink">Bot</h1>
          <p class="flex items-center gap-1.5 text-2xs text-muted">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ background: DOT[status] }" />
            <span class="truncate">{{ statusLabel }}</span>
          </p>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <!-- Der Zaehler ist die Auskunft: „3 unsaved" sagt, dass etwas aussteht UND wieviel. -->
          <span v-if="dirty" class="font-mono text-2xs text-warning">
            {{ dirtyPaths.length }} unsaved
          </span>
          <Button v-if="dirty" size="xs" @click="revert">Discard</Button>
          <Button
            variant="primary"
            size="xs"
            icon="lucide:save"
            :busy="state.saving"
            busy-label="Saving…"
            :disabled="!dirty"
            title="Save changed settings (Ctrl+S)"
            @click="doSave"
          >
            Save
          </Button>
        </div>
      </div>

      <!-- Abschnitte: beschriftet ist, was es gibt, markiert, wo man steht. -->
      <nav class="mx-auto mt-3 flex w-full max-w-6xl flex-wrap gap-1">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition"
          :class="tab === t.id
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-transparent text-muted hover:bg-surface-offset'"
          :title="t.hint"
          @click="tab = t.id"
        >
          <Icon :icon="t.icon" class="h-3.5 w-3.5" />
          {{ t.label }}
        </button>
      </nav>
    </header>

    <!-- ======================= Inhalt ======================= -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div class="mx-auto w-full max-w-6xl">
        <BusyState
          v-if="!state.loaded"
          variant="panel"
          title="Loading bot settings…"
          detail="host, model, generation parameters and the four prompt templates"
          :rows="4"
          :since="startedAt"
        />

        <template v-else-if="draft">
          <!-- ---------------- Connection ---------------- -->
          <div v-show="tab === 'connection'" class="space-y-5">
            <BotHealthCard
              :health="state.health"
              :checking="state.healthChecking"
              :host="draft.host"
              :model="draft.model"
              :dirty="dirty"
              @check="checkHealth({ useDraft: true })"
            />

            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-3 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Server</h2>
              <div class="space-y-4">
                <BotField
                  v-for="f in fieldsOf('connection')"
                  :key="f.path"
                  :spec="f"
                  :model-value="getPath(draft, f.path)"
                  :default-value="getPath(state.defaults, f.path)"
                  :overridden="state.overrides.includes(f.path)"
                  :env-name="envNameFor(f.path)"
                  @update:model-value="updateField(f.path, $event)"
                />
              </div>
            </section>

            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-3 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Model catalog</h2>
              <BotModelPicker
                :models="state.models"
                :active="draft.model"
                :loading="state.modelsLoading"
                :error="state.modelsError"
                :host="draft.host"
                @select="pickModel"
                @refresh="loadModels(draft.host)"
              />
            </section>

            <!-- Der Bedeutungsindex gehoert unter das Modell, das ihn erzeugt: ein Modellwechsel
                 macht jeden gespeicherten Vektor ungueltig, und diese Folge muss dort stehen, wo
                 man wechselt. -->
            <BotEmbedIndex :health="state.health" :draft-model="draft.embedModel" />
          </div>

          <!-- ---------------- Generation ---------------- -->
          <div v-show="tab === 'generation'" class="space-y-5">
            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Sampling</h2>
              <p class="mb-3.5 text-2xs text-muted">
                Everything on <span class="font-mono">auto</span> is left to the model — that option is not sent at all.
              </p>
              <div class="grid gap-4 lg:grid-cols-2 lg:gap-x-8">
                <BotField
                  v-for="f in fieldsOf('generation')"
                  :key="f.path"
                  :spec="f"
                  :model-value="getPath(draft, f.path)"
                  :default-value="getPath(state.defaults, f.path)"
                  :overridden="state.overrides.includes(f.path)"
                  @update:model-value="updateField(f.path, $event)"
                />
              </div>
            </section>

            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Queue</h2>
              <p class="mb-3.5 text-2xs text-muted">
                How the background analysis works through classes. Applies to a running queue as well.
              </p>
              <div class="grid gap-4 lg:grid-cols-2 lg:gap-x-8">
                <BotField
                  v-for="f in fieldsOf('queue')"
                  :key="f.path"
                  :spec="f"
                  :model-value="getPath(draft, f.path)"
                  :default-value="getPath(state.defaults, f.path)"
                  :overridden="state.overrides.includes(f.path)"
                  @update:model-value="updateField(f.path, $event)"
                />
              </div>
            </section>
          </div>

          <!-- ---------------- Prompts ---------------- -->
          <div v-show="tab === 'prompts'" class="space-y-5">
            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-3 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Project context</h2>
              <BotField
                v-for="f in fieldsOf('context')"
                :key="f.path"
                :spec="f"
                :model-value="getPath(draft, f.path)"
                :default-value="getPath(state.defaults, f.path)"
                :overridden="state.overrides.includes(f.path)"
                @update:model-value="updateField(f.path, $event)"
              />
            </section>

            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Templates</h2>
              <p class="mb-3.5 text-2xs text-muted">
                What Wikit actually sends. Placeholders in braces are replaced before the request — the
                <span class="font-mono">Playground</span> tab renders them with a sample class.
              </p>
              <BotPromptEditor
                :prompts="draft.prompts"
                :defaults="state.defaultPrompts"
                :placeholders="state.placeholders"
                :placeholder-help="state.placeholderHelp"
                :fields="state.fields"
                :overrides="state.overrides"
                @update="updatePrompt"
                @reset="resetPrompt"
              />
            </section>
          </div>

          <!-- ---------------- Wiki ---------------- -->
          <div v-show="tab === 'wiki'" class="space-y-5">
            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <h2 class="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted">Version history</h2>
              <p class="mb-3.5 text-2xs text-muted">
                Every article keeps its earlier text. Nothing here reaches Ollama — the status dot above
                does not apply.
              </p>
              <div class="grid gap-4 lg:grid-cols-2 lg:gap-x-8">
                <BotField
                  v-for="f in fieldsOf('wiki')"
                  :key="f.path"
                  :spec="f"
                  :model-value="getPath(draft, f.path)"
                  :default-value="getPath(state.defaults, f.path)"
                  :overridden="state.overrides.includes(f.path)"
                  :env-name="envNameFor(f.path)"
                  @update:model-value="updateField(f.path, $event)"
                />
              </div>
              <!-- Eine gesenkte Grenze wirft beim naechsten Speichern weg, was darueber liegt –
                   das gehoert VOR den Klick, nicht in die Fehlermeldung danach. -->
              <p class="mt-3 text-2xs leading-relaxed text-muted">
                Lowering this drops the surplus versions the next time an article is saved — oldest
                first, and it cannot be undone.
              </p>
            </section>
          </div>

          <!-- ---------------- Playground ---------------- -->
          <div v-show="tab === 'playground'">
            <section class="rounded-xl border border-line bg-surface-2 p-4">
              <BotPlayground ref="playground" :draft="draft" :prompts="draft.prompts" :dirty="dirty" />
            </section>
          </div>

          <!-- Der Weg zurueck auf Werkseinstellung steht unten, nicht in der Kopfzeile: er ist
               selten und folgenreich, und rot in der Kopfzeile ist eine Warnung, die nach zwei
               Minuten niemanden mehr erreicht. -->
          <div class="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button
              type="button"
              class="rounded-md border border-line px-3 py-1.5 text-2xs font-medium text-muted transition hover:border-danger/50 hover:text-danger"
              @click="resetAll"
            >
              Reset everything to defaults
            </button>
            <p class="text-3xs text-muted">
              <!-- „Everything" heißt seit dem Wiki-Reiter mehr als die Ollama-Werte. Die Zeile
                   nennt sie, also muss sie vollständig sein – sonst verspricht der Knopf weniger,
                   als er tut. -->
              Removes the stored values — including the wiki ones. Afterwards the environment
              variables apply again (<span class="font-mono">OLLAMA_URL</span>,
              <span class="font-mono">OLLAMA_MODEL</span>, <span class="font-mono">OLLAMA_TIMEOUT_MS</span>,
              <span class="font-mono">WIKI_HISTORY_KEEP</span>), and the shipped prompt templates.
            </p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
