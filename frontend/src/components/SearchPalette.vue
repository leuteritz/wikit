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
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import { useSearch } from '../composables/useSearch.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { api } from '../lib/api.js'
import { buildSearchRegex } from '../lib/codeSearch.js'
import { buildCallWindow } from '../lib/javaCode.js'
import { parseSearchQuery, wantsArticles, wantsCode, wantsSymbols, SEARCH_FACETS } from '../lib/searchQuery.js'
import CategoryBadge from './CategoryBadge.vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const router = useRouter()
const { articles } = useArticles()
const { run } = useSearch(articles)
const { lastFileId, lastTargetLine, lastSearchQuery, lastSearchOpts } = useJavaAnalyzer()

// Namenssuche ist billig, die Zeilensuche im Quelltext liest Quelltexte – daher zwei Stufen
// (dieselbe Staffelung wie Klassenfilter/Graph in CodeView).
const NAME_DEBOUNCE_MS = 180
const CODE_DEBOUNCE_MS = 260
const PREVIEW_DEBOUNCE_MS = 120
// Artikel bleiben oben, damit ein Titel-Treffer weiterhin der erste Eintrag ist. Sind Codetreffer
// da, reicht eine Handvoll: sonst steht der Code, um den es geht, unter zwanzig Artikeln.
const ARTICLES_WITH_CODE = 5

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
  if (!q) return parsed.value.scope === 'all' ? articles.value.slice(0, 8) : []
  return run(q)
})

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
    nameToken++
    codeToken++
    return
  }

  if (wantsSymbols(scope)) {
    nameTimer = setTimeout(async () => {
      const token = ++nameToken
      try {
        const rows = await api.search(q)
        if (token !== nameToken) return
        symbolHits.value = rows.filter((r) => r.type === 'java_file' || r.type === 'java_entity')
      } catch {
        if (token === nameToken) symbolHits.value = []
      }
    }, NAME_DEBOUNCE_MS)
  } else {
    symbolHits.value = []
  }

  if (wantsCode(scope) && !patternError.value) {
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

  // Die Namenssuche liefert Klassen und Methoden gemischt; die Praefixe schraenken auf genau eine
  // Achse ein (`c:` will Klassennamen, nicht „Klasse, in deren Quelltext das Wort vorkommt").
  const classes = symbolHits.value
    .filter((r) => r.type === 'java_file')
    .filter((r) => {
      if (scope === 'class') return (r.name || '').toLowerCase().includes(t)
      if (scope === 'package') return (r.package || '').toLowerCase().includes(t)
      if (scope === 'method') return false
      return true
    })
    .slice(0, 12)
    .map((r) => add({ kind: 'class', item: r }))

  const methods =
    scope === 'class' || scope === 'package'
      ? []
      : symbolHits.value
          .filter((r) => r.type === 'java_entity')
          .slice(0, 12)
          .map((r) => add({ kind: 'method', item: r }))

  return { flat, articleItems, codeFiles, classes, methods }
})

const flatItems = computed(() => results.value.flat)
const activeItem = computed(() => flatItems.value[active.value] || null)

const counter = computed(() => {
  if (patternError.value) return 'Invalid regex'
  if (!term.value) return ''
  const parts = []
  const code = codeResult.value
  if (code?.totalMatches) {
    parts.push(`${code.files.length}${code.truncated ? '+' : ''} ${code.files.length === 1 ? 'class' : 'classes'}`)
    parts.push(`${code.totalMatches} in code`)
  }
  const names = results.value.classes.length + results.value.methods.length
  if (names) parts.push(`${names} names`)
  if (results.value.articleItems.length) parts.push(`${results.value.articleItems.length} articles`)
  return parts.join(' · ')
})

// Was NICHT gelesen wurde, gehoert angeschrieben – ein stiller Deckel liest sich wie „mehr gibt es
// nicht". Der Regex-Weg kann den FTS-Index nicht nutzen und scannt der Reihe nach.
const scanNote = computed(() => {
  const code = codeResult.value
  if (!code || !code.truncated) return ''
  return `Stopped after ${code.scannedFiles} of ${code.totalFiles} classes — narrow the search for the rest.`
})

// --- Vorschau ------------------------------------------------------------------------------
// Fenster je (Klasse, Zeile), einmal geholt und gemerkt: beim Durchblaettern mit den Pfeiltasten
// waere sonst jeder Rueckschritt ein neuer Request.
const previewCache = new Map()
const preview = ref(null)
let previewTimer = null
let previewToken = 0

const previewKey = (item) => (item?.fileId && item?.line ? `${item.fileId}:${item.line}` : '')

watch(activeItem, (item) => {
  clearTimeout(previewTimer)
  const key = previewKey(item)
  if (!key) {
    preview.value = null
    return
  }
  if (previewCache.has(key)) {
    preview.value = previewCache.get(key)
    return
  }
  preview.value = null
  previewTimer = setTimeout(async () => {
    const token = ++previewToken
    try {
      const win = await api.getJavaSourceWindow(item.fileId, item.line)
      if (token !== previewToken) return
      // Server liefert reines Shiki-HTML, der Client schneidet daraus sein Fenster und markiert die
      // Fundzeile – dieselben DOM-Helfer wie im Edge-/Bundle-Panel, kein zweiter Highlighter.
      const entry = { ...win, html: buildCallWindow(win.html, win.startLine, item.line) }
      previewCache.set(key, entry)
      preview.value = entry
    } catch {
      if (token === previewToken) preview.value = null
    }
  }, PREVIEW_DEBOUNCE_MS)
})

watch(() => props.open, async (open) => {
  if (open) {
    query.value = ''
    active.value = 0
    symbolHits.value = []
    codeResult.value = null
    codeError.value = ''
    preview.value = null
    await nextTick()
    inputEl.value?.focus()
  }
})
watch(flatItems, () => { active.value = 0 })
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
  // Neu ist die Suche selbst: sie faehrt mit und steht danach in der Suchleiste der Klasse, also
  // laeuft „weiter" dort ab dem Treffer, den man angeklickt hat – statt bei null anzufangen.
  const item = entry.kind === 'code' ? entry : entry.item
  lastFileId.value = entry.kind === 'code' ? entry.fileId : item.fileId ?? item.id
  lastTargetLine.value = entry.kind === 'code' ? entry.line : item.lineNumber ?? null
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
}

function toggleOpt(key) {
  opts.value = { ...opts.value, [key]: !opts.value[key] }
}
function applyFacet(prefix) {
  query.value = prefix
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
  <Transition name="fade">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh] backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div class="flex max-h-[76vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-2xl">
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
          <span
            v-if="counter"
            class="hidden shrink-0 whitespace-nowrap font-mono text-3xs tabular-nums sm:block"
            :class="patternError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
          >{{ counter }}</span>
          <Icon v-if="codeLoading" icon="lucide:loader-2" class="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]" />
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
          <kbd class="ml-1 hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-3xs text-[var(--color-text-muted)] sm:block">ESC</kbd>
        </div>

        <!-- Facetten: stehen nicht in einem Tooltip, den niemand oeffnet, sondern erscheinen im
             leeren Feld und tragen sich per Klick selbst ein (wie im Graph-Suchfeld). -->
        <div v-if="!query && focused" class="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-2">
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
          <div class="min-h-0 w-full shrink-0 overflow-y-auto py-2 lg:w-[24rem] lg:border-r lg:border-[var(--color-border)]">
            <!-- Warum die Code-Gruppe fehlt. Ohne diese Zeile verschwindet sie bei einer halb
                 getippten Regex kommentarlos, waehrend Artikel und Namen weiter dastehen – das
                 liest sich wie „im Code kommt es nicht vor". -->
            <p
              v-if="patternError || codeError"
              class="mx-4 mb-1 mt-1 rounded-lg border border-[var(--color-danger)] px-3 py-1.5 text-2xs text-[var(--color-danger)]"
            >{{ patternError ? `No code search: ${patternError}` : codeError }}</p>

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
              <p v-if="scanNote" class="px-4 pb-1 pt-0.5 text-3xs text-[var(--color-text-muted)]">{{ scanNote }}</p>
            </template>

            <!-- Klassen (Namenstreffer) -->
            <template v-if="results.classes.length">
              <div class="flex items-center gap-1.5 px-4 pb-1 pt-3 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
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
                <span class="truncate text-sm text-[var(--color-text)]">{{ entry.item.name }}</span>
                <span class="ml-auto truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ entry.item.package }}</span>
              </button>
            </template>

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
          <div class="hidden min-h-0 flex-1 flex-col lg:flex">
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
                <span class="truncate text-sm font-semibold text-[var(--color-text)]">
                  {{ activeItem.kind === 'code' ? activeItem.className : (activeItem.item.className || activeItem.item.name) }}
                </span>
                <span class="truncate font-mono text-3xs text-[var(--color-text-muted)]">
                  {{ shortPackage(activeItem.kind === 'code' ? activeItem.package : activeItem.item.package) }}
                </span>
                <span v-if="previewKey(activeItem)" class="ml-auto shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                  L{{ activeItem.line ?? activeItem.item.lineNumber }}
                </span>
              </div>
              <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
                <!-- Server-gehighlightetes Fenster … -->
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
                <div v-else class="text-xs text-[var(--color-text-muted)]">Loading…</div>
              </div>
            </template>

            <div class="flex items-center gap-3 border-t border-[var(--color-border)] px-5 py-2 text-3xs text-[var(--color-text-muted)]">
              <span><kbd class="rounded border border-[var(--color-border)] px-1">↑</kbd><kbd class="ml-0.5 rounded border border-[var(--color-border)] px-1">↓</kbd> navigate</span>
              <span><kbd class="rounded border border-[var(--color-border)] px-1">↵</kbd> open in Code — the search comes along</span>
            </div>
          </div>
        </div>

        <div v-else class="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
          <template v-if="patternError">
            <span class="text-[var(--color-danger)]">Invalid regular expression</span>
            <p class="mt-1 font-mono text-2xs">{{ patternError }}</p>
          </template>
          <template v-else-if="codeError">
            <span class="text-[var(--color-danger)]">Code search failed</span>
            <p class="mt-1 font-mono text-2xs">{{ codeError }}</p>
          </template>
          <template v-else-if="codeLoading">Searching…</template>
          <template v-else-if="term">No results for “{{ term }}”.</template>
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
