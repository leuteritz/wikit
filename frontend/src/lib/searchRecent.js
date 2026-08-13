// Zuletzt gesuchte Begriffe der globalen Suche.
//
// Eine Suche wird selten einmal gestellt: man sucht eine Klasse, sieht sie an, kommt zurück und
// sucht dieselbe wieder. Bis hierher stand im leeren Feld nur eine Liste zuletzt geänderter
// Artikel – die beantwortet „was ist neu?", nicht „woran war ich dran?".
//
// Gemerkt wird die EINGABE, nicht der geparste Begriff: `s:findByName` ist eine andere Suche als
// `findByName`, und wer sie wiederholt, meint auch die Facette wieder.
//
// ⚠️ Gemerkt wird erst beim ÖFFNEN eines Treffers, nicht beim Tippen. Sonst stünde jede
// Zwischenstufe einer Eingabe in der Liste („f", "fi", "fin", …).
const KEY = 'wikit:search-recent:v1'
const MAX = 6

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

let list = read()

export function recentQueries() {
  return list
}

export function rememberQuery(q) {
  const v = (q || '').trim()
  if (!v) return
  // Dieselbe Suche wandert nach vorn, statt ein zweites Mal dazustehen.
  list = [v, ...list.filter((x) => x !== v)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* Quota/Privatmodus: die Liste bleibt für diese Sitzung im Speicher */
  }
}

export function clearRecentQueries() {
  list = []
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
