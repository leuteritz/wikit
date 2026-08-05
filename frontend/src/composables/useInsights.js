// Der Zustand des Insights-Bereichs – und die Quelle, aus der auch `/code` seine Kennzahlen liest.
//
// Warum ein geteilter Store und kein Laden je Ansicht: die Antwort beschreibt DENSELBEN Graphen,
// den der Code-Graph zeichnet. Zweimal geladen hiesse zwei Staende, und dann faerbte der Graph
// nach Zahlen, die die Rangliste nebenan nicht mehr kennt.
//
// Geladen wird auf Verlangen (`ensure`), nicht beim Start: wer nie nach Kennzahlen fragt, soll
// dafuer auch nicht zahlen. `reload()` ist der ausdrueckliche Nachschlag nach einem Import.
import { computed, ref } from 'vue'
import { api } from '../lib/api.js'

// Module-Singleton -> alle Konsumenten teilen sich denselben Stand.
const data = ref(null)
const loading = ref(false)
const loadedAt = ref(0)
let inflight = null

async function load() {
  // Zwei Ansichten koennen gleichzeitig fragen (Graph und Bericht) – die zweite haengt sich an die
  // laufende Anfrage, statt eine zweite zu stellen.
  if (inflight) return inflight
  loading.value = true
  inflight = api
    .getInsights()
    .then((res) => {
      data.value = res
      loadedAt.value = Date.now()
      return res
    })
    .finally(() => {
      loading.value = false
      inflight = null
    })
  return inflight
}

export function useInsights() {
  // Kennzahlen je Datei-Id: der Graph fragt pro Karte, und eine lineare Suche ueber tausend
  // Klassen bei jedem Neuzeichnen waere genau die Art von Kosten, die man im Bild spuert.
  const byFileId = computed(() => {
    const map = new Map()
    for (const c of data.value?.classes || []) map.set(c.id, c)
    return map
  })

  const byPackage = computed(() => {
    const map = new Map()
    for (const p of data.value?.packages || []) map.set(p.path, p)
    return map
  })

  // Klassen, die in einem Zyklus stecken – als Menge, weil der Graph sie je Karte abfragt.
  const cycleFileIds = computed(() => {
    const set = new Set()
    for (const c of data.value?.classes || []) if (c.cycle != null) set.add(c.id)
    return set
  })

  return {
    data,
    loading,
    loadedAt,
    byFileId,
    byPackage,
    cycleFileIds,
    totals: computed(() => data.value?.totals || null),
    /** Einmal laden, wenn noch nichts da ist. Mehrfach aufzurufen ist folgenlos. */
    ensure: () => (data.value ? Promise.resolve(data.value) : load()),
    /** Ausdruecklich neu rechnen lassen (nach Import, Kanten-Neuberechnung, Loeschen). */
    reload: load,
    /**
     * Nach einem Schreibvorgang: nur nachziehen, was schon jemand angesehen hat.
     *
     * Der Unterschied zu `reload()` ist die Kostenfrage. Wer importiert, ohne je auf Kennzahlen
     * geschaut zu haben, soll dafuer keinen Lauf ueber den ganzen Graphen bezahlen; wer den
     * Farbmodus offen hat, darf dagegen nicht auf Zahlen von vor dem Import schauen.
     */
    refreshIfLoaded: () => (data.value ? load() : Promise.resolve(null)),
    /** Nach einem Komplett-Reset gibt es nichts mehr zu zeigen. */
    clear: () => {
      data.value = null
      loadedAt.value = 0
    },
  }
}
