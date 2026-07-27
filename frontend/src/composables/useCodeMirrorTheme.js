// Dark/Light-Umschaltung fuer alle CodeMirror-6-Instanzen (JavaCodeEditor, JavaDiffViewer,
// MarkdownEditor). Vorher stand in jeder dieser drei Komponenten derselbe Dreiklang: ein
// `Compartment`, eine `themeExtension()`-Funktion und ein `watch(theme, ...)`-Reconfigure.
//
// Nutzung:
//   const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme()
//   ... extensions: [ themeComp.of(themeExtension()) ] ...
//   bindTheme(() => view)   // Getter, weil `view` erst in onMounted entsteht
//
// Frische Instanz pro Aufruf (KEIN Modul-Singleton): jede Editor-Instanz braucht ihr eigenes
// Compartment, sonst wuerde ein Reconfigure in die falsche EditorView dispatchen.
import { watch } from 'vue'
import { Compartment } from '@codemirror/state'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { useTheme } from './useTheme.js'

export function useCodeMirrorTheme() {
  const { theme } = useTheme()
  const themeComp = new Compartment()

  const themeExtension = () =>
    theme.value === 'dark' ? oneDark : syntaxHighlighting(defaultHighlightStyle)

  function bindTheme(getView) {
    watch(theme, () => {
      getView()?.dispatch({ effects: themeComp.reconfigure(themeExtension()) })
    })
  }

  return { themeComp, themeExtension, bindTheme }
}
