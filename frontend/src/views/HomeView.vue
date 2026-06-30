<script setup>
// Workbench-Landing: asymmetrisches Zwei-Spalten-Layout.
// Links = Primaeraktion (Java hochladen/einfuegen -> analysieren -> Sprung in den Analyzer).
// Rechts = code-thematisches Live-Panel (Demo-Snippet + Echtzeit-Stats + Schnelleinstiege).
// Hintergrund = dezentes, theme-abhaengiges Graph-Mesh (Knoten + Kanten, opacity < 0.06).
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useArticles } from '../composables/useArticles.js'
import { api } from '../lib/api.js'
import { WIKI_TITLE } from '../config.js'
import JavaCodeEditor from '../components/java/JavaCodeEditor.vue'
import { Icon } from '../lib/icons.js'

const router = useRouter()
const { files, fetchFiles, analyzeCode, analyzing, error, userContext, lastFileId } = useJavaAnalyzer()
const { enqueueClass, allJobs } = useJavaQueue()
const { articles, categories, load } = useArticles()

const source = ref('')
const filename = ref('')
const dragging = ref(false)
const showPaste = ref(false)
const showContext = ref(false)
// Anzahl Relationen (= Kanten im Wissens-Graph) fuer die Graph-Kachel. Eigener Fetch, da es
// keinen Relations-Store gibt; api.getGraph() liefert { nodes, edges } (s. RelationGraph.vue).
const relationCount = ref(0)

onMounted(() => {
  fetchFiles()
  load() // gecachter No-Op, falls App.vue bereits geladen hat (useArticles als Singleton-Store)
  api
    .getGraph()
    .then((g) => {
      relationCount.value = g.edges?.length ?? 0
    })
    .catch(() => {}) // Graph optional – Kachel zeigt dann 0
})

const recent = computed(() => [...files.value].slice(0, 6))

// Aktive + wartende KI-Jobs (gleiche Logik wie App.vue). Bewusst KEIN ensurePolling() hier –
// die Landing zeigt den zuletzt bekannten Stand; 0 im Leerlauf ist korrekt.
const pendingCount = computed(
  () => allJobs.value.filter((j) => ['running', 'queued'].includes(j.status)).length,
)

// Vier Kacheln = die vier Nav-Tabs (gleiche Icons/Routen wie App.vue navLinks). Reihenfolge
// steuert das 2x2-Raster: Code (oben links) · Queues (oben rechts) · Wiki (unten links) ·
// Graph (unten rechts). Jede Kachel traegt eine Live-Zahl als sekundaere Metrik.
const tabs = computed(() => [
  { icon: 'lucide:braces', value: files.value.length, label: 'Code', to: '/code' },
  { icon: 'lucide:list-checks', value: pendingCount.value, label: 'Queues', to: '/code/queues' },
  { icon: 'lucide:book-open', value: articles.value.length, label: 'Wiki', to: '/wiki' },
  { icon: 'lucide:share-2', value: relationCount.value, label: 'Graph', to: '/graph' },
])

const quickLinks = [{ to: '/new', label: 'New article', icon: 'lucide:plus' }]

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
  <div class="landing relative min-h-[calc(100vh-3.5rem)] overflow-hidden">
    <!-- Hintergrund: dezentes Graph-Mesh (rein dekorativ, kein Icon) -->
    <div class="mesh pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
      <svg class="mesh-svg h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 800 600">
        <g class="mesh-edges" stroke="var(--color-accent)" stroke-width="1" fill="none">
          <path d="M120 90 L300 180 L210 360 L120 90 M300 180 L520 130 L640 300 L520 130 M210 360 L430 470 L640 300 M430 470 L260 540 M640 300 L700 480" />
        </g>
        <g class="mesh-nodes" fill="var(--color-accent)">
          <circle cx="120" cy="90" r="4" />
          <circle cx="300" cy="180" r="5" />
          <circle cx="210" cy="360" r="4" />
          <circle cx="520" cy="130" r="4" />
          <circle cx="640" cy="300" r="5" />
          <circle cx="430" cy="470" r="4" />
          <circle cx="260" cy="540" r="3" />
          <circle cx="700" cy="480" r="3" />
        </g>
      </svg>
    </div>

    <div class="mx-auto grid max-w-6xl items-center gap-10 px-5 py-12 lg:min-h-[calc(100vh-3.5rem)] lg:grid-cols-[1.3fr_1fr] lg:gap-14 lg:py-0">
      <!-- ===== Links: Primaeraktion ===== -->
      <section class="reveal min-w-0">
        <p class="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          <Icon icon="lucide:terminal" class="h-3.5 w-3.5 text-[var(--color-accent)]" />
          Local code intelligence · no cloud, no login
        </p>

        <h1 class="text-3xl font-bold tracking-tight text-[var(--color-text)] sm:text-4xl">
          {{ WIKI_TITLE }}
        </h1>
        <p class="mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--color-text-muted)]">
          A self-hosted knowledge base for developers: author notes in
          <span class="font-medium text-[var(--color-text)]">Markdown</span>, parse
          <span class="font-medium text-[var(--color-text)]">Java</span> locally into a class graph
          with per-method AI summaries, and connect everything in a
          <span class="font-medium text-[var(--color-text)]">knowledge graph</span>.
        </p>

        <!-- Upload-Karte -->
        <div class="mt-7">
          <div
            class="group relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition"
            :class="dragging
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-accent)]'"
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

            <p v-if="filename" class="mt-3 flex max-w-full items-center justify-center gap-1.5 text-sm font-medium text-[var(--color-text)]">
              <Icon icon="lucide:file-text" class="h-4 w-4 shrink-0" />
              <span class="truncate">{{ filename }}</span>
            </p>
          </div>

          <!-- Code einfuegen (einklappbar) -->
          <button
            type="button"
            class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-accent)] transition hover:opacity-80"
            @click="showPaste = !showPaste"
          >
            <Icon icon="lucide:chevron-right" class="h-3.5 w-3.5 transition-transform" :class="showPaste ? 'rotate-90' : ''" />
            or paste code
          </button>
          <div v-show="showPaste" class="mt-2 h-60">
            <JavaCodeEditor v-model="source" />
          </div>

          <!-- Projekt-Kontext (einklappbar) -->
          <button
            type="button"
            class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
            @click="showContext = !showContext"
          >
            <Icon icon="lucide:chevron-right" class="h-3.5 w-3.5 transition-transform" :class="showContext ? 'rotate-90' : ''" />
            Project context (optional){{ userContext ? ' · active' : '' }}
          </button>
          <textarea
            v-show="showContext"
            v-model="userContext"
            spellcheck="false"
            rows="2"
            placeholder="e.g. Windchill background, module purpose… – fed into every AI prompt."
            class="mt-2 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />

          <p v-if="error" class="mt-3 text-sm text-[var(--color-danger)]">{{ error }}</p>

          <!-- Analysieren -->
          <button
            type="button"
            class="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            :disabled="analyzing || !source.trim()"
            @click="analyze"
          >
            <Icon v-if="analyzing" icon="lucide:loader-2" class="h-4 w-4 animate-spin" />
            <Icon v-else icon="lucide:arrow-right" class="h-4 w-4" />
            {{ analyzing ? 'Analyzing…' : 'Analyze class' }}
          </button>
        </div>
      </section>

      <!-- ===== Rechts: Code-Panel + Live-Stats ===== -->
      <aside class="reveal reveal-delay min-w-0 space-y-4">
        <!-- Editor-artige Demo-Karte (statisches Snippet, kein Shiki) -->
        <div class="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-sm">
          <div class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-2">
            <span class="flex gap-1.5">
              <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-danger)]/60"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-warning)]/70"></span>
              <span class="h-2.5 w-2.5 rounded-full bg-[var(--color-success)]/70"></span>
            </span>
            <span class="ml-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
              {{ WIKI_TITLE }}.java
            </span>
            <Icon icon="lucide:terminal" class="ml-auto h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          </div>
          <pre class="snippet overflow-x-auto px-4 py-3 text-[12.5px] leading-relaxed"><code><span class="c">/** Parsed locally — no JDK required. */</span>
<span class="k">public class</span> <span class="t">{{ WIKI_TITLE }}</span> {
  <span class="k">private final</span> <span class="t">Graph</span> graph;

  <span class="c">// AI-documented per method via Ollama</span>
  <span class="k">public</span> <span class="t">Article</span> <span class="fn">analyze</span>(<span class="t">Class</span> c) {
    <span class="k">return</span> graph.<span class="fn">link</span>(c).<span class="fn">summarize</span>();
  }
}</code></pre>
        </div>

        <!-- Tab-Kacheln (= die vier Nav-Tabs) mit Live-Zahl -->
        <div class="grid grid-cols-2 gap-3">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5 transition hover:border-[var(--color-accent)]"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-2 text-[var(--color-text)]">
                <Icon :icon="t.icon" class="h-4 w-4 text-[var(--color-accent)]" />
                <span class="text-sm font-semibold">{{ t.label }}</span>
              </span>
              <Icon icon="lucide:arrow-right" class="h-4 w-4 -translate-x-1 text-[var(--color-accent)] opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
            </div>
            <div class="mt-1.5 text-2xl font-bold tabular-nums text-[var(--color-text)]">{{ t.value }}</div>
          </RouterLink>
        </div>

        <!-- Zuletzt analysiert -->
        <div v-if="recent.length">
          <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Recently analyzed</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="f in recent"
              :key="f.id"
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              @click="openClass(f.id)"
            >
              <Icon v-if="f.description" icon="lucide:sparkles" class="h-3.5 w-3.5 text-[var(--color-accent)]" />
              {{ f.class_name }}
            </button>
          </div>
        </div>

        <!-- Schnelleinstiege -->
        <div class="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3">
          <RouterLink
            v-for="link in quickLinks"
            :key="link.to"
            :to="link.to"
            class="group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
          >
            <Icon :icon="link.icon" class="h-4 w-4 text-[var(--color-accent)]" />
            <span>{{ link.label }}</span>
            <Icon icon="lucide:arrow-right" class="ml-auto h-4 w-4 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
          </RouterLink>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* --- Graph-Mesh-Hintergrund: theme-abhaengig ueber --color-accent, sehr dezent ---------- */
.mesh-svg {
  opacity: 0.05;
}
.mesh-edges {
  animation: mesh-drift 36s ease-in-out infinite alternate;
  transform-origin: center;
}
.mesh-nodes {
  animation: mesh-pulse 8s ease-in-out infinite;
}
@keyframes mesh-drift {
  from {
    transform: translate3d(0, 0, 0) scale(1);
  }
  to {
    transform: translate3d(-14px, 10px, 0) scale(1.03);
  }
}
@keyframes mesh-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* --- Statisches Java-Snippet: themenunabhaengige, ruhige Syntax-Toene ------------------- */
.snippet {
  color: var(--color-text);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
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

@media (prefers-reduced-motion: reduce) {
  .mesh-edges,
  .mesh-nodes,
  .reveal {
    animation: none;
  }
}
</style>
