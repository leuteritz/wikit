<script setup>
// Wiki-Index: Artikel nach Kategorie gruppiert, mit Inline-Filter. Gruppierungslogik
// wie zuvor (useArticles als Store) – nur die Darstellung folgt dem neuen Design.
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import BusyState from '../components/BusyState.vue'
import WikiRelationGraph from '../components/WikiRelationGraph.vue'
import WikiHealth from '../components/WikiHealth.vue'
import { categoryColors, colorFor } from '../lib/wikiGraph.js'
import { Icon } from '../lib/icons.js'

const { articles, categories, loading, load } = useArticles()
const filter = ref('')
const startedAt = ref(Date.now())
// DREI Modi derselben Ansicht (gleiche Bauart wie „Class · Relation" in /code): die Liste
// beantwortet „was gibt es?", der Graph „was haengt woran?", der Bericht „woran muss ich ran?".
// Derselbe Bestand, drei Fragen – deshalb ein Umschalter und kein dritter Sidebar-Eintrag.
//
// ⚠️ **Gemountet wird beim ERSTEN Umschalten, danach nur noch versteckt** (`v-if` + `v-show`).
// Beides ist noetig und keins reicht allein: ein von Anfang an gemounteter Graph laege in einem
// `display:none`-Container, misst dort 0x0 – und `fitView` passt ein Layout in nichts ein, das
// Bild bliebe beim Umschalten leer. Ihn dagegen bei jedem Wechsel neu zu mounten hiesse, Daten,
// Layout und gewaehlten Ausschnitt jedes Mal wegzuwerfen.
//
// Fuer den Bericht gilt dieselbe Regel aus einem zweiten Grund: er kostet einen Request, und wer
// nur die Liste ansieht, hat danach nicht gefragt (gleiche Begruendung wie bei den
// Link-Vorschlaegen im Graphen). Einmal geholt, ueberlebt er das Hin- und Herschalten.
const view = ref('list') // 'list' | 'graph' | 'health'
const graphMounted = ref(false)
const healthMounted = ref(false)

function setView(next) {
  if (next === 'graph') graphMounted.value = true
  if (next === 'health') healthMounted.value = true
  view.value = next
}

onMounted(load)

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return articles.value
  return articles.value.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      (a.summary || '').toLowerCase().includes(q) ||
      (a.tags || []).some((t) => t.toLowerCase().includes(q)),
  )
})

// Die Treffer des Filters, EINMAL gerechnet – der Graph markiert dieselben, die die Liste zeigt.
// Ohne Filter ist die Menge leer und nicht etwa „alle": sonst leuchtete jede Karte im Bild, und
// eine Hervorhebung, die fuer alles gilt, hebt nichts hervor.
const matchIds = computed(() =>
  filter.value.trim() ? new Set(filtered.value.map((a) => a.id)) : new Set(),
)

// ⚠️ Die Kategoriefarbe kommt aus `lib/wikiGraph.js` und haengt an der KATEGORIE, nicht an der
// Position ihrer Gruppe in der gefilterten Liste. Vorher rotierte sie ueber den Gruppen-Index –
// ein Filter, der die erste Kategorie ausblendete, faerbte alle uebrigen um. Neben dem Graphen
// waere das sofort sichtbar: dieselbe Kategorie links gruen, rechts violett.
const catColors = computed(() => categoryColors(categories.value))

// Artikel nach Kategorie gruppieren (inkl. "Uncategorized") – wie in der bisherigen Logik.
const groups = computed(() => {
  const byCat = new Map()
  for (const c of categories.value) byCat.set(c.id, { category: c, items: [] })
  const uncategorized = []
  for (const a of filtered.value) {
    if (a.category && byCat.has(a.category.id)) byCat.get(a.category.id).items.push(a)
    else uncategorized.push(a)
  }
  const result = [...byCat.values()].filter((g) => g.items.length)
  if (uncategorized.length) {
    result.push({ category: { id: null, name: 'Uncategorized', icon: null }, items: uncategorized })
  }
  return result.map((g) => ({ ...g, color: colorFor(catColors.value, g.category.id) }))
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-6 py-9 sm:px-8">
    <!-- Kopf -->
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-2 font-mono text-3xs font-semibold tracking-[0.16em] text-muted">KNOWLEDGE BASE</p>
        <h1 class="font-mono text-3xl font-semibold tracking-tight text-ink">Wiki</h1>
        <p class="mt-2 text-[0.8125rem] text-muted">
          <span class="font-mono font-semibold text-ink">{{ articles.length }}</span> articles ·
          <span class="font-mono font-semibold text-ink">{{ categories.length }}</span> categories
        </p>
      </div>
      <div class="flex items-center gap-2">
        <!-- Umschalter: drei Fragen an denselben Bestand. Die Liste sagt „was gibt es?",
             der Graph „was haengt woran?", der Bericht „woran muss ich ran?". -->
        <div class="flex items-center rounded-lg border border-line p-0.5">
          <button
            v-for="m in [
              { key: 'list', icon: 'lucide:list', label: 'List' },
              { key: 'graph', icon: 'lucide:network', label: 'Graph' },
              { key: 'health', icon: 'lucide:activity', label: 'Health' },
            ]"
            :key="m.key"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-3xs font-semibold transition"
            :class="view === m.key
              ? 'bg-accent-soft text-accent'
              : 'text-muted hover:text-ink'"
            :aria-pressed="view === m.key"
            @click="setView(m.key)"
          >
            <Icon :icon="m.icon" class="h-3.5 w-3.5" />
            {{ m.label }}
          </button>
        </div>
        <RouterLink
          to="/new"
          class="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-[0.78125rem] font-semibold text-accent-contrast transition hover:bg-accent-hover"
        >
          <Icon icon="lucide:plus" class="h-4 w-4" />
          New article
        </RouterLink>
      </div>
    </div>

    <!-- Filter. Im Bericht ausgeblendet: er filtert die Liste und markiert im Graphen, und ueber
         einer Befundliste haette er gar keine Bedeutung – ein Bedienelement, das nichts entscheidet,
         ist Ballast (gleiche Begruendung, aus der das Beziehungsnetz keine Kontextstufen hat). -->
    <div
      v-show="view !== 'health'"
      class="mb-7 flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5"
    >
      <Icon icon="lucide:search" class="h-4 w-4 shrink-0 text-muted" />
      <input
        v-model="filter"
        type="text"
        placeholder="filter articles, tags…"
        class="w-full bg-transparent py-2.5 font-mono text-[0.8125rem] text-ink outline-none placeholder:text-muted"
      />
      <span class="shrink-0 font-mono text-3xs text-muted">{{ filtered.length }} results</span>
    </div>

    <!-- Gleiche Wartemeldung wie im Analyzer (components/BusyState.vue). -->
    <BusyState v-if="loading" variant="panel" title="Loading articles…" detail="titles, categories and tags" :since="startedAt" :rows="4" />

    <!-- Erst beim Umschalten mounten, danach nur verstecken (s. `setView`). Der Filter MARKIERT
         hier, statt zu isolieren: ein Beziehungsnetz ohne die unpassenden Knoten beantwortet
         „wer haengt woran?" nicht mehr. -->
    <div v-if="graphMounted" v-show="view === 'graph'" class="h-[72vh] min-h-[26rem]">
      <WikiRelationGraph :categories="categories" :match-ids="matchIds" />
    </div>

    <!-- Der Bericht. Sein Verweis auf die verwaisten Artikel schaltet in den Graphen: der Befund
         steht dort, also fuehrt der Satz auch dorthin, statt ihn nur zu erwaehnen. -->
    <div v-if="healthMounted" v-show="view === 'health'">
      <WikiHealth @show-graph="setView('graph')" />
    </div>

    <!-- Gruppen -->
    <div v-show="!loading && view === 'list'" class="flex flex-col gap-8">
      <section v-for="group in groups" :key="group.category.id">
        <h2 class="mb-3.5 flex items-center gap-2.5">
          <span class="h-2 w-2 rounded-[2px]" :style="{ background: group.color }" />
          <span class="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-ink">{{ group.category.name }}</span>
          <span class="rounded-full border border-line px-1.5 py-0.5 font-mono text-3xs text-muted">{{ group.items.length }}</span>
          <span class="h-px flex-1 bg-line" />
        </h2>
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(258px, 1fr))">
          <RouterLink
            v-for="a in group.items"
            :key="a.id"
            :to="`/article/${a.slug}`"
            class="group flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-4 transition hover:-translate-y-0.5 hover:border-accent"
          >
            <span class="text-sm font-semibold leading-snug text-ink">{{ a.title }}</span>
            <span v-if="a.summary" class="line-clamp-2 text-xs leading-relaxed text-muted">{{ a.summary }}</span>
            <span v-if="a.tags?.length" class="mt-0.5 flex flex-wrap gap-1.5">
              <span
                v-for="t in a.tags.slice(0, 4)"
                :key="t"
                class="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-3xs text-accent"
              >#{{ t }}</span>
            </span>
          </RouterLink>
        </div>
      </section>

      <p
        v-if="!groups.length"
        class="rounded-lg border border-dashed border-line px-4 py-11 text-center font-mono text-[0.8125rem] text-muted"
      >
        no articles match “{{ filter }}”.
      </p>
    </div>
  </div>
</template>
