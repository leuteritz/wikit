import { ref, readonly } from 'vue'

// Aktueller Umrechnungsfaktor rem -> px, reaktiv.
//
// Warum es das braucht: die App skaliert ueber die Root-Schriftgroesse (`html { font-size: clamp(...) }`
// in assets/style.css) – alles rem-Basierte waechst damit von allein mit. Der Abhaengigkeitsgraph
// ist die Ausnahme: Vue Flow positioniert Knoten in einem eigenen px-Koordinatensystem, die
// Knotengroesse geht also als ZAHL ins Layout. Bliebe sie fest, waehrend der Text in der Karte
// waechst, liefe der Klassenname aus seiner Box.
//
// Modul-Singleton (wie die uebrigen Composables hier): EIN resize-Listener fuer alle Aufrufer.
// `clamp()` haengt an der Viewport-Breite, der Faktor aendert sich also beim Fenster-Resize –
// wer ihn liest, rechnet dank Reaktivitaet automatisch neu.

const scale = ref(1)

function measure() {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  if (Number.isFinite(px) && px > 0) scale.value = px / 16
}

let started = false
function start() {
  if (started || typeof window === 'undefined') return
  started = true
  measure()
  // Kein Debounce: measure() ist ein einzelner Style-Read und der Graph rechnet ohnehin nur neu,
  // wenn sich der Wert wirklich aendert (ref schreibt bei gleichem Zahlenwert nicht).
  window.addEventListener('resize', measure, { passive: true })
}

/**
 * @returns {{ scale: import('vue').Ref<number> }} Faktor gegenueber der 16px-Basis
 *          (1.0 = 16px, 1.25 = 20px). Feste px-Basiswerte damit multiplizieren.
 */
export function useRootScale() {
  start()
  return { scale: readonly(scale) }
}
