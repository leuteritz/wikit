<script setup>
// Klassen-Abhaengigkeitsgraph (Vue Flow + dagre Auto-Layout).
// Knoten = NUR geladene Klassen (in Imports referenzierte, nicht geladene Klassen werden
// bewusst NICHT als Knoten dargestellt). Kanten = direkte Abhaengigkeiten zwischen geladenen
// Klassen:
//   * Call-Edge ("Methoden-Nutzung"): durchgezogen + Akzentfarbe, Label = aufgerufene
//     Methode(n), KLICKBAR -> oeffnet ein Code-Panel mit dem verwendenden Code (CodeMirror).
//   * Uses-Edge (Struktur-/Typ-Bezug): Variablen-/Feld-/Parameter-/Rueckgabetyp, new X() oder
//     statischer Aufruf ohne Methoden-Treffer -> violett gestrichelt, ohne Label, nicht klickbar.
//     Fallback je Klassenpaar (nur wenn keine Call-Edge existiert).
//   * Import-Edge: gestrichelt + gedaempft, ohne Label, nicht klickbar.
// BEIDE Kantentypen rendern ueber dieselbe Custom-Kante (ManagedEdge): so greift fuer alle
// Kanten derselbe Faecher-Versatz + die Label-Staffelung -> parallele Kanten/Labels zwischen
// denselben Knoten (auch Call vs. Import oder A->B/B->A) ueberlappen nicht mehr.
// Knoten-Akzentfarbe = ROLLE im Abhaengigkeitsnetz (provider/consumer/hub/isolated, Streifen +
// Badge + Ring); das Package steckt nur noch in einem kleinen Farbpunkt. Alles client-seitig aus
// der Dateiliste (props.files enthaelt methods[].body + dependencies[]) -> kein Request, kein
// Backend noetig. Icons via Iconify.
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { Icon } from '../../lib/icons.js'
import JavaEdgeDetailPanel from './JavaEdgeDetailPanel.vue'
import ManualEdgePanel from './ManualEdgePanel.vue'
import ManagedEdge from './ManagedEdge.vue'

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
})
const emit = defineEmits(['select'])

const { theme } = useTheme()
const { fitView, zoomIn, zoomOut, setViewport } = useVueFlow()

// Persistierte Call-/Uses-Edges (auto + manuell) – Quelle der Wahrheit ist das Backend.
// Kanten lassen sich im Graph manuell anlegen (Drag-to-Connect) und löschen (× am Label):
//   * createEdge/deleteEdge laufen ausschließlich über das Composable (HTTP via lib/api.js).
//   * deleteEdge im Backend: manuelle Kante hart löschen, Auto-Kante als Tombstone (dismissed=1)
//     merken -> falsch erkannte Auto-Kanten kehren bei „Kanten neu simulieren" nicht zurück.
const { edges: serverEdges, fetchEdges, createEdge, deleteEdge, highlightedCall, clearHighlightedCall, highlightedDef, clearHighlightedDef } = useJavaGraph()

// Beide Code-Tab-Highlights (Consumer ausgehend / Source eingehend) gemeinsam loeschen -> jeder
// Graph-Klick (Node/Pane) raeumt einen evtl. stehenden Zustand vollstaendig auf.
function clearHighlights() {
  clearHighlightedCall()
  clearHighlightedDef()
}

// Custom-Edge-Typ registrieren.
const edgeTypes = { managed: ManagedEdge }

// Package-Farben (Zusatz-Hues der neuen Palette), rotierend nach Package-Index.
const PKG_COLORS = ['#b3819c', '#7d7bad', '#3f93a0', '#9a8574'] // thistle · lavender · cyan · beige
const NODE_W = 208
const NODE_H = 66
const REVIEW_COLOR = '#b8862f' // warmes Gold (uncertain / „Please review")
const USES_COLOR = '#9a7fb0' // Struktur-/Typ-Bezug (uses): gedaempftes Lavendel, gestrichelt, ohne Label
const DEBUG_EDGES = true // Debug (F12): loggt geladene Klassen + nicht gezeichnete Server-Kanten

// Rollen-Metadaten (Node-Glyph + Legende). Die FARBE kommt ueber die CSS-Klasse `vf-role-<role>`
// (s. <style> / --color-role-* Tokens), hier nur Icon + English-Labels.
const ROLE_META = {
  provider: { icon: 'lucide:box', label: 'Source', hint: 'provides · used by others', legend: 'Source · provides' },
  consumer: { icon: 'lucide:arrow-up-from-line', label: 'Consumer', hint: 'uses other classes', legend: 'Consumer · uses' },
  hub: { icon: 'lucide:git-fork', label: 'Hub', hint: 'provides & uses', legend: 'Hub · both' },
  isolated: { icon: 'lucide:unlink', label: 'Isolated', hint: 'no connections', legend: 'Isolated · none' },
}
const ROLE_ORDER = ['provider', 'consumer', 'hub', 'isolated']

// Legende: einklappbar und standardmaessig ZU. Permanent sichtbar hat sie ein Viertel des
// Canvas verdeckt; als Popover bleibt sie einen Klick entfernt. Zustand ueberlebt den Reload.
const LEGEND_KEY = 'wikit:graph-legend-open'
const legendOpen = ref(false)
try {
  legendOpen.value = localStorage.getItem(LEGEND_KEY) === '1'
} catch {
  /* localStorage nicht verfuegbar -> zu */
}
function toggleLegend() {
  legendOpen.value = !legendOpen.value
  try {
    localStorage.setItem(LEGEND_KEY, legendOpen.value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

const simpleName = (fqn) => String(fqn).split('.').pop()

// Methodensignatur fuers Edge-Panel: `return_type name(type name, …)` (parameters sind geparst).
const buildSignature = (m) => {
  const params = (m.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ')
  return `${m.return_type || 'void'} ${m.method_name}(${params})`
}

// Datei-Lookups (id -> file, class_name -> file).
const filesById = computed(() => {
  const m = new Map()
  for (const f of props.files || []) m.set(f.id, f)
  return m
})

// Kanten initial laden + bei jeder Aenderung der Dateiliste neu ziehen (das Backend rechnet
// die Auto-Kanten bei Analyse/Loeschen neu -> Graph bleibt ohne Reload konsistent).
onMounted(fetchEdges)
watch(
  () => (props.files || []).map((f) => f.id).join(','),
  () => fetchEdges(),
)

const layout = computed(() => {
  const files = props.files || []
  const known = new Map() // class_name -> file
  for (const f of files) known.set(f.class_name, f)

  // Package -> Farbindex (stabil sortiert).
  const pkgs = [...new Set(files.map((f) => f.package || '(default)'))].sort()
  const pkgColor = new Map(pkgs.map((p, i) => [p, PKG_COLORS[i % PKG_COLORS.length]]))

  // --- Kanten zwischen geladenen Klassen bestimmen ---
  const edges = []
  const callPairs = new Set()
  const skipped = [] // Debug: Server-Kanten, die NICHT gezeichnet werden (Endpunkt nicht geladen)
  // Distinkte, referenzierte-aber-nicht-geladene Klassen (Kante hat nur EINEN geladenen Endpunkt).
  // Speist den Legenden-Hinweis „N external classes hidden" -> macht die stille Filterung sichtbar.
  const externalRefs = new Set()

  // 1) Persistierte Call-/Uses-Edges aus dem Backend (auto + manuell). source_class = Aufrufer (A),
  //    target_class = definierende Klasse (B). Pfeilrichtung im Graph bleibt „Definition ->
  //    Nutzung": Graph-Quelle = B, Graph-Ziel (Pfeilspitze) = A. Nur Kanten rendern, deren
  //    beide Endpunkte geladen sind.
  //
  //    BUENDELUNG: Mehrere Call-Edges zwischen DEMSELBEN Klassenpaar (verschiedene method_name)
  //    werden zu EINER Graph-Kante zusammengefasst (Label „n Methoden", Verwaltung pro Methode im
  //    Panel) -> kein visuelles Chaos mehr bei vielen genutzten Methoden. Uses-Edges bleiben
  //    weiterhin einzeln (sie haben ohnehin kein Label und sind reiner Typ-Fallback).
  //
  //    STATISCH vs. INSTANZ (Ticket 2b/2c): bewusst NICHT umgesetzt. serverEdges (Entity
  //    backend/src/entities/java-edge.entity.ts) traegt KEIN is_static-Flag, und der Parser
  //    (backend/src/common/java-parser.ts) erfasst keine Methoden-Modifier. Ergaenzungspfad fuer
  //    spaeter: (1) Parser Modifier lesen; (2) Spalte is_static in schema.ts + java-method/
  //    java-edge-Entity; (3) SerializerService + Edge-Berechnung durchreichen; (4) hier dann je
  //    Methode strokeDasharray:'2 3', Akzent 70% Opacity, markerEnd.type = MarkerType.Arrow (hohl)
  //    statt ArrowClosed + Legendeneintrag. Bis dahin: Visualisierung + Legende unveraendert.
  const callGroups = new Map() // `${callerId}->${definerId}` -> { callerFile, definerFile, methods: [] }
  for (const e of serverEdges.value || []) {
    const callerFile = known.get(e.source_class) // A
    const definerFile = known.get(e.target_class) // B
    if (!callerFile || !definerFile || callerFile.id === definerFile.id) {
      // Genau ein Endpunkt fehlt -> die andere Klasse ist „extern" (nicht geladen).
      if (!callerFile && definerFile) externalRefs.add(e.source_class)
      if (callerFile && !definerFile) externalRefs.add(e.target_class)
      if (DEBUG_EDGES)
        skipped.push({
          source: e.source_class,
          target: e.target_class,
          kind: e.kind,
          method: e.method_name,
          reason: !callerFile ? 'Quellklasse nicht geladen' : !definerFile ? 'Zielklasse nicht geladen' : 'Self-Edge',
        })
      continue
    }
    const pairKey = `${callerFile.id}->${definerFile.id}`
    callPairs.add(pairKey)

    // uses-Kante = struktureller Typ-Bezug (Variablen-/Feld-/Parameter-/Rueckgabetyp, new X(),
    // statischer Aufruf ohne Methoden-Treffer): eigener Stil, kein Label, nicht klickbar, einzeln.
    if (e.kind === 'uses') {
      edges.push({
        id: `edge:${e.id}`,
        source: `c:${definerFile.id}`,
        target: `c:${callerFile.id}`,
        type: 'managed',
        markerEnd: { type: MarkerType.ArrowClosed, color: USES_COLOR },
        data: {
          kind: 'uses',
          edgeStyle: { stroke: USES_COLOR, strokeWidth: 1.5, strokeDasharray: '4 3', cursor: 'default' },
        },
      })
      continue
    }

    // call-Kante -> nach Klassenpaar gruppieren.
    if (!callGroups.has(pairKey)) callGroups.set(pairKey, { callerFile, definerFile, methods: [] })
    callGroups.get(pairKey).methods.push({
      edgeId: e.id,
      method: e.method_name,
      isManual: !!e.is_manual,
      confidence: e.confidence,
      needsReview: !e.is_manual && e.confidence < 1,
    })
  }

  // 1b) Je Klassenpaar EINE gebuendelte Call-Kante. Inline-Quick-Actions (Bearbeiten/Loeschen am
  //     Label) + Rechtsklick gibt es nur fuer Einzel-Methoden-Kanten; Buendel werden ueber das
  //     Detail-Panel verwaltet (onOpen ist immer gesetzt).
  for (const { callerFile, definerFile, methods } of callGroups.values()) {
    const single = methods.length === 1
    const allManual = methods.every((m) => m.isManual)
    const needsReview = methods.some((m) => m.needsReview)
    const stroke = needsReview ? REVIEW_COLOR : 'var(--color-accent)'
    edges.push({
      id: `call:${definerFile.id}-${callerFile.id}`,
      source: `c:${definerFile.id}`,
      target: `c:${callerFile.id}`,
      type: 'managed',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        kind: 'call',
        methods, // [{ edgeId, method, isManual, confidence, needsReview }]
        bundleCount: methods.length,
        method: methods[0].method, // Back-compat (Einzel-Kante: Label/Context-Menu/Editor)
        edgeId: single ? methods[0].edgeId : null,
        isManual: allManual,
        needsReview,
        fromClass: callerFile.class_name, // Aufrufer A
        toClass: definerFile.class_name, // Definition B
        fromFileId: callerFile.id,
        toFileId: definerFile.id,
        edgeStyle: {
          stroke,
          strokeWidth: 2,
          strokeDasharray: allManual ? '6 4' : undefined,
          cursor: 'pointer',
        },
        onOpen: openEdgePanel,
        onDelete: onDeleteEdge,
      },
    })
  }

  // 2) Interne Import-Kanten (nur, wenn nicht bereits Call-Kante; nur geladene Ziele).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      const target = known.get(simpleName(dep))
      if (!target) {
        externalRefs.add(simpleName(dep)) // importierte Klasse nicht geladen -> extern, ausgeblendet
        continue
      }
      if (target.id === f.id) continue
      if (callPairs.has(`${f.id}->${target.id}`)) continue
      callPairs.add(`${f.id}->${target.id}`)
      edges.push({
        id: `imp:${f.id}-${target.id}`,
        // Einheitlicher „Definition -> Nutzung"-Fluss: importierte Klasse = Quelle,
        // importierende Klasse = Ziel (Pfeilspitze). Ueber ManagedEdge gerendert -> faechert
        // mit, hat aber kein Label und ist nicht klickbar (kind: 'import').
        source: `c:${target.id}`,
        target: `c:${f.id}`,
        type: 'managed',
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-text-muted)' },
        data: {
          kind: 'import',
          edgeStyle: { stroke: 'var(--color-text-muted)', strokeWidth: 1.5, strokeDasharray: '5 4' },
        },
      })
    }
  }

  // Parallele Kanten desselben (UNGEORDNETEN) Knotenpaars indizieren -> ManagedEdge faechert
  // sie per Versatz auf und staffelt die Labels. ALLE Kanten zaehlen mit (Call + Import, beide
  // Richtungen ueber den sortierten Key), sonst koennen Call vs. Import oder A->B/B->A
  // deckungsgleich uebereinanderliegen.
  const pairGroups = new Map()
  for (const e of edges) {
    const key = [e.source, e.target].slice().sort().join('|')
    if (!pairGroups.has(key)) pairGroups.set(key, [])
    pairGroups.get(key).push(e)
  }
  for (const group of pairGroups.values()) {
    group.forEach((e, i) => {
      e.data = e.data || {}
      e.data.parallelIndex = i
      e.data.parallelCount = group.length
      // Gegenrichtungen erhalten ein stabiles Vorzeichen (konsistente Faecher-Seite).
      e.data.direction = e.source < e.target ? 1 : -1
    })
  }

  // --- Rolle je Knoten im Abhaengigkeitsnetz -----------------------------------
  // Kanten fliessen konsistent „Definition -> Nutzung": e.source = Provider/Definition-Seite,
  // e.target = Anwender/Consumer-Seite. Daraus die Rolle jeder geladenen Klasse ableiten:
  //   * provider – kommt nur als Quelle vor (wird genutzt, nutzt selbst keine geladene Klasse)
  //   * consumer – kommt nur als Ziel vor (nutzt andere, wird selbst nicht referenziert)
  //   * hub      – beides (Standard-Fall)
  //   * isolated – keine Kante (keine Verbindung zu einer anderen geladenen Klasse)
  const sourceNodeIds = new Set(edges.map((e) => e.source)) // Definition/Provider-Seite
  const targetNodeIds = new Set(edges.map((e) => e.target)) // Anwender/Consumer-Seite
  const roleFor = (nid) => {
    const isSrc = sourceNodeIds.has(nid)
    const isTgt = targetNodeIds.has(nid)
    return isSrc && isTgt ? 'hub' : isSrc ? 'provider' : isTgt ? 'consumer' : 'isolated'
  }

  // --- dagre-Auto-Layout ---
  // Groessere nodesep/ranksep als zuvor -> mehr Luft zwischen Knoten, damit Node-Labels (und
  // die aufgefaecherten Kanten/Kanten-Labels) bei dicht liegenden Klassen nicht kollidieren.
  // Verbindungslose Klassen aus dagre HERAUSHALTEN: dagre legt sie sonst als eine einzige,
  // endlos breite Reihe ab -> der Graph zoomt auf Briefmarkengroesse und der Canvas bleibt
  // vertikal leer. Sie bekommen weiter unten ein eigenes, kompaktes Raster.
  const degree = new Map()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1)
    degree.set(e.target, (degree.get(e.target) || 0) + 1)
  }

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 90, ranksep: 110, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  const orphans = []
  for (const f of files) {
    const id = `c:${f.id}`
    if (degree.get(id)) g.setNode(id, { width: NODE_W, height: NODE_H })
    else orphans.push(id)
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  }
  // Ohne Knoten kein Layout: dagre setzt die Graph-Groesse dann auf -Infinity (Maximum ueber
  // eine leere Menge). Das ist truthy und wuerde die Orphan-Koordinaten unten unbrauchbar machen.
  if (g.nodeCount()) dagre.layout(g)

  // Raster der verbindungslosen Klassen: annaehernd quadratisch, unter dem verbundenen Graph
  // zentriert (bzw. ab 0/0, wenn es gar keine Kanten gibt). Koordinaten wie bei dagre = Mitte.
  const orphanPos = new Map()
  if (orphans.length) {
    const COL_STEP = NODE_W + 60
    const ROW_STEP = NODE_H + 48
    const finite = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
    const gw = finite(g.graph().width)
    const gh = finite(g.graph().height)
    const cols = Math.max(1, Math.ceil(Math.sqrt(orphans.length)))
    const originX = gw ? (gw - (cols * COL_STEP - 60)) / 2 : 0
    const originY = gh ? gh + ROW_STEP : 0
    orphans.forEach((id, i) => {
      orphanPos.set(id, {
        x: originX + (i % cols) * COL_STEP + NODE_W / 2,
        y: originY + Math.floor(i / cols) * ROW_STEP + NODE_H / 2,
      })
    })
  }

  const nodes = files.map((f) => {
    const pkg = f.package || '(default)'
    const id = `c:${f.id}`
    const nd = g.hasNode(id) ? g.node(id) : orphanPos.get(id)
    return {
      id,
      type: 'klass',
      // dagre (bzw. das Orphan-Raster) liefert die Mitte -> Vue Flow erwartet die obere linke Ecke.
      // Nicht-endliche Werte hart abfangen: eine einzige NaN-Position macht fitView() und damit
      // den kompletten Viewport (inkl. Background-Pattern) unbrauchbar.
      position: {
        x: (Number.isFinite(nd?.x) ? nd.x : 0) - NODE_W / 2,
        y: (Number.isFinite(nd?.y) ? nd.y : 0) - NODE_H / 2,
      },
      data: {
        fileId: f.id,
        className: f.class_name,
        pkg,
        methodCount: (f.methods || []).length,
        color: pkgColor.get(pkg),
        role: roleFor(id),
        analyzed: !!(f.description && f.description.trim()),
        version: f.version ?? 1,
      },
    }
  })

  if (DEBUG_EDGES) {
    console.debug(
      '[java-edges] geladene Klassen:',
      [...known.keys()],
      '| Server-Kanten:',
      (serverEdges.value || []).length,
      '| gezeichnet:',
      edges.length,
      '| uebersprungen:',
      skipped.length,
    )
    if (skipped.length) console.debug('[java-edges] nicht gezeichnete Kanten:', skipped)
  }

  return { nodes, edges, externalRefsHidden: externalRefs.size }
})

const nodes = computed(() => layout.value.nodes)
// Anzahl referenzierter, aber nicht geladener Klassen (fuer den Legenden-Hinweis).
const externalRefsHidden = computed(() => layout.value.externalRefsHidden)
// Reine Projektion: das pure `layout` bleibt unberuehrt; nur hier wird die aktuell „aufleuchtende"
// Call-Edge (highlightedCall aus dem Code-Tab) markiert -> Glow-Klasse + Edge-Highlight-Farbe.
const edges = computed(() => {
  const hc = highlightedCall.value
  const hd = highlightedDef.value
  return layout.value.edges.map((e) => {
    const d = e.data || {}
    // Consumer-Seite (ausgehend): geklickte Aufruf-Kante des Aufrufers.
    const match =
      hc && d.kind === 'call' && d.fromFileId === hc.callerFileId && (d.methods || []).some((m) => m.method === hc.method)
    // Source-Seite (eingehend): Kanten, die genau die geklickte Definition dieser Klasse nutzen.
    const matchIn =
      hd && d.kind === 'call' && d.toFileId === hd.definerFileId && (d.methods || []).some((m) => m.method === hd.method)
    // `class` MUSS auf JEDER Kante gesetzt sein: Vue Flow merged eingehende Kanten per
    // Object.assign auf die bestehende GraphEdge (parseEdge). Fehlt der `class`-Key, bleibt ein
    // zuvor gesetztes 'edge-lit' haengen -> die Kante leuchtet weiter, auch nach dem Deselektieren.
    // Darum explizit '' statt den Key wegzulassen (erzwingt das Ueberschreiben).
    if (!match && !matchIn) return { ...e, class: '' }
    return {
      ...e,
      class: 'edge-lit',
      data: {
        ...d,
        isHighlighted: true,
        edgeStyle: { ...d.edgeStyle, stroke: 'var(--color-edge-highlight)', strokeWidth: (d.edgeStyle?.strokeWidth || 2) + 0.75 },
      },
    }
  })
})

// Canvas-Raster: ein einzelnes Linienraster, das mit dem Viewport wandert und beim Pannen
// Orientierung gibt. Deckkraft so gewaehlt, dass es als Gefuege lesbar bleibt, ohne mit den
// Knoten zu konkurrieren. Feste rgba-Werte statt color-mix: die Farbe landet als SVG-Attribut,
// nicht als CSS-Property.
const gridLineColor = computed(() => (theme.value === 'dark' ? 'rgba(196,186,143,0.065)' : 'rgba(133,126,97,0.09)'))

function onNodeClick({ node }) {
  // Klick in den Graph (Node) -> transiente Code-Tab-Highlights verwerfen (Spec: „Node ohne Kante").
  clearHighlights()
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
function resetView() {
  setViewport({ x: 0, y: 0, zoom: 1 })
}

// `fit-view-on-init` greift ins Leere: die Knoten kommen erst mit dem async fetchFiles() an,
// der Graph montiert vorher – und die Kanten (fetchEdges) sogar noch einmal spaeter, was das
// dagre-Layout ein zweites Mal umstellt. Deshalb auf die tatsaechliche GEOMETRIE hoeren, nicht
// nur auf die Knoten-IDs: sonst bleibt nach dem Kanten-Nachladen die halbe Hierarchie ausserhalb
// des sichtbaren Bereichs. `layout` haengt allein an files/serverEdges -> die Signatur aendert
// sich nur, wenn wirklich neu gelayoutet wurde, nicht bei jeder Auswahl.
watch(
  () => nodes.value.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join('|'),
  async (sig) => {
    if (!sig) return
    await nextTick()
    // maxZoom 1: einzelne Knoten sollen nicht auf Plakatgroesse aufgeblasen werden.
    fitView({ padding: 0.18, maxZoom: 1, duration: 200 })
  },
)

// --- Edge-Detail-Panel fuer angeklickte Auto-Call-Edges -----------------------
// Die Call-Sites werden erst beim Klick fuer das konkrete Klassenpaar + Methode berechnet
// (rein zur Anzeige; die Existenz der Kante kommt aus dem Backend). Manuelle Kanten haben
// keinen verifizierbaren Quellcode -> oeffnen das Panel nicht.
const activeEdge = ref(null)

// Baut die Panel-Daten fuer eine (ggf. gebuendelte) Call-Kante. `methods` = Array von
// { edgeId, method, isManual } -> Aufrufstellen werden ueber ALLE Methoden gesammelt; das Panel
// listet jede Methode (mit Signatur + edgeId fuer Per-Methoden-Aktionen).
function computeCallEdgeData(callerFile, definerFile, methods, edgeMeta = {}) {
  const list = (methods || []).filter((m) => m && m.method)
  const callSites = []
  const panelMethods = []
  for (const meta of list) {
    const methodName = meta.method
    for (const ca of callerFile.methods || []) {
      const body = ca.body || ''
      if (!body) continue
      const base = ca.body_start_line ?? ca.start_line ?? null
      const lineExact = ca.body_start_line != null
      const safe = String(methodName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`\\b${safe}\\s*\\(`, 'g')
      let m
      while ((m = re.exec(body)) !== null) {
        const relLine = (body.slice(0, m.index).match(/\n/g) || []).length
        callSites.push({
          callerMethod: ca.method_name,
          calleeMethod: methodName,
          callerBody: body,
          bodyStartLine: base,
          line: base != null ? base + relLine : relLine + 1,
          lineExact,
        })
      }
    }
    const ce = (definerFile.methods || []).find((mm) => mm.method_name === methodName)
    panelMethods.push({
      edgeId: meta.edgeId ?? null,
      name: methodName,
      signature: ce ? buildSignature(ce) : '',
      isManual: !!meta.isManual,
    })
  }
  const single = panelMethods.length === 1
  return {
    kind: 'call',
    bundleCount: panelMethods.length,
    // Pro-Methoden-Liste (Panel-Anzeige + Per-Methoden-Aktionen/Footer-Loeschen).
    methods: panelMethods,
    // Kanten-Metadaten fuer die Footer-Aktionen (Bearbeiten/Loeschen) im Modal – nur bei Einzelkante.
    edgeId: single ? panelMethods[0].edgeId : null,
    method: single ? panelMethods[0].name : null,
    isManual: !!edgeMeta.isManual,
    fromClass: callerFile.class_name,
    toClass: definerFile.class_name,
    fromFileId: callerFile.id,
    toFileId: definerFile.id,
    callSites,
    // Back-compat-Felder (alte Panel-Bindungen).
    callees: panelMethods.map((p) => p.name),
    calleeSignatures: panelMethods.map((p) => ({ name: p.name, signature: p.signature })),
  }
}

// Gemeinsame Oeffnen-Logik fuer beide Pfade: Klick auf den SVG-Pfad (@edge-click) UND Klick auf
// das Kanten-Label (data.onOpen in ManagedEdge). In try/catch gekapselt, damit ein Fehler im
// Browser-Log sichtbar wird statt lautlos zu scheitern.
function openEdgePanel(d) {
  try {
    // Auto- UND manuelle Call-Kanten oeffnen das Modal (manuelle haben ggf. keine verifizierten
    // Aufrufstellen -> der Verwendung-Abschnitt zeigt dann einen leeren Zustand).
    if (!d || d.kind !== 'call') return
    // Gebuendelte Kante traegt d.methods; Einzel-Fallback aus d.method (z. B. Modal-Edit-Reopen).
    const methodList = d.methods?.length
      ? d.methods
      : d.method
        ? [{ edgeId: d.edgeId, method: d.method, isManual: d.isManual }]
        : []
    if (!methodList.length) return
    const callerFile = filesById.value.get(d.fromFileId)
    const definerFile = filesById.value.get(d.toFileId)
    if (!callerFile || !definerFile) {
      console.warn('[JavaGraph] Edge-Panel: Klasse(n) nicht in der Dateiliste gefunden', d)
      return
    }
    activeEdge.value = computeCallEdgeData(callerFile, definerFile, methodList, {
      isManual: d.isManual,
    })
  } catch (e) {
    console.warn('[JavaGraph] Edge-Panel konnte nicht geöffnet werden', d, e)
  }
}

function onEdgeClick({ edge }) {
  openEdgePanel(edge?.data)
}
function closeEdgePanel() {
  activeEdge.value = null
}

// --- Kante löschen (× am Label / Detail-Panel) -------------------------------
// edgeId = java_edges.id. Backend tombstoned Auto-Kanten (kein Wiederauftauchen),
// löscht manuelle hart. Danach refetcht das Composable -> layout rechnet neu.
async function onDeleteEdge(edgeId) {
  if (edgeId == null) return
  try {
    await deleteEdge(edgeId)
  } catch (e) {
    console.warn('[JavaGraph] Kante konnte nicht gelöscht werden', edgeId, e)
    return
  }
  // Offenes Detail-Panel an die neu geladenen Kanten anpassen (gelöschte Methode raus).
  if (activeEdge.value) refreshActiveEdge()
}

// Methoden des offenen Detail-Panels gegen die aktuell geladenen Server-Kanten abgleichen;
// keine mehr übrig -> Panel schließen.
function refreshActiveEdge() {
  const ae = activeEdge.value
  if (!ae) return
  const liveIds = new Set((serverEdges.value || []).map((e) => e.id))
  const methods = (ae.methods || []).filter((m) => m.edgeId == null || liveIds.has(m.edgeId))
  if (!methods.length) {
    activeEdge.value = null
    return
  }
  activeEdge.value = { ...ae, methods }
}

// --- Manuelle Kante anlegen (Drag-to-Connect -> Slide-over) -------------------
// Vue Flow liefert Node-IDs (`c:<fileId>`). Quelle = unteres Handle (Definition), Ziel =
// oberes Handle (Anwender) – gleiche „Definition -> Nutzung"-Richtung wie der Graph-Pfeil.
const pendingConnection = ref(null) // { sourceFile (Definition), targetFile (Anwender) }

function fileFromNodeId(nodeId) {
  const id = Number(String(nodeId).replace(/^c:/, ''))
  return filesById.value.get(id) || null
}

function onConnect(conn) {
  if (!conn || conn.source === conn.target) return
  const sourceFile = fileFromNodeId(conn.source) // Definition (oben)
  const targetFile = fileFromNodeId(conn.target) // Anwender (unten)
  if (!sourceFile || !targetFile) return
  pendingConnection.value = { sourceFile, targetFile }
}

function onSwapConnection() {
  const c = pendingConnection.value
  if (!c) return
  pendingConnection.value = { sourceFile: c.targetFile, targetFile: c.sourceFile }
}

function closeManualPanel() {
  pendingConnection.value = null
}

// Speichern: source_class = Aufrufer (Anwender, unten), target_class = Definition (oben),
// method_name = gewählte Methode der Definitionsklasse. Composable persistiert (is_manual=1)
// und refetcht -> neue gestrichelte Kante erscheint.
async function onSaveManualEdge({ methodName }) {
  const c = pendingConnection.value
  if (!c) return
  closeManualPanel()
  try {
    await createEdge({
      source: c.targetFile.class_name,
      target: c.sourceFile.class_name,
      methodName: methodName || undefined,
    })
  } catch (e) {
    console.warn('[JavaGraph] Manuelle Kante konnte nicht angelegt werden', e)
  }
}

// Komplett-Reset im Code-Tab (files -> []): VueFlow selbst wird via v-else unmountet (interner
// Node/Edge-Store verworfen), aber das geteleportete Edge-Panel haengt am <body> -> hier aktiv
// schliessen, sonst bleibt es offen stehen.
watch(
  () => (props.files || []).length,
  (n) => {
    if (!n) {
      activeEdge.value = null
      pendingConnection.value = null
    }
  },
)
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
  >
    <div v-if="!files.length" class="absolute inset-0 grid place-items-center px-6 text-center">
      <div class="max-w-xs">
        <span class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[var(--color-surface-offset)] text-[var(--color-text-muted)]">
          <Icon icon="lucide:git-fork" class="h-6 w-6" />
        </span>
        <p class="mb-1 text-sm font-semibold text-[var(--color-text)]">Nothing to graph yet</p>
        <p class="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Add <code class="rounded bg-[var(--color-surface-offset)] px-1 py-0.5 font-mono">.java</code> sources with
          <span class="font-semibold text-[var(--color-text)]">Add code</span> – classes and their call edges appear here.
        </p>
      </div>
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      :edge-types="edgeTypes"
      fit-view-on-init
      :min-zoom="0.2"
      :max-zoom="2"
      :default-edge-options="{ type: 'managed' }"
      :nodes-connectable="true"
      :edges-updatable="false"
      @node-click="onNodeClick"
      @edge-click="onEdgeClick"
      @pane-click="clearHighlights"
      @connect="onConnect"
    >
      <!-- Custom Node: kompaktes Card-Design, Akzentfarbe nach ROLLE (Streifen/Badge/Ring);
           Package steckt nur noch im kleinen .vf-pkgdot vor dem Package-Text. -->
      <template #node-klass="{ data }">
        <div
          class="vf-card"
          :class="[`vf-role-${data.role}`, { 'vf-card--selected': selectedId === data.fileId }]"
          :style="{ '--pkg': data.color }"
        >
          <Handle type="target" :position="Position.Top" class="vf-handle" />
          <span class="vf-strip" />
          <div class="vf-body">
            <div class="vf-name">
              <Icon
                :icon="ROLE_META[data.role].icon"
                class="vf-role-glyph"
                :title="`${ROLE_META[data.role].label} — ${ROLE_META[data.role].hint}`"
                :aria-label="ROLE_META[data.role].label"
              />
              <Icon v-if="data.analyzed" icon="lucide:sparkles" class="vf-ai" title="AI-analyzed" />{{ data.className }}
            </div>
            <div class="vf-pkg">
              <span class="vf-pkgdot" :title="data.pkg" />{{ data.pkg }}
            </div>
          </div>
          <span
            class="vf-version"
            :class="{ 'vf-version--multi': data.version > 1 }"
            :title="`Version ${data.version}`"
          >v{{ data.version }}</span>
          <span class="vf-badge" title="Methods">{{ data.methodCount }}</span>
          <Handle type="source" :position="Position.Bottom" class="vf-handle" />
        </div>
      </template>

      <Background variant="lines" :gap="110" :line-width="1" :color="gridLineColor" />
    </VueFlow>

    <!-- Canvas-Chrome unten: Werkzeuge links, Legende rechts. Beide schweben am unteren Rand,
         damit die obere Canvas-Haelfte (wo dagre die Wurzelknoten setzt) frei bleibt. -->
    <div v-if="files.length" class="vf-dock vf-dock--left">
      <button type="button" class="vf-tool" title="Zoom in" @click="zoomIn()">
        <Icon icon="lucide:zoom-in" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" title="Zoom out" @click="zoomOut()">
        <Icon icon="lucide:zoom-out" class="h-4 w-4" />
      </button>
      <span class="vf-dock-sep" />
      <button type="button" class="vf-tool" title="Fit to view" @click="fitView()">
        <Icon icon="lucide:maximize" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" title="Reset view" @click="resetView">
        <Icon icon="lucide:rotate-ccw" class="h-4 w-4" />
      </button>
    </div>

    <!-- Legende: Toggle-Pille; das Panel klappt darueber auf (Default zu). -->
    <div v-if="files.length" class="absolute bottom-3 right-3 flex flex-col items-end gap-2">
      <Transition name="legend">
        <div v-if="legendOpen" class="vf-legend">
          <div class="legend-head">Nodes · role</div>
          <div v-for="role in ROLE_ORDER" :key="role" class="legend-row">
            <span class="legend-node-swatch" :style="{ background: `var(--color-role-${role})` }" />
            <Icon :icon="ROLE_META[role].icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: `var(--color-role-${role})` }" />
            <span>{{ ROLE_META[role].legend }}</span>
          </div>

          <div class="legend-head mt-1.5">Edges</div>
          <div class="legend-row">
            <span class="legend-line" style="background: var(--color-accent)" />
            <span>calls · clickable</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dashed" style="color: var(--color-accent)" />
            <span>manual edge</span>
          </div>
          <div class="legend-row">
            <span class="legend-line" style="background: #b8862f" />
            <span>uncertain · “Please review”</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dashed" style="color: var(--color-text-muted)" />
            <span>imported by</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dashed" style="color: #9a7fb0" />
            <span>uses type (variable/new)</span>
          </div>

          <div class="legend-head mt-1.5">Badges</div>
          <div class="legend-row">
            <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span>AI-analyzed</span>
          </div>
          <div class="legend-row">
            <span class="legend-version">v2</span>
            <span>version · history</span>
          </div>

          <!-- One-sided Kanten sind bereits ausgeblendet (nur geladene Klassen sind Knoten) – hier sichtbar machen. -->
          <div v-if="externalRefsHidden" class="legend-note">
            <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
            <span>{{ externalRefsHidden }} external {{ externalRefsHidden === 1 ? 'class' : 'classes' }} hidden (not loaded)</span>
          </div>
        </div>
      </Transition>

      <button type="button" class="vf-dock vf-legend-toggle" :class="{ 'is-open': legendOpen }" @click="toggleLegend">
        <Icon icon="lucide:info" class="h-4 w-4" />
        <span>Legend</span>
        <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5 opacity-60 transition-transform" :class="legendOpen ? '' : 'rotate-180'" />
      </button>
    </div>

    <!-- Edge-Detail-Modal: Ansicht Definition -> Nutzung; löscht Kanten pro Methode (ESC schliesst) -->
    <JavaEdgeDetailPanel
      :edge="activeEdge"
      :visible="!!activeEdge"
      @close="closeEdgePanel"
      @delete-edge="onDeleteEdge"
    />

    <!-- Slide-over: manuelle Kante anlegen (ausgelöst durch Drag-to-Connect) -->
    <ManualEdgePanel
      :visible="!!pendingConnection"
      :source-file="pendingConnection?.sourceFile || null"
      :target-file="pendingConnection?.targetFile || null"
      @save="onSaveManualEdge"
      @swap="onSwapConnection"
      @close="closeManualPanel"
    />
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

.vf-card {
  /* Karten-Akzent = ROLLE im Abhaengigkeitsnetz (Streifen, Badge, Ring). Package steckt nur noch
     im kleinen .vf-pkgdot. --role wird per .vf-role-<role>-Klasse gesetzt (Default: isoliert). */
  --role: var(--color-role-isolated);
  display: flex;
  align-items: center;
  gap: 8px;
  width: 208px;
  padding: 8px 10px 8px 0;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--role) 22%, transparent);
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.vf-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--role) 32%, transparent);
}
.vf-card--selected {
  border-color: var(--role);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--role) 35%, transparent), 0 6px 16px color-mix(in srgb, var(--role) 30%, transparent);
}
/* Rollen-Farbe (Tokens in assets/style.css, theme-faehig). */
.vf-role-provider { --role: var(--color-role-provider); }
.vf-role-consumer { --role: var(--color-role-consumer); }
.vf-role-hub { --role: var(--color-role-hub); }
.vf-role-isolated { --role: var(--color-role-isolated); }
/* Isolierte Knoten treten optisch zurueck (gedaempft), damit Provider/Hubs hervorstechen. */
.vf-role-isolated {
  opacity: 0.72;
}
.vf-role-isolated:hover {
  opacity: 1;
}
.vf-strip {
  width: 4px;
  align-self: stretch;
  border-radius: 12px 0 0 12px;
  background: var(--role);
}
/* Isolierter Knoten: Streifen als Hinweis „keine Verbindung" gestrichelt statt voll. */
.vf-role-isolated .vf-strip {
  background: repeating-linear-gradient(var(--role) 0 3px, transparent 3px 6px);
}
/* Rollen-Glyph vor dem Klassennamen (Icon in Rollenfarbe). */
.vf-role-glyph {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  color: var(--role);
}
/* Kleiner Package-Punkt vor dem Package-Text (Package-Identitaet, sekundaer). Inline-block, damit
   das text-overflow:ellipsis des Package-Texts erhalten bleibt. */
.vf-pkgdot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 999px;
  vertical-align: middle;
  background: var(--pkg);
}
.vf-body {
  min-width: 0;
  flex: 1;
}
.vf-name {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
}
.vf-ai {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  color: var(--color-accent);
}
.vf-pkg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--color-text-muted);
}
.vf-badge {
  flex-shrink: 0;
  min-width: 22px;
  padding: 1px 6px;
  border-radius: 999px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--role);
}
/* Versions-Chip (Changelog): sekundaer/outlined -> klar abgesetzt von der gefuellten
   Methoden-Pille. Ab v2 in Akzentfarbe, um „hat Historie" hervorzuheben. */
.vf-version {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}
.vf-version--multi {
  color: var(--color-accent);
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: var(--color-accent-soft);
}
/* --- Schwebendes Canvas-Chrome (Werkzeuge + Legende) ---------------------- *
 * Eine gemeinsame „Dock"-Optik: abgerundete Glas-Pille am unteren Canvas-Rand. */
.vf-dock {
  position: absolute;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-surface-2) 88%, transparent);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.08);
  backdrop-filter: blur(8px);
}
.vf-dock--left {
  left: 12px;
}
.vf-dock-sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--color-border);
}
/* Legenden-Toggle: gleiche Pille, aber mit Beschriftung. */
.vf-legend-toggle {
  position: static;
  gap: 6px;
  padding: 5px 9px 5px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  transition: color 0.15s ease, border-color 0.15s ease;
}
.vf-legend-toggle:hover,
.vf-legend-toggle.is-open {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}
/* Legenden-Panel: gleiche Materialsprache, scrollt bei sehr flachem Canvas. */
.vf-legend {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: min(420px, 60vh);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-surface-2) 92%, transparent);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  backdrop-filter: blur(8px);
  font-size: 12px;
}
.legend-enter-active,
.legend-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
  transform-origin: bottom right;
}
.legend-enter-from,
.legend-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.97);
}
.legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  color: var(--color-text-muted);
}
/* Kanten-Swatch: durchgezogen ueber background, gestrichelt ueber border-top + currentColor. */
.legend-line {
  flex-shrink: 0;
  width: 16px;
  height: 2px;
  border-radius: 999px;
}
.legend-line--dashed {
  height: 0;
  background: none;
  border-top: 2px dashed currentColor;
}
/* Legenden-Abschnittsueberschrift (Nodes / Edges) – dezent, damit die laengere Legende scanbar bleibt. */
.legend-head {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  opacity: 0.75;
}
/* Farb-Swatch fuer die Rollen-Eintraege (Rechteck in Rollenfarbe). */
.legend-node-swatch {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 3px;
}
/* Hinweis auf ausgeblendete, nicht geladene Klassen. */
.legend-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 11px;
}
/* Legenden-Swatch fuer den Versions-Chip (spiegelt .vf-version--multi). */
.legend-version {
  display: inline-block;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-accent);
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: var(--color-accent-soft);
}
.vf-handle {
  width: 8px;
  height: 8px;
  background: var(--color-border);
  border: 2px solid var(--color-surface-2);
  transition: width 0.15s ease, height 0.15s ease, background 0.15s ease;
}
/* Beim Hover über die Klasse die Verbindungspunkte deutlich machen (Drag-to-Connect-Affordance). */
.vf-card:hover .vf-handle {
  width: 12px;
  height: 12px;
  background: var(--color-accent);
}
.vf-tool {
  display: grid;
  place-items: center;
  height: 28px;
  width: 28px;
  border-radius: 6px;
  color: var(--color-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
.vf-tool:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
</style>
