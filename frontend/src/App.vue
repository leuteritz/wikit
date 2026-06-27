<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import SearchPalette from './components/SearchPalette.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import { useArticles } from './composables/useArticles.js'
import { WIKI_TITLE } from './config.js'

const { load } = useArticles()
const route = useRoute()
const searchOpen = ref(false)

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchOpen.value = true
  } else if (e.key === 'Escape') {
    searchOpen.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

// Navigation: code-first. Analyzer zuerst, dann Wiki/Graph.
const navLinks = [
  { to: '/java', label: 'Analyzer', icon: 'M8 16l-4-4 4-4M16 8l4 4-4 4M14 4l-4 16' },
  { to: '/java/queues', label: 'Queues', icon: 'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0M12 7v5l3 2' },
  { to: '/wiki', label: 'Wiki', icon: 'M4 5h11a2 2 0 0 1 2 2v12a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2zM9 5v14' },
  { to: '/graph', label: 'Graph', icon: 'M5 6a2 2 0 1 0 0-.01M19 6a2 2 0 1 0 0-.01M12 18a2 2 0 1 0 0-.01M6.7 7.4 11 16M17.3 7.4 13 16' },
]
</script>

<template>
  <div class="min-h-screen">
    <!-- Topbar -->
    <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div class="mx-auto flex h-14 max-w-[100rem] items-center gap-3 px-4 sm:gap-4">
        <RouterLink to="/" class="flex shrink-0 items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <span class="text-xl">📚</span>
          <span class="hidden text-[var(--color-accent)] sm:inline">{{ WIKI_TITLE }}</span>
        </RouterLink>

        <!-- Sichtbare Suchleiste (oeffnet die Palette) -->
        <button
          type="button"
          class="mx-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 transition hover:border-[var(--color-accent)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
          @click="searchOpen = true"
        >
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <span class="truncate">Artikel, Tags, Kategorien durchsuchen…</span>
          <kbd class="ml-auto hidden shrink-0 rounded border border-slate-300 px-1.5 text-[10px] sm:inline dark:border-slate-600">Strg K</kbd>
        </button>

        <!-- Nav -->
        <nav class="flex shrink-0 items-center gap-1">
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            exact-active-class="bg-[var(--color-accent-soft)] !text-[var(--color-accent)]"
            :title="link.label"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="link.icon" /></svg>
            <span class="hidden md:inline">{{ link.label }}</span>
          </RouterLink>
          <ThemeToggle />
        </nav>
      </div>
    </header>

    <!-- Inhalt (volle Breite; Views steuern eigene Zentrierung) -->
    <main class="min-w-0">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :key="route.fullPath" />
      </RouterView>
    </main>

    <SearchPalette :open="searchOpen" @close="searchOpen = false" />
  </div>
</template>
