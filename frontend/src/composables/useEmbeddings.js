// Stand des Bedeutungsindex – GETEILTER Store (Modul-Singleton), wie `useInsights`.
//
// Warum geteilt: die Zahl neben „Ask" in der Sidebar und die Karte in `/bot` beantworten dieselbe
// Frage („worauf kann Ask antworten?"). Lägen sie in zwei lokalen Refs, zeigte die Sidebar nach
// einem Indexlauf noch den alten Stand, während die Karte daneben den neuen zeigt – zwei Wahrheiten
// über denselben Index. Wer schreibt (`BotEmbedIndex.build`), lädt hier neu, und beide ziehen mit.
//
// ⚠️ **Es sind ZWEI Indizes und EINE Bilanz.** Seit `/ask` auch die Wiki-Artikel liest, gibt es
// `/java/embeddings` und `/articles/embeddings` – aber „worauf kann Ask antworten?" ist eine Frage
// mit einer Antwort. Die Summe entsteht deshalb hier, nicht in der Sidebar und in der Karte
// getrennt: zwei Additionen derselben Zahlen wären zwei Gelegenheiten, sie verschieden zu bilden.
// Die Einzelstände (`java`, `articles`) bleiben daneben stehen – die Karte in `/bot` zeigt, welcher
// der beiden noch etwas zu tun hat, und dort ist das die eigentliche Auskunft.
import { computed, ref } from 'vue'
import { api } from '../lib/api.js'

const java = ref(null)
const articles = ref(null)
const loading = ref(false)
let inFlight = null

/** Summe zweier Stände über ein Zahlenfeld – fehlt eine Seite, zählt sie als nichts. */
const sum = (key) => (java.value?.[key] ?? 0) + (articles.value?.[key] ?? 0)

async function load() {
  // Mehrfachaufrufe (Sidebar beim Start, Bot-Karte beim Öffnen) teilen sich eine Anfrage: der
  // Status liest bei tausend Klassen die halbe Datenbank, und zweimal parallel wäre er zweimal
  // teuer für dieselbe Auskunft.
  if (inFlight) return inFlight
  loading.value = true
  inFlight = (async () => {
    // Nebeneinander, nicht nacheinander: zwei unabhängige Auskünfte über zwei Tabellen. Und
    // einzeln aufgefangen – ein fehlender Artikel-Stand darf die Klassenzahl nicht mitreißen.
    const [j, a] = await Promise.all([
      api.getJavaEmbeddingStatus().catch(() => null),
      api.getArticleEmbeddingStatus().catch(() => null),
    ])
    java.value = j
    articles.value = a
    loading.value = false
    inFlight = null
    return { java: j, articles: a }
  })()
  return inFlight
}

export function useEmbeddings() {
  return {
    /** Die beiden Einzelstände – für die Karte in `/bot`, die je Seite sagt, was zu tun ist. */
    java,
    articles,
    loading,
    /** Ist überhaupt schon nachgesehen worden? Ohne das wäre jede 0 unten eine Behauptung. */
    known: computed(() => !!(java.value || articles.value)),
    /** Wie viele Quellen die Bedeutungssuche beantworten kann. `null` = noch nichts geladen. */
    indexed: computed(() => (java.value || articles.value ? sum('indexed') : null)),
    /** Wie viele es insgesamt sein könnten (Klassen + Artikel). */
    total: computed(() => (java.value || articles.value ? sum('total') : null)),
    /** Was ein Lauf zu tun hätte – veraltet plus nie indiziert, über beide Bestände. */
    todo: computed(() => sum('stale') + sum('missing')),
    /** Gibt es überhaupt etwas zu durchsuchen? Ein halb gefüllter Index ist nutzbar. */
    ready: computed(() => !!(java.value?.ready || articles.value?.ready)),
    /** Modell gesetzt? Ohne eines ist die Bedeutungssuche aus – und mit ihr `/ask`. */
    enabled: computed(() => !!(java.value?.enabled ?? articles.value?.enabled)),
    /** Das gemeinsame Modell beider Indizes – sie müssen dasselbe benutzen (s. schema.ts). */
    model: computed(() => java.value?.model || articles.value?.model || ''),
    load,
    /** Einmal laden, wenn noch nichts da ist. Mehrfach aufzurufen ist folgenlos. */
    ensure: () => (java.value || articles.value ? Promise.resolve({ java: java.value, articles: articles.value }) : load()),
  }
}
