// Drag-to-Resize fuer das 3-Spalten-Layout der Code-Ansicht (views/CodeView.vue).
//
// Die Breiten werden als fr-Gewichte (Summe 100, wirken wie Prozent) gehalten und ueber
// `grid-template-columns` gerendert: `minmax(0,{l}fr) {R}px minmax(0,{c}fr) {R}px minmax(0,{r}fr)`.
// Die zwei `{R}px`-Tracks sind die Divider; fr verteilt den Restplatz proportional, die
// Mindestbreite (MIN) bleibt sauber erhalten.
//
// View-lokaler State (frische Instanz pro Aufruf, KEIN Modul-Singleton) – kein Pinia/Vuex.
// Drag-Listener haengen am `window`, damit das Ziehen nicht abbricht, wenn die Maus den
// schmalen Divider (oder den Graphen) verlaesst. Eingestellte Breiten ueberleben einen
// Reload via localStorage.
import { reactive, ref, computed, onMounted, onUnmounted } from 'vue'

const MIN = 10 // kein Panel < 10 % (untere Klemmgrenze fuer ALLE Panels)
// fr-Gewichte (Summe 100). Die linke Klassen-Spalte startet bewusst auf der Minimal-Breite
// (left == MIN): reine Liste mit Ellipsis, der Nutzer kann sie nur breiter ziehen. Der Platz
// geht an Graph (Mitte) und das Doku-/Code-Panel (rechts).
const DEFAULTS = { left: MIN, center: 60, right: 30 }
const RESIZER_PX = 8 // Breite eines Divider-Tracks (einzige Quelle: CSS-Template + px-Umrechnung)
const STORAGE_KEY = 'wikit:code-panel-widths'

// Drei endliche Zahlen mit Summe ~100? -> als gespeicherte Aufteilung akzeptieren.
function isValidTriple(v) {
  if (!v || typeof v !== 'object') return false
  const { left, center, right } = v
  for (const n of [left, center, right]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < MIN) return false
  }
  return Math.abs(left + center + right - 100) < 0.5
}

export function usePanelResize() {
  const widths = reactive({ ...DEFAULTS })

  // Persistierte Aufteilung wiederherstellen (best effort).
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (isValidTriple(parsed)) Object.assign(widths, parsed)
    }
  } catch {
    /* localStorage nicht verfuegbar -> Defaults */
  }

  const isDragging = ref(false)
  const activeKey = ref(null) // 'left' | 'right' | null -> hebt den gezogenen Divider hervor

  const isDirty = computed(
    () =>
      Math.abs(widths.left - DEFAULTS.left) > 0.5 ||
      Math.abs(widths.center - DEFAULTS.center) > 0.5 ||
      Math.abs(widths.right - DEFAULTS.right) > 0.5,
  )

  const gridTemplate = computed(
    () =>
      `minmax(0,${widths.left}fr) ${RESIZER_PX}px ` +
      `minmax(0,${widths.center}fr) ${RESIZER_PX}px ` +
      `minmax(0,${widths.right}fr)`,
  )

  // --- Responsiv: Resize nur im lg-Layout (>= 1024px) aktiv ---
  const mq = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null
  const isWide = ref(mq ? mq.matches : true)
  const onMq = (e) => {
    isWide.value = e.matches
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...widths }))
    } catch {
      /* ignore */
    }
  }

  let active = null // { aKey, bKey, aStart, bStart, startX, availablePx, pair }

  function onMove(e) {
    if (!active) return
    const deltaFr = ((e.clientX - active.startX) / active.availablePx) * 100
    let a = active.aStart + deltaFr
    let b = active.bStart - deltaFr
    // Beide Nachbarn auf MIN klemmen; die Summe des Paares (und damit die dritte Spalte) bleibt fix.
    if (a < MIN) {
      a = MIN
      b = active.pair - MIN
    } else if (b < MIN) {
      b = MIN
      a = active.pair - MIN
    }
    widths[active.aKey] = a
    widths[active.bKey] = b
  }

  function stopDrag() {
    if (!active) return
    active = null
    isDragging.value = false
    activeKey.value = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stopDrag)
    persist()
  }

  // which: 'left' = Divider zwischen Spalte 1/2, 'right' = zwischen Spalte 2/3.
  function startDrag(which, e) {
    e.preventDefault() // verhindert Textselektion waehrend des Ziehens
    const gridEl = e.currentTarget.parentElement
    const rect = gridEl.getBoundingClientRect()
    const availablePx = Math.max(1, rect.width - 2 * RESIZER_PX) // px-Raum fuer die 100 fr
    const aKey = which === 'left' ? 'left' : 'center'
    const bKey = which === 'left' ? 'center' : 'right'
    active = {
      aKey,
      bKey,
      aStart: widths[aKey],
      bStart: widths[bKey],
      pair: widths[aKey] + widths[bKey],
      startX: e.clientX,
      availablePx,
    }
    isDragging.value = true
    activeKey.value = which
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stopDrag)
  }

  function reset() {
    Object.assign(widths, DEFAULTS)
    persist()
  }

  onMounted(() => mq?.addEventListener('change', onMq))
  onUnmounted(() => {
    mq?.removeEventListener('change', onMq)
    stopDrag() // Sicherheit, falls waehrend eines Drags unmounted
  })

  return { widths, gridTemplate, isWide, isDragging, activeKey, isDirty, startDrag, reset }
}
