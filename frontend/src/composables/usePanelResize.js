// Drag-to-Resize fuer das 3-Spalten-Layout der Code-Ansicht (views/CodeView.vue).
//
// Die Breiten werden als fr-Gewichte (Summe 100, wirken wie Prozent) gehalten und ueber
// `grid-template-columns` gerendert: `minmax(0,{l}fr) {R}px minmax(0,{c}fr) {R}px minmax(0,{r}fr)`.
// Die zwei `{R}px`-Tracks sind die Divider; fr verteilt den Restplatz proportional, die
// Mindestbreite (MIN) bleibt sauber erhalten.
//
// Drei Wege, die Breiten zu aendern, und sie unterscheiden sich in ihrer Verbindlichkeit:
// Ziehen (Einstellung, bleibt) · `toggleWide` (Entscheidung, bleibt, mit Rueckweg) ·
// `focusRight` (geliehen, wird beim naechsten Klick zurueckgegeben).
//
// View-lokaler State (frische Instanz pro Aufruf, KEIN Modul-Singleton) – kein Pinia/Vuex.
// Drag-Listener haengen am `window`, damit das Ziehen nicht abbricht, wenn die Maus den
// schmalen Divider (oder den Graphen) verlaesst. Eingestellte Breiten ueberleben einen
// Reload via localStorage.
import { reactive, ref, computed, onMounted, onUnmounted } from 'vue'

const MIN = 10 // kein Panel < 10 % (untere Klemmgrenze fuer ALLE Panels)
// fr-Gewichte (Summe 100). Die linke Klassen-Spalte bekommt genug Breite, dass ein typischer
// Klassenname ohne Ellipsis lesbar bleibt (~18 % ≈ 300 px bei 1920) – schmaler war sie faktisch
// nur eine Spalte abgeschnittener Namen. Der restliche Platz geht an Graph (Mitte) und das
// Doku-/Code-Panel (rechts).
const DEFAULTS = { left: 18, center: 52, right: 30 }
const RESIZER_PX = 8 // Breite eines Divider-Tracks (einzige Quelle: CSS-Template + px-Umrechnung)
// v2: Key bewusst gebumpt, damit die alte 10-%-Voreinstellung nicht als "gespeicherte Wahl"
// weiterlebt. Wer die Spalten selbst gezogen hat, stellt sie einmalig neu ein.
const STORAGE_KEY = 'wikit:code-panel-widths:v2'

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

  const isDragging = ref(false)
  const activeKey = ref(null) // 'left' | 'right' | null -> hebt den gezogenen Divider hervor

  // --- Geliehene Breite --------------------------------------------------------------------
  // Wer aus der globalen Suche in eine Klasse springt, will den CODE lesen und nicht den Graphen –
  // das Panel macht dafuer vorübergehend auf. `borrowed` haelt die Aufteilung, die vorher galt:
  // eine geliehene Ansicht ist KEINE Einstellung, sie wird deshalb auch nicht persistiert und
  // beim Schliessen (oder beim naechsten Klick in Graph/Baum) vollstaendig zurueckgegeben.
  const borrowed = ref(null)
  // 44 statt der Haelfte: deutlich breiter als der Normalzustand (30 %), aber der Graph behaelt
  // gut ein Drittel und bleibt damit lesbar – auf 52 % schrumpfte er auf einen Streifen.
  const FOCUS_RIGHT = 44
  const isFocused = computed(() => borrowed.value !== null)

  // --- Breit lesen -------------------------------------------------------------------------
  // Anders als die geliehene Breite ist das eine ENTSCHEIDUNG: sie bleibt, bis man sie zuruecknimmt,
  // und ueberlebt deshalb auch den Reload. Die MITTE weicht dafuer ganz – den Graphen liest niemand,
  // waehrend er eine Klasse liest, und eine Restspalte davon liest erst recht niemand. Links bleibt
  // stehen, was es ist: die Navigation, mit der man zur naechsten Klasse kommt. `stash` haelt die
  // Aufteilung von vorher.
  const wide = ref(false)
  let stash = null

  // Persistierte Aufteilung wiederherstellen (best effort). Steht hinter den Deklarationen, weil der
  // gemerkte Stand auch den Breit-Modus umfasst.
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (isValidTriple(parsed)) {
        widths.left = parsed.left
        widths.center = parsed.center
        widths.right = parsed.right
        // Der Breit-Modus gilt nur mit gemerkter Ruecksprung-Aufteilung – ohne sie waere „zurueck"
        // ein Knopf ohne Ziel.
        if (parsed.wide && isValidTriple(parsed.stash)) {
          wide.value = true
          stash = { left: parsed.stash.left, center: parsed.stash.center, right: parsed.stash.right }
        }
      }
    }
  } catch {
    /* localStorage nicht verfuegbar -> Defaults */
  }

  const isDirty = computed(
    () =>
      Math.abs(widths.left - DEFAULTS.left) > 0.5 ||
      Math.abs(widths.center - DEFAULTS.center) > 0.5 ||
      Math.abs(widths.right - DEFAULTS.right) > 0.5,
  )

  // Im Breit-Modus hat das Raster nur ZWEI Spalten und keinen Divider: die Mitte wird ausgeblendet,
  // nicht verkleinert (CodeView haengt dieselbe Bedingung an ihr `v-show`). Als 10-%-Streifen war
  // sie keine Ansicht mehr – ueberlappende Overlay-Karten, halb abgeschnittene Knoten – und der Sinn
  // des Modus ist ja gerade, dass der Graph in diesem Moment nicht gebraucht wird. Ziehen gibt es
  // hier nicht: es gaebe nur noch eine Kante, und sie wuerde eine andere Frage beantworten.
  // `widths.center` bleibt dabei auf seinem Wert stehen (nicht 0) – die Drei-Zahlen-Invariante von
  // `isValidTriple` traegt die Persistenz, und gerendert wird die Zahl im Breit-Modus ohnehin nicht.
  const gridTemplate = computed(() =>
    wide.value
      ? `minmax(0,${widths.left}fr) minmax(0,${widths.right}fr)`
      : `minmax(0,${widths.left}fr) ${RESIZER_PX}px ` +
        `minmax(0,${widths.center}fr) ${RESIZER_PX}px ` +
        `minmax(0,${widths.right}fr)`,
  )

  // --- Responsiv: Resize nur im lg-Layout (>= 1024px) aktiv ---
  const mq = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null
  const isWide = ref(mq ? mq.matches : true)
  const onMq = (e) => {
    isWide.value = e.matches
  }

  // Ist die Mittelspalte gerade ausgeblendet? Nur im lg-Layout: darunter gibt es keine Spalten,
  // sondern einen Stapel – dort waere der Graph verschwunden, waehrend der Knopf, der ihn
  // zurueckholt, deaktiviert ist (`toggleWide` steigt ohne `isWide` aus). Ein aus einem breiten
  // Fenster gemerktes `wide` darf im schmalen also nichts ausblenden.
  const centerHidden = computed(() => isWide.value && wide.value)

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...widths, wide: wide.value, stash }))
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
    // Wer selbst zieht, uebernimmt: die geliehene Breite wird zu SEINER Breite (inkl. persist beim
    // Loslassen). Ein spaeteres Zurueckspringen waere hier ein Zustand, den niemand mehr erwartet.
    // Dasselbe gilt fuer den Breit-Modus: sein Knopf zeigt „an", und die Breite ist bereits eine
    // andere – das waere eine Anzeige, die luegt.
    borrowed.value = null
    wide.value = false
    stash = null
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

  // Detail-Panel vorübergehend breit machen. Der Platz kommt zuerst aus der MITTE (dort steht der
  // Graph, den man in diesem Moment nicht liest) und erst danach von links; die 10-%-Klemmgrenze
  // gilt weiter. Ist rechts ohnehin breit genug, passiert nichts – dann gibt es auch nichts
  // zurueckzugeben.
  function focusRight() {
    if (!isWide.value || widths.right >= FOCUS_RIGHT) return false
    if (!borrowed.value) borrowed.value = { ...widths }
    const need = FOCUS_RIGHT - widths.right
    const fromCenter = Math.min(need, Math.max(0, widths.center - MIN))
    const fromLeft = Math.min(need - fromCenter, Math.max(0, widths.left - MIN))
    widths.center -= fromCenter
    widths.left -= fromLeft
    widths.right += fromCenter + fromLeft
    return true
  }

  // Zurueck in die Ursprungsposition. Ohne geliehene Breite ein No-op – der Aufrufer muss also
  // nicht wissen, ob ueberhaupt etwas geliehen wurde.
  function releaseFocus() {
    if (!borrowed.value) return
    Object.assign(widths, borrowed.value)
    borrowed.value = null
  }

  // Detail-Panel dauerhaft breit machen (und wieder zurueck). Kein Effekt im gestapelten Layout –
  // dort gibt es keine Spalten, zwischen denen sich Platz verschieben liesse.
  function toggleWide() {
    if (!isWide.value) return
    if (wide.value) {
      if (stash) Object.assign(widths, stash)
      stash = null
      wide.value = false
    } else {
      stash = { ...widths }
      borrowed.value = null // eine geliehene Breite waere hier nur noch ein Ruecksprung ins Nichts
      // Die Mitte auf MIN (nicht 0): sie wird im Breit-Modus nicht gerendert, muss die gespeicherte
      // Aufteilung aber weiter gueltig halten (`isValidTriple`: jede Zahl >= MIN, Summe 100). Ihr
      // Anteil geht an die Detailspalte, die damit vier Fuenftel der gezeichneten Flaeche bekommt.
      widths.center = MIN
      widths.right = 100 - widths.left - MIN
      wide.value = true
    }
    persist()
  }

  function reset() {
    borrowed.value = null
    wide.value = false
    stash = null
    Object.assign(widths, DEFAULTS)
    persist()
  }

  onMounted(() => mq?.addEventListener('change', onMq))
  onUnmounted(() => {
    mq?.removeEventListener('change', onMq)
    stopDrag() // Sicherheit, falls waehrend eines Drags unmounted
  })

  return {
    widths,
    gridTemplate,
    isWide,
    isDragging,
    activeKey,
    isDirty,
    isFocused,
    wide,
    centerHidden,
    startDrag,
    focusRight,
    releaseFocus,
    toggleWide,
    reset,
  }
}
