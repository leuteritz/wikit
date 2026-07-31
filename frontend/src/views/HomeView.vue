<script setup>
// Landing als BENTO: Kopf (Titel + Suche) ueber die volle Breite, darunter ein Raster aus Kacheln,
// das links und rechts auf DERSELBEN Linie endet.
//
// Warum das die eigentliche Aenderung ist: vorher standen links „Einlesen" und rechts ein Stapel
// aus Demo-Snippet, Zahlen, Chips und Links – zwei Spalten mit unabhaengiger Hoehe, also lief die
// rechte je nach Datenlage weit unter die linke hinaus. Ein Raster loest das nicht von selbst
// (Grid-Spalten sind zwar gleich hoch, ihr INHALT endet aber, wo er will). Deshalb hat jede Seite
// GENAU EIN wachsendes Element: links die Dropzone, rechts die Bilanz-Kachel. Wer auch immer die
// Hoehe bestimmt – aufgeklappter Editor links, viele Packages rechts – die andere Seite fuellt
// nach, und die Unterkante stimmt in jeder Datenlage.
//
// Die rechte Kachel zeigt jetzt die ECHTE Instanz (Klassen, Methoden, Packages, KI-Fortschritt,
// Package-Verteilung) statt eines erfundenen `wikit.java`-Schnipsels. Das Snippet bleibt als
// Leerzustand: solange nichts analysiert ist, gibt es nichts zu bilanzieren, und dann ist ein Bild
// davon, worum es geht, mehr wert als eine Reihe Nullen. Alle Zahlen stammen aus der Klassenliste,
// die ohnehin im Store liegt (App.vue laedt sie fuer den Nav-Zaehler) -> KEIN zusaetzlicher
// Request auf der Startseite.
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useArticles } from '../composables/useArticles.js'
import { WIKI_TITLE, WIKI_ICON } from '../config.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import MeshBackground from '../components/MeshBackground.vue'
import SearchPalette from '../components/SearchPalette.vue'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { files, fetchFiles, analyzeCode, analyzing, error, userContext, lastFileId } = useJavaAnalyzer()
const { enqueueClass } = useJavaQueue()
const { articles, categories, load } = useArticles()

// So viele Packages traegt die Verteilung. Mehr Zeilen waeren in einer Kachel keine Verteilung
// mehr, sondern eine Liste – und die gibt es im Analyzer, vollstaendig und aufklappbar.
const PKG_ROWS = 5
// Zuletzt analysiert: eine Zeile Chips. Der Rest steht im Analyzer.
const RECENT_LIMIT = 8

const source = ref('')
const filename = ref('')
const dragging = ref(false)
const showPaste = ref(false)
const showContext = ref(false)

onMounted(() => {
  fetchFiles()
  load() // gecachter No-Op, falls App.vue bereits geladen hat (useArticles als Singleton-Store)
})

const hasCode = computed(() => files.value.length > 0)

// Zuletzt analysiert – zwei Faelle gleicher Namen, die gemessen beide vorkommen und
// unterschiedliche Antworten verlangen:
//
//  * Gleicher Name im GLEICHEN Package = dieselbe Klasse zweimal in der DB (ein Massen-Import kann
//    sie enthalten; der Export ueberspringt solche Dubletten und schreibt sie an). Vier Chips
//    „DoaAddForm", die alle dieselbe Klasse oeffnen, sind vier Klicks fuer ein Ergebnis – hier
//    zaehlt nur der erste, und die Zeile zeigt stattdessen vier VERSCHIEDENE Klassen.
//  * Gleicher Name in VERSCHIEDENEN Packages = verschiedene Klassen. Dann steht das letzte
//    Package-Segment dabei, sonst sagt kein Chip, welcher welcher ist.
const recent = computed(() => {
  const out = []
  const byName = new Map()
  const seenFqcn = new Set()
  for (const f of files.value) {
    const full = f.package ? `${f.package}.${f.class_name}` : f.class_name
    if (seenFqcn.has(full)) continue
    seenFqcn.add(full)
    byName.set(f.class_name, (byName.get(f.class_name) || 0) + 1)
    out.push({ id: f.id, name: f.class_name, pkg: f.package || '', full, documented: !!f.description })
    if (out.length === RECENT_LIMIT) break
  }
  return out.map((e) => ({ ...e, hint: byName.get(e.name) > 1 ? e.pkg.split('.').pop() : '' }))
})

// EIN Durchlauf ueber die Klassenliste fuer alle Kennzahlen: die Liste hat auf einer gefuellten
// Instanz ein paar tausend Eintraege, und vier getrennte `computed` waeren vier Durchlaeufe fuer
// dieselben Felder.
const stats = computed(() => {
  const packages = new Set()
  let methods = 0
  let documented = 0
  for (const f of files.value) {
    packages.add(f.package || '')
    methods += f.method_count || 0
    if (f.description) documented++
  }
  return {
    classes: files.value.length,
    methods,
    packages: packages.size,
    documented,
    // Anteil der Klassen mit KI-Zusammenfassung – die einzige Zahl hier, die einen Fortschritt
    // beschreibt und nicht nur einen Bestand.
    documentedPct: files.value.length ? Math.round((documented / files.value.length) * 100) : 0,
  }
})

// Verteilung ueber die Packages. Die Balkenlaenge ist RELATIV ZUM GROESSTEN Package, nicht zur
// Gesamtzahl: bei 40 Packages waere jeder Anteil einstellig und jeder Balken ein Strich.
const packageRows = computed(() => {
  const by = new Map()
  for (const f of files.value) {
    const key = f.package || '(default package)'
    by.set(key, (by.get(key) || 0) + 1)
  }
  const sorted = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const max = sorted[0]?.[1] || 1
  const top = sorted.slice(0, PKG_ROWS).map(([path, count]) => ({
    path,
    count,
    // 6 % Mindestbreite (ein Balken, den man sieht), 92 % Deckel: laege der groesste randvoll,
    // sähe eine flache Verteilung – gemessen fuenfmal 52 Klassen – wie fuenf volle Balken aus,
    // also wie ein Anzeigefehler statt wie die Aussage „die groessten sind gleich gross".
    width: Math.max(6, Math.round((count / max) * 92)),
  }))
  const rest = sorted.slice(PKG_ROWS)
  return { top, restPackages: rest.length, restClasses: rest.reduce((n, [, c]) => n + c, 0) }
})

// Vierstellige Zahlen in einer schmalen Kachel: 4.2k statt 4231. Die genaue Zahl steht im Titel.
function compact(n) {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`.replace('.0k', 'k')
  return `${Math.round(n / 1000)}k`
}

// Die zwei Welten der App als Einstieg – mit der Zahl, die dahinter wartet.
const worlds = computed(() => [
  {
    to: '/code',
    icon: 'lucide:braces',
    label: 'Code',
    value: stats.value.classes,
    caption: stats.value.classes
      ? `${stats.value.documented} with AI summary`
      : 'nothing analyzed yet',
  },
  {
    to: '/wiki',
    icon: 'lucide:book-open',
    label: 'Wiki',
    value: articles.value.length,
    caption: `${categories.value.length} categor${categories.value.length === 1 ? 'y' : 'ies'}`,
  },
])

async function readJavaFile(file) {
  if (!file) return
  filename.value = file.name
  source.value = await file.text()
  showPaste.value = true
}

async function onFile(e) {
  await readJavaFile(e.target.files?.[0])
}

function onDrop(e) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file && file.name.endsWith('.java')) readJavaFile(file)
}

async function analyze() {
  if (!source.value.trim()) return
  try {
    const result = await analyzeCode(source.value, filename.value)
    enqueueClass(result.file, { userContext: userContext.value })
    lastFileId.value = result.file.id
    router.push('/code')
  } catch {
    // Fehler steht in `error` (Composable) und wird unten angezeigt.
  }
}

function openClass(id) {
  lastFileId.value = id
  router.push('/code')
}
</script>

<template>
  <div class="landing relative min-h-full overflow-hidden">
    <!-- Hintergrund: animiertes Constellation-Netz (Canvas, eigene Komponente) -->
    <MeshBackground />

    <div class="relative z-10 mx-auto max-w-[86rem] px-5 py-10 lg:py-14">
      <!-- ===== Kopf: Titel + Suche, ueber die volle Breite ==================================
           Die Suche steht ueber Upload und Paste, weil die haeufigste Frage an eine gefuellte
           Instanz „wo ist X?" ist und nicht „wie kommt Neues rein?" – und sie spannt ueber die
           ganze Breite, weil sie in einer Spalte gemessen nur ~750 px breit waere: zu wenig fuer
           Trefferliste UND Codevorschau nebeneinander. -->
      <section class="reveal mx-auto max-w-3xl text-center">
        <p class="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-2xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          <span class="relative flex h-1.5 w-1.5">
            <span class="live-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-success)] opacity-70"></span>
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"></span>
          </span>
          Local code intelligence · no cloud, no login
        </p>

        <h1 class="flex items-center justify-center gap-3 font-mono text-4xl font-semibold tracking-tight text-[var(--color-text)] sm:text-5xl">
          <Icon :icon="WIKI_ICON" class="shrink-0 text-[var(--color-accent)]" />
          <span class="text-[var(--color-accent)]">{{ WIKI_TITLE }}</span><span class="blink font-normal text-[var(--color-accent)]">_</span>
        </h1>
        <p class="mx-auto mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-[var(--color-text-muted)]">
          A self-hosted knowledge base for developers: author notes in
          <span class="font-medium text-[var(--color-text)]">Markdown</span>, parse
          <span class="font-medium text-[var(--color-text)]">Java</span> locally into a class graph
          with per-method AI summaries, and connect everything in a
          <span class="font-medium text-[var(--color-text)]">knowledge graph</span>.
        </p>
      </section>

      <!-- DIESELBE Komponente wie hinter Strg+K (`variant="inline"`): gleiche Rangfolge, gleiche
           Tastatur, gleicher Sprung in die Code-Ansicht – nur ohne den dunklen Ueberzug. Neu ist
           `facet-bar`: die Quelle laesst sich hier anklicken, statt sie als `s:` zu wissen. -->
      <div class="reveal mx-auto mt-8 max-w-5xl">
        <SearchPalette variant="inline" facet-bar />
        <p class="mt-2.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-1 text-center text-2xs text-[var(--color-text-muted)]">
          <Icon icon="lucide:search" class="h-3 w-3 text-[var(--color-accent)]" />
          A hit opens the class in the analyzer — graph and package tree follow along.
          <span class="inline-flex items-center gap-1">
            <kbd class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 font-mono text-3xs">Ctrl</kbd>
            <kbd class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 font-mono text-3xs">K</kbd>
            anywhere
          </span>
        </p>
      </div>

      <!-- ===== Bento: Einlesen (links) · Bilanz (rechts) ====================================
           `items-stretch` (Grid-Default) macht die SPALTEN gleich hoch; dass auch ihr INHALT auf
           derselben Linie endet, leisten die beiden `flex-1`-Elemente darin. -->
      <div class="mt-9 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-5">
        <!-- ---------- Links: Code einlesen ---------- -->
        <section class="reveal tile flex min-w-0 flex-col p-4 sm:p-5">
          <header class="mb-3 flex items-center gap-2">
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Icon icon="lucide:upload" class="h-4 w-4" />
            </span>
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-[var(--color-text)]">Add code</h2>
              <p class="text-2xs text-[var(--color-text-muted)]">Parsed on this machine — no JDK, no upload</p>
            </div>
          </header>

          <!-- Die Dropzone ist das wachsende Element dieser Spalte: steht rechts mehr, dehnt sie
               sich, statt unten Leerraum stehen zu lassen. -->
          <div
            class="dropzone group relative flex flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition"
            :class="dragging
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-surface-offset)]/50 hover:border-[var(--color-accent)]'"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <label class="flex cursor-pointer flex-col items-center">
              <span class="grid h-14 w-14 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] transition group-hover:scale-105">
                <Icon icon="lucide:upload" class="h-7 w-7" />
              </span>
              <span class="mt-3 text-base font-semibold text-[var(--color-text)]">
                Drop or choose a <span class="text-[var(--color-accent)]">.java</span> file
              </span>
              <span class="mt-1 text-xs text-[var(--color-text-muted)]">Drag &amp; drop or click · everything stays local</span>
              <input type="file" accept=".java" class="hidden" @change="onFile" />
            </label>

            <p v-if="filename" class="mt-3 flex max-w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-surface-2)] px-2.5 py-1 text-sm font-medium text-[var(--color-text)]">
              <Icon icon="lucide:file-text" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate">{{ filename }}</span>
            </p>
          </div>

          <!-- Alternative Eingaben als erkennbare Option-Cards (statt winziger Text-Toggles). -->
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              class="flex items-start gap-3 rounded-xl border p-3 text-left transition"
              :class="showPaste
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface-offset)]/50 hover:border-[var(--color-accent)]'"
              :aria-expanded="showPaste"
              @click="showPaste = !showPaste"
            >
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:code-2" class="h-5 w-5" />
              </span>
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text)]">
                  Paste code
                  <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5 text-[var(--color-text-muted)] transition-transform" :class="showPaste ? 'rotate-180' : ''" />
                </span>
                <span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">Drop a class straight into the editor</span>
              </span>
            </button>

            <button
              type="button"
              class="flex items-start gap-3 rounded-xl border p-3 text-left transition"
              :class="showContext
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface-offset)]/50 hover:border-[var(--color-accent)]'"
              :aria-expanded="showContext"
              @click="showContext = !showContext"
            >
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:wand-2" class="h-5 w-5" />
              </span>
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text)]">
                  Project context
                  <span
                    v-if="userContext"
                    class="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-3xs font-bold leading-none text-[var(--color-accent-contrast)]"
                  >active</span>
                  <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5 text-[var(--color-text-muted)] transition-transform" :class="showContext ? 'rotate-180' : ''" />
                </span>
                <span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">Steers every AI summary</span>
              </span>
            </button>
          </div>

          <div v-show="showPaste" class="mt-3 h-64">
            <JavaCodeEditor v-model="source" />
          </div>

          <textarea
            v-show="showContext"
            v-model="userContext"
            spellcheck="false"
            rows="3"
            placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
            class="mt-3 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-offset)] p-2.5 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />

          <p v-if="error" class="mt-3 rounded-lg border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">{{ error }}</p>

          <button
            type="button"
            class="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            :disabled="analyzing || !source.trim()"
            @click="analyze"
          >
            <Icon v-if="analyzing" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
            <Icon v-else icon="lucide:arrow-right" class="h-4 w-4" />
            {{ analyzing ? 'Analyzing…' : 'Analyze class' }}
          </button>
        </section>

        <!-- ---------- Rechts: die zwei Welten + Bilanz ---------- -->
        <div class="reveal reveal-delay flex min-w-0 flex-col gap-4 lg:gap-5">
          <div class="grid grid-cols-2 gap-4 lg:gap-5">
            <RouterLink
              v-for="w in worlds"
              :key="w.label"
              :to="w.to"
              class="tile tile-link group flex flex-col p-4"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="flex items-center gap-2 text-[var(--color-text)]">
                  <Icon :icon="w.icon" class="h-4 w-4 text-[var(--color-accent)]" />
                  <span class="text-sm font-semibold">{{ w.label }}</span>
                </span>
                <Icon icon="lucide:arrow-right" class="h-4 w-4 -translate-x-1 text-[var(--color-accent)] opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
              </span>
              <span class="mt-1 text-3xl font-bold leading-none tabular-nums text-[var(--color-text)]" :title="String(w.value)">{{ compact(w.value) }}</span>
              <span class="mt-1 truncate text-2xs text-[var(--color-text-muted)]">{{ w.caption }}</span>
            </RouterLink>
          </div>

          <!-- Die Bilanz-Kachel ist das wachsende Element dieser Spalte. -->
          <section class="tile flex min-h-0 flex-1 flex-col p-4 sm:p-5">
            <!-- Gefuellte Instanz: echte Zahlen aus der geladenen Klassenliste. -->
            <template v-if="hasCode">
              <header class="flex items-center gap-2">
                <Icon icon="lucide:layers" class="h-4 w-4 text-[var(--color-accent)]" />
                <h2 class="text-sm font-semibold text-[var(--color-text)]">Your codebase</h2>
                <span class="ml-auto font-mono text-3xs text-[var(--color-text-muted)]">local · sqlite</span>
              </header>

              <dl class="mt-3 grid grid-cols-3 gap-2">
                <div v-for="m in [
                  { label: 'methods', value: stats.methods },
                  { label: 'packages', value: stats.packages },
                  { label: 'documented', value: stats.documentedPct, suffix: '%' },
                ]" :key="m.label" class="rounded-lg bg-[var(--color-surface-offset)]/60 px-2.5 py-2">
                  <dt class="text-3xs uppercase tracking-[0.1em] text-[var(--color-text-muted)]">{{ m.label }}</dt>
                  <dd class="text-lg font-bold leading-tight tabular-nums text-[var(--color-text)]" :title="String(m.value)">
                    {{ compact(m.value) }}<span v-if="m.suffix" class="text-sm font-semibold text-[var(--color-text-muted)]">{{ m.suffix }}</span>
                  </dd>
                </div>
              </dl>

              <!-- Verteilung: Balken relativ zum groessten Package (s. Kommentar oben). -->
              <p class="mb-1.5 mt-4 text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Largest packages
              </p>
              <ul class="space-y-1.5">
                <li v-for="p in packageRows.top" :key="p.path" class="flex items-center gap-2">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-2xs text-[var(--color-text)]" :title="p.path">{{ p.path }}</span>
                    <span class="pkg-bar mt-1 block" :style="{ '--w': `${p.width}%` }"></span>
                  </span>
                  <span class="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-[var(--color-text-muted)]">{{ p.count }}</span>
                </li>
              </ul>
              <p v-if="packageRows.restPackages" class="mt-1.5 font-mono text-3xs text-[var(--color-text-muted)]">
                + {{ packageRows.restPackages }} more package(s) · {{ packageRows.restClasses }} classes
              </p>

              <!-- Zuletzt analysiert: `mt-auto` haelt die Chips an der Unterkante, damit die
                   Kachel beim Strecken unten nicht ausfranst. -->
              <div class="mt-auto pt-4">
                <p class="mb-1.5 text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Recently analyzed</p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="f in recent"
                    :key="f.id"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-offset)]/60 px-2.5 py-1 text-2xs font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    :title="f.full"
                    @click="openClass(f.id)"
                  >
                    <Icon v-if="f.documented" icon="lucide:sparkles" class="h-3 w-3 text-[var(--color-accent)]" />
                    {{ f.name }}
                    <span v-if="f.hint" class="font-mono text-3xs text-[var(--color-text-muted)]">{{ f.hint }}</span>
                  </button>
                </div>
              </div>
            </template>

            <!-- Leerzustand: nichts zu bilanzieren – dann zeigt die Kachel, worum es geht.
                 Statische Terminal-Optik, kein Shiki (das Bundle traegt der Analyzer). -->
            <template v-else>
              <header class="flex items-center gap-2 border-b border-[var(--color-border)] pb-2.5">
                <span class="flex gap-1.5">
                  <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-danger)]/60"></span>
                  <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-warning)]/70"></span>
                  <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-success)]/70"></span>
                </span>
                <span class="ml-1 flex items-center gap-1.5 font-mono text-xs text-[var(--color-text-muted)]">
                  <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                  {{ WIKI_TITLE }}.java
                </span>
                <Icon icon="lucide:terminal" class="ml-auto h-3.5 w-3.5 text-[var(--color-text-muted)]" />
              </header>
              <pre class="snippet mt-3 overflow-x-auto text-[0.78125rem] leading-relaxed"><code><span class="c">/** Parsed locally — no JDK required. */</span>
<span class="k">public class</span> <span class="t">{{ WIKI_TITLE }}</span> {
  <span class="k">private final</span> <span class="t">Graph</span> graph;

  <span class="c">// AI-documented per method via Ollama</span>
  <span class="k">public</span> <span class="t">Article</span> <span class="fn">analyze</span>(<span class="t">Class</span> c) {
    <span class="k">return</span> graph.<span class="fn">link</span>(c).<span class="fn">summarize</span>();
  }
}</code></pre>
              <p class="mt-auto pt-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Nothing analyzed yet. Drop a <span class="font-mono text-[var(--color-text)]">.java</span> file on
                the left — classes, methods and their relations show up here, and the analyzer draws
                the dependency graph from them.
              </p>
            </template>
          </section>
        </div>
      </div>

      <!-- ===== Fusszeile: sekundaere Wege. Bewusst KEINE Kacheln – „Code" und „Wiki" stehen schon
           oben rechts, und dieselbe Tuer zweimal auf einer Seite ist eine Entscheidung zu viel. -->
      <div class="reveal mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/70 px-4 py-2.5 text-2xs text-[var(--color-text-muted)] lg:mt-5">
        <RouterLink to="/new" class="group inline-flex items-center gap-1.5 font-medium text-[var(--color-text)] transition hover:text-[var(--color-accent)]">
          <Icon icon="lucide:plus" class="h-3.5 w-3.5 text-[var(--color-accent)]" />
          New article
          <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </RouterLink>
        <span class="hidden h-3 w-px bg-[var(--color-border)] sm:block"></span>
        <span class="inline-flex items-center gap-1.5">
          <kbd class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 font-mono text-3xs">?</kbd>
          keyboard shortcuts
        </span>
        <span class="hidden h-3 w-px bg-[var(--color-border)] sm:block"></span>
        <span class="inline-flex items-center gap-1.5">
          <Icon icon="lucide:database" class="h-3.5 w-3.5" />
          Everything stays on this machine
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* --- Bento-Kachel: EINE Definition fuer alle Flaechen des Rasters ------------------------
   Inline-Utilities waeren hier fuenfmal derselbe lange Klassensatz; die Kachel ist genau der
   Sonderfall, fuer den scoped CSS vorgesehen ist. Deckende Flaeche statt `backdrop-filter`:
   dahinter laeuft ein Canvas, und eine Offscreen-Textur ueber dessen Ausschnitt ist genau die
   Konstruktion, die im Graphen schwarze Flaechen erzeugt hat. */
.tile {
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  background: var(--color-surface-2);
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%);
}
.tile-link {
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.tile-link:hover {
  border-color: var(--color-accent);
  transform: translateY(-2px);
  box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--color-accent) 55%, transparent);
}

/* Package-Balken: Laenge kommt als `--w` aus dem Template (relativ zum groessten Package). */
.pkg-bar {
  height: 0.3125rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
  overflow: hidden;
}
.pkg-bar::before {
  content: '';
  display: block;
  height: 100%;
  width: var(--w, 0%);
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--color-accent),
    color-mix(in srgb, var(--color-accent) 55%, transparent)
  );
}

/* --- Statisches Java-Snippet (nur Leerzustand): ruhige, theme-abhaengige Toene ------------ */
.snippet {
  color: var(--color-text);
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
}
.snippet .c {
  color: var(--color-text-muted);
  font-style: italic;
}
.snippet .k {
  color: var(--color-accent);
  font-weight: 600;
}
.snippet .t {
  color: var(--color-success);
}
.snippet .fn {
  color: var(--color-warning);
}

/* --- Mount-Reveal (dezent), respektiert reduzierte Bewegung ----------------------------- */
.reveal {
  animation: reveal-in 0.5s ease both;
}
.reveal-delay {
  animation-delay: 0.08s;
}
@keyframes reveal-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Blinkender Cursor hinter dem Titel (Terminal-Optik). */
.blink {
  animation: blink 1.1s step-end infinite;
}
@keyframes blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}

/* Lebenszeichen im Kopf-Chip: „laeuft hier, jetzt, lokal". */
.live-ping {
  animation: live-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes live-ping {
  75%,
  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reveal,
  .blink,
  .live-ping {
    animation: none;
  }
}
</style>
