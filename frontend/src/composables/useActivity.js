// EINE Quelle fuer die Frage „laeuft gerade etwas Langes?" – und damit fuer jede Anzeige, die sie
// beantwortet (Sidebar-Karte, Fortschrittsring im Import-Modal, Chip in der Kopfzeile).
//
// Vorher lag dieser Apparat komplett IN `CodeView.vue`: Phasen, Uhr, Prozent, Restzeit. Das war
// richtig, solange man den Lauf nur dort sehen konnte – nur laeuft er auf dem Server weiter, wenn
// man die Ansicht wechselt. Sichtbar war er danach nirgends mehr, und beim Zurueckkommen in die
// Code-Ansicht auch nicht wieder: die Komponente wird neu montiert, `progress` beginnt bei null,
// waehrend der Import noch minutenlang durchlaeuft. Genau deshalb liegt der Zustand jetzt hier
// (Modul-Singleton, wie jeder andere Zustand in diesem Projekt – kein Pinia).
//
// Zwei Herkuenfte, bewusst getrennt gehalten:
//   `run`   – ein SSE-Lauf (Import / Reset / Kanten neu berechnen). Genau EINER zur Zeit, weil
//             alle drei dieselbe Codebasis umschreiben.
//   `queue` – die KI-Queue. Abgeleitet aus `useJavaQueue().summary` (Polling, kein SSE) und
//             deshalb NICHT gespiegelt: eine Kopie waere ein zweiter Stand, der dem echten
//             hinterherlaeuft.
// Beide koennen gleichzeitig laufen (nach einem Import reiht CodeView die neuen Klassen ein),
// darum zeigt die Karte beide statt eines von beiden zu verschweigen.
import { ref, computed } from 'vue'
import { api } from '../lib/api.js'
import { useJavaQueue } from './useJavaQueue.js'

// --- Phasen ------------------------------------------------------------------------------------
// Die Gewichte sind GEMESSENE Zeitanteile, keine Schaetzung, und `unit` sagt, was der Zaehler in
// dieser Phase ueberhaupt zaehlt (je Phase etwas anderes).
//
// Gemessen ueber den SSE-Strom, 1200 Klassen auf einer Entwicklungsmaschine:
// Erst-Import  split 0 % · parse 35 % · check 2 % · save 20 % · edges 40 %
// inkrementell (50 neue Klassen in 1250)      parse 8 % · check 3 % · save 16 % · edges 67 %
//
// Die Kantenphase dominiert in BEIDEN Faellen: sie laeuft ueber ALLE Klassen der Codebasis, nicht
// nur ueber die neuen. Wer an `recomputeAutoEdges` etwas aendert, das Zeit kostet, misst neu.
export const IMPORT_PHASES = [
  { key: 'split', label: 'Splitting sources', weight: 0.02, unit: 'sections' },
  { key: 'parse', label: 'Parsing classes', weight: 0.33, unit: 'classes' },
  { key: 'check', label: 'Checking duplicates', weight: 0.03, unit: 'classes' },
  { key: 'save', label: 'Writing to database', weight: 0.2, unit: 'classes' },
  { key: 'edges', label: 'Computing call edges', weight: 0.42, unit: 'classes scanned' },
]
// Der Komplett-Reset laeuft durch denselben Apparat, hat aber eigene Phasen.
export const RESET_PHASES = [
  { key: 'delete', label: 'Removing classes', weight: 0.85, unit: 'classes' },
  { key: 'edges', label: 'Clearing edges', weight: 0.15, unit: 'classes scanned' },
]
// Die Neuberechnung meldet nur die Kantenphase – sie IST der Lauf.
export const EDGE_PHASES = [
  { key: 'edges', label: 'Computing call edges', weight: 1, unit: 'classes scanned' },
]

// Was der Nutzer sieht, je Art des Laufs. `first` ist die Phase, mit der die Anzeige startet:
// bis das erste Server-Ereignis eintrifft, vergehen bei einem grossen Paste Sekunden, und eine
// leere Karte in dieser Zeit sieht aus wie „nichts passiert".
const KINDS = {
  import: { phases: IMPORT_PHASES, title: 'Importing code', icon: 'lucide:database', first: 'split' },
  reset: { phases: RESET_PHASES, title: 'Deleting all data', icon: 'lucide:trash-2', first: 'delete' },
  edges: { phases: EDGE_PHASES, title: 'Recomputing edges', icon: 'lucide:git-branch', first: 'edges' },
}

// --- Zustand -----------------------------------------------------------------------------------
const run = ref(null) // { kind, progress: { phase, done, total }, phaseStartedAt }
// Ergebnis des letzten Laufs, kurz stehen gelassen: wer beim Abschluss nicht hinsah, erfaehrt ihn
// sonst gar nicht – das Ergebnis-Toast erscheint dort, wo der Lauf gestartet wurde, und das ist
// genau die Ansicht, die man verlassen hat.
const result = ref(null) // { kind, ok, message }
const elapsedMs = ref(0)

const RESULT_LINGER_MS = 6000
let runStartedAt = 0
let elapsedTimer = null
let resultTimer = null

// --- Uhr ---------------------------------------------------------------------------------------
// Sie tickt genau einmal fuer die ganze App. Vorher lief sie in jeder Komponente, die eine Dauer
// anzeigte (dieselbe Begruendung wie bei `BusyState`).
function startClock() {
  runStartedAt = Date.now()
  elapsedMs.value = 0
  clearInterval(elapsedTimer)
  // 250 ms: fluessig genug fuer eine Sekundenanzeige, ohne unnoetige Renders.
  elapsedTimer = setInterval(() => (elapsedMs.value = Date.now() - runStartedAt), 250)
}
function stopClock() {
  clearInterval(elapsedTimer)
  elapsedTimer = null
}

// --- Lauf melden -------------------------------------------------------------------------------
function begin(kind) {
  clearTimeout(resultTimer)
  result.value = null
  startClock()
  run.value = {
    kind,
    progress: { phase: KINDS[kind]?.first || 'split', done: 0, total: 0 },
    phaseStartedAt: Date.now(),
  }
}

// Fortschrittsereignis uebernehmen und den Phasenwechsel stempeln (Basis der Zeit-Interpolation in
// Phasen, die keinen Zaehler liefern koennen).
function report(ev) {
  const cur = run.value
  if (!cur || !ev || ev.phase === 'heartbeat') return
  if (ev.phase !== cur.progress?.phase) cur.phaseStartedAt = Date.now()
  cur.progress = ev
}

function end({ kind, ok = true, message = '' } = {}) {
  stopClock()
  run.value = null
  if (!message) {
    result.value = null
    return
  }
  result.value = { kind, ok, message }
  clearTimeout(resultTimer)
  resultTimer = setTimeout(() => (result.value = null), RESULT_LINGER_MS)
}

// Ergebnis von Hand wegnehmen (die Karte hat kein ×, aber ein neuer Lauf soll den alten Stand
// nicht erben – `begin` raeumt es ebenfalls weg).
function clearResult() {
  clearTimeout(resultTimer)
  result.value = null
}

/**
 * Einen serverseitigen Lauf ausfuehren UND dabei anzeigen. Kapselt das Muster, das vorher an drei
 * Stellen wortgleich stand (analyze-batch, Reset, Kanten-Recompute): Der Client erzeugt die jobId,
 * oeffnet damit den SSE-Strom, wartet kurz auf die Verbindung und schickt sie im Body mit.
 *
 * Der Strom ist eine reine Zugabe: faellt er aus (Proxy, alter Server), laeuft die Arbeit
 * unveraendert weiter – nur eben ohne Zahlen.
 *
 * @param kind      'import' | 'reset' | 'edges'
 * @param fn        (jobId) => Promise<result> – der eigentliche Request
 * @param summarize (result) => string|null – Abschlussmeldung fuer die Karte. `null` heisst
 *                  „noch nicht fertig" (z. B. Import mit Rueckfrage wegen Duplikaten) und laesst
 *                  die Karte kommentarlos verschwinden, statt einen Abschluss zu behaupten.
 */
async function trackRun(kind, fn, { summarize = null } = {}) {
  const jobId = `${kind[0]}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  begin(kind)
  let es = null
  try {
    es = new EventSource(api.javaAnalyzeProgressUrl(jobId))
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg && msg.phase !== 'heartbeat') report(msg)
      } catch {
        /* unlesbares Event ignorieren */
      }
    }
    es.onerror = () => {}
    // Kurz warten, bis die Verbindung wirklich offen ist – sonst gehen die ersten Ereignisse
    // (split/parse-Start) verloren.
    await new Promise((resolve) => {
      es.addEventListener('open', resolve, { once: true })
      setTimeout(resolve, 400)
    })
  } catch {
    es = null
  }
  try {
    const res = await fn(jobId)
    end({ kind, ok: true, message: summarize ? summarize(res) : '' })
    return res
  } catch (e) {
    end({ kind, ok: false, message: e?.message || 'Failed' })
    throw e
  } finally {
    es?.close()
  }
}

// --- Ableitungen (eine Rechnung, mehrere Anzeigen) ----------------------------------------------
const progress = computed(() => run.value?.progress || null)
const activePhases = computed(() => KINDS[run.value?.kind]?.phases || IMPORT_PHASES)
const runTitle = computed(() => KINDS[run.value?.kind]?.title || 'Working')
const runIcon = computed(() => KINDS[run.value?.kind]?.icon || 'lucide:loader-2')

const phaseIndex = computed(() => {
  const list = activePhases.value
  const i = list.findIndex((p) => p.key === progress.value?.phase)
  return i === -1 ? (progress.value?.phase === 'done' ? list.length : 0) : i
})

// Anteil erledigter Phasen + Bruchteil der laufenden.
//
// Die Schreibphase kann keinen Zaehler liefern: better-sqlite3 arbeitet synchron, waehrend der
// Transaktion kommt vom Server nichts. Statt den Ring dort minutenlang einfrieren zu lassen,
// naehert er sich in solchen Phasen ZEITBASIERT dem Phasenende (asymptotisch, erreicht es nie) –
// die Anzeige bleibt lebendig, ohne einen Fortschritt zu behaupten, der schon erreicht waere.
const PHASE_TAU_MS = 9000
// Fuellgrad der LAUFENDEN Phase (0..1). Eigene Groesse, weil mehrere Anzeigen sie brauchen: der
// Ring im Modal, die Phasenleiste im Header und die Sidebar-Karte. Zweimal gerechnet waere
// zweimal die Gelegenheit, auseinanderzulaufen.
const currentPhaseFraction = computed(() => {
  const p = progress.value
  if (!p) return 0
  if (p.phase === 'done') return 1
  // ⚠️ Meldet die Phase einen ZAEHLER, ist er der Fortschritt – die Zeitkurve darf ihn nicht
  // ueberschreiben. Genau das tat ein `Math.max(byTime, byCount)`: die Kantenphase laeuft bei
  // grossen Importen minutenlang, die Kurve stand also laengst auf ihrem Deckel (90 % der Phase),
  // waehrend der Server 2.000 von 2.680 meldete. Angezeigt wurden 99 %.
  if (p.total) return Math.max(0, Math.min(1, (p.done || 0) / p.total))
  // Ohne Zaehler bleibt nur die Zeit. Asymptotisch und bei 90 % gedeckelt – so erreicht die Phase
  // ihr Ende nie von selbst und behauptet nie, fertig zu sein.
  // `now` aus dem tickenden elapsedMs ableiten – so ist die Interpolation reaktiv.
  const now = runStartedAt + elapsedMs.value
  return (1 - Math.exp(-Math.max(0, now - (run.value?.phaseStartedAt || now)) / PHASE_TAU_MS)) * 0.9
})

const runPercent = computed(() => {
  const p = progress.value
  if (!p) return 0
  if (p.phase === 'done') return 100
  let acc = 0
  const list = activePhases.value
  for (let i = 0; i < phaseIndex.value; i++) acc += list[i].weight
  const cur = list[phaseIndex.value]
  if (cur) acc += cur.weight * currentPhaseFraction.value
  return Math.max(1, Math.min(99, Math.round(acc * 100)))
})

// Fuellgrad EINER Phase fuer die Segmentleiste: durch = 1, laufend = ihr Bruchteil, offen = 0.
const phaseFill = (i) => (i < phaseIndex.value ? 1 : i === phaseIndex.value ? currentPhaseFraction.value : 0)

// Restzeit. Solange die laufende Phase ZAEHLT, kommt sie aus deren eigener Rate – die Gesamtquote
// taugt dafuer nicht: sie haengt an den Phasengewichten und behauptete bei 99 % „0:03", waehrend
// noch 680 Klassen vor dem Lauf lagen. Zur Restzeit der laufenden Phase kommt der Anteil der noch
// offenen Phasen, hochgerechnet aus dem, was die laufende bisher gekostet hat.
// Erst ab etwas Fortschritt, sonst schwankt die Schaetzung wild.
const runRemainingMs = computed(() => {
  const p = progress.value
  if (!p || p.phase === 'done' || elapsedMs.value < 1500) return null
  const list = activePhases.value
  const cur = list[phaseIndex.value]
  const done = p.done || 0
  const phaseElapsed = runStartedAt + elapsedMs.value - (run.value?.phaseStartedAt || runStartedAt)
  if (cur?.weight && p.total && done > 0 && phaseElapsed > 500) {
    const phaseLeft = (phaseElapsed / done) * Math.max(0, p.total - done)
    const restWeight = list.slice(phaseIndex.value + 1).reduce((n, x) => n + x.weight, 0)
    return Math.round(phaseLeft + ((phaseElapsed + phaseLeft) / cur.weight) * restWeight)
  }
  // Zaehlerlose Phase (Schreiben) -> aus der Gesamtquote.
  const pct = runPercent.value
  if (pct < 5 || pct >= 100) return null
  return Math.round((elapsedMs.value / pct) * (100 - pct))
})

const runPhaseLabel = computed(() => activePhases.value[phaseIndex.value]?.label || 'Finishing up')
// Was der Zaehler zaehlt – je Phase etwas anderes.
const runPhaseUnit = computed(() => activePhases.value[phaseIndex.value]?.unit || '')

// --- KI-Queue ----------------------------------------------------------------------------------
// Abgeleitet, nicht gespiegelt: `summary` ist bereits reaktiv und wird gepollt.
const { summary: queueSummary } = useJavaQueue()
const queue = computed(() => {
  const s = queueSummary.value
  if (!s || (s.running <= 0 && s.queued <= 0)) return null
  const total = s.unitsTotal || 0
  const done = s.unitsDone || 0
  return {
    total,
    done,
    percent: total ? Math.max(1, Math.min(99, Math.round((done / total) * 100))) : 0,
    etaMs: s.etaMs ?? null,
    // Woran gerade gearbeitet wird. Bei grossen Queues faellt die Detailliste weg, `current`
    // bleibt aber immer besetzt – deshalb haengt die Auskunft daran und nicht an `allJobs`.
    className: s.current?.className || '',
    // 'methods' | 'class' – sagt, ob gerade die Methoden oder die Klassen-Zusammenfassung laufen.
    phase: s.current?.phase || '',
    classesLeft: (s.queued || 0) + (s.running || 0),
    parallel: s.parallel || 1,
  }
})

// „Es tut sich etwas" – die eine Frage, an der Sidebar-Karte und Nav-Punkt haengen.
const busy = computed(() => !!run.value || !!queue.value)
const anything = computed(() => busy.value || !!result.value)

export function useActivity() {
  return {
    // Lauf (SSE)
    run,
    progress,
    elapsedMs,
    activePhases,
    phaseIndex,
    phaseFill,
    runPercent,
    runRemainingMs,
    runPhaseLabel,
    runPhaseUnit,
    runTitle,
    runIcon,
    // KI-Queue (Polling)
    queue,
    // Abschluss
    result,
    clearResult,
    // Gesamt
    busy,
    anything,
    // Steuerung
    trackRun,
    begin,
    report,
    end,
  }
}
