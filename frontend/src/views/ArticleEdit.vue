<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { api } from '../lib/api.js'
import { useArticles } from '../composables/useArticles.js'
import MarkdownEditor from '../components/MarkdownEditor.vue'
import { Icon } from '../lib/icons.js'
import { readDraft, writeDraft, clearDraft } from '../lib/articleDraft.js'
import { formatRelative } from '../lib/format.js'
import { IS_MAC } from '../lib/shortcuts.js'

const props = defineProps({ slug: { type: String, default: '' } })
const router = useRouter()
const store = useArticles()
const { articles, categories } = store

const isEdit = computed(() => !!props.slug)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

// Der Stand, wie er zuletzt vom Server kam (bzw. der leere Neu-Artikel). Alles, was davon abweicht,
// ist ungesichert – das ist die EINE Definition von „dirty", die Entwurfssicherung, Speichern-Knopf
// und Verlassen-Schutz gemeinsam benutzen.
const baseline = ref('')
const draftFound = ref(null)

const form = reactive({
  id: null,
  title: '',
  slug: '',
  summary: '',
  category_id: '',
  tagsInput: '',
  content: '# New article\n\nWrite your content here…\n',
})

const relations = ref({ outgoing: [], incoming: [] })
const newRel = reactive({ target_id: '', relation_type: 'related', label: '' })
const RELATION_TYPES = ['related', 'depends-on', 'uses', 'deploys-to', 'integrates', 'contains', 'calls']

const otherArticles = computed(() => articles.value.filter((a) => a.id !== form.id))

// Die Felder, die der Entwurf traegt – und zugleich das, woran „ungesichert" gemessen wird.
// Beziehungen stehen NICHT darin: sie werden beim Anlegen sofort auf dem Server geschrieben, sind
// also nie ungesichert.
const DRAFT_FIELDS = ['title', 'slug', 'summary', 'category_id', 'tagsInput', 'content']
const snapshot = () => JSON.stringify(DRAFT_FIELDS.map((k) => form[k]))
const dirty = computed(() => snapshot() !== baseline.value)

onMounted(async () => {
  await store.load()
  if (isEdit.value) {
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
  }
  baseline.value = snapshot()

  // Erst JETZT nach einem Entwurf sehen – vorher waere „weicht ab" gegen einen leeren Stand
  // gemessen und jeder Artikel haette einen Entwurf zu melden.
  const d = readDraft(props.slug)
  if (d && JSON.stringify(DRAFT_FIELDS.map((k) => d[k])) !== baseline.value) draftFound.value = d
  else if (d) clearDraft(props.slug)

  // Ab hier wird mitgeschrieben. Nur solange etwas abweicht – ein Entwurf, der dem gespeicherten
  // Stand gleicht, ist keiner.
  watch(
    () => snapshot(),
    () => {
      if (dirty.value) writeDraft(props.slug, Object.fromEntries(DRAFT_FIELDS.map((k) => [k, form[k]])))
      else clearDraft(props.slug)
    },
  )
})

function restoreDraft() {
  for (const k of DRAFT_FIELDS) if (draftFound.value[k] !== undefined) form[k] = draftFound.value[k]
  draftFound.value = null
}
function discardDraft() {
  clearDraft(props.slug)
  draftFound.value = null
}

function tagsArray() {
  return form.tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
}

async function save() {
  if (saving.value) return
  if (!form.title.trim()) { error.value = 'Please enter a title.'; return }
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
    // Der Entwurf hat seinen Zweck erfuellt. `baseline` mitziehen, sonst schlaegt der
    // Verlassen-Schutz beim Weiterleiten auf den gerade gespeicherten Artikel zu.
    clearDraft(props.slug)
    baseline.value = snapshot()
    router.push(`/article/${result.slug}`)
  } catch (e) {
    error.value = e.message
    saving.value = false
  }
}

// --- Ungesichertes geht nicht still verloren ----------------------------------------------------
// Drei Wege aus dem Editor, zwei davon kann die Anwendung selbst abfangen:
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return confirm('This article has unsaved changes. Leave anyway? The draft is kept in this browser.')
})
// …und den dritten (Tab schliessen, Reload) nur der Browser, mit seinem eigenen Wortlaut.
function onBeforeUnload(e) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

// Strg+S speichert. Ohne `preventDefault` oeffnete der Browser seinen „Seite speichern"-Dialog –
// der haeufigste Griff im Editor darf nicht der falsche sein.
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    save()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})

async function createCategory() {
  const name = prompt('Name of the new category:')
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
  <div class="flex h-full flex-col px-5 py-5">
    <div class="mb-4 flex shrink-0 items-center justify-between gap-4">
      <h1 class="flex items-baseline gap-2.5 font-mono text-xl font-semibold text-ink">
        {{ isEdit ? 'Edit article' : 'New article' }}
        <!-- Der Zustand steht am Titel, nicht am Knopf: „ist etwas offen?" fragt man, bevor man
             nach dem Knopf sucht. -->
        <span v-if="dirty" class="badge-warning rounded px-1.5 py-0.5 font-mono text-3xs font-semibold">unsaved</span>
      </h1>
      <div class="flex items-center gap-2">
        <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-muted transition hover:bg-surface-offset" @click="router.back()">Cancel</button>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
          <kbd class="rounded border border-accent-contrast/30 px-1 font-mono text-3xs">{{ IS_MAC ? '⌘' : 'Ctrl' }} S</kbd>
        </button>
      </div>
    </div>

    <!-- ⚠️ Der Entwurf wird ANGEBOTEN, nicht eingespielt: er kann älter sein als der gespeicherte
         Stand (anderer Tab, anderer Rechner), und dann wäre das stille Überschreiben die falsche
         von zwei Wahrheiten. -->
    <div
      v-if="draftFound"
      class="mb-3 flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
    >
      <Icon icon="lucide:file-clock" class="h-4 w-4 shrink-0 text-warning" />
      <span class="flex-1 text-ink">
        An unsaved draft from this browser is newer than what you see
        <span class="text-muted">— {{ formatRelative(new Date(draftFound.savedAt).toISOString()) }}</span>
      </span>
      <button type="button" class="rounded-lg bg-warning px-3 py-1 text-xs font-semibold text-accent-contrast transition hover:opacity-90" @click="restoreDraft">Restore it</button>
      <button type="button" class="rounded-lg px-2 py-1 text-xs font-medium text-muted transition hover:bg-surface-offset" @click="discardDraft">Discard</button>
    </div>

    <p v-if="error" class="mb-3 shrink-0 rounded-lg bg-danger/12 px-3 py-2 text-sm text-danger">{{ error }}</p>

    <!-- Metadaten -->
    <div class="mb-3 grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <input v-model="form.title" placeholder="Title *" class="input md:col-span-2" />
      <select v-model="form.category_id" class="input">
        <option value="">— Category —</option>
        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
      </select>
      <button type="button" class="input cursor-pointer text-left text-muted hover:text-accent" @click="createCategory">+ New category</button>
      <input v-model="form.summary" placeholder="Summary" class="input md:col-span-2" />
      <input v-model="form.tagsInput" placeholder="Tags (comma-separated)" class="input md:col-span-2" />
    </div>

    <!-- Editor -->
    <div class="min-h-0 flex-1">
      <MarkdownEditor v-model="form.content" :articles="otherArticles" />
    </div>

    <!-- Relationen (nur bei vorhandenem Artikel) -->
    <details v-if="isEdit" class="mt-3 shrink-0 rounded-xl border border-line p-3">
      <summary class="cursor-pointer text-sm font-semibold text-ink">Relations ({{ relations.outgoing.length }})</summary>
      <div class="mt-3 space-y-2">
        <div v-for="rel in relations.outgoing" :key="rel.id" class="flex items-center gap-2 text-sm">
          <span class="rounded bg-accent-soft px-2 py-0.5 text-xs text-accent">{{ rel.relation_type }}</span>
          <span class="flex-1 text-ink">{{ rel.title }}</span>
          <button type="button" class="grid h-6 w-6 place-items-center rounded text-danger transition hover:bg-surface-offset" title="Remove" @click="removeRelation(rel.id)"><Icon icon="lucide:x" class="h-4 w-4" /></button>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-2">
          <select v-model="newRel.target_id" class="input flex-1">
            <option value="">Choose target article…</option>
            <option v-for="a in otherArticles" :key="a.id" :value="a.id">{{ a.title }}</option>
          </select>
          <input v-model="newRel.relation_type" list="reltypes" class="input w-36" placeholder="Type" />
          <datalist id="reltypes">
            <option v-for="t in RELATION_TYPES" :key="t" :value="t" />
          </datalist>
          <input v-model="newRel.label" class="input w-40" placeholder="Label (optional)" />
          <button type="button" class="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast transition hover:bg-accent-hover" @click="addRelation">Add</button>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";
.input {
  @apply rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft;
}
</style>
