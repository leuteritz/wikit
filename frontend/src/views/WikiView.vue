<script setup>
// Wiki-Index: ersetzt die fruehere permanente Sidebar. Artikel nach Kategorie gruppiert,
// mit Inline-Filter. Gruppierungslogik analog AppSidebar.vue (useArticles als Store).
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'

const { articles, categories, loading, load } = useArticles()
const filter = ref('')

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

// Artikel nach Kategorie gruppieren (inkl. "Ohne Kategorie") – wie in AppSidebar.vue.
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
    result.push({ category: { id: 0, name: 'Ohne Kategorie', icon: '🗂️' }, items: uncategorized })
  }
  return result
})
</script>

<template>
  <div class="mx-auto max-w-5xl px-5 py-10">
    <!-- Kopf -->
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Wiki</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400">{{ articles.length }} Artikel in {{ categories.length }} Kategorien.</p>
      </div>
      <RouterLink
        to="/new"
        class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)]"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Neuer Artikel
      </RouterLink>
    </div>

    <!-- Filter -->
    <div class="mb-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
      <svg class="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
      <input
        v-model="filter"
        type="text"
        placeholder="Artikel filtern…"
        class="w-full bg-transparent py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
      />
    </div>

    <p v-if="loading" class="text-sm text-slate-400">Lädt…</p>

    <!-- Gruppen -->
    <div v-else class="space-y-8">
      <section v-for="group in groups" :key="group.category.id">
        <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <span>{{ group.category.icon }}</span>
          <span>{{ group.category.name }}</span>
          <span class="text-[10px] text-slate-400">{{ group.items.length }}</span>
        </h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <RouterLink
            v-for="a in group.items"
            :key="a.id"
            :to="`/article/${a.slug}`"
            class="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[var(--color-accent)] hover:shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <div class="truncate font-semibold text-slate-800 group-hover:text-[var(--color-accent)] dark:text-slate-100">{{ a.title }}</div>
            <p v-if="a.summary" class="mt-1 line-clamp-2 text-sm text-slate-500 dark:text-slate-400">{{ a.summary }}</p>
            <div v-if="a.tags?.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="t in a.tags.slice(0, 4)" :key="t" class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">#{{ t }}</span>
            </div>
          </RouterLink>
        </div>
      </section>

      <p v-if="!groups.length" class="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400 dark:border-slate-800">
        Keine Artikel gefunden.
      </p>
    </div>
  </div>
</template>
