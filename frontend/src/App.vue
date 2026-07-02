<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import SearchPalette from './components/SearchPalette.vue'
import { useArticles } from './composables/useArticles.js'
import { useJavaAnalyzer } from './composables/useJavaAnalyzer.js'
import { useTheme } from './composables/useTheme.js'
import { WIKI_TITLE, WIKI_ICON, WIKI_VERSION } from './config.js'
import { Icon } from './lib/icons.js'

const { load, articles } = useArticles()
const { files, fetchFiles } = useJavaAnalyzer()
const { theme, toggle: toggleTheme } = useTheme()
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
  // Nur die Anzahl fuer den Nav-Badge – Fehler still (Code-Feature ist optional/leer moeglich).
  fetchFiles().catch(() => {})
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

// Navigation: code-first (Analyzer zuerst, dann Wiki). Icons ausschliesslich via Iconify.
const navLinks = computed(() => [
  { to: '/code', label: 'Code', icon: 'lucide:braces', count: files.value.length },
  { to: '/wiki', label: 'Wiki', icon: 'lucide:book-open', count: articles.value.length },
])

const isDark = computed(() => theme.value === 'dark')

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-[var(--color-surface)] text-[var(--color-text)]">
    <!-- ============================ SIDEBAR ============================ -->
    <aside
      class="flex h-full w-16 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-4 lg:w-60 lg:px-3"
    >
      <!-- Brand: Wikit-Icon bleibt IMMER neben dem Titel -->
      <RouterLink
        to="/"
        class="mb-1 flex items-center gap-2.5 rounded-lg px-1 py-1.5 transition hover:bg-[var(--color-surface-offset)] lg:px-2"
        title="Home"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon :icon="WIKI_ICON" class="text-xl" />
        </span>
        <span class="hidden min-w-0 flex-col leading-tight lg:flex">
          <span class="truncate font-mono text-[15px] font-semibold tracking-tight text-[var(--color-text)]">{{ WIKI_TITLE }}</span>
          <span class="font-mono text-[9px] font-medium tracking-[0.14em] text-[var(--color-text-muted)]">v{{ WIKI_VERSION }} · LOCAL</span>
        </span>
      </RouterLink>

      <!-- Suche (oeffnet die Palette) -->
      <button
        type="button"
        class="mb-4 mt-2.5 flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-offset)] px-2 py-2 text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] lg:px-2.5"
        title="Search (Ctrl+K)"
        @click="searchOpen = true"
      >
        <Icon icon="lucide:search" class="h-4 w-4 shrink-0" />
        <span class="hidden flex-1 truncate text-left text-[12.5px] lg:inline">Search…</span>
        <kbd class="ml-auto hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[9.5px] tracking-wide text-[var(--color-text-muted)] lg:inline">Ctrl K</kbd>
      </button>

      <!-- Navigation -->
      <p class="hidden px-2 pb-2 font-mono text-[9.5px] font-semibold tracking-[0.16em] text-[var(--color-text-muted)] lg:block">NAVIGATE</p>
      <nav class="flex flex-col gap-1">
        <RouterLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="relative flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] font-medium transition lg:px-2.5"
          :class="isActive(link.to)
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)]'"
          :title="link.label"
        >
          <span
            v-if="isActive(link.to)"
            class="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-[var(--color-accent)]"
          />
          <Icon :icon="link.icon" class="h-[18px] w-[18px] shrink-0" />
          <span class="hidden flex-1 lg:inline">{{ link.label }}</span>
          <span
            class="hidden min-w-[24px] rounded px-1.5 py-0.5 text-center font-mono text-[11px] lg:inline"
            :class="isActive(link.to) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
          >{{ link.count }}</span>
        </RouterLink>
      </nav>

      <div class="flex-1" />

      <!-- Neuer Artikel -->
      <RouterLink
        to="/new"
        class="mb-2 flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 py-2 text-[12.5px] font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)]"
        title="New article"
      >
        <Icon icon="lucide:plus" class="h-4 w-4 shrink-0" />
        <span class="hidden lg:inline">New article</span>
      </RouterLink>

      <!-- Theme-Toggle (Pill) -->
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md border border-[var(--color-border)] px-2 py-2 font-mono text-[11px] tracking-wide text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] lg:px-2.5"
        :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="toggleTheme"
      >
        <Icon :icon="isDark ? 'lucide:moon' : 'lucide:sun'" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
        <span class="hidden flex-1 text-left uppercase lg:inline">{{ theme }}</span>
        <span class="hidden h-[15px] w-[26px] shrink-0 rounded-full bg-[var(--color-accent-soft)] lg:inline-block" style="position:relative">
          <span
            class="absolute top-[2px] h-[11px] w-[11px] rounded-full bg-[var(--color-accent)] transition-[left]"
            :style="{ left: isDark ? '13px' : '2px' }"
          />
        </span>
      </button>
    </aside>

    <!-- ============================ MAIN ============================ -->
    <main class="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :key="route.fullPath" />
      </RouterView>
    </main>

    <SearchPalette :open="searchOpen" @close="searchOpen = false" />
  </div>
</template>
