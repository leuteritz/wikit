// Farbgebung fuer alle CodeMirror-6-Instanzen (JavaCodeEditor, JavaDiffViewer, MarkdownEditor).
// Vorher stand in jeder dieser drei Komponenten derselbe Dreiklang: ein `Compartment`, eine
// `themeExtension()`-Funktion und ein `watch(theme, ...)`-Reconfigure.
//
// Nutzung:
//   const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme()          // Quelltext
//   const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme('prose')   // Fliesstext
//   ... extensions: [ themeComp.of(themeExtension()) ] ...
//   bindTheme(() => view)   // Getter, weil `view` erst in onMounted entsteht
//
// ZWEI FLAECHEN, nicht eine:
//   'code'  – ein Editor, in dem QUELLTEXT steht, ist dasselbe Material wie jeder andere
//             Code-Block der App (`--color-code`, s. style.css) und damit IMMER dunkel, auch im
//             Light-Mode. `oneDark` liefert die Syntaxfarben; seine eigenen Flaechen (#282c34,
//             Gutter #21252b) werden ueberschrieben – sonst laege ein kuehles Blaugrau neben den
//             warmen Shiki-Bloecken derselben Ansicht.
//   'prose'  – der Markdown-Editor ist eine SCHREIBflaeche mit Prosa-Vorschau daneben. Er folgt
//             deshalb dem Theme; ein dunkler Editor neben heller Vorschau waere genau der Bruch,
//             den die Code-Flaeche gerade beseitigt. Im Light-Mode bringt `defaultHighlightStyle`
//             keinerlei Flaechenfarbe mit, deshalb steht sie hier ausdruecklich da.
//
// Frische Instanz pro Aufruf (KEIN Modul-Singleton): jede Editor-Instanz braucht ihr eigenes
// Compartment, sonst wuerde ein Reconfigure in die falsche EditorView dispatchen.
import { watch } from 'vue'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { useTheme } from './useTheme.js'

// ⚠️ Bewusst `oneDarkHighlightStyle` statt `oneDark`: das Paket buendelt Syntaxfarben UND Flaechen
// (`oneDarkTheme`), und dessen Flaechen sind ein kuehles Blaugrau (#282c34, Gutter #21252b). Ein
// zweites `EditorView.theme` daneben zu legen und auf die Reihenfolge zu hoffen, ist keine
// Entscheidung – gemessen gewinnt `oneDarkTheme`. Genommen wird deshalb nur, was gebraucht wird
// (die Token-Farben), und die Flaechen stehen hier vollstaendig und an EINER Stelle.
const CODE_SURFACE = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--color-code)', color: 'var(--color-code-ink)' },
    '.cm-content': { caretColor: 'var(--color-accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 9%, transparent)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-warning) 22%, transparent)' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-warning) 28%, transparent)',
      outline: '1px solid var(--color-code-line)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--color-warning) 52%, transparent)',
    },
    '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-code-2)',
      color: 'var(--color-code-muted)',
      border: 'none',
      borderRight: '1px solid var(--color-code-line)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-code-ink)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--color-code-muted)',
    },
    '.cm-panels': { backgroundColor: 'var(--color-code-2)', color: 'var(--color-code-ink)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--color-code-line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-code-line)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-code-2)',
      border: '1px solid var(--color-code-line)',
    },
  },
  { dark: true },
)

// Schreibflaeche: folgt dem Theme, traegt aber – wie die Code-Flaeche – ihren Grund selbst.
// Vorher hatte sie im Light-Mode GAR keine Flaechenfarbe (`defaultHighlightStyle` bringt keine
// mit) und uebernahm im Dark-Mode das Blaugrau von `oneDarkTheme`; beides waren Zufallswerte.
const proseSurface = (dark) =>
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text)' },
      '.cm-content': { caretColor: 'var(--color-accent)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--color-accent) 26%, transparent)',
      },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' },
      '.cm-gutters': {
        backgroundColor: 'var(--color-surface-2)',
        color: 'var(--color-text-muted)',
        border: 'none',
        borderRight: '1px solid var(--color-border)',
      },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-text)' },
    },
    { dark },
  )

export function useCodeMirrorTheme(surface = 'code') {
  const { theme } = useTheme()
  const themeComp = new Compartment()

  const themeExtension = () => {
    if (surface === 'code') return [syntaxHighlighting(oneDarkHighlightStyle), CODE_SURFACE]
    const dark = theme.value === 'dark'
    return [
      syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
      proseSurface(dark),
    ]
  }

  function bindTheme(getView) {
    // Die Code-Flaeche haengt nicht mehr am Theme – ohne diesen Ausstieg dispatchte jeder
    // Theme-Wechsel ein Reconfigure, das nichts aendert.
    if (surface === 'code') return
    watch(theme, () => {
      getView()?.dispatch({ effects: themeComp.reconfigure(themeExtension()) })
    })
  }

  return { themeComp, themeExtension, bindTheme }
}
