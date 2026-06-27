// Client fuer die BACKEND-gehaltene KI-Generierungs-Queue der Java-Analyse.
// Der Queue-Zustand lebt im Server (Map<fileId, QueueJob>); hier wird er per HTTP-Polling
// (alle 3 s, KEIN WebSocket/SSE) gespiegelt. Dadurch laeuft die Queue weiter, auch wenn der
// Nutzer die Seite verlaesst – beim Zurueckkehren zeigt das Polling den aktuellen Stand.
//
// Oeffentliche API bleibt kompatibel zur frueheren (client-seitigen) Implementierung:
//   enqueueClass(file, {userContext})  -> reiht alle Methoden ein (Auto-Start nach Upload)
//   progressFor(fileId)                -> reaktiver Fortschritt fuer Badges/Banner
//   lastEvent                          -> feuert bei Fortschritt -> Views laden Daten neu
// Neu: enqueueMethods/queueClass (explizite Buttons), allJobs (Statusseite), ensurePolling().
import { reactive, ref } from 'vue'
import { api } from '../lib/api.js'

const POLL_MS = 3000

// Vollstaendige Job-Liste vom Backend (fuer /java/queues).
const allJobs = ref([])
// Schnellzugriff fileId -> repraesentativer Job (laufende Queue bevorzugt).
const byFile = reactive({})
// Letztes Fortschritts-/Statusereignis -> JavaClassDetail laedt bei Aenderung neu.
const lastEvent = ref(null)

let timer = null
let viewers = 0
// Merkt sich den letzten Stand pro fileId, um Aenderungen (done/status) zu erkennen.
const seen = new Map()

function hasActive() {
  return allJobs.value.some((j) => j.status === 'running' || j.status === 'queued')
}

// Aus der flachen Job-Liste je Datei einen repraesentativen Job ableiten
// (laufende/wartende Queue bevorzugt, sonst die zuletzt eingereihte).
function indexByFile(jobs) {
  const map = {}
  for (const j of jobs) {
    const prev = map[j.fileId]
    if (!prev) {
      map[j.fileId] = j
      continue
    }
    const prevActive = prev.status === 'running' || prev.status === 'queued'
    const curActive = j.status === 'running' || j.status === 'queued'
    if (curActive && !prevActive) map[j.fileId] = j
    else if (curActive === prevActive && j.queuedAt > prev.queuedAt) map[j.fileId] = j
  }
  return map
}

async function refresh() {
  try {
    const jobs = await api.listJavaQueues()
    allJobs.value = jobs
    const map = indexByFile(jobs)
    // byFile reaktiv aktualisieren (Schluessel synchronisieren).
    for (const k of Object.keys(byFile)) if (!map[k]) delete byFile[k]
    for (const fileId in map) byFile[fileId] = map[fileId]

    // Fortschritts-/Status-Aenderung erkennen -> lastEvent feuern.
    for (const j of jobs) {
      const sig = `${j.status}:${j.done}:${j.failed}`
      if (seen.get(j.fileId + ':' + j.kind) !== sig) {
        seen.set(j.fileId + ':' + j.kind, sig)
        lastEvent.value = { fileId: j.fileId, kind: j.kind, status: j.status, done: j.done, ts: Date.now() }
      }
    }
  } catch {
    // Netzwerkfehler -> stiller Retry beim naechsten Tick.
  } finally {
    // Stoppen, wenn niemand mehr zusieht UND nichts mehr laeuft.
    if (viewers <= 0 && !hasActive()) stopPolling()
  }
}

function startPolling() {
  if (timer) return
  void refresh()
  timer = setInterval(refresh, POLL_MS)
}

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
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
    current: job.current,
    ollamaUnavailable: job.ollamaUnavailable,
  }
}

// Alle Methoden einer Datei einreihen (Name aus Kompatibilitaet beibehalten: Auto-Start
// nach Upload reiht weiterhin die Methoden-Queue ein).
async function enqueueClass(file, { userContext = '' } = {}) {
  if (!file?.id) return
  startPolling()
  await api.queueJavaMethods(file.id, { userContext })
  await refresh()
}

// Explizit: nur Klassen-Zusammenfassung einreihen.
async function queueClass(fileId, { userContext = '' } = {}) {
  startPolling()
  await api.queueJavaClass(fileId, { userContext })
  await refresh()
}

// Explizit: alle Methoden einreihen.
async function enqueueMethods(fileId, { userContext = '' } = {}) {
  startPolling()
  await api.queueJavaMethods(fileId, { userContext })
  await refresh()
}

// Einzelnen Job abbrechen. Optimistisch sofort lokal entfernen (kein Warten auf das 3-s-Polling),
// damit die Liste/Badge unmittelbar reagiert; das naechste Polling bestaetigt den Server-Zustand.
async function cancelJob(fileId, kind) {
  await api.cancelJavaQueue(fileId, kind)
  allJobs.value = allJobs.value.filter((j) => !(j.fileId === fileId && j.kind === kind))
  // byFile auf die verbleibenden Jobs dieser Datei neu ableiten (oder Key entfernen).
  const rest = allJobs.value.filter((j) => j.fileId === fileId)
  if (rest.length) Object.assign(byFile, indexByFile(rest))
  else delete byFile[fileId]
}

// Gesamte Queue abbrechen + leeren (aktive + abgeschlossene). Sofort lokal leeren.
async function cancelAllJobs() {
  await api.cancelAllJavaQueues()
  allJobs.value = []
  for (const k of Object.keys(byFile)) delete byFile[k]
}

export function useJavaQueue() {
  return {
    allJobs,
    lastEvent,
    enqueueClass,
    enqueueMethods,
    queueClass,
    cancelJob,
    cancelAllJobs,
    progressFor,
    ensurePolling,
    refresh,
  }
}
