<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { isTypingTarget } from '../lib/shortcuts.js'
import { useArticles } from '../composables/useArticles.js'
import ArticleView from '../components/ArticleView.vue'
import BusyState from '../components/BusyState.vue'
import TableOfContents from '../components/TableOfContents.vue'
import JavaAnalysisPanel from '../components/java/JavaAnalysisPanel.vue'

const props = defineProps({ slug: { type: String, required: true } })
const router = useRouter()
const { remove } = useArticles()

const article = ref(null)
const javaFile = ref(null)
const loading = ref(true)
const error = ref('')
const startedAt = ref(Date.now())

onMounted(async () => {
  try {
    article.value = await api.getArticle(props.slug)
    // Verknuepfte Java-Klasse laden (404 = keine -> still ignorieren).
    try {
      javaFile.value = await api.getJavaFileByArticle(article.value.id)
    } catch {
      javaFile.value = null
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

/**
 * Nach einer aus den Vorschlägen angelegten Beziehung den Artikel neu holen.
 *
 * ⚠️ Neu laden statt die Relation im Client einzuhängen: `relations` kommt fertig serialisiert vom
 * Server, und sie hier zusammenzusetzen wäre eine zweite Fassung dieses Shapes. Der Request ist
 * derselbe, der die Seite gefüllt hat.
 */
async function refresh() {
  try {
    article.value = await api.getArticle(props.slug)
  } catch {
    // Der sichtbare Stand bleibt der alte – das ist besser als eine leere Seite nach einem Klick,
    // der selbst funktioniert hat.
  }
}

async function onDelete(a) {
  if (!confirm(`Really delete article “${a.title}”?`)) return
  await remove(a.id)
  router.push('/')
}

// `e` fuehrt in den Editor. Wie jedes Kuerzel der Anwendung prueft es `isTypingTarget` – sonst
// verschwaende der Buchstabe in einem Suchfeld die Seite. Modifikatoren gehoeren dem Browser.
function onKeydown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key !== 'e' || isTypingTarget(document.activeElement)) return
  if (!article.value) return
  e.preventDefault()
  router.push(`/edit/${article.value.slug}`)
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="px-5 py-8">
    <!-- Gleiche Wartemeldung wie im Analyzer und in der Suche (components/BusyState.vue). -->
    <BusyState
      v-if="loading"
      class="mx-auto max-w-3xl"
      variant="panel"
      title="Loading article…"
      detail="rendered markdown · table of contents"
      :since="startedAt"
      :rows="4"
    />
    <div v-else-if="error" class="mx-auto max-w-3xl">
      <p class="rounded-xl p-4 text-danger" style="background-color: color-mix(in srgb, var(--color-danger) 12%, transparent)">
        {{ error }}
      </p>
    </div>

    <div v-else-if="article" class="mx-auto flex max-w-6xl gap-10">
      <div class="min-w-0 flex-1 pb-16">
        <JavaAnalysisPanel v-if="javaFile" :file="javaFile" :article-id="article.id" />
        <ArticleView :article="article" @delete="onDelete" @linked="refresh" />
      </div>
      <aside class="hidden w-56 shrink-0 xl:block">
        <div class="sticky top-6">
          <TableOfContents :toc="article.toc" />
        </div>
      </aside>
    </div>
  </div>
</template>
