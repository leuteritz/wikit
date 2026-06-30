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
  placeholder: { type: String, default: '// Paste Java code here…' },
  // Read-only-Modus: dient als syntaxhervorgehobener Quellcode-Viewer (Detail-Panel).
  readonly: { type: Boolean, default: false },
  // Methodennamen, die als Call-Edge existieren -> im Quellcode klickbar gemacht (dezent
  // unterstrichen). Ein Klick auf so ein Token emittiert `method-click` (Graph-Highlight).
  clickableWords: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'method-click'])

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

// --- Methoden-Bereich-Highlight (Edge-Panel „Definiert in") -------------------
// Persistente Mehrzeilen-Decoration: hebt den GESAMTEN Methodenbereich (Signatur bis schliessende
// Klammer) farbig hervor. Bleibt stehen, bis eine andere Methode/ein anderes Ziel gewaehlt wird
// (kein auto-fade wie der Such-Glow) – eine eigene Farbe macht „Methode markiert" vs.
// „Zeile gesprungen" unterscheidbar.
const setMethodRange = StateEffect.define() // value: { from, to } (1-basiert) | null
const methodLineDeco = Decoration.line({ class: 'cm-method-highlight' })
const methodField = StateField.define({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setMethodRange)) continue
      if (!e.value) {
        deco = Decoration.none
        continue
      }
      const ranges = []
      for (let n = e.value.from; n <= e.value.to; n++) {
        ranges.push(methodLineDeco.range(tr.state.doc.line(n).from))
      }
      deco = Decoration.set(ranges)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// --- Call-Highlight (Code-Token <-> Graph-Edge) -------------------------------
// Zwei Mark-Decorations auf Methodennamen-Tokens (Zeichenbereiche, nicht ganze Zeilen):
//   1) cm-call-link: passiv, ALLE klickbaren Call-Sites (props.clickableWords) -> dezent
//      unterstrichen, signalisiert „klickbar".
//   2) cm-call-active: der zuletzt angeklickte Methodenname (alle Vorkommen) -> Hintergrund in
//      --color-edge-highlight, exakt dieselbe Farbe wie die aufleuchtende Graph-Kante.
const setLinkMarks = StateEffect.define() // value: [{from,to}] | null
const setCallMarks = StateEffect.define() // value: [{from,to}] | null
const linkMark = Decoration.mark({ class: 'cm-call-link' })
const callMark = Decoration.mark({ class: 'cm-call-active' })
function markField(effect, mark) {
  return StateField.define({
    create() {
      return Decoration.none
    },
    update(deco, tr) {
      deco = deco.map(tr.changes)
      for (const e of tr.effects) {
        if (!e.is(effect)) continue
        deco = e.value && e.value.length ? Decoration.set(e.value.map((r) => mark.range(r.from, r.to))) : Decoration.none
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}
const linkField = markField(setLinkMarks, linkMark)
const callField = markField(setCallMarks, callMark)

// Methodennamen-Aufrufstellen (`name(`) im Dokument finden -> Zeichenbereiche des Namens (ohne die
// Klammer). Regex analog zu computeCallEdgeData in JavaDependencyGraph; global -> aufsteigend sortiert.
function scanCalls(text, names) {
  const list = (names || []).filter(Boolean)
  if (!list.length) return []
  const alt = list.map((n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`\\b(${alt})\\s*\\(`, 'g')
  const out = []
  let m
  while ((m = re.exec(text)) !== null) out.push({ from: m.index, to: m.index + m[1].length })
  return out
}

// Passive „klickbar"-Markierung aller Call-Sites neu setzen (bei Mount, Quelltext- oder
// clickableWords-Aenderung).
function refreshLinks() {
  if (!view) return
  view.dispatch({ effects: setLinkMarks.of(scanCalls(view.state.doc.toString(), props.clickableWords)) })
}

// Oeffentliche API: alle Vorkommen EINES Methodennamens aktiv markieren + erstes ansteuern.
function setActiveCall(name) {
  if (!view || !name) return
  const ranges = scanCalls(view.state.doc.toString(), [name])
  const effects = [setCallMarks.of(ranges)]
  if (ranges.length) effects.push(EditorView.scrollIntoView(ranges[0].from, { y: 'center' }))
  view.dispatch({ effects })
}
function clearActiveCall() {
  view?.dispatch({ effects: setCallMarks.of(null) })
}

// Oeffentliche API: zur (1-basierten) Zeile scrollen + kurz hervorheben (auto-fade nach 2,5 s).
function highlightLine(lineNumber) {
  if (!view || !lineNumber) return
  clearMethodHighlight() // ein Einzelzeilen-Sprung raeumt eine evtl. stehende Methoden-Markierung
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

// Oeffentliche API: den kompletten Methodenbereich (1-basiert, inkl. End-Zeile) markieren + an den
// Anfang scrollen. Persistent bis zur naechsten Markierung/Clear.
function highlightMethod(startLine, endLine) {
  if (!view || !startLine) return
  const total = view.state.doc.lines
  const from = Math.max(1, Math.min(Number(startLine), total))
  const to = Math.max(from, Math.min(Number(endLine || startLine), total))
  view.dispatch({
    effects: [
      setMethodRange.of({ from, to }),
      EditorView.scrollIntoView(view.state.doc.line(from).from, { y: 'center' }),
    ],
  })
}
function clearMethodHighlight() {
  view?.dispatch({ effects: setMethodRange.of(null) })
}
defineExpose({ highlightLine, highlightMethod, clearMethodHighlight, setActiveCall, clearActiveCall })

onMounted(() => {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    glowField,
    methodField,
    linkField,
    callField,
    // Klick auf einen klickbaren Methodennamen -> Graph-Highlight ausloesen (Selektion nicht blocken).
    EditorView.domEventHandlers({
      mousedown(event, v) {
        const words = props.clickableWords
        if (!words || !words.length) return false
        const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const w = v.state.wordAt(pos)
        if (!w) return false
        const word = v.state.sliceDoc(w.from, w.to)
        if (words.includes(word)) emit('method-click', { name: word })
        return false
      },
    }),
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
  refreshLinks()
})

// Externe Aenderungen (z. B. Datei-Upload) in den Editor spiegeln.
watch(() => props.modelValue, (val) => {
  if (view && val !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } })
    refreshLinks()
  }
})

// Klickbare Methodennamen aenderten sich (Edge wurde angelegt/geloescht oder Klasse gewechselt).
watch(() => props.clickableWords, refreshLinks)

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

/* Persistente Methoden-Markierung (Edge-Panel „Definiert in"): ruhiger Accent-Tint + linker
   Balken auf jeder Zeile des Methodenbereichs. Eigene Farbe (Indigo) -> klar abgegrenzt vom
   amber Such-Glow. Dark-Variante kraeftiger fuer Kontrast auf dunklem Grund. */
.cm-method-highlight {
  --cm-method: 99, 102, 241; /* indigo-500 */
  background-color: rgba(var(--cm-method), 0.12);
  box-shadow: inset 3px 0 0 0 rgba(var(--cm-method), 0.85);
}
html.dark .cm-method-highlight {
  --cm-method: 129, 140, 248; /* indigo-400, kräftiger auf dunklem Grund */
  background-color: rgba(var(--cm-method), 0.18);
}

/* Call-Token-Markierung (Code <-> Graph-Edge): Farbe kommt aus --color-edge-highlight, exakt
   identisch zur aufleuchtenden Graph-Kante. Passiv = dezent gepunktet unterstrichen (klickbar),
   aktiv = ausgefuellter Hintergrund. Variable funktioniert in Light + Dark (in style.css definiert). */
.cm-call-link {
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-edge-highlight) 70%, transparent);
  text-underline-offset: 3px;
  cursor: pointer;
}
.cm-call-link:hover {
  text-decoration-color: var(--color-edge-highlight);
  background-color: color-mix(in srgb, var(--color-edge-highlight) 12%, transparent);
  border-radius: 3px;
}
.cm-call-active {
  background-color: color-mix(in srgb, var(--color-edge-highlight) 32%, transparent);
  border-radius: 3px;
  box-shadow: inset 0 -2px 0 0 var(--color-edge-highlight);
}
</style>
