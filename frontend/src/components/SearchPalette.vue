<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import { useSearch } from '../composables/useSearch.js'
import CategoryBadge from './CategoryBadge.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const router = useRouter()
const { articles } = useArticles()
const { run } = useSearch(articles)

const query = ref('')
const active = ref(0)
const inputEl = ref(null)

const results = computed(() => {
  const q = query.value.trim()
  if (!q) return articles.value.slice(0, 8) // ohne Eingabe: ein paar Einstiege zeigen
  return run(q)
})

watch(() => props.open, async (open) => {
  if (open) {
    query.value = ''
    active.value = 0
    await nextTick()
    inputEl.value?.focus()
  }
})
watch(results, () => { active.value = 0 })

function go(article) {
  if (!article) return
  emit('close')
  router.push(`/article/${article.slug}`)
}
function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = Math.min(active.value + 1, results.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = Math.max(active.value - 1, 0) }
  else if (e.key === 'Enter') { e.preventDefault(); go(results.value[active.value]) }
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-[12vh] backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div class="flex items-center gap-3 border-b border-slate-100 px-4 dark:border-slate-800">
          <svg class="h-5 w-5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            placeholder="Artikel, Tags, Kategorien durchsuchen…"
            class="w-full bg-transparent py-3.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
            @keydown="onKeydown"
          />
          <kbd class="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 sm:block dark:border-slate-700">ESC</kbd>
        </div>

        <ul v-if="results.length" class="max-h-[50vh] overflow-y-auto py-2">
          <li v-for="(a, i) in results" :key="a.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition"
              :class="i === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-slate-50 dark:hover:bg-slate-800'"
              @mouseenter="active = i"
              @click="go(a)"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{{ a.title }}</div>
                <div class="truncate text-xs text-slate-500 dark:text-slate-400">{{ a.summary }}</div>
              </div>
              <CategoryBadge :category="a.category" size="xs" />
            </button>
          </li>
        </ul>
        <div v-else class="px-4 py-10 text-center text-sm text-slate-400">Keine Treffer für „{{ query }}".</div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
