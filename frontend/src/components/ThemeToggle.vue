<script setup>
import { useTheme } from '../composables/useTheme.js'
import { Icon } from '../lib/icons.js'
const { theme, toggle } = useTheme()
</script>

<template>
  <button
    type="button"
    class="grid h-9 w-9 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
    :title="theme === 'dark' ? 'Light mode' : 'Dark mode'"
    @click="toggle"
  >
    <Icon :icon="theme === 'dark' ? 'lucide:sun' : 'lucide:moon'" class="h-5 w-5" />
  </button>
</template>
