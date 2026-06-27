<script setup>
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'

const emit = defineEmits(['navigate', 'open-java'])

const { articles, categories } = useArticles()
const route = useRoute()
const collapsed = ref({}) // slug -> bool

function openJavaModal() {
  // Modal lebt in App.vue (einzige Instanz; das Mobile-Drawer unmountet beim Navigieren).
  emit('open-java')
  emit('navigate')
}

// Artikel nach Kategorie gruppieren (inkl. "Ohne Kategorie").
const groups = computed(() => {
  const byCat = new Map()
  for (const c of categories.value) byCat.set(c.id, { category: c, items: [] })
  const uncategorized = []
  for (const a of articles.value) {
    if (a.category && byCat.has(a.category.id)) byCat.get(a.category.id).items.push(a)
    else uncategorized.push(a)
  }
  const result = [...byCat.values()].filter((g) => g.items.length)
  if (uncategorized.length) {
    result.push({ category: { id: 0, name: 'Ohne Kategorie', icon: '🗂️', slug: '_none' }, items: uncategorized })
  }
  return result
})

function toggle(slug) {
  collapsed.value[slug] = !collapsed.value[slug]
}
const isActive = (slug) => route.params.slug === slug
</script>

<template>
  <nav class="flex h-full flex-col">
    <div class="grid grid-cols-2 gap-2 px-3 py-3">
      <RouterLink
        to="/new"
        class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
        @click="$emit('navigate')"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Neuer Artikel
      </RouterLink>
      <button
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 shadow-sm transition hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
        @click="openJavaModal"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 16-4-4 4-4M16 8l4 4-4 4M14 4l-4 16" /></svg>
        Java analysieren
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-6">
      <div v-for="group in groups" :key="group.category.id" class="mb-1">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          @click="toggle(group.category.slug)"
        >
          <span>{{ group.category.icon }}</span>
          <span class="flex-1">{{ group.category.name }}</span>
          <span class="text-[10px] text-slate-400">{{ group.items.length }}</span>
          <svg
            class="h-3.5 w-3.5 transition-transform"
            :class="collapsed[group.category.slug] ? '-rotate-90' : ''"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          ><path d="m6 9 6 6 6-6" /></svg>
        </button>

        <ul v-show="!collapsed[group.category.slug]" class="mb-2 mt-0.5 space-y-0.5">
          <li v-for="a in group.items" :key="a.id">
            <RouterLink
              :to="`/article/${a.slug}`"
              class="block truncate rounded-md px-3 py-1.5 text-sm transition"
              :class="isActive(a.slug)
                ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'"
              @click="$emit('navigate')"
            >
              {{ a.title }}
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </nav>
</template>
