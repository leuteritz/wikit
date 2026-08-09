import { computed, reactive } from 'vue'
import { api } from '../lib/api.js'

// Zustand des Bot-Bereichs (/bot) als Modul-Singleton – wie jeder andere Store hier: kein Pinia.
//
// Zwei Staende nebeneinander, und das ist der Kern: `config` ist, was der SERVER gespeichert hat,
// `draft` ist das Formular. Erst dadurch gibt es "ungespeicherte Aenderungen", einen Verwerfen-Weg
// und – der eigentliche Zweck – einen Probelauf mit Werten, die noch NICHT gespeichert sind. Wer
// eine Temperatur ausprobieren will, soll dafuer nicht erst den naechsten Massenlauf umstellen.
//
// Die Feldbeschreibung (Typ, Grenzen, Erklaerung) kommt aus derselben Antwort mit (`fields`);
// das Formular zeichnet sich daraus. Waeren die Grenzen hier noch einmal aufgeschrieben, boete es
// irgendwann etwas an, das der Server ablehnt.

const state = reactive({
  loading: false,
  loaded: false,
  saving: false,
  config: null,
  draft: null,
  defaults: null,
  overrides: [],
  fields: [],
  placeholders: {},
  placeholderHelp: {},
  defaultPrompts: {},
  env: {},
  // Verbindungsstand. `null` = noch nicht geprueft (grauer Punkt), nicht "offline".
  health: null,
  healthChecking: false,
  models: [],
  modelsError: '',
  modelsLoading: false,
})

const clone = (v) => JSON.parse(JSON.stringify(v ?? null))

function getPath(obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}

function setPath(obj, path, value) {
  const parts = path.split('.')
  const last = parts.pop()
  let cur = obj
  for (const p of parts) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[last] = value
}

// Zwei Werte gelten als gleich, wenn sie es nach der Serialisierung sind – das faengt auch den
// Fall "null vs. leeres Feld" ab, der sonst als Aenderung durchginge und ein PUT ausloeste.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

let healthTimer = null

export function useBot() {
  const dirtyPaths = computed(() => {
    if (!state.config || !state.draft) return []
    return state.fields
      .map((f) => f.path)
      .filter((p) => !same(getPath(state.draft, p), getPath(state.config, p)))
  })
  const dirty = computed(() => dirtyPaths.value.length > 0)

  async function load({ force = false } = {}) {
    if (state.loading) return
    if (state.loaded && !force) return
    state.loading = true
    try {
      const data = await api.getBotSettings()
      state.config = data.config
      // Beim erneuten Laden nur uebernehmen, was der Nutzer nicht gerade bearbeitet – sonst
      // loescht ein Hintergrund-Refresh Eingaben, die noch nicht gespeichert sind.
      if (!state.draft || !dirty.value) state.draft = clone(data.config)
      state.defaults = data.defaults
      state.overrides = data.overrides || []
      state.fields = data.fields || []
      state.placeholders = data.placeholders || {}
      state.placeholderHelp = data.placeholderHelp || {}
      state.defaultPrompts = data.defaultPrompts || {}
      state.env = data.env || {}
      state.loaded = true
    } finally {
      state.loading = false
    }
  }

  /** Nur die geaenderten Felder schicken – ein Voll-Update wuerde jedes Feld als Override schreiben. */
  async function save() {
    if (!state.draft || !dirty.value) return
    const patch = {}
    for (const path of dirtyPaths.value) setPath(patch, path, getPath(state.draft, path))
    state.saving = true
    try {
      const data = await api.updateBotSettings(patch)
      state.config = data.config
      state.draft = clone(data.config)
      state.overrides = data.overrides || []
      state.env = data.env || {}
      return data
    } finally {
      state.saving = false
    }
  }

  /** Auf den Default zuruecksetzen: der Server loescht die Zeile, danach gilt wieder Env/Code. */
  async function resetPaths(paths) {
    const data = await api.resetBotSettings(paths && paths.length ? paths : null)
    state.config = data.config
    state.draft = clone(data.config)
    state.overrides = data.overrides || []
    return data
  }

  function revert() {
    if (state.config) state.draft = clone(state.config)
  }

  /** Im Formular auf den Default setzen, ohne zu speichern (der Save-Knopf schreibt es dann). */
  function setDefault(path) {
    if (!state.draft || !state.defaults) return
    setPath(state.draft, path, clone(getPath(state.defaults, path)))
  }

  /**
   * Verbindungstest. Ohne Argument gegen den GESPEICHERTEN Stand (das ist der Punkt in der
   * Sidebar), mit `useDraft` gegen das, was gerade im Formular steht.
   */
  async function checkHealth({ useDraft = false } = {}) {
    state.healthChecking = true
    try {
      const src = useDraft ? state.draft : state.config
      const res = await api.botHealth(src ? { host: src.host, model: src.model, embedModel: src.embedModel } : {})
      state.health = res
      return res
    } catch (e) {
      // Der Endpunkt selbst ist nicht erreichbar (Backend weg) – das ist eine andere Aussage als
      // "Ollama ist aus", also steht sie auch anders da.
      state.health = { online: false, error: e?.message || 'The server did not answer', checkedAt: new Date().toISOString() }
      return state.health
    } finally {
      state.healthChecking = false
    }
  }

  async function loadModels(host = '') {
    state.modelsLoading = true
    try {
      const res = await api.botModels(host)
      state.models = res.models || []
      state.modelsError = res.error || ''
      return res
    } catch (e) {
      state.models = []
      state.modelsError = e?.message || 'The server did not answer'
      return null
    } finally {
      state.modelsLoading = false
    }
  }

  /**
   * Statuspunkt der Sidebar: einmal beim Start und danach im Ruhetakt. Nur wenn der Tab sichtbar
   * ist – ein Hintergrundfenster, das im Minutentakt einen Ollama-Server anpingt, ist Last ohne
   * Betrachter.
   */
  function startHealthWatch(intervalMs = 60_000) {
    if (healthTimer) return
    const tick = () => {
      if (document.visibilityState === 'visible') checkHealth().catch(() => {})
    }
    tick()
    healthTimer = setInterval(tick, intervalMs)
  }

  // Ampel fuer die Sidebar: grau = ungeprueft, rot = nicht erreichbar, gelb = erreichbar, aber das
  // eingestellte Modell liegt dort nicht (die Generierung schluege spaeter fehl), gruen = bereit.
  //
  // ⚠️ Das EMBEDDING-Modell faerbt hier bewusst NICHT mit, obwohl `health` es seit 4.26.2 mitprueft.
  // Die Bedeutungssuche ist optional (leeres Feld = aus), und ein gelber Punkt ueber einen bewusst
  // gewaehlten Zustand ist ein Daueralarm -- dasselbe Argument wie gegen die faerbende Ask-Zahl in
  // der Sidebar. Seine Auskunft steht an der Karte, die den Indexlauf ausloest (`BotEmbedIndex`).
  const status = computed(() => {
    if (!state.health) return 'unknown'
    if (!state.health.online) return 'offline'
    if (state.health.modelInstalled === false) return 'warn'
    return 'online'
  })

  const statusLabel = computed(() => {
    const h = state.health
    if (!h) return 'Connection not checked yet'
    if (!h.online) return h.error || 'Ollama is not reachable'
    if (h.modelInstalled === false) return `Ollama is up, but "${h.model}" is not pulled on the server`
    return `Ollama ${h.version || ''} · ${h.latencyMs} ms`.trim()
  })

  return {
    state,
    dirty,
    dirtyPaths,
    status,
    statusLabel,
    load,
    save,
    revert,
    resetPaths,
    setDefault,
    checkHealth,
    loadModels,
    startHealthWatch,
    getPath,
    setPath,
  }
}
