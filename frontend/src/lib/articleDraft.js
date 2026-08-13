// Ungesicherter Artikelentwurf ueber den Reload hinweg.
//
// Der Editor hatte bis hierher KEINE Absicherung: ein versehentliches Zurueck, ein geschlossener
// Tab, ein Reload – und eine halbe Stunde Schreiben war weg. Der Server weiss nichts davon (er
// kennt nur gespeicherte Fassungen), also gehoert der Entwurf in den Browser.
//
// ⚠️ Ein Entwurf wird NIE still eingespielt. Beim Oeffnen steht ein Hinweis mit zwei Knoepfen –
// „wiederherstellen" oder „verwerfen". Ein Entwurf ist eine ERINNERUNG, keine Wahrheit: er kann
// aelter sein als der gespeicherte Stand (ein anderer Tab, ein anderer Rechner), und ihn
// ungefragt ueber den Server-Stand zu legen hiesse, den falschen von zweien zu waehlen.
//
// Ein Schluessel je Artikel, damit zwei offene Entwuerfe sich nicht ueberschreiben; `__new` fuer
// den noch namenlosen.
const PREFIX = 'wikit:article-draft:v1:'
const WRITE_DELAY_MS = 600

// Nach 14 Tagen ist ein Entwurf keine Erinnerung mehr, sondern Muell – und er wuerde bei jedem
// Oeffnen desselben Artikels erneut nachfragen.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const keyFor = (slug) => PREFIX + (slug || '__new')

let timer = null

/** Entwurf lesen. Liefert `null`, wenn keiner da, er kaputt oder zu alt ist. */
export function readDraft(slug) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(slug)) || 'null')
    if (!raw || typeof raw !== 'object' || !raw.savedAt) return null
    if (Date.now() - raw.savedAt > MAX_AGE_MS) {
      clearDraft(slug)
      return null
    }
    return raw
  } catch {
    return null
  }
}

/** Verzoegert schreiben – der Entwurf aendert sich im Takt von Tastendruecken. */
export function writeDraft(slug, data) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    try {
      localStorage.setItem(keyFor(slug), JSON.stringify({ ...data, savedAt: Date.now() }))
    } catch {
      /* Quota/Privatmodus: der Entwurf geht verloren, der Editor laeuft weiter */
    }
  }, WRITE_DELAY_MS)
}

/** Nach dem Speichern und beim Verwerfen: der Entwurf hat seinen Zweck erfuellt. */
export function clearDraft(slug) {
  clearTimeout(timer)
  try {
    localStorage.removeItem(keyFor(slug))
  } catch {
    /* ignore */
  }
}
