<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import CategoryBadge from './CategoryBadge.vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({
  article: { type: Object, required: true },
})
defineEmits(['delete'])

const bodyEl = ref(null)

function fmtDate(s) {
  if (!s) return ''
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Copy-Buttons an die (serverseitig gerenderten) Code-Bloecke haengen.
function enhanceCodeBlocks() {
  const root = bodyEl.value
  if (!root) return
  root.querySelectorAll('pre.shiki').forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-wrap')) return
    const wrap = document.createElement('div')
    wrap.className = 'code-wrap'
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(pre)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy'
    btn.textContent = 'Kopieren'
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.innerText)
      btn.textContent = 'Kopiert'
      setTimeout(() => (btn.textContent = 'Kopieren'), 1500)
    })
    wrap.appendChild(btn)
  })
}

onMounted(enhanceCodeBlocks)
watch(() => props.article?.id, () => nextTick(enhanceCodeBlocks))
</script>

<template>
  <article>
    <header class="mb-6 border-b border-slate-200 pb-6 dark:border-slate-800">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <CategoryBadge :category="article.category" />
        <span class="text-xs text-slate-400">Aktualisiert {{ fmtDate(article.updated_at) }}</span>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">{{ article.title }}</h1>
      <p v-if="article.summary" class="mt-2 text-lg text-slate-500 dark:text-slate-400">{{ article.summary }}</p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <span
          v-for="tag in article.tags"
          :key="tag"
          class="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >#{{ tag }}</span>
      </div>

      <div class="mt-5 flex gap-2">
        <RouterLink
          :to="`/edit/${article.slug}`"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Icon icon="lucide:pencil" class="h-4 w-4" />
          Bearbeiten
        </RouterLink>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          @click="$emit('delete', article)"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Löschen
        </button>
      </div>
    </header>

    <div
      ref="bodyEl"
      class="article-body prose prose-slate max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-a:text-[var(--color-accent)]"
      v-html="article.content_html"
    />

    <!-- Zusammenhänge -->
    <section
      v-if="article.relations && (article.relations.outgoing.length || article.relations.incoming.length)"
      class="mt-10 border-t border-slate-200 pt-6 dark:border-slate-800"
    >
      <h2 class="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">Zusammenhänge</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <RouterLink
          v-for="rel in [...article.relations.outgoing, ...article.relations.incoming]"
          :key="rel.id"
          :to="`/article/${rel.slug}`"
          class="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-[var(--color-accent)] hover:shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <span class="rounded-md bg-[var(--color-accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--color-accent)]">{{ rel.relation_type }}</span>
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 group-hover:text-[var(--color-accent)] dark:text-slate-200">{{ rel.title }}</span>
          <Icon icon="lucide:arrow-right" class="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[var(--color-accent)]" />
        </RouterLink>
      </div>
    </section>
  </article>
</template>
