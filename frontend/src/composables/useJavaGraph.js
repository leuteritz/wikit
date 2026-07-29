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

// Knoten, ueber dem gerade die Maus steht (`c:<fileId>` | `p:<path>` | null). Der Graph dimmt
// darueber alles, was nicht in der direkten Nachbarschaft liegt – bei dicht liegenden Kanten die
// einzige Moeglichkeit, EINE Beziehung wieder herauszulesen. Bewusst hier und nicht als Prop:
// ManagedEdge liest den Wert direkt, sonst muesste bei jedem Hover der komplette Kanten-Store von
// Vue Flow neu geschrieben werden (bei einigen hundert Kanten sichtbar traege).
const hoveredNode = ref(null)

// Gegenstueck fuer die KANTE unter der Maus: `{ id, sourceId, targetId, color }` | null.
// Eine Kante ist eine Aussage ueber ZWEI Klassen – wer sie ansieht, will wissen, welche beiden.
// Deshalb hebt der Graph beim Hover die Linie UND ihre beiden Endpunkte hervor und daempft den
// Rest. Gleiche Begruendung wie bei hoveredNode fuer den geteilten Zustand statt Props: sonst
// muesste bei jeder Mausbewegung der komplette Kanten-Store neu geschrieben werden.
const hoveredEdge = ref(null)

// --- Suche IM gezeichneten Graphen ------------------------------------------------------------
// Aus demselben Grund hier wie der Hover-Zustand: ManagedEdge entscheidet selbst, ob es gemeint
// ist, statt dass der komplette Kanten-Store bei jedem Tastendruck neu geschrieben wird.
// `graphQuery` ist die Roheingabe (Parsen macht lib/graphQuery.js), `graphHitNodes` die Menge der
// getroffenen Karten-Ids – Kanten brauchen sie, um zu erkennen, dass sie ZWEI Treffer verbindet
// und deshalb dazugehoert.
const graphQuery = ref('')
const graphHitNodes = ref(new Set())

// Rueckweg aus einem Kanten-Panel in den Quellcode.
//
// Der Sprung „Kante -> Aufrufstelle" ist eine Einbahnstrasse: das Panel schliesst sich (sonst
// verdeckt es genau den Code, zu dem gesprungen wurde), und damit ist auch die Beziehung weg, die
// man gerade untersucht hat. Wer den Code gelesen hat, will zurueck zu genau dieser Kante – nicht
// sie im Graphen neu suchen. `edgeReturn` haelt dafuer den Panel-Zustand fest; `edgeReturnToken`
// ist das Signal an den Graphen, ihn wiederherzustellen (gleiche Mechanik wie `focusToken` dort:
// ein Zaehler, damit auch zweimal dasselbe Ziel ausloest).
const edgeReturn = ref(null) // { kind: 'edge'|'bundle', label, payload } | null
const edgeReturnToken = ref(0)

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
    // --- Hover-Fokus (Graph) ------------------------------------------------------------------
    hoveredNode,
    setHoveredNode(nodeId) {
      hoveredNode.value = nodeId
    },
    hoveredEdge,
    setHoveredEdge(payload) {
      hoveredEdge.value = payload
    },
    // --- Suche im Graphen ---------------------------------------------------------------------
    graphQuery,
    setGraphQuery(value) {
      graphQuery.value = value || ''
      if (!graphQuery.value) graphHitNodes.value = new Set()
    },
    graphHitNodes,
    // Immer ein NEUES Set setzen – ein mutiertes bliebe fuer die Kanten unsichtbar.
    setGraphHitNodes(ids) {
      graphHitNodes.value = ids instanceof Set ? ids : new Set(ids || [])
    },
    // --- Rueckweg zum Kanten-Panel ------------------------------------------------------------
    edgeReturn,
    edgeReturnToken,
    setEdgeReturn(target) {
      edgeReturn.value = target
    },
    clearEdgeReturn() {
      edgeReturn.value = null
    },
    // Vom „Back"-Knopf aufgerufen: der Graph hoert auf den Zaehler und oeffnet das Panel erneut.
    requestEdgeReturn() {
      if (edgeReturn.value) edgeReturnToken.value++
    },
    // Nur loeschen, wenn wirklich noch DIESE Kante steht: beim Wandern von Kante A nach B feuert
    // As `mouseleave` teils nach Bs `mouseenter` – ohne die Pruefung bliebe gar nichts markiert.
    clearHoveredEdge(id) {
      if (!id || hoveredEdge.value?.id === id) hoveredEdge.value = null
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
