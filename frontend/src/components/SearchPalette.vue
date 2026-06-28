<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import { useSearch } from '../composables/useSearch.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { api } from '../lib/api.js'
import CategoryBadge from './CategoryBadge.vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const router = useRouter()
const { articles } = useArticles()
const { run } = useSearch(articles)
const { lastFileId } = useJavaAnalyzer()

const query = ref('')
const active = ref(0)
const inputEl = ref(null)

// --- Artikel (instant, clientseitig via Fuse) ---
const articleHits = computed(() => {
  const q = query.value.trim()
  if (!q) return articles.value.slice(0, 8) // ohne Eingabe: ein paar Einstiege zeigen
  return run(q)
})

// --- Code (Java-Dateien, serverseitig via FTS5; debounced) ---
const codeHits = ref([])
let debounceTimer = null
let reqToken = 0

watch(query, (q) => {
  const term = q.trim()
  clearTimeout(debounceTimer)
  if (!term) {
    codeHits.value = []
    return
  }
  debounceTimer = setTimeout(async () => {
    const token = ++reqToken
    try {
      const results = await api.search(term)
      if (token !== reqToken) return // veralteter Request -> verwerfen
      codeHits.value = results.filter((r) => r.type === 'java_file')
    } catch {
      if (token === reqToken) codeHits.value = []
    }
  }, 180)
})

// Gruppierte Anzeige + flache Liste fuer Tastatur-Navigation (ein gemeinsamer Index).
const groups = computed(() => {
  const out = []
  if (articleHits.value.length) out.push({ key: 'article', label: 'Artikel', items: articleHits.value })
  if (codeHits.value.length) out.push({ key: 'java_file', label: 'Code', items: codeHits.value })
  return out
})
const flatItems = computed(() => groups.value.flatMap((g) => g.items.map((item) => ({ kind: g.key, item }))))

watch(() => props.open, async (open) => {
  if (open) {
    query.value = ''
    active.value = 0
    codeHits.value = []
    await nextTick()
    inputEl.value?.focus()
  }
})
watch(flatItems, () => { active.value = 0 })
onUnmounted(() => clearTimeout(debounceTimer))

function go(entry) {
  if (!entry) return
  emit('close')
  if (entry.kind === 'java_file') {
    // Handoff wie Queue -> Code: CodeView selektiert die Klasse beim Mount via lastFileId.
    lastFileId.value = entry.item.id
    router.push('/code')
  } else {
    router.push(`/article/${entry.item.slug}`)
  }
}
function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = Math.min(active.value + 1, flatItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = Math.max(active.value - 1, 0) }
  else if (e.key === 'Enter') { e.preventDefault(); go(flatItems.value[active.value]) }
}
// FTS5-snippet() escaped den Quelltext NICHT -> Java-Generics (`List<String>`) wuerden als
// kaputtes HTML rendern. Daher alles escapen und nur die <mark>-Marker wiederherstellen.
function renderSnippet(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}

// Globaler Index eines Eintrags (Gruppe + Position) -> Aktiv-Markierung/Maus-Sync.
function flatIndex(groupKey, i) {
  let idx = 0
  for (const g of groups.value) {
    if (g.key === groupKey) return idx + i
    idx += g.items.length
  }
  return idx + i
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
          <Icon icon="lucide:search" class="h-5 w-5 shrink-0 text-slate-400" />
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            placeholder="Artikel, Tags, Code durchsuchen…"
            class="w-full bg-transparent py-3.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
            @keydown="onKeydown"
          />
          <kbd class="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 sm:block dark:border-slate-700">ESC</kbd>
        </div>

        <div v-if="flatItems.length" class="max-h-[50vh] overflow-y-auto py-2">
          <div v-for="group in groups" :key="group.key">
            <div class="flex items-center gap-1.5 px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <Icon v-if="group.key === 'java_file'" icon="lucide:code-2" class="h-3 w-3" />
              {{ group.label }}
            </div>
            <ul>
              <li v-for="(item, i) in group.items" :key="`${group.key}-${item.id}`">
                <!-- Artikel-Treffer -->
                <button
                  v-if="group.key === 'article'"
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition"
                  :class="flatIndex('article', i) === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-slate-50 dark:hover:bg-slate-800'"
                  @mouseenter="active = flatIndex('article', i)"
                  @click="go({ kind: 'article', item })"
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{{ item.title }}</div>
                    <div class="truncate text-xs text-slate-500 dark:text-slate-400">{{ item.summary }}</div>
                  </div>
                  <CategoryBadge :category="item.category" size="xs" />
                </button>

                <!-- Code-Treffer (Java-Datei) -->
                <button
                  v-else
                  type="button"
                  class="flex w-full items-start gap-3 px-4 py-2.5 text-left transition"
                  :class="flatIndex('java_file', i) === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-slate-50 dark:hover:bg-slate-800'"
                  @mouseenter="active = flatIndex('java_file', i)"
                  @click="go({ kind: 'java_file', item })"
                >
                  <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                    <Icon icon="lucide:braces" class="h-4 w-4" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{{ item.name }}</span>
                      <span class="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-accent)]">&lt;/&gt; Code</span>
                    </div>
                    <code v-if="item.snippet" class="search-snippet mt-1 block truncate rounded bg-[var(--color-surface-offset)] px-1.5 py-1 font-mono text-[11px] text-[var(--color-text-muted)]" v-html="renderSnippet(item.snippet)" />
                    <div v-if="item.package" class="mt-0.5 truncate font-mono text-[10px] text-slate-400 dark:text-slate-500">{{ item.package }}</div>
                  </div>
                </button>
              </li>
            </ul>
          </div>
        </div>
        <div v-else class="px-4 py-10 text-center text-sm text-slate-400">
          <template v-if="query.trim()">Keine Treffer für „{{ query }}".</template>
          <template v-else>Tippe, um Artikel und Code zu durchsuchen…</template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
@reference "../assets/style.css";

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* FTS5-Snippet-Highlight (<mark>) im Code-Treffer dezent einfaerben. */
.search-snippet :deep(mark) {
  background: color-mix(in srgb, var(--color-accent) 26%, transparent);
  color: var(--color-text);
  border-radius: 3px;
  padding: 0 1px;
}
</style>
