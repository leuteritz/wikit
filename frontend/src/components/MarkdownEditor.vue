<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { renderClientMarkdown } from '../lib/clientMarkdown.js'
import { useCodeMirrorTheme } from '../composables/useCodeMirrorTheme.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  // Für die `[[`-Vervollständigung. Kommt als Prop und NICHT aus einem eigenen Endpunkt: die Liste
  // liegt im Artikel-Store, den jede Wiki-Ansicht ohnehin lädt – ein `?q=`-Endpunkt wäre Maschinerie
  // für ein paar Dutzend Titel im Speicher.
  articles: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])

// --- `[[` schlägt Artikel vor -------------------------------------------------------------------
// Ohne das ist ein Wikilink eine Gedächtnisleistung: man müsste den Slug kennen, den der Server
// beim Anlegen gebildet hat. Eingesetzt wird deshalb der SLUG, angezeigt der Titel – genau die
// Zuordnung, die man sich sonst merken müsste.
function wikiLinkSource(ctx) {
  const before = ctx.matchBefore(/\[\[([^\]|\n]*)$/)
  if (!before) return null
  const typed = before.text.slice(2).toLowerCase()
  const options = props.articles
    .filter((a) => !typed || a.title.toLowerCase().includes(typed) || a.slug.includes(typed))
    .slice(0, 20)
    .map((a) => ({
      label: a.title,
      // `apply` schreibt die schließenden Klammern gleich mit – eine offene `[[` ist kein Link.
      apply: `${a.slug}|${a.title}]]`,
      detail: a.category?.name || '',
      type: 'text',
    }))
  if (!options.length) return null
  return { from: before.from + 2, options }
}

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
      // ⚠️ `completionKeymap` VOR `defaultKeymap`: sonst schluckt dessen `Escape`-Eintrag das
      // Schliessen der Vorschlagsliste, und `Enter` bestaetigt keinen Vorschlag, sondern bricht
      // die Zeile um.
      keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      autocompletion({ override: [wikiLinkSource], icons: false }),
      markdown(),
      EditorView.lineWrapping,
      themeComp.of(themeExtension()),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem', lineHeight: '1.6' },
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
  <div class="grid h-full grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-2">
    <!-- Editor -->
    <div class="flex min-h-0 flex-col bg-surface-2">
      <div class="border-b border-line px-4 py-2 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-muted">Markdown</div>
      <div ref="editorParent" class="min-h-0 flex-1 overflow-auto px-4"></div>
    </div>
    <!-- Vorschau -->
    <div class="flex min-h-0 flex-col bg-surface-2">
      <div class="border-b border-line px-4 py-2 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-muted">Preview</div>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div class="prose max-w-none dark:prose-invert prose-sm" v-html="previewHtml" />
      </div>
    </div>
  </div>
</template>
