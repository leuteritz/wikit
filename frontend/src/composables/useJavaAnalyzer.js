// Composable fuer die Java-Analyse (kein Pinia). Kapselt alle API-Aufrufe ueber lib/api.js
// -> in Komponenten wird nie direkt fetch() benutzt.
import { reactive, toRefs } from 'vue'
import { api } from '../lib/api.js'

const state = reactive({
  files: [],
  loading: false,
  analyzing: false,
  error: '',
})

async function fetchFiles() {
  state.loading = true
  state.error = ''
  try {
    state.files = await api.listJavaFiles()
  } catch (e) {
    state.error = e.message
  } finally {
    state.loading = false
  }
}

export function useJavaAnalyzer() {
  return {
    ...toRefs(state),
    fetchFiles,
    fetchGraph: () => api.getJavaGraph(),
    getFile: (id) => api.getJavaFile(id),
    async analyzeCode(source, filename = '') {
      state.analyzing = true
      state.error = ''
      try {
        const result = await api.analyzeJava({ source, filename })
        await fetchFiles()
        return result
      } catch (e) {
        state.error = e.message
        throw e
      } finally {
        state.analyzing = false
      }
    },
    async deleteFile(id) {
      await api.deleteJavaFile(id)
      await fetchFiles()
    },
    summarizeMethod: (id) => api.summarizeJavaMethod(id),
    linkArticle: (id, articleId) => api.linkJavaArticle(id, { article_id: articleId }),
  }
}
