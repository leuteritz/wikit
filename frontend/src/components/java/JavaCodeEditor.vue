<script setup>
// CodeMirror-6-Editor mit Java-Syntax-Highlighting (analog MarkdownEditor.vue).
// v-model-Pattern; das Theme folgt dem App-Theme (oneDark / defaultHighlightStyle).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder as cmPlaceholder, Decoration } from '@codemirror/view'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import { useCodeMirrorTheme } from '../../composables/useCodeMirrorTheme.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '// Paste Java code here…' },
  // Read-only-Modus: dient als syntaxhervorgehobener Quellcode-Viewer (Detail-Panel).
  readonly: { type: Boolean, default: false },
  // Methodennamen, die als Call-Edge existieren -> im Quellcode klickbar gemacht (dezent
  // unterstrichen). Ein Klick auf so ein Token emittiert `method-click` (Graph-Highlight).
  clickableWords: { type: Array, default: () => [] },
  // Aktuell hervorgehobener Methodenname (reaktiv, aus dem geteilten highlightedCall-State).
  // Setzen/Loeschen der aktiven Token-Markierung folgt diesem Prop -> KEIN imperatives Setzen mehr.
  activeCall: { type: String, default: null },
  // SOURCE-Seite (eingehende Kanten): Methoden-DEFINITIONEN, die von anderen Klassen aufgerufen
  // werden -> im Quellcode klickbar. Ein Klick emittiert `def-click` (Graph-Highlight der
  // eingehenden Kanten + Ganz-Block-Markierung dieser Methode).
  defWords: { type: Array, default: () => [] },
  // Aktuell markierter Methodenbereich (reaktiv, aus dem geteilten highlightedDef-State):
  // { from, to } (1-basierte Zeilen) | null. Treibt die persistente Block-Decoration.
  activeDefRange: { type: Object, default: null },
  // Code-Suche: ALLE Treffer als Dokument-Offsets [{from,to}] (berechnet in lib/codeSearch.js,
  // gehalten von der Suchleiste im Detail-Panel) und der Index des aktiven Treffers (-1 = keiner).
  // Der Editor rechnet nichts – er markiert und scrollt nur.
  searchMatches: { type: Array, default: () => [] },
  searchActive: { type: Number, default: -1 },
})
const emit = defineEmits(['update:modelValue', 'method-click', 'clear-call', 'def-click', 'clear-def', 'select-word'])

// Code-Flaeche: dasselbe Material wie jeder Shiki-Block, deshalb themenunabhaengig dunkel.
const { themeComp, themeExtension, bindTheme } = useCodeMirrorTheme()
const editorParent = ref(null)
let view = null
let glowTimer = null
bindTheme(() => view)

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

// --- Source-Methoden-Highlight (SOURCE-Seite: eingehende Kanten) ---------------
// Zweite, UNABHAENGIGE Block-Decoration (eigene Klasse `cm-source-method-highlight`, Violett).
// Bewusst getrennt von setMethodRange/`cm-method-highlight` (Edge-Panel „Definiert in"), damit
// sich beide nicht in die Quere kommen und die Richtung (eingehend) farblich eigenstaendig bleibt.
// Reaktiv getrieben von props.activeDefRange (kein imperatives Setzen von aussen).
const setSourceMethodRange = StateEffect.define() // value: { from, to } (1-basiert) | null
const sourceMethodLineDeco = Decoration.line({ class: 'cm-source-method-highlight' })
const sourceMethodField = StateField.define({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setSourceMethodRange)) continue
      if (!e.value) {
        deco = Decoration.none
        continue
      }
      const ranges = []
      for (let n = e.value.from; n <= e.value.to; n++) {
        ranges.push(sourceMethodLineDeco.range(tr.state.doc.line(n).from))
      }
      deco = Decoration.set(ranges)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Reaktiv an props.activeDefRange ausrichten: Bereich gesetzt -> ganze Methode markieren + an den
// Anfang scrollen; null -> Markierung entfernen.
function applyActiveDefRange(range) {
  if (!view) return
  if (!range || !range.from) {
    view.dispatch({ effects: setSourceMethodRange.of(null) })
    return
  }
  const total = view.state.doc.lines
  const from = Math.max(1, Math.min(Number(range.from), total))
  const to = Math.max(from, Math.min(Number(range.to || range.from), total))
  view.dispatch({
    effects: [
      setSourceMethodRange.of({ from, to }),
      EditorView.scrollIntoView(view.state.doc.line(from).from, { y: 'center' }),
    ],
  })
}

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

// --- Code-Suche (Suchleiste im Detail-Panel) ----------------------------------
// Zwei Mark-Ebenen nach demselben Muster: alle Treffer dezent, der aktive kraeftig. Die Trefferliste
// kommt fertig als Prop – dieselben Offsets, aus denen die Leiste ihren Zaehler bildet, also kann
// „3 von 12" nicht von dem abweichen, was im Code leuchtet.
const setSearchMarks = StateEffect.define() // value: [{from,to}] | null
const setActiveMatch = StateEffect.define() // value: [{from,to}] | null
const searchMark = Decoration.mark({ class: 'cm-search-match' })
const activeMatchMark = Decoration.mark({ class: 'cm-search-active' })
const searchField = markField(setSearchMarks, searchMark)
const activeMatchField = markField(setActiveMatch, activeMatchMark)

// Treffer-Markierung an die Props angleichen. Der aktive Treffer wird aus der Sammel-Ebene
// herausgenommen (statt beide Marks zu stapeln), damit seine Farbe nicht die des Untergrunds erbt.
// Gescrollt wird NUR, wenn der aktive Treffer nicht genau die aktuelle Selektion ist: sonst
// ruckelte das Bild bei jeder Doppelklick-Uebernahme, obwohl die Stelle schon vor Augen liegt.
function applySearch() {
  if (!view) return
  const list = props.searchMatches || []
  const i = props.searchActive
  const active = i >= 0 && i < list.length ? list[i] : null
  const rest = active ? list.filter((_, n) => n !== i) : list
  const effects = [setSearchMarks.of(rest), setActiveMatch.of(active ? [active] : null)]
  if (active) {
    const sel = view.state.selection.main
    if (sel.from !== active.from || sel.to !== active.to) {
      effects.push(EditorView.scrollIntoView(active.from, { y: 'center' }))
    }
  }
  view.dispatch({ effects })
}

// Aktuelle Selektion nach oben melden (speist die Suchleiste). Bewusst an mouseup/keyup statt an
// einen updateListener gehaengt: waehrend des Ziehens ist die Selektion ein Zwischenstand, und jeder
// davon wuerde die Suche neu anwerfen. Mehrzeilige oder sehr lange Selektionen sind kein Suchbegriff.
function reportSelection(v) {
  const sel = v.state.selection.main
  if (sel.empty) return
  const text = v.state.sliceDoc(sel.from, sel.to)
  if (!text.trim() || text.length > 80 || text.includes('\n')) return
  emit('select-word', { text, from: sel.from })
}

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

// Aktive Call-Markierung reaktiv an `props.activeCall` ausrichten: Name gesetzt -> alle Vorkommen
// markieren + erstes ansteuern; null -> Markierung entfernen. Wird aus dem watch + onMounted
// aufgerufen (kein imperativer Aufruf von aussen mehr).
function applyActiveCall(name) {
  if (!view) return
  if (!name) {
    view.dispatch({ effects: setCallMarks.of(null) })
    return
  }
  const ranges = scanCalls(view.state.doc.toString(), [name])
  const effects = [setCallMarks.of(ranges)]
  if (ranges.length) effects.push(EditorView.scrollIntoView(ranges[0].from, { y: 'center' }))
  view.dispatch({ effects })
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
defineExpose({ highlightLine, highlightMethod, clearMethodHighlight })

// Klickbaren Methodennamen an der Klick-Position ermitteln (fuer mousedown/contextmenu).
// Rueckgabe: der Name, falls er in props.clickableWords ist, sonst null.
function clickableWordAt(event, v) {
  const words = props.clickableWords
  if (!words || !words.length) return null
  const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos == null) return null
  const w = v.state.wordAt(pos)
  if (!w) return null
  const word = v.state.sliceDoc(w.from, w.to)
  return words.includes(word) ? word : null
}

// Klickbaren Methoden-DEFINITIONSnamen (SOURCE-Seite) an der Klick-Position ermitteln.
// Rueckgabe: der Name, falls er in props.defWords ist, sonst null. (Getrennt von clickableWordAt,
// damit die Consumer-Erkennung unveraendert bleibt.)
function defWordAt(event, v) {
  const words = props.defWords
  if (!words || !words.length) return null
  const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos == null) return null
  const w = v.state.wordAt(pos)
  if (!w) return null
  const word = v.state.sliceDoc(w.from, w.to)
  return words.includes(word) ? word : null
}

onMounted(() => {
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    glowField,
    methodField,
    sourceMethodField,
    linkField,
    callField,
    searchField,
    activeMatchField,
    // Klick (links ODER rechts – mousedown feuert fuer beide Buttons):
    //   - auf eine Consumer-Call-Site (clickableWords) -> method-click (ausgehende Kante)
    //   - sonst auf eine Methoden-Definition mit eingehender Kante (defWords) -> def-click
    //   - sonst (leere Flaeche / anderes Token) -> beide Highlights loeschen
    // Consumer hat Vorrang (identischer Pfad wie bisher). Selektion/Caret bleiben unblockiert.
    EditorView.domEventHandlers({
      mousedown(event, v) {
        const word = clickableWordAt(event, v)
        if (word) {
          emit('method-click', { name: word })
          return false
        }
        const def = defWordAt(event, v)
        if (def) {
          emit('def-click', { name: def })
          return false
        }
        emit('clear-call')
        emit('clear-def')
        return false
      },
      // Fertige Maus-Selektion (auch der Doppelklick aufs Wort) -> Suchbegriff melden.
      mouseup(event, v) {
        reportSelection(v)
        return false
      },
      // Tastatur-Selektion (Shift+Pfeil/Shift+Ende) – derselbe Weg, damit die Maus nicht Pflicht ist.
      keyup(event, v) {
        if (event.shiftKey) reportSelection(v)
        return false
      },
      // Rechtsklick auf eine klickbare Methode (Consumer ODER Definition): natives Kontextmenue
      // unterdruecken (der Toggle wurde bereits vom vorausgehenden mousedown erledigt).
      contextmenu(event, v) {
        if (clickableWordAt(event, v) || defWordAt(event, v)) {
          event.preventDefault()
          return true
        }
        return false
      },
    }),
    indentUnit.of('    '),
    java(),
    EditorView.lineWrapping,
    themeComp.of(themeExtension()),
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem', lineHeight: '1.6' },
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
  applyActiveCall(props.activeCall) // evtl. bereits gesetztes Highlight sofort spiegeln
  applyActiveDefRange(props.activeDefRange) // evtl. bereits gesetzten Methodenbereich spiegeln
  applySearch() // laufende Suche ueberlebt den Tab-Wechsel (der Editor wird dabei neu gemountet)
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

// Reaktive Call-Token-Markierung: folgt dem geteilten Highlight-State (Setzen/Wechseln/Loeschen).
watch(() => props.activeCall, (name) => applyActiveCall(name))

// Reaktive Source-Methoden-Block-Markierung: folgt props.activeDefRange (Setzen/Wechseln/Loeschen).
watch(() => props.activeDefRange, (range) => applyActiveDefRange(range))

// Treffer-Markierung der Code-Suche: folgt Trefferliste UND aktivem Index (ein watch fuer beides,
// sonst wuerde ein Wechsel der Liste zweimal dispatchen).
watch(() => [props.searchMatches, props.searchActive], applySearch)

onBeforeUnmount(() => {
  clearTimeout(glowTimer)
  view?.destroy()
})
</script>

<template>
  <div
    ref="editorParent"
    class="h-full min-h-0 overflow-auto rounded-xl border border-line bg-surface px-3"
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

/* Source-Methoden-Markierung (SOURCE-Seite: „wer ruft DIESE Methode auf?"). Eigene Farbe
   (Violett) -> klar unterscheidbar von der Consumer-Token-Markierung (Gold), dem Indigo der
   „Definiert in"-Navigation und dem amber Such-Glow. Gleiche Balken-Optik wie cm-method-highlight,
   damit „ganze Methode markiert" konsistent wirkt. */
.cm-source-method-highlight {
  --cm-source: 139, 92, 246; /* violet-500 */
  background-color: rgba(var(--cm-source), 0.12);
  box-shadow: inset 3px 0 0 0 rgba(var(--cm-source), 0.85);
}
html.dark .cm-source-method-highlight {
  --cm-source: 167, 139, 250; /* violet-400, kräftiger auf dunklem Grund */
  background-color: rgba(var(--cm-source), 0.18);
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

/* Code-Suche: dieselbe Gold-Familie wie `mark` in style.css – „Suchtreffer sieht in Wikit so aus".
   Der AKTIVE Treffer trennt sich nicht ueber eine zweite Farbe, sondern ueber Deckkraft + Ring:
   eine dritte Bedeutung fuer eine neue Hue haette der Editor (Gold=Call, Indigo/Violett=Methode,
   Amber=Sprung) nicht mehr frei. */
.cm-search-match {
  background-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
  border-radius: 2px;
}
.cm-search-active {
  background-color: color-mix(in srgb, var(--color-warning) 85%, transparent);
  border-radius: 2px;
  box-shadow: 0 0 0 1px var(--color-warning);
  color: #17160f; /* dunkler Text – die volle Goldflaeche traegt keine Shiki-/oneDark-Farbe mehr */
}
</style>
