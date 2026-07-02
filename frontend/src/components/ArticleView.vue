<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import CategoryBadge from './CategoryBadge.vue'
import { Icon } from '../lib/icons.js'
import { isHighlightableVar, varColorClass } from '../lib/varHighlight.js'

const props = defineProps({
  article: { type: Object, required: true },
})
defineEmits(['delete'])

const bodyEl = ref(null)

function fmtDate(s) {
  if (!s) return ''
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Copy-Buttons + Variablen-Highlighting an die (serverseitig gerenderten) Code-Bloecke haengen.
function enhanceCodeBlocks() {
  const root = bodyEl.value
  if (!root) return
  root.querySelectorAll('pre.shiki').forEach((pre) => {
    if (!pre.parentElement?.classList.contains('code-wrap')) {
      const wrap = document.createElement('div')
      wrap.className = 'code-wrap'
      pre.parentNode.insertBefore(wrap, pre)
      wrap.appendChild(pre)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'code-copy'
      btn.textContent = 'Copy'
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(pre.innerText)
        btn.textContent = 'Copied'
        setTimeout(() => (btn.textContent = 'Copy'), 1500)
      })
      wrap.appendChild(btn)
    }
    tagJavaVars(pre)
  })
}

// Klickbare Variablen-Tokens in Java-Bloecken markieren (Affordance via .vh-token) und einen
// Klick-Handler anhaengen. Shiki setzt `class="language-java"` aufs <code> -> sichere Erkennung.
function tagJavaVars(pre) {
  if (pre._vhDone) return
  const code = pre.querySelector('code.language-java')
  if (!code) return
  pre._vhDone = true
  pre._vhActive = new Set()
  // Nur Leaf-Token-Spans (mit direktem Text, ohne Kind-Spans) – nicht die .line-Wrapper.
  code.querySelectorAll('span').forEach((span) => {
    if (span.querySelector('span')) return
    if (isHighlightableVar(span)) span.classList.add('vh-token')
  })
  pre.addEventListener('click', (e) => onVarClick(e, pre))
}

// Klick auf eine Variable: alle gleichnamigen Tokens im Block ein-/ausschalten (Toggle).
// Mehrere Variablen koennen gleichzeitig aktiv sein – jede in ihrer deterministischen Farbe.
function onVarClick(e, pre) {
  const token = e.target.closest('.vh-token')
  if (!token || !pre.contains(token)) return
  const name = (token.textContent || '').trim()
  if (!name) return
  const colorCls = varColorClass(name)
  const turnOn = !pre._vhActive.has(name)
  if (turnOn) pre._vhActive.add(name)
  else pre._vhActive.delete(name)
  pre.querySelectorAll('.vh-token').forEach((el) => {
    if ((el.textContent || '').trim() !== name) return
    el.classList.toggle('vh-active', turnOn)
    el.classList.toggle(colorCls, turnOn)
  })
}

onMounted(enhanceCodeBlocks)
watch(() => props.article?.id, () => nextTick(enhanceCodeBlocks))
</script>

<template>
  <article>
    <header class="mb-6 border-b border-[var(--color-border)] pb-6">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <CategoryBadge :category="article.category" />
        <span class="text-xs text-[var(--color-text-muted)]">Updated {{ fmtDate(article.updated_at) }}</span>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-[var(--color-text)]">{{ article.title }}</h1>
      <p v-if="article.summary" class="mt-2 text-lg text-[var(--color-text-muted)]">{{ article.summary }}</p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <span
          v-for="tag in article.tags"
          :key="tag"
          class="rounded-md bg-[var(--color-accent-soft)] px-2 py-0.5 font-mono text-xs text-[var(--color-accent)]"
        >#{{ tag }}</span>
      </div>

      <div class="mt-5 flex gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]"
          @click="$emit('delete', article)"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Delete
        </button>
      </div>
    </header>

    <div
      ref="bodyEl"
      class="article-body prose max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-a:text-[var(--color-accent)]"
      v-html="article.content_html"
    />

    <!-- Zusammenhänge -->
    <section
      v-if="article.relations && (article.relations.outgoing.length || article.relations.incoming.length)"
      class="mt-10 border-t border-[var(--color-border)] pt-6"
    >
      <h2 class="mb-4 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Relations</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <RouterLink
          v-for="rel in [...article.relations.outgoing, ...article.relations.incoming]"
          :key="rel.id"
          :to="`/article/${rel.slug}`"
          class="group flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 transition hover:border-[var(--color-accent)]"
        >
          <span class="rounded-md bg-[var(--color-accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--color-accent)]">{{ rel.relation_type }}</span>
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{{ rel.title }}</span>
          <Icon icon="lucide:arrow-right" class="h-4 w-4 text-[var(--color-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--color-accent)]" />
        </RouterLink>
      </div>
    </section>
  </article>
</template>
