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
// ALLE DREI Kantenarten rendern ueber dieselbe Custom-Kante (ManagedEdge): so greift fuer alle
// Kanten derselbe Faecher-Versatz + die Label-Staffelung -> parallele Kanten/Labels zwischen
// denselben Knoten (auch Call vs. Import oder A->B/B->A) ueberlappen nicht mehr.
// Knoten-Akzentfarbe = ROLLE im Abhaengigkeitsnetz (provider/consumer/hub/isolated, Streifen +
// Badge + Ring); das Package steckt nur noch in einem kleinen Farbpunkt. Icons via Iconify.
//
// WOHER die Kanten kommen: Call und Uses sind server-berechnet und persistiert (java_edges,
// java.service.ts – dort entsteht auch confidence) und liegen als `edges` im Composable
// (useJavaGraph -> GET /api/java/edges). NUR die Import-Kanten baut diese Komponente selbst, aus
// props.files[].dependencies. Methodenruempfe traegt die Dateiliste NICHT (der Listen-Serializer
// liefert method_count + dependencies[]) – die holt das Edge-Panel lazy je Klasse ueber
// useJavaAnalyzer().getFile bzw. api.getJavaMethodSnippet.
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useRootScale } from '../../composables/useRootScale.js'
import { Icon } from '../../lib/icons.js'
import { buildPackageLevel, buildNeighbourLevel, buildContextLevel, commonPackagePrefix, breadcrumbFor } from '../../lib/packageGraph.js'
import { layoutFlat, layoutClustered, layoutRadial } from '../../lib/graphLayout.js'
import { parseGraphQuery, matchNode, matchEdge, GRAPH_QUERY_HELP } from '../../lib/graphQuery.js'
import BusyState from '../BusyState.vue'
import JavaEdgeDetailPanel from './JavaEdgeDetailPanel.vue'
import JavaBundlePanel from './JavaBundlePanel.vue'
import ManualEdgePanel from './ManualEdgePanel.vue'
import ManagedEdge from './ManagedEdge.vue'

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
  // --- Steuerung aus dem Package-Baum (linke Spalte) ---
  // Package, das der Graph oeffnen soll; leerer String = oberste Ebene.
  focusPath: { type: [String, null], default: null },
  // Klasse, die zusaetzlich zentriert werden soll.
  focusFileId: { type: [Number, null], default: null },
  // Zaehler: aendert sich bei JEDEM Klick im Baum, auch wenn dasselbe Ziel erneut gewaehlt wird.
  focusToken: { type: Number, default: 0 },
  // Aktive Suche: Treffer-IDs + Suchtext. Ist etwas gesetzt, zeigt der Graph die Treffer samt
  // direkter Nachbarschaft statt der Package-Ebene.
  matchIds: { type: Array, default: () => [] },
  searchQuery: { type: String, default: '' },
})
// `navigate` = „der Graph zeigt jetzt diese Ebene" (Package-Pfad, leerer String = oberste Ebene).
// Gegenrichtung zu focusPath: der Baum links ist die Ortsangabe und darf nicht stehenbleiben,
// waehrend man sich hier durch die Packages klickt.
const emit = defineEmits(['select', 'clear-search', 'navigate', 'pane-click'])

const { theme } = useTheme()
// `viewport` wird fuer den Zonen-Layer gebraucht: er liegt HINTER dem Canvas und muss dessen
// Pan/Zoom selbst nachfahren (Vue Flow transformiert nur seine eigenen Ebenen).
const { fitView, zoomIn, zoomOut, setViewport, setCenter, viewport } = useVueFlow()

// Persistierte Call-/Uses-Edges (auto + manuell) – Quelle der Wahrheit ist das Backend.
// Kanten lassen sich im Graph manuell anlegen (Drag-to-Connect) und löschen (× am Label):
//   * createEdge/deleteEdge laufen ausschließlich über das Composable (HTTP via lib/api.js).
//   * deleteEdge im Backend: manuelle Kante hart löschen, Auto-Kante als Tombstone (dismissed=1)
//     merken -> falsch erkannte Auto-Kanten kehren bei „Kanten neu simulieren" nicht zurück.
const {
  edges: serverEdges,
  fetchEdges,
  createEdge,
  deleteEdge,
  highlightedCall,
  clearHighlightedCall,
  highlightedDef,
  clearHighlightedDef,
  hoveredNode,
  hoverPalette,
  setHoveredNode,
  hoveredEdge,
  setHoveredEdge,
  setGraphQuery,
  setGraphHitNodes,
  edgeReturn,
  edgeReturnToken,
  setEdgeReturn,
  clearEdgeReturn,
} = useJavaGraph()
// Detailabruf einer einzelnen Klasse (Methodenruempfe fuers Edge-Panel) – die Liste traegt sie nicht.
const { getFile } = useJavaAnalyzer()
const { scale: rootScale } = useRootScale()

// Beide Code-Tab-Highlights (Consumer ausgehend / Source eingehend) gemeinsam loeschen -> jeder
// Graph-Klick (Node/Pane) raeumt einen evtl. stehenden Zustand vollstaendig auf.
function clearHighlights() {
  clearHighlightedCall()
  clearHighlightedDef()
  // Klick auf die freie Flaeche ist „ich bin wieder beim Bild": CodeView gibt daraufhin eine fuer
  // einen Suchtreffer geliehene Panelbreite zurueck (s. usePanelResize.releaseFocus).
  emit('pane-click')
}

// Custom-Edge-Typ registrieren.
const edgeTypes = { managed: ManagedEdge }

// Package-Farben, rotierend nach Package-Index. Als TOKENS, nicht als feste Hex-Werte: die
// Zusatz-Hues haben im Dark-Mode eigene, aufgehellte Werte – hart notiert waeren Zonen und
// Package-Punkte dort deutlich zu dunkel.
const PKG_COLORS = ['var(--color-thistle)', 'var(--color-lavender)', 'var(--color-cyan)', 'var(--color-beige)']
// Etwas breiter als frueher: die Karte traegt jetzt Typ-Chip UND Rollen-Badge, und der
// Klassenname darf davon nicht abgeschnitten werden – er ist die wichtigste Information.
// BASISWERTE bei 16px-Root. Vue Flow rechnet in px, die Karten selbst sind in rem gesetzt und
// wachsen mit der Root-Schriftgroesse -> beides muss denselben Faktor sehen, sonst laeuft der
// Klassenname aus der Box. `rootScale` liefert ihn reaktiv (s. composables/useRootScale.js).
const NODE_W = 250
const NODE_H = 74
const PKG_W = 248
const PKG_H = 96
// Ab dieser Klassenzahl startet der Graph auf Package-Ebene statt mit einem Knoten je Klasse.
// Darunter aendert sich nichts: kleine Projekte sollen weiter direkt ihre Klassen sehen.
const PACKAGE_MODE_FROM = 150
// Mehr Klassenknoten zeichnet der Graph nicht auf einmal. Gemessen: 5000 Knoten brauchen ueber
// 30 s Layout+Render und blockieren dabei alles. Darueber wird abgeschnitten (sichtbar
// angeschrieben) bzw. der Klassen-Umschalter gesperrt.
const CLASS_RENDER_LIMIT = 400
// --- Kanten-Vokabular ---------------------------------------------------------------------
// Jeder Kantentyp bekommt eine EIGENE Farbe UND ein eigenes Strichmuster. Die doppelte Codierung
// ist Absicht: bei Farbfehlsichtigkeit, im Ausdruck und beim starken Herauszoomen traegt das
// Muster die Unterscheidung weiter. Alle Farben kommen aus den Palette-Tokens (theme-faehig) –
// vorher standen hier feste Hex-Werte, die im Dark-Mode neben den Tokens lagen.
const CALL_COLOR = 'var(--color-accent)' // Methodenaufruf – der Hauptfall
const REVIEW_COLOR = 'var(--color-warning)' // unsicher erkannt („Please review")
const USES_COLOR = 'var(--color-cyan)' // Struktur-/Typ-Bezug (Feld, Parameter, new X())
const IMPORT_COLOR = 'var(--color-text-muted)' // nur importiert, kein erkannter Zugriff
const AGG_COLOR = 'var(--color-thistle)' // gebuendelte Package-Beziehungen (andere Ebene)
const DEBUG_EDGES = true // Debug (F12): loggt geladene Klassen + nicht gezeichnete Server-Kanten

// --- Kategorien im Graph ---------------------------------------------------------------------
// Jede Karte beantwortet zwei Fragen, und beide sollen ohne Nachdenken lesbar sein. Sie bekommen
// deshalb GETRENNTE Slots und getrennte Farbfamilien (Tokens in assets/style.css):
//   * ROLLE (wie haengt der Knoten im Netz?)  -> Streifen links, Ring, Methoden-Badge rechts
//   * TYP   (was IST der Knoten?)             -> Chip vor dem Klassennamen
// Dazu als dritte Ebene die GRUPPE (Package): Zone, Package-Knoten und Package-Punkt.
const ROLE_META = {
  // Pfeile laufen im Graph von der Definition nach unten zur Nutzung – die Rollen-Glyphen
  // folgen genau dieser Richtung, damit Icon und Bildaufbau dasselbe sagen.
  provider: { icon: 'lucide:arrow-down', label: 'Source', hint: 'provides · used by others', legend: 'Source · provides' },
  consumer: { icon: 'lucide:arrow-up-from-line', label: 'Consumer', hint: 'uses other classes', legend: 'Consumer · uses' },
  hub: { icon: 'lucide:git-fork', label: 'Hub', hint: 'provides & uses', legend: 'Hub · both' },
  isolated: { icon: 'lucide:unlink', label: 'Isolated', hint: 'no connections', legend: 'Isolated · none' },
}
const ROLE_ORDER = ['provider', 'consumer', 'hub', 'isolated']

// Was der Knoten IST (`java_files.stereotype`, sonst `class_type`). Die Achse beantwortet eine
// Frage, also bleibt sie EIN Slot: der Chip zeigt den Charakter der Klasse, nicht bloss „class".
// `class` ist dabei der Normalfall und bleibt neutral (ohne Rahmen) – Information ist die
// ABWEICHUNG davon. Eine Datenklasse, eine Utility oder eine Exception liest man beim Überfliegen
// anders als einen Service, und genau das soll die Karte zeigen.
const TYPE_META = {
  class: { icon: 'lucide:box', label: 'Class', color: 'var(--color-type-class)' },
  data: { icon: 'lucide:database', label: 'Data class', color: 'var(--color-type-data)' },
  util: { icon: 'lucide:wrench', label: 'Utility', color: 'var(--color-type-util)' },
  exception: { icon: 'lucide:alert-triangle', label: 'Exception', color: 'var(--color-type-exception)' },
  abstract: { icon: 'lucide:layers', label: 'Abstract', color: 'var(--color-type-abstract)' },
  interface: { icon: 'lucide:component', label: 'Interface', color: 'var(--color-type-interface)' },
  enum: { icon: 'lucide:list', label: 'Enum', color: 'var(--color-type-enum)' },
  annotation: { icon: 'lucide:at-sign', label: 'Annotation', color: 'var(--color-type-annotation)' },
  record: { icon: 'lucide:braces', label: 'Record', color: 'var(--color-type-record)' },
}
// Datenträger: Karten dieser Art zeigen ihre FELDER statt der Methodenzahl – bei einer
// Datenklasse ist „5 fields" die Aussage, „0 methods" wäre nur die Abwesenheit einer.
const DATA_TYPES = new Set(['data', 'record'])
// Kennzahl für den Badge rechts auf der Karte. Ohne bekannte Feldzahl (Altbestand, noch nicht neu
// analysiert) bleibt es bei den Methoden – lieber die alte Aussage als eine erfundene 0.
function nodeMetric(d) {
  const useFields = DATA_TYPES.has(d.type) && d.fieldCount != null
  const value = useFields ? d.fieldCount : d.methodCount
  const unit = useFields ? 'field' : 'method'
  return { value, label: `${value} ${unit}${value === 1 ? '' : 's'}` }
}
const TYPE_ORDER = ['class', 'interface', 'enum', 'annotation']
// `stereotype` ist NULL, solange eine Klasse nicht neu analysiert wurde -> auf `class_type`
// zurückfallen, und Unbekanntes auf `class`; nie undefined, sonst rendert die Karte ohne Glyph.
const typeOf = (f) => {
  const t = typeof f === 'string' ? f : f?.stereotype || f?.class_type
  return t && TYPE_META[t] ? t : 'class'
}
// Legenden-Reihenfolge: die vier kanonischen Java-Typen immer (sie koennen jederzeit auftauchen),
// die Charakter-Verfeinerungen (data/util/…) nur, wenn es sie im Ausschnitt wirklich gibt.
const legendTypes = computed(() => {
  const seen = new Set((props.files || []).map((f) => typeOf(f)))
  return [...TYPE_ORDER, ...Object.keys(TYPE_META).filter((t) => !TYPE_ORDER.includes(t) && seen.has(t))]
})

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

// --- Anzeige-Optionen (Dock unten links) -----------------------------------------------------
// Beides ueberlebt den Reload: wer den Graphen einmal auf „nur Aufrufe" eingestellt hat, will ihn
// beim naechsten Besuch nicht wieder voller Import-Linien vorfinden.
const VIEW_KEY = 'wikit:graph-view:v1'
// Klassen nach Package gruppieren (Zonen-Layout). Default AN – das ist der eigentliche Gewinn.
const groupByPackage = ref(true)
// Welche Kantenarten werden gezeichnet? Gefilterte Kanten fallen auch aus dem LAYOUT heraus,
// wirken also nicht mehr auf die Platzierung – sonst bliebe der Graph nach dem Ausblenden der
// Imports genauso zerrissen wie vorher.
const edgeFilter = ref({ call: true, uses: true, import: true })
// Umgebung des Ausschnitts mitzeichnen. Default AN: ein geoeffnetes Package ohne seine Umgebung
// sieht aus wie eine Insel – und beantwortet damit genau die Frage nicht, wegen der man es
// geoeffnet hat. Abschaltbar, weil „nur dieses Package" beim Lesen einer einzelnen Ebene hilft.
const showRelated = ref(true)
try {
  const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
  if (raw && typeof raw === 'object') {
    if (typeof raw.grouped === 'boolean') groupByPackage.value = raw.grouped
    if (typeof raw.related === 'boolean') showRelated.value = raw.related
    if (raw.edges && typeof raw.edges === 'object') edgeFilter.value = { ...edgeFilter.value, ...raw.edges }
  }
} catch {
  /* kaputter/blockierter localStorage -> Defaults */
}
function persistView() {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ grouped: groupByPackage.value, related: showRelated.value, edges: edgeFilter.value }),
    )
  } catch {
    /* ignore */
  }
}
// Auch die Umschalter des Docks werfen das Layout neu – bei einem grossen Ausschnitt dauert das
// genauso lange wie ein Ebenenwechsel. Sie laufen deshalb durch dieselbe Meldung (s. withLayoutBusy).
function toggleRelated() {
  withLayoutBusy(
    viewBusyInfo(
      showRelated.value ? 'Hiding neighbours…' : 'Adding neighbours…',
      showRelated.value ? 'redrawing without the surrounding packages' : 'pulling in what touches this level',
    ),
    () => {
      showRelated.value = !showRelated.value
      persistView()
    },
  )
}
function toggleGrouping() {
  withLayoutBusy(
    viewBusyInfo(
      groupByPackage.value ? 'Ungrouping…' : 'Grouping by package…',
      groupByPackage.value ? 'one layout over all classes' : 'one layout per package, then over the zones',
    ),
    () => {
      groupByPackage.value = !groupByPackage.value
      persistView()
    },
  )
}
function toggleEdgeKind(kind) {
  withLayoutBusy(viewBusyInfo('Redrawing…', `${kind} edges ${edgeFilter.value[kind] ? 'off' : 'on'} — edges steer the layout`), () => {
    edgeFilter.value = { ...edgeFilter.value, [kind]: !edgeFilter.value[kind] }
    persistView()
  })
}
// Beschriftung + Farbe der Filter-Pillen; die Farben spiegeln exakt die Kanten im Canvas.
const EDGE_KINDS = [
  { key: 'call', label: 'Calls', color: 'var(--color-accent)' },
  { key: 'uses', label: 'Uses', color: 'var(--color-cyan)' },
  { key: 'import', label: 'Imports', color: 'var(--color-text-muted)' },
]

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

// --- Ebenen-Navigation (Package -> … -> Klassen) ------------------------------------------
// Bei einer grossen Codebasis ist ein Knoten je Klasse unlesbar. Der Graph zeigt dann die
// Packages als Aggregatknoten; ein Klick steigt eine Ebene ab, bis die Klassen erreicht sind.
// `zoomPath` = aktuell geoeffneter Pfad, `showClasses` = manuelles Aufklappen dieser Ebene.
const zoomPath = ref(null) // null -> noch nicht gesetzt, faellt auf rootPath zurueck
const showClasses = ref(false)

// Startpfad = laengster gemeinsamer Package-Praefix. Liegt alles unter com.acme, waere die
// oberste Ebene sonst ein einziger Knoten "com".
const rootPath = computed(() => commonPackagePrefix(props.files || []))
const basePath = computed(() => (zoomPath.value == null ? rootPath.value : zoomPath.value))

// Alle Klassenkanten (unabhaengig von der Sichtbarkeit) fuer die Aggregation: gleiche Richtung
// wie im Graph, also fromId = Definition/Provider, toId = Nutzung/Consumer.
const allClassEdges = computed(() => {
  const files = props.files || []
  const byName = new Map()
  for (const f of files) byName.set(f.class_name, f)
  const out = []
  const pairs = new Set()
  for (const e of serverEdges.value || []) {
    const caller = byName.get(e.source_class)
    const definer = byName.get(e.target_class)
    if (!caller || !definer || caller.id === definer.id) continue
    out.push({ fromId: definer.id, toId: caller.id, kind: e.kind || 'call' })
    pairs.add(`${definer.id}->${caller.id}`)
  }
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      const target = byName.get(simpleName(dep))
      if (!target || target.id === f.id) continue
      const key = `${target.id}->${f.id}`
      if (pairs.has(key)) continue
      pairs.add(key)
      out.push({ fromId: target.id, toId: f.id, kind: 'import' })
    }
  }
  return out
})

const level = computed(() =>
  buildPackageLevel({ files: props.files || [], classEdges: allClassEdges.value, basePath: basePath.value }),
)

// Package-Ebene nur, solange sie ueberhaupt etwas aggregiert: viele Klassen, echte Sub-Packages,
// und der Nutzer hat sie nicht manuell aufgeklappt.
const packageMode = computed(
  () =>
    !searchActive.value &&
    (props.files || []).length >= PACKAGE_MODE_FROM &&
    level.value.groups.length > 0 &&
    !showClasses.value,
)

// Welche Klassen werden als Klassenknoten gezeichnet? Auf Package-Ebene nur die, die direkt im
// geoeffneten Pfad liegen; sonst alles unterhalb des Pfads (bzw. alles, wenn kein Pfad gesetzt).
const scopedFiles = computed(() => {
  const files = props.files || []
  const base = basePath.value
  if (!base) return files
  return files.filter((f) => f.package === base || String(f.package || '').startsWith(base + '.'))
})
// --- Suchmodus: Treffer + direkte Nachbarschaft ----------------------------------------------
// Nur die Treffer zu zeigen waere ein Graph ohne Kanten – gerade bei einem einzigen Treffer.
// Deshalb kommt eine Hop-Ebene Kontext dazu: die Klassen, die den Treffer nutzen oder von ihm
// genutzt werden. Treffer bleiben hervorgehoben, der Kontext tritt zurueck.
// Oberhalb dieser Trefferzahl waere der Suchmodus sinnlos: hunderte hervorgehobene Knoten sind
// dasselbe wie keine Hervorhebung. Der Graph bleibt dann auf Package-Ebene und sagt es an.
const SEARCH_GRAPH_LIMIT = 80
const searchTooBroad = computed(() => !!props.searchQuery && props.matchIds.length > SEARCH_GRAPH_LIMIT)
const searchActive = computed(
  () => !!props.searchQuery && props.matchIds.length > 0 && props.matchIds.length <= SEARCH_GRAPH_LIMIT,
)
const matchIdSet = computed(() => new Set(props.matchIds))
// Nachbarn UND Beziehungszahl in einem Durchlauf: die Leiter unten braucht die Gesamtzahl auch
// dann, wenn gerade gar keine Umgebung gezeichnet wird (Stufe 0) – sonst stuende dort „0 von 0".
const searchContextInfo = computed(() => {
  const ids = matchIdSet.value
  const out = new Set()
  let relations = 0
  if (!searchActive.value) return { ids: out, relations: 0 }
  for (const e of allClassEdges.value) {
    const from = ids.has(e.fromId)
    const to = ids.has(e.toId)
    if (from === to) continue // beide Treffer oder keiner -> keine Beziehung nach draussen
    out.add(from ? e.toId : e.fromId)
    relations++
  }
  return { ids: out, relations }
})
const searchNeighbourIds = computed(() => searchContextInfo.value.ids)
// --- Wieviel Umgebung? EINE Bedienung, egal ob ein Treffer oder sechsundzwanzig --------------
//
// Das waren lange zwei Mechaniken fuer dieselbe Frage, und man sah es: ein einzelner Treffer
// bekam eine Stufenleiter in der Leiste links (8 · 20 · 40 · all), mehrere Treffer einen grossen
// Schalter mittig ueber dem Graphen („Show 78 related classes"). Wer im Klassenfilter tippte,
// wechselte damit je nach Trefferzahl die Bedienung – und der Schalter war die schlechtere
// Haelfte: er kannte nur alles oder nichts, sprang also von 26 auf 104 Karten und damit in genau
// das Gedraenge, das die Suche aufloesen sollte.
//
// Jetzt gilt fuer beides dieselbe Leiter, und ein einzelner Treffer ist nur der Sonderfall „ein
// Zentrum" (s. lib/packageGraph.js → buildContextLevel). Vier Festlegungen:
//
//   * Stufe 0 ist „nur die Treffer" – das alte „Hide related", jetzt als unterste Sprosse
//     derselben Leiter statt als eigener Schalter an eigener Stelle.
//   * Was nicht als Karte ins Budget passt, verschwindet NICHT, sondern wird je Package zu einem
//     Aggregatknoten – dieselbe Karte und dieselbe Kantenart wie bei der Package-Umgebung, also
//     anklickbar, aufloesbar und im Buendel-Panel lesbar. Ein Budget, das still abschneidet,
//     waere ein Deckel, der sich als Bild ausgibt.
//   * Die Automatik waehlt die STARTSTUFE, nicht einen An/Aus-Zustand: so viel Umgebung, wie das
//     Bild vertraegt (CONTEXT_AUTO_LIMIT). Frueher war dieselbe Schwelle ein Boolean – bei 5
//     Treffern und 40 Nachbarn hiess das „gar nichts", heute sind es die 20 staerksten.
//   * Ein einzelner Treffer beginnt bei EGO_CARD_LIMIT statt bei der Automatik: dort IST die
//     Umgebung die Antwort auf die Frage, und eine Karte ohne Kanten waere gar keine.
// Der Override gilt fuer GENAU diese Anfrage – die naechste beginnt wieder bei der Automatik,
// sonst schleppt man eine Entscheidung mit, die zu einem anderen Ergebnis getroffen wurde.
const CONTEXT_AUTO_LIMIT = 30 // so gross darf das Bild von selbst werden (Treffer + Umgebung)
const EGO_CARD_LIMIT = 40 // Startbudget bei genau einem Treffer
const CONTEXT_NODE_LIMIT = 10 // hoechstens so viele Aggregatknoten
// Feste Stufen statt Schieberegler: jeder Zwischenwert kostet ein dagre-Layout, und niemand
// formuliert „63 Karten" als Absicht. Was ueber der Nachbarzahl liegt, wird ausgeblendet.
const CONTEXT_STEPS = [0, 8, 20, 40, 80, 160, 400]

const contextOverride = ref(null) // null = automatisch, sonst die gewaehlte Stufe
const contextExpanded = ref(new Set()) // aufgeklappte Nachbar-Packages (Pfad)

// Genau ein Treffer -> Stern mit Mitte (nur dafuer taugt das radiale Layout).
const egoCenterId = computed(() =>
  searchActive.value && props.matchIds.length === 1 ? props.matchIds[0] : null,
)
// Jede neue Suche faengt bei der Voreinstellung an: eine mitgeschleppte Stufe oder ein
// aufgeklapptes Package gehoerten zu einem anderen Ergebnis.
watch([() => props.searchQuery, egoCenterId], () => {
  contextOverride.value = null
  contextExpanded.value = new Set()
})

// Stufen, die es bei DIESEM Ergebnis ueberhaupt gibt: alles oberhalb der Nachbarzahl waere
// derselbe Ausschnitt unter anderem Namen. Die letzte Stufe ist immer „alle".
const contextSteps = computed(() => {
  const total = searchContextInfo.value.ids.size
  return [...CONTEXT_STEPS.filter((s) => s < total), total]
})
const autoBudget = computed(() => {
  const total = searchContextInfo.value.ids.size
  if (!total) return 0
  if (props.matchIds.length === 1) return Math.min(EGO_CARD_LIMIT, total)
  // Die groesste Stufe, die neben den Treffern noch ins Bild passt.
  const room = CONTEXT_AUTO_LIMIT - matchIdSet.value.size
  return contextSteps.value.reduce((best, s) => (s <= room ? s : best), 0)
})
const contextBudget = computed(() => contextOverride.value ?? autoBudget.value)
function setContextBudget(n) {
  contextOverride.value = n
}
function stepContext(dir) {
  const steps = contextSteps.value
  const i = steps.findIndex((s) => s >= contextBudget.value)
  const next = steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? steps.length - 1 : i) + dir))]
  if (next != null) contextOverride.value = next
}
// Ein Aggregat aufklappen heisst: DIESES Package als Karten zeigen. Der Weg zurueck ist der Chip
// in der Leiste – ein zweiter Klick auf den Knoten geht nicht, weil er danach nicht mehr da ist.
function toggleContextPackage(path) {
  const next = new Set(contextExpanded.value)
  const key = path || '(default)'
  if (next.has(key)) next.delete(key)
  else next.add(key)
  contextExpanded.value = next
}

// Umgebung ueberhaupt vorhanden -> die Leiste zeigt die Leiter (auch auf Stufe 0, sonst gaebe es
// keinen Weg zurueck nach oben).
const contextAvailable = computed(() => searchActive.value && searchContextInfo.value.ids.size > 0)
// Umgebung im Bild -> Karten und Aggregate werden gebaut.
const contextShown = computed(() => contextAvailable.value && contextBudget.value > 0)
const EMPTY_CONTEXT = {
  cardIds: new Set(),
  nodes: [],
  edges: [],
  keyByFileId: new Map(),
  linkedIds: new Set(),
  neighbours: 0,
  relations: 0,
  aggregatedClasses: 0,
  hiddenPackages: 0,
  hiddenRelations: 0,
  cardCount: 0,
  expandedPaths: [],
}
const contextLevel = computed(() =>
  contextShown.value
    ? buildContextLevel({
        files: props.files || [],
        classEdges: allClassEdges.value,
        centerIds: matchIdSet.value,
        cardLimit: contextBudget.value,
        nodeLimit: CONTEXT_NODE_LIMIT,
        rootPath: rootPath.value,
        expandedPaths: contextExpanded.value,
      })
    : EMPTY_CONTEXT,
)

const searchScope = computed(() => {
  if (!searchActive.value) return null
  const ids = matchIdSet.value
  const wanted = new Set([...ids, ...contextLevel.value.cardIds])
  return {
    files: (props.files || []).filter((f) => wanted.has(f.id)),
    matches: ids.size,
    // „related" ist die GESAMTZAHL der Nachbarn, nicht die gerade gezeichnete: die Leiste sagt
    // „20 von 78", und 78 muss dieselbe Zahl sein, egal auf welcher Stufe man steht.
    related: searchContextInfo.value.ids.size,
    relations: searchContextInfo.value.relations,
  }
})

// --- Der Ausschnitt selbst (ohne seine Umgebung) ---------------------------------------------
// Grundlage fuer alles Weitere: WELCHE Knoten stehen fuer den geoeffneten Pfad? Auf der
// Package-Ebene die Aggregate + die direkt darin liegenden Klassen, sonst die Klassen darunter.
const scopeFiles = computed(() => {
  if (packageMode.value) return level.value.directFiles
  // Harte Obergrenze: Vue Flow + dagre brauchen fuer tausende Knoten zig Sekunden und blockieren
  // dabei den Hauptthread. Lieber ehrlich abschneiden und es anschreiben, als die Oberflaeche
  // einfrieren zu lassen – der Weg zur vollstaendigen Sicht ist das Aufklappen eines Packages.
  const list = scopedFiles.value
  return list.length > CLASS_RENDER_LIMIT ? list.slice(0, CLASS_RENDER_LIMIT) : list
})

// --- Die Umgebung des Ausschnitts ------------------------------------------------------------
// Ein geoeffnetes Package zeigte bisher nur sich selbst: jede Beziehung nach draussen endete am
// Rand des Ausschnitts und wurde nur gezaehlt. Genau die ist aber die Frage, wegen der man ein
// Package oeffnet. Der Graph zieht sie deshalb auf zwei Arten mit herein – die Wahl haengt an der
// Zahl, weil dieselbe Darstellung nicht beides kann:
//   * wenige Nachbarklassen -> jede EINZELN, wie im Suchmodus. Bei einer Handvoll ist die Klasse
//     die Aussage, und ihre Kanten tragen Methodennamen (klickbar bis in den Code).
//   * viele -> je fremdem Zweig EIN Aggregatknoten. 300 fremde Klassen um ein Package herum sind
//     kein Bild mehr; „bom · 12 relations" ist eines – und die Aggregatkante loest sich per Klick
//     ohnehin in genau diese Klassenpaare auf (JavaBundlePanel).
// Welche Knoten der Ausschnitt zeichnet, muss die Umgebung wissen: auf der Package-Ebene haengt
// eine Klasse an ihrem Aggregat, im Klassenmodus an sich selbst.
const RELATED_NODE_LIMIT = 8 // hoechstens so viele Nachbar-Packages (nach Beziehungszahl)
const RELATED_CLASS_LIMIT = 60 // bis hierher einzelne Nachbarklassen statt Aggregatknoten
const insideKeys = computed(() =>
  packageMode.value ? level.value.keyByFileId : new Map(scopeFiles.value.map((f) => [f.id, `c:${f.id}`])),
)
const neighbourhood = computed(() =>
  // Der Suchmodus bringt seine eigene Umgebung mit (Aggregate der ueberzaehligen Nachbarn) –
  // dieselbe Form wie hier, damit Kanten, Farben, Legende und das Buendel-Panel unveraendert damit
  // arbeiten. Deshalb ein Zweig und keine zweite Rendering-Strecke.
  contextShown.value
    ? contextLevel.value
    : buildNeighbourLevel({
        files: props.files || [],
        classEdges: allClassEdges.value,
        // Im Suchmodus und bei abgeschalteter Umgebung: leerer basePath -> die Funktion liefert
        // nichts. Die Suche bringt ihre eigene Nachbarschaft mit; zwei Kontextbegriffe
        // gleichzeitig waeren nicht mehr lesbar.
        basePath: searchActive.value || !showRelated.value ? '' : basePath.value,
        insideKeys: insideKeys.value,
        rootPath: rootPath.value,
        limit: RELATED_NODE_LIMIT,
      }),
)
// Nachbarklassen als eigene Knoten – nur im Klassenmodus und nur, solange es wenige sind.
const relatedFiles = computed(() => {
  const ids = neighbourhood.value.linkedIds
  if (packageMode.value || !ids.size) return []
  return (props.files || []).filter((f) => ids.has(f.id))
})
const relatedAsClasses = computed(
  () =>
    relatedFiles.value.length > 0 &&
    relatedFiles.value.length <= RELATED_CLASS_LIMIT &&
    scopeFiles.value.length + relatedFiles.value.length <= CLASS_RENDER_LIMIT,
)
// Sonst: Aggregatknoten. (Beides gleichzeitig waere dieselbe Beziehung zweimal im Bild.)
const relatedNodes = computed(() => (relatedAsClasses.value ? [] : neighbourhood.value.nodes))
const relatedIdSet = computed(() => new Set(relatedAsClasses.value ? relatedFiles.value.map((f) => f.id) : []))
// Kopfzeile: was traegt die Umgebung gerade bei?
const relatedSummary = computed(() => {
  const n = neighbourhood.value
  if (!n.relations) return null
  return {
    relations: n.relations,
    classes: relatedAsClasses.value ? relatedFiles.value.length : 0,
    packages: relatedAsClasses.value ? 0 : n.nodes.length,
    hiddenPackages: relatedAsClasses.value ? 0 : n.hiddenPackages,
    hiddenRelations: relatedAsClasses.value ? 0 : n.hiddenRelations,
  }
})

const visibleFiles = computed(() => {
  if (searchActive.value) {
    const list = searchScope.value.files
    return list.length > CLASS_RENDER_LIMIT ? list.slice(0, CLASS_RENDER_LIMIT) : list
  }
  return relatedAsClasses.value ? [...scopeFiles.value, ...relatedFiles.value] : scopeFiles.value
})
// Wieviele Klassen des Ausschnitts werden gerade NICHT gezeichnet? Gemessen am AUSSCHNITT, nicht
// an den gezeichneten Knoten – die Umgebung gehoert nicht dazu und wuerde die Zahl schoenrechnen.
const truncatedClasses = computed(() =>
  packageMode.value ? 0 : Math.max(0, scopedFiles.value.length - scopeFiles.value.length),
)

const breadcrumb = computed(() => breadcrumbFor(basePath.value, rootPath.value))
// Wieviele Klassen stecken im aktuell geoeffneten Ausschnitt (fuer die Kopfzeile)?
const scopeClassCount = computed(() => {
  const base = basePath.value
  const files = props.files || []
  if (!base) return files.length
  return files.filter((f) => f.package === base || String(f.package || '').startsWith(base + '.')).length
})

// --- Warten sichtbar machen ------------------------------------------------------------------
// Das Layout (dagre) laeuft SYNCHRON in `layout` und blockiert dabei den Hauptthread: bei einem
// Package mit einigen hundert Klassen passiert nach dem Klick erst sekundenlang nichts, dann steht
// das neue Bild da. Ein Spinner, den man erst NACH der Rechnung setzt, waere unsichtbar – deshalb
// laeuft jede Ebenen-Aenderung durch `withLayoutBusy`: Meldung setzen, zwei Frames abwarten (erst
// dann hat der Browser sie wirklich gemalt), DANN die Aenderung ausloesen.
const layoutBusy = ref(null) // { title, detail, hint, since } | null
// Darunter ist die Rechnung so kurz, dass die Meldung nur aufblitzen wuerde.
const BUSY_MIN_NODES = 120

const twoFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

// Klassen unterhalb eines Pfades – die Zahl, die den Aufwand bestimmt UND die den Nutzer
// interessiert („771 classes").
function classesUnder(path) {
  const list = props.files || []
  if (!path) return list.length
  return list.filter((f) => f.package === path || String(f.package || '').startsWith(path + '.')).length
}
function packagesUnder(path) {
  const set = new Set()
  for (const f of props.files || []) {
    const pkg = f.package || ''
    if (!path || pkg === path || pkg.startsWith(path + '.')) set.add(pkg || '(default)')
  }
  return set.size
}

// `info` beschreibt die Situation, `mutate` loest sie aus. Kleine Aenderungen laufen unveraendert
// durch – ein Overlay fuer 30 ms ist Unruhe, keine Auskunft.
async function withLayoutBusy(info, mutate) {
  if (!info || info.nodes < BUSY_MIN_NODES) {
    mutate()
    return
  }
  layoutBusy.value = { ...info, since: Date.now() }
  await nextTick()
  await twoFrames()
  mutate()
  // Die schwere Arbeit passiert in Vues Re-Render – nach diesem Tick steht das neue Bild.
  await nextTick()
  await twoFrames()
  layoutBusy.value = null
}

// Meldung fuer eine Aenderung AM AKTUELLEN Ausschnitt (Dock-Umschalter): der Aufwand haengt an
// dem, was gerade gezeichnet ist.
function viewBusyInfo(title, detail) {
  const n = visibleFiles.value.length + (relatedNodes.value?.length || 0)
  return {
    nodes: n,
    title,
    detail: `${n} nodes on screen · ${detail}`,
    hint: 'Placing nodes and routing edges — this runs in the browser, so the page stays still while it works.',
  }
}

// Meldungstexte an EINER Stelle, damit „Opening …" ueberall gleich klingt.
function levelBusyInfo(path) {
  const classes = classesUnder(path)
  const pkgs = packagesUnder(path)
  const label = path ? path.split('.').pop() : 'all packages'
  return {
    nodes: classes,
    title: `Opening ${label}…`,
    detail: `${classes} classes · ${pkgs} package(s)`,
    hint:
      classes > CLASS_RENDER_LIMIT
        ? `Large level: only the first ${CLASS_RENDER_LIMIT} classes are drawn — open a sub-package for the full picture.`
        : 'Placing nodes and routing edges — this runs in the browser, so the page stays still while it works.',
  }
}

// Umschalten zwischen Package-Karten und allen Klassen dieser Ebene – der teuerste Wechsel im
// Graphen, weil aus einer Handvoll Kacheln hunderte Karten werden.
function setShowClasses(value) {
  if (showClasses.value === value) return
  const opening = value
  const n = opening ? scopeClassCount.value : level.value.groups.length
  withLayoutBusy(
    {
      nodes: opening ? n : 0, // Zurueck auf Packages ist immer billig
      title: opening ? `Showing ${n} classes…` : 'Back to packages…',
      detail: opening ? `laying out every class below ${basePath || 'the root'}` : '',
      hint:
        n > CLASS_RENDER_LIMIT
          ? `Only the first ${CLASS_RENDER_LIMIT} classes are drawn — open a sub-package for the full picture.`
          : 'Placing nodes and routing edges — this runs in the browser, so the page stays still while it works.',
    },
    () => {
      showClasses.value = value
    },
  )
}

function drillTo(path) {
  withLayoutBusy(levelBusyInfo(path), () => {
    zoomPath.value = path
    showClasses.value = false
  })
}
function drillUp() {
  const base = basePath.value
  if (!base || base === rootPath.value) return
  const parent = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : ''
  drillTo(parent.length >= rootPath.value.length ? parent : rootPath.value)
}

// --- Der Baum folgt dem Graphen --------------------------------------------------------------
// Gemeldet wird der GEZEIGTE Pfad, nicht der Klick: Zonenkopf, Package-Knoten, Breadcrumb und
// `drillUp` laufen alle ueber `drillTo`, ein von aussen gesetzter Fokus (Baum-Klick) dagegen
// direkt ueber `zoomPath` – und ein verschobener Wurzelpraefix ueber den Watcher darueber. Am
// `basePath` haengt jeder dieser Wege, also gibt es genau eine Meldung und keinen Zustand, den
// der Baum zeigt, ohne dass der Graph ihn haette. `immediate`, damit auch die Startebene ankommt.
// Im Suchmodus gibt es keine Ebene zu melden: der Graph zeigt dann die Treffer quer durch die
// Codebasis, und eine markierte Ebene im Baum waere eine Ortsangabe, die nicht mehr stimmt.
watch([basePath, searchActive], ([path, searching]) => emit('navigate', searching ? null : path), { immediate: true })

// Das Einpassen nach einem Ebenenwechsel uebernimmt der Geometrie-Watcher weiter unten: er hoert
// auf die tatsaechlichen Knotenpositionen und feuert damit erst, wenn das neue Layout steht. Ein
// zweiter fitView()-Aufruf hier wuerde ihm mit der alten Geometrie zuvorkommen.

// Neue/geloeschte Klassen koennen den gemeinsamen Praefix verschieben -> Pfad zuruecksetzen,
// wenn er nicht mehr existiert.
watch(rootPath, (root) => {
  if (zoomPath.value != null && !String(zoomPath.value).startsWith(root)) zoomPath.value = null
})

// --- Der Graph folgt dem Baum ----------------------------------------------------------------
// Auf einen Klasse-Klick soll der Knoten nicht nur sichtbar, sondern auch angesteuert werden.
// Das kann erst passieren, wenn das neue Layout steht -> hier nur vormerken, das Anfahren
// uebernimmt der Geometrie-Watcher weiter unten.
const pendingFocusNode = ref(null)
watch(
  () => props.focusToken,
  () => {
    if (props.focusPath != null) {
      const path = props.focusPath
      // Nur oeffnen, was zur Wurzel passt (der gemeinsame Praefix ist die oberste Ebene).
      const target = rootPath.value && !path.startsWith(rootPath.value) ? rootPath.value : path
      // Genau der Fall aus der Beschwerde: ein Klick im Baum auf ein Package mit hunderten
      // Klassen. Die Meldung gehoert vor die Rechnung, nicht danach.
      withLayoutBusy(levelBusyInfo(target), () => {
        zoomPath.value = target
        // Ein konkretes Package im Baum meint die Klassen darin, nicht dessen Unterebene.
        showClasses.value = false
      })
    }
    if (props.focusFileId != null) pendingFocusNode.value = `c:${props.focusFileId}`
  },
)

const layout = computed(() => {
  const files = visibleFiles.value
  const known = new Map() // class_name -> file
  for (const f of files) known.set(f.class_name, f)

  // Package -> Farbindex (stabil sortiert). Die Nachbar-Aggregate gehoeren dazu: sie bekommen im
  // geclusterten Layout eine eigene Zone, und die traegt die Package-Farbe.
  const pkgs = [
    ...new Set([...files.map((f) => f.package || '(default)'), ...relatedNodes.value.map((n) => n.path || '(default)')]),
  ].sort()
  const pkgColor = new Map(pkgs.map((p, i) => [p, PKG_COLORS[i % PKG_COLORS.length]]))

  // --- Kanten zwischen geladenen Klassen bestimmen ---
  const edges = []
  // Jede erkannte Beziehung – auch die gerade ausgeblendete. Die ROLLE eines Knotens
  // (provider/consumer/hub) haengt daran und darf nicht mit dem Kanten-Filter springen: wer die
  // Imports abschaltet, will weniger Linien sehen, nicht eine andere Bewertung der Klassen.
  const rolePairs = []
  const showKind = (kind) => edgeFilter.value[kind] !== false
  const callPairs = new Set()
  const skipped = [] // Debug: Server-Kanten, die NICHT gezeichnet werden (Endpunkt nicht geladen)
  // Im Suchmodus zaehlt nur, was einen TREFFER beruehrt. Wie die mitgezeigten Nachbarn
  // untereinander zusammenhaengen, beantwortet eine Frage, die niemand gestellt hat – es waren
  // aber die meisten Linien im Bild (und jede davon geht ins dagre-Layout ein, kostet also auch
  // Rechenzeit). Der Kontext soll die Treffer erklaeren, nicht sich selbst.
  const touchesMatch = (a, b) => !searchActive.value || matchIdSet.value.has(a) || matchIdSet.value.has(b)
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
    if (!touchesMatch(callerFile.id, definerFile.id)) continue
    const pairKey = `${callerFile.id}->${definerFile.id}`
    callPairs.add(pairKey)
    rolePairs.push({ source: `c:${definerFile.id}`, target: `c:${callerFile.id}` })

    // uses-Kante = struktureller Typ-Bezug (Variablen-/Feld-/Parameter-/Rueckgabetyp, new X(),
    // statischer Aufruf ohne Methoden-Treffer): eigener Stil, kein Label, nicht klickbar, einzeln.
    if (e.kind === 'uses') {
      if (!showKind('uses')) continue
      edges.push({
        id: `edge:${e.id}`,
        source: `c:${definerFile.id}`,
        target: `c:${callerFile.id}`,
        type: 'managed',
        markerEnd: { type: MarkerType.ArrowClosed, color: USES_COLOR },
        data: {
          kind: 'uses',
          sourceId: `c:${definerFile.id}`,
          targetId: `c:${callerFile.id}`,
          // Kurz gestrichelt – deutlich anders als der Punktraster der Import-Kante.
          edgeStyle: { stroke: USES_COLOR, strokeWidth: 1.9, strokeDasharray: '5 3', cursor: 'default' },
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
    if (!showKind('call')) break
    const single = methods.length === 1
    const allManual = methods.every((m) => m.isManual)
    const needsReview = methods.some((m) => m.needsReview)
    const stroke = needsReview ? REVIEW_COLOR : CALL_COLOR
    edges.push({
      id: `call:${definerFile.id}-${callerFile.id}`,
      source: `c:${definerFile.id}`,
      target: `c:${callerFile.id}`,
      type: 'managed',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        kind: 'call',
        sourceId: `c:${definerFile.id}`,
        targetId: `c:${callerFile.id}`,
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
          strokeWidth: 2.4,
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
      if (!touchesMatch(f.id, target.id)) continue
      if (callPairs.has(`${f.id}->${target.id}`)) continue
      callPairs.add(`${f.id}->${target.id}`)
      rolePairs.push({ source: `c:${target.id}`, target: `c:${f.id}` })
      if (!showKind('import')) continue
      edges.push({
        id: `imp:${f.id}-${target.id}`,
        // Einheitlicher „Definition -> Nutzung"-Fluss: importierte Klasse = Quelle,
        // importierende Klasse = Ziel (Pfeilspitze). Ueber ManagedEdge gerendert -> faechert
        // mit, hat aber kein Label und ist nicht klickbar (kind: 'import').
        source: `c:${target.id}`,
        target: `c:${f.id}`,
        type: 'managed',
        markerEnd: { type: MarkerType.ArrowClosed, color: IMPORT_COLOR },
        data: {
          kind: 'import',
          sourceId: `c:${target.id}`,
          targetId: `c:${f.id}`,
          // Punktraster statt Striche: die schwaechste Aussage bekommt auch die leiseste Linie.
          edgeStyle: {
            stroke: IMPORT_COLOR,
            strokeWidth: 1.7,
            strokeDasharray: '1 5',
            strokeLinecap: 'round',
            opacity: 0.75,
          },
        },
      })
    }
  }

  // 2a2) Rollen im Suchmodus aus ALLEN erkannten Beziehungen, nicht nur aus den gezeichneten.
  //      Sonst behauptet die Karte einer Klasse mit drei Nutzern „no connections", nur weil deren
  //      Nutzer gerade nicht im Bild sind – dieselbe Regel wie beim Kanten-Filter: wer weniger
  //      Linien sieht, soll keine andere Bewertung der Klassen bekommen. Fremde Knoten-IDs stoeren
  //      nicht, die Rolle wird nur fuer die gezeichneten Knoten abgefragt.
  if (searchActive.value) {
    const drawnIds = new Set(files.map((f) => f.id))
    for (const e of allClassEdges.value) {
      if (!drawnIds.has(e.fromId) && !drawnIds.has(e.toId)) continue
      rolePairs.push({ source: `c:${e.fromId}`, target: `c:${e.toId}` })
    }
  }

  // 2b) Aggregierte Kanten zwischen den Package-Knoten dieser Ebene. Ein Label mit der Anzahl der
  //     zusammengefassten Klassenbeziehungen; die Strichstaerke waechst logarithmisch mit, damit
  //     ein Buendel aus 400 Kanten nicht 40x dicker wirkt als eines aus 10.
  // 2c) …und dieselbe Bauart fuer die Kanten in die UMGEBUNG (Ausschnitt <-> fremder Zweig). Sie
  //     entstehen unabhaengig vom Modus: auch ein Klassenausschnitt haengt an anderen Packages.
  const aggEdges = [
    ...(packageMode.value ? level.value.groupEdges : []),
    ...(relatedNodes.value.length ? neighbourhood.value.edges : []),
  ]
  for (const ge of aggEdges) {
    const width = Math.min(7, 1.8 + Math.log2(ge.count + 1) * 0.9)
    rolePairs.push({ source: ge.source, target: ge.target })
    edges.push({
      id: `agg:${ge.id}`,
      source: ge.source,
      target: ge.target,
      type: 'managed',
      markerEnd: { type: MarkerType.ArrowClosed, color: AGG_COLOR },
      data: {
        kind: 'aggregate',
        count: ge.count,
        sourceId: ge.source,
        targetId: ge.target,
        // Eigene Farbe, weil es eine ANDERE EBENE ist: hier steht ein Knoten fuer viele Klassen.
        edgeStyle: { stroke: AGG_COLOR, strokeWidth: width, opacity: 0.9, cursor: 'pointer' },
        // Klick loest das Buendel in seine einzelnen Klassenbeziehungen auf.
        onOpen: openBundlePanel,
      },
    })
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
  const sourceNodeIds = new Set(rolePairs.map((e) => e.source)) // Definition/Provider-Seite
  const targetNodeIds = new Set(rolePairs.map((e) => e.target)) // Anwender/Consumer-Seite
  const roleFor = (nid) => {
    const isSrc = sourceNodeIds.has(nid)
    const isTgt = targetNodeIds.has(nid)
    return isSrc && isTgt ? 'hub' : isSrc ? 'provider' : isTgt ? 'consumer' : 'isolated'
  }

  // --- Platzierung ---------------------------------------------------------------------------
  // Zwei Verfahren (Details in lib/graphLayout.js):
  //   * geclustert – Klassen werden nach ihrem Package in Zonen gelegt, die Zonen selbst danach
  //     nach ihren Abhaengigkeiten geschichtet. Das ist der Normalfall im Klassenmodus.
  //   * flach – ein Lauf ueber alles. Bleibt fuer die Package-Ebene (dort IST jeder Knoten schon
  //     ein Package) und fuer Ausschnitte mit nur einem Package, wo eine Zone nichts trennt.
  const pkgGroups = packageMode.value ? level.value.groups : []
  const related = relatedNodes.value
  // Knotengroessen UND Abstaende folgen der Root-Schriftgroesse – die Karten sind in rem gesetzt.
  const s = rootScale.value
  const nodeW = NODE_W * s
  const nodeH = NODE_H * s
  const pkgW = PKG_W * s
  const pkgH = PKG_H * s
  const layoutNodes = [
    ...pkgGroups.map((grp) => ({ id: grp.id, width: pkgW, height: pkgH, group: grp.path })),
    // Nachbar-Aggregate liegen ausserhalb des Ausschnitts -> im geclusterten Layout bekommt jedes
    // seine eigene Zone (mit seinem Package-Namen), damit man auf einen Blick sieht, was zum
    // geoeffneten Pfad gehoert und was daneben liegt.
    ...related.map((n) => ({ id: n.id, width: pkgW, height: pkgH, group: n.path || '(default)' })),
    ...files.map((f) => ({ id: `c:${f.id}`, width: nodeW, height: nodeH, group: f.package || '(default)' })),
  ]
  const distinctPkgs = new Set(layoutNodes.map((n) => n.group)).size
  // Im Suchmodus wird nur geclustert, wenn die Umgebung mitgezeichnet wird: die blossen Treffer
  // liegen quer ueber die Codebasis, das waeren zwanzig Rahmen um je eine Karte – nichts
  // zusammengefasst, dafuer ein dagre-Lauf je Zone plus Meta-Layout. Kommen die nutzenden und
  // genutzten Klassen dazu, entstehen dagegen echte Gruppen (ein Treffer und seine Nutzer liegen
  // oft im selben Package), und dann traegt die Zone. Einzelgaenger bleiben auch dort ungerahmt
  // (minGroupSize) – genau der Fall, der die Gruppierung hier frueher gekostet hat.
  const searchClustered = searchActive.value && contextShown.value
  const clustered =
    !packageMode.value && groupByPackage.value && distinctPkgs > 1 && (!searchActive.value || searchClustered)
  // Radial gilt nur beim EINZELNEN Treffer: dort ist der Ausschnitt ein Stern, dagre hat nichts zu
  // schichten (jede Kante geht zur Mitte) und legte alle Nachbarn in EINE Reihe. Bei mehreren
  // Treffern gibt es keine Mitte – ein Ring um irgendeinen von ihnen waere eine erfundene
  // Rangfolge, dort schichtet dagre (geclustert, s. o.) richtig.
  const radial = contextShown.value && egoCenterId.value != null
  const placed = radial
    ? layoutRadial({
        centerId: `c:${egoCenterId.value}`,
        ring: layoutNodes.filter((n) => n.id !== `c:${egoCenterId.value}` && n.id.startsWith('c:')),
        outer: layoutNodes.filter((n) => n.id.startsWith('p:')),
        scale: s,
      })
    : clustered
    ? layoutClustered({
        nodes: layoutNodes,
        edges,
        nodesep: 60 * s,
        ranksep: 90 * s,
        scale: s,
        minGroupSize: searchActive.value ? 2 : 1,
      })
    : layoutFlat({
        nodes: layoutNodes,
        edges,
        // Package-Ebene kompakter stapeln: dort zaehlen wenige, grosse Knoten – mit dem
        // Klassen-Abstand wuerde eine Kette aus 8 Packages so hoch, dass fitView() sie auf
        // Briefmarkengroesse zoomt.
        nodesep: (packageMode.value ? 120 : 90) * s,
        ranksep: (packageMode.value ? 70 : 110) * s,
        scale: s,
      })
  const posOf = (id) => placed.pos.get(id) || { x: 0, y: 0 }

  // Sichtbare Package-Zonen (Hintergrundflaechen). Beschriftet wird relativ zum geoeffneten
  // Pfad – der gemeinsame Praefix steht bereits im Breadcrumb und wuerde jede Zone nur verlaengern.
  const base = basePath.value
  const zoneLabel = (key) => {
    if (!key) return '(default)'
    if (base && key === base) return key.split('.').pop() || key
    if (base && key.startsWith(base + '.')) return key.slice(base.length + 1)
    return key
  }
  // Nachbar-Aggregate bekommen KEINE Zone: die Karte traegt den Package-Namen bereits, eine Box um
  // eine einzelne Box herum waere nur ein zweiter Rahmen um dieselbe Aussage. Im Meta-Layout
  // zaehlen sie trotzdem als eigene Gruppe – sie sollen ja neben dem Ausschnitt liegen, nicht darin.
  const relatedPaths = new Set(related.map((n) => n.path || '(default)'))
  const zones = (placed.zones || [])
    .filter((z) => !relatedPaths.has(z.key))
    .map((z) => ({
      ...z,
      label: zoneLabel(z.key),
      path: z.key === '(default)' ? '' : z.key,
      color: pkgColor.get(z.key) || PKG_COLORS[0],
    }))

  // Package-Knoten dieser Ebene (nur im Package-Modus). Sie tragen die Bilanz ihres Teilbaums:
  // Klassen, KI-Fortschritt, Zahl der Sub-Packages und die nach aussen laufenden Beziehungen.
  const pkgNodes = pkgGroups.map((grp) => {
    const nd = posOf(grp.id)
    return {
      id: grp.id,
      type: 'pkg',
      position: { x: nd.x - pkgW / 2, y: nd.y - pkgH / 2 },
      data: {
        path: grp.path,
        label: grp.label,
        classCount: grp.classCount,
        analyzedCount: grp.analyzedCount,
        methodCount: grp.methodCount,
        childCount: grp.childCount,
        hasChildren: grp.hasChildren,
        internal: grp.internal,
        external: grp.external,
        color: pkgColor.get(grp.path) || PKG_COLORS[grp.label.length % PKG_COLORS.length],
      },
    }
  })

  // Nachbar-Aggregate: dieselbe Karte, aber sichtbar „zweite Reihe" (data.related). Sie zeigen
  // NICHT die Bilanz eines Teilbaums, sondern seine Beruehrung mit dem Ausschnitt – wieviele
  // Klassen daran haengen und in welche Richtung.
  const relatedNodeList = related.map((n) => {
    const nd = posOf(n.id)
    return {
      id: n.id,
      type: 'pkg',
      position: { x: nd.x - pkgW / 2, y: nd.y - pkgH / 2 },
      data: {
        related: true,
        path: n.path,
        label: n.label,
        classCount: n.classCount,
        linkedCount: n.linkedCount,
        provides: n.provides,
        consumes: n.consumes,
        relations: n.relations,
        color: pkgColor.get(n.path || '(default)') || PKG_COLORS[n.label.length % PKG_COLORS.length],
      },
    }
  })

  const nodes = files.map((f) => {
    const pkg = f.package || '(default)'
    const id = `c:${f.id}`
    const nd = posOf(id)
    return {
      id,
      type: 'klass',
      // Das Layout liefert die Mitte -> Vue Flow erwartet die obere linke Ecke.
      position: { x: nd.x - nodeW / 2, y: nd.y - nodeH / 2 },
      data: {
        fileId: f.id,
        className: f.class_name,
        pkg,
        // Im Suchmodus: Treffer bleiben voll da, der mitgezeigte Kontext tritt zurueck. Dieselbe
        // Unterscheidung traegt die mitgezeigte Umgebung eines Packages – es ist derselbe
        // Sachverhalt („das hier ist der Kontext, nicht das Gesuchte"), also dieselbe Darstellung.
        isMatch: searchActive.value && matchIdSet.value.has(f.id),
        isContext: (searchActive.value && !matchIdSet.value.has(f.id)) || relatedIdSet.value.has(f.id),
        methodCount: f.method_count ?? (f.methods || []).length,
        // Feldzahl der Datenträger (NULL bei noch nicht neu analysierten Klassen -> die Karte
        // zeigt dann weiter die Methodenzahl statt einer erfundenen 0).
        fieldCount: f.field_count ?? null,
        color: pkgColor.get(pkg),
        role: roleFor(id),
        type: typeOf(f),
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

  return {
    nodes: [...pkgNodes, ...relatedNodeList, ...nodes],
    edges,
    zones,
    clustered,
    externalRefsHidden: externalRefs.size,
  }
})

const nodes = computed(() => layout.value.nodes)
// Package-Zonen (Hintergrund-Layer, s. Template). Leer, wenn flach gelayoutet wurde.
const zones = computed(() => layout.value.zones || [])
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

// --- Suche IM gezeichneten Graphen ------------------------------------------------------------
// Unterschied zum Klassenfilter der linken Spalte: DER bestimmt, was gezeichnet wird, und rechnet
// dafuer ein Layout. Diese Suche laesst das Bild stehen und beantwortet „wo ist das hier drin?" –
// sie setzt nur Treffer-/Daempfungs-Klassen, kostet also keinen dagre-Lauf, und nichts springt.
// Die Kanten pruefen sich selbst (ManagedEdge liest den Zustand aus dem Composable), damit bei
// jedem Tastendruck nicht der komplette Kanten-Store neu geschrieben wird.
const findInput = ref('')
const findCursor = ref(0)
const findFocused = ref(false)
const findField = ref(null)
const findQuery = computed(() => parseGraphQuery(findInput.value))

// Praefix-Chips: machen die Facetten entdeckbar, statt sie in einem Tooltip zu verstecken.
const FIND_HINTS = [
  { prefix: 'm:', label: 'method' },
  { prefix: 'c:', label: 'class' },
  { prefix: 'p:', label: 'package' },
  { prefix: 't:', label: 'type' },
  { prefix: 'r:', label: 'role' },
  { prefix: 'review:', label: 'uncertain edges' },
  { prefix: 'manual:', label: 'hand-made edges' },
]

// Getroffene Karten in ZEICHENreihenfolge -> „weiter" laeuft stabil durch dasselbe Bild.
const findNodeHits = computed(() => {
  const q = findQuery.value
  if (!q) return []
  return nodes.value.filter((n) => matchNode(n.data, q)).map((n) => n.id)
})
const findNodeHitSet = computed(() => new Set(findNodeHits.value))
// Eine Kante gilt als getroffen, wenn ihr Methodenname passt ODER sie zwei Treffer verbindet –
// zwischen zwei leuchtenden Karten eine gedaempfte Linie zu lassen, waere die halbe Aussage.
const findEdgeHits = computed(() => {
  const q = findQuery.value
  if (!q) return []
  const hits = findNodeHitSet.value
  return edges.value.filter((e) => matchEdge(e.data, q) || (hits.has(e.source) && hits.has(e.target)))
})
// Endpunkte getroffener Kanten bleiben stehen (gleiche Regel wie beim Kanten-Hover): eine Kante
// ist eine Aussage ueber zwei Klassen, und die will man dabei sehen.
const findEdgeEnds = computed(() => {
  const s = new Set()
  for (const e of findEdgeHits.value) {
    s.add(e.source)
    s.add(e.target)
  }
  return s
})
const findTotal = computed(() => findNodeHits.value.length + findEdgeHits.value.length)
const findCounter = computed(() => {
  if (!findQuery.value) return ''
  const n = findNodeHits.value.length
  const e = findEdgeHits.value.length
  if (!n && !e) return 'No match'
  const parts = []
  if (n) parts.push(`${n} class${n === 1 ? '' : 'es'}`)
  if (e) parts.push(`${e} edge${e === 1 ? '' : 's'}`)
  return parts.join(' · ')
})
// Ist eine Karte vom aktuellen Fund betroffen (selbst getroffen oder Endpunkt einer Treffer-Kante)?
function isFindHit(nodeId) {
  return findNodeHitSet.value.has(nodeId) || findEdgeEnds.value.has(nodeId)
}

// Zustand nach unten reichen: die Kanten lesen ihn selbst.
watch(findInput, (v) => setGraphQuery(v))
watch(findNodeHits, (ids) => setGraphHitNodes(ids), { immediate: true })
watch(findQuery, () => {
  findCursor.value = 0
})

// Von Treffer zu Treffer: der Graph faehrt hin, statt dass man ihn absucht. Karten zuerst, sonst
// die Endpunkte der getroffenen Kanten (bei `review:`/`m:` gibt es oft nur Kanten-Treffer).
const findTargets = computed(() => (findNodeHits.value.length ? findNodeHits.value : [...findEdgeEnds.value]))
function stepFind(delta) {
  const list = findTargets.value
  if (!list.length) return
  findCursor.value = ((findCursor.value + delta) % list.length + list.length) % list.length
  const node = nodes.value.find((n) => n.id === list[findCursor.value])
  if (!node) return
  // Bewusst `setCenter` statt `fitView([node])`: fitView rechnet einen eigenen Zoom aus dem
  // Padding und liess den Ausschnitt bei kleinen Treffermengen unveraendert. Hier soll nur die
  // Kamera fahren – der Zoom bleibt, wie der Nutzer ihn eingestellt hat (nur nach unten begrenzt,
  // damit ein Treffer im weit herausgezoomten Bild ueberhaupt lesbar ankommt).
  const w = (node.type === 'pkg' ? PKG_W : NODE_W) * rootScale.value
  const h = (node.type === 'pkg' ? PKG_H : NODE_H) * rootScale.value
  setCenter(node.position.x + w / 2, node.position.y + h / 2, {
    zoom: Math.max(viewport.value?.zoom ?? 1, 0.75),
    duration: 320,
  })
}
function clearFind() {
  findInput.value = ''
  findCursor.value = 0
  findField.value?.blur()
}
function applyHint(prefix) {
  findInput.value = prefix
  findField.value?.focus()
}

// Tastatur-Zugriff von aussen (CodeView routet die Kuerzel – EIN Handler, EINE Regel).
// Bewusst Methoden statt eines Props: „fokussiere jetzt" ist ein Ereignis, kein Zustand; als
// Prop braeuchte es einen Zaehler wie bei `focusToken`, nur um dasselbe zweimal ausloesen zu koennen.
function focusFind() {
  findField.value?.focus()
  findField.value?.select()
}
defineExpose({ focusFind, fitToView: () => fitView({ padding: 0.18, maxZoom: 1.15, duration: 200 }), drillUp })

// Canvas-Raster: ein einzelnes Linienraster, das mit dem Viewport wandert und beim Pannen
// Orientierung gibt. Deckkraft so gewaehlt, dass es als Gefuege lesbar bleibt, ohne mit den
// Knoten zu konkurrieren. Feste rgba-Werte statt color-mix: die Farbe landet als SVG-Attribut,
// nicht als CSS-Property.
const gridLineColor = computed(() => (theme.value === 'dark' ? 'rgba(196,186,143,0.065)' : 'rgba(133,126,97,0.09)'))

// --- Hover-Fokus -----------------------------------------------------------------------------
// Bei dicht liegenden Kanten hilft kein Layout mehr weiter – man muss EINE Beziehung isolieren
// koennen. Zeigt die Maus auf eine Klasse, bleiben nur sie, ihre direkten Nachbarn und die Kanten
// dazwischen stehen; alles andere faellt fast auf null zurueck. Die Kanten lesen den Zustand
// selbst (s. ManagedEdge), hier geht es nur um die Knoten.
const neighbours = computed(() => {
  const m = new Map()
  const add = (a, b) => {
    if (!m.has(a)) m.set(a, new Set())
    m.get(a).add(b)
  }
  for (const e of layout.value.edges) {
    add(e.source, e.target)
    add(e.target, e.source)
  }
  return m
})
function isDimmed(nodeId) {
  const h = hoveredNode.value
  // Reihenfolge mit Absicht: der Hover ist die feinere Geste und darf INNERHALB eines Suchergebnisses
  // weiter isolieren. Liegt die Maus nirgends, bestimmt die Suche das Bild.
  if (!h && !hoveredEdge.value && findQuery.value) return !isFindHit(nodeId)
  if (h) return h !== nodeId && !neighbours.value.get(h)?.has(nodeId)
  // Hover auf einer KANTE: nur ihre beiden Endpunkte bleiben stehen. Schaerfer als beim
  // Knoten-Hover (dort bleibt die ganze Nachbarschaft) – eine Kante ist genau eine Beziehung
  // zwischen genau zwei Klassen, und das soll man auch so sehen.
  const he = hoveredEdge.value
  if (he) return he.sourceId !== nodeId && he.targetId !== nodeId
  return false
}
// --- Identitaetsfarbe je Nachbar -------------------------------------------------------------
// Sechs Farben aus derselben Familie, die im Edge-Panel die Methoden auseinanderhaelt (`--mc-*`,
// s. lib/javaMethodColors.js). Bewusst kein siebter Farbraum: die Frage ist dieselbe – „welches
// dieser gleichartigen Dinge ist welches?" – und die Tokens sind bereits fuer beide Themes gesetzt.
const HOVER_COLORS = ['var(--mc-0)', 'var(--mc-1)', 'var(--mc-2)', 'var(--mc-3)', 'var(--mc-4)', 'var(--mc-5)']

// Nachbarn eines Knotens reihum einfaerben – nach ihrer LAGE im Bild, nicht nach ihrer Id: bei mehr
// als sechs Nachbarn wiederholen sich die Farben, und dann sollen die Wiederholungen moeglichst
// weit auseinander liegen. Zwei gleichfarbige Linien direkt nebeneinander waeren genau die
// Verwechslung, die die Faerbung aufloesen soll.
function neighbourPalette(nodeId) {
  const ns = neighbours.value.get(nodeId)
  if (!ns?.size) return null
  const pos = new Map(layout.value.nodes.map((n) => [n.id, n.position]))
  const sorted = [...ns].sort((a, b) => {
    const pa = pos.get(a) || { x: 0, y: 0 }
    const pb = pos.get(b) || { x: 0, y: 0 }
    return pa.x - pb.x || pa.y - pb.y
  })
  return new Map(sorted.map((id, i) => [id, HOVER_COLORS[i % HOVER_COLORS.length]]))
}

// Farbe, die eine Karte im Hover-Fokus traegt (Rahmen + Ring; der Streifen bleibt die ROLLE – was
// eine Klasse im Netz ist, aendert sich durch einen Hover nicht). Zwei Faelle, eine Regel: die
// Karte traegt die Farbe der Linie, die zu ihr fuehrt.
// - Hover auf einer KANTE: ihre beiden Endpunkte in deren Farbe.
// - Hover auf einem KNOTEN: jeder Nachbar in seiner Identitaetsfarbe, dieselbe wie die Linie
//   dorthin. Der gehoverte Knoten selbst bleibt neutral – er ist der Bezugspunkt, nicht eines der
//   unterschiedenen Dinge; eine siebte Farbe in der Mitte wuerde nur eine Zuordnung vortaeuschen.
function focusColor(nodeId) {
  const h = hoveredNode.value
  if (h) return h === nodeId ? null : hoverPalette.value?.get(nodeId) || null
  const he = hoveredEdge.value
  if (!he || (he.sourceId !== nodeId && he.targetId !== nodeId)) return null
  return he.color || 'var(--color-accent)'
}
// Hover-ABSICHT, dieselbe Regel wie an der Kante (s. ManagedEdge): eine Karte gilt erst als
// gemeint, wenn die Maus kurz auf ihr bleibt. Beim Queren eines dichten Feldes streift man sonst
// zwanzig Karten in einer Sekunde, und jede davon laesst saemtliche Knoten und Kanten ihre
// Daempfung neu bewerten – gemessen 20 Hauptthread-Blockaden auf einem einzigen Schwenk.
const NODE_HOVER_INTENT_MS = 90
let nodeHoverTimer = null
function onNodeEnter({ node }) {
  clearTimeout(nodeHoverTimer)
  const id = node?.id || null
  nodeHoverTimer = setTimeout(() => {
    // Knoten schlaegt Kante: liegt die Maus auf einer Karte, ist die Karte gemeint. Ohne das
    // Zuruecksetzen blieben beide Hervorhebungen gleichzeitig stehen und wuerden sich widersprechen.
    setHoveredEdge(null)
    // Die Palette entsteht genau hier, einmal je Hover – nicht als computed pro Karte: sie haengt
    // an der Nachbarschaft, und die aendert sich waehrend eines Hovers nicht.
    setHoveredNode(id, id ? neighbourPalette(id) : null)
  }, NODE_HOVER_INTENT_MS)
}
function onNodeLeave() {
  clearTimeout(nodeHoverTimer)
  setHoveredNode(null)
}
// Modul-State: beim Verlassen des Code-Tabs koennte sonst ein gedimmter Graph zurueckbleiben.
onUnmounted(() => {
  clearTimeout(nodeHoverTimer)
  setHoveredNode(null)
  setHoveredEdge(null)
})

function onNodeClick({ node }) {
  // Klick in den Graph (Node) -> transiente Code-Tab-Highlights verwerfen (Spec: „Node ohne Kante").
  clearHighlights()
  // Package-Knoten: eine Ebene tiefer. Hat er keine Sub-Packages mehr, zeigt die naechste Ebene
  // direkt die Klassen dieses Packages.
  // Ein Nachbar-Aggregat traegt keinen eigenen Inhalt, sondern einen Ort: der Klick oeffnet ihn –
  // damit ist der Weg aus einem Package zu seinem Gegenueber ein einziger Klick.
  if (node?.type === 'pkg') {
    // Im Suchmodus steht ein Aggregat fuer „und diese hier haengen auch dran". Ein Klick loest
    // genau DAS auf – schrittweise, statt in eine andere Ebene zu springen und den Ausschnitt zu
    // verlassen, um den es gerade geht.
    if (contextShown.value && node.data?.related) {
      toggleContextPackage(node.data.path || '')
      return
    }
    drillTo(node.data?.path || '')
    return
  }
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
function resetView() {
  setViewport({ x: 0, y: 0, zoom: 1 })
}

// Der Zonen-Layer liegt ausserhalb der Vue-Flow-Ebenen (einmal dahinter fuer die Flaeche, einmal
// davor fuer die klickbare Kopfzeile) und muss Pan/Zoom deshalb selbst nachfahren – exakt so, wie
// Vue Flow es intern mit seinem Viewport macht.
const viewportStyle = computed(() => ({
  transform: `translate(${viewport.value.x}px, ${viewport.value.y}px) scale(${viewport.value.zoom})`,
}))

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
    // Ein nextTick reicht NICHT: Vue Flow uebernimmt die neuen Knoten erst in seinem eigenen
    // Render-Durchlauf. Ohne das zusaetzliche Frame rechnet fitView() beim Ebenenwechsel noch mit
    // der alten Geometrie – der neue Ausschnitt haengt dann halb ausserhalb des Canvas.
    // Steht ein Klassen-Klick aus dem Baum an, wird DIESER Knoten angefahren statt der ganzen
    // Ebene – sonst laege die gesuchte Klasse irgendwo im Raster und man muesste sie suchen.
    const focusId = pendingFocusNode.value
    const hasFocus = focusId && nodes.value.some((n) => n.id === focusId)
    // maxZoom deckelt, damit einzelne Knoten nicht auf Plakatgroesse aufgeblasen werden – aber
    // nicht mehr bei exakt 1: ein Graph aus wenigen Klassen liess damit den halben Canvas leer,
    // waehrend die Karten unnoetig klein blieben.
    const fit = () =>
      hasFocus
        ? fitView({ nodes: [{ id: focusId }], padding: 1.6, maxZoom: 1.25, duration: 300 })
        : fitView({ padding: 0.18, maxZoom: 1.15, duration: 200 })
    if (hasFocus) pendingFocusNode.value = null
    requestAnimationFrame(fit)
    // Zweiter Anlauf: fitView rechnet mit den GEMESSENEN Knotengroessen. Werden viele Knoten auf
    // einmal ausgetauscht (Ebenenwechsel: 8 Packages -> 125 Klassen), sind die neuen im ersten
    // Frame noch nicht vermessen und der Ausschnitt bliebe halb ausserhalb des Canvas.
    setTimeout(fit, 280)
  },
)

// --- Edge-Detail-Panel fuer angeklickte Auto-Call-Edges -----------------------
// Die Call-Sites werden erst beim Klick fuer das konkrete Klassenpaar + Methode berechnet
// (rein zur Anzeige; die Existenz der Kante kommt aus dem Backend). Manuelle Kanten haben
// keinen verifizierbaren Quellcode -> oeffnen das Panel nicht.
const activeEdge = ref(null)
// Laeuft, waehrend die Methodenruempfe fuer das Edge-Panel nachgeladen werden (s. methodsOf).
const edgePanelLoading = ref(false)

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
      // Unsicherer Auto-Treffer (confidence < 1): das Panel erklaert ihn – bis hierher wurde die
      // Angabe verworfen, das „Please review" am Kanten-Label blieb im Modal unbeantwortet.
      confidence: meta.confidence ?? 1,
      needsReview: !!meta.needsReview,
    })
  }
  const single = panelMethods.length === 1
  return {
    kind: 'call',
    bundleCount: panelMethods.length,
    // Pro-Methoden-Liste (Panel-Anzeige + Per-Methoden-Aktionen/Footer-Loeschen).
    methods: panelMethods,
    // Traegt IRGENDEINE Methode einen unsicheren Treffer? -> Hinweis im Modal-Kopf.
    needsReview: panelMethods.some((p) => p.needsReview),
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
// Methoden-Detail (inkl. Ruempfe) einer Klasse holen und merken. Die Dateiliste traegt die
// Ruempfe NICHT mehr mit: bei 5000 Klassen waere das ein zweistelliger MB-Betrag beim Laden der
// Seite – gebraucht werden sie aber nur hier, beim Klick auf eine Kante.
const methodCache = new Map() // fileId -> methods[]
async function methodsOf(fileId) {
  if (methodCache.has(fileId)) return methodCache.get(fileId)
  const full = await getFile(fileId)
  const list = full?.methods || []
  methodCache.set(fileId, list)
  return list
}
// Dateiliste aenderte sich (neue Analyse/Loeschen) -> gecachte Ruempfe koennen veraltet sein.
watch(
  () => (props.files || []).map((f) => `${f.id}:${f.version ?? 1}`).join(','),
  () => methodCache.clear(),
)

async function openEdgePanel(d) {
  try {
    // Auto- UND manuelle Call-Kanten oeffnen das Modal (manuelle haben ggf. keine verifizierten
    // Aufrufstellen -> der Verwendung-Abschnitt zeigt dann einen leeren Zustand).
    if (!d || d.kind !== 'call') return
    // Gebuendelte Kante traegt d.methods; Einzel-Fallback aus d.method (z. B. Modal-Edit-Reopen).
    const methodList = d.methods?.length
      ? d.methods
      : d.method
        ? [{ edgeId: d.edgeId, method: d.method, isManual: d.isManual, confidence: d.confidence, needsReview: d.needsReview }]
        : []
    if (!methodList.length) return
    const callerFile = filesById.value.get(d.fromFileId)
    const definerFile = filesById.value.get(d.toFileId)
    if (!callerFile || !definerFile) {
      console.warn('[JavaGraph] Edge-Panel: Klasse(n) nicht in der Dateiliste gefunden', d)
      return
    }
    edgePanelLoading.value = true
    try {
      const [callerMethods, definerMethods] = await Promise.all([
        methodsOf(d.fromFileId),
        methodsOf(d.toFileId),
      ])
      activeEdge.value = computeCallEdgeData(
        { ...callerFile, methods: callerMethods },
        { ...definerFile, methods: definerMethods },
        methodList,
        { isManual: d.isManual },
      )
    } finally {
      edgePanelLoading.value = false
    }
  } catch (e) {
    console.warn('[JavaGraph] Edge-Panel konnte nicht geöffnet werden', d, e)
  }
}

// --- Aggregatkante aufloesen ("N class relations") --------------------------------------------
// Eine Kante zwischen zwei Package-Knoten steht fuer viele Klassenbeziehungen. Ohne Aufloesung
// bleibt sie eine Zahl, die man nicht pruefen kann. Der Klick listet deshalb genau die Paare auf,
// die darin stecken – und von dort fuehrt ein weiterer Klick auf die Aufrufstelle im Code.
const activeBundle = ref(null) // { fromLabel, toLabel, relations: [...] }

// Ebenen-Schluessel (`p:<path>` | `c:<id>`) lesbar machen: der Pfad relativ zum offenen Ausschnitt.
function labelForKey(key) {
  if (!key) return ''
  if (key.startsWith('c:')) return filesById.value.get(Number(key.slice(2)))?.class_name || key
  const path = key.slice(2)
  const base = basePath.value
  if (base && path.startsWith(base + '.')) return path.slice(base.length + 1)
  return path
}

// Alle Klassenbeziehungen zwischen zwei Ebenen-Knoten, gruppiert nach Klassenpaar. Richtung wie
// im Graph: `provider` definiert, `consumer` nutzt. Die Kanten kommen aus derselben Quelle wie
// im Layout (serverEdges + Import-Fallback), damit die Liste die gezeichnete Zahl exakt trifft.
// Ebenen-Schluessel ALLER aufloesbaren Knoten: der Ausschnitt und seine Umgebung. Ohne die
// Umgebung liefe der Klick auf eine Kante „Ausschnitt -> Nachbar-Package" ins Leere – die fremden
// Klassen haetten keinen Knoten, dem sie zugeordnet sind.
const bundleKeys = computed(() => {
  const m = new Map(insideKeys.value)
  for (const [id, key] of neighbourhood.value.keyByFileId) if (!m.has(id)) m.set(id, key)
  return m
})

function relationsBetween(sourceKey, targetKey) {
  const keyOf = bundleKeys.value
  const files = props.files || []
  const byName = new Map(files.map((f) => [f.class_name, f]))
  const groups = new Map()
  const add = (provider, consumer, kind, method) => {
    const k = `${provider.id}->${consumer.id}`
    let g = groups.get(k)
    if (!g) {
      g = { key: k, provider, consumer, kind, methods: [] }
      groups.set(k, g)
    }
    // Ein Paar kann mehrere Kantenarten haben – die staerkste Aussage gewinnt fuer das Badge.
    if (kind === 'call' || (kind === 'uses' && g.kind === 'import')) g.kind = kind
    if (method) g.methods.push(method)
  }

  for (const e of serverEdges.value || []) {
    const consumer = byName.get(e.source_class)
    const provider = byName.get(e.target_class)
    if (!consumer || !provider || consumer.id === provider.id) continue
    if (keyOf.get(provider.id) !== sourceKey || keyOf.get(consumer.id) !== targetKey) continue
    add(
      provider,
      consumer,
      e.kind || 'call',
      e.kind === 'uses'
        ? null
        : {
            edgeId: e.id,
            method: e.method_name,
            isManual: !!e.is_manual,
            confidence: e.confidence,
            needsReview: !e.is_manual && e.confidence < 1,
          },
    )
  }
  // Import-Fallback: nur fuer Paare, die noch gar keine Beziehung haben (wie im Graph).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      const provider = byName.get(simpleName(dep))
      if (!provider || provider.id === f.id) continue
      if (keyOf.get(provider.id) !== sourceKey || keyOf.get(f.id) !== targetKey) continue
      if (groups.has(`${provider.id}->${f.id}`)) continue
      add(provider, f, 'import', null)
    }
  }

  const rank = { call: 0, uses: 1, import: 2 }
  return [...groups.values()].sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      a.provider.class_name.localeCompare(b.provider.class_name) ||
      a.consumer.class_name.localeCompare(b.consumer.class_name),
  )
}

function openBundlePanel(d) {
  if (!d || d.kind !== 'aggregate') return
  const relations = relationsBetween(d.sourceId, d.targetId)
  activeBundle.value = {
    fromLabel: labelForKey(d.sourceId),
    toLabel: labelForKey(d.targetId),
    fromIsClass: String(d.sourceId).startsWith('c:'),
    toIsClass: String(d.targetId).startsWith('c:'),
    count: d.count,
    relations,
  }
}
function closeBundlePanel(reason) {
  rememberReturn(reason, 'bundle', activeBundle.value)
  activeBundle.value = null
}
// Aufrufstellen einer einzelnen Beziehung ermitteln – dieselbe Rechnung wie fuer das
// Edge-Detail-Modal, nur ohne es zu oeffnen. Das Bundle-Panel zeigt den Code damit INLINE; die
// Methodenruempfe kommen aus dem gemeinsamen `methodCache` (die Dateiliste traegt sie nicht).
// Wird als Funktions-Prop hineingereicht: dieselbe Bauweise wie `data.onOpen` an den Kanten.
async function loadRelationDetail(rel) {
  const callerFile = filesById.value.get(rel?.consumer?.id)
  const definerFile = filesById.value.get(rel?.provider?.id)
  if (!callerFile || !definerFile) return null
  const [callerMethods, definerMethods] = await Promise.all([methodsOf(callerFile.id), methodsOf(definerFile.id)])
  return computeCallEdgeData(
    { ...callerFile, methods: callerMethods },
    { ...definerFile, methods: definerMethods },
    rel.methods || [],
  )
}
// Aus der Liste heraus zur Aufrufstelle: dieselbe Funktion wie beim Klick auf eine Call-Kante,
// also derselbe Code-Auszug – nur eben ohne dass man erst ins Package hineinzoomen muss.
function openRelationCode(rel) {
  if (!rel?.methods?.length) return
  openEdgePanel({
    kind: 'call',
    fromFileId: rel.consumer.id, // Aufrufer
    toFileId: rel.provider.id, // Definition
    methods: rel.methods,
    isManual: rel.methods.every((m) => m.isManual),
  })
}

function onEdgeClick({ edge }) {
  const d = edge?.data
  // Neue Kante angesehen -> ein gemerkter Rueckweg zur alten fuehrt nur noch in die Irre.
  clearEdgeReturn()
  if (d?.kind === 'aggregate') return openBundlePanel(d)
  openEdgePanel(d)
}
function closeEdgePanel(reason) {
  rememberReturn(reason, 'edge', activeEdge.value)
  activeEdge.value = null
}

// --- Rueckweg aus dem Code zurueck zur Kante -------------------------------------------------
// Schliesst ein Panel, WEIL in den Quellcode gesprungen wurde, merken wir uns seinen Zustand.
// CodeView blendet daraufhin einen Zurueck-Knopf ein; ein Klick darauf stellt exakt dieses Panel
// wieder her (der Zustand IST die Wiederherstellung – nichts wird neu berechnet).
function rememberReturn(reason, kind, payload) {
  if (reason !== 'navigate' || !payload) {
    // Per ESC/× geschlossen: der Nutzer ist fertig mit der Kante, ein Rueckweg waere Ballast.
    clearEdgeReturn()
    return
  }
  const label =
    kind === 'bundle'
      ? `${payload.fromLabel} → ${payload.toLabel}`
      : `${payload.fromClass} → ${payload.toClass}`
  setEdgeReturn({ kind, label, payload })
}

watch(edgeReturnToken, () => {
  const t = edgeReturn.value
  if (!t) return
  if (t.kind === 'bundle') activeBundle.value = t.payload
  else activeEdge.value = t.payload
  clearEdgeReturn() // einmaliger Rueckweg: das Panel steht wieder offen, der Knopf hat sich erledigt
})

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

    <!-- Wartemeldung ueber dem Canvas. Sie wird VOR der Rechnung gesetzt und zwei Frames lang
         gemalt, sonst kaeme sie nie ins Bild: dagre laeuft synchron und blockiert den Hauptthread
         (s. withLayoutBusy). Gleiche Form wie in Palette, Klassen-Panel und Artikelansicht. -->
    <BusyState
      v-if="layoutBusy"
      variant="overlay"
      :title="layoutBusy.title"
      :detail="layoutBusy.detail"
      :hint="layoutBusy.hint"
      :since="layoutBusy.since"
    />

    <!-- Package-Zonen, Flaeche: liegt HINTER dem Canvas, damit Kanten und Knoten darueber laufen.
         Rein dekorativ (pointer-events: none) – geklickt wird die Kopfzeile im vorderen Layer. -->
    <div v-if="files.length && zones.length" class="vf-zonelayer" :style="viewportStyle">
      <div
        v-for="z in zones"
        :key="z.key"
        class="vf-zone"
        :style="{ left: `${z.x}px`, top: `${z.y}px`, width: `${z.width}px`, height: `${z.height}px`, '--pkg': z.color }"
      />
    </div>

    <!-- Kein v-else mehr: der Zonen-Layer steht dazwischen (und muss dort stehen, damit er im
         Stapel unter dem Canvas liegt). Unmounten bei leerer Dateiliste macht das v-if genauso. -->
    <VueFlow
      v-if="files.length"
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
      @node-mouse-enter="onNodeEnter"
      @node-mouse-leave="onNodeLeave"
      @edge-click="onEdgeClick"
      @pane-click="clearHighlights"
      @connect="onConnect"
    >
      <!-- Custom Node: kompaktes Card-Design, Akzentfarbe nach ROLLE (Streifen/Badge/Ring);
           Package steckt nur noch im kleinen .vf-pkgdot vor dem Package-Text. -->
      <template #node-klass="{ data }">
        <div
          class="vf-card"
          :class="[
            `vf-role-${data.role}`,
            {
              'vf-card--selected': selectedId === data.fileId,
              'vf-card--match': data.isMatch,
              'vf-card--context': data.isContext,
              'vf-card--dim': isDimmed(`c:${data.fileId}`),
              'vf-card--focus': !!focusColor(`c:${data.fileId}`),
              'vf-card--find': findNodeHitSet.has(`c:${data.fileId}`),
            },
          ]"
          :style="{ '--pkg': data.color, '--edge': focusColor(`c:${data.fileId}`) }"
        >
          <Handle type="target" :position="Position.Top" class="vf-handle" />
          <span class="vf-strip" />
          <div class="vf-body">
            <div class="vf-name">
              <!-- Slot 1: WAS ist das? Java-Elementtyp als farbiges Chip. -->
              <span
                class="vf-type"
                :class="{ 'vf-type--plain': data.type === 'class' }"
                :style="{ '--type': TYPE_META[data.type].color }"
                :title="TYPE_META[data.type].label"
                :aria-label="TYPE_META[data.type].label"
              >
                <Icon :icon="TYPE_META[data.type].icon" />
              </span>
              <Icon v-if="data.analyzed" icon="lucide:sparkles" class="vf-ai" title="AI-analyzed" />{{ data.className }}
            </div>
            <div class="vf-pkg">
              <span class="vf-pkgdot" :title="data.pkg" />{{ data.pkg }}
            </div>
          </div>
          <!-- Version erst ab v2: „v1" ist der Normalfall und kostet nur Platz, den der
               Klassenname besser gebraucht. Eine Historie dagegen ist eine echte Aussage. -->
          <span
            v-if="data.version > 1"
            class="vf-version vf-version--multi"
            :title="`Version ${data.version} — this class has a history`"
          >v{{ data.version }}</span>
          <!-- Slot 2: WIE haengt es drin? Rolle + Umfang als eine Einheit (Glyph + Methodenzahl). -->
          <span
            class="vf-badge"
            :title="`${ROLE_META[data.role].label} — ${ROLE_META[data.role].hint} · ${nodeMetric(data).label}`"
          >
            <Icon :icon="ROLE_META[data.role].icon" class="vf-badge-ic" />{{ nodeMetric(data).value }}
          </span>
          <Handle type="source" :position="Position.Bottom" class="vf-handle" />
        </div>
      </template>

      <!-- Package-Knoten: Aggregat eines ganzen Teilbaums. Klick = eine Ebene tiefer.
           Zwei Auspraegungen, EINE Karte: ein Knoten DIESER Ebene traegt die Bilanz seines
           Teilbaums (Klassen, Sub-Packages, KI-Fortschritt), ein NACHBAR ausserhalb des
           Ausschnitts traegt seine Beruehrung mit ihm (verbundene Klassen, Richtung). Beides sind
           Packages – deshalb dieselbe Form; nur was sie sagen, ist verschieden. -->
      <template #node-pkg="{ data }">
        <div
          class="vf-pkgcard"
          :class="{
            'vf-pkgcard--related': data.related,
            'vf-card--dim': isDimmed(`p:${data.path}`),
            'vf-card--focus': !!focusColor(`p:${data.path}`),
            'vf-card--find': findNodeHitSet.has(`p:${data.path}`),
          }"
          :style="{ '--pkg': data.color, '--edge': focusColor(`p:${data.path}`) }"
          :title="data.related
            ? `${data.path || '(default)'} — outside this scope, ${data.relations} relation${data.relations === 1 ? '' : 's'}. Click to open.`
            : `${data.path} — click to open`"
        >
          <Handle type="target" :position="Position.Top" class="vf-handle" />
          <span class="vf-strip" />
          <div class="vf-pkgbody">
            <div class="vf-pkgname">
              <Icon
                :icon="data.related ? 'lucide:share-2' : data.hasChildren ? 'lucide:folder' : 'lucide:package'"
                class="vf-pkgicon"
              />
              {{ data.label }}
              <span v-if="data.related" class="vf-pkgtag">related</span>
            </div>
            <!-- Nachbar: die Zahlen beschreiben die BEZIEHUNG, nicht den Teilbaum. Richtung mit
                 denselben Glyphen wie die Rollen auf der Klassenkarte (Pfeil nach unten =
                 liefert, Pfeil nach oben = nutzt) – der Graph fliesst ueberall gleich. -->
            <div v-if="data.related" class="vf-pkgmeta">
              <span class="vf-pkgstat" :title="`${data.linkedCount} of ${data.classCount} classes touch this scope`">
                <b>{{ data.linkedCount }}</b> linked
              </span>
              <span v-if="data.provides" class="vf-pkgstat vf-pkgstat--ext" title="Used by this scope">
                <Icon icon="lucide:arrow-down" class="vf-pkgic" />{{ data.provides }}
              </span>
              <span v-if="data.consumes" class="vf-pkgstat vf-pkgstat--ext" title="Uses this scope">
                <Icon icon="lucide:arrow-up-from-line" class="vf-pkgic" />{{ data.consumes }}
              </span>
            </div>
            <template v-else>
              <div class="vf-pkgmeta">
                <span class="vf-pkgstat"><b>{{ data.classCount }}</b> classes</span>
                <span v-if="data.childCount" class="vf-pkgstat"><b>{{ data.childCount }}</b> sub</span>
                <span v-if="data.external" class="vf-pkgstat vf-pkgstat--ext" title="Relations leaving this package">
                  <Icon icon="lucide:arrow-up-from-line" class="vf-pkgic" />{{ data.external }}
                </span>
              </div>
              <!-- KI-Fortschritt des Teilbaums: schmaler Balken, damit man sieht, wo noch Arbeit liegt. -->
              <div class="vf-pkgbar" :title="`${data.analyzedCount}/${data.classCount} analyzed`">
                <span :style="{ width: (data.classCount ? (data.analyzedCount / data.classCount) * 100 : 0) + '%' }" />
              </div>
            </template>
          </div>
          <Handle type="source" :position="Position.Bottom" class="vf-handle" />
        </div>
      </template>

      <Background variant="lines" :gap="110" :line-width="1" :color="gridLineColor" />
    </VueFlow>

    <!-- Package-Zonen, Kopfzeile: liegt VOR dem Canvas, weil das Vue-Flow-Pane sonst jeden Klick
         abfaengt. Der Layer selbst ist durchlaessig, nur die Pille nimmt Klicks an – sie sitzt im
         Kopfbereich der Zone, den das Layout freihaelt, und ueberdeckt daher keinen Knoten. -->
    <div v-if="files.length && zones.length" class="vf-zonelayer vf-zonelayer--front" :style="viewportStyle">
      <button
        v-for="z in zones"
        :key="z.key"
        type="button"
        class="vf-zonehead"
        :style="{ left: `${z.x + 12}px`, top: `${z.y + 10}px`, maxWidth: `${z.width - 24}px`, '--pkg': z.color }"
        :title="`${z.key} — show only this package`"
        @click="drillTo(z.path)"
      >
        <Icon icon="lucide:folder" class="vf-zoneic" />
        <span class="vf-zonename">{{ z.label }}</span>
        <span class="vf-zonecount">{{ z.count }}</span>
      </button>
    </div>

    <!-- ===== Leiste links: WO bin ich, WAS ist im Bild ==========================================
         Vorher lagen hier zwei bis drei horizontale Balken uebereinander – der Pfad wuchs mit jeder
         Ebene nach rechts und lief irgendwann unter das Suchfeld oben rechts, die Ego-Leiste
         darunter noch einmal. Vertikal waechst der Pfad dorthin, wo Platz ist (nach unten), liest
         sich wie der Baum in der linken Spalte und kollidiert mit nichts. Eine Leiste, drei
         Abschnitte: Ort · Bilanz · Ego-Regler. -->
    <div v-if="files.length && (searchActive || level.groups.length || basePath)" class="vf-rail">
      <!-- 1) Ort. Im Suchmodus ist der Ort die Anfrage: ein Pfad waere dort keine gueltige
              Ortsangabe mehr (die Treffer liegen quer durch die Codebasis). -->
      <div v-if="searchActive" class="vf-rail-sec">
        <div class="vf-rail-head">
          <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span class="min-w-0 flex-1 truncate font-mono text-2xs text-[var(--color-text)]">“{{ searchQuery }}”</span>
          <button
            type="button"
            class="vf-rail-x"
            v-tip="{ title: 'Clear the filter', hint: 'Back to the package level.' }"
            @click="emit('clear-search')"
          >
            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
          </button>
        </div>
        <div class="vf-rail-stats">
          <span class="vf-crumb-count">{{ searchScope.matches }} match{{ searchScope.matches === 1 ? '' : 'es' }}</span>
          <span v-if="searchScope.relations" class="vf-crumb-count">
            {{ searchScope.relations }} relation{{ searchScope.relations === 1 ? '' : 's' }}
          </span>
        </div>
      </div>

      <!-- Pfad als Stufen untereinander: jede Zeile eine Ebene, eingerueckt wie im Baum. Die
           aktuelle traegt den Punkt und ist nicht klickbar – man steht ja schon dort. -->
      <div v-else class="vf-rail-sec">
        <button
          v-for="(c, i) in breadcrumb"
          :key="c.path || 'root'"
          type="button"
          class="vf-rail-step"
          :class="{ 'is-current': c.path === basePath }"
          :style="{ paddingLeft: `${6 + i * 10}px` }"
          :disabled="c.path === basePath"
          v-tip="c.path === basePath ? null : { title: `Open ${c.label}`, hint: 'One level up in the package tree.' }"
          @click="drillTo(c.path)"
        >
          <Icon
            :icon="c.path === basePath ? 'lucide:package-open' : 'lucide:chevron-right'"
            class="vf-rail-stepic"
          />
          <span class="truncate">{{ c.label }}</span>
        </button>
        <div class="vf-rail-stats">
          <span class="vf-crumb-count">{{ scopeClassCount }} classes</span>
          <!-- Was die Umgebung beitraegt. Ohne diese Zeile waere nicht zu unterscheiden, was zum
               geoeffneten Pfad gehoert und was nur danebensteht. -->
          <span
            v-if="relatedSummary"
            class="vf-crumb-rel"
            v-tip="{ title: 'Neighbours', hint: relatedSummary.classes
              ? `${relatedSummary.relations} relations to ${relatedSummary.classes} classes outside this scope`
              : `${relatedSummary.relations} relations to ${relatedSummary.packages} packages outside this scope` }"
          >
            <Icon icon="lucide:share-2" class="h-3 w-3" />
            +{{ relatedSummary.classes || relatedSummary.packages }}
            {{ relatedSummary.classes ? 'related' : relatedSummary.packages === 1 ? 'package' : 'packages' }}
          </span>
          <!-- Gedeckelte Umgebung: die uebrigen Nachbarn werden genannt, nicht verschwiegen. -->
          <span
            v-if="relatedSummary && relatedSummary.hiddenPackages"
            class="vf-crumb-warn"
            v-tip="{ title: `${relatedSummary.hiddenPackages} more packages`, hint: `${relatedSummary.hiddenRelations} relations to further packages are not drawn — open a smaller scope to see them.` }"
          >
            <Icon icon="lucide:alert-triangle" class="h-3 w-3" />
            +{{ relatedSummary.hiddenPackages }} more
          </span>
          <!-- Zu unscharfe Suche: der Graph bleibt, wo er ist, statt hunderte Treffer zu markieren. -->
          <span
            v-if="searchTooBroad"
            class="vf-crumb-warn"
            v-tip="{ title: 'Too many matches', hint: 'Narrow the filter to focus the graph on them.' }"
          >
            <Icon icon="lucide:search" class="h-3 w-3" />
            {{ matchIds.length }} matches
          </span>
          <!-- Abgeschnittener Ausschnitt: nie stillschweigend – sonst liest man einen
               unvollstaendigen Graphen als vollstaendig. -->
          <span
            v-if="truncatedClasses"
            class="vf-crumb-warn"
            v-tip="{ title: `${truncatedClasses} classes hidden`, hint: `Only the first ${CLASS_RENDER_LIMIT} are drawn — open a package for the full picture.` }"
          >
            <Icon icon="lucide:alert-triangle" class="h-3 w-3" />
            {{ truncatedClasses }} hidden
          </span>
        </div>
      </div>

      <!-- 2) Umgebung: EINE Leiter fuer einen wie fuer sechsundzwanzig Treffer. Bei 132 Nachbarn
              ist weder „alle" noch „vierzig" die Antwort – die Frage ist, wieviel man gerade sehen
              WILL. Stufen statt Schieberegler: jeder Schritt kostet genau ein Layout und ist
              ruecknehmbar. Die Leiste steht auch auf Stufe 0 da, sonst gaebe es keinen Weg
              zurueck nach oben. -->
      <div v-if="contextAvailable" class="vf-rail-sec">
        <div class="vf-rail-head">
          <Icon icon="lucide:git-fork" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span class="vf-ego-label">Context</span>
          <span class="vf-ego-count">
            <b>{{ contextLevel.cardCount }}</b>/{{ searchScope.related }}
          </span>
        </div>
        <div class="vf-rail-stats">
          <span class="vf-crumb-count">
            {{ contextBudget ? 'related classes' : 'matches only' }}
          </span>
          <span v-if="contextLevel.nodes.length" class="vf-crumb-count">
            {{ contextLevel.aggregatedClasses }} in {{ contextLevel.nodes.length }} pkg
          </span>
          <span
            v-if="contextLevel.hiddenPackages"
            class="vf-crumb-warn"
            v-tip="{ title: `${contextLevel.hiddenPackages} more packages`, hint: `${contextLevel.hiddenRelations} further relations are not drawn — raise the step or open a package.` }"
          >
            <Icon icon="lucide:alert-triangle" class="h-3 w-3" />
            +{{ contextLevel.hiddenPackages }}
          </span>
        </div>

        <div class="vf-ego-step">
          <button
            type="button"
            class="vf-ego-btn"
            :disabled="contextBudget <= contextSteps[0]"
            v-tip="{ title: 'Show less', hint: 'One step down — the rest folds back into its packages.' }"
            @click="stepContext(-1)"
          >
            <Icon icon="lucide:minus" class="h-3.5 w-3.5" />
          </button>
          <span class="vf-ego-hint">{{ contextBudget ? `${contextBudget === searchScope.related ? 'all' : contextBudget} as cards` : 'no context' }}</span>
          <button
            type="button"
            class="vf-ego-btn"
            :disabled="contextBudget >= searchScope.related"
            v-tip="{ title: 'Show more', hint: 'One step up — more neighbours become single cards.' }"
            @click="stepContext(1)"
          >
            <Icon icon="lucide:plus" class="h-3.5 w-3.5" />
          </button>
        </div>
        <!-- Die Stufen selbst: wer weiss, wieviel er sehen will, springt direkt hin. „0" ist das
             frühere „Hide related" – jetzt die unterste Sprosse derselben Leiter. -->
        <div class="vf-ego-ticks">
          <button
            v-for="s in contextSteps"
            :key="s"
            type="button"
            class="vf-ego-tick"
            :class="{ 'is-on': contextBudget === s }"
            v-tip="s === 0
              ? { title: 'Matches only', hint: 'Hides the surrounding classes entirely.' }
              : { title: `${s === searchScope.related ? 'All' : s} neighbour${s === 1 ? '' : 's'} as cards`, hint: 'The rest stays in the picture as one node per package.' }"
            @click="setContextBudget(s)"
          >{{ s === searchScope.related ? 'all' : s }}</button>
        </div>

        <!-- Aufgeklappte Packages: der Chip IST der Rueckweg – ihr Aggregatknoten ist ja weg. -->
        <div v-if="contextLevel.expandedPaths.length" class="vf-rail-chips">
          <button
            v-for="p in contextLevel.expandedPaths"
            :key="p"
            type="button"
            class="vf-ego-chip"
            v-tip="{ title: `Collapse ${p}`, hint: 'Folds these classes back into one aggregate node.' }"
            @click="toggleContextPackage(p)"
          >
            <Icon icon="lucide:package-open" class="h-3 w-3 shrink-0" />
            <span class="truncate">{{ p }}</span>
            <Icon icon="lucide:x" class="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </div>
      </div>
    </div>


    <!-- Suche IM Bild (oben rechts, die einzige freie Ecke). Sie aendert den Ausschnitt nicht –
         sie sagt, wo im aktuellen Graphen etwas steckt, und daempft den Rest. -->
    <div v-if="files.length" class="vf-find" :class="{ 'is-active': !!findQuery }">
      <div class="vf-find-row">
        <Icon icon="lucide:search" class="vf-find-icon" />
        <input
          ref="findField"
          v-model="findInput"
          type="text"
          class="vf-find-input"
          placeholder="Find in graph…"
          aria-label="Find in graph"
          spellcheck="false"
          :title="GRAPH_QUERY_HELP"
          @focus="findFocused = true"
          @blur="findFocused = false"
          @keydown.enter.prevent="stepFind($event.shiftKey ? -1 : 1)"
          @keydown.esc.prevent="clearFind"
        />
        <span v-if="findQuery" class="vf-find-count" :class="{ 'is-empty': !findTotal }">{{ findCounter }}</span>
        <button
          type="button"
          class="vf-find-btn"
          title="Previous hit (Shift+Enter)"
          :disabled="!findTargets.length"
          @click="stepFind(-1)"
        >
          <Icon icon="lucide:chevron-up" class="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          class="vf-find-btn"
          title="Next hit (Enter) — the graph moves to it"
          :disabled="!findTargets.length"
          @click="stepFind(1)"
        >
          <Icon icon="lucide:chevron-down" class="h-3.5 w-3.5" />
        </button>
        <button v-if="findInput" type="button" class="vf-find-btn" title="Clear (Esc)" @click="clearFind">
          <Icon icon="lucide:x" class="h-3.5 w-3.5" />
        </button>
      </div>
      <!-- Die Facetten stehen nicht in einem Tooltip, den niemand oeffnet: sie erscheinen beim
           ersten Klick ins leere Feld und tragen sich per Klick selbst ein. -->
      <div v-if="findFocused && !findInput" class="vf-find-hints">
        <button
          v-for="h in FIND_HINTS"
          :key="h.prefix"
          type="button"
          class="vf-find-hint"
          @mousedown.prevent="applyHint(h.prefix)"
        >
          <code>{{ h.prefix }}</code>{{ h.label }}
        </button>
      </div>
    </div>

    <!-- Hier stand die Schaltflaeche „Show N related classes" mittig ueber dem Graphen. Sie ist in
         die Leiste links gewandert und dort zur Stufenleiter geworden: dieselbe Frage wie beim
         einzelnen Treffer, deshalb dieselbe Bedienung an derselben Stelle – und statt „alles oder
         nichts" eine Stufe, die zum Ergebnis passt. -->

    <!-- Canvas-Chrome unten: Werkzeuge links, Legende rechts. Beide schweben am unteren Rand,
         damit die obere Canvas-Haelfte (wo dagre die Wurzelknoten setzt) frei bleibt. -->
    <div v-if="files.length" class="vf-dock vf-dock--left">
      <button
        type="button"
        class="vf-tool"
        v-tip="{ title: 'Zoom in' }"
        @click="zoomIn()"
      >
        <Icon icon="lucide:zoom-in" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" v-tip="{ title: 'Zoom out' }" @click="zoomOut()">
        <Icon icon="lucide:zoom-out" class="h-4 w-4" />
      </button>
      <span class="vf-dock-sep" />
      <button type="button" class="vf-tool" v-tip="{ title: 'Fit to view', hint: 'Also on the 0 key.' }" @click="fitView()">
        <Icon icon="lucide:maximize" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" v-tip="{ title: 'Reset view', hint: 'Back to 100 % at the origin.' }" @click="resetView">
        <Icon icon="lucide:rotate-ccw" class="h-4 w-4" />
      </button>

      <!-- Ebene: Packages oder Klassen. Der Umschalter stand am ENDE der Kopfzeile oben links –
           und rutschte dort bei langen Pfaden unter das Suchfeld oben rechts. Er gehoert ohnehin
           hierher: das Dock beantwortet „was wird gezeichnet?", die Kopfzeile „wo bin ich?".
           Als Segment statt als Wechselknopf, weil ein Wechselknopf immer den ANDEREN Zustand
           beschriftet – man liest „Classes" und ist in der Package-Ebene. -->
      <template v-if="level.groups.length">
        <span class="vf-dock-sep" />
        <div class="vf-seg">
          <button
            type="button"
            class="vf-seg-btn"
            :class="{ 'is-on': !showClasses }"
            v-tip="{ title: 'Package level', hint: 'One card per package — open one to go deeper.' }"
            @click="setShowClasses(false)"
          >
            <Icon icon="lucide:package" class="h-3.5 w-3.5" />
            Packages
          </button>
          <button
            type="button"
            class="vf-seg-btn"
            :class="{ 'is-on': showClasses }"
            :disabled="!showClasses && scopeClassCount > CLASS_RENDER_LIMIT"
            v-tip="scopeClassCount > CLASS_RENDER_LIMIT && !showClasses
              ? { title: `Too many classes here (${scopeClassCount})`, hint: `Open a package first — at most ${CLASS_RENDER_LIMIT} class cards are drawn.` }
              : { title: 'Class level', hint: `Every class below this path (${scopeClassCount}) as its own card.` }"
            @click="setShowClasses(true)"
          >
            <Icon icon="lucide:braces" class="h-3.5 w-3.5" />
            Classes
          </button>
        </div>
      </template>
      <!-- Zonen an/aus. Auf der Package-Ebene gibt es nichts zu gruppieren – dort ist jeder
           Knoten bereits ein Package. -->
      <template v-if="!packageMode">
        <span class="vf-dock-sep" />
        <button
          type="button"
          class="vf-tool"
          :class="{ 'is-on': groupByPackage }"
          v-tip="groupByPackage
            ? { title: 'Grouped by package', hint: 'Click to lay out all classes in one run, without zones.' }
            : { title: 'Group by package', hint: 'One layout per package, then over the zones — faster and easier to read.' }"
          @click="toggleGrouping"
        >
          <Icon icon="lucide:package" class="h-4 w-4" />
        </button>
      </template>
      <!-- Umgebung an/aus. Gilt in BEIDEN Modi (Package-Ebene wie Klassen): die Frage „wen beruehrt
           das hier?" haengt nicht daran, wie fein der Ausschnitt gerade gezeichnet wird. Auf der
           obersten Ebene gibt es kein Aussen -> gesperrt statt wirkungslos. -->
      <button
        type="button"
        class="vf-tool"
        :class="{ 'is-on': showRelated }"
        :disabled="!basePath || basePath === rootPath"
        v-tip="!basePath || basePath === rootPath
          ? { title: 'Nothing outside this scope', hint: 'You are at the top level — everything is already in the picture.' }
          : showRelated
            ? { title: 'Neighbours shown', hint: 'Click to hide what this scope connects to outside itself.' }
            : { title: 'Show neighbours', hint: 'Draws what this scope uses and what uses it, outside itself.' }"
        @click="toggleRelated"
      >
        <Icon icon="lucide:share-2" class="h-4 w-4" />
      </button>
      <!-- Kantenarten einzeln abschaltbar: die schnellste Art, ein ueberladenes Bild aufzuraeumen.
           Ausgeblendete Kanten wirken auch nicht mehr auf die Platzierung. -->
      <span class="vf-dock-sep" />
      <button
        v-for="k in EDGE_KINDS"
        :key="k.key"
        type="button"
        class="vf-chip"
        :class="{ 'is-off': !edgeFilter[k.key] }"
        :style="{ '--c': k.color }"
        v-tip="edgeFilter[k.key]
          ? { title: `Hide ${k.label.toLowerCase()}`, hint: 'Hidden edges also stop steering the layout.' }
          : { title: `Show ${k.label.toLowerCase()}`, hint: 'Edges steer the layout — showing them changes the placement.' }"
        @click="toggleEdgeKind(k.key)"
      >
        <span class="vf-chip-line" />
        {{ k.label }}
      </button>
    </div>

    <!-- Legende: Toggle-Pille; das Panel klappt darueber auf (Default zu). -->
    <div v-if="files.length" class="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2">
      <Transition name="legend">
        <div v-if="legendOpen" class="vf-legend">
          <!-- Achse 1: WAS ist der Knoten? (Chip vor dem Klassennamen) -->
          <div class="legend-head">Nodes · what it is</div>
          <div class="legend-grid">
            <div v-for="t in legendTypes" :key="t" class="legend-row">
              <span
                class="vf-type legend-type"
                :class="{ 'vf-type--plain': t === 'class' }"
                :style="{ '--type': TYPE_META[t].color }"
              >
                <Icon :icon="TYPE_META[t].icon" />
              </span>
              <span>{{ TYPE_META[t].label }}</span>
            </div>
          </div>

          <!-- Achse 2: WIE haengt er im Netz? (Streifen, Ring, Methoden-Badge) -->
          <div class="legend-head mt-1.5">Nodes · how it connects</div>
          <div class="legend-grid">
            <div v-for="role in ROLE_ORDER" :key="role" class="legend-row" :title="ROLE_META[role].hint">
              <span class="legend-node-swatch" :style="{ background: `var(--color-role-${role})` }" />
              <Icon :icon="ROLE_META[role].icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: `var(--color-role-${role})` }" />
              <span>{{ ROLE_META[role].label }}</span>
            </div>
          </div>

          <!-- Achse 3: WO gehoert er hin? (Package als Zone bzw. als eigener Knoten) -->
          <template v-if="zones.length || packageMode || relatedNodes.length">
            <div class="legend-head mt-1.5">Groups · packages</div>
            <div v-if="zones.length" class="legend-row">
              <span class="legend-zone" />
              <span><b>Zone</b> — click its label to focus</span>
            </div>
            <div v-if="packageMode" class="legend-row">
              <span class="legend-node-swatch legend-node-swatch--pkg" />
              <Icon icon="lucide:folder" class="h-3.5 w-3.5 shrink-0" style="color: var(--color-thistle)" />
              <span><b>Package</b> node — click to open</span>
            </div>
            <div v-if="relatedNodes.length" class="legend-row">
              <span class="legend-node-swatch legend-node-swatch--rel" />
              <Icon icon="lucide:share-2" class="h-3.5 w-3.5 shrink-0" style="color: var(--color-thistle)" />
              <span><b>Related</b> package — outside this scope</span>
            </div>
            <p class="legend-sub">Each package keeps its own hue — zone, node and the dot on a card.</p>
          </template>

          <div class="legend-head mt-1.5">Edges · what connects them</div>
          <div class="legend-row">
            <span class="legend-line" style="background: var(--color-accent)" />
            <span><b>Calls</b> a method — click for the code</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--longdash" style="color: var(--color-accent)" />
            <span><b>Manual</b> link you drew yourself</span>
          </div>
          <div class="legend-row">
            <span class="legend-line" style="background: var(--color-warning)" />
            <span><b>Uncertain</b> match — “Please review”</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dashed" style="color: var(--color-cyan)" />
            <span><b>Uses</b> the type — field, parameter, <code>new X()</code></span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dotted" style="color: var(--color-text-muted)" />
            <span><b>Imports</b> only — no access found</span>
          </div>
          <div v-if="packageMode || relatedNodes.length" class="legend-row">
            <span class="legend-line legend-line--thick" style="background: var(--color-thistle)" />
            <span><b>Bundle</b> of class relations — click to list them</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--lit" style="background: var(--color-edge-highlight)" />
            <span><b>Highlighted</b> from a click in the source code</span>
          </div>
          <p class="legend-hint">
            Arrows point from the definition to the class using it.<br />
            Hover a class to isolate its connections —<br />
            each neighbour shares a colour with the line leading to it.
          </p>

          <div class="legend-head mt-1.5">Badges &amp; states</div>
          <div class="legend-row">
            <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span>AI-analyzed</span>
          </div>
          <div class="legend-row">
            <span class="legend-version">v2</span>
            <span>version · history</span>
          </div>
          <div class="legend-row">
            <span class="legend-state legend-state--match" />
            <span>Search match</span>
          </div>
          <div class="legend-row">
            <span class="legend-state legend-state--context" />
            <span>Context · outside the scope, shown to explain a relation</span>
          </div>
          <div class="legend-row">
            <span class="legend-state legend-state--dim" />
            <span>Faded · not connected to the hovered class</span>
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

    <!-- Slide-over: eine Aggregatkante („N class relations") in ihre Klassenpaare auflösen.
         MUSS vor dem Edge-Detail-Modal stehen: beide teleportieren an <body>, und die
         Template-Reihenfolge entscheidet, was oben liegt – der Code-Auszug gehört über die Liste. -->
    <JavaBundlePanel
      :visible="!!activeBundle"
      :bundle="activeBundle"
      :load-detail="loadRelationDetail"
      @close="closeBundlePanel"
      @open="openRelationCode"
    />

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

/* --- Package-Knoten (aggregierte Ebene) ------------------------------------------------
   Bewusst groesser und ruhiger als die Klassenkarte: auf dieser Ebene zaehlen Name, Umfang
   und KI-Fortschritt des Teilbaums, nicht Einzelheiten. Der Akzent ist die Package-Farbe. */
.vf-pkgcard {
  --role: var(--pkg, var(--color-accent));
  display: flex;
  align-items: stretch;
  gap: 10px;
  /* in rem, damit die Karte mit der Root-Schriftgroesse waechst – PKG_W im Skript ist derselbe
     Wert und wird dort mit `rootScale` multipliziert. Beide muessen zusammen bleiben. */
  width: 15.5rem;
  padding: 0 12px 0 0;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--role) 42%, var(--color-border));
  background: var(--color-surface-2);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--role) 20%, transparent);
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
}
.vf-pkgcard:hover {
  transform: translateY(-1px);
  border-color: var(--role);
  box-shadow: 0 8px 20px color-mix(in srgb, var(--role) 34%, transparent);
}
/* Nachbar ausserhalb des Ausschnitts: gestrichelt und zurueckgenommen – dieselbe „zweite Reihe"
   wie die mitgezeigten Klassen im Suchmodus (.vf-card--context), nur eben als Package. Der
   Strichrand sagt dabei zusaetzlich, dass die Karte NICHT vollstaendig ist: sie steht fuer einen
   Zweig, von dem nur der beruehrte Teil zaehlt. */
.vf-pkgcard--related {
  border-style: dashed;
  background: color-mix(in srgb, var(--color-surface-2) 82%, transparent);
  box-shadow: none;
  opacity: 0.62;
}
.vf-pkgcard--related:hover {
  opacity: 1;
}
.vf-pkgtag {
  flex-shrink: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--role) 18%, transparent);
  padding: 0 5px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.5625rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}
.vf-pkgbody {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  padding: 10px 0;
}
.vf-pkgname {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  /* Bewusst groesser als der Klassenname: auf dieser Ebene wird oft herausgezoomt (viele
     Packages), und der Name ist das Einzige, was dann noch lesbar sein muss. */
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--color-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vf-pkgicon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--role);
}
.vf-pkgmeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
.vf-pkgstat b {
  font-weight: 600;
  color: var(--color-text);
}
.vf-pkgstat--ext {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.vf-pkgic {
  width: 11px;
  height: 11px;
}
.vf-pkgbar {
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-surface-offset);
}
.vf-pkgbar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--color-accent);
}

/* --- Ebenen-Navigation (Breadcrumb) ---------------------------------------------------- */

.vf-ego-label--muted {
  opacity: 0.75;
}
.vf-ego-label {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
/* Der Zaehler steht ZWISCHEN den Knoepfen: „wieviel von wieviel" ist die Aussage, die Knoepfe
   sind nur ihre beiden Richtungen. */
.vf-ego-step {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 1px 2px;
}
.vf-ego-btn {
  display: grid;
  height: 1.25rem;
  width: 1.25rem;
  place-items: center;
  border-radius: 5px;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-ego-btn:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-ego-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.vf-ego-count {
  min-width: 3.25rem;
  text-align: center;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
.vf-ego-count b {
  font-weight: 600;
  color: var(--color-text);
}
/* Zwischen den beiden Richtungsknoepfen steht, was die aktuelle Stufe BEDEUTET („20 as cards",
   „no context") – die reine Zahl steht schon in der Kopfzeile des Abschnitts, und sie zweimal
   nebeneinander zu zeigen hiesse, dieselbe Auskunft fuer zwei zu halten. */
.vf-ego-hint {
  min-width: 5.5rem;
  text-align: center;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
/* Die Stufen als Skala: wer weiss, wieviel er sehen will, springt direkt hin. */
.vf-ego-ticks {
  display: flex;
  align-items: center;
  gap: 2px;
}
.vf-ego-tick {
  border-radius: 6px;
  padding: 1px 6px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-ego-tick:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-ego-tick.is-on {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 600;
}

/* Aufgeklapptes Package: der Chip IST der Rueckweg – sein Aggregatknoten ist ja verschwunden. */
.vf-ego-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: var(--color-accent-soft);
  padding: 1px 7px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-accent);
  transition: background-color 0.15s ease;
}
.vf-ego-chip:hover {
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
}










/* --- Leiste links: Ort, Bilanz, Ego-Regler – vertikal ------------------------------------
 * Vorher lagen hier zwei bis drei horizontale Balken uebereinander: der Pfad wuchs mit jeder
 * Ebene nach RECHTS und lief unter das Suchfeld oben rechts, die Ego-Leiste darunter noch einmal.
 * Vertikal waechst der Pfad dorthin, wo Platz ist, liest sich wie der Baum in der linken Spalte
 * und kollidiert mit nichts. Deckender Hintergrund ohne `backdrop-filter` (s. Stolperfalle
 * „kein filter im Graphen"): das Element gibt es zwar nur einmal, aber es liegt ueber der
 * gesamten Layoutflaeche und waere damit die groesste Offscreen-Textur im Bild. */
.vf-rail {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  display: flex;
  width: 13.5rem;
  max-width: calc(100% - 20px);
  max-height: calc(100% - 92px); /* Dock unten bleibt frei */
  flex-direction: column;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.1);
}
/* Abschnitt = eine Aussage. Die Haarlinie trennt Ort von Bilanz von Reglern. */
.vf-rail-sec {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
}
.vf-rail-sec + .vf-rail-sec {
  border-top: 1px solid var(--color-border);
}
.vf-rail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.vf-rail-x {
  display: grid;
  height: 1.25rem;
  width: 1.25rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 5px;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-rail-x:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
/* Eine Stufe des Pfades. Einzug = Tiefe (inline gesetzt), damit die Verschachtelung ohne
   Trennzeichen lesbar ist – dieselbe Sprache wie der Package-Baum links. */
.vf-rail-step {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  padding: 3px 6px;
  text-align: left;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-rail-step:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-rail-step.is-current {
  background: var(--color-accent-soft);
  font-weight: 600;
  color: var(--color-accent);
  cursor: default;
}
.vf-rail-stepic {
  height: 0.75rem;
  width: 0.75rem;
  flex-shrink: 0;
  opacity: 0.7;
}
/* Zahlen und Warnungen: umbrechend, weil die Leiste schmal ist und eine Zeile pro Aussage
   ehrlicher liest als eine abgeschnittene. */
.vf-rail-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 2px;
}
.vf-rail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 2px;
}
.vf-rail-chips .vf-ego-chip {
  max-width: 100%;
}

.vf-crumb-count {
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  padding-left: 8px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}




/* --- Suche im gezeichneten Graphen (oben rechts) ---------------------------------------------
   Deckender Hintergrund, kein backdrop-filter (s. Stolperfalle „kein filter im Graphen"). */
.vf-find {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 6;
  display: flex;
  width: 19rem;
  max-width: calc(100% - 20px);
  flex-direction: column;
  gap: 4px;
}
.vf-find-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 3px 6px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
  transition: border-color 0.15s ease;
}
.vf-find.is-active .vf-find-row,
.vf-find-row:focus-within {
  border-color: var(--color-accent);
}
.vf-find-icon {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  color: var(--color-text-muted);
}
.vf-find-input {
  min-width: 0;
  flex: 1;
  background: transparent;
  padding: 3px 2px;
  font-size: 0.75rem;
  color: var(--color-text);
  outline: none;
}
.vf-find-input::placeholder {
  color: var(--color-text-muted);
}
.vf-find-count {
  flex-shrink: 0;
  white-space: nowrap;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-text-muted);
}
.vf-find-count.is-empty {
  color: var(--color-danger);
}
.vf-find-btn {
  display: grid;
  height: 1.25rem;
  width: 1.25rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 5px;
  color: var(--color-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
.vf-find-btn:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-find-btn:disabled {
  opacity: 0.35;
}
/* Facetten-Chips: erscheinen im leeren, fokussierten Feld und tragen sich per Klick ein. */
.vf-find-hints {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 5px 6px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
}
.vf-find-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border-radius: 6px;
  background: var(--color-surface-offset);
  padding: 1px 5px;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
.vf-find-hint:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.vf-find-hint code {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 700;
  color: var(--color-accent);
}

/* Die Schaltflaeche `.vf-ctx-toggle` („Show N related classes", mittig ueber dem Graphen) ist
   entfallen: dieselbe Frage beantwortet jetzt die Stufenleiter in der Leiste links, fuer einen
   Treffer wie fuer sechsundzwanzig. Zwei Bedienelemente an zwei Stellen fuer eine Frage waren der
   Bruch, den man beim Tippen im Klassenfilter gesehen hat. */

/* Bilanz der Umgebung: eigene Farbe (Aggregat-Ton), damit sie nicht als Teil der Klassenzahl des
   Ausschnitts gelesen wird – sie zaehlt genau das, was AUSSERHALB liegt. */
.vf-crumb-rel {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 3px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-thistle) 18%, transparent);
  padding: 2px 6px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.vf-crumb-warn {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 3px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-warning) 16%, transparent);
  padding: 2px 6px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  color: var(--color-warning);
  white-space: nowrap;
}

.vf-card {
  /* Karten-Akzent = ROLLE im Abhaengigkeitsnetz (Streifen, Badge, Ring). Package steckt nur noch
     im kleinen .vf-pkgdot. --role wird per .vf-role-<role>-Klasse gesetzt (Default: isoliert). */
  --role: var(--color-role-isolated);
  display: flex;
  align-items: center;
  gap: 8px;
  /* rem: waechst mit der Root-Schriftgroesse (Gegenstueck zu NODE_W * rootScale im Skript). */
  width: 14.25rem;
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
/* Suchtreffer: klarer Ring in der Akzentfarbe – die Rolle bleibt an Streifen und Glyph ablesbar. */
.vf-card--match {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 55%, transparent), 0 6px 18px color-mix(in srgb, var(--color-accent) 28%, transparent);
}
/* Mitgezeigte Nachbarschaft: sichtbar, aber eindeutig zweite Reihe. */
.vf-card--context {
  opacity: 0.5;
}
.vf-card--context:hover {
  opacity: 1;
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
/* Typ-Chip vor dem Klassennamen (Achse 2: WAS ist der Knoten?). Eigener Slot und eigene
   Farbfamilie – die Rolle sitzt auf der anderen Kartenseite und mischt sich hier nicht ein. */
.vf-type {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--type) 32%, transparent);
  background: color-mix(in srgb, var(--type) 15%, transparent);
  color: var(--type);
}
.vf-type svg {
  width: 11px;
  height: 11px;
}
/* `class` ist der Normalfall: nur das Glyph, kein Chip. In einer Codebasis aus 500 Klassen waeren
   500 identische Kaestchen reines Rauschen – so bleibt der Rahmen dem Besonderen vorbehalten. */
.vf-type--plain {
  border-color: transparent;
  background: none;
  opacity: 0.75;
}
.vf-type--plain svg {
  width: 14px;
  height: 14px;
}
/* Kleiner Package-Punkt vor dem Package-Text (Package-Identitaet, sekundaer). Inline-block, damit
   das text-overflow:ellipsis des Package-Texts erhalten bleibt. */
.vf-pkgdot {
  display: inline-block;
  width: 8px;
  height: 8px;
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
  /* Der Klassenname ist die wichtigste Information der Karte und muss auch dann noch lesbar sein,
     wenn fitView() bei vielen Knoten herauszoomt -> bewusst kraeftiger als die uebrige Karte. */
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--color-text);
}
.vf-ai {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  color: var(--color-accent);
}
.vf-pkg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
/* Rollen-Badge: Glyph + Methodenzahl in EINER Pille (Achse 1). Rolle und Umfang gehoeren
   zusammen – „ein Hub mit 12 Methoden" liest sich als eine Aussage. */
.vf-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 1px 7px 1px 5px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  /* NICHT hart #fff: im Dark-Mode sind die Rollenfarben aufgehellt, weisser Text darauf ist
     kaum lesbar. Das Kontrast-Token dreht sich mit dem Theme (dunkel auf hell / hell auf dunkel). */
  color: var(--color-accent-contrast);
  background: var(--role);
}
.vf-badge-ic {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  opacity: 0.9;
}
/* Versions-Chip (Changelog): sekundaer/outlined -> klar abgesetzt von der gefuellten
   Methoden-Pille. Ab v2 in Akzentfarbe, um „hat Historie" hervorzuheben. */
.vf-version {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.6875rem;
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
  z-index: 6;
  display: flex;
  /* Umbrechen statt ueberlaufen: in einer schmalen Graph-Spalte passen Werkzeuge und
     Kanten-Filter nicht in eine Zeile. */
  max-width: calc(100% - 24px);
  flex-wrap: wrap;
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
  font-size: 0.75rem;
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
  gap: 2px;
  width: 22rem;
  /* Hoch genug, dass die fuenf Kategorie-Abschnitte auf ueblichen Fenstern ohne Scrollen
     nebeneinanderstehen – eine Legende, in der man blaettern muss, wird nicht gelesen. */
  max-height: min(640px, 76vh);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-surface-2) 92%, transparent);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  backdrop-filter: blur(8px);
  font-size: 0.75rem;
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
/* Die Muster spiegeln exakt die Kanten im Canvas – die Legende ist sonst eine huebsche Luege. */
.legend-line--dashed {
  height: 0;
  background: none;
  border-top: 2px dashed currentColor;
}
.legend-line--longdash {
  height: 0;
  background: none;
  border-top: 2px dashed currentColor;
  /* laengere Striche = manuelle Kante (6 4 im Canvas) */
  border-image: repeating-linear-gradient(to right, currentColor 0 6px, transparent 6px 10px) 2;
}
.legend-line--dotted {
  height: 0;
  background: none;
  border-top: 2px dotted currentColor;
  opacity: 0.8;
}
.legend-line--thick {
  height: 4px;
}
.legend-line--lit {
  height: 3px;
  box-shadow: 0 0 6px color-mix(in srgb, var(--color-edge-highlight) 70%, transparent);
}
.legend-hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
  font-size: 0.625rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}
.legend-row code {
  border-radius: 3px;
  background: var(--color-surface-offset);
  padding: 0 3px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
}
/* Legenden-Abschnittsueberschrift (Nodes / Edges) – dezent, damit die laengere Legende scanbar bleibt. */
.legend-head {
  font-size: 0.625rem;
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
  font-size: 0.6875rem;
}
/* Legenden-Swatch fuer den Versions-Chip (spiegelt .vf-version--multi). */
.legend-version {
  display: inline-block;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 0.625rem;
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
/* --- Segment-Schalter im Dock: welche EBENE wird gezeichnet ------------------------------
 * Zwei Segmente statt eines Wechselknopfes: ein Wechselknopf beschriftet immer den ANDEREN
 * Zustand („Classes", waehrend man Packages sieht) – man liest ihn als Aussage ueber das Bild
 * und liegt falsch. Hier ist beschriftet, was es gibt, und markiert, wo man steht. */
.vf-seg {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 2px;
}
.vf-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-seg-btn:hover:not(:disabled):not(.is-on) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-seg-btn.is-on {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 600;
}
.vf-seg-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
/* Umschalter im Zustand „aktiv" (Package-Gruppierung). */
.vf-tool.is-on {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

/* --- Kanten-Filter (Pillen im Dock) ------------------------------------------------------- */
.vf-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  flex-shrink: 0;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-text);
  background: color-mix(in srgb, var(--c) 16%, transparent);
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.vf-chip-line {
  width: 12px;
  height: 2px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--c);
}
/* Abgeschaltet: farblos und zurueckgenommen – der Unterschied muss ohne Hover erkennbar sein. */
.vf-chip.is-off {
  color: var(--color-text-muted);
  background: transparent;
  opacity: 0.6;
}
.vf-chip.is-off .vf-chip-line {
  background: currentColor;
  opacity: 0.45;
}
.vf-chip:hover {
  opacity: 1;
  color: var(--color-text);
}

/* --- Package-Zonen ------------------------------------------------------------------------
   Zwei Ebenen ausserhalb von Vue Flow, beide mit dem Viewport transformiert:
     .vf-zonelayer          – die Flaeche, HINTER dem Canvas (Kanten laufen darueber)
     .vf-zonelayer--front   – die Kopfzeile, DAVOR (sonst schluckt das Vue-Flow-Pane den Klick)
   Der z-index von --front bleibt unter Breadcrumb (5), Dock und Legende (10). */
.vf-zonelayer {
  position: absolute;
  inset: 0;
  z-index: 0;
  transform-origin: 0 0;
  pointer-events: none;
}
.vf-zonelayer--front {
  z-index: 3;
}
.vf-zone {
  position: absolute;
  border-radius: 18px;
  /* Gestrichelt und sehr leise: die Zone ist Ordnung im Hintergrund, keine Aussage im Vordergrund. */
  border: 1px dashed color-mix(in srgb, var(--pkg) 38%, transparent);
  background: color-mix(in srgb, var(--pkg) 7%, transparent);
}
.vf-zonehead {
  position: absolute;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--pkg) 45%, var(--color-border));
  /* Deckend statt `backdrop-filter: blur()`: von diesem Kopf gibt es EINEN JE PACKAGE, und jedes
     backdrop-filter-Element verlangt vom Compositor eine eigene Kopie des Hintergrunds – bei
     Dutzenden Zonen ueber einem mehrere tausend Pixel grossen Graph-Layer war das ein Auslöser
     fuer schwarz gezeichnete Flaechen. Legende/Dock/Breadcrumb bleiben unveraendert: die gibt es
     genau einmal. */
  background: var(--color-surface-2);
  padding: 2px 4px 2px 8px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
  transition: color 0.15s ease, border-color 0.15s ease;
}
.vf-zonehead:hover {
  color: var(--color-text);
  border-color: var(--pkg);
}
/* Folder-Glyph statt Punkt: die Zone gehoert damit sichtbar zur selben Kategorie wie der
   Package-Knoten der aggregierten Ebene – Farbe bleibt die des jeweiligen Packages. */
.vf-zoneic {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--pkg);
}
.vf-zonename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vf-zonecount {
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--color-surface-offset);
  padding: 0 6px;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

/* Hover-Fokus: alles ausserhalb der Nachbarschaft faellt weit zurueck. Muss NACH den
   Rollen-Regeln stehen (.vf-role-isolated setzt ebenfalls opacity). */
.vf-card--dim {
  opacity: 0.14;
}
.vf-card--dim:hover {
  opacity: 0.14;
}
/* Karte im Hover-Fokus. Ring + Schein in der FARBE DER LINIE, die zu ihr fuehrt (nicht der Rolle):
   beim Kanten-Hover ist das die Farbe der Kante, beim Knoten-Hover die Identitaetsfarbe dieses
   Nachbarn (s. focusColor/neighbourPalette im Script). So gehoeren Linie, Label und Karte sichtbar
   zusammen, und bei einem Hub mit zwoelf Nachbarn ist ablesbar, welche Linie an welcher Karte
   endet. Der Ring liegt aussen (box-shadow), veraendert also keine Kartengroesse – ein Aufklappen
   beim Hover wuerde das Layout verspringen lassen und die Maus womoeglich gleich wieder aus der
   Kante schieben. */
/* Treffer der Graph-Suche: Gold-Familie wie jeder andere Suchtreffer in Wikit (`mark` in
   style.css, Treffer im Quelltext). Ring per box-shadow – eine Karte, die beim Suchen ihre Groesse
   aendert, verschoebe das ganze Layout. Die Rollenfarbe am Streifen bleibt sichtbar: WAS der Knoten
   im Netz ist, aendert sich durch eine Suche nicht. */
.vf-card--find,
.vf-pkgcard.vf-card--find {
  border-color: var(--color-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 42%, transparent),
    0 8px 22px color-mix(in srgb, var(--color-warning) 26%, transparent);
  z-index: 1;
}

.vf-card--focus,
.vf-pkgcard.vf-card--focus {
  border-color: var(--edge);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--edge) 45%, transparent),
    0 8px 22px color-mix(in srgb, var(--edge) 30%, transparent);
  transform: translateY(-1px);
  z-index: 1;
}
/* --- Legende: Kategorien --------------------------------------------------------------------
   Die Typ-Zeilen sind kurz (ein Wort) -> zweispaltig, sonst waere die Legende doppelt so hoch
   wie noetig und der Rest muesste gescrollt werden. */
.legend-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
}
/* Chip in der Legende: identisch zur Karte, nur ohne Umgebung. */
.legend-type {
  width: 15px;
  height: 15px;
}
/* Erlaeuterung unter einem Abschnitt – erklaert die Systematik, nicht ein einzelnes Symbol. */
.legend-sub {
  margin: 2px 0 0 0;
  font-size: 0.625rem;
  line-height: 1.45;
  color: var(--color-text-muted);
  opacity: 0.8;
}
/* Package-Swatch: mehrfarbig, weil jedes Package seinen eigenen Ton bekommt. */
.legend-node-swatch--pkg {
  background: linear-gradient(135deg, var(--color-thistle) 0 50%, var(--color-cyan) 50% 100%);
}
/* Nachbar-Package: dieselbe Flaeche, aber gestrichelt umrandet und zurueckgenommen – genau wie
   die Karte im Canvas. */
.legend-node-swatch--rel {
  border: 1px dashed color-mix(in srgb, var(--color-thistle) 70%, var(--color-border));
  background: color-mix(in srgb, var(--color-thistle) 22%, transparent);
}
/* Zustands-Swatches (Treffer/gedimmt) – zeigen den Effekt, statt ihn zu beschreiben. */
.legend-state {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 3px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
}
.legend-state--match {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 45%, transparent);
}
/* Kontext: derselbe Effekt wie im Canvas (halbe Deckkraft, gestrichelt = „nicht der Ausschnitt"). */
.legend-state--context {
  border-style: dashed;
  opacity: 0.5;
}
/* Nicht so weit heruntergezogen wie im Canvas (0.14) – als 12-px-Swatch waere davon nichts mehr
   zu sehen und die Zeile saehe aus, als fehle ihr das Symbol. */
.legend-state--dim {
  opacity: 0.35;
  border-style: dashed;
}
/* Zonen-Swatch der Legende – spiegelt Rand und Fuellung der Flaeche im Canvas. */
.legend-zone {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 4px;
  border: 1px dashed color-mix(in srgb, var(--color-thistle) 55%, transparent);
  background: color-mix(in srgb, var(--color-thistle) 14%, transparent);
}
</style>
