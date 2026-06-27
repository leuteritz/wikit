// Kapselt den SSE-Lebenszyklus der gestreamten KI-Analyse einer Java-Klasse.
// HTTP-Start laeuft ueber lib/api.js; der Stream selbst ueber EventSource (kein fetch).
// Pro Panel-Instanz eigener State (Fortschritt) -> daher eine Factory-Funktion.
import { ref, onUnmounted } from 'vue'
import { api } from '../lib/api.js'

export function useJavaAnalysis() {
  const running = ref(false)      // laeuft ein Analyse-Lauf?
  const currentIndex = ref(-1)    // 0 = Klasse, 1..N = Methode (1-basiert), -1 = idle
  const total = ref(0)            // Anzahl Methoden
  const classDone = ref(false)
  const methodsDone = ref(0)
  const error = ref('')

  let es = null

  function close() {
    if (es) { es.close(); es = null }
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
    try {
      const res = await api.startJavaAnalysis(articleId, { userContext })
      total.value = res?.total ?? 0
      close()
      es = new EventSource(api.analysisStreamUrl(articleId))
      es.onmessage = (ev) => {
        let evt
        try { evt = JSON.parse(ev.data) } catch { return }
        switch (evt.type) {
          case 'class_start': currentIndex.value = 0; break
          case 'class_done':
            classDone.value = true
            onClassDone?.(evt.content)
            break
          case 'method_start':
            currentIndex.value = evt.index
            onMethodStart?.(evt.index)
            break
          case 'method_done':
            methodsDone.value++
            onMethodDone?.(evt.content)
            break
          case 'all_done':
            running.value = false
            currentIndex.value = -1
            close()
            break
          case 'error':
            if (evt.message) error.value = evt.message
            break
        }
      }
      es.onerror = () => {
        // Server schliesst den Stream nach all_done -> normales Ende; nur aufraeumen.
        close()
        if (running.value) running.value = false
      }
    } catch (e) {
      error.value = e.message
      running.value = false
      currentIndex.value = -1
    }
  }

  onUnmounted(close)

  return { running, currentIndex, total, classDone, methodsDone, error, start, close }
}
