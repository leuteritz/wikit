import { ref, watch } from 'vue'

const STORAGE_KEY = 'wiki-theme'
const stored = localStorage.getItem(STORAGE_KEY)
const initial = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

const theme = ref(initial)

function apply(value) {
  document.documentElement.classList.toggle('dark', value === 'dark')
}

apply(theme.value)
watch(theme, (value) => {
  apply(value)
  localStorage.setItem(STORAGE_KEY, value)
})

export function useTheme() {
  return {
    theme,
    isDark: () => theme.value === 'dark',
    toggle: () => { theme.value = theme.value === 'dark' ? 'light' : 'dark' },
  }
}
