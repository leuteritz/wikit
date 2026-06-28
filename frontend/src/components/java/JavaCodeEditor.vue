<script setup>
// CodeMirror-6-Editor mit Java-Syntax-Highlighting (analog MarkdownEditor.vue).
// v-model-Pattern; das Theme folgt dem App-Theme (oneDark / defaultHighlightStyle).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder as cmPlaceholder, Decoration } from '@codemirror/view'
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state'
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
let glowTimer = null

function themeExtension() {
  return theme.value === 'dark' ? oneDark : syntaxHighlighting(defaultHighlightStyle)
}

// --- Zeilen-Highlight (Such-Sprung / Edge-Panel-Navigation) -------------------
// StateEffects setzen/loeschen eine Line-Decoration; ein StateField haelt sie. So kann
// die Glow-Markierung gezielt gesetzt und nach 2500 ms wieder entfernt werden.
const addGlow = StateEffect.define()
const clearGlow = StateEffect.define()
const glowDeco = Decoration.line({ class: 'cm-glow-line' })
const glowField = StateField.define({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(addGlow)) deco = Decoration.set([glowDeco.range(e.value)])
      else if (e.is(clearGlow)) deco = Decoration.none
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Oeffentliche API: zur (1-basierten) Zeile scrollen + kurz hervorheben (auto-fade nach 2,5 s).
function highlightLine(lineNumber) {
  if (!view || !lineNumber) return
  const total = view.state.doc.lines
  const n = Math.max(1, Math.min(Number(lineNumber), total))
  const line = view.state.doc.line(n)
  clearTimeout(glowTimer)
  view.dispatch({
    effects: [addGlow.of(line.from), EditorView.scrollIntoView(line.from, { y: 'center' })],
  })
  glowTimer = setTimeout(() => {
    view?.dispatch({ effects: clearGlow.of(null) })
  }, 2500)
}
defineExpose({ highlightLine })

onMounted(() => {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    glowField,
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

onBeforeUnmount(() => {
  clearTimeout(glowTimer)
  view?.destroy()
})
</script>

<template>
  <div
    ref="editorParent"
    class="h-full min-h-0 overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
  />
</template>

<!--
  Global (NICHT scoped): die Glow-Zeile ist CodeMirror-generiertes DOM ohne data-v-Attribut,
  scoped-Styles wuerden nicht greifen. Klassenname `cm-glow-line` ist spezifisch genug.
  Theme-Anpassung via CSS-Variable (analog zu Shikis html.dark-Umschaltung).
-->
<style>
.cm-glow-line {
  --cm-glow: 234, 179, 8; /* amber-500 */
  border-radius: 3px;
  animation: cm-glow-fade 2.5s ease-out forwards;
}
html.dark .cm-glow-line {
  --cm-glow: 250, 204, 21; /* amber-400, kräftiger auf dunklem Grund */
}
@keyframes cm-glow-fade {
  0% {
    background-color: rgba(var(--cm-glow), 0.55);
    box-shadow: inset 3px 0 0 0 rgba(var(--cm-glow), 0.9);
  }
  55% {
    background-color: rgba(var(--cm-glow), 0.3);
    box-shadow: inset 3px 0 0 0 rgba(var(--cm-glow), 0.6);
  }
  100% {
    background-color: rgba(var(--cm-glow), 0);
    box-shadow: inset 3px 0 0 0 rgba(var(--cm-glow), 0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cm-glow-line {
    animation: none;
    background-color: rgba(var(--cm-glow), 0.28);
  }
}
</style>
