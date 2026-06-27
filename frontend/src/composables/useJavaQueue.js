// Persistente KI-Queue fuer die Java-Analyse (kein Pinia, kein Worker).
// Verarbeitet die Methoden einer hochgeladenen Klasse SEQUENZIELL (eine Anfrage gleichzeitig)
// via POST /java/methods/:id/summarize. Fortschritt ist reaktiv -> Badge in der Klassenliste.
//
// Persistenz: best-effort ueber localStorage (try/catch). Ist localStorage nicht verfuegbar
// (Dev-Sandbox/Privatmodus), laeuft die Queue rein In-Memory weiter.
import { reactive, ref } from 'vue'
import { api } from '../lib/api.js'

const STORAGE_KEY = 'wikit-java-queue'

// fileId -> { fileId, className, userContext, total, done, failed, status, methods: [{id,name,status}] }
const state = reactive({ jobs: {} })
// Letztes abgeschlossenes Method-Event -> Views koennen darauf reagieren (z. B. Detail neu laden).
const lastEvent = ref(null)

let processing = false
let restored = false

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.jobs))
  } catch {
    /* localStorage nicht verfuegbar -> nur In-Memory */
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const jobs = JSON.parse(raw)
    for (const fileId in jobs) {
      const job = jobs[fileId]
      // 'running' beim Wiederherstellen auf 'pending' zuruecksetzen (Lauf wurde unterbrochen).
      for (const m of job.methods || []) if (m.status === 'running') m.status = 'pending'
      job.status = (job.methods || []).some((m) => m.status === 'pending') ? 'pending' : job.status
      state.jobs[fileId] = job
    }
  } catch {
    /* defekter/leerer State -> ignorieren */
  }
}

function ensureRestored() {
  if (restored) return
  restored = true
  restore()
}

function progressFor(fileId) {
  const job = state.jobs[fileId]
  if (!job) return null
  return { total: job.total, done: job.done, failed: job.failed, status: job.status }
}

function recomputeStatus(job) {
  if (job.methods.some((m) => m.status === 'pending' || m.status === 'running')) return
  job.status = job.failed ? 'done-with-errors' : 'done'
}

function nextPending() {
  for (const fileId in state.jobs) {
    const job = state.jobs[fileId]
    const method = job.methods.find((m) => m.status === 'pending')
    if (method) return { job, method }
  }
  return null
}

async function process() {
  if (processing) return
  processing = true
  try {
    let item
    while ((item = nextPending())) {
      const { job, method } = item
      method.status = 'running'
      job.status = 'running'
      persist()
      try {
        await api.summarizeJavaMethod(method.id, { userContext: job.userContext })
        method.status = 'done'
        job.done++
      } catch {
        // Netzwerkfehler etc. -> Methode als fehlgeschlagen markieren, Queue laeuft weiter.
        method.status = 'failed'
        job.failed++
      }
      lastEvent.value = { fileId: job.fileId, methodId: method.id, status: method.status, ts: Date.now() }
      recomputeStatus(job)
      persist()
    }
  } finally {
    processing = false
  }
}

// Alle Methoden einer frisch analysierten Klasse einreihen und sofort abarbeiten.
function enqueueClass(file, { userContext = '' } = {}) {
  ensureRestored()
  const methods = (file.methods || []).map((m) => ({ id: m.id, name: m.method_name, status: 'pending' }))
  state.jobs[file.id] = {
    fileId: file.id,
    className: file.class_name,
    userContext,
    total: methods.length,
    done: 0,
    failed: 0,
    status: methods.length ? 'pending' : 'done',
    methods,
  }
  persist()
  process()
}

export function useJavaQueue() {
  ensureRestored()
  // Offene Jobs aus einer frueheren Session sofort fortsetzen.
  if (!processing && nextPending()) process()
  return {
    jobs: state.jobs,
    lastEvent,
    enqueueClass,
    progressFor,
  }
}
