// Robustes Kopieren in die Zwischenablage – auch im UNSICHEREN Kontext.
//
// Wikit laeuft laut Design auf http://raspberrypi.local:3000 (kein HTTPS, kein localhost).
// Dort ist `navigator.clipboard` *undefined* (Secure-Context-only) -> ein direkter
// `navigator.clipboard.writeText()`-Aufruf wirft und ein stiller catch laesst den Button
// wirkungslos erscheinen. Daher: moderne API bevorzugen, sonst auf das alte
// `document.execCommand('copy')` (via temporaeres <textarea>) zurueckfallen.
//
// Gibt `true` bei Erfolg zurueck, sonst `false` (Aufrufer entscheidet ueber Feedback).

// Ab hier ist die Zwischenablage kein tragfaehiger Weg mehr: der execCommand-Fallback oben
// schiebt den ganzen Text durch ein <textarea>, und bei einigen Megabyte blockiert das den Tab
// spuerbar. Die Zahl gehoert hierher und nicht an die Aufrufer – „was die Ablage noch vertraegt"
// ist eine Eigenschaft dieses Weges, und zwei Fassungen davon waeren zwei Schwellen fuer denselben
// Rueckfall. Wer sie ueberschreitet, bietet den Download an (Export-Modal, Themen-Buendel).
export const BIG_CLIPBOARD_BYTES = 4 * 1024 * 1024

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

/**
 * Der andere Weg aus der Anwendung heraus: als Datei.
 *
 * Er stand als Kopie in `JavaExportModal` und gehoert hierher, neben `BIG_CLIPBOARD_BYTES` – die
 * Grenze und der Ausweg, den sie meint, sind eine Sache. Ab dem dritten Aufrufer (Klassenexport,
 * Wiki-Export, Backup) waere jede Kopie eine Stelle, an der jemand das `revokeObjectURL` vergisst.
 *
 * Rein clientseitig: der Text liegt bereits im Speicher, ein zweiter Request dafuer waere
 * derselbe Inhalt ein zweites Mal.
 */
export function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  if (!text) return
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Erst nach dem Klick freigeben – sonst ist der Blob weg, bevor der Browser ihn liest.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
