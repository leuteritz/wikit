<script setup>
// Landing: Titel, Suche, eine Zeile Bilanz. Sonst nichts.
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
// Die Zahlen kommen aus der Klassenliste, die App.vue fuer den Nav-Zaehler ohnehin laedt: kein
// zusaetzlicher Request auf der Startseite.
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useArticles } from '../composables/useArticles.js'
import { WIKI_TITLE, WIKI_ICON } from '../config.js'
import MeshBackground from '../components/MeshBackground.vue'
import SearchPalette from '../components/SearchPalette.vue'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { files, fetchFiles, openAddCode } = useJavaAnalyzer()
const { articles, load } = useArticles()

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

const links = [
  { label: 'Code', icon: 'lucide:braces', to: '/code' },
  { label: 'Wiki', icon: 'lucide:book-open', to: '/wiki' },
  { label: 'New article', icon: 'lucide:plus', to: '/new' },
]

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
