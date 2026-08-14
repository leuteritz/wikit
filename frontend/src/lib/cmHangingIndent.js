// Haengender Einzug fuer umbrochene CodeMirror-Zeilen (`EditorView.lineWrapping`).
//
// Dasselbe Anliegen wie `.code-soft-wrap .shiki .line` in assets/style.css – und derselbe Grund,
// warum CSS es nicht allein kann: der Einzug muss die Einrueckung DIESER Zeile kennen. Ein fester
// Wert ab Zeilenrand liegt bei geschachteltem Code LINKS vom Anweisungsanfang, und dann liest sich
// die Fortsetzung wie eine flachere neue Anweisung – genau das, was sie nicht sein soll.
//
// Die Zahl kommt als CSS-Variable `--ind` an die Zeile; verrechnet wird sie im `EditorView.theme`
// der jeweiligen Instanz (`padding-left: calc(6px + var(--ind, 0ch) + 3ch)`), damit dort EIN Ort
// bleibt, an dem die Geometrie einer Zeile steht.
//
// Zwei Konsumenten: JavaCodeEditor (Quelltext) und JavaDiffViewer (Unified Diff). Deshalb steht die
// Rechnung hier und nicht zweimal dort.
import { Decoration, ViewPlugin, EditorView } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

// Fuehrende Leerzeichen in Zeichenspalten. Tabs zaehlen mit der Tab-Weite des Editors – dieselbe,
// nach der er sie auch DARSTELLT (`state.tabSize`), sonst rechnete der Einzug an der Anzeige vorbei.
function leadingCols(text, tabSize) {
  let cols = 0
  for (const ch of text) {
    if (ch === ' ') cols += 1
    else if (ch === '\t') cols += tabSize - (cols % tabSize)
    else break
  }
  return cols
}

export function hangingIndent({ skipPrefix = null } = {}) {
  // Eine Decoration je Spaltenzahl statt je Zeile: bei einer 400-Zeilen-Klasse gibt es eine
  // Handvoll Einrueckungstiefen, aber vierhundert Zeilen.
  const cache = new Map()
  const lineDeco = (cols) => {
    let d = cache.get(cols)
    if (!d) {
      d = Decoration.line({ attributes: { style: `--ind: ${cols}ch` } })
      cache.set(cols, d)
    }
    return d
  }

  function build(view) {
    const builder = new RangeSetBuilder()
    const { tabSize } = view.state
    // Nur der sichtbare Bereich – bei jedem Scrollen neu. Ueber das ganze Dokument zu rechnen waere
    // bei einer grossen Klasse Arbeit fuer Zeilen, die niemand sieht.
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos)
        // Was am Zeilenanfang kein Code ist (Diff-Praefix `+`/`-`/Leerzeichen), zaehlt als Spalte
        // mit, wird beim Messen der Einrueckung aber uebersprungen. Welches Zeichen das ist, weiss
        // nur der Aufrufer – der Diff-Viewer nennt es, der Quelltext-Editor hat keins.
        const skipped = skipPrefix ? (line.text.match(skipPrefix)?.[0]?.length ?? 0) : 0
        const cols = skipped + leadingCols(line.text.slice(skipped), tabSize)
        if (cols) builder.add(line.from, line.from, lineDeco(cols))
        pos = line.to + 1
      }
    }
    return builder.finish()
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view)
      }
      update(u) {
        // Auch bei `viewportChanged`: gescrollte Zeilen sind vorher nie gemessen worden.
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}

// Die Geometrie, die beide Instanzen teilen: 6px ist CodeMirrors eigenes `.cm-line`-Padding links,
// 3ch der Abstand, an dem man eine Fortsetzung von einer neuen Anweisung unterscheidet (derselbe
// Wert wie in style.css). Als fertige Theme-Extension, damit die Zahlen nicht zweimal dastehen.
export const hangingIndentTheme = EditorView.theme({
  '.cm-line': {
    paddingLeft: 'calc(6px + var(--ind, 0ch) + 3ch)',
    textIndent: 'calc(-1 * (var(--ind, 0ch) + 3ch))',
  },
})
