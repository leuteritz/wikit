<script setup>
// Landing: Titel, Suche, eine Zeile Bilanz – und was auf eine Handlung wartet. Sonst nichts.
//
// Vorher stand hier ein Bento aus Einlese-Karte (Drop-Zone, Paste-Editor, Project-Context,
// Analyze-Knopf), Zahlkacheln, Package-Balken und Chips der zuletzt analysierten Klassen. Das war
// eine zweite Code-Ansicht vor der Code-Ansicht: jedes dieser Elemente gibt es dort noch einmal,
// nur vollstaendiger. Die Startseite beantwortet stattdessen die eine Frage, mit der man sie
// oeffnet – „wo ist X?" – und sagt in einer Zeile, worin gesucht wird.
//
// Was hier entfaellt, ist nirgends verloren: „Add code" oeffnet drueben direkt das Modal
// (`openAddCode`, s. useJavaAnalyzer), Project context sitzt darin, und die zuletzt analysierten
// Klassen stehen in der Klassenliste der Code-Ansicht – sortiert, filterbar, vollstaendig.
//
// ⚠️ **Die Grenze verlaeuft nicht bei „wenig", sondern bei der ART der Auskunft.** Bestand und
// Werkzeuge gehoeren nach `/code` und `/wiki` – dort sind sie vollstaendig. Hierher gehoert nur,
// was auf eine HANDLUNG wartet: wo man zuletzt war, und was offen ist. Beides beantwortet „wie
// mache ich weiter?", und diese Frage stellt man genau hier. Deshalb kein Balken, keine Kachel
// und keine Zahl ohne Aufforderung – und deshalb verschwindet die Liste vollstaendig, sobald
// nichts offen ist (eine Liste, die immer dasteht, fordert zu nichts auf).
//
// Die Zahlen kommen aus den Stores, die App.vue fuer die Sidebar ohnehin laedt: **kein
// zusaetzlicher Request auf der Startseite** – deshalb fehlt der Wiki-Bericht in der Liste, der
// einen eigenen kostet (s. `lib/nextActions.js`).
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useArticles } from '../composables/useArticles.js'
import { useInsights } from '../composables/useInsights.js'
import { useEmbeddings } from '../composables/useEmbeddings.js'
import { WIKI_TITLE, WIKI_ICON } from '../config.js'
import MeshBackground from '../components/MeshBackground.vue'
import SearchPalette from '../components/SearchPalette.vue'
import { buildNextActions } from '../lib/nextActions.js'
import { recentArticles } from '../lib/recentArticles.js'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { files, fetchFiles, openAddCode } = useJavaAnalyzer()
const { articles, load } = useArticles()
// ⚠️ Nur GELESEN, nicht geholt: `App.vue` laedt beide fuer die Sidebar-Zahlen, sobald es Klassen
// gibt. Ein `ensure()` hier waere derselbe Request ein zweites Mal – und auf einer Startseite,
// die ausdruecklich keinen eigenen stellt.
const { totals: insightTotals } = useInsights()
const { enabled: embedEnabled, todo: embedTodo } = useEmbeddings()

// Wo man war. Aus dem Speicher, kein Request – und bewusst NICHT „zuletzt geaendert": das
// beantwortet, was neu ist (auch nach einem Import), nicht, woran ICH war.
const recent = ref(recentArticles())

onMounted(() => {
  fetchFiles()
  load() // gecachter No-Op, falls App.vue bereits geladen hat (useArticles als Singleton-Store)
})

// EIN Durchlauf ueber die Klassenliste – auf einer gefuellten Instanz sind das ein paar tausend
// Eintraege, und drei getrennte `computed` waeren drei Durchlaeufe fuer dieselben Felder.
const stats = computed(() => {
  const packages = new Set()
  let methods = 0
  for (const f of files.value) {
    packages.add(f.package || '')
    methods += f.method_count || 0
  }
  return { classes: files.value.length, methods, packages: packages.size }
})

// Die Bilanz als eine Zeile. Leere Werte fallen raus, statt als „0" dazustehen: eine Null ist
// keine Auskunft ueber den Bestand, sondern nur die Abwesenheit einer.
const facts = computed(() =>
  [
    { n: stats.value.classes, one: 'class', many: 'classes' },
    { n: stats.value.methods, one: 'method', many: 'methods' },
    { n: stats.value.packages, one: 'package', many: 'packages' },
    { n: articles.value.length, one: 'article', many: 'articles' },
  ].filter((f) => f.n > 0),
)

// Was offen ist. ⚠️ Die Liste ist eine LESEART bereits gerechneter Befunde – hier wird nichts
// ermittelt (s. `lib/nextActions.js`). Sie verschwindet vollstaendig, sobald nichts aussteht.
// Dasselbe Kriterium, das die Code-Ansicht in ihrer Kopfzeile zaehlt (`analyzedCount`): eine
// Klasse gilt als beschrieben, wenn `description` gefuellt ist. Zwei Rechnungen fuer dieselbe
// Aussage waeren zwei Zahlen, die sich widersprechen koennen.
const unanalysed = computed(() => files.value.filter((f) => !f.description).length)
const nextActions = computed(() =>
  buildNextActions({
    insights: insightTotals.value,
    unanalysed: unanalysed.value,
    embeddings: { enabled: embedEnabled.value, todo: embedTodo.value },
  }),
)

// Der erste Eindruck einer frischen Installation. Bis hierher verschwand bei leerem Bestand auch
// die Bilanzzeile ersatzlos (`facts` filtert Nullen weg) – wer Wikit zum ersten Mal oeffnete, sah
// Titel, leeres Feld und vier Links, aber nirgends „fang hier an".
const isEmpty = computed(() => !files.value.length && !articles.value.length)

const links = [
  { label: 'Code', icon: 'lucide:braces', to: '/code' },
  { label: 'Wiki', icon: 'lucide:book-open', to: '/wiki' },
  { label: 'New article', icon: 'lucide:plus', to: '/new' },
]

const TONE_CLASS = {
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-muted',
}

function addCode() {
  openAddCode.value = true
  router.push('/code')
}
</script>

<template>
  <div class="landing relative flex min-h-full flex-col overflow-hidden">
    <!-- Hintergrund: animiertes Constellation-Netz (Canvas, eigene Komponente) -->
    <MeshBackground />

    <!-- Senkrecht mittig statt oben angeschlagen: die Seite traegt jetzt so wenig, dass sie sonst
         als Rest am oberen Rand haengen wuerde. `pb-24` haelt die optische Mitte etwas ueber der
         geometrischen – dort erwartet man sie. -->
    <div class="relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-5 py-12 pb-24">
      <section class="reveal text-center">
        <h1 class="flex items-center justify-center gap-3 font-mono text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          <Icon :icon="WIKI_ICON" class="shrink-0 text-accent" />
          <span class="text-accent">{{ WIKI_TITLE }}</span><span class="blink font-normal text-accent">_</span>
        </h1>
        <p class="mt-2.5 text-sm text-muted">
          Java class graph and Markdown notes — local, no cloud, no login.
        </p>
      </section>

      <!-- DIESELBE Komponente wie hinter Strg+K (`variant="inline"`): gleiche Rangfolge, gleiche
           Tastatur, gleicher Sprung in die Code-Ansicht – nur ohne den dunklen Ueberzug. -->
      <div class="reveal mt-7">
        <SearchPalette variant="inline" facet-bar />
      </div>

      <!-- Bilanz: eine Zeile, keine Kacheln. Sie sagt, worin die Suche darueber sucht – mehr will
           die Startseite ueber den Bestand nicht behaupten. -->
      <p
        v-if="facts.length"
        class="reveal reveal-delay mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center font-mono text-2xs text-muted"
      >
        <template v-for="(f, i) in facts" :key="f.one">
          <span v-if="i" class="opacity-40">·</span>
          <span><span class="font-semibold tabular-nums text-ink">{{ f.n }}</span> {{ f.n === 1 ? f.one : f.many }}</span>
        </template>
      </p>

      <!-- Frische Installation: der eine Satz, der bis hierher fehlte. `facts` filtert Nullen weg,
           also verschwand bei leerem Bestand auch die Bilanzzeile – und damit stand hier gar
           nichts mehr, was sagt, wo man anfaengt. -->
      <p v-else-if="isEmpty" class="reveal reveal-delay mt-5 text-center text-2xs text-muted">
        Nothing stored yet — paste some Java under “Add code”, or write your first article.
      </p>

      <!-- Woran du warst. Nicht „zuletzt geaendert": das beantwortet, was NEU ist (auch nach einem
           Import), nicht, wo ICH war – und beim Wiedereinstieg ist das die Frage. -->
      <p
        v-if="recent.length"
        class="reveal reveal-delay mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-center text-2xs"
      >
        <span class="font-mono text-muted opacity-70">where you were</span>
        <RouterLink
          v-for="a in recent"
          :key="a.slug"
          :to="`/article/${a.slug}`"
          class="max-w-[14rem] truncate rounded-md border border-line px-2 py-0.5 text-muted transition hover:border-accent hover:text-accent"
        >
          {{ a.title }}
        </RouterLink>
      </p>

      <!-- ================= Was offen ist =================
           ⚠️ Sieben Sorten Befund rechnet Wikit bereits – und legt jede in eine andere Ansicht.
           Niemand fragt „zeig mir die Zyklen"; man fragt „was soll ich als Naechstes tun?", und
           dafuer musste man bis hierher fuenf Orte abklappern.

           Die Liste ist eine Leseart, kein neuer Befund: sie rechnet nichts (s. lib/nextActions.js)
           und verschwindet vollstaendig, sobald nichts aussteht. Eine Liste, die immer dasteht,
           fordert zu nichts auf – dieselbe Regel wie bei den Zahlen der Sidebar. -->
      <ul
        v-if="nextActions.length"
        class="reveal reveal-delay mx-auto mt-6 flex w-full max-w-md flex-col gap-1"
      >
        <li v-for="a in nextActions" :key="a.id">
          <RouterLink
            :to="a.to"
            class="group flex items-center gap-2.5 rounded-lg border border-line/70 px-3 py-1.5 text-left transition hover:border-accent hover:bg-surface-2"
          >
            <Icon :icon="a.icon" class="h-3.5 w-3.5 shrink-0" :class="TONE_CLASS[a.tone] || 'text-muted'" />
            <span class="min-w-0 flex-1 truncate text-2xs text-muted">
              <span class="font-mono font-semibold tabular-nums" :class="TONE_CLASS[a.tone] || 'text-ink'">
                {{ a.count }}
              </span>
              {{ a.count === 1 ? a.label : a.labelMany }}
            </span>
            <Icon
              icon="lucide:arrow-right"
              class="h-3.5 w-3.5 shrink-0 -translate-x-1 text-accent opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100"
            />
          </RouterLink>
        </li>
      </ul>

      <!-- Die drei Wege weiter. Textlinks statt Kacheln: sie sind der Ausgang der Seite, nicht ihr
           Inhalt – und „Add code" fuehrt bis ins Modal, nicht nur bis zu dem Knopf, der es oeffnet. -->
      <nav class="reveal reveal-delay mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
        <RouterLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="group inline-flex items-center gap-1.5 font-medium text-muted transition hover:text-accent"
        >
          <Icon :icon="l.icon" class="h-4 w-4 text-accent" />
          {{ l.label }}
          <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </RouterLink>
        <button
          type="button"
          class="group inline-flex items-center gap-1.5 font-medium text-muted transition hover:text-accent"
          @click="addCode"
        >
          <Icon icon="lucide:upload" class="h-4 w-4 text-accent" />
          Add code
          <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* --- Mount-Reveal (dezent), respektiert reduzierte Bewegung ----------------------------- */
.reveal {
  animation: reveal-in var(--dur-slow) var(--ease-out) both;
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

@media (prefers-reduced-motion: reduce) {
  .reveal,
  .blink {
    animation: none;
  }
}
</style>
