// Gemeinsame Anzeige-Formatierer (Datum/Zeit/Dauer). Vorher lagen fast identische Kopien in
// ArticleView.vue, java/JavaAnalysisPanel.vue und java/JavaClassDetail.vue – mit dem feinen
// Unterschied, dass nur ein Teil davon die SQLite-Eigenheit unten beruecksichtigt hat.
//
// WICHTIG: SQLite liefert `datetime('now')` als "YYYY-MM-DD HH:MM:SS" – UTC, aber OHNE
// Zeitzonen-Suffix. `new Date(...)` wuerde das je nach Browser als LOKALE Zeit lesen und die
// Anzeige um den UTC-Offset verschieben. `parseTimestamp` normalisiert das: fehlt ein Zonen-
// Suffix, wird der Wert explizit als UTC interpretiert. ISO-Strings (aus `toISOString()`, z. B.
// java_files.generated_at) bleiben unveraendert.

export function parseTimestamp(ts) {
  if (!ts) return null
  const iso = /Z|[+-]\d\d:?\d\d$/.test(ts) ? ts : String(ts).replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  return isNaN(d) ? null : d
}

// Absolute Datums-/Zeitangabe in lokaler Zone (DD/MM/YYYY, HH:MM).
export function formatDateTime(ts) {
  const d = parseTimestamp(ts)
  if (!d) return ''
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Kompakte Relativzeit ("3 minutes ago"), Fallback auf die absolute Angabe.
export function formatRelative(ts) {
  const then = parseTimestamp(ts)
  if (!then) return ts || ''
  const diff = Math.round((Date.now() - then.getTime()) / 1000)
  if (diff < 45) return 'just now'
  if (diff < 90) return 'a minute ago'
  const mins = Math.round(diff / 60)
  if (mins < 60) return `${mins} minutes ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return then.toLocaleString()
}

// Dauer als mm:ss (Analyse-Laufzeiten).
export function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
