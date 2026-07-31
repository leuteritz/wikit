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

// Ab dieser Job-Zahl wird die VOLLE Liste nicht mehr dauerhaft mitgepollt, sondern nur noch die
// kompakte Summary – die Liste holt dann nur, wer sie wirklich anzeigt (Queue-Modal meldet sich
// per ensurePolling({ detail: true }) an). Grund: bei 1000 eingereihten Klassen ist eine Antwort
// von GET /java/queues ~390 KB und kostet den Server knapp eine Sekunde – alle 3 s.
const LIST_LIMIT = 250

// Endzustaende eines Queue-Jobs (Server-Vokabular aus java-queue.service.ts `DONE_STATES`).
// Einzige Quelle im Frontend: `markAllRead` hier, die Header-Zaehler in CodeView und die
// Sortierung/Icons im JavaQueueModal lasen die Liste vorher jeweils aus einer eigenen Kopie.
const FINISHED_STATES = ['done', 'done-with-errors', 'failed', 'cancelled']
export const isFinishedStatus = (status) => FINISHED_STATES.includes(status)

// Vollstaendige Job-Liste vom Backend (fuer die Queue-Anzeige + das Queue-Modal im Code-View).
// Kann bei sehr grossen Queues leer sein – dann traegt `summary` die Anzeige (s. LIST_LIMIT).
const allJobs = ref([])
// Kompakte Gesamtbilanz: { total, queued, running, done, failed, finished, unitsTotal, unitsDone,
// msPerUnit, etaMs, current }. Immer aktuell, unabhaengig davon, ob die Liste geladen wird.
const summary = ref(null)
// Schnellzugriff fileId -> Job (1:1, da pro Klasse genau ein Job existiert).
const byFile = reactive({})
// Letztes Fortschritts-/Statusereignis -> JavaClassDetail laedt bei Aenderung neu.
const lastEvent = ref(null)
// Live-Token-Puffer je fileId: { text, tokens, phase }. Gespeist vom SSE-Strom (Token-by-Token).
// Polling bleibt Source of Truth fuer Status/Fortschritt.
const liveByKey = ref({})

let timer = null
let viewers = 0
let detailViewers = 0 // Beobachter, die die VOLLE Job-Liste brauchen (Queue-Modal)
let es = null // geteilte EventSource fuer den Live-Strom
// Merkt sich den letzten Stand pro fileId, um Aenderungen (done/status) zu erkennen.
const seen = new Map()
let lastSummarySig = ''

function hasActive() {
  const s = summary.value
  if (s) return s.queued > 0 || s.running > 0
  return allJobs.value.some((j) => j.status === 'running' || j.status === 'queued')
}

// Volle Liste in allJobs/byFile spiegeln.
function applyJobs(jobs) {
  allJobs.value = jobs
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
}

async function refresh() {
  try {
    // Immer zuerst die billige Bilanz – sie entscheidet, ob die Liste ueberhaupt noetig ist.
    const s = await api.getJavaQueueSummary()
    summary.value = s

    const wantList = detailViewers > 0 || s.total <= LIST_LIMIT
    if (wantList) {
      applyJobs(await api.listJavaQueues())
    } else if (allJobs.value.length) {
      // Keine Liste mehr -> alte Eintraege verwerfen, damit nirgends veraltete Badges stehen.
      allJobs.value = []
      for (const k of Object.keys(byFile)) delete byFile[k]
      seen.clear()
    }

    // Auch ohne Liste muss sich etwas ruehren: Bewegung in der Bilanz -> lastEvent (Detailansichten
    // laden dann neu). fileId kommt vom gerade laufenden Job.
    const sig = `${s.finished}:${s.unitsDone}:${s.current?.fileId ?? ''}`
    if (!wantList && sig !== lastSummarySig) {
      lastSummarySig = sig
      lastEvent.value = { fileId: s.current?.fileId ?? null, status: 'running', done: s.unitsDone, ts: Date.now() }
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
// `detail: true` fordert zusaetzlich die volle Job-Liste an (Queue-Modal). Ohne das Flag wird bei
// grossen Queues nur die Bilanz gepollt.
function ensurePolling({ detail = false } = {}) {
  viewers++
  if (detail) {
    detailViewers++
    void refresh() // sofort nachladen, nicht erst beim naechsten Tick
  }
  startPolling()
  let released = false
  return () => {
    if (released) return
    released = true
    viewers = Math.max(0, viewers - 1)
    if (detail) detailViewers = Math.max(0, detailViewers - 1)
    if (viewers <= 0 && !hasActive()) stopPolling()
  }
}

// EINMAL nachsehen, ob im Server noch etwas laeuft – und nur dann das Polling starten.
// Fuer die Sidebar-Anzeige: nach einem Reload (oder wenn die App auf einer anderen Ansicht
// startet) weiss der Client sonst nichts von einer laufenden Queue, bis jemand die Code-Ansicht
// oeffnet. Bewusst KEIN `ensurePolling()` an dieser Stelle: das haelt einen Dauer-Beobachter und
// wuerde bis in alle Ewigkeit alle 3 s fragen, auch wenn nie wieder etwas laeuft. `refresh()`
// stoppt sich dagegen selbst, sobald nichts mehr aktiv ist und niemand zusieht.
async function probe() {
  await refresh()
  if (hasActive()) startPolling()
}

function progressFor(fileId) {
  const job = byFile[fileId]
  if (job) {
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
  // Ohne Detailliste (grosse Queue) bleibt wenigstens der gerade laufende Job auskunftsfaehig.
  const cur = summary.value?.current
  if (cur && cur.fileId === fileId) {
    return {
      total: cur.total,
      done: cur.done,
      failed: 0,
      status: 'running',
      phase: cur.phase,
      current: cur.current,
      ollamaUnavailable: false,
    }
  }
  return null
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

// Bulk nach einem Paste: genau diese Klassen einreihen – EIN Request. Frueher lief das als
// enqueueClass() je Klasse (plus je ein Nachladen der gesamten Queue-Liste); bei 1000 Klassen
// summierte sich das auf Minuten, in denen die Oberflaeche blockiert war.
async function enqueueMany(fileIds, { userContext = '' } = {}) {
  const ids = (fileIds || []).map((f) => (typeof f === 'object' ? f?.id : f)).filter((id) => id != null)
  if (!ids.length) return { queuedClasses: 0 }
  startPolling()
  const res = await api.queueJavaBatch(ids, { userContext })
  await refresh()
  return res
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
  summary.value = null
  for (const k of Object.keys(byFile)) delete byFile[k]
}

// "Alle als gelesen markieren": abgeschlossene Eintraege ausblenden. Die Analyse-Ergebnisse
// bleiben in der DB; nur die transienten Queue-Eintraege verschwinden. Optimistisch lokal filtern.
async function markAllRead() {
  await api.clearFinishedJavaQueues()
  allJobs.value = allJobs.value.filter((j) => !isFinishedStatus(j.status))
  for (const k of Object.keys(byFile)) if (isFinishedStatus(byFile[k].status)) delete byFile[k]
}

export function useJavaQueue() {
  return {
    allJobs,
    summary,
    lastEvent,
    liveByKey,
    enqueueClass,
    enqueueMany,
    enqueueAllUnanalyzed,
    cancelJob,
    cancelAllJobs,
    markAllRead,
    progressFor,
    ensurePolling,
    refresh,
    probe,
  }
}
