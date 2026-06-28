// Leichte Client-Heuristik NUR fuer die Live-Vorschau der erkannten Klassen (Name + Package)
// unter dem Editor. Bewusst KEIN echtes Parsen – die autoritative Trennung/Analyse macht das
// Backend (java-parser, /api/java/analyze-batch). Hier reicht ein brace-zaehlender Scan, der
// Strings/Chars/Kommentare ueberspringt und nur Top-Level-Typen (depth 0) erfasst, damit die
// Vorschau moeglichst genau dem entspricht, was das Backend als eigene Einheiten anlegt.

const IDENT = /[A-Za-z0-9_$]/

// Index nach dem schliessenden Quote eines String-/Char-Literals (inkl. Escapes).
function skipLiteral(text, i, quote) {
  i++
  const n = text.length
  while (i < n) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) return i + 1
    i++
  }
  return n
}

export function detectJavaClasses(source) {
  const text = String(source || '').replace(/\r\n/g, '\n')
  const n = text.length
  const results = []
  const seen = new Set()
  let pkg = ''
  let depth = 0
  let i = 0

  while (i < n) {
    const c = text[i]
    const c2 = text[i + 1]

    if (c === '/' && c2 === '/') {
      const e = text.indexOf('\n', i)
      i = e === -1 ? n : e
      continue
    }
    if (c === '/' && c2 === '*') {
      const e = text.indexOf('*/', i + 2)
      i = e === -1 ? n : e + 2
      continue
    }
    if (c === '"' || c === "'") {
      i = skipLiteral(text, i, c)
      continue
    }
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      if (depth > 0) depth--
      i++
      continue
    }

    // Wortgrenze -> Schluesselwort pruefen.
    if (IDENT.test(c) && (i === 0 || !IDENT.test(text[i - 1]))) {
      let j = i + 1
      while (j < n && IDENT.test(text[j])) j++
      const word = text.slice(i, j)
      const rest = text.slice(j)

      if (depth === 0 && word === 'package') {
        const pm = rest.match(/^\s+([\w.]+)\s*;/)
        if (pm) {
          pkg = pm[1]
          i = j + pm[0].length
          continue
        }
      }
      if (depth === 0 && (word === 'class' || word === 'interface' || word === 'enum' || word === 'record')) {
        const nm = rest.match(/^\s+([A-Za-z_$][\w$]*)/)
        if (nm) {
          const name = nm[1]
          const fqcn = (pkg ? pkg + '.' : '') + name
          if (!seen.has(fqcn)) {
            seen.add(fqcn)
            results.push({ class_name: name, package: pkg || null, type: word })
          }
        }
      }
      i = j
      continue
    }
    i++
  }
  return results
}
