<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import AppSidebar from './components/AppSidebar.vue'
import SearchPalette from './components/SearchPalette.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import { useArticles } from './composables/useArticles.js'
import { WIKI_TITLE } from './config.js'

const { load } = useArticles()
const route = useRoute()
const searchOpen = ref(false)
const sidebarOpen = ref(false)

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchOpen.value = true
  } else if (e.key === 'Escape') {
    searchOpen.value = false
    sidebarOpen.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="min-h-screen">
    <!-- Topbar -->
    <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div class="flex h-14 items-center gap-3 px-4">
        <button
          type="button"
          class="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
          @click="sidebarOpen = !sidebarOpen"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>

        <RouterLink to="/" class="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <span class="text-xl">📚</span>
          <span class="text-indigo-600 dark:text-indigo-400">{{ WIKI_TITLE }}</span>
        </RouterLink>

        <button
          type="button"
          class="ml-auto flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
          @click="searchOpen = true"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <span class="hidden sm:inline">Suchen…</span>
          <kbd class="hidden rounded border border-slate-300 px-1.5 text-[10px] sm:inline dark:border-slate-600">Strg K</kbd>
        </button>

        <RouterLink
          to="/graph"
          class="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          title="Zusammenhang-Graph"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M6.7 7.4 11 16M17.3 7.4 13 16" /></svg>
        </RouterLink>

        <ThemeToggle />
      </div>
    </header>

    <div class="mx-auto flex max-w-[100rem]">
      <!-- Sidebar (Desktop) -->
      <aside class="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-72 shrink-0 border-r border-slate-200 lg:block dark:border-slate-800">
        <AppSidebar />
      </aside>

      <!-- Sidebar (Mobile Drawer) -->
      <Transition name="slide">
        <div v-if="sidebarOpen" class="fixed inset-0 z-40 lg:hidden">
          <div class="absolute inset-0 bg-slate-900/40" @click="sidebarOpen = false" />
          <div class="absolute left-0 top-0 h-full w-72 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <AppSidebar @navigate="sidebarOpen = false" />
          </div>
        </div>
      </Transition>

      <!-- Inhalt -->
      <main class="min-w-0 flex-1">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="route.fullPath" />
        </RouterView>
      </main>
    </div>

    <SearchPalette :open="searchOpen" @close="searchOpen = false" />
  </div>
</template>

<style scoped>
.slide-enter-active, .slide-leave-active { transition: opacity 0.2s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; }
</style>
