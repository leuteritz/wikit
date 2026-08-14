<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { isTypingTarget } from '../lib/shortcuts.js'
import { forgetArticle, rememberArticle } from '../lib/recentArticles.js'
import { useArticles } from '../composables/useArticles.js'
import ArticleView from '../components/ArticleView.vue'
import BusyState from '../components/BusyState.vue'
import TableOfContents from '../components/TableOfContents.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
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
    // ⚠️ Erst NACH dem erfolgreichen Laden gemerkt: ein Slug, der 404 liefert, ist kein Ort, an
    // dem jemand war – er stuende sonst als Chip in der Liste und fuehrte beim Klick wieder ins
    // Leere. Aus demselben Grund der Titel vom Server und nicht aus der Adresse.
    rememberArticle(article.value.slug, article.value.title)
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

// ⚠️ Der gestaltete Dialog statt `window.confirm`: der native kennt weder den Ton der Anwendung
// noch ihren Fokus-Kaefig, blockiert den Hauptthread und schneidet lange Titel nach Browser-Laune
// ab. `ConfirmDialog` gab es bereits – er wurde hier nur nie benutzt.
const pendingDelete = ref(null)
const deleting = ref(false)

function onDelete(a) {
  pendingDelete.value = a
}

async function confirmDelete() {
  const a = pendingDelete.value
  if (!a) return
  deleting.value = true
  try {
    await remove(a.id)
    // Ein geloeschter Artikel gehoert nicht mehr in „zuletzt gelesen": der Chip fuehrte ins Leere.
    forgetArticle(a.slug)
    router.push('/')
  } catch {
    // Der Grund steht bereits als Toast (lib/api.js) – der Dialog schliesst trotzdem, sonst
    // bleibt er als Rest stehen und behauptet, es sei noch etwas zu entscheiden.
  } finally {
    deleting.value = false
    pendingDelete.value = null
  }
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
      <p class="notice-danger rounded-xl p-4">{{ error }}</p>
    </div>

    <div v-else-if="article" class="mx-auto flex max-w-6xl gap-10">
      <div class="min-w-0 flex-1 pb-16">
        <JavaAnalysisPanel v-if="javaFile" :file="javaFile" :article-id="article.id" />

        <!-- ⚠️ Unterhalb von `xl` fällt die Spalte rechts weg – und damit fiel bis hierher jede
             Navigation im Artikel weg. Auf einem 1366er-Laptop mit Sidebar ist genau das der
             Normalfall, nicht die Ausnahme. Also dieselbe Liste, nur zusammengeklappt: `<details>`
             statt eines eigenen Zustands, weil der Browser das Auf und Zu bereits kann. -->
        <details
          v-if="article.toc?.length"
          class="mb-6 rounded-xl border border-line bg-surface-2 px-4 py-3 xl:hidden"
        >
          <summary class="cursor-pointer list-none font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-ink">
            On this page ({{ article.toc.length }})
          </summary>
          <div class="mt-3">
            <TableOfContents :toc="article.toc" :heading="false" />
          </div>
        </details>

        <ArticleView :article="article" @delete="onDelete" @linked="refresh" />
      </div>
      <aside class="hidden w-56 shrink-0 xl:block">
        <div class="sticky top-6">
          <TableOfContents :toc="article.toc" />
        </div>
      </aside>
    </div>

    <ConfirmDialog
      :open="!!pendingDelete"
      tone="danger"
      icon="lucide:trash-2"
      title="Delete this article?"
      confirm-label="Delete"
      busy-label="Deleting…"
      :busy="deleting"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <template #subtitle>
        <span class="font-mono">{{ pendingDelete?.title }}</span>
      </template>
      <!-- Was verloren geht, gehört VOR den Klick. Die Fassungen hängen per CASCADE am Artikel
           (s. schema.ts) – sie sind danach nicht mehr zurückzuholen, und das ist der eigentliche
           Verlust, nicht der Text, den man noch im Kopf hat. -->
      Its text and every stored version go with it. This cannot be undone.
    </ConfirmDialog>
  </div>
</template>
