<script setup>
// Der Fassungsverlauf eines Artikels: links, was passiert ist – rechts, was sich geändert hat.
//
// ⚠️ Die Ansicht hat KEINEN eigenen Zustand über den Reload hinaus (anders als /code oder /topic).
// Was hier gemerkt gehört, ist keine Arbeitshaltung, sondern die Frage selbst – und die steht in
// der URL (`?from=&to=`). Ein „so stand es vor dem Umbau" ist etwas, das man verlinkt.
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { useArticles } from '../composables/useArticles.js'
import { formatDateTime, formatRelative } from '../lib/format.js'
import { Icon } from '../lib/icons.js'
import ArticleDiff from '../components/ArticleDiff.vue'
import BusyState from '../components/BusyState.vue'

const props = defineProps({ slug: { type: String, required: true } })
const route = useRoute()
const router = useRouter()
const store = useArticles()

const articleId = ref(null)
const data = ref(null)
const diff = ref(null)
const loading = ref(true)
const diffLoading = ref(false)
const error = ref('')
const restored = ref(0)
const startedAt = ref(Date.now())

const from = ref(0)
const to = ref(0)

const versions = computed(() => data.value?.versions || [])
const newest = computed(() => (versions.value.length ? versions.value[0].version_number : 0))
// Nur die höchste Fassung IST der aktuelle Stand des Artikels (Invariante des Schreibpfads,
// s. article-versions.service.ts) – „restore" auf sie wäre ein Speichern ohne Änderung.
const canRestore = computed(() => to.value > 0 && to.value !== newest.value)

onMounted(async () => {
  try {
    // Die Id kommt aus dem ohnehin geladenen Store, nicht aus einem eigenen Request: die Route
    // kennt nur den Slug, und den vollen Artikel samt gerendertem HTML zu holen, um eine Zahl
    // daraus zu lesen, wäre ein Request für ein Feld.
    if (!store.articles.value.length) await store.load()
    const found = store.articles.value.find((a) => a.slug === props.slug)
    if (!found) throw new Error('Article not found')
    articleId.value = found.id
    await reload()
    applyRoute()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

async function reload() {
  data.value = await api.listArticleVersions(articleId.value)
}

/** Auswahl aus der URL übernehmen – sonst die neueste Fassung gegen ihre Vorfassung. */
function applyRoute() {
  const q = route.query
  const wantTo = Number(q.to) || newest.value
  // `from` darf 0 sein („gegen nichts"), deshalb hier bewusst kein `||`: die 0 ist eine Wahl.
  const wantFrom = q.from !== undefined ? Number(q.from) || 0 : Math.max(0, wantTo - 1)
  to.value = clamp(wantTo)
  from.value = q.from !== undefined ? clamp(wantFrom) : Math.max(0, to.value - 1)
}

function clamp(n) {
  if (!versions.value.length) return 0
  const known = versions.value.map((v) => v.version_number)
  if (known.includes(n)) return n
  return n === 0 ? 0 : newest.value
}

watch([from, to], async ([f, t]) => {
  if (!t) {
    diff.value = null
    return
  }
  // Die URL trägt die Auswahl mit – aber per `replace`: durch einen Vergleich zu blättern soll
  // nicht bedeuten, dass der Zurück-Knopf danach zwanzigmal gedrückt werden muss.
  router.replace({ query: { ...route.query, from: String(f), to: String(t) } })
  diffLoading.value = true
  try {
    diff.value = await api.diffArticleVersions(articleId.value, f, t)
  } catch {
    diff.value = null
  } finally {
    diffLoading.value = false
  }
})

/** Klick in der Liste: diese Fassung gegen ihre Vorfassung – die häufigste Frage in einem Klick. */
function pick(v) {
  to.value = v.version_number
  from.value = Math.max(0, v.version_number - 1)
}

async function restore(v) {
  if (!confirm(`Restore version ${v} of “${data.value.article.title}”? The current text is kept as a version.`)) return
  await api.restoreArticleVersion(articleId.value, v)
  await store.reload()
  await reload()
  restored.value = v
  to.value = newest.value
  from.value = Math.max(0, newest.value - 1)
}
</script>

<template>
  <div class="flex h-full flex-col px-5 py-5">
    <!-- Kopf -->
    <div class="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <RouterLink
          :to="`/article/${slug}`"
          class="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:border-accent hover:text-accent"
          title="Back to the article"
        >
          <Icon icon="lucide:chevron-left" class="h-4 w-4" />
        </RouterLink>
        <div class="min-w-0">
          <h1 class="truncate text-xl font-semibold text-ink">
            {{ data?.article?.title || 'History' }}
          </h1>
          <p class="font-mono text-2xs uppercase tracking-[0.12em] text-muted">
            Version history
          </p>
        </div>
      </div>
    </div>

    <BusyState
      v-if="loading"
      variant="panel"
      title="Loading history…"
      detail="versions · differences"
      :since="startedAt"
      :rows="4"
    />

    <p v-else-if="error" class="notice-danger rounded-xl p-4">{{ error }}</p>

    <!-- Kein Verlauf. Das ist eine Aussage über den Zeitpunkt, nicht über den Artikel: eine
         erfundene „Fassung 1" trüge ein Datum, das nichts bedeutet (s. article-versions.service). -->
    <div
      v-else-if="!versions.length"
      class="rounded-xl border border-dashed border-line px-6 py-12 text-center"
    >
      <Icon icon="lucide:history" class="mx-auto mb-3 h-8 w-8 text-muted opacity-50" />
      <p class="text-sm font-medium text-ink">No versions yet</p>
      <p class="mx-auto mt-1 max-w-md text-sm text-muted">
        This article was last saved before Wikit started keeping history. The next time you save it,
        the text as it stands today becomes version 1 — nothing is lost from here on.
      </p>
    </div>

    <div v-else class="grid min-h-0 flex-1 gap-5" style="grid-template-columns: 20rem minmax(0, 1fr)">
      <!-- Fassungsliste -->
      <div class="flex min-h-0 flex-col rounded-xl border border-line bg-surface">
        <div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
          <span class="font-mono text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
            {{ versions.length }} {{ versions.length === 1 ? 'version' : 'versions' }}
          </span>
          <span v-if="data.keep" class="font-mono text-2xs text-muted opacity-70">keep {{ data.keep }}</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <button
            v-for="v in versions"
            :key="v.version_number"
            type="button"
            class="vh-item"
            :class="{ 'vh-item--active': v.version_number === to, 'vh-item--base': v.version_number === from }"
            @click="pick(v)"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-xs font-semibold text-ink">v{{ v.version_number }}</span>
              <span v-if="v.version_number === newest" class="vh-chip vh-chip--now">current</span>
              <span v-if="v.note" class="vh-chip vh-chip--note">restored</span>
              <span class="ml-auto shrink-0 font-mono text-2xs text-muted">{{ formatRelative(v.created_at) }}</span>
            </div>

            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs">
              <span v-if="v.stats" class="text-muted">
                <span class="text-success">+{{ v.stats.added }}</span>
                <span class="text-danger"> −{{ v.stats.removed }}</span>
              </span>
              <!-- Bei Prosa ist eine Zeile ein Absatz: „+1 −1" sieht beim Tippfehler aus wie beim
                   neu geschriebenen Abschnitt. Die Zeichenzahl trennt die beiden Fälle. -->
              <span class="text-muted opacity-70">{{ v.chars.toLocaleString() }} chars</span>
              <span v-if="v.title_changed" class="vh-chip vh-chip--meta">title</span>
              <span v-if="v.summary_changed" class="vh-chip vh-chip--meta">summary</span>
            </div>

            <!-- Der KI-Satz ist die Abkürzung vor dem Diff, nicht sein Ersatz. Fehlt er (kein
                 Ollama, noch nicht fertig, weggefallen beim Fortschreiben), fehlt genau er. -->
            <p v-if="v.ai_summary" class="mt-1.5 line-clamp-3 text-xs leading-snug text-muted">
              {{ v.ai_summary }}
            </p>
            <p v-else-if="v.note" class="mt-1.5 text-xs italic text-muted">{{ v.note }}</p>
          </button>
        </div>

        <!-- Dass getrimmt wurde, MUSS dastehen: ein Verlauf, der bei Fassung 12 beginnt, sieht
             sonst aus wie einer, der dort begonnen hat. -->
        <p
          v-if="data.trimmed"
          class="shrink-0 border-t border-line px-4 py-2 text-2xs leading-relaxed text-muted"
        >
          <template v-if="data.keep">
            Older versions were dropped — Wikit keeps the last {{ data.keep }} per article.
            <RouterLink to="/bot" class="text-accent hover:underline">Change it</RouterLink>.
          </template>
          <template v-else>Older versions were dropped before the limit was lifted.</template>
        </p>
      </div>

      <!-- Vergleich -->
      <div class="flex min-h-0 flex-col">
        <div class="mb-3 flex shrink-0 flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <label class="font-mono text-2xs uppercase tracking-[0.12em] text-muted">Compare</label>
            <select v-model.number="from" class="vh-select">
              <!-- „Empty" ist keine Verlegenheitsoption: ohne sie ließe sich die älteste
                   vorhandene Fassung überhaupt nicht ansehen. -->
              <option :value="0">Empty</option>
              <option v-for="v in versions" :key="v.version_number" :value="v.version_number" :disabled="v.version_number >= to">
                v{{ v.version_number }} · {{ formatDateTime(v.created_at) }}
              </option>
            </select>
            <Icon icon="lucide:arrow-right" class="h-4 w-4 text-muted" />
            <select v-model.number="to" class="vh-select">
              <option v-for="v in versions" :key="v.version_number" :value="v.version_number" :disabled="v.version_number <= from">
                v{{ v.version_number }} · {{ formatDateTime(v.created_at) }}
              </option>
            </select>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <span v-if="diff" class="font-mono text-2xs text-muted">
              <span class="text-success">+{{ diff.stats.charsAdded.toLocaleString() }}</span>
              <span class="text-danger"> −{{ diff.stats.charsRemoved.toLocaleString() }}</span>
              chars
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition enabled:hover:border-accent enabled:hover:text-accent disabled:opacity-40"
              :disabled="!canRestore"
              :title="canRestore ? `Bring version ${to} back as the current text` : 'This is already the current version'"
              @click="restore(to)"
            >
              <Icon icon="lucide:rotate-ccw" class="h-4 w-4" />
              Restore v{{ to }}
            </button>
          </div>
        </div>

        <p
          v-if="restored"
          class="mb-3 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink"
          style="background-color: color-mix(in srgb, var(--color-success) 14%, transparent)"
        >
          <Icon icon="lucide:check" class="h-4 w-4 text-success" />
          Version {{ restored }} is now the current text.
          <RouterLink :to="`/article/${slug}`" class="font-medium text-accent hover:underline">Open the article</RouterLink>
        </p>

        <div class="min-h-0 flex-1">
          <BusyState v-if="diffLoading && !diff" variant="panel" title="Comparing…" :since="startedAt" :rows="6" />
          <ArticleDiff v-else-if="diff" :diff="diff" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

.vh-item {
  @apply block w-full border-b border-line px-4 py-2.5 text-left transition hover:bg-surface-offset;
}
/* Die verglichene Fassung trägt den Akzent, die Basis nur eine Kante: „von hier bis dort" hat
   eine Richtung, und zwei gleich betonte Zeilen hätten keine. */
.vh-item--active {
  background-color: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--color-accent);
}
.vh-item--base {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-text-muted) 60%, transparent);
}

.vh-chip {
  @apply rounded px-1.5 py-px font-mono text-3xs font-medium uppercase tracking-wide;
}
.vh-chip--now {
  @apply bg-accent-soft text-accent;
}
.vh-chip--note {
  color: var(--color-warning);
  background-color: color-mix(in srgb, var(--color-warning) 16%, transparent);
}
.vh-chip--meta {
  @apply text-muted;
  background-color: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
}

.vh-select {
  @apply rounded-lg border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs text-ink outline-none transition focus:border-accent;
}
</style>
