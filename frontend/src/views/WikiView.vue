<script setup>
// Wiki-Index: Artikel nach Kategorie gruppiert, mit Inline-Filter. Gruppierungslogik
// wie zuvor (useArticles als Store) – nur die Darstellung folgt dem neuen Design.
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import { Icon } from '../lib/icons.js'

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

// Kategorie-Farbe: durch die Zusatz-Hues rotieren (deterministisch per Index).
const CAT_COLORS = ['var(--color-thistle)', 'var(--color-accent)', 'var(--color-lavender)', 'var(--color-cyan)']

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
    result.push({ category: { id: 0, name: 'Uncategorized', icon: null }, items: uncategorized })
  }
  return result.map((g, i) => ({ ...g, color: CAT_COLORS[i % CAT_COLORS.length] }))
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-6 py-9 sm:px-8">
    <!-- Kopf -->
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-2 font-mono text-[10px] font-semibold tracking-[0.16em] text-[var(--color-text-muted)]">KNOWLEDGE BASE</p>
        <h1 class="font-mono text-3xl font-semibold tracking-tight text-[var(--color-text)]">Wiki</h1>
        <p class="mt-2 text-[13px] text-[var(--color-text-muted)]">
          <span class="font-mono font-semibold text-[var(--color-text)]">{{ articles.length }}</span> articles ·
          <span class="font-mono font-semibold text-[var(--color-text)]">{{ categories.length }}</span> categories
        </p>
      </div>
      <RouterLink
        to="/new"
        class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-[12.5px] font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)]"
      >
        <Icon icon="lucide:plus" class="h-4 w-4" />
        New article
      </RouterLink>
    </div>

    <!-- Filter -->
    <div class="mb-7 flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3.5">
      <Icon icon="lucide:search" class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      <input
        v-model="filter"
        type="text"
        placeholder="filter articles, tags…"
        class="w-full bg-transparent py-2.5 font-mono text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
      />
      <span class="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{{ filtered.length }} results</span>
    </div>

    <p v-if="loading" class="text-sm text-[var(--color-text-muted)]">Loading…</p>

    <!-- Gruppen -->
    <div v-else class="flex flex-col gap-8">
      <section v-for="group in groups" :key="group.category.id">
        <h2 class="mb-3.5 flex items-center gap-2.5">
          <span class="h-2 w-2 rounded-[2px]" :style="{ background: group.color }" />
          <span class="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-text)]">{{ group.category.name }}</span>
          <span class="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">{{ group.items.length }}</span>
          <span class="h-px flex-1 bg-[var(--color-border)]" />
        </h2>
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(258px, 1fr))">
          <RouterLink
            v-for="a in group.items"
            :key="a.id"
            :to="`/article/${a.slug}`"
            class="group flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 transition hover:-translate-y-0.5 hover:border-[var(--color-accent)]"
          >
            <span class="text-sm font-semibold leading-snug text-[var(--color-text)]">{{ a.title }}</span>
            <span v-if="a.summary" class="line-clamp-2 text-xs leading-relaxed text-[var(--color-text-muted)]">{{ a.summary }}</span>
            <span v-if="a.tags?.length" class="mt-0.5 flex flex-wrap gap-1.5">
              <span
                v-for="t in a.tags.slice(0, 4)"
                :key="t"
                class="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)]"
              >#{{ t }}</span>
            </span>
          </RouterLink>
        </div>
      </section>

      <p
        v-if="!groups.length"
        class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-11 text-center font-mono text-[13px] text-[var(--color-text-muted)]"
      >
        no articles match “{{ filter }}”.
      </p>
    </div>
  </div>
</template>
