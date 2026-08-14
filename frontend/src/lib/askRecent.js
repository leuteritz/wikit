// Zuletzt gestellte Fragen (`/ask`).
//
// Die Ansicht hatte kein Gedaechtnis: jedes `ask()` setzt Antwort, Quellen und Belegzahl zurueck,
// und damit war die vorige Frage weg – nicht einmal als Wort. Das ist bei einer Q&A-Oberflaeche
// die teuerste Luecke, weil Fragen in Reihen kommen: „wie laeuft der Import?", dann „und was
// passiert bei einem Fehler dabei?". Die zweite Frage formuliert man aus der ersten.
//
// ⚠️ Gleiche Bauart wie `lib/searchRecent.js`, und das mit Absicht: derselbe Schluessel-Stil,
// dieselbe Deckelung, dieselbe Regel „die Wiederholung wandert nach vorn statt sich zu
// verdoppeln". Zwei Merklisten, die sich verschieden verhalten, waeren zwei Dinge zu lernen.
//
// ⚠️ Gemerkt wird beim STELLEN, nicht beim Tippen – anders als bei der Suche, wo erst das Oeffnen
// eines Treffers zaehlt. Der Unterschied liegt in der Sache: eine Suche wird waehrend des Tippens
// hundertmal ausgefuehrt, eine Frage genau einmal, und zwar bewusst. Sie IST der Klick.
const KEY = 'wikit:ask-recent:v1'
const MAX = 6
// Eine sehr lange Frage als Chip waere eine Textwand mit abgeschnittenem Ende. Was darueber
// hinausgeht, ist ohnehin nicht mehr wiederzuerkennen.
const MAX_LEN = 200

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string' && s) : []
  } catch {
    return []
  }
}

let list = read()

export function recentQuestions() {
  return list
}

export function rememberQuestion(q) {
  const v = String(q || '').trim().slice(0, MAX_LEN)
  if (!v) return
  list = [v, ...list.filter((x) => x !== v)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* Quota/Privatmodus: die Liste bleibt fuer diese Sitzung im Speicher */
  }
}

export function clearRecentQuestions() {
  list = []
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
