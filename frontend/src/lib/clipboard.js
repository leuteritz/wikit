// Robustes Kopieren in die Zwischenablage – auch im UNSICHEREN Kontext.
//
// Wikit laeuft laut Design auf http://raspberrypi.local:3000 (kein HTTPS, kein localhost).
// Dort ist `navigator.clipboard` *undefined* (Secure-Context-only) -> ein direkter
// `navigator.clipboard.writeText()`-Aufruf wirft und ein stiller catch laesst den Button
// wirkungslos erscheinen. Daher: moderne API bevorzugen, sonst auf das alte
// `document.execCommand('copy')` (via temporaeres <textarea>) zurueckfallen.
//
// Gibt `true` bei Erfolg zurueck, sonst `false` (Aufrufer entscheidet ueber Feedback).
export async function copyToClipboard(text) {
  if (!text) return false
  // 1) Moderne Clipboard-API (nur in Secure Contexts verfuegbar).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* -> Fallback unten */
  }
  // 2) Fallback fuer unsichere Kontexte (http auf dem Pi): textarea + execCommand.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
