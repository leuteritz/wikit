// `v-tip` – erklaerender Hinweis am Bedienelement.
//
// Warum nicht `title=""`: der Browser-Tooltip erscheint erst nach ~1 s, sieht auf jedem System
// anders aus, ignoriert Theme und Schriftgroesse, haengt am Mauszeiger statt am Knopf und laesst
// sich nicht zweizeilig schreiben. Genau das braucht eine Werkzeugleiste aus Icons aber: schnell,
// am Knopf, mit einem Satz WARUM.
//
// Bauart bewusst als Direktive mit EINEM gemeinsamen Element am `<body>`:
//   * ein Knopf braucht kein eigenes Wrapper-Element (kein zusaetzliches Markup je Knopf),
//   * `position: fixed` heisst, kein `overflow: hidden` eines Vorfahren kann es abschneiden –
//     die Werkzeug-Gruppe der Kopfzeile ist genau so ein Container (abgerundete Ecken),
//   * und es gibt immer nur einen Hinweis im DOM, egal wie viele Knoepfe es gibt.
//
// Bedienung: `v-tip="'Kurztext'"` oder `v-tip="{ title: 'Kurz', hint: 'ein Satz warum' }"`.
// `aria-label`/Text des Knopfes bleiben davon unberuehrt – der Hinweis ist eine Zugabe fuer die
// Maus, keine Ersatzbeschriftung (deshalb `aria-hidden`).

const SHOW_DELAY_MS = 120 // schnell genug zum Nachschlagen, langsam genug, um beim Vorbeifahren zu schweigen
const HIDE_DELAY_MS = 60
const GAP = 8 // Abstand zwischen Knopf und Hinweis
const EDGE = 8 // Mindestabstand zum Fensterrand

let el = null // das eine, geteilte Hinweis-Element
let showTimer = null
let hideTimer = null
let current = null // Knopf, zu dem der Hinweis gerade gehoert

function ensureEl() {
  if (el) return el
  el = document.createElement('div')
  el.className = 'tip'
  el.setAttribute('role', 'tooltip')
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  return el
}

function normalize(value) {
  if (!value) return null
  if (typeof value === 'string') return { title: value, hint: '' }
  return { title: value.title || '', hint: value.hint || '' }
}

function render(content) {
  const node = ensureEl()
  node.textContent = ''
  const title = document.createElement('span')
  title.className = 'tip-title'
  title.textContent = content.title
  node.appendChild(title)
  if (content.hint) {
    const hint = document.createElement('span')
    hint.className = 'tip-hint'
    hint.textContent = content.hint
    node.appendChild(hint)
  }
}

// Unter dem Knopf, sonst darueber – und nie ueber den Fensterrand hinaus.
function place(target) {
  const node = ensureEl()
  const t = target.getBoundingClientRect()
  const r = node.getBoundingClientRect()
  const below = t.bottom + GAP + r.height <= window.innerHeight - EDGE
  const top = below ? t.bottom + GAP : t.top - GAP - r.height
  let left = t.left + t.width / 2 - r.width / 2
  left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - r.width))
  node.style.top = `${Math.round(top)}px`
  node.style.left = `${Math.round(left)}px`
  node.dataset.side = below ? 'below' : 'above'
}

function show(target, content) {
  if (!content?.title) return
  current = target
  render(content)
  const node = ensureEl()
  node.classList.add('is-visible')
  node.setAttribute('aria-hidden', 'false')
  // Erst messen, dann setzen: die Groesse steht erst, wenn der Text drin ist.
  place(target)
}

function hide() {
  if (!el) return
  el.classList.remove('is-visible')
  el.setAttribute('aria-hidden', 'true')
  current = null
}

function scheduleShow(target, content) {
  clearTimeout(hideTimer)
  clearTimeout(showTimer)
  showTimer = setTimeout(() => show(target, content), SHOW_DELAY_MS)
}

function scheduleHide() {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hide, HIDE_DELAY_MS)
}

// Beim Scrollen/Resize sofort weg: ein Hinweis, der neben seinem Knopf steht, ist falscher als
// keiner. (Passive Listener, damit das Scrollen nicht darunter leidet.)
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => current && hide(), { passive: true, capture: true })
  window.addEventListener('resize', () => current && hide(), { passive: true })
}

export const vTip = {
  mounted(target, binding) {
    target.__tip = normalize(binding.value)
    const onEnter = () => scheduleShow(target, target.__tip)
    const onLeave = () => scheduleHide()
    target.__tipOn = { onEnter, onLeave }
    target.addEventListener('mouseenter', onEnter)
    target.addEventListener('mouseleave', onLeave)
    // Tastatur: wer sich durchtabbt, bekommt dieselbe Erklaerung.
    target.addEventListener('focus', onEnter)
    target.addEventListener('blur', onLeave)
    // Ein Klick beantwortet die Frage bereits – der Hinweis darf dann nicht stehenbleiben.
    target.addEventListener('click', onLeave)
  },
  updated(target, binding) {
    target.__tip = normalize(binding.value)
    if (current === target) show(target, target.__tip)
  },
  unmounted(target) {
    const on = target.__tipOn
    if (on) {
      target.removeEventListener('mouseenter', on.onEnter)
      target.removeEventListener('mouseleave', on.onLeave)
      target.removeEventListener('focus', on.onEnter)
      target.removeEventListener('blur', on.onLeave)
      target.removeEventListener('click', on.onLeave)
    }
    // Verschwindet der Knopf (v-if), verschwindet sein Hinweis mit ihm.
    if (current === target) hide()
  },
}
