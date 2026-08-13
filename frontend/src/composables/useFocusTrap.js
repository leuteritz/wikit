// Tastatur-Fokus in einem geoeffneten Overlay halten – und ihn danach dorthin zurueckgeben, wo er
// herkam. Bis hierher gab es das in der App an keiner Stelle: mit `Tab` lief man aus jedem Modal
// heraus in die Seite dahinter, ohne dass das Modal sich schloss.
//
// Bewusst KEINE Bibliothek und bewusst klein: die App hat genau eine Form von Overlay
// (`ui/Modal.vue`) plus zwei Sonderfaelle (Suchpalette, Slideover), die dieselbe Funktion
// mitbenutzen koennen.
//
// Ein Instanz-Composable, kein Modul-Singleton: es kann mehr als ein Overlay im DOM stehen
// (`CodeView` haelt vier gleichzeitig, nur eines ist offen).
import { watch, nextTick, onBeforeUnmount } from 'vue'

// `:not([tabindex="-1"])` haelt Elemente draussen, die nur PROGRAMMATISCH fokussierbar sind –
// darunter der Modal-Container selbst.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * @param {import('vue').Ref<HTMLElement|null>} containerRef Wurzel des Overlays (braucht tabindex="-1")
 * @param {import('vue').Ref<boolean>} active                ob das Overlay offen ist
 */
export function useFocusTrap(containerRef, active) {
  let restoreTo = null

  function focusables() {
    const el = containerRef.value
    if (!el) return []
    // `offsetParent === null` filtert ausgeblendete Elemente (v-show, display:none) heraus –
    // sonst tabbt man in ein Feld, das gar nicht zu sehen ist.
    return Array.from(el.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null)
  }

  function onKeydown(e) {
    if (e.key !== 'Tab' || !active.value) return
    const el = containerRef.value
    if (!el) return
    const list = focusables()
    if (!list.length) {
      e.preventDefault()
      el.focus()
      return
    }
    const first = list[0]
    const last = list[list.length - 1]
    const cur = document.activeElement
    const inside = el.contains(cur)
    // Auch der Sprung von AUSSEN nach innen wird abgefangen: stuende der Fokus noch auf der Seite
    // dahinter, liefe die erste Tabulatortaste sonst durch deren Bedienelemente.
    if (e.shiftKey ? cur === first || !inside : cur === last || !inside) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    }
  }

  function activate() {
    restoreTo = document.activeElement
    document.addEventListener('keydown', onKeydown)
    nextTick(() => {
      const el = containerRef.value
      if (!el) return
      // Standardmaessig bekommt der CONTAINER den Fokus, nicht das erste Bedienelement: sonst
      // landet man beim Oeffnen regelmaessig auf dem Schliessen-Kreuz und liest die Meldung nicht.
      // Ein Feld, das den Fokus wirklich haben will, sagt das mit `data-autofocus`.
      const wanted = el.querySelector('[data-autofocus]')
      ;(wanted || el).focus({ preventScroll: true })
    })
  }

  function deactivate() {
    document.removeEventListener('keydown', onKeydown)
    // Zurueck an den Ausloeser – der Knopf, der das Overlay geoeffnet hat. Ohne das steht der
    // Fokus nach dem Schliessen am <body> und die naechste Tabulatortaste beginnt wieder oben.
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus?.({ preventScroll: true })
    restoreTo = null
  }

  watch(active, (on) => (on ? activate() : deactivate()), { immediate: true })
  onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
}
