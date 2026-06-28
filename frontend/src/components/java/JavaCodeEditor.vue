<script setup>
// CodeMirror-6-Editor mit Java-Syntax-Highlighting (analog MarkdownEditor.vue).
// v-model-Pattern; das Theme folgt dem App-Theme (oneDark / defaultHighlightStyle).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { useTheme } from '../../composables/useTheme.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '// Java-Code hier einfügen…' },
  // Read-only-Modus: dient als syntaxhervorgehobener Quellcode-Viewer (Detail-Panel).
  readonly: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const { theme } = useTheme()
const editorParent = ref(null)
const themeComp = new Compartment()
let view = null

function themeExtension() {
  return theme.value === 'dark' ? oneDark : syntaxHighlighting(defaultHighlightStyle)
}

onMounted(() => {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    indentUnit.of('    '),
    java(),
    EditorView.lineWrapping,
    themeComp.of(themeExtension()),
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', lineHeight: '1.6' },
      '.cm-content': { padding: '12px 0' },
    }),
  ]
  if (props.readonly) {
    // Reiner Viewer: keine Bearbeitung, keine History/Edit-Keys.
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  } else {
    extensions.push(
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      cmPlaceholder(props.placeholder),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      }),
    )
  }
  const state = EditorState.create({ doc: props.modelValue, extensions })
  view = new EditorView({ state, parent: editorParent.value })
})

// Externe Aenderungen (z. B. Datei-Upload) in den Editor spiegeln.
watch(() => props.modelValue, (val) => {
  if (view && val !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } })
  }
})

watch(theme, () => {
  view?.dispatch({ effects: themeComp.reconfigure(themeExtension()) })
})

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div
    ref="editorParent"
    class="h-full min-h-0 overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
  />
</template>
