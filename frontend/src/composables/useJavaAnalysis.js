// Kapselt den SSE-Lebenszyklus der gestreamten KI-Analyse einer Java-Klasse.
// HTTP-Start/Cancel laufen ueber lib/api.js; der Stream selbst ueber EventSource (kein fetch).
// Pro Panel-Instanz eigener State (Fortschritt) -> daher eine Factory-Funktion.
//
// Realitaet auf dem Pi: ein Ollama-Call dauert ~40s+. Damit die UI nicht "eingefroren" wirkt,
// sendet das Backend Heartbeats; hier laufen zusaetzlich Schritt-/Gesamt-Timer, eine ETA und
// ein Stall-Watchdog. Echte Stream-Abbrueche werden NICHT mehr stillschweigend geschluckt.
import { ref, computed, onUnmounted } from 'vue'
import { api } from '../lib/api.js'

const STALL_MS = 15000 // kein Event (auch kein Heartbeat) so lange -> als haengend markieren

export function useJavaAnalysis() {
  const running = ref(false)      // laeuft ein Analyse-Lauf?
  const currentIndex = ref(-1)    // 0 = Klasse, 1..N = Methode (1-basiert), -1 = idle
  const total = ref(0)            // Anzahl Methoden
  const classDone = ref(false)
  const methodsDone = ref(0)
  const error = ref('')
  const stepElapsedMs = ref(0)    // Laufzeit des aktuellen Schritts
  const totalElapsedMs = ref(0)   // Gesamtlaufzeit des Laufs
  const stalled = ref(false)      // Watchdog: keine Antwort vom Server
  const cancelling = ref(false)   // Abbruch angefordert, noch nicht bestaetigt

  let es = null
  let ticker = null
  let stepStartedAt = 0
  let totalStartedAt = 0
  let lastEventAt = 0
  let finished = false            // all_done | cancelled -> es.onerror ist dann normal
  let cancelled = false
  const stepDurations = []

  // Grobe Restzeit-Schaetzung: verbleibende Schritte × bisheriger Schnitt (Fallback 45s).
  const etaMs = computed(() => {
    const steps = total.value + 1 // Klasse + N Methoden
    const completed = (classDone.value ? 1 : 0) + methodsDone.value
    const remaining = Math.max(0, steps - completed)
    const avg = stepDurations.length
      ? stepDurations.reduce((a, b) => a + b, 0) / stepDurations.length
      : 45000
    return remaining * avg
  })

  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null }
  }

  function tick() {
    const now = Date.now()
    totalElapsedMs.value = now - totalStartedAt
    if (currentIndex.value >= 0) stepElapsedMs.value = now - stepStartedAt
    if (running.value && !finished && now - lastEventAt > STALL_MS) stalled.value = true
  }

  // Jedes eingehende SSE-Event: Watchdog zuruecksetzen + Stall aufheben.
  function bump() {
    lastEventAt = Date.now()
    stalled.value = false
  }

  function close() {
    if (es) { es.close(); es = null }
    stopTicker()
  }

  // start() ruft ZUERST den POST (Backend resettet den Stream + startet die Queue),
  // DANN wird der SSE-Stream geoeffnet. Das ReplaySubject im Backend puffert fruehe Events,
  // sodass nichts verloren geht. Callbacks mergen die Inhalte in den Panel-State.
  async function start(articleId, { userContext, onClassDone, onMethodStart, onMethodDone } = {}) {
    error.value = ''
    running.value = true
    classDone.value = false
    methodsDone.value = 0
    currentIndex.value = 0
    stepElapsedMs.value = 0
    totalElapsedMs.value = 0
    stalled.value = false
    cancelling.value = false
    finished = false
    cancelled = false
    stepDurations.length = 0
    const now = Date.now()
    totalStartedAt = now
    stepStartedAt = now
    lastEventAt = now
    stopTicker()
    ticker = setInterval(tick, 1000)
    try {
      const res = await api.startJavaAnalysis(articleId, { userContext })
      total.value = res?.total ?? 0
      if (es) { es.close(); es = null }
      es = new EventSource(api.analysisStreamUrl(articleId))
      es.onmessage = (ev) => {
        let evt
        try { evt = JSON.parse(ev.data) } catch { return }
        bump()
        switch (evt.type) {
          case 'class_start':
            currentIndex.value = 0
            stepStartedAt = Date.now()
            stepElapsedMs.value = 0
            break
          case 'class_done':
            classDone.value = true
            stepDurations.push(Date.now() - stepStartedAt)
            onClassDone?.(evt.content, evt.aiGenerated)
            break
          case 'method_start':
            currentIndex.value = evt.index
            stepStartedAt = Date.now()
            stepElapsedMs.value = 0
            onMethodStart?.(evt.index)
            break
          case 'method_done':
            methodsDone.value++
            stepDurations.push(Date.now() - stepStartedAt)
            onMethodDone?.(evt.content, evt.aiGenerated)
            break
          case 'heartbeat':
            // Autoritative Server-Laufzeit des aktuellen Schritts.
            if (typeof evt.elapsedMs === 'number') stepElapsedMs.value = evt.elapsedMs
            break
          case 'all_done':
            finished = true
            running.value = false
            currentIndex.value = -1
            close()
            break
          case 'cancelled':
            finished = true
            cancelled = true
            running.value = false
            cancelling.value = false
            currentIndex.value = -1
            close()
            break
          case 'error':
            if (evt.message) error.value = evt.message
            break
        }
      }
      es.onerror = () => {
        // Sauberes Ende: Server schliesst den Stream nach all_done/cancelled.
        if (finished || cancelled) { close(); if (running.value) running.value = false; return }
        // Sonst echter Verbindungsverlust -> sichtbar machen, State fuer Retry behalten.
        error.value = 'Lost connection to the analysis stream.'
        stalled.value = true
        running.value = false
        close()
      }
    } catch (e) {
      error.value = e.message
      running.value = false
      currentIndex.value = -1
      stopTicker()
    }
  }

  // Laufenden Lauf abbrechen: Backend bricht den in-flight Ollama-Call ab und sendet 'cancelled'.
  async function cancel(articleId) {
    if (!running.value || cancelling.value) return
    cancelled = true
    cancelling.value = true
    try {
      await api.cancelJavaAnalysis(articleId)
    } catch (e) {
      // Abbruch trotzdem lokal vollziehen, falls der Request scheitert.
      finished = true
      running.value = false
      cancelling.value = false
      currentIndex.value = -1
      close()
    }
  }

  onUnmounted(close)

  return {
    running, currentIndex, total, classDone, methodsDone, error,
    stepElapsedMs, totalElapsedMs, stalled, cancelling, etaMs,
    start, cancel, close,
  }
}
