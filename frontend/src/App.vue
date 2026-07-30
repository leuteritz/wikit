<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import SearchPalette from './components/SearchPalette.vue'
import ShortcutsOverlay from './components/ShortcutsOverlay.vue'
import { sidebarShortcuts, keyChips, isTypingTarget } from './lib/shortcuts.js'
import NotificationHost from './components/NotificationHost.vue'
import { useArticles } from './composables/useArticles.js'
import { useJavaAnalyzer } from './composables/useJavaAnalyzer.js'
import { useTheme } from './composables/useTheme.js'
import { WIKI_TITLE, WIKI_ICON, WIKI_VERSION } from './config.js'
import { Icon } from './lib/icons.js'

const { load, articles } = useArticles()
const { files, fetchFiles } = useJavaAnalyzer()
const { theme, toggle: toggleTheme } = useTheme()
const route = useRoute()
const router = useRouter()
const searchOpen = ref(false)
const shortcutsOpen = ref(false)
// Die Sidebar zeigt die Kuerzel der AKTUELLEN Ansicht – in der Code-Ansicht sind das andere als im
// Wiki, und eine Liste, in der die Haelfte gerade nicht gilt, liest niemand zweimal.
const sidebarKeys = computed(() => sidebarShortcuts(route.path))

// Tastenfolge `g` dann `c|w`: kein Modifier noetig, kollidiert mit nichts – aber nur, solange
// niemand tippt. Das Fenster ist kurz, sonst wird aus einem spaeteren `c` im Fliesstext eine
// Navigation.
const GOTO_WINDOW_MS = 1200
let gotoArmedAt = 0

function onKey(e) {
  const typing = isTypingTarget(document.activeElement)

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchOpen.value = true
    return
  }
  if (e.key === 'Escape') {
    searchOpen.value = false
    shortcutsOpen.value = false
    return
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return

  // `?` liegt auf jeder Tastatur woanders (hier Shift+ß) – `e.key` liefert trotzdem das Zeichen.
  if (e.key === '?') {
    e.preventDefault()
    shortcutsOpen.value = !shortcutsOpen.value
    return
  }
  if (e.key.toLowerCase() === 'g') {
    gotoArmedAt = Date.now()
    return
  }
  if (gotoArmedAt && Date.now() - gotoArmedAt < GOTO_WINDOW_MS) {
    const k = e.key.toLowerCase()
    if (k === 'c' || k === 'w') {
      e.preventDefault()
      router.push(k === 'c' ? '/code' : '/wiki')
    }
  }
  gotoArmedAt = 0
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
          <span class="truncate font-mono text-[0.9375rem] font-semibold tracking-tight text-[var(--color-text)]">{{ WIKI_TITLE }}</span>
          <span class="font-mono text-2xs font-medium tracking-[0.1em] text-[var(--color-text-muted)]">v{{ WIKI_VERSION }} · LOCAL</span>
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
        <span class="hidden flex-1 truncate text-left text-[0.78125rem] lg:inline">Search…</span>
        <kbd class="ml-auto hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[0.59375rem] tracking-wide text-[var(--color-text-muted)] lg:inline">Ctrl K</kbd>
      </button>

      <!-- Navigation -->
      <p class="hidden px-2 pb-2 font-mono text-[0.59375rem] font-semibold tracking-[0.16em] text-[var(--color-text-muted)] lg:block">NAVIGATE</p>
      <nav class="flex flex-col gap-1">
        <RouterLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="relative flex items-center gap-2.5 rounded-md px-2 py-2 text-[0.8125rem] font-medium transition lg:px-2.5"
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
            class="hidden min-w-[24px] rounded px-1.5 py-0.5 text-center font-mono text-2xs lg:inline"
            :class="isActive(link.to) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
          >{{ link.count }}</span>
        </RouterLink>
      </nav>

      <div class="flex-1" />

      <!-- Kuerzel der aktuellen Ansicht. Sie standen bisher nirgends – man musste sie kennen oder
           in einem `title` finden. Hier ist Platz (die Spalte ist unten leer), und die Liste bleibt
           kurz: alles Weitere ist einen Tastendruck entfernt (`?`). Nur im breiten Layout – in der
           Icon-Spalte waere sie unlesbar. -->
      <div class="mb-3 hidden lg:block">
        <button
          type="button"
          class="mb-1.5 flex w-full items-center gap-1.5 px-2 font-mono text-[0.59375rem] font-semibold tracking-[0.16em] text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
          title="Show all keyboard shortcuts (?)"
          @click="shortcutsOpen = true"
        >
          SHORTCUTS
          <Icon icon="lucide:arrow-up-right" class="h-3 w-3 opacity-60" />
        </button>
        <ul class="space-y-1">
          <li
            v-for="s in sidebarKeys"
            :key="s.id"
            class="flex items-center gap-2 rounded-md px-2 py-1 text-[var(--color-text-muted)]"
          >
            <span class="flex shrink-0 items-center gap-1">
              <template v-for="(combo, ci) in s.keys" :key="combo">
                <span v-if="ci > 0" class="text-[0.59375rem] opacity-70">{{ s.seq ? 'then' : '/' }}</span>
                <kbd
                  v-for="chip in keyChips(combo)"
                  :key="chip"
                  class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-px font-mono text-[0.59375rem] font-medium text-[var(--color-text)]"
                >{{ chip }}</kbd>
              </template>
            </span>
            <span class="min-w-0 flex-1 truncate text-2xs">{{ s.label }}</span>
          </li>
        </ul>
      </div>

      <!-- Neuer Artikel -->
      <RouterLink
        to="/new"
        class="mb-2 flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 py-2 text-[0.78125rem] font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)]"
        title="New article"
      >
        <Icon icon="lucide:plus" class="h-4 w-4 shrink-0" />
        <span class="hidden lg:inline">New article</span>
      </RouterLink>

      <!-- Theme-Toggle (Pill) -->
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-md border border-[var(--color-border)] px-2 py-2 font-mono text-2xs tracking-wide text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] lg:px-2.5"
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
    <ShortcutsOverlay :open="shortcutsOpen" @close="shortcutsOpen = false" />

    <!-- Globale Rueckmeldungen. Steht hier, damit sie auf JEDER Route erscheinen – ein Fehler
         soll nicht davon abhaengen, welche Ansicht ihn ausgeloest hat. -->
    <NotificationHost />
  </div>
</template>
