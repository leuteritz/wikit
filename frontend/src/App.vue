<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import SearchPalette from './components/SearchPalette.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import { useArticles } from './composables/useArticles.js'
import { WIKI_TITLE, WIKI_ICON, WIKI_VERSION } from './config.js'
import { Icon } from './lib/icons.js'

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

// Navigation: code-first. Analyzer zuerst, dann Wiki/Graph. Icons ausschliesslich via Iconify.
const navLinks = [
  { to: '/code', label: 'Code', icon: 'lucide:braces' },
  { to: '/code/queues', label: 'Queues', icon: 'lucide:list-checks' },
  { to: '/wiki', label: 'Wiki', icon: 'lucide:book-open' },
  { to: '/graph', label: 'Graph', icon: 'lucide:share-2' },
]
</script>

<template>
  <div class="min-h-screen">
    <!-- Topbar: full-bleed 3-Spalten-Grid (Brand · Suche · Nav). Brand klebt am linken Rand,
         Nav am rechten Rand; die mittlere auto-Spalte haelt die Suche echt viewport-zentriert. -->
    <header class="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/80 backdrop-blur">
      <div class="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <!-- Brand (links) -->
        <RouterLink to="/" class="flex min-w-0 items-center gap-2 font-semibold text-[var(--color-text)]">
          <Icon :icon="WIKI_ICON" class="shrink-0 text-2xl text-[var(--color-accent)]" />
          <span class="hidden truncate text-[var(--color-accent)] sm:inline">{{ WIKI_TITLE }}</span>
          <span
            class="hidden shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-[var(--color-accent)] tabular-nums sm:inline"
            :title="`Version ${WIKI_VERSION}`"
          >v{{ WIKI_VERSION }}</span>
        </RouterLink>

        <!-- Suchleiste (mittig, oeffnet die Palette) -->
        <button
          type="button"
          class="flex w-44 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] sm:w-72 md:w-80 lg:w-96"
          @click="searchOpen = true"
        >
          <Icon icon="lucide:search" class="h-4 w-4 shrink-0" />
          <span class="hidden truncate sm:inline">Artikel, Tags, Kategorien durchsuchen…</span>
          <span class="truncate sm:hidden">Suchen…</span>
          <kbd class="ml-auto hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 text-[10px] sm:inline">Strg K</kbd>
        </button>

        <!-- Nav (rechts) -->
        <nav class="flex items-center justify-end gap-1">
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)]"
            exact-active-class="bg-[var(--color-accent-soft)] !text-[var(--color-accent)]"
            :title="link.label"
          >
            <Icon :icon="link.icon" class="h-4 w-4" />
            <span class="hidden lg:inline">{{ link.label }}</span>
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
