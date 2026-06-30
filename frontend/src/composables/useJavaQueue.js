// Client fuer die BACKEND-gehaltene KI-Generierungs-Queue der Java-Analyse.
// Der Queue-Zustand lebt im Server (Map<fileId, QueueJob>); hier wird er per HTTP-Polling
// (alle 3 s, KEIN WebSocket/SSE fuer den Status) gespiegelt. Dadurch laeuft die Queue weiter,
// auch wenn der Nutzer die Seite verlaesst – beim Zurueckkehren zeigt das Polling den Stand.
//
// ATOMARE EINHEIT pro Klasse: ein Job je fileId (Phase methods -> class). Es gibt also nur noch
// EINEN Eintrag pro Klasse statt getrennter Klassen-/Methoden-Jobs.
//
//   enqueueClass(file, {userContext, force}) -> volle Analyse-Einheit einreihen (Auto-Start + Button)
//   enqueueAllUnanalyzed({userContext})      -> alle unanalysierten Klassen (topologisch) einreihen
//   progressFor(fileId)                      -> reaktiver Fortschritt fuer Badges/Banner
//   markAllRead()                            -> abgeschlossene Eintraege ausblenden
//   lastEvent                                -> feuert bei Fortschritt -> Views laden Daten neu
import { reactive, ref } from 'vue'
import { api } from '../lib/api.js'

const POLL_MS = 3000

// Vollstaendige Job-Liste vom Backend (fuer die Queue-Anzeige + das Queue-Modal im Code-View).
const allJobs = ref([])
// Schnellzugriff fileId -> Job (1:1, da pro Klasse genau ein Job existiert).
const byFile = reactive({})
// Letztes Fortschritts-/Statusereignis -> JavaClassDetail laedt bei Aenderung neu.
const lastEvent = ref(null)
// Live-Token-Puffer je fileId: { text, tokens, phase }. Gespeist vom SSE-Strom (Token-by-Token).
// Polling bleibt Source of Truth fuer Status/Fortschritt.
const liveByKey = ref({})

let timer = null
let viewers = 0
let es = null // geteilte EventSource fuer den Live-Strom
// Merkt sich den letzten Stand pro fileId, um Aenderungen (done/status) zu erkennen.
const seen = new Map()

function hasActive() {
  return allJobs.value.some((j) => j.status === 'running' || j.status === 'queued')
}

async function refresh() {
  try {
    const jobs = await api.listJavaQueues()
    allJobs.value = jobs
    // byFile reaktiv aktualisieren (Schluessel synchronisieren).
    const map = {}
    for (const j of jobs) map[j.fileId] = j
    for (const k of Object.keys(byFile)) if (!map[k]) delete byFile[k]
    for (const fileId in map) byFile[fileId] = map[fileId]

    // Fortschritts-/Status-Aenderung erkennen -> lastEvent feuern.
    for (const j of jobs) {
      const sig = `${j.status}:${j.done}:${j.failed}`
      if (seen.get(j.fileId) !== sig) {
        seen.set(j.fileId, sig)
        lastEvent.value = { fileId: j.fileId, status: j.status, done: j.done, ts: Date.now() }
      }
    }
  } catch {
    // Netzwerkfehler -> stiller Retry beim naechsten Tick.
  } finally {
    // Stoppen, wenn niemand mehr zusieht UND nichts mehr laeuft.
    if (viewers <= 0 && !hasActive()) stopPolling()
  }
}

// Geteilten SSE-Strom oeffnen (genau eine EventSource). Liefert die Token-Deltas live (key=fileId).
function openLiveStream() {
  if (es) return
  try {
    es = new EventSource(api.javaQueueStreamUrl())
  } catch {
    es = null
    return
  }
  es.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!msg || msg.phase === 'heartbeat' || !msg.key) return
    const map = liveByKey.value
    if (msg.phase === 'start') {
      map[msg.key] = { text: '', tokens: 0, phase: 'running' }
    } else if (msg.phase === 'token') {
      const cur = map[msg.key] || { text: '', tokens: 0, phase: 'running' }
      map[msg.key] = {
        text: cur.text + (msg.delta || ''),
        tokens: msg.tokenCount ?? cur.tokens,
        phase: 'running',
      }
    } else if (msg.phase === 'done') {
      const cur = map[msg.key]
      if (cur) map[msg.key] = { ...cur, phase: 'done' }
    }
  }
  // Bei Verbindungsabbruch reconnectet EventSource selbst; nichts weiter zu tun.
  es.onerror = () => {}
}

function closeLiveStream() {
  if (es) {
    es.close()
    es = null
  }
  liveByKey.value = {}
}

function startPolling() {
  if (timer) return
  void refresh()
  timer = setInterval(refresh, POLL_MS)
  openLiveStream()
}

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  closeLiveStream()
}

// Komponente meldet sich als Beobachter an (onMounted) und gibt eine Release-Fn zurueck
// (onUnmounted). Solange Beobachter aktiv sind ODER Jobs laufen, wird gepollt.
function ensurePolling() {
  viewers++
  startPolling()
  let released = false
  return () => {
    if (released) return
    released = true
    viewers = Math.max(0, viewers - 1)
    if (viewers <= 0 && !hasActive()) stopPolling()
  }
}

function progressFor(fileId) {
  const job = byFile[fileId]
  if (!job) return null
  return {
    total: job.total,
    done: job.done,
    failed: job.failed,
    status: job.status,
    phase: job.phase,
    current: job.current,
    ollamaUnavailable: job.ollamaUnavailable,
  }
}

// Volle Analyse-Einheit einer Klasse einreihen (Methoden -> Klasse). `file` darf das File-Objekt
// (mit id) oder direkt die fileId sein. `force` erzwingt das Neu-Generieren analysierter Methoden.
async function enqueueClass(file, { userContext = '', force = false } = {}) {
  const id = typeof file === 'object' ? file?.id : file
  if (id == null) return
  startPolling()
  await api.queueJavaClass(id, { userContext, force })
  await refresh()
}

// Bulk: alle noch nicht analysierten Klassen (topologisch) einreihen. Gibt { queuedClasses }
// zurueck (fuer Inline-Feedback).
async function enqueueAllUnanalyzed({ userContext = '' } = {}) {
  startPolling()
  const res = await api.analyzeAllJava({ userContext })
  await refresh()
  return res
}

// Einzelnen Job abbrechen. Optimistisch sofort lokal entfernen (kein Warten auf das 3-s-Polling),
// damit Liste/Badge unmittelbar reagieren; das naechste Polling bestaetigt den Server-Zustand.
async function cancelJob(fileId) {
  await api.cancelJavaQueue(fileId)
  allJobs.value = allJobs.value.filter((j) => j.fileId !== fileId)
  delete byFile[fileId]
}

// Gesamte Queue abbrechen + leeren (aktive + abgeschlossene). Sofort lokal leeren.
async function cancelAllJobs() {
  await api.cancelAllJavaQueues()
  allJobs.value = []
  for (const k of Object.keys(byFile)) delete byFile[k]
}

// "Alle als gelesen markieren": abgeschlossene Eintraege ausblenden. Die Analyse-Ergebnisse
// bleiben in der DB; nur die transienten Queue-Eintraege verschwinden. Optimistisch lokal filtern.
async function markAllRead() {
  await api.clearFinishedJavaQueues()
  const done = ['done', 'done-with-errors', 'failed', 'cancelled']
  allJobs.value = allJobs.value.filter((j) => !done.includes(j.status))
  for (const k of Object.keys(byFile)) if (done.includes(byFile[k].status)) delete byFile[k]
}

export function useJavaQueue() {
  return {
    allJobs,
    lastEvent,
    liveByKey,
    enqueueClass,
    enqueueAllUnanalyzed,
    cancelJob,
    cancelAllJobs,
    markAllRead,
    progressFor,
    ensurePolling,
    refresh,
  }
}
