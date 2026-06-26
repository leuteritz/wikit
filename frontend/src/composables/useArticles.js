// Zentraler, leichtgewichtiger Store (kein Pinia noetig).
// Haelt die Artikelliste + Kategorien fuer Sidebar und Suche im Speicher.
import { reactive, toRefs } from 'vue'
import { api } from '../lib/api.js'

const state = reactive({
  articles: [],
  categories: [],
  loaded: false,
  loading: false,
  error: '',
})

async function load(force = false) {
  if (state.loaded && !force) return
  state.loading = true
  state.error = ''
  try {
    const [articles, categories] = await Promise.all([
      api.listArticles(),
      api.listCategories(),
    ])
    state.articles = articles
    state.categories = categories
    state.loaded = true
  } catch (e) {
    state.error = e.message
  } finally {
    state.loading = false
  }
}

export function useArticles() {
  return {
    ...toRefs(state),
    load,
    reload: () => load(true),
    async create(data) {
      const article = await api.createArticle(data)
      await load(true)
      return article
    },
    async update(id, data) {
      const article = await api.updateArticle(id, data)
      await load(true)
      return article
    },
    async remove(id) {
      await api.deleteArticle(id)
      await load(true)
    },
  }
}
