<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { renderClientMarkdown } from '../lib/clientMarkdown.js'
import { useCodeMirrorTheme } from '../composables/useCodeMirrorTheme.js'

const props = defineProps({ modelValue: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])

// Dark/Light-Umschaltung zentral (identisch in JavaCodeEditor/JavaDiffViewer).
const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme()
const editorParent = ref(null)
let view = null

const previewHtml = computed(() => renderClientMarkdown(props.modelValue))
bindTheme(() => view)

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

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div class="grid h-full grid-cols-1 gap-px overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-border)] lg:grid-cols-2">
    <!-- Editor -->
    <div class="flex min-h-0 flex-col bg-[var(--color-surface-2)]">
      <div class="border-b border-[var(--color-border)] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Markdown</div>
      <div ref="editorParent" class="min-h-0 flex-1 overflow-auto px-4"></div>
    </div>
    <!-- Vorschau -->
    <div class="flex min-h-0 flex-col bg-[var(--color-surface-2)]">
      <div class="border-b border-[var(--color-border)] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Preview</div>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div class="prose max-w-none dark:prose-invert prose-sm" v-html="previewHtml" />
      </div>
    </div>
  </div>
</template>
