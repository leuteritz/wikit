<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { useArticles } from '../composables/useArticles.js'
import ArticleView from '../components/ArticleView.vue'
import TableOfContents from '../components/TableOfContents.vue'

const props = defineProps({ slug: { type: String, required: true } })
const router = useRouter()
const { remove } = useArticles()

const article = ref(null)
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    article.value = await api.getArticle(props.slug)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

async function onDelete(a) {
  if (!confirm(`Artikel „${a.title}" wirklich löschen?`)) return
  await remove(a.id)
  router.push('/')
}
</script>

<template>
  <div class="px-5 py-8">
    <div v-if="loading" class="mx-auto max-w-3xl text-sm text-slate-400">Lädt…</div>
    <div v-else-if="error" class="mx-auto max-w-3xl">
      <p class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
        {{ error }}
      </p>
    </div>

    <div v-else-if="article" class="mx-auto flex max-w-6xl gap-10">
      <div class="min-w-0 flex-1 pb-16">
        <ArticleView :article="article" @delete="onDelete" />
      </div>
      <aside class="hidden w-56 shrink-0 xl:block">
        <div class="sticky top-20">
          <TableOfContents :toc="article.toc" />
        </div>
      </aside>
    </div>
  </div>
</template>
