<script setup>
import { ref, watch, nextTick, onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import CategoryBadge from './CategoryBadge.vue'
import RelatedArticles from './RelatedArticles.vue'
import ArticleBacklinks from './ArticleBacklinks.vue'
import { Icon } from '../lib/icons.js'
import { formatDateTime as fmtDate } from '../lib/format.js'
import { isHighlightableVar, varColorClass } from '../lib/varHighlight.js'

const props = defineProps({
  article: { type: Object, required: true },
})
// `linked` reicht nur durch: die Vorschlagsliste hat eine Beziehung angelegt, also stimmt der
// Abschnitt „Relations" darüber nicht mehr – und der gehört zum Artikel, nicht zu dieser Liste.
defineEmits(['delete', 'linked'])

const bodyEl = ref(null)

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

// --- Interne Links bleiben in der Anwendung ------------------------------------------------------
// Der Artikelrumpf kommt als fertiges HTML vom Server (`v-html`) – seine `<a href="/article/…">`
// sind gewoehnliche Links und loesten deshalb einen VOLLEN Seiten-Neuladen aus: Router, Stores und
// der ganze Bundle wurden fuer einen Sprung innerhalb desselben Wikis neu aufgebaut.
//
// Ein delegierter Handler an der Wurzel statt eines Handlers je Link: die Links entstehen erst beim
// Rendern des Markdown, und nach jedem Nachladen muesste man sie erneut verdrahten.
const router = useRouter()
function onBodyClick(e) {
  // Modifikatoren gehoeren dem Browser: Strg-Klick oeffnet einen neuen Tab, und das soll er.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = e.target.closest('a')
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return
  const href = a.getAttribute('href') || ''
  // Nur eigene, absolute Pfade – externe Ziele, `mailto:` und reine Anker (`#heading`, die die
  // Anker-Permalinks erzeugen) bleiben unangetastet.
  if (!href.startsWith('/') || href.startsWith('//')) return
  e.preventDefault()
  router.push(href)
}

onMounted(enhanceCodeBlocks)
watch(() => props.article?.id, () => nextTick(enhanceCodeBlocks))
</script>

<template>
  <article>
    <header class="mb-6 border-b border-line pb-6">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <CategoryBadge :category="article.category" />
        <span class="text-xs text-muted">Updated {{ fmtDate(article.updated_at) }}</span>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-ink">{{ article.title }}</h1>
      <p v-if="article.summary" class="mt-2 text-lg text-muted">{{ article.summary }}</p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <!-- Ein Schlagwort ist eine FRAGE („was gehört noch dazu?"), keine Beschriftung – seit es
             `/tag/:name` gibt, führt es dorthin, statt nur dazustehen. -->
        <RouterLink
          v-for="tag in article.tags"
          :key="tag"
          :to="`/tag/${encodeURIComponent(tag)}`"
          class="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-xs text-accent transition hover:bg-accent hover:text-accent-contrast"
        >#{{ tag }}</RouterLink>
      </div>

      <div class="mt-5 flex gap-2">
        <!-- ⚠️ Der Bearbeiten-Knopf stand hier lange NICHT: `/edit/:slug` war ausschließlich über
             einen Befund im Wiki-Health erreichbar. Der offensichtlichste Weg zu einem Artikel ist
             aber der Artikel selbst – und er steht vor History und Delete, weil Bearbeiten das ist,
             was man beim Lesen am häufigsten will. -->
        <RouterLink
          :to="`/edit/${article.slug}`"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:border-accent hover:text-accent"
        >
          <Icon icon="lucide:file-edit" class="h-4 w-4" />
          Edit
          <kbd class="ml-0.5 rounded border border-line px-1 font-mono text-3xs text-muted">E</kbd>
        </RouterLink>
        <!-- Der Weg zum Gedächtnis des Artikels steht AM Artikel: „was stand hier vorher?" fragt
             man beim Lesen, nicht in einer Übersicht. -->
        <RouterLink
          :to="`/article/${article.slug}/history`"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:border-accent hover:text-accent"
        >
          <Icon icon="lucide:history" class="h-4 w-4" />
          History
        </RouterLink>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-danger transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]"
          @click="$emit('delete', article)"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4" />
          Delete
        </button>
      </div>
    </header>

    <div
      ref="bodyEl"
      class="article-body prose max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-a:text-accent"
      v-html="article.content_html"
      @click="onBodyClick"
    />

    <!-- Zusammenhänge -->
    <section
      v-if="article.relations && (article.relations.outgoing.length || article.relations.incoming.length)"
      class="mt-10 border-t border-line pt-6"
    >
      <h2 class="mb-4 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted">Relations</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <RouterLink
          v-for="rel in [...article.relations.outgoing, ...article.relations.incoming]"
          :key="rel.id"
          :to="`/article/${rel.slug}`"
          class="group flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3 transition hover:border-accent"
        >
          <span class="rounded-md bg-accent-soft px-2 py-1 text-2xs font-medium text-accent">{{ rel.relation_type }}</span>
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink group-hover:text-accent">{{ rel.title }}</span>
          <Icon icon="lucide:arrow-right" class="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </RouterLink>
      </div>
    </section>

    <!-- Drei Abschnitte, drei Verbindlichkeiten – in abnehmender Ordnung:
         Relations (oben, von Hand eingetragen) -> Linked mentions (steht so im Text)
         -> Related (Vermutung aus dem Bedeutungsindex). Ein leerer Abschnitt erscheint nicht. -->
    <ArticleBacklinks :article="article" />

    <RelatedArticles :article="article" @linked="$emit('linked')" />
  </article>
</template>
