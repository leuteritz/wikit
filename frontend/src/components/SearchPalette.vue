<script setup>
// Globale Suche (Strg+K). Drei Quellen in EINER Liste, dazu eine Vorschau rechts.
//
// Warum zwei Requests statt einem: `/api/search` beantwortet „welches DING heisst so?" (Artikel,
// Klassen, Methoden – FTS5 bzw. Namensvergleich, billig). `/api/java/code-search` beantwortet
// „WO STEHT das im Code?" – zeilengenau, mit denselben Schaltern wie die Suchleiste im
// Quellcode-Tab (Case / ganzes Wort / Regex). FTS5 kann diese Schalter prinzipiell nicht (der
// Tokenizer wirft Interpunktion weg und matcht nur Token-Praefixe), deshalb ist die Codesuche ein
// eigener Weg und kein weiterer Zweig im FTS.
//
// Die Vorschau rechts ist der eigentliche Zweck: ein Treffer im Code ohne seinen Code ist nur die
// Behauptung, dass es ihn gibt. Sie zeigt sofort den Ausschnitt aus dem Suchergebnis (kommt ohne
// zweiten Request mit) und tauscht ihn gegen das server-gehighlightete Fenster, sobald das da ist.
// Der Ausschnitt richtet sich dabei nach der FRAGE, nicht nach der Trefferart: ein Treffer auf den
// Klassennamen meint die Klasse, also steht dort ihr ganzer Quelltext (`wantsFullClass`); ein
// Treffer im Quelltext meint die Stelle, also das Fenster darum.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import { useSearch } from '../composables/useSearch.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { api } from '../lib/api.js'
import { buildSearchRegex } from '../lib/codeSearch.js'
import { addLineNumbers, buildCallWindow } from '../lib/javaCode.js'
import { parseSearchQuery, wantsArticles, wantsCode, wantsSymbols, SEARCH_FACETS, SEARCH_SCOPE_ALL } from '../lib/searchQuery.js'
import BusyState from './BusyState.vue'
import CategoryBadge from './CategoryBadge.vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'modal' = Strg+K ueber der Seite · 'inline' = eingebettete Karte (Landing Page).
  // Der Unterschied ist der RAHMEN, nicht das Verhalten: Suche, Rangfolge, Tastatur und der Sprung
  // in die Code-Ansicht sind in beiden Faellen derselbe Code.
  variant: { type: String, default: 'modal' },
  // Dauerhaft sichtbare Facettenleiste ueber dem Feld (Landing Page). Ohne sie erscheinen die
  // Facetten nur als Chips im leeren, fokussierten Feld – wer sie nicht kennt, findet sie dort
  // nie, weil sie beim ersten getippten Zeichen verschwinden. Auf einer Seite, die die Suche als
  // Hauptangebot zeigt, ist „einschraenken" ein Klick wert; im Modal bliebe die Leiste dagegen
  // dauerhaft im Weg, dort ist die Eingabe schon der Anfang der Antwort.
  facetBar: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const isModal = computed(() => props.variant === 'modal')
// Inline ist immer offen – ein Suchfeld, das erst „geoeffnet" werden muss, waere auf einer Seite,
// die es als Hauptangebot zeigt, ein Widerspruch.
const visible = computed(() => isModal.value ? props.open : true)

const router = useRouter()
const { articles } = useArticles()
const { run } = useSearch(articles)
const { files, lastFileId, lastTargetLine, lastSearchQuery, lastSearchOpts } = useJavaAnalyzer()

// Namenssuche ist billig, die Zeilensuche im Quelltext liest Quelltexte – daher zwei Stufen
// (dieselbe Staffelung wie Klassenfilter/Graph in CodeView).
const NAME_DEBOUNCE_MS = 140
const CODE_DEBOUNCE_MS = 240
const PREVIEW_DEBOUNCE_MS = 120
// Ab hier ist ein Warten sichtbar. Darunter blitzt eine Ladezeile nur auf und macht die Suche
// unruhiger, als sie ist.
const SPINNER_AFTER_MS = 250
// Artikel stehen unter den Klassen: „wie heisst die Klasse" ist die haeufigste Frage an diese
// Palette. Sind Codetreffer da, reicht eine Handvoll Artikel – sonst steht der Code, um den es
// geht, unter zwanzig Artikeln.
const ARTICLES_WITH_CODE = 4
// Sofort-Treffer aus der geladenen Klassenliste. Mehr als das waeren Namen, die niemand mehr liest.
const CLASS_LIMIT = 8

const query = ref('')
const active = ref(0)
const inputEl = ref(null)
const focused = ref(false)
const opts = ref({ caseSensitive: false, wholeWord: false, regex: false })

const SEARCH_TOGGLES = [
  { key: 'caseSensitive', icon: 'lucide:case-sensitive', title: 'Match case (code search)' },
  { key: 'wholeWord', icon: 'lucide:whole-word', title: 'Match whole word (code search)' },
  { key: 'regex', icon: 'lucide:regex', title: 'Use regular expression (code search)' },
]

const parsed = computed(() => parseSearchQuery(query.value))
const term = computed(() => parsed.value.term)

// Ungueltige Regex ist ein Bedienfehler: derselbe Text wie in der Klassen-Suchleiste, und der
// Request geht gar nicht erst raus (sonst beantwortete der Server jeden Zwischenstand mit 400).
const patternError = computed(() => {
  if (!term.value || !opts.value.regex) return ''
  return buildSearchRegex({ query: term.value, ...opts.value }).error
})

// --- Namen: Artikel (Fuse, sofort) + Klassen/Methoden (FTS/LIKE, debounced) ---
const symbolHits = ref([])
const codeResult = ref(null)
const codeLoading = ref(false)
const codeError = ref('')

const articleHits = computed(() => {
  if (!wantsArticles(parsed.value.scope)) return []
  const q = term.value
  // Ohne Eingabe zeigt das MODAL ein paar Einstiege (es ist sonst leer und ueberdeckt die Seite).
  // Die eingebettete Karte tut das NICHT: sie steht in einer Seite, die schon Inhalt hat, und
  // waere mit acht Artikeln im Ruhezustand hoeher als alles darunter.
  if (!q) return isModal.value && parsed.value.scope === 'all' ? articles.value.slice(0, 8) : []
  return run(q)
})

// --- Klassennamen: sofort, ohne Request -----------------------------------------------------
// Die Klassenliste liegt bereits im Store (App.vue laedt sie fuer den Nav-Zaehler) – jeder
// Klassenname ist also schon da, waehrend Server-Anfragen noch unterwegs sind. Genau das war die
// Beschwerde: „ich tippe einen Klassennamen und warte". Vier Stufen, damit der EXAKTE Name oben
// steht und nicht irgendeine Klasse, die ihn zufaellig enthaelt.
function rankClass(f, t, scope) {
  const name = (f.class_name || '').toLowerCase()
  const pkg = (f.package || '').toLowerCase()
  if (scope === 'package') return pkg.includes(t) ? 2 : -1
  if (name === t) return 0
  if (name.startsWith(t)) return 1
  if (name.includes(t)) return 2
  // Der volle Pfad zaehlt nur ausserhalb von `c:` – dort ist ausdruecklich der Klassenname gemeint.
  if (scope !== 'class' && (pkg.includes(t) || `${pkg}.${name}`.includes(t))) return 3
  return -1
}

const localClasses = computed(() => {
  const scope = parsed.value.scope
  if (scope === 'method' || !wantsSymbols(scope)) return []
  const t = term.value.trim().toLowerCase()
  if (!t) return []
  const hits = []
  for (const f of files.value) {
    const rank = rankClass(f, t, scope)
    if (rank >= 0) hits.push({ f, rank })
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.f.class_name.length - b.f.class_name.length ||
      a.f.class_name.localeCompare(b.f.class_name),
  )
  return hits.slice(0, CLASS_LIMIT)
})

// Wartezeit sichtbar machen, statt sie nur zu haben: `elapsed` laeuft, solange irgendetwas
// unterwegs ist. Auf einem Pi dauert die erste Quelltextsuche ueber ein paar tausend Klassen
// spuerbar – ein Spinner ohne Zahl ist dann nicht von „haengt" zu unterscheiden.
const nameLoading = ref(false)
const elapsed = ref(0)
let elapsedTimer = null
// Startzeitpunkt als ref, weil ihn auch `BusyState` bekommt (dort laeuft die Uhr fuer die Anzeige;
// `elapsed` hier entscheidet nur, AB WANN ueberhaupt eine Meldung erscheint).
const startedAt = ref(0)

function startClock() {
  if (elapsedTimer) return
  startedAt.value = Date.now()
  elapsed.value = 0
  elapsedTimer = setInterval(() => {
    elapsed.value = Date.now() - startedAt.value
  }, 100)
}
function stopClock() {
  clearInterval(elapsedTimer)
  elapsedTimer = null
  elapsed.value = 0
}
// Der Spinner erscheint erst nach SPINNER_AFTER_MS: bei einer Antwort in 40 ms waere er ein
// Aufblitzen, das die Suche unruhiger macht, als sie ist.
const busy = computed(() => nameLoading.value || codeLoading.value)
const showBusy = computed(() => busy.value && elapsed.value >= SPINNER_AFTER_MS)
const elapsedLabel = computed(() => (elapsed.value >= 1000 ? `${(elapsed.value / 1000).toFixed(1)}s` : ''))

let nameTimer = null
let codeTimer = null
let nameToken = 0
let codeToken = 0

watch([term, () => parsed.value.scope, opts], ([q, scope]) => {
  clearTimeout(nameTimer)
  clearTimeout(codeTimer)

  if (!q) {
    symbolHits.value = []
    codeResult.value = null
    codeError.value = ''
    codeLoading.value = false
    nameLoading.value = false
    stopClock()
    nameToken++
    codeToken++
    return
  }

  // `c:` und `p:` beantwortet die geladene Klassenliste vollstaendig – kein Request, keine
  // Wartezeit. Der Server traegt dort nur Treffer bei, die im QUELLTEXT stehen, und genau die
  // sind bei einer Namensfacette nicht gemeint.
  const needsNames = wantsSymbols(scope) && scope !== 'class' && scope !== 'package'
  const needsCode = wantsCode(scope) && !patternError.value
  if (needsNames || needsCode) startClock()
  else stopClock()

  if (needsNames) {
    nameLoading.value = true
    nameTimer = setTimeout(async () => {
      const token = ++nameToken
      try {
        const rows = await api.search(q)
        if (token !== nameToken) return
        symbolHits.value = rows.filter((r) => r.type === 'java_file' || r.type === 'java_entity')
      } catch {
        if (token === nameToken) symbolHits.value = []
      } finally {
        if (token === nameToken) nameLoading.value = false
      }
    }, NAME_DEBOUNCE_MS)
  } else {
    symbolHits.value = []
    nameLoading.value = false
  }

  if (needsCode) {
    // Das alte Ergebnis gehoert zur alten Eingabe: es stehenzulassen zeigt Treffer mit
    // Markierungen eines Begriffs, nach dem gerade nicht mehr gesucht wird. Die Ladezeile an
    // seiner Stelle sagt stattdessen, was laeuft.
    codeResult.value = null
    codeLoading.value = true
    codeTimer = setTimeout(async () => {
      const token = ++codeToken
      try {
        const res = await api.searchJavaCode(q, opts.value)
        if (token !== codeToken) return
        codeResult.value = res
        codeError.value = ''
      } catch (e) {
        if (token !== codeToken) return
        codeResult.value = null
        codeError.value = e?.message || 'Code search failed'
      } finally {
        if (token === codeToken) codeLoading.value = false
      }
    }, CODE_DEBOUNCE_MS)
  } else {
    codeResult.value = null
    codeLoading.value = false
  }
}, { deep: true })

// Uhr anhalten, sobald nichts mehr laeuft – nicht im `finally` der Anfragen, weil dort die je
// ANDERE noch unterwegs sein kann.
watch(busy, (running) => {
  if (!running) stopClock()
})

// --- Eine Liste, EIN Index -----------------------------------------------------------------
// Gruppen werden gerendert, navigiert wird flach: jeder Eintrag traegt seinen globalen Index
// (`idx`), damit Tastatur und Maus nie auseinanderlaufen koennen.
const results = computed(() => {
  const flat = []
  const add = (item) => {
    item.idx = flat.length
    flat.push(item)
    return item
  }
  const scope = parsed.value.scope
  const t = term.value.toLowerCase()

  // 1. Klassennamen – ZUERST und ohne Request. Wer einen Klassennamen tippt, meint fast immer
  //    diese Klasse; sie unter Artikeln und Codezeilen zu begraben (und dafuer auf zwei
  //    Server-Antworten zu warten) war die eigentliche Beschwerde.
  const localIds = new Set()
  const classes = localClasses.value.map(({ f, rank }) => {
    localIds.add(f.id)
    return add({
      kind: 'class',
      exact: rank === 0,
      fileId: f.id,
      line: f.class_line || 1,
      name: f.class_name,
      package: f.package || '',
      classType: f.stereotype || f.class_type || 'class',
      methodCount: f.method_count ?? null,
      fieldCount: f.field_count ?? null,
    })
  })

  // 2. Was der Server zusaetzlich findet, sind Klassen, deren QUELLTEXT passt – kein Namenstreffer.
  //    Sie stehen darunter und sagen das auch (`viaSource`), sonst sieht es wie ein zweiter
  //    Namenstreffer aus.
  const serverClasses =
    scope === 'class' || scope === 'package' || scope === 'method'
      ? []
      : symbolHits.value
          .filter((r) => r.type === 'java_file' && !localIds.has(r.fileId ?? r.id))
          .slice(0, 6)
          .map((r) =>
            add({
              kind: 'class',
              viaSource: true,
              fileId: r.fileId ?? r.id,
              line: r.lineNumber || 1,
              name: r.name,
              package: r.package || '',
              snippet: r.snippet || '',
            }),
          )

  const arts = articleHits.value
  const codeFilesRaw = codeResult.value?.files || []
  const articleItems = (codeFilesRaw.length ? arts.slice(0, ARTICLES_WITH_CODE) : arts).map((a) =>
    add({ kind: 'article', article: a }),
  )

  const codeFiles = codeFilesRaw.map((f) => ({
    ...f,
    items: f.hits.map((h) =>
      add({
        kind: 'code',
        fileId: f.fileId,
        className: f.className,
        package: f.package,
        line: h.line,
        lines: h.lines,
      }),
    ),
  }))

  const methods =
    scope === 'class' || scope === 'package'
      ? []
      : symbolHits.value
          .filter((r) => r.type === 'java_entity')
          .slice(0, 12)
          .map((r) => add({ kind: 'method', item: r }))

  return { flat, classes, serverClasses, articleItems, codeFiles, methods }
})

const flatItems = computed(() => results.value.flat)
const activeItem = computed(() => flatItems.value[active.value] || null)

const counter = computed(() => {
  if (patternError.value) return 'Invalid regex'
  if (!term.value) return ''
  const parts = []
  const names = results.value.classes.length + results.value.serverClasses.length
  if (names) parts.push(`${names} ${names === 1 ? 'class' : 'classes'}`)
  if (results.value.methods.length) parts.push(`${results.value.methods.length} methods`)
  const code = codeResult.value
  if (code?.totalMatches) parts.push(`${code.totalMatches} in code`)
  if (results.value.articleItems.length) parts.push(`${results.value.articleItems.length} articles`)
  return parts.join(' · ')
})

// Wer wartet, will wissen worauf. Die Quelltextsuche ist die teure – sie wird deshalb beim Namen
// genannt, statt „Searching…" zu behaupten, wenn nur noch sie laeuft.
const busyLabel = computed(() => {
  if (codeLoading.value && nameLoading.value) return 'Searching names and source…'
  if (codeLoading.value) return 'Searching source code…'
  if (nameLoading.value) return 'Searching names…'
  return ''
})

// Was NICHT gelesen wurde, gehoert angeschrieben – ein stiller Deckel liest sich wie „mehr gibt es
// nicht". Und auch der vollstaendige Lauf sagt es: „12 Treffer" beantwortet nicht, ob in 30 oder in
// 2600 Klassen gesucht wurde. Der Regex-/Interpunktions-Weg kann den FTS-Index nicht nutzen und
// liest der Reihe nach – deshalb steht dabei, welcher Weg es war.
const scanNote = computed(() => {
  const code = codeResult.value
  if (!code || !code.totalFiles) return ''
  if (code.truncated) {
    return `Stopped after ${code.scannedFiles} of ${code.totalFiles} classes — narrow the search for the rest.`
  }
  return `${code.scannedFiles} of ${code.totalFiles} classes read · ${code.mode === 'scan' ? 'full scan' : 'index'}`
})

// --- Vorschau ------------------------------------------------------------------------------
// Fenster je (Klasse, Zeile, Ausschnitt), einmal geholt und gemerkt: beim Durchblaettern mit den
// Pfeiltasten waere sonst jeder Rueckschritt ein neuer Request. Der Deckel ist neu und noetig,
// seit ein Eintrag eine ganze Klasse sein kann: das Modal bleibt gemountet, und ein paar Dutzend
// Suchen mit je acht Klassen haetten sonst dauerhaft ein paar hundert Kilobyte HTML je Eintrag
// im Speicher. Aeltester Eintrag zuerst (Map haelt die Einfuegereihenfolge).
const PREVIEW_CACHE_MAX = 24
const previewCache = new Map()
const preview = ref(null)
const previewBody = ref(null)
// Startzeitpunkt der laufenden Vorschau-Anfrage (fuer BusyState). Eine ganze Klasse zu rendern ist
// mehr Arbeit als sieben Zeilen – auf dem Pi ist das der Unterschied zwischen „ist gleich da" und
// „haengt".
const previewSince = ref(0)
let previewTimer = null
let previewToken = 0

// Ziel der Vorschau: Klassen- und Code-Treffer tragen Datei und Zeile direkt, Methoden-Treffer
// bringen sie aus der Namenssuche in `item` mit (`lineNumber`). Beides hier aufloesen, sonst blieb
// die Vorschau bei Methodentreffern leer.
const previewTarget = (item) => {
  const fileId = item?.fileId ?? item?.item?.fileId ?? null
  const line = item?.line ?? item?.item?.lineNumber ?? null
  return fileId && line ? { fileId, line } : null
}
// Ein Treffer auf den KLASSENNAMEN meint die Klasse, nicht die Zeile, in der ihr Name steht – dort
// ist ein Fenster von sieben Zeilen die falsche Antwort. Alles andere behaelt es: bei einem
// Quelltext- oder Methodentreffer IST die Fundstelle die Auskunft, und in 400 Zeilen ginge sie
// unter. Deshalb auch die Server-Klassen (`viaSource`) nicht – die passen im Quelltext, nicht im
// Namen, und sagen das in der Liste auch.
const wantsFullClass = (item) => item?.kind === 'class' && !item.viaSource
const previewKey = (item) => {
  const t = previewTarget(item)
  return t ? `${t.fileId}:${t.line}:${wantsFullClass(item) ? 'full' : 'win'}` : ''
}

watch(activeItem, (item) => {
  clearTimeout(previewTimer)
  const target = previewTarget(item)
  const key = previewKey(item)
  const full = wantsFullClass(item)
  if (!key) {
    preview.value = null
    return
  }
  if (previewCache.has(key)) {
    preview.value = previewCache.get(key)
    return
  }
  preview.value = null
  previewSince.value = Date.now()
  previewTimer = setTimeout(async () => {
    const token = ++previewToken
    try {
      const win = await api.getJavaSourceWindow(target.fileId, target.line, { full })
      if (token !== previewToken) return
      // Server liefert reines Shiki-HTML, der Client schneidet es zurecht und markiert die Zeile,
      // um die es geht – dieselben DOM-Helfer wie im Edge-/Bundle-Panel, kein zweiter Highlighter.
      // Ganze Klasse: Leerzeilen bleiben (sie sind die Gliederung) und die Klassendeklaration wird
      // markiert. Fenster: +-3 Nicht-Leerzeilen um die Fundstelle.
      const html = full
        ? addLineNumbers(win.html, win.startLine, { keepBlank: true, highlight: win.hitLine })
        : buildCallWindow(win.html, win.startLine, target.line)
      const entry = { ...win, html }
      if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value)
      previewCache.set(key, entry)
      preview.value = entry
    } catch {
      if (token === previewToken) preview.value = null
    }
  }, PREVIEW_DEBOUNCE_MS)
})

// Die markierte Zeile in den Blick holen. Bei der ganzen Klasse steht die Deklaration hinter
// Package- und Import-Block, also unten aus dem Bild – und eine Vorschau, die man erst scrollen
// muss, um zu sehen, worauf man gerade steht, ist keine. Gerechnet statt `scrollIntoView()`:
// letzteres scrollt jeden Vorfahren mit, also auch die Seite hinter dem Modal.
watch(preview, async (p) => {
  await nextTick()
  const box = previewBody.value
  if (!box) return
  const line = p?.full ? box.querySelector('.line-highlight') : null
  if (!line) {
    box.scrollTop = 0
    return
  }
  const delta = line.getBoundingClientRect().top - box.getBoundingClientRect().top
  // Ein Drittel von oben: darueber bleiben Package/Imports sichtbar, darunter beginnt die Klasse.
  box.scrollTop = Math.max(0, box.scrollTop + delta - box.clientHeight / 3)
})

// Jedes Oeffnen des Modals beginnt bei null – eine alte Eingabe waere beim naechsten Strg+K ein
// Ergebnis auf eine Frage von vorgestern. Die eingebettete Karte behaelt ihre Eingabe dagegen
// (sie ist Teil der Seite) und faengt nur einmal den Fokus ab, weil sie das Hauptangebot ist.
watch(() => props.open, async (open) => {
  if (!isModal.value || !open) return
  query.value = ''
  active.value = 0
  symbolHits.value = []
  codeResult.value = null
  codeError.value = ''
  preview.value = null
  await nextTick()
  inputEl.value?.focus()
})
onMounted(async () => {
  if (isModal.value) return
  await nextTick()
  inputEl.value?.focus()
})
// Die Auswahl haengt an der EINGABE, nicht an der Ergebnisliste: die Liste waechst nachtraeglich
// (erst Klassen, dann Namen, dann Code), und ein `watch(flatItems)` haette die Markierung bei jeder
// eintreffenden Antwort wieder nach oben gerissen – auch wenn man laengst weitergeblaettert hat.
watch(term, () => { active.value = 0 })
watch(flatItems, (list) => {
  if (active.value > list.length - 1) active.value = Math.max(0, list.length - 1)
})
onUnmounted(() => {
  clearTimeout(nameTimer)
  clearTimeout(codeTimer)
  clearTimeout(previewTimer)
})

// --- Navigation ----------------------------------------------------------------------------
function go(entry) {
  if (!entry) return
  emit('close')
  if (entry.kind === 'article') {
    router.push(`/article/${entry.article.slug}`)
    return
  }
  // Handoff wie Queue/Edge-Panel -> Code: CodeView waehlt die Klasse und springt in die Zeile.
  // Die Suche faehrt mit und steht danach in der Suchleiste der Klasse, also laeuft „weiter" dort
  // ab dem Treffer, den man angeklickt hat – statt bei null anzufangen.
  // Klassen- und Code-Treffer tragen fileId/line direkt, Methoden-Treffer stecken in `item`.
  lastFileId.value = entry.fileId ?? entry.item?.fileId ?? entry.item?.id ?? null
  lastTargetLine.value = entry.line ?? entry.item?.lineNumber ?? null
  if (term.value) {
    lastSearchQuery.value = term.value
    lastSearchOpts.value = { ...opts.value }
  }
  router.push('/code')
}

function move(delta) {
  const n = flatItems.value.length
  if (!n) return
  active.value = ((active.value + delta) % n + n) % n
  nextTick(() => {
    document.querySelector('[data-sp-active="1"]')?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); go(activeItem.value) }
  // Esc leert das eingebettete Feld (das Modal schliesst stattdessen – das erledigt App.vue).
  else if (e.key === 'Escape' && !isModal.value && query.value) { e.stopPropagation(); query.value = '' }
}

function toggleOpt(key) {
  opts.value = { ...opts.value, [key]: !opts.value[key] }
}
function applyFacet(prefix) {
  query.value = prefix
  inputEl.value?.focus()
}

// --- Facettenleiste: Quelle wechseln, Begriff behalten --------------------------------------
// Der Praefix wird getauscht, nicht dem Feld vorangestellt: `query` ist EINE Zeichenkette, aus der
// `parseSearchQuery` Scope und Begriff liest. Wer „DoaAddForm" getippt hat und dann auf „Source"
// klickt, meint denselben Begriff in einer anderen Quelle – ihn dabei zu verlieren, waere die
// Einschraenkung teurer als das Tippen.
const scopeChips = computed(() => [SEARCH_SCOPE_ALL, ...SEARCH_FACETS])

// Mit Facettenleiste hat der Ruhezustand nichts mehr zu sagen: „Type to search…" steht bereits als
// Platzhalter IM Feld, und die Chips darueber sagen genauer, was durchsucht wird. Die Zeile bleibt
// fuer alles, was eine Auskunft ist – Fehler, laufende Suche, „nichts gefunden".
const showEmptyNote = computed(
  () => !props.facetBar || !!(patternError.value || codeError.value || busy.value || term.value),
)

function pickScope(facet) {
  // Ein zweiter Klick auf die aktive Facette hebt sie auf. Ohne das kaeme man aus einer
  // Einschraenkung nur heraus, indem man den Praefix im Feld von Hand loescht.
  const prefix = parsed.value.scope === facet.scope ? '' : facet.prefix
  const t = term.value
  query.value = prefix ? (t ? `${prefix} ${t}` : prefix) : t
  active.value = 0
  inputEl.value?.focus()
}

// --- Darstellung ---------------------------------------------------------------------------
const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Trefferbereiche der Codesuche als <mark> setzen. Der Server liefert Offsets in genau dem Text,
// den er mitschickt (dedentet/gekuerzt) – hier wird nur noch escaped und umschlossen.
function markRanges(text, ranges) {
  const src = String(text ?? '')
  if (!ranges?.length) return escapeHtml(src)
  let out = ''
  let pos = 0
  for (const r of ranges) {
    const from = Math.max(pos, r.from)
    const to = Math.max(from, r.to)
    if (from > pos) out += escapeHtml(src.slice(pos, from))
    out += `<mark>${escapeHtml(src.slice(from, to))}</mark>`
    pos = to
  }
  return out + escapeHtml(src.slice(pos))
}

// FTS5-snippet() escaped den Quelltext NICHT -> Java-Generics (`List<String>`) wuerden als
// kaputtes HTML rendern. Daher alles escapen und nur die <mark>-Marker wiederherstellen.
function renderSnippet(s) {
  return escapeHtml(s)
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}

const hitLine = (item) => item?.lines?.find((l) => l.isHit) || null
const shortPackage = (pkg) => pkg || 'default package'
</script>

<template>
  <!-- ZWEI Rahmen, EINE Palette: als Modal (Strg+K) liegt sie ueber der Seite, `inline` steht sie
       als Karte auf der Landing Page. Alles darunter – Trefferliste, Vorschau, Tastatur, Sprung –
       ist identisch, weil es dasselbe Markup ist. Zwei Kopien haetten spaetestens beim naechsten
       Feld auseinandergelegen. -->
  <Transition :name="isModal ? 'fade' : ''">
    <div
      v-if="visible"
      :class="isModal
        ? 'fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh] backdrop-blur-sm'
        : 'w-full'"
      @click.self="isModal && emit('close')"
    >
      <div
        class="sp-card flex w-full flex-col overflow-hidden border bg-[var(--color-surface-2)]"
        :class="isModal
          ? 'max-h-[76vh] max-w-5xl rounded-2xl border-[var(--color-border-strong)] shadow-2xl'
          : 'sp-inline max-h-[62vh] rounded-2xl border-[var(--color-border)] shadow-xl'"
      >
        <!-- Facettenleiste (nur mit `facet-bar`): WELCHE QUELLE gefragt wird, als Klick statt als
             Tippwissen. Sie steht UEBER dem Feld, weil sie den Gegenstand der Eingabe bestimmt –
             darunter laese sie sich wie ein Filter des Ergebnisses. Der aktive Chip kommt aus
             `parsed.scope`, nicht aus einem eigenen Ref: sonst haette die Leiste einen Zustand,
             den ein von Hand getippter Praefix (`s: foo`) still widerlegt. -->
        <div v-if="facetBar" class="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-offset)]/40 px-2.5 py-2">
          <button
            v-for="f in scopeChips"
            :key="f.scope"
            type="button"
            class="sp-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-2xs font-semibold transition"
            :class="parsed.scope === f.scope
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] shadow-sm'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'"
            :title="f.hint"
            :aria-pressed="parsed.scope === f.scope"
            @mousedown.prevent
            @click="pickScope(f)"
          >
            <Icon :icon="f.icon" class="h-3.5 w-3.5 shrink-0" />
            {{ f.short }}
            <code
              v-if="f.prefix"
              class="hidden font-mono text-3xs opacity-70 sm:inline"
            >{{ f.prefix }}</code>
          </button>
        </div>

        <!-- Kopfzeile: Feld, Zaehler, Modus-Schalter. Die Schalter sind dieselben wie in der
             Suchleiste des Quellcode-Tabs (gleiche Icons, gleiche Bedeutung) – sie betreffen die
             Zeilensuche im Code, Namen und Artikel bleiben unberuehrt. -->
        <div
          class="flex items-center gap-2 border-b px-4"
          :class="patternError ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]'"
        >
          <Icon icon="lucide:search" class="h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="Search articles, classes and source code…"
            class="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            @keydown="onKeydown"
            @focus="focused = true"
            @blur="focused = false"
          />
          <!-- Solange etwas laeuft, steht hier WAS laeuft und WIE LANGE schon – nicht nur ein
               drehender Kreis. Ist alles da, treten die Zaehler an dieselbe Stelle. -->
          <span
            v-if="showBusy"
            class="hidden shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-3xs text-[var(--color-text-muted)] sm:flex"
          >
            <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-accent)]" />
            {{ busyLabel }}
            <span v-if="elapsedLabel" class="tabular-nums opacity-70">{{ elapsedLabel }}</span>
          </span>
          <span
            v-else-if="counter"
            class="hidden shrink-0 whitespace-nowrap font-mono text-3xs tabular-nums sm:block"
            :class="patternError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
          >{{ counter }}</span>
          <span class="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border)]" />
          <button
            v-for="o in SEARCH_TOGGLES"
            :key="o.key"
            type="button"
            class="grid h-6 w-6 shrink-0 place-items-center rounded transition"
            :class="opts[o.key]
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]'"
            :title="o.title"
            :aria-pressed="opts[o.key]"
            @mousedown.prevent
            @click="toggleOpt(o.key)"
          >
            <Icon :icon="o.icon" class="h-3.5 w-3.5" />
          </button>
          <!-- Im Modal schliesst ESC, eingebettet leert es nur – dort steht deshalb das Kuerzel,
               das dorthin FUEHRT (Strg K), nicht das, was hier passiert. -->
          <kbd v-if="isModal" class="ml-1 hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-3xs text-[var(--color-text-muted)] sm:block">ESC</kbd>
          <span v-else class="ml-1 hidden shrink-0 items-center gap-1 sm:flex">
            <kbd class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-3xs text-[var(--color-text-muted)]">Ctrl</kbd>
            <kbd class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-3xs text-[var(--color-text-muted)]">K</kbd>
          </span>
        </div>

        <!-- Facetten: stehen nicht in einem Tooltip, den niemand oeffnet, sondern erscheinen im
             leeren Feld und tragen sich per Klick selbst ein (wie im Graph-Suchfeld). -->
        <div v-if="!facetBar && !query && focused" class="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-2">
          <span class="font-mono text-3xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Narrow it down</span>
          <button
            v-for="f in SEARCH_FACETS"
            :key="f.prefix"
            type="button"
            class="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-2xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            :title="f.hint"
            @mousedown.prevent="applyFacet(f.prefix)"
          >
            <code class="font-mono text-[var(--color-accent)]">{{ f.prefix }}</code>{{ f.label }}
          </button>
        </div>

        <div v-if="flatItems.length" class="flex min-h-0 flex-1">
          <!-- Ergebnisliste -->
          <div
            class="sp-list min-h-0 w-full shrink-0 overflow-y-auto py-2"
            :class="isModal ? 'lg:w-[24rem] lg:border-r lg:border-[var(--color-border)]' : ''"
          >
            <!-- Warum die Code-Gruppe fehlt. Ohne diese Zeile verschwindet sie bei einer halb
                 getippten Regex kommentarlos, waehrend Artikel und Namen weiter dastehen – das
                 liest sich wie „im Code kommt es nicht vor". -->
            <p
              v-if="patternError || codeError"
              class="mx-4 mb-1 mt-1 rounded-lg border border-[var(--color-danger)] px-3 py-1.5 text-2xs text-[var(--color-danger)]"
            >{{ patternError ? `No code search: ${patternError}` : codeError }}</p>

            <!-- Klassen zuerst: der Namenstreffer steht ohne Request sofort da (die Klassenliste
                 liegt im Store), waehrend Namens- und Quelltextsuche noch unterwegs sind. -->
            <template v-if="results.classes.length || results.serverClasses.length">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-2 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <Icon icon="lucide:braces" class="h-3 w-3" /> Classes
              </div>
              <button
                v-for="entry in results.classes"
                :key="`k-${entry.idx}`"
                type="button"
                :data-sp-active="entry.idx === active ? '1' : null"
                class="flex w-full items-center gap-3 px-4 py-1.5 text-left transition"
                :class="entry.idx === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                @mouseenter="active = entry.idx"
                @click="go(entry)"
              >
                <Icon icon="lucide:braces" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-sm font-medium text-[var(--color-text)]">{{ entry.name }}</span>
                    <!-- „Genau so heisst sie" ist die Antwort auf die haeufigste Frage an diese
                         Palette – sie gehoert an den Treffer, nicht nur in die Sortierung. -->
                    <span
                      v-if="entry.exact"
                      class="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 font-mono text-3xs font-semibold text-[var(--color-accent)]"
                    >exact</span>
                  </div>
                  <div class="truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ shortPackage(entry.package) }}</div>
                </div>
                <span class="shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                  {{ entry.classType }}<template v-if="entry.methodCount"> · {{ entry.methodCount }}m</template>
                </span>
              </button>
              <!-- Server-Treffer: passen im QUELLTEXT, nicht im Namen. Ohne diesen Hinweis saehen
                   sie wie ein zweiter Namenstreffer aus. -->
              <button
                v-for="entry in results.serverClasses"
                :key="`ks-${entry.idx}`"
                type="button"
                :data-sp-active="entry.idx === active ? '1' : null"
                class="flex w-full items-center gap-3 px-4 py-1.5 text-left transition"
                :class="entry.idx === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                @mouseenter="active = entry.idx"
                @click="go(entry)"
              >
                <Icon icon="lucide:braces" class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
                <div class="min-w-0 flex-1">
                  <span class="truncate text-sm text-[var(--color-text)]">{{ entry.name }}</span>
                  <div class="truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ shortPackage(entry.package) }}</div>
                </div>
                <span class="shrink-0 font-mono text-3xs text-[var(--color-text-muted)] opacity-70">in source</span>
              </button>
            </template>

            <!-- Artikel -->
            <template v-if="results.articleItems.length">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-2 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <Icon icon="lucide:file-text" class="h-3 w-3" /> Articles
              </div>
              <button
                v-for="entry in results.articleItems"
                :key="`a-${entry.idx}`"
                type="button"
                :data-sp-active="entry.idx === active ? '1' : null"
                class="flex w-full items-center gap-3 px-4 py-2 text-left transition"
                :class="entry.idx === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                @mouseenter="active = entry.idx"
                @click="go(entry)"
              >
                <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <Icon icon="lucide:file-text" class="h-4 w-4" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium text-[var(--color-text)]">{{ entry.article.title }}</div>
                  <div class="truncate text-xs text-[var(--color-text-muted)]">{{ entry.article.summary }}</div>
                </div>
                <CategoryBadge :category="entry.article.category" size="xs" />
              </button>
            </template>

            <!-- Laeuft noch etwas, steht das DORT, wo die Treffer erscheinen werden – sonst wirkt
                 die Liste fertig, obwohl der teuerste Teil noch unterwegs ist. -->
            <template v-if="codeLoading && showBusy">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-3 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <Icon icon="lucide:code-2" class="h-3 w-3" /> Code
              </div>
              <BusyState
                class="px-4"
                :title="`Reading source of ${files.length} classes…`"
                :detail="opts.regex ? 'regex: every class is read in order' : 'index first, full scan if it finds nothing'"
                hint="The server reads stored sources line by line — narrow the term to make it shorter."
                :since="startedAt"
              />
            </template>

            <!-- Code: je Klasse eine Kopfzeile, darunter die einzelnen Fundstellen -->
            <template v-if="results.codeFiles.length">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-3 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <Icon icon="lucide:code-2" class="h-3 w-3" /> Code
              </div>
              <div v-for="file in results.codeFiles" :key="`f-${file.fileId}`" class="mb-1">
                <div class="flex items-baseline gap-2 px-4 py-1">
                  <span class="truncate text-xs font-semibold text-[var(--color-text)]">{{ file.className }}</span>
                  <span class="truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ shortPackage(file.package) }}</span>
                  <span class="ml-auto shrink-0 rounded bg-[var(--color-surface-offset)] px-1.5 font-mono text-3xs text-[var(--color-text-muted)]">{{ file.matchCount }}</span>
                </div>
                <button
                  v-for="entry in file.items"
                  :key="`c-${entry.idx}`"
                  type="button"
                  :data-sp-active="entry.idx === active ? '1' : null"
                  class="flex w-full items-center gap-2 px-4 py-1 text-left transition"
                  :class="entry.idx === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                  @mouseenter="active = entry.idx"
                  @click="go(entry)"
                >
                  <span class="w-9 shrink-0 text-right font-mono text-3xs tabular-nums text-[var(--color-text-muted)]">{{ entry.line }}</span>
                  <code
                    class="search-code min-w-0 flex-1 truncate font-mono text-2xs text-[var(--color-text-muted)]"
                    v-html="markRanges(hitLine(entry)?.text, hitLine(entry)?.ranges)"
                  />
                </button>
              </div>
            </template>
            <!-- Steht auch OHNE Codetreffer da: „nichts im Code" ist eine Aussage ueber den Lauf,
                 und die gehoert mit dem Umfang zusammen, in dem gesucht wurde. -->
            <p v-if="scanNote && !codeLoading" class="px-4 pb-1 pt-1 font-mono text-3xs text-[var(--color-text-muted)] opacity-80">{{ scanNote }}</p>

            <!-- Methoden (zeilengenauer Sprung) -->
            <template v-if="results.methods.length">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-3 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                <Icon icon="lucide:file-code" class="h-3 w-3" /> Methods
              </div>
              <button
                v-for="entry in results.methods"
                :key="`m-${entry.idx}`"
                type="button"
                :data-sp-active="entry.idx === active ? '1' : null"
                class="flex w-full items-start gap-3 px-4 py-1.5 text-left transition"
                :class="entry.idx === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface-offset)]'"
                @mouseenter="active = entry.idx"
                @click="go(entry)"
              >
                <Icon icon="lucide:file-code" class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono text-sm text-[var(--color-text)]">{{ entry.item.name }}()</div>
                  <div class="truncate text-xs text-[var(--color-text-muted)]">{{ entry.item.className }}</div>
                </div>
              </button>
            </template>
          </div>

          <!-- Vorschau: was der markierte Treffer wirklich ist -->
          <!-- Vorschau: im Modal ab `lg`, eingebettet erst ab `2xl`. Der Unterschied ist gemessen,
               nicht geschaetzt: die eingebettete Karte steht in einer Spalte der Landing Page und
               ist bei 1920 nur ~670 px breit – Liste (384) und Codevorschau darin waeren beide zu
               eng. Ab 2xl hat die Karte ~1000 px, dann traegt die zweite Spalte.
               `min-w-0` ist Pflicht: ein Flex-Kind schrumpft sonst nicht unter die Breite seines
               Inhalts, und der Codeblock (bewusst ohne eigenen Overflow-Container, s. `.edge-code`)
               schob die Vorschau aus der Karte heraus, wo sie abgeschnitten wurde. -->
          <div class="sp-preview hidden min-h-0 min-w-0 flex-1 flex-col" :class="isModal ? 'lg:flex' : ''">
            <template v-if="activeItem?.kind === 'article'">
              <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div class="flex items-center gap-2">
                  <CategoryBadge :category="activeItem.article.category" size="xs" />
                  <span class="font-mono text-3xs text-[var(--color-text-muted)]">/{{ activeItem.article.slug }}</span>
                </div>
                <h3 class="mt-2 text-base font-semibold text-[var(--color-text)]">{{ activeItem.article.title }}</h3>
                <p class="mt-1 text-sm text-[var(--color-text-muted)]">{{ activeItem.article.summary }}</p>
                <p
                  v-if="activeItem.article.snippet"
                  class="search-snippet mt-3 rounded-lg bg-[var(--color-surface-offset)] px-3 py-2 text-xs leading-relaxed text-[var(--color-text-muted)]"
                  v-html="renderSnippet(activeItem.article.snippet)"
                />
                <div v-if="activeItem.article.tags?.length" class="mt-3 flex flex-wrap gap-1">
                  <span v-for="t in activeItem.article.tags" :key="t" class="rounded-full bg-[var(--color-surface-offset)] px-2 py-0.5 text-3xs text-[var(--color-text-muted)]">#{{ t }}</span>
                </div>
              </div>
            </template>

            <template v-else-if="activeItem">
              <div class="flex items-baseline gap-2 border-b border-[var(--color-border)] px-5 py-2.5">
                <!-- Kopf der Vorschau aus EINEM Zugriff: Code- und Klassentreffer tragen ihre
                     Felder direkt, Methodentreffer stecken in `item`. -->
                <span class="truncate text-sm font-semibold text-[var(--color-text)]">
                  {{ activeItem.className || activeItem.name || activeItem.item?.className || activeItem.item?.name }}
                </span>
                <span class="truncate font-mono text-3xs text-[var(--color-text-muted)]">
                  {{ shortPackage(activeItem.package ?? activeItem.item?.package) }}
                </span>
                <!-- Bei der ganzen Klasse ist der Umfang die Auskunft (und die markierte Zeile die
                     Deklaration); beim Fenster ist es die Fundzeile. -->
                <span v-if="previewKey(activeItem)" class="ml-auto shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                  L{{ activeItem.line ?? activeItem.item?.lineNumber }}<template v-if="preview?.full"> · {{ preview.totalLines }} lines</template>
                </span>
              </div>
              <div ref="previewBody" class="min-h-0 flex-1 overflow-auto px-5 py-4">
                <!-- Server-gehighlighteter Ausschnitt: ganze Klasse beim Klassentreffer, sonst das
                     Fenster um die Fundstelle. -->
                <div v-if="preview" class="edge-code code-dark" v-html="preview.html" />
                <!-- … bis dahin der Ausschnitt, der mit dem Suchergebnis ohnehin schon da ist.
                     Kein Ladezustand, der den Blick anhaelt: derselbe Code, nur ohne Farben. -->
                <pre
                  v-else-if="activeItem.kind === 'code'"
                  class="search-fallback overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] p-3 font-mono text-2xs leading-relaxed"
                ><span
                  v-for="l in activeItem.lines"
                  :key="l.line"
                  class="block"
                  :class="l.isHit ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'"
                ><span class="mr-3 inline-block w-8 select-none text-right text-[var(--color-text-muted)]">{{ l.line }}</span><span v-html="markRanges(l.text, l.ranges)" /></span></pre>
                <!-- Ein Klassentreffer bringt keinen Ausschnitt mit (er kommt aus der Klassenliste,
                     nicht aus der Quelltextsuche) – hier steht deshalb die Wartemeldung der App,
                     mitsamt dem, worauf gewartet wird. -->
                <BusyState
                  v-else
                  :title="`Opening ${activeItem.name || activeItem.className || activeItem.item?.className || 'class'}…`"
                  :detail="wantsFullClass(activeItem) ? 'full source · highlighted on the server' : 'source around the match'"
                  hint="The whole class is rendered once and then kept — arrow keys stay instant."
                  :since="previewSince"
                />
                <!-- Was der Deckel abschneidet, steht da. Ein stiller Schnitt liest sich wie
                     „so kurz ist die Klasse". -->
                <p
                  v-if="preview?.truncated"
                  class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-1.5 font-mono text-3xs text-[var(--color-text-muted)]"
                >Showing the first {{ preview.endLine }} of {{ preview.totalLines }} lines — press ↵ to open the full class in Code.</p>
              </div>
            </template>

            <div class="flex items-center gap-3 border-t border-[var(--color-border)] px-5 py-2 text-3xs text-[var(--color-text-muted)]">
              <span><kbd class="rounded border border-[var(--color-border)] px-1">↑</kbd><kbd class="ml-0.5 rounded border border-[var(--color-border)] px-1">↓</kbd> navigate</span>
              <span><kbd class="rounded border border-[var(--color-border)] px-1">↵</kbd> open in Code — the search comes along</span>
            </div>
          </div>
        </div>

        <!-- Leerzustand: im Modal eine ganze Flaeche, eingebettet nur eine Zeile – dort ist die
             Karte Teil der Seite und darf im Ruhezustand nicht die Hoehe von acht Treffern haben. -->
        <div
          v-else-if="showEmptyNote"
          class="text-center text-[var(--color-text-muted)]"
          :class="isModal ? 'px-4 py-10 text-sm' : 'px-4 py-4 text-xs'"
        >
          <template v-if="patternError">
            <span class="text-[var(--color-danger)]">Invalid regular expression</span>
            <p class="mt-1 font-mono text-2xs">{{ patternError }}</p>
          </template>
          <template v-else-if="codeError">
            <span class="text-[var(--color-danger)]">Code search failed</span>
            <p class="mt-1 font-mono text-2xs">{{ codeError }}</p>
          </template>
          <template v-else-if="busy">
            <span class="inline-flex items-center gap-2">
              <Icon icon="lucide:loader-2" class="h-4 w-4 animate-spin text-[var(--color-accent)]" />
              {{ busyLabel || 'Searching…' }}
            </span>
            <p v-if="elapsedLabel" class="mt-1 font-mono text-2xs tabular-nums opacity-70">{{ elapsedLabel }}</p>
          </template>
          <!-- „Nichts gefunden" ist erst dann wahr, wenn auch feststeht, WO gesucht wurde. -->
          <template v-else-if="term">
            No results for “{{ term }}”.
            <p v-if="codeResult" class="mt-1 text-2xs opacity-70">
              Searched {{ codeResult.scannedFiles }} of {{ codeResult.totalFiles }} classes
              ({{ codeResult.mode === 'scan' ? 'full scan' : 'indexed' }}), {{ articles.length }} articles.
            </p>
          </template>
          <template v-else>Type to search articles, classes and source code…</template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
@reference "../assets/style.css";

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* --- Zweite Spalte nach KARTENBREITE, nicht nach Fensterbreite -------------------------------
   Das Modal darf sich am Viewport orientieren (es nimmt ihn ganz ein), die eingebettete Karte
   nicht: sie steht in einer Spalte der Landing Page und ist bei 1920 nur ~670 px breit – gemessen.
   Eine `2xl:`-Regel haette dort die Vorschau eingeblendet, wo kein Platz fuer sie ist. Container-
   Query fragt das Einzig-Richtige: wie breit ist DIESE Karte. */
.sp-inline {
  container-type: inline-size;
}
/* 48rem sind je nach Root-Schriftgroesse 768–960 px (die App skaliert sie mit der Fensterbreite,
   s. „Schriftgroessen nie in px"). Gemessen: bei 1920 ist die Karte ~670 px breit (Liste allein),
   bei 2560 ~1010 px (Liste + Vorschau). Genau die Grenze, die man sehen will. */
@container (min-width: 48rem) {
  .sp-inline .sp-list {
    width: 20rem;
    flex-shrink: 0;
    border-right: 1px solid var(--color-border);
  }
  .sp-inline .sp-preview {
    display: flex;
  }
}

/* Treffer tragen die Gold-Familie von `mark` (style.css) – dieselbe Farbe wie jeder andere
   Suchtreffer in Wikit (Quelltext-Suche, Graph-Suche). */
.search-snippet :deep(mark),
.search-code :deep(mark),
.search-fallback :deep(mark) {
  background: color-mix(in srgb, var(--color-warning) 30%, transparent);
  color: var(--color-text);
  border-radius: 3px;
  padding: 0 1px;
}
/* Der ausgelieferte Ausschnitt behaelt seine RELATIVE Einrueckung (dedentet, nicht getrimmt) –
   ohne `pre` faellt sie im HTML zusammen. */
.search-fallback {
  white-space: pre;
  tab-size: 2;
}
</style>
