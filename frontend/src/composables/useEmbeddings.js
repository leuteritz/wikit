// Stand des Bedeutungsindex – GETEILTER Store (Modul-Singleton), wie `useInsights`.
//
// Warum geteilt: die Zahl neben „Ask" in der Sidebar und die Karte in `/bot` beantworten dieselbe
// Frage („worauf kann Ask antworten?"). Lägen sie in zwei lokalen Refs, zeigte die Sidebar nach
// einem Indexlauf noch den alten Stand, während die Karte daneben den neuen zeigt – zwei Wahrheiten
// über denselben Index. Wer schreibt (`BotEmbedIndex.build`), lädt hier neu, und beide ziehen mit.
import { computed, ref } from 'vue'
import { api } from '../lib/api.js'

const status = ref(null)
const loading = ref(false)
let inFlight = null

async function load() {
  // Mehrfachaufrufe (Sidebar beim Start, Bot-Karte beim Öffnen) teilen sich eine Anfrage: der
  // Status liest bei tausend Klassen die halbe Datenbank, und zweimal parallel wäre er zweimal
  // teuer für dieselbe Auskunft.
  if (inFlight) return inFlight
  loading.value = true
  inFlight = (async () => {
    try {
      status.value = await api.getJavaEmbeddingStatus()
    } catch {
      // Nicht erreichbar ist kein Fehler mit Meldung: die Zahl entfällt dann einfach (`silent` im
      // Client), und die Ansicht sagt an ihrer Stelle, was fehlt.
      status.value = null
    } finally {
      loading.value = false
      inFlight = null
    }
    return status.value
  })()
  return inFlight
}

export function useEmbeddings() {
  return {
    status,
    loading,
    /** Wie viele Klassen die Bedeutungssuche beantworten kann. `null` = noch nichts geladen. */
    indexed: computed(() => status.value?.indexed ?? null),
    /** Gibt es überhaupt etwas zu durchsuchen? Ein halb gefüllter Index ist nutzbar. */
    ready: computed(() => !!status.value?.ready),
    /** Modell gesetzt? Ohne eines ist die Bedeutungssuche aus – und mit ihr `/ask`. */
    enabled: computed(() => !!status.value?.enabled),
    load,
    /** Einmal laden, wenn noch nichts da ist. Mehrfach aufzurufen ist folgenlos. */
    ensure: () => (status.value ? Promise.resolve(status.value) : load()),
  }
}
