<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { useArticles } from '../composables/useArticles.js'
import MarkdownEditor from '../components/MarkdownEditor.vue'

const props = defineProps({ slug: { type: String, default: '' } })
const router = useRouter()
const store = useArticles()
const { articles, categories } = store

const isEdit = computed(() => !!props.slug)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const form = reactive({
  id: null,
  title: '',
  slug: '',
  summary: '',
  category_id: '',
  tagsInput: '',
  content: '# Neuer Artikel\n\nHier den Inhalt schreiben…\n',
})

const relations = ref({ outgoing: [], incoming: [] })
const newRel = reactive({ target_id: '', relation_type: 'related', label: '' })
const RELATION_TYPES = ['related', 'depends-on', 'uses', 'deploys-to', 'integrates', 'enthält', 'calls']

const otherArticles = computed(() => articles.value.filter((a) => a.id !== form.id))

onMounted(async () => {
  await store.load()
  if (!isEdit.value) return
  loading.value = true
  try {
    const a = await api.getArticle(props.slug)
    form.id = a.id
    form.title = a.title
    form.slug = a.slug
    form.summary = a.summary
    form.category_id = a.category?.id || ''
    form.tagsInput = (a.tags || []).join(', ')
    form.content = a.content
    relations.value = a.relations || { outgoing: [], incoming: [] }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function tagsArray() {
  return form.tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
}

async function save() {
  if (!form.title.trim()) { error.value = 'Bitte einen Titel eingeben.'; return }
  saving.value = true
  error.value = ''
  const payload = {
    title: form.title.trim(),
    slug: form.slug.trim() || undefined,
    summary: form.summary.trim(),
    category_id: form.category_id || null,
    tags: tagsArray(),
    content: form.content,
  }
  try {
    const result = isEdit.value
      ? await store.update(form.id, payload)
      : await store.create(payload)
    router.push(`/article/${result.slug}`)
  } catch (e) {
    error.value = e.message
    saving.value = false
  }
}

async function createCategory() {
  const name = prompt('Name der neuen Kategorie:')
  if (!name) return
  try {
    const cat = await api.createCategory({ name })
    await store.reload()
    form.category_id = cat.id
  } catch (e) {
    alert(e.message)
  }
}

async function addRelation() {
  if (!newRel.target_id) return
  try {
    await api.createRelation({
      source_id: form.id,
      target_id: Number(newRel.target_id),
      relation_type: newRel.relation_type,
      label: newRel.label,
    })
    const a = await api.getArticle(form.slug)
    relations.value = a.relations
    newRel.target_id = ''
    newRel.label = ''
  } catch (e) {
    alert(e.message)
  }
}

async function removeRelation(id) {
  await api.deleteRelation(id)
  const a = await api.getArticle(form.slug)
  relations.value = a.relations
}
</script>

<template>
  <div class="flex h-[calc(100vh-3.5rem)] flex-col px-5 py-5">
    <div class="mb-4 flex shrink-0 items-center justify-between gap-4">
      <h1 class="text-xl font-bold text-slate-900 dark:text-white">
        {{ isEdit ? 'Artikel bearbeiten' : 'Neuer Artikel' }}
      </h1>
      <div class="flex items-center gap-2">
        <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" @click="router.back()">Abbrechen</button>
        <button
          type="button"
          class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >{{ saving ? 'Speichert…' : 'Speichern' }}</button>
      </div>
    </div>

    <p v-if="error" class="mb-3 shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">{{ error }}</p>

    <!-- Metadaten -->
    <div class="mb-3 grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <input v-model="form.title" placeholder="Titel *" class="input md:col-span-2" />
      <select v-model="form.category_id" class="input">
        <option value="">— Kategorie —</option>
        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
      </select>
      <button type="button" class="input cursor-pointer text-left text-slate-500 hover:text-indigo-600" @click="createCategory">+ Neue Kategorie</button>
      <input v-model="form.summary" placeholder="Kurzbeschreibung" class="input md:col-span-2" />
      <input v-model="form.tagsInput" placeholder="Tags (Komma-getrennt)" class="input md:col-span-2" />
    </div>

    <!-- Editor -->
    <div class="min-h-0 flex-1">
      <MarkdownEditor v-model="form.content" />
    </div>

    <!-- Relationen (nur bei vorhandenem Artikel) -->
    <details v-if="isEdit" class="mt-3 shrink-0 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <summary class="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">Zusammenhänge ({{ relations.outgoing.length }})</summary>
      <div class="mt-3 space-y-2">
        <div v-for="rel in relations.outgoing" :key="rel.id" class="flex items-center gap-2 text-sm">
          <span class="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">{{ rel.relation_type }}</span>
          <span class="flex-1 text-slate-700 dark:text-slate-300">{{ rel.title }}</span>
          <button type="button" class="text-rose-500 hover:text-rose-600" @click="removeRelation(rel.id)">✕</button>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-2">
          <select v-model="newRel.target_id" class="input flex-1">
            <option value="">Ziel-Artikel wählen…</option>
            <option v-for="a in otherArticles" :key="a.id" :value="a.id">{{ a.title }}</option>
          </select>
          <input v-model="newRel.relation_type" list="reltypes" class="input w-36" placeholder="Typ" />
          <datalist id="reltypes">
            <option v-for="t in RELATION_TYPES" :key="t" :value="t" />
          </datalist>
          <input v-model="newRel.label" class="input w-40" placeholder="Label (optional)" />
          <button type="button" class="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-700" @click="addRelation">Hinzufügen</button>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";
.input {
  @apply rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-500/20;
}
</style>
