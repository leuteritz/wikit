// Composable fuer die persistierten Klassen-Graph-Kanten (auto + manuell).
// Bewusst getrennt von useJavaAnalyzer: Kanten-Mutationen (Drag-to-Connect, Bearbeiten,
// Loeschen) haben einen eigenen Lebenszyklus und sollen den ohnehin grossen Analyzer-Store
// nicht aufblaehen. HTTP laeuft ausschliesslich ueber lib/api.js (kein fetch in Komponenten).
import { ref } from 'vue'
import { api } from '../lib/api.js'

// Module-Singleton -> alle Konsumenten teilen sich denselben Kanten-Zustand.
const edges = ref([])
const loading = ref(false)
const recomputing = ref(false)
const error = ref('')

async function fetchEdges() {
  loading.value = true
  error.value = ''
  try {
    edges.value = await api.listJavaEdges()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Alle Auto-Call-Edges im Backend neu berechnen + persistieren, danach neu laden.
async function recomputeEdges() {
  recomputing.value = true
  error.value = ''
  try {
    const res = await api.recomputeJavaEdges()
    await fetchEdges()
    return res
  } catch (e) {
    error.value = e.message
    throw e
  } finally {
    recomputing.value = false
  }
}

export function useJavaGraph() {
  return {
    edges,
    loading,
    recomputing,
    error,
    fetchEdges,
    recomputeEdges,
    // Frontend-Spiegel der Kanten sofort leeren (Komplett-Reset im Code-Tab). Die Auto-Kanten
    // werden serverseitig bei jedem deleteFile ohnehin neu (leer) gerechnet; danach reicht es,
    // den lokalen Ref zu nullen, damit der Graph nicht kurz alte Kanten zeigt.
    resetEdges() {
      edges.value = []
    },
    // Gibt die erstellte/aktualisierte Kante zurueck (z. B. fuer Undo), refetcht danach.
    async createEdge(data) {
      const edge = await api.createJavaEdge(data)
      await fetchEdges()
      return edge
    },
    async updateEdge(id, data) {
      const edge = await api.updateJavaEdge(id, data)
      await fetchEdges()
      return edge
    },
    async deleteEdge(id) {
      await api.deleteJavaEdge(id)
      await fetchEdges()
    },
  }
}
