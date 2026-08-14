<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import SearchPalette from './components/SearchPalette.vue'
import ShortcutsOverlay from './components/ShortcutsOverlay.vue'
import { sidebarShortcuts, keyChips, isTypingTarget } from './lib/shortcuts.js'
import NotificationHost from './components/NotificationHost.vue'
import ActivityCard from './components/ActivityCard.vue'
import ActivityModal from './components/ActivityModal.vue'
import { useArticles } from './composables/useArticles.js'
import { useJavaAnalyzer } from './composables/useJavaAnalyzer.js'
import { useJavaQueue } from './composables/useJavaQueue.js'
import { useInsights } from './composables/useInsights.js'
// Der Stand des Bedeutungsindex – dieselbe Quelle, die die Karte in `/bot` zeigt.
import { useEmbeddings } from './composables/useEmbeddings.js'
import { useActivity } from './composables/useActivity.js'
import { useBot } from './composables/useBot.js'
import { useTheme } from './composables/useTheme.js'
// Der Arbeitsstand des Themen-Buendels. Die Sidebar liest hier nur die Zahl – geschrieben wird sie
// in `TopicView`, und sie ueberlebt den Reload (s. `useTopic`).
import { useTopic } from './composables/useTopic.js'
import { WIKI_TITLE, WIKI_ICON, WIKI_VERSION, WIKI_WHATS_NEW } from './config.js'
import { Icon } from './lib/icons.js'

const { load, articles } = useArticles()
const { files, fetchFiles } = useJavaAnalyzer()
const { probe: probeQueue } = useJavaQueue()
// Der Zaehler des Insights-Bereichs. Geteilter Store: was hier fuer die Sidebar geholt wird, liegt
// danach auch dem Klassen-Panel und dem Farbmodus des Graphen vor – der Request ist vorgezogen,
// nicht zusaetzlich.
const { totals: insightTotals, ensure: ensureInsights } = useInsights()
const { indexed: embeddedCount, enabled: embedEnabled, ensure: ensureEmbeddings } = useEmbeddings()
// „Laeuft gerade etwas Langes?" – die Frage betrifft jede Ansicht, denn Import, Reset,
// Kanten-Neuberechnung und KI-Queue laufen im Server weiter, wenn man die Code-Ansicht verlaesst.
const { busy: activityBusy, closeDetail: closeActivity } = useActivity()
const { theme, toggle: toggleTheme } = useTheme()
// Verbindungsstand des Bots. Er haengt an der Sidebar, weil die Frage „antwortet die KI ueberhaupt?"
// jede Ansicht betrifft – ein Massenlauf gegen einen abgeschalteten Ollama-Server faellt sonst
// erst auf, wenn die Beschreibungen leer bleiben.
const { status: botStatus, statusLabel: botStatusLabel, startHealthWatch } = useBot()
const { pickedCount, topicTerm } = useTopic()
const route = useRoute()
const router = useRouter()
const searchOpen = ref(false)
const shortcutsOpen = ref(false)
// Die Sidebar zeigt die Kuerzel der AKTUELLEN Ansicht – in der Code-Ansicht sind das andere als im
// Wiki, und eine Liste, in der die Haelfte gerade nicht gilt, liest niemand zweimal.
const sidebarKeys = computed(() => sidebarShortcuts(route.path))

// Tastenfolge `g` dann `c|w`: kein Modifier noetig, kollidiert mit nichts – aber nur, solange
// niemand tippt. Das Fenster ist kurz, sonst wird aus einem spaeteren `c` im Fliesstext eine
// Navigation.
const GOTO_WINDOW_MS = 1200
// Die Ziele stehen als Tabelle da, damit ein weiterer Bereich eine Zeile ist und keine zweite
// Bedingung im Handler (die dritte Verzweigung war der Punkt, an dem es eine wurde).
const GOTO_TARGETS = { c: '/code', i: '/insights', w: '/wiki', b: '/bot' }
let gotoArmedAt = 0

function onKey(e) {
  const typing = isTypingTarget(document.activeElement)

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchOpen.value = true
    return
  }
  if (e.key === 'Escape') {
    searchOpen.value = false
    shortcutsOpen.value = false
    // Das Aktivitaets-Fenster schliesst hier mit, nicht in der Komponente: ESC gehoert der Ansicht,
    // die es abfaengt (dieselbe Regel wie bei den Kanten-Panels in `CodeView`).
    closeActivity()
    return
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return

  // `?` liegt auf jeder Tastatur woanders (hier Shift+ß) – `e.key` liefert trotzdem das Zeichen.
  if (e.key === '?') {
    e.preventDefault()
    shortcutsOpen.value = !shortcutsOpen.value
    return
  }
  if (e.key.toLowerCase() === 'g') {
    gotoArmedAt = Date.now()
    return
  }
  if (gotoArmedAt && Date.now() - gotoArmedAt < GOTO_WINDOW_MS) {
    const target = GOTO_TARGETS[e.key.toLowerCase()]
    if (target) {
      e.preventDefault()
      router.push(target)
    }
  }
  gotoArmedAt = 0
}

onMounted(() => {
  load()
  // Nur die Anzahl fuer den Nav-Badge – Fehler still (Code-Feature ist optional/leer moeglich).
  fetchFiles().catch(() => {})
  // Einmal nachsehen, ob im Server noch eine KI-Queue laeuft. Ohne das faengt die Sidebar einen
  // laufenden Massenlauf erst auf, wenn jemand die Code-Ansicht oeffnet – nach einem Reload also
  // womoeglich nie.
  probeQueue().catch(() => {})
  startHealthWatch()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

// Die Kennzahlen erst holen, wenn es ueberhaupt Klassen gibt – und dann einmalig (`ensure`).
// Als watch statt im `onMounted`, weil die Klassenliste asynchron eintrifft und weil der erste
// Import den Zaehler sonst bis zum naechsten Reload leer liesse.
watch(
  () => files.value.length,
  (n) => {
    if (n) ensureInsights().catch(() => {})
    // Derselbe Grund fuer den Bedeutungsindex: die Zahl neben „Ask" haengt daran, und ohne
    // Klassen gibt es keinen Index, ueber den man etwas sagen koennte.
    if (n) ensureEmbeddings().catch(() => {})
  },
  { immediate: true },
)

// ⚠️ **Die Zahl bei Ask ist ein Bestand, aber nicht der der Klassen: sie zaehlt, worauf Ask
// ANTWORTEN kann.** Eine Frage selbst ist ein Vorgang – „so viele Fragen hast du gestellt" waere
// eine Zahl, nach der niemand fragt. Die eingebetteten Quellen dagegen sind genau die Menge, aus
// der eine Antwort entstehen kann: steht dort 0, findet `/ask` nichts, egal was man tippt.
//
// ⚠️ Gezaehlt werden Klassen UND Wiki-Artikel (`useEmbeddings` summiert beide Indizes). Nur die
// Klassen zu nehmen hiesse, in einem Wiki ohne hochgeladenen Code eine 0 zu zeigen – obwohl `/ask`
// dort aus jedem indizierten Artikel antworten kann.
//
// Sie darf FEHLEN (wie die Topic-Zahl): ohne jeden Bestand gibt es keinen Index, und ein nicht
// geladener Stand ist keine 0 – das waere die Behauptung „nichts indiziert", bevor jemand
// nachgesehen hat. Ist der Index dagegen wirklich leer, IST die 0 die Aussage – sie faerbt sich
// aber nicht (s. `navLinks`), denn sie beschreibt eine nicht eingerichtete Option, keinen Fehler.
// Warum die 0 hier trotzdem stehen darf, wo sie bei Topic entfaellt: bei Topic hiesse sie „du hast
// nichts eingesammelt" – eine Aussage ueber den Nutzer, nach der niemand gefragt hat. Hier heisst
// sie „hier ist nichts zu holen", und genau das erklaert, warum `/ask` gleich nichts finden wird.
const hasAskable = computed(() => files.value.length > 0 || articles.value.length > 0)
const askCount = computed(() => {
  if (!hasAskable.value) return null
  return embeddedCount.value
})
const askTitle = computed(() => {
  if (!hasAskable.value) return 'Ask a question and get an answer backed by the sources it came from'
  if (askCount.value == null) return 'Ask — checking the meaning index…'
  if (!embedEnabled.value) return 'Ask — no embedding model set, so there is nothing to search'
  if (!askCount.value) return 'Ask — the meaning index is empty, build it under Bot'
  return `Ask — answers built from ${askCount.value} indexed ${askCount.value === 1 ? 'source' : 'sources'} (classes and wiki articles)`
})

// `null` statt `0`, solange nichts gerechnet ist: eine 0 waere die Behauptung „keine Zyklen", und
// die ist ohne die Rechnung nicht gedeckt. Ohne Klassen gibt es ohnehin nichts zu melden.
//
// ⚠️ **Gezaehlt werden ZWEI Befunde**: Zyklen und Beziehungen, die gegen eine aufgeschriebene Regel
// laufen. Beide erfuellen die Bedingung, die an diese Zahl gestellt ist – sie koennen echt 0 werden
// und fordern dann zu nichts auf (anders als Brandherde, die es in jeder Codebasis gibt). Und beide
// sind dieselbe Art Aussage: „hier stimmt etwas nicht mit der Struktur". Sie getrennt zu zeigen
// hiesse zwei Zahlen an einem Eintrag, und dann waere keine mehr auf einen Blick lesbar; welcher
// Anteil woher kommt, sagt der `title`.
const cycleCount = computed(() => {
  const t = insightTotals.value
  if (!t || !t.classes) return null
  return t.classCycles + t.packageCycles + (t.ruleViolations || 0)
})
const cycleTitle = computed(() => {
  const t = insightTotals.value
  const n = cycleCount.value
  if (n == null) return 'Insights'
  if (!n) return 'Insights — no dependency cycles, no broken rules'
  const parts = []
  const cycles = t.classCycles + t.packageCycles
  if (cycles) parts.push(`${cycles} dependency ${cycles === 1 ? 'cycle' : 'cycles'}`)
  if (t.ruleViolations) {
    parts.push(`${t.ruleViolations} ${t.ruleViolations === 1 ? 'relation breaks' : 'relations break'} a rule`)
  }
  return `Insights — ${parts.join(' · ')}`
})

// Navigation: code-first (Analyzer zuerst, dann Wiki). Icons ausschliesslich via Iconify.
const navLinks = computed(() => [
  { to: '/code', label: 'Code', icon: 'lucide:braces', count: files.value.length },
  // ⚠️ Die Zahl bei Insights ist ein BEFUND, kein Bestand: Klassen und Artikel zaehlen, was da
  // liegt – hier zaehlt, was auffaellt. Deshalb Zyklen und nicht etwa Brandherde: die gibt es in
  // jeder Codebasis (die schwerste Klasse existiert immer), eine Zahl die nie 0 wird fordert zu
  // nichts auf. Eine 0 ist hier die gute Nachricht und steht deshalb auch da – nur die Farbe
  // wechselt, sobald etwas zu tun ist.
  {
    to: '/insights',
    label: 'Insights',
    icon: 'lucide:activity',
    count: cycleCount.value,
    warn: cycleCount.value > 0,
    title: cycleTitle.value,
  },
  // ⚠️ Die Zahl bei Topic ist ein ARBEITSSTAND – die dritte Art Aussage in dieser Spalte (Bestand
  // bei Code/Wiki, Befund bei Insights, Zustand beim Bot-Punkt): sie zaehlt, was gerade
  // eingesammelt ist. Deshalb ist sie die einzige, die FEHLEN darf – ohne Buendel steht dort
  // nichts, denn eine „0" waere die Behauptung, hier fehle etwas. Kein `warn`: ein Buendel ist
  // nichts, was man in Ordnung bringen muesste.
  {
    to: '/topic',
    label: 'Topic',
    icon: 'lucide:boxes',
    // Ohne Bestand kein Buendel: nach einem Komplett-Reset zeigte der gemerkte Stand sonst eine
    // Zahl ueber Klassen, die es nicht mehr gibt (dieselbe „Erinnerung, keine Garantie"-Regel wie
    // beim Arbeitsstand der Code-Ansicht).
    count: files.value.length ? pickedCount.value : null,
    title: files.value.length && pickedCount.value
      ? `Topic — ${pickedCount.value} ${pickedCount.value === 1 ? 'class' : 'classes'} picked for “${topicTerm.value}”`
      : 'Collect every class around a topic and copy their code',
  },
  // Die Zahl bei Ask zaehlt nicht die Fragen, sondern die Klassen, aus denen eine Antwort
  // entstehen kann (s. `askCount`). ⚠️ KEIN `warn`, obwohl eine 0 heisst „findet nichts": die
  // Bedeutungssuche braucht Ollama, und das ist optional. Eine dauerhaft rote Null waere ein
  // Daueralarm ueber einen Zustand, den der Betreiber bewusst gewaehlt hat – dieselbe Regel wie
  // beim verwaisten Artikel im Wiki-Graphen (gestrichelt, nicht rot: nicht eingerichtet ist kein
  // Fehler). Was zu tun waere, sagt der Titel, und ob Ollama ueberhaupt antwortet, sagt der Punkt
  // beim Bot zwei Zeilen weiter.
  {
    to: '/ask',
    label: 'Ask',
    icon: 'lucide:help-circle',
    count: askCount.value,
    title: askTitle.value,
  },
  { to: '/wiki', label: 'Wiki', icon: 'lucide:book-open', count: articles.value.length },
  // Der Bot traegt keine Zahl, sondern einen Zustand: eine „3" waere hier keine Auskunft, die
  // Frage ist „antwortet er?". Der Punkt sitzt an derselben Stelle wie die Zaehler daneben.
  { to: '/bot', label: 'Bot', icon: 'lucide:bot', status: botStatus.value, title: botStatusLabel.value },
])

const DOT_COLOR = {
  online: 'var(--color-success)',
  warn: 'var(--color-warning)',
  offline: 'var(--color-danger)',
  unknown: 'var(--color-text-muted)',
}

const isDark = computed(() => theme.value === 'dark')

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-surface text-ink">
    <!-- ============================ SIDEBAR ============================ -->
    <aside
      class="flex h-full w-16 shrink-0 flex-col border-r border-line bg-surface-2 px-2 py-4 lg:w-60 lg:px-3"
    >
      <!-- Brand: Wikit-Icon bleibt IMMER neben dem Titel. Die Version steht als Chip statt als
           graue Zeile – sie ist die Auskunft „welche Fassung laeuft hier", nicht eine Fussnote.
           „· LOCAL" ist entfallen: dass es lokal laeuft, sagt schon die ganze Anwendung. -->
      <RouterLink
        to="/"
        class="flex items-center gap-2.5 rounded-lg px-1 py-1.5 transition hover:bg-surface-offset lg:px-2"
        title="Home"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon :icon="WIKI_ICON" class="text-xl" />
        </span>
        <span class="hidden min-w-0 flex-col items-start gap-0.5 leading-tight lg:flex">
          <span class="truncate font-mono text-[0.9375rem] font-semibold tracking-tight text-ink">{{ WIKI_TITLE }}</span>
          <span class="rounded bg-accent-soft px-1.5 py-px font-mono text-2xs font-semibold tracking-[0.06em] text-accent">v{{ WIKI_VERSION }}</span>
        </span>
      </RouterLink>
      <!-- Was diese Fassung gebracht hat. Steht UNTER der Nummer, weil es dieselbe Auskunft
           weiterfuehrt – und ausserhalb des Links: wer den Satz liest, will nicht zur Startseite.
           Der Text kommt aus `whatsNew` in der Root-package.json (s. config.js) und wird bei jedem
           Versions-Bump mitgepflegt.
           Kein Rahmen mehr: eine Box neben dem Versions-Chip sah aus wie ein zweites Bedienelement.
           Stattdessen ein ZITAT – Anfuehrungszeichen im Akzent, Satz kursiv: das liest sich als
           Stimme der Fassung („das ist neu"), nicht als angehaengter Halbsatz, und kostet keine
           Flaeche. Beim Hovern geht der Satz auf volle Textfarbe, weil er dann gelesen wird.
           Zwei Zeilen sind das Maximum, der Rest steht im Tooltip (gemessen bei 240–300 px
           Spaltenbreite: 61 Zeichen bleiben zweizeilig).
           ⚠️ Kein haengendes Anfuehrungszeichen (negatives `text-indent`): `line-clamp` bringt
           `overflow: hidden` mit, das Zeichen wurde dadurch angeschnitten statt in den Rand
           zu ragen. -->
      <p
        v-if="WIKI_WHATS_NEW"
        class="group mb-1 mt-2 hidden px-2 lg:block"
        :title="WIKI_WHATS_NEW"
      >
        <span
          class="line-clamp-2 text-2xs italic leading-snug text-muted transition-colors duration-200 group-hover:text-ink"
        >
          <span class="not-italic text-accent">“</span>{{ WIKI_WHATS_NEW }}<span class="not-italic text-accent">”</span>
        </span>
      </p>

      <!-- Suche (oeffnet die Palette) -->
      <button
        type="button"
        class="mb-4 mt-2.5 flex w-full items-center gap-2 rounded-md border border-line bg-surface-offset px-2 py-2 text-muted transition hover:border-line-strong lg:px-2.5"
        title="Search (Ctrl+K)"
        @click="searchOpen = true"
      >
        <Icon icon="lucide:search" class="h-4 w-4 shrink-0" />
        <span class="hidden flex-1 truncate text-left text-[0.78125rem] lg:inline">Search…</span>
        <kbd class="ml-auto hidden shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[0.59375rem] tracking-wide text-muted lg:inline">Ctrl K</kbd>
      </button>

      <!-- Navigation -->
      <p class="hidden px-2 pb-2 font-mono text-[0.59375rem] font-semibold tracking-[0.16em] text-muted lg:block">NAVIGATE</p>
      <nav class="flex flex-col gap-1">
        <RouterLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="relative flex items-center gap-2.5 rounded-md px-2 py-2 text-[0.8125rem] font-medium transition lg:px-2.5"
          :class="isActive(link.to)
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:bg-surface-offset'"
          :title="link.title || link.label"
        >
          <span
            v-if="isActive(link.to)"
            class="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-accent"
          />
          <span class="relative shrink-0">
            <Icon :icon="link.icon" class="h-[18px] w-[18px]" />
            <!-- In der schmalen Icon-Spalte gibt es keine Zeile fuer den Zustand – dort sitzt der
                 Punkt am Symbol, damit die Auskunft auf jeder Breite ankommt. -->
            <span
              v-if="link.status"
              class="absolute -right-1 -top-0.5 h-2 w-2 rounded-full ring-2 ring-surface-2 lg:hidden"
              :style="{ background: DOT_COLOR[link.status] }"
            />
            <!-- Ersatz fuer die Fortschrittskarte in der schmalen Icon-Spalte: dort ist fuer eine
                 Phasenleiste kein Platz, aber „es laeuft etwas" muss trotzdem ankommen. Hier ist
                 der Puls angebracht (anders als beim Bot-Punkt): der zeigt einen ZUSTAND, dieser
                 einen laufenden Vorgang – und genau das ist die Aussage. -->
            <span
              v-if="link.to === '/code' && activityBusy"
              class="absolute -right-1 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent ring-2 ring-surface-2 lg:hidden"
            />
          </span>
          <span class="hidden flex-1 lg:inline">{{ link.label }}</span>
          <!-- Zustand und Zaehler teilen sich EINEN Slot (`w-6`, zentriert, `mr-2` vom Rand): der
               Punkt ist 8 px breit, das Zahlenfeld 24 – rechtsbuendig gesetzt laegen sie auf zwei
               Achsen, und drei Nav-Zeilen untereinander machen jeden Versatz sichtbar. Der Abstand
               zum Rand gehoert dazu, sonst klebt der Punkt an der Trennlinie. -->
          <span
            v-if="link.status"
            class="ml-auto mr-2 hidden w-6 shrink-0 items-center justify-center lg:flex"
          >
            <!-- Bewusst ohne Animation: ein Punkt, der dauerhaft pulsiert, ist nach zwei Minuten
                 Arbeit nur noch Unruhe (dieselbe Zurueckhaltung wie beim „Add code"-Knopf). -->
            <span class="h-2 w-2 rounded-full" :style="{ background: DOT_COLOR[link.status] }" />
          </span>
          <!-- Ein Befund faerbt sich, ein Bestand nicht: „3" neben Insights heisst „hier stimmt
               etwas nicht", „18" neben Code heisst nur „so viele". Gleicher Slot, andere Aussage. -->
          <span
            v-else
            class="ml-auto mr-2 hidden w-6 shrink-0 text-center font-mono text-2xs lg:inline"
            :class="link.warn
              ? 'text-danger'
              : isActive(link.to) ? 'text-accent' : 'text-muted'"
          >{{ link.count }}</span>
        </RouterLink>
      </nav>

      <div class="flex-1" />

      <!-- Was gerade auf dem Server laeuft (Import, Reset, Kanten, KI-Queue). Steht hier, weil die
           Sidebar die einzige Flaeche ist, die JEDE Ansicht zeigt – der Fortschritt hing vorher an
           der Code-Ansicht und war beim Wechseln weg, obwohl der Lauf weiterging. -->
      <ActivityCard />

      <!-- Kuerzel der aktuellen Ansicht. Sie standen bisher nirgends – man musste sie kennen oder
           in einem `title` finden. Hier ist Platz (die Spalte ist unten leer), und die Liste bleibt
           kurz: alles Weitere ist einen Tastendruck entfernt (`?`). Nur im breiten Layout – in der
           Icon-Spalte waere sie unlesbar.
           Sie bleibt waehrend eines Laufs stehen: dass ein Import laeuft, ist kein Grund, dem
           Nutzer die Bedienung wegzunehmen – und ein Block, der kommt und geht, laesst den unteren
           Teil der Sidebar bei jedem Start und jedem Ende springen. Damit beides sicher
           nebeneinander passt, zeigt die Liste `SIDEBAR_LIMIT` Zeilen (lib/shortcuts.js). -->
      <div class="mb-3 hidden lg:block">
        <button
          type="button"
          class="mb-1.5 flex w-full items-center gap-1.5 px-2 font-mono text-[0.59375rem] font-semibold tracking-[0.16em] text-muted transition hover:text-ink"
          title="Show all keyboard shortcuts (?)"
          @click="shortcutsOpen = true"
        >
          SHORTCUTS
          <!-- Die Taste steht am Einstieg, seit `help` nicht mehr in der gekuerzten Liste steht –
               sonst waere die Uebersicht nur noch mit der Maus erreichbar. -->
          <kbd class="rounded border border-line bg-surface px-1 py-px font-mono text-[0.59375rem] font-medium text-ink">?</kbd>
          <Icon icon="lucide:arrow-up-right" class="ml-auto h-3 w-3 opacity-60" />
        </button>
        <ul class="space-y-1">
          <li
            v-for="s in sidebarKeys"
            :key="s.id"
            class="flex items-center gap-2 rounded-md px-2 py-1 text-muted"
          >
            <span class="flex shrink-0 items-center gap-1">
              <template v-for="(combo, ci) in s.keys" :key="combo">
                <span v-if="ci > 0" class="text-[0.59375rem] opacity-70">{{ s.seq ? 'then' : '/' }}</span>
                <kbd
                  v-for="chip in keyChips(combo)"
                  :key="chip"
                  class="rounded border border-line bg-surface px-1 py-px font-mono text-[0.59375rem] font-medium text-ink"
                >{{ chip }}</kbd>
              </template>
            </span>
            <span class="min-w-0 flex-1 truncate text-2xs">{{ s.label }}</span>
          </li>
        </ul>
      </div>

      <!-- Neuer Artikel -->
      <RouterLink
        to="/new"
        class="mb-2 flex items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-2 text-[0.78125rem] font-semibold text-accent-contrast transition hover:bg-accent-hover"
        title="New article"
      >
        <Icon icon="lucide:plus" class="h-4 w-4 shrink-0" />
        <span class="hidden lg:inline">New article</span>
      </RouterLink>

      <!-- Theme-Toggle (Pill) -->
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md border border-line px-2 py-2 font-mono text-2xs tracking-wide text-muted transition hover:bg-surface-offset lg:px-2.5"
        :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="toggleTheme"
      >
        <Icon :icon="isDark ? 'lucide:moon' : 'lucide:sun'" class="h-4 w-4 shrink-0 text-accent" />
        <span class="hidden flex-1 text-left uppercase lg:inline">{{ theme }}</span>
        <span class="hidden h-[15px] w-[26px] shrink-0 rounded-full bg-accent-soft lg:inline-block" style="position:relative">
          <span
            class="absolute top-[2px] h-[11px] w-[11px] rounded-full bg-accent transition-[left]"
            :style="{ left: isDark ? '13px' : '2px' }"
          />
        </span>
      </button>
    </aside>

    <!-- ============================ MAIN ============================ -->
    <main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
      <RouterView v-slot="{ Component }">
        <!-- ⚠️ `route.path`, NICHT `route.fullPath`: die Query gehoert der Ansicht, nicht ihrer
             Identitaet. Vier Ansichten schreiben ihren Zustand selbst in die Adresse
             (`/ask?q=`, `/topic?q=`, `/article/:slug/history?from=&to=`) – mit `fullPath` war
             jedes dieser `router.replace` ein Schluesselwechsel und damit ein vollstaendiger
             Neuaufbau der Ansicht. Bei `/ask` hiess das: die Frage wurde ZWEIMAL gestellt (die
             zerstoerte Instanz schliesst nur ihren Strom, der Lauf auf dem Server laeuft weiter),
             bei der Fassungsliste wurde sie bei jedem Blaettern neu geladen.
             Parameter stecken im `path` – `/article/a` und `/article/b` bleiben verschieden. -->
        <component :is="Component" :key="route.path" />
      </RouterView>
    </main>

    <SearchPalette :open="searchOpen" @close="searchOpen = false" />
    <ShortcutsOverlay :open="shortcutsOpen" @close="shortcutsOpen = false" />

    <!-- Detail zur Fortschrittskarte. Steht hier und nicht in der Code-Ansicht, weil der Lauf
         ueberall sichtbar ist – seinen Einzelheiten in genau eine Ansicht zu legen waere derselbe
         Fehler, den die Karte gerade behoben hat. Der Offen-Zustand liegt in `useActivity`. -->
    <ActivityModal />

    <!-- Globale Rueckmeldungen. Steht hier, damit sie auf JEDER Route erscheinen – ein Fehler
         soll nicht davon abhaengen, welche Ansicht ihn ausgeloest hat. -->
    <NotificationHost />
  </div>
</template>
