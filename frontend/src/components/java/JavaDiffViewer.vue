<script setup>
// Read-only-Viewer fuer einen Unified-Diff (git/SVN-Stil) mit Java-Syntax-Highlighting.
// Analog JavaCodeEditor.vue: CodeMirror 6, Theme folgt dem App-Theme (oneDark / defaultHighlightStyle).
// Zusaetzlich eine zeilenweise Decoration nach Diff-Praefix: `+` gruen, `-` rot, Header/@@ gedaempft.
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, lineNumbers, Decoration } from '@codemirror/view'
import { EditorState, StateField } from '@codemirror/state'
import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import { useCodeMirrorTheme } from '../../composables/useCodeMirrorTheme.js'

const props = defineProps({
  diff: { type: String, default: '' },
})

// Dark/Light-Umschaltung zentral (identisch in JavaCodeEditor/MarkdownEditor).
const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme()
const editorParent = ref(null)
let view = null
bindTheme(() => view)

// Zeilenweise Diff-Decoration aus dem Dokument aufbauen: `+`-Zeilen gruen, `-`-Zeilen rot,
// Datei-/Hunk-Header (---/+++/@@/Index:/diff) gedaempft. Reihenfolge der Checks beachten:
// die `---`/`+++`-Header MUESSEN vor den generischen `-`/`+`-Faellen stehen.
function classForLine(text) {
  if (
    text.startsWith('+++') ||
    text.startsWith('---') ||
    text.startsWith('@@') ||
    text.startsWith('Index:') ||
    text.startsWith('diff ') ||
    text.startsWith('===')
  ) {
    return 'cm-diff-meta'
  }
  if (text.startsWith('+')) return 'cm-diff-added'
  if (text.startsWith('-')) return 'cm-diff-removed'
  return null
}

function buildDiffDeco(state) {
  const ranges = []
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    const cls = classForLine(line.text)
    if (cls) ranges.push(Decoration.line({ class: cls }).range(line.from))
  }
  return Decoration.set(ranges)
}

const diffField = StateField.define({
  create(state) {
    return buildDiffDeco(state)
  },
  update(deco, tr) {
    return tr.docChanged ? buildDiffDeco(tr.state) : deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

onMounted(() => {
  const extensions = [
    lineNumbers(),
    diffField,
    indentUnit.of('    '),
    java(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    themeComp.of(themeExtension()),
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', lineHeight: '1.6' },
      '.cm-content': { padding: '8px 0' },
    }),
  ]
  const state = EditorState.create({ doc: props.diff || '', extensions })
  view = new EditorView({ state, parent: editorParent.value })
})

// Externe Diff-Aenderung in den Viewer spiegeln (docChanged -> Decoration wird neu berechnet).
watch(
  () => props.diff,
  (val) => {
    if (view && val !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val || '' } })
    }
  },
)

onBeforeUnmount(() => {
  view?.destroy()
})
</script>

<template>
  <div
    ref="editorParent"
    class="h-full min-h-0 overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
  />
</template>
