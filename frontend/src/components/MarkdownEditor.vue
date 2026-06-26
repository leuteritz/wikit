<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { renderClientMarkdown } from '../lib/clientMarkdown.js'
import { useTheme } from '../composables/useTheme.js'

const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])

const { theme } = useTheme()
const editorParent = ref(null)
const themeComp = new Compartment()
let view = null

const previewHtml = computed(() => renderClientMarkdown(props.modelValue))

function themeExtension() {
  return theme.value === 'dark' ? oneDark : syntaxHighlighting(defaultHighlightStyle)
}

onMounted(() => {
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      themeComp.of(themeExtension()),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', lineHeight: '1.6' },
        '.cm-content': { padding: '12px 0' },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      }),
    ],
  })
  view = new EditorView({ state, parent: editorParent.value })
})

// Externe Aenderungen (z. B. beim Laden eines Artikels) in den Editor spiegeln.
watch(() => props.modelValue, (val) => {
  if (view && val !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } })
  }
})

// Editor-Theme dem App-Theme folgen lassen.
watch(theme, () => {
  view?.dispatch({ effects: themeComp.reconfigure(themeExtension()) })
})

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div class="grid h-full grid-cols-1 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 lg:grid-cols-2 dark:border-slate-800 dark:bg-slate-800">
    <!-- Editor -->
    <div class="flex min-h-0 flex-col bg-white dark:bg-slate-900">
      <div class="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">Markdown</div>
      <div ref="editorParent" class="min-h-0 flex-1 overflow-auto px-4"></div>
    </div>
    <!-- Vorschau -->
    <div class="flex min-h-0 flex-col bg-white dark:bg-slate-900">
      <div class="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">Vorschau</div>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div class="prose prose-slate max-w-none dark:prose-invert prose-sm" v-html="previewHtml" />
      </div>
    </div>
  </div>
</template>
