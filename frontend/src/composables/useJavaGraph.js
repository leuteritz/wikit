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

// Aktuell „aufleuchtende" Call-Edge: gesetzt, wenn im Code-Tab (JavaClassDetail) ein Methodenname
// angeklickt wird, der einer Call-Edge entspricht. Wert: { callerFileId, method } | null.
// Der Graph (JavaDependencyGraph) liest dies und hebt die passende Kante hervor; das Code-Token
// wird im Editor mit derselben Farbe markiert. Bewusst geteilter Module-State (kein Pinia).
const highlightedCall = ref(null)

// Aktuell „aufleuchtende" Methoden-DEFINITION (SOURCE-Seite): gesetzt, wenn im Code-Tab
// (JavaClassDetail) eine Methode angeklickt wird, die eine EINGEHENDE Call-Edge hat. Wert:
// { definerFileId, method } | null. Symmetrisch zu highlightedCall (Consumer-Seite): der Graph
// hebt die eingehenden Kanten dieser Methode hervor, der Editor markiert den GESAMTEN Methodenblock.
const highlightedDef = ref(null)

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
    // --- Debug (F12): zeigt, was die Neuberechnung erzeugt hat ---
    try {
      const all = edges.value || []
      const byKind = all.reduce((acc, e) => {
        const k = e.is_manual ? 'manual' : e.kind || 'call'
        acc[k] = (acc[k] || 0) + 1
        return acc
      }, {})
      console.group('[java-edges] Kanten neu berechnet')
      console.log('Backend-Anzahl (ohne Tombstones):', res?.count)
      console.log('Geladene Kanten gesamt:', all.length, byKind)
      console.table(
        all.map((e) => ({
          source: e.source_class,
          target: e.target_class,
          kind: e.kind,
          method: e.method_name,
          conf: e.confidence,
          manual: e.is_manual,
        })),
      )
      console.groupEnd()
    } catch {
      /* Logging darf den Ablauf nie stoeren */
    }
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
    highlightedCall,
    setHighlightedCall(payload) {
      highlightedCall.value = payload
    },
    // Toggle-Semantik: derselbe {callerFileId, method} erneut angeklickt -> Highlight aus.
    // Sonst auf die neue Call-Edge umschalten. Eine einzige Zuweisung -> Graph-Kante UND
    // Code-Token aktualisieren sich in EINEM reaktiven Tick (kein Flackern beim Wechsel).
    toggleHighlightedCall(payload) {
      const cur = highlightedCall.value
      if (cur && cur.callerFileId === payload.callerFileId && cur.method === payload.method) {
        highlightedCall.value = null
      } else {
        highlightedCall.value = payload
      }
    },
    clearHighlightedCall() {
      highlightedCall.value = null
    },
    // --- SOURCE-Seite (eingehende Kanten): spiegelt die Consumer-API oben ---------------------
    highlightedDef,
    setHighlightedDef(payload) {
      highlightedDef.value = payload
    },
    // Toggle-Semantik analog zu toggleHighlightedCall: dieselbe {definerFileId, method} erneut
    // angeklickt -> aus; sonst auf die neue Definition umschalten.
    toggleHighlightedDef(payload) {
      const cur = highlightedDef.value
      if (cur && cur.definerFileId === payload.definerFileId && cur.method === payload.method) {
        highlightedDef.value = null
      } else {
        highlightedDef.value = payload
      }
    },
    clearHighlightedDef() {
      highlightedDef.value = null
    },
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
