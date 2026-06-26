<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import CategoryBadge from '../components/CategoryBadge.vue'
import { WIKI_TITLE } from '../config.js'

const { articles, categories, loading } = useArticles()

const recent = computed(() =>
  [...articles.value]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 6)
)

function countFor(catId) {
  return articles.value.filter((a) => a.category?.id === catId).length
}
function firstSlug(catId) {
  return articles.value.find((a) => a.category?.id === catId)?.slug
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-5 py-10">
    <!-- Hero -->
    <section class="mb-10">
      <h1 class="text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
        Willkommen bei {{ WIKI_TITLE }}
      </h1>
      <p class="mt-3 max-w-2xl text-lg text-slate-500 dark:text-slate-400">
        Deine persönliche Wissensdatenbank – Artikel in Markdown, durchsuchbar, verlinkt und
        jederzeit erweiterbar. Drücke
        <kbd class="rounded border border-slate-300 px-1.5 text-sm dark:border-slate-600">Strg K</kbd>
        zum Suchen.
      </p>
      <div class="mt-5 flex flex-wrap gap-3">
        <RouterLink to="/new" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500">
          + Artikel anlegen
        </RouterLink>
        <RouterLink to="/graph" class="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
          🕸️ Zusammenhänge ansehen
        </RouterLink>
      </div>
    </section>

    <!-- Stats -->
    <section class="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
      <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div class="text-3xl font-bold text-slate-900 dark:text-white">{{ articles.length }}</div>
        <div class="text-sm text-slate-500">Artikel</div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div class="text-3xl font-bold text-slate-900 dark:text-white">{{ categories.length }}</div>
        <div class="text-sm text-slate-500">Kategorien</div>
      </div>
      <div class="col-span-2 rounded-xl border border-slate-200 bg-white p-4 sm:col-span-1 dark:border-slate-800 dark:bg-slate-900">
        <div class="text-3xl font-bold text-slate-900 dark:text-white">SQLite</div>
        <div class="text-sm text-slate-500">eine .db-Datei, einfach backupbar</div>
      </div>
    </section>

    <!-- Kategorien -->
    <section class="mb-10">
      <h2 class="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Themen</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <RouterLink
          v-for="cat in categories"
          :key="cat.id"
          :to="firstSlug(cat.id) ? `/article/${firstSlug(cat.id)}` : '/'"
          class="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-indigo-300 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500/40"
        >
          <div class="flex items-center gap-2">
            <span class="text-2xl">{{ cat.icon }}</span>
            <span class="font-semibold text-slate-800 group-hover:text-indigo-600 dark:text-slate-100">{{ cat.name }}</span>
          </div>
          <div class="mt-1 text-sm text-slate-500">{{ countFor(cat.id) }} Artikel</div>
        </RouterLink>
      </div>
    </section>

    <!-- Zuletzt aktualisiert -->
    <section v-if="recent.length">
      <h2 class="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Zuletzt aktualisiert</h2>
      <ul class="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        <li v-for="a in recent" :key="a.id">
          <RouterLink :to="`/article/${a.slug}`" class="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800">
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium text-slate-800 dark:text-slate-100">{{ a.title }}</div>
              <div class="truncate text-sm text-slate-500">{{ a.summary }}</div>
            </div>
            <CategoryBadge :category="a.category" size="xs" />
          </RouterLink>
        </li>
      </ul>
    </section>

    <p v-if="loading" class="mt-6 text-sm text-slate-400">Lädt…</p>
  </div>
</template>
