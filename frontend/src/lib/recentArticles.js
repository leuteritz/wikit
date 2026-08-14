// Zuletzt GELESENE Artikel.
//
// Die Anwendung merkte sich, was man gesucht (`searchRecent.js`) und was man gefragt hat
// (`askRecent.js`) – aber nicht, wo man war. Das ist die haeufigste Frage beim Wiedereinstieg:
// „woran war ich dran?". Die Startseite konnte sie bis hierher nicht beantworten und zeigte
// stattdessen, was es GIBT.
//
// ⚠️ „Zuletzt geaendert" ist nicht dasselbe und liegt bereits vor (`articles[].updated_at`). Die
// beiden Listen beantworten verschiedene Fragen: was ist neu (auch von einem Import) gegen wo war
// ICH. In einem Wiki, in dem ein Massenimport zwanzig Artikel auf einmal schreibt, sind sie sogar
// meistens verschieden.
//
// Gespeichert werden Slug UND Titel: der Slug ist der Weg zurueck, aber ein Chip, der nur
// `order-service` sagt, waere die Adresse statt der Sache. Der Titel kann veralten (Umbenennung) –
// dann steht dort der Name von damals, und das ist richtiger als ein Eintrag, der verschwindet,
// weil die Liste beim Lesen keinen Bestand nachschlaegt.
const KEY = 'wikit:recent-articles:v1'
const MAX = 5

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw)
      ? raw.filter((a) => a && typeof a.slug === 'string' && typeof a.title === 'string')
      : []
  } catch {
    return []
  }
}

let list = read()

export function recentArticles() {
  return list
}

/**
 * ⚠️ Gemerkt wird beim ÖFFNEN, nicht beim Speichern: gelesen zu haben ist die Spur, die hier
 * gesucht wird. Wer einen Artikel bearbeitet, hat ihn ohnehin vorher geoeffnet.
 */
export function rememberArticle(slug, title) {
  const s = String(slug || '').trim()
  if (!s) return
  list = [{ slug: s, title: String(title || s) }, ...list.filter((a) => a.slug !== s)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* Quota/Privatmodus: die Liste bleibt fuer diese Sitzung im Speicher */
  }
}

/** Ein geloeschter Artikel gehoert nicht mehr in die Liste – der Chip fuehrte ins Leere. */
export function forgetArticle(slug) {
  list = list.filter((a) => a.slug !== slug)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}
