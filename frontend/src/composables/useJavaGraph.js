// Composable fuer die persistierten Klassen-Graph-Kanten (auto + manuell).
// Bewusst getrennt von useJavaAnalyzer: Kanten-Mutationen (Drag-to-Connect, Bearbeiten,
// Loeschen) haben einen eigenen Lebenszyklus und sollen den ohnehin grossen Analyzer-Store
// nicht aufblaehen. HTTP laeuft ausschliesslich ueber lib/api.js (kein fetch in Komponenten).
import { ref, computed } from 'vue'
import { api } from '../lib/api.js'
import { useActivity } from './useActivity.js'

const { trackRun, run: activityRun } = useActivity()

// Module-Singleton -> alle Konsumenten teilen sich denselben Kanten-Zustand.
const edges = ref([])
const loading = ref(false)
const recomputing = ref(false)
// Fortschritt des laufenden Recompute: { done, total } | null. Der erste Lauf nach einem Import
// parst jede Klasse einmal (der Cache im Backend ist dann kalt) und dauert bei einigen tausend
// Klassen Minuten – ein Spinner ohne Zahl ist da nicht von „haengt" zu unterscheiden.
//
// ABGELEITET, nicht eigener Zustand: der Knopf in der Kopfzeile und die Sidebar-Karte zeigen
// denselben Lauf, und zwei Staende desselben Laufs koennen nur auseinanderlaufen. Nur die
// Kantenphase zaehlt hier – 'done' traegt die Kantenzahl, nicht die Klassenzahl, und sie in
// denselben Balken zu kippen waere ein Sprung.
const recomputeProgress = computed(() => {
  const r = activityRun.value
  if (r?.kind !== 'edges' || r.progress?.phase !== 'edges') return null
  return { done: r.progress.done ?? 0, total: r.progress.total ?? 0 }
})
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

// Anker des Hover-Fokus: die rechts geoeffnete Klasse (`c:<fileId>`) – gesetzt NUR, solange der
// gehoverte Knoten ueber mindestens eine gezeichnete Kante an ihr haengt. Dann meint der Hover
// nicht mehr „die Nachbarschaft dieses Knotens", sondern GENAU EINE Verbindung: Ankerkarte,
// gehoverte Karte und die Linien dazwischen bleiben stehen, alles andere faellt weg.
//
// Warum ueberhaupt: wer eine Klasse aufgeschlagen hat, sieht ihre saemtlichen Beziehungen auf
// einmal. Der Hover auf einen Nachbarn beantwortete bis dahin eine ANDERE Frage – er zeigte dessen
// eigene Nachbarschaft und damit ein halbes Dutzend Klassen, die mit der aufgeschlagenen nichts zu
// tun haben. Gefragt ist aber: „was genau verbindet die beiden?"
// Liegt der Hover woanders (keine offene Klasse, kein Bezug zu ihr), bleibt es beim alten
// Verhalten – ohne Anker gibt es keine Verbindung, die man isolieren koennte.
const hoverAnchor = ref(null)

// Identitaetsfarbe je Nachbar des gehoverten Knotens: `Map<nodeId, CSS-Farbe>` | null.
// Ein Hub hat schnell ein Dutzend Nachbarn, und bisher trugen alle Linien dorthin dieselbe
// Art-Farbe (call/uses/import) – welche Linie zu welcher Karte gehoert, war in einem dichten Feld
// nicht mehr abzulesen. Die Karte am Ende einer Linie und die Linie selbst tragen deshalb dieselbe
// Farbe. Berechnet wird sie EINMAL beim Betreten des Knotens (der Graph kennt die Nachbarschaft,
// s. `neighbourPalette` in JavaDependencyGraph) und liegt aus demselben Grund hier wie
// `hoveredNode`: ManagedEdge liest sie selbst, statt dass der Kanten-Store neu geschrieben wird.
const hoverPalette = ref(null)

// Die ANGEKLICKTE Kante: `{ id, sourceId, targetId, color }` | null. Gleiche Form und gleiche
// Wirkung wie `hoveredEdge` – nur bleibt sie stehen, solange ihr Detail in der rechten Spalte
// offen ist. Sie ersetzt das frühere Modal als Ortsangabe: das Detail sagt, WAS die Beziehung
// ist, der Pin sagt, WO im Bild sie liegt. Ohne ihn stünde rechts Code zu einer Linie, die man
// im Kantenfeld nicht mehr wiederfindet.
//
// Gesetzt wird er vom Graphen (er kennt Kanten-Ids, Endpunkte und Farbe), gelöscht beim
// Schliessen des Details oder sobald keiner der beiden Endpunkte mehr gezeichnet wird – ein Pin
// auf zwei unsichtbaren Knoten wuerde SAEMTLICHE Karten daempfen und das Bild leerraeumen.
//
// ZWEI Formen, eine Frage: der Klick auf eine LINIE pinnt genau sie (`id`), der Klick auf eine
// KARTE die ganze Verbindung zweier Knoten (`pair: true`) – und die besteht oft aus mehreren
// Linien in beide Richtungen. `pinCovers` ist die eine Stelle, an der das entschieden wird.
const pinnedEdge = ref(null)

// Ungeordnetes Knotenpaar: eine Verbindung hat keine Richtung, ihre einzelnen Kanten schon.
const samePair = (a1, a2, b1, b2) => (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1)

// Gehoert diese Kante zum Pin? Einzelkante ueber die Vue-Flow-Id, Verbindung ueber das Knotenpaar.
function pinCovers(pin, edgeId, sourceId, targetId) {
  if (!pin) return false
  return pin.pair ? samePair(pin.sourceId, pin.targetId, sourceId, targetId) : pin.id === edgeId
}

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

// --- Kanten-Labels weichen den Karten aus --------------------------------------------------------
// Eine Karte ist der Gegenstand, das Label nur die Beschriftung der Linie dazwischen – deshalb
// liegen Karten ueber den Labels (`.vue-flow__nodes { z-index: 10 }` in style.css). Diese
// Stapelreihenfolge ist aber nur die GARANTIE, dass kein Label eine Karte zudeckt; sie macht ein
// verdecktes Label unlesbar. Der eigentliche Weg ist, dass das Label gar nicht erst unter einer
// Karte landet: der Graph meldet nach jedem Layout die Rechtecke aller gezeichneten Karten
// (Flow-Koordinaten), und jedes Label sucht sich damit den naechstgelegenen freien Platz.
// Ausgewichen wird SENKRECHT, weil dort auch die Linie verlaeuft (Smoothstep, Handles oben/unten):
// das Label rutscht an seiner eigenen Kante entlang und bleibt ihr damit zugeordnet. Horizontal
// waere es ein Kaestchen neben einer fremden Linie.
// Warum ein Raster und keine Liste: ein Ausschnitt hat bis zu 400 Karten und ebenso viele Labels –
// jedes gegen jedes waere je Layout ein sechsstelliges Produkt.
const OBSTACLE_CELL = 200 // px Kantenlaenge einer Rasterzelle (Flow-Koordinaten)
// Weiter als das weicht kein Label aus: was zwei Kartenreihen entfernt steht, liest niemand mehr
// als Beschriftung DIESER Linie. Findet sich darin nichts, bleibt das Label, wo es war.
const LABEL_SHIFT_MAX = 260
let obstacleGrid = new Map()
// Nur eine Version als Ref, nicht die Boxen selbst: die Labels lesen die Rechtecke nie, sie
// brauchen bloss den Anstoss, ihre Position nach einem neuen Layout neu zu rechnen.
const labelObstacleVersion = ref(0)

// boxes: [{ x, y, w, h }] – linke obere Ecke + Groesse, wie Vue Flow die Knoten fuehrt.
function setLabelObstacles(boxes) {
  const grid = new Map()
  for (const b of boxes || []) {
    const cx1 = Math.floor((b.x + b.w) / OBSTACLE_CELL)
    const cy1 = Math.floor((b.y + b.h) / OBSTACLE_CELL)
    for (let cx = Math.floor(b.x / OBSTACLE_CELL); cx <= cx1; cx++) {
      for (let cy = Math.floor(b.y / OBSTACLE_CELL); cy <= cy1; cy++) {
        const key = `${cx}|${cy}`
        const bucket = grid.get(key)
        if (bucket) bucket.push(b)
        else grid.set(key, [b])
      }
    }
  }
  obstacleGrid = grid
  labelObstacleVersion.value++
}

// Naechstgelegenes freies y fuer einen Label-MITTELPUNKT bei (x, y) mit den halben Kantenlaengen
// halfW/halfH. `gap` ist der Mindestabstand zwischen Kartenrand und Labelrand.
function freeLabelY(x, y, halfW, halfH, gap = 6) {
  const left = x - halfW
  const right = x + halfW
  // Verbotene Mittelpunkte auf der y-Achse: jede Karte im senkrechten Korridor sperrt ihre eigene
  // Hoehe plus die halbe Labelhoehe an beiden Enden – an der Intervallgrenze beruehren sich die
  // Raender gerade nicht mehr.
  const blocked = []
  const seen = new Set()
  const cx1 = Math.floor(right / OBSTACLE_CELL)
  const cy1 = Math.floor((y + LABEL_SHIFT_MAX) / OBSTACLE_CELL)
  for (let cx = Math.floor(left / OBSTACLE_CELL); cx <= cx1; cx++) {
    for (let cy = Math.floor((y - LABEL_SHIFT_MAX) / OBSTACLE_CELL); cy <= cy1; cy++) {
      const bucket = obstacleGrid.get(`${cx}|${cy}`)
      if (!bucket) continue
      for (const b of bucket) {
        // Eine Karte liegt in bis zu vier abgefragten Zellen – ohne die Merkliste stuende sie
        // mehrfach in `blocked` (harmlos fuer das Ergebnis, aber unnoetige Arbeit).
        if (seen.has(b)) continue
        seen.add(b)
        if (b.x + b.w <= left || b.x >= right) continue
        blocked.push([b.y - halfH - gap, b.y + b.h + halfH + gap])
      }
    }
  }
  if (!blocked.length) return y
  blocked.sort((a, b) => a[0] - b[0])
  // Ueberlappende Sperren verschmelzen: erst danach ist die GRENZE eines Intervalls garantiert
  // frei – ohne den Schritt landete das Label womoeglich in der naechsten Karte.
  const merged = [[blocked[0][0], blocked[0][1]]]
  for (let i = 1; i < blocked.length; i++) {
    const last = merged[merged.length - 1]
    if (blocked[i][0] <= last[1]) last[1] = Math.max(last[1], blocked[i][1])
    else merged.push([blocked[i][0], blocked[i][1]])
  }
  for (const [a, b] of merged) {
    if (y < a) break // sortiert -> ab hier liegt alles unterhalb des Labels
    if (y <= b) {
      const shifted = y - a <= b - y ? a : b
      // Zu weit ist keine Beschriftung mehr: dann lieber stehen bleiben (die Karte deckt das Label
      // dann teilweise, aber es steht wenigstens an seiner Linie).
      return Math.abs(shifted - y) > LABEL_SHIFT_MAX ? y : shifted
    }
  }
  return y
}

// Der frühere Rueckweg-Apparat (`edgeReturn`/`edgeReturnToken`) ist ersatzlos entfallen: er war
// die Antwort darauf, dass das Kanten-MODAL beim Sprung in den Code zuklappte und die Beziehung
// mitnahm. Seit das Detail in der rechten Spalte steht, bleibt es beim Sprung schlicht geoeffnet
// – der Umschalter „Class · Relation" dort IST der Rueckweg. Zwei Wege dafuer waeren genau die
// Doppelspurigkeit, gegen die der Apparat einmal gebaut wurde.

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
    // Der Fortschritts-Strom laeuft ueber `trackRun` (dasselbe Muster wie Import und Reset, dort
    // begruendet). Reine Zugabe – faellt er aus (Proxy, alter Server), laeuft die Neuberechnung
    // unveraendert weiter, nur ohne Zahlen.
    const res = await trackRun('edges', (jobId) => api.recomputeJavaEdges(jobId), {
      summarize: (r) => `Recomputed ${r?.count ?? 0} edge(s)`,
    })
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
    recomputeProgress,
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
    hoverPalette,
    hoverAnchor,
    // Palette, Anker und Knoten immer zusammen setzen: eine Farbzuordnung ohne den Knoten, zu dem
    // sie gehoert, waere ein Zustand, den niemand mehr aufloest – fuer den Anker gilt dasselbe.
    setHoveredNode(nodeId, palette = null, anchor = null) {
      hoveredNode.value = nodeId
      hoverPalette.value = nodeId ? palette : null
      hoverAnchor.value = nodeId ? anchor : null
    },
    hoveredEdge,
    setHoveredEdge(payload) {
      hoveredEdge.value = payload
    },
    // --- Angeklickte Kante (Detail rechts offen) ----------------------------------------------
    pinnedEdge,
    pinCovers,
    samePair,
    setPinnedEdge(payload) {
      // Referenzgleichheit pruefen: der Graph setzt den Pin aus einem watchEffect ueber dem
      // Layout, und ein unveraenderter Wert wuerde sonst jede Karte und jede Kante ihre Daempfung
      // neu bewerten lassen – bei jedem Layout-Lauf.
      if (pinnedEdge.value !== payload) pinnedEdge.value = payload
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
    // --- Ausweichende Kanten-Labels (Begruendung oben) ----------------------------------------
    labelObstacleVersion,
    setLabelObstacles,
    freeLabelY,
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
