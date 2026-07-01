// Anzeige-Re-Indenter fuer flachen Java-Quellcode (Source-Tab in JavaClassDetail.vue).
//
// Hintergrund: die eingefuegten/gespeicherten Quellen (raw_source) sind teils komplett flach
// (jede Zeile auf Spalte 0, keine Tabs/Leerzeichen). CodeMirror rendert das getreu -> unleserlich.
// Wir rekonstruieren den Einzug zur ANZEIGE aus der Klammer-Tiefe.
//
// WICHTIGE INVARIANTE: Es wird ausschliesslich das FUEHRENDE Whitespace jeder Zeile neu gesetzt.
// Zeilen werden NIE gesplittet/gemergt -> Zeilenanzahl + Reihenfolge bleiben konstant. Nur so
// bleiben die zeilenbasierten Features gueltig (start_line/body_start_line, targetLine/targetEndLine,
// highlightLine/highlightMethod im Editor).

// Anteil nicht-leerer Zeilen mit fuehrendem Whitespace. Liegt er unter dem Schwellwert, gilt die
// Quelle als "flach" (praktisch ohne Einzug) und wird neu eingerueckt; sonst 1:1 belassen
// (bereits gut formatierter Paste soll nicht umformatiert werden).
export function looksFlat(src, threshold = 0.15) {
  const lines = String(src || '').split('\n')
  let nonEmpty = 0
  let indented = 0
  for (const l of lines) {
    if (l.trim() === '') continue
    nonEmpty++
    if (/^[ \t]/.test(l)) indented++
  }
  if (!nonEmpty) return false
  return indented / nonEmpty < threshold
}

// Eine (bereits getrimmte) Zeile zeichenweise scannen: Klammer-Deltas AUSSERHALB von
// Strings/Chars/Kommentaren zaehlen. `inBlock` (Block-Kommentar) ist zeilenuebergreifend und wird
// mitgefuehrt. `leadingClose` = Anzahl schliessender Klammern am Zeilenanfang (nur Whitespace davor)
// -> die `}`-/`)`-Zeile selbst wird dedentet.
function scanLine(line, inBlock) {
  let open = 0
  let close = 0
  let leadingClose = 0
  let sawContent = false
  let block = inBlock

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const c2 = line[i + 1]

    if (block) {
      if (c === '*' && c2 === '/') {
        block = false
        i++
      }
      continue
    }

    if (c === '/' && c2 === '/') break // Rest der Zeile ist Line-Comment
    if (c === '/' && c2 === '*') {
      block = true
      i++
      continue
    }
    if (c === '"' || c === "'") {
      // String-/Char-Literal ueberspringen (inkl. Backslash-Escapes).
      const quote = c
      i++
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2
          continue
        }
        if (line[i] === quote) break
        i++
      }
      sawContent = true
      continue
    }

    if (c === '{' || c === '(') {
      open++
      sawContent = true
      continue
    }
    if (c === '}' || c === ')') {
      close++
      if (!sawContent) leadingClose++
      continue
    }
    if (!/\s/.test(c)) sawContent = true
  }

  return { open, close, leadingClose, block }
}

// Flachen Java-Quellcode nach Klammer-Tiefe neu einruecken. `looksFlat` false -> unveraendert.
export function reindentJava(src, { unit = '    ' } = {}) {
  const text = String(src || '')
  if (!text) return text
  if (!looksFlat(text)) return text

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let depth = 0
  let inBlock = false

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '') {
      out.push('')
      continue
    }

    const wasInBlock = inBlock
    const { open, close, leadingClose, block } = scanLine(trimmed, inBlock)
    inBlock = block

    let indent = depth - leadingClose
    if (indent < 0) indent = 0

    // Javadoc/Block-Kommentar-Optik: Fortsetzungszeilen (` * …`, ` */`) mit einem Leerzeichen
    // ausrichten, damit die Sterne unter dem `/**` stehen.
    const starPrefix = wasInBlock && trimmed.startsWith('*') ? ' ' : ''
    out.push(unit.repeat(indent) + starPrefix + trimmed)

    depth += open - close
    if (depth < 0) depth = 0
  }

  return out.join('\n')
}
