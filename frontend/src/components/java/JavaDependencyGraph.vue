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
import { computed, ref, onMounted, onUnmounted, watch, watchEffect, nextTick } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useRootScale } from '../../composables/useRootScale.js'
import { Icon } from '../../lib/icons.js'
import {
  buildPackageLevel,
  buildNeighbourLevel,
  buildContextLevel,
  commonPackagePrefix,
  breadcrumbFor,
  indexFilesByName,
  resolveClassByName,
  resolveImport,
} from '../../lib/packageGraph.js'
import { layoutFlat, layoutClustered, layoutRadial } from '../../lib/graphLayout.js'
import { parseGraphQuery, matchNode, matchEdge } from '../../lib/graphQuery.js'
import { codeState, patchCodeState } from '../../lib/codeState.js'
import BusyState from '../BusyState.vue'
// Kanten-Detail und Aggregat-Aufloesung rendert CodeView in Spalte 3 – der Graph rechnet sie nur
// und meldet sie als `relation` nach oben (s. dortiger Kommentar am Emit).
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
  // Steht das Kanten-Detail rechts gerade IM BILD? CodeView zeigt dort wahlweise die geoeffnete
  // Klasse oder die Beziehung; nur im zweiten Fall gehoert die Kante im Graphen markiert. Was man
  // sieht, ist markiert – ein Pin auf eine Beziehung, deren Detail gerade hinter dem Klassen-Tab
  // liegt, waere eine Daempfung ohne sichtbaren Anlass.
  relationVisible: { type: Boolean, default: true },
})
// `navigate` = „der Graph zeigt jetzt diese Ebene" (Package-Pfad, leerer String = oberste Ebene).
// Gegenrichtung zu focusPath: der Baum links ist die Ortsangabe und darf nicht stehenbleiben,
// waehrend man sich hier durch die Packages klickt.
// `relation` = „das ist die angeklickte Beziehung" – der Graph RECHNET sie (er allein kennt
// Dateiliste, Kanten und Ebenen-Schluessel), gezeigt wird sie in Spalte 3 von CodeView. Payload:
//   { kind: 'edge',   edge, loading, since, back }   – eine Klassenkante (call/field)
//   { kind: 'bundle', bundle, loadDetail, openRelation } – eine Aggregatkante der Package-Ebene
//   null – nichts offen
// Die zwei Funktionen im Bundle-Payload sind dieselbe Bauart wie `data.onOpen` an den Kanten:
// die Rechnung bleibt dort, wo ihre Daten liegen, und wandert nicht in die View.
// `find-result` = „das habe ICH gefunden" – nur fuer `r:` (Rolle): sie entsteht erst in diesem
// Ausschnitt, also kann die Klassenliste links sie nicht selbst beantworten und filtert auf diese
// Meldung (s. lib/graphQuery.js -> queryFiles).
const emit = defineEmits(['select', 'clear-search', 'navigate', 'pane-click', 'relation', 'find-result'])

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
  hoverAnchor,
  setHoveredNode,
  hoveredEdge,
  setHoveredEdge,
  setGraphQuery,
  setGraphHitNodes,
  pinnedEdge,
  setPinnedEdge,
  setLabelObstacles,
  selectionAnchor,
  selectionPalette,
  setSelectionColors,
  graphPreview,
  setGraphPreview,
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
// Feldzugriff (`Http.GET`). Eigene Hue, weil die Kante etwas anderes sagt als die drei anderen:
// sie benennt ein MITGLIED wie ein Aufruf, traegt aber kein Verhalten. Lavendel ist im
// Kanten-Slot frei (Aufruf = Akzent, Typbezug = Cyan, Import = gedaempft, Buendel = Thistle,
// Highlight = Gold) – dass es an einer Karte auch die Consumer-Rolle faerbt, stoert nicht:
// das sind zwei Slots, die nie am selben Element sitzen.
const FIELD_COLOR = 'var(--color-lavender)'
const USES_COLOR = 'var(--color-cyan)' // Struktur-/Typ-Bezug (Parameter, Cast, new X())
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
// --- Wo eine Methode definiert ist, ist nicht dasselbe wie was dort laeuft --------------------
// Ein Aufruf gegen ein Interface oder eine abstrakte Klasse sagt NICHT, welche Implementierung
// wirklich ausgefuehrt wird – bei einer konkreten Klasse sagt er es. Das ist am Kanten-Label die
// wichtigere Auskunft als der Methodenname allein, und UML notiert sie seit jeher gleich: kursiv
// fuer alles, dessen Implementierung offen ist. Kursiv kostet dabei weder eine Farbe (die sind an
// Rolle/Typ/Gruppe vergeben) noch eine Strichform (call/uses/import).
//
// `stereotype` ist bei Altbestand NULL (s. Datenmodell) – deshalb zusaetzlich `class_modifiers`,
// das aus derselben Analyse stammt, aber schon laenger gefuellt wird. Ohne diesen zweiten Weg
// saehe eine nie neu analysierte abstrakte Klasse aus wie eine konkrete.
const OPEN_KIND_ICON = { interface: TYPE_META.interface.icon, abstract: TYPE_META.abstract.icon }
function openKindOf(f) {
  if (!f) return null
  if (f.class_type === 'interface') return 'interface'
  if (f.stereotype === 'abstract') return 'abstract'
  return (f.class_modifiers || []).includes('abstract') ? 'abstract' : null
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
// `field` kam spaeter dazu: ein gespeicherter Zustand ohne den Schluessel wird per Spread
// gemischt, der Default bleibt also `true` – niemand findet seine Feldkanten „verschwunden".
const edgeFilter = ref({ call: true, field: true, uses: true, import: true })
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
  { key: 'field', label: 'Fields', color: 'var(--color-lavender)' },
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
//
// Beides ueberlebt den Reload (s. `lib/codeState.js`): welche Ebene offen ist, IST die Ansicht –
// sie beim naechsten Besuch wieder auf die Wurzel zu stellen, hiesse den Weg dorthin noch einmal
// zu verlangen. Der gemerkte Stand liegt im selben Schluessel wie der Klassenfilter von CodeView,
// weil beide zusammen erst einen Ausschnitt ergeben.
const saved = codeState()
const zoomPath = ref(saved.path ?? null) // null -> noch nicht gesetzt, faellt auf rootPath zurueck
const showClasses = ref(!!saved.classes)

// Startpfad = laengster gemeinsamer Package-Praefix. Liegt alles unter com.acme, waere die
// oberste Ebene sonst ein einziger Knoten "com".
const rootPath = computed(() => commonPackagePrefix(props.files || []))
const basePath = computed(() => (zoomPath.value == null ? rootPath.value : zoomPath.value))

// Klassenname -> Datei. Die Auflösung liegt als reine Funktion in `lib/packageGraph.js` (dort
// steht auch, warum sie mehr tut als ein Map-Lookup: Kanten tragen nur den EINFACHEN Namen).
const filesByName = computed(() => indexFilesByName(props.files || []))
const resolveClass = (name, consumer, pkg = null) => resolveClassByName(filesByName.value, name, consumer, pkg)
// Beide Enden einer Server-Kante zuordnen. Die Kante trägt ihre Packages selbst mit
// (`source_pkg`/`target_pkg`) – damit ist die Zuordnung exakt statt geraten; NULL bei Altbestand,
// dann greift wieder die Namensauflösung über die Importe des Nutzers.
function endsOf(e, resolve) {
  const consumer = resolve(e.source_class, null, e.source_pkg ?? null)
  const provider = resolve(e.target_class, consumer, e.target_pkg ?? null)
  return { consumer, provider }
}

// Alle Klassenkanten (unabhaengig von der Sichtbarkeit) fuer die Aggregation: gleiche Richtung
// wie im Graph, also fromId = Definition/Provider, toId = Nutzung/Consumer.
const allClassEdges = computed(() => {
  const files = props.files || []
  const out = []
  const pairs = new Set()
  for (const e of serverEdges.value || []) {
    const { consumer: caller, provider: definer } = endsOf(e, resolveClass)
    if (!caller || !definer || caller.id === definer.id) continue
    out.push({ fromId: definer.id, toId: caller.id, kind: e.kind || 'call' })
    pairs.add(`${definer.id}->${caller.id}`)
  }
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      // Ueber die volle FQCN, nicht ueber den einfachen Namen (s. resolveImport).
      const target = resolveImport(filesByName.value, dep)
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

// Ein gemerkter Pfad ist eine Erinnerung, keine Garantie: das Package kann seit dem letzten Besuch
// geloescht worden sein, und eine leere Flaeche ohne erkennbaren Grund ist schlimmer als die
// Uebersicht. Geprueft wird EINMAL, sobald die Dateiliste ueberhaupt etwas enthaelt – vorher heisst
// „keine Klasse unter dem Pfad" nur „noch nicht geladen". Der Watcher auf `rootPath` daneben faengt
// den anderen Fall ab (der gemeinsame Praefix hat sich verschoben).
let savedPathChecked = false
watch(
  () => (props.files || []).length,
  (n) => {
    if (savedPathChecked || !n) return
    savedPathChecked = true
    if (zoomPath.value == null || scopedFiles.value.length) return
    zoomPath.value = null
    // Und den Verwurf auch merken: die Dateiliste kann schon stehen, wenn dieser Watcher laeuft
    // (Rueckkehr aus dem Wiki) – dann ist das hier noch das Setup, der Schreiber unten ist erst
    // danach registriert und saehe die Aenderung nie. Der Pfad bliebe gespeichert und muesste bei
    // jedem Start neu verworfen werden.
    patchCodeState({ path: null })
  },
  { immediate: true },
)
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

// Der gemerkte Stand des letzten Besuchs gehoert zu GENAU der Suche, die damals lief – deshalb
// wird die Anfrage mitgemerkt und nicht bloss ein Schalter gesetzt (dasselbe Muster wie
// `egoOverride` in CodeView, und aus demselben Grund: der Filter links steht beim Start sofort,
// der Graph erfaehrt ihn erst nach seinem Debounce – dazwischen liegt genau ein Wechsel von '' auf
// die Suche, und der wuerde die Stufe sonst als „neue Suche" verwerfen).
let pendingContext = saved.search && saved.context ? { query: saved.search, ...saved.context } : null
const contextOverride = ref(pendingContext?.budget ?? null) // null = automatisch, sonst die gewaehlte Stufe
const contextExpanded = ref(new Set(pendingContext?.expanded || [])) // aufgeklappte Nachbar-Packages (Pfad)

// Genau ein Treffer -> Stern mit Mitte (nur dafuer taugt das radiale Layout).
const egoCenterId = computed(() =>
  searchActive.value && props.matchIds.length === 1 ? props.matchIds[0] : null,
)
// Jede neue Suche faengt bei der Voreinstellung an: eine mitgeschleppte Stufe oder ein
// aufgeklapptes Package gehoerten zu einem anderen Ergebnis. Ausnahme ist genau ein Lauf: der
// gemerkte Stand, wenn die Suche ankommt, zu der er gehoert – danach ist er verbraucht, sonst
// wuerde er eine spaetere Wahl des Nutzers bei derselben Suche wieder ueberschreiben.
watch([() => props.searchQuery, egoCenterId], ([q]) => {
  const restore = pendingContext?.query === (q || '') ? pendingContext : null
  pendingContext = null
  contextOverride.value = restore?.budget ?? null
  contextExpanded.value = new Set(restore?.expanded || [])
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

// --- Die Stufen als LESBARE Liste, nicht als Achse -------------------------------------------
// Ein Regler zeigt eine Position; hier ist aber die Frage „was sehe ich bei dieser Stufe?", und
// die beantwortet keine Position, sondern ein Satz. Jede Stufe steht deshalb als eigene Zeile da,
// mit ihrer Zahl und dem, was sie bedeutet – alle gleichzeitig sichtbar, jede ein Klick.
// Was NICHT als Karte passt, bleibt je Package gefaltet: `total - s` ist ohne Rechnung bekannt und
// gilt fuer jede Stufe, nicht nur fuer die gerade gewaehlte.
const contextLayers = computed(() => {
  const total = searchContextInfo.value.ids.size
  return contextSteps.value.map((s) => ({
    step: s,
    label: s === 0 ? 'none' : s === total ? 'all' : String(s),
    // Zweite Zeile: was diese Wahl bedeutet. „matches only" ist die Abwesenheit von Umgebung,
    // „nothing folded" ihr Gegenteil – dazwischen zaehlt, was zusammengefasst bleibt.
    note:
      s === 0
        ? 'matches only'
        : s === total
          ? 'nothing folded'
          : `+${total - s} folded into packages`,
    count: s === total ? total : null,
  }))
})
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
// ⚠️ Es zaehlt, was GEZEICHNET ist – nicht, was im Ausschnitt liegt. Im Suchmodus sind das die
// Treffer plus die Kontextkarten (`searchScope`), nicht alle Klassen unter dem Pfad: `scopeFiles`
// lieferte dort die ganze Codebasis (ohne Pfad ist `scopedFiles` = alle Dateien), und damit bekam
// AUCH jede Klasse, die gerade in einem Aggregat steckt, den Schluessel `c:<id>`. In `bundleKeys`
// gewinnt insideKeys, also ueberschrieb dieser Schluessel die Package-Zuordnung aus dem
// Kontext-Level – und der Klick auf „22 class relations" fand null Paare, weil er Klassen unter
// `p:com.acme.util` suchte, die dort nicht mehr standen. Gemessen: 22 -> „total 0".
const insideKeys = computed(() => {
  if (packageMode.value) return level.value.keyByFileId
  const drawn = searchActive.value ? searchScope.value.files : scopeFiles.value
  return new Map(drawn.map((f) => [f.id, `c:${f.id}`]))
})
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
    if (props.focusFileId != null) {
      const id = `c:${props.focusFileId}`
      // Steht die Karte schon im Bild und wechselt gerade keine Ebene (der Fall „Suchtreffer
      // anfahren"), faehrt die Kamera sofort – der Geometrie-Watcher unten feuert nur bei NEUER
      // Geometrie und liesse den Sprung sonst aus.
      if (props.focusPath == null && nodes.value.some((n) => n.id === id)) centerOnNode(id)
      else pendingFocusNode.value = id
    }
  },
)

const layout = computed(() => {
  const files = visibleFiles.value
  // class_name -> Dateien (Mehrzahl: der Name ist nicht eindeutig, s. resolveClassByName). Nur
  // die GEZEICHNETEN Klassen – was nicht im Bild ist, bekommt auch keine Kante.
  const known = indexFilesByName(files)
  const resolveHere = (name, consumer, pkg = null) => resolveClassByName(known, name, consumer, pkg)

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
  // Feldzugriffe werden genauso gebuendelt: `Http.GET/PUT/POST` sind drei Kanten desselben Paares
  // und ergaeben sonst drei parallele Linien mit je einem Wort daran.
  const fieldGroups = new Map()
  for (const e of serverEdges.value || []) {
    const { consumer: callerFile, provider: definerFile } = endsOf(e, resolveHere) // A -> B
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

    // field-Kante = benannter Zugriff auf ein Feld der anderen Klasse -> eigene Gruppe.
    if (e.kind === 'field') {
      if (!showKind('field')) continue
      if (!fieldGroups.has(pairKey)) fieldGroups.set(pairKey, { callerFile, definerFile, fields: [] })
      fieldGroups.get(pairKey).fields.push({
        edgeId: e.id,
        method: e.method_name, // der Feldname – gleiche Form wie bei den Methoden, s. computeFieldEdgeData
        isManual: !!e.is_manual,
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
        // Steht die Implementierung fest? `null` = ja (konkrete Klasse), sonst 'interface' bzw.
        // 'abstract' – das Label setzt die Methode dann kursiv und stellt das Typzeichen davor.
        openKind: openKindOf(definerFile),
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
        // Der Pin im Bild haengt an der Vue-Flow-Kanten-Id; `data` allein kennt sie nicht.
        edgeKey: `call:${definerFile.id}-${callerFile.id}`,
        onOpen: openRelation,
        onDelete: onDeleteEdge,
      },
    })
  }

  // 1c) Je Klassenpaar EINE gebuendelte Feld-Kante. Durchgezogen wie ein Aufruf – es ist eine
  //     konkrete, benannte Abhaengigkeit –, aber in eigener Farbe und ohne die Aufruf-Semantik
  //     (kein „Please review": ein Feldzugriff wird nie geraten, die Zielklasse muss das Feld
  //     deklarieren, sonst entsteht die Kante gar nicht).
  for (const { callerFile, definerFile, fields } of fieldGroups.values()) {
    edges.push({
      id: `field:${definerFile.id}-${callerFile.id}`,
      source: `c:${definerFile.id}`,
      target: `c:${callerFile.id}`,
      type: 'managed',
      markerEnd: { type: MarkerType.ArrowClosed, color: FIELD_COLOR },
      data: {
        kind: 'field',
        sourceId: `c:${definerFile.id}`,
        targetId: `c:${callerFile.id}`,
        methods: fields,
        bundleCount: fields.length,
        method: fields[0].method,
        edgeId: fields.length === 1 ? fields[0].edgeId : null,
        isManual: fields.every((f) => f.isManual),
        fromClass: callerFile.class_name,
        toClass: definerFile.class_name,
        fromFileId: callerFile.id,
        toFileId: definerFile.id,
        edgeStyle: { stroke: FIELD_COLOR, strokeWidth: 2.1, cursor: 'pointer' },
        edgeKey: `field:${definerFile.id}-${callerFile.id}`,
        onOpen: openRelation,
      },
    })
  }

  // 2) Interne Import-Kanten (nur, wenn nicht bereits Call-Kante; nur geladene Ziele).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      // Wildcard nennt keine Klasse – weder eine Kante noch ein „externer" Eintrag (das war bisher
      // ein `*` im Zaehler der ausgeblendeten Klassen).
      if (String(dep).endsWith('.*')) continue
      const target = resolveImport(known, dep)
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
        edgeKey: `agg:${ge.id}`,
        onOpen: openRelation,
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

// Die gezeichneten Karten sind die Hindernisse der Kanten-Labels (Begruendung in useJavaGraph):
// jedes Label sucht sich damit selbst einen freien Platz an seiner Linie, statt halb unter einer
// Karte zu verschwinden. Hier statt im `layout`-computed, weil das eine reine Rechnung bleiben
// soll – ein Seiteneffekt darin liefe bei jedem Leser erneut. Die Zonen zaehlen NICHT mit: sie
// liegen als Hintergrund hinter allem und verdecken nichts.
watch(
  nodes,
  (list) => {
    const s = rootScale.value
    setLabelObstacles(
      list.map((n) => ({
        x: n.position.x,
        y: n.position.y,
        w: (n.type === 'pkg' ? PKG_W : NODE_W) * s,
        h: (n.type === 'pkg' ? PKG_H : NODE_H) * s,
      })),
    )
  },
  { immediate: true },
)

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

// --- Die Suche IM Bild --------------------------------------------------------------------------
// Die Eingabe steht links im Kopf der Klassenliste (CodeView) – hier ankommen tut sie als
// `searchQuery`, zusammen mit der Trefferliste `matchIds`. Frueher hatte der Graph ein eigenes
// Feld; damit gab es zwei Antworten auf dieselbe Frage, denn `matchIds` entstehen unscharf
// (Rang + Fuzzy) und die Markierung hier woertlich. Deshalb gilt jetzt:
//
//   * KLASSENkarten folgen `matchIds` – dieselbe Menge, die der Baum zeigt und die der Ausschnitt
//     zeichnet. Eine gezeichnete, aber unmarkierte Trefferkarte kann es nicht mehr geben.
//   * Package-Aggregate und `r:` (Rolle) pruefen sich weiter selbst: ein Aggregat hat keine Datei,
//     und die Rolle entsteht ueberhaupt erst in diesem Ausschnitt (s. lib/graphQuery.js).
//   * Kanten pruefen sich selbst (ManagedEdge liest den Zustand aus dem Composable), damit bei
//     jedem Tastendruck nicht der komplette Kanten-Store neu geschrieben wird.
const findCursor = ref(0)
const findQuery = computed(() => parseGraphQuery(props.searchQuery))

// Getroffene Karten in ZEICHENreihenfolge -> „weiter" laeuft stabil durch dasselbe Bild.
const findNodeHits = computed(() => {
  const q = findQuery.value
  if (!q) return []
  return nodes.value
    .filter((n) => {
      const fid = n.data?.fileId
      return fid != null && q.field !== 'role' ? matchIdSet.value.has(fid) : matchNode(n.data, q)
    })
    .map((n) => n.id)
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
// Ist eine Karte vom aktuellen Fund betroffen (selbst getroffen oder Endpunkt einer Treffer-Kante)?
function isFindHit(nodeId) {
  return findNodeHitSet.value.has(nodeId) || findEdgeEnds.value.has(nodeId)
}

// Zustand nach unten reichen: die Kanten lesen ihn selbst. `immediate`, weil die Ansicht mit einer
// gemerkten Suche startet – und weil der geteilte Zustand aus einem frueheren Mount sonst
// stehenbliebe (useJavaGraph ist ein Modul-Singleton).
watch(() => props.searchQuery, (v) => setGraphQuery(v), { immediate: true })
watch(findNodeHits, (ids) => setGraphHitNodes(ids), { immediate: true })

// `r:` (Rolle) ist die einzige Facette, die nur DIESER Ausschnitt beantworten kann – die Klassen
// dazu kennt die linke Spalte nicht. Also meldet der Graph seine Treffer nach oben, und der Baum
// filtert darauf (Begruendung in lib/graphQuery.js).
watch([findNodeHits, findQuery], ([ids, q]) => {
  if (q?.field !== 'role') return
  emit(
    'find-result',
    ids.map((id) => nodes.value.find((n) => n.id === id)?.data?.fileId).filter((v) => v != null),
  )
})

// --- Den Ausschnitt merken --------------------------------------------------------------------
// Alles, was AM GRAPHEN den Ausschnitt ausmacht, in einem Zug: Ebene, aufgeklappte Klassen und
// Kontextstufe samt aufgeklappten Nachbar-Packages. Die Suche und die geoeffnete Klasse kommen aus
// CodeView in denselben Schluessel (s. lib/codeState.js).
// Kein `immediate`: beim Mount steht dort bereits genau das, was hier gerade gelesen wurde.
watch([zoomPath, showClasses, contextOverride, contextExpanded], () =>
  patchCodeState({
    path: zoomPath.value,
    classes: showClasses.value,
    context: { budget: contextOverride.value, expanded: [...contextExpanded.value] },
  }),
)
watch(findQuery, () => {
  findCursor.value = 0
})

// Von Treffer zu Treffer: der Graph faehrt hin, statt dass man ihn absucht. Karten zuerst, sonst
// die Endpunkte der getroffenen Kanten (bei `review:`/`m:` gibt es oft nur Kanten-Treffer).
const findTargets = computed(() => (findNodeHits.value.length ? findNodeHits.value : [...findEdgeEnds.value]))
// ⚠️ Kamera auf EINEN Knoten: `setCenter`, nicht `fitView({ nodes: [...] })`. fitView mit einer
// Knotenliste bleibt hier wirkungslos – gemessen: der Ausschnitt stand nach einem Klassen-Klick im
// Baum unveraendert da (25 -> 22 Knoten, Viewport-Transform identisch). Ein stiller No-Op sieht aus
// wie „der Graph springt eben nicht", deshalb faehrt hier alles ueber diese eine Funktion.
// Der Zoom bleibt, wie der Nutzer ihn eingestellt hat – nur nach unten begrenzt, damit ein Treffer
// im weit herausgezoomten Bild ueberhaupt lesbar ankommt.
// Rueckgabe: die Datei-Id des angefahrenen Knotens (oder null) – CodeView schlaegt sie rechts auf.
function centerOnNode(nodeId) {
  const node = nodes.value.find((n) => n.id === nodeId)
  if (!node) return null
  const w = (node.type === 'pkg' ? PKG_W : NODE_W) * rootScale.value
  const h = (node.type === 'pkg' ? PKG_H : NODE_H) * rootScale.value
  setCenter(node.position.x + w / 2, node.position.y + h / 2, {
    zoom: Math.max(viewport.value?.zoom ?? 1, 0.75),
    duration: 320,
  })
  return node.data?.fileId ?? null
}

// Gibt die Datei-Id des angefahrenen Treffers zurueck: die Kamera allein waere der halbe Schritt –
// man saehe die Karte und muesste sie trotzdem anklicken, um zu lesen, was drin steht.
function stepFind(delta) {
  const list = findTargets.value
  if (!list.length) return null
  findCursor.value = ((findCursor.value + delta) % list.length + list.length) % list.length
  return centerOnNode(list[findCursor.value])
}
// `stepFind` wird von aussen gerufen (Enter bzw. ↑/↓ am Suchfeld in CodeView) – bewusst eine
// Methode und kein Prop: „fahr zum naechsten Treffer" ist ein Ereignis, kein Zustand; als Prop
// braeuchte es einen Zaehler wie bei `focusToken`, nur um dasselbe zweimal ausloesen zu koennen.
// `fitToView` nimmt Optionen an: der Aufrufer weiss, ob er die Tastatur bedient (0 -> sofort, so
// schnell wie ein Tastendruck) oder eine Ansicht aufraeumt (dann ein ruhiger Schwenk statt eines
// Sprungs). Die Grundwerte bleiben dieselben, damit beide Wege denselben Ausschnitt ergeben.
defineExpose({
  stepFind,
  fitToView: (opts = {}) => fitView({ padding: 0.18, maxZoom: 1.15, duration: 200, ...opts }),
  drillUp,
  // Das Detail steht rechts, bedient wird es also auch von dort (× / ESC / Klick ins Leere).
  // Der Zustand bleibt trotzdem hier: er entsteht aus Kanten, Dateiliste und Ebenen-Schluesseln,
  // die CodeView gar nicht hat. Deshalb Methoden und keine Props – „schliess jetzt" bzw. „loesch
  // diese Kante" sind Ereignisse, keine Zustaende (gleiche Begruendung wie bei `stepFind`).
  closeRelation,
  closeEdgeDetail: closeEdgePanel, // nur die Einzelkante: darunter kann eine Aggregatliste stehen
  deleteRelationEdge: onDeleteEdge,
})

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
// ZWEI Staerken, nicht eine: `soft` (0.14) fuer die Suche, `hard` (0.04) fuer den Fokus auf genau
// eine Sache. Der Unterschied ist keine Geschmacksfrage, sondern die Zahl der gemeinten Dinge –
// eine Suche meint mehrere Treffer samt ihrer Nachbarschaft und muss die uebrigen Karten als
// Umfeld lesbar lassen; ein Hover meint genau eine Verbindung, und daneben soll nichts mehr
// mitreden. Gemessen war der alte Einheitswert der Grund, warum der Fokus nicht ankam: die Linien
// lagen bei 0.07, die Karten bei 0.14 – und eine Karte traegt Rahmen, Grund und Schatten, ist also
// bei gleicher Deckkraft ungleich praesenter als eine 2 px schmale Linie.
// Rueckgabe: `'hard' | 'soft' | null`.
function dimLevel(nodeId) {
  // Vorschau aus der Ansichts-Karte steht vorn: waehrend ihrer liegt die Maus ausserhalb des
  // Canvas, es kann also weder ein Hover noch eine angeklickte Kante widersprechen. `soft` und
  // nicht `hard`, weil eine Kantenart mehrere Karten meint (dieselbe Regel wie bei der Suche).
  const pv = graphPreview.value
  if (pv?.nodes) return pv.nodes.has(nodeId) ? null : 'soft'
  const h = hoveredNode.value
  // Reihenfolge mit Absicht: der Hover ist die feinere Geste und darf INNERHALB eines Suchergebnisses
  // weiter isolieren. Liegt die Maus nirgends, bestimmt die angeklickte Kante das Bild, und erst
  // danach die Suche.
  if (!h && !hoveredEdge.value && !pinnedEdge.value && findQuery.value)
    return !isFindHit(nodeId) && !findNeighbourSet.value.has(nodeId) ? 'soft' : null
  // Anker gesetzt: es geht um EINE Verbindung, also bleiben genau ihre zwei Enden stehen.
  if (h && hoverAnchor.value) return nodeId !== h && nodeId !== hoverAnchor.value ? 'hard' : null
  // Ohne Anker meint der Hover eine ganze Nachbarschaft – mehrere Karten, wie bei der Suche.
  // Deshalb hier die weiche Stufe: sie zeigt, woraus isoliert wurde.
  if (h) return h !== nodeId && !neighbours.value.get(h)?.has(nodeId) ? 'soft' : null
  // Hover auf einer KANTE: nur ihre beiden Endpunkte bleiben stehen. Schaerfer als beim
  // Knoten-Hover (dort bleibt die ganze Nachbarschaft) – eine Kante ist genau eine Beziehung
  // zwischen genau zwei Klassen, und das soll man auch so sehen.
  const he = hoveredEdge.value || pinnedEdge.value
  if (he) return he.sourceId !== nodeId && he.targetId !== nodeId ? 'hard' : null
  return null
}
// Liegt der Blick gerade auf EINER Sache? Dann treten auch die Dinge zurueck, die gar keine Knoten
// sind: die Package-Zonen und ihre Koepfe liegen ausserhalb von Vue Flow und dimmten deshalb bisher
// nicht mit – eine vollflaechige, voll deckende Zonenordnung hinter zwei isolierten Karten macht
// genau den Fokus wieder zunichte, um den es geht.
const focusActive = computed(
  () => (!!hoveredNode.value && !!hoverAnchor.value) || !!hoveredEdge.value || !!pinnedEdge.value,
)

// --- Vorschau: die Ansichts-Karte zeigt im BILD, was ein Eintrag meint --------------------------
// „Calls" ist ein Wort; welche der sechzig Linien damit gemeint sind, sagt es nicht. Beim
// Verweilen auf einem Eintrag bleibt deshalb genau seine Teilmenge stehen und der Rest tritt
// zurueck – dieselbe Sprache wie beim Hover im Bild, nur von aussen ausgeloest. Drei Festlegungen:
//   (1) Gerechnet wird auf dem GEZEICHNETEN Layout, nicht auf dem Bestand: die Frage lautet „was
//       davon sehe ich hier?". Findet sich nichts, gibt es auch keine Vorschau – ein leergeraeumtes
//       Bild waere die Antwort auf eine Frage, die niemand gestellt hat.
//   (2) `zones` daempft NICHTS: „Group by package" ordnet die Karten, es waehlt keine aus. Gezeigt
//       wird stattdessen die Ordnung selbst (die Zonen treten hervor).
//   (3) Erst nach kurzem Verweilen (wie `HOVER_DELAY` im Bild), damit ein Schwenk ueber vier
//       Zeilen nicht viermal alle Knoten neu bewertet. Verlassen wirkt sofort.
const PREVIEW_HOLD_MS = 90
let viewPreviewTimer = null
const relatedNodeIds = computed(
  () =>
    new Set(
      relatedAsClasses.value ? relatedFiles.value.map((f) => `c:${f.id}`) : relatedNodes.value.map((n) => n.id),
    ),
)
function viewPreviewFor(key) {
  if (key === 'zones') return { edges: null, nodes: null, zones: true }
  const rel = relatedNodeIds.value
  const keep =
    key === 'related'
      ? (e) => rel.has(e.source) || rel.has(e.target)
      : (e) => (e.data?.kind || '') === key
  const edges = new Set()
  const nodes = new Set(key === 'related' ? rel : [])
  for (const e of layout.value.edges) {
    if (!keep(e)) continue
    edges.add(e.id)
    nodes.add(e.source)
    nodes.add(e.target)
  }
  return edges.size || nodes.size ? { edges, nodes, zones: false } : null
}
function startViewPreview(key) {
  clearTimeout(viewPreviewTimer)
  viewPreviewTimer = setTimeout(() => setGraphPreview(viewPreviewFor(key)), PREVIEW_HOLD_MS)
}
function endViewPreview() {
  clearTimeout(viewPreviewTimer)
  setGraphPreview(null)
}
onUnmounted(() => clearTimeout(viewPreviewTimer))
// Zaehler je Kantenart – was im Bild wirklich gezeichnet ist. Auf der Package-Ebene sind alle
// Linien Buendel, also steht dort ueberall null: „diese Art ist hier keine eigene Linie" ist eine
// Auskunft, eine erfundene Zahl waere keine.
const edgeKindCounts = computed(() => {
  const m = { call: 0, field: 0, uses: 0, import: 0 }
  for (const e of layout.value.edges) {
    const k = e.data?.kind
    if (k in m) m[k]++
  }
  return m
})
// --- „Haengt an einem Treffer" ------------------------------------------------------------------
// Die Linie zwischen Treffer und Nachbar leuchtet (s. `touchesHit` in ManagedEdge) – die Karte an
// ihrem Ende lag aber bei 0.14 und war nicht mehr zu lesen. Eine Linie, die zu einem Geist fuehrt,
// ist keine Auskunft: sie sagt „hier haengt etwas dran" und verschweigt genau, was.
//
// Drei Stufen, und jede beantwortet eine andere Frage (so steht es auch in der Legende):
//   Treffer     – das Gesuchte. Akzentfarbe, Ring, groesser.
//   verbunden   – haengt daran. Volle Deckkraft, KEIN Akzent: sie traegt weiter ihre eigene
//                 Rollen-/Typ-/Package-Farbe, sonst waere die Trefferfarbe plotzlich die Farbe von
//                 zwanzig Karten und saehe aus wie zwanzig Treffer.
//   gedaempft   – gerade nicht gemeint.
const findNeighbourSet = computed(() => {
  if (!findQuery.value) return new Set()
  const out = new Set()
  for (const id of findNodeHitSet.value) {
    for (const n of neighbours.value.get(id) || []) out.add(n)
  }
  for (const id of findEdgeEnds.value) out.add(id)
  return out
})
// Nur die Nachbarn, die NICHT selbst Treffer sind – die Karte soll genau einen Zustand tragen.
function isFindNeighbour(nodeId) {
  return !!findQuery.value && findNeighbourSet.value.has(nodeId) && !findNodeHitSet.value.has(nodeId)
}

// Endpunkt der angeklickten Kante? Traegt einen bleibenden Ring statt des fluechtigen Hover-Rings.
function isPinnedEnd(nodeId) {
  const p = pinnedEdge.value
  return !!p && (p.sourceId === nodeId || p.targetId === nodeId)
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

// --- Der Anker: die offene Klasse als Bezugspunkt ------------------------------------------------
// Wer eine Klasse aufgeschlagen hat, sieht im Bild alle ihre Beziehungen auf einmal. Der Hover auf
// einen Nachbarn beantwortete bis dahin eine ANDERE Frage – er zeigte dessen eigene Nachbarschaft,
// also ein halbes Dutzend Klassen, die mit der aufgeschlagenen nichts zu tun haben. Gefragt ist:
// „was genau verbindet die beiden?" Also bleiben nur noch der Anker, der gehoverte Knoten und die
// Linien dazwischen stehen.
// Der Anker gilt nur, wenn beide ueber eine GEZEICHNETE Kante zusammenhaengen: sonst gibt es keine
// Verbindung zu isolieren, und es bleibt beim bisherigen Nachbarschafts-Fokus.
const anchorId = computed(() => (props.selectedId != null ? `c:${props.selectedId}` : null))
function anchorFor(nodeId) {
  const a = anchorId.value
  if (!a || a === nodeId) return null
  return neighbours.value.get(a)?.has(nodeId) ? a : null
}
// Die staerkste Aussage faerbt die Verbindung: ein Aufruf sagt mehr als ein Import, und die Farbe
// am Ring beider Karten ist dieselbe wie an der Linie – eine Aussage, ein Ton.
const KIND_RANK = { call: 4, field: 3, uses: 2, import: 1, aggregate: 0 }
function connectionColor(aId, bId) {
  let best = null
  for (const e of layout.value.edges) {
    const d = e.data || {}
    if (!((d.sourceId === aId && d.targetId === bId) || (d.sourceId === bId && d.targetId === aId))) continue
    if (!best || (KIND_RANK[d.kind] ?? 0) > (KIND_RANK[best.kind] ?? 0)) best = d
  }
  return best?.edgeStyle?.stroke || 'var(--color-accent)'
}
// Im Ankerfall gibt es nichts auseinanderzuhalten – es sind genau zwei Karten und eine Verbindung.
// Also KEINE sechs Identitaetsfarben, sondern EINE: beide Karten und jede Linie dazwischen tragen
// sie, und damit ist sichtbar, dass sie zusammen eine einzige Aussage sind.
// ⚠️ Welche EINE, steht schon fest, sobald die Klasse offen ist: der Nachbar traegt dann bereits
// seine Zuordnungsfarbe (`selectionPalette`). Der Hover uebernimmt sie, statt auf die Art-Farbe zu
// wechseln – sonst spraenge dieselbe Verbindung beim Draufzeigen in einen anderen Ton.
function pairPalette(anchor, nodeId) {
  const color = selectionPalette.value?.get(nodeId) || connectionColor(anchor, nodeId)
  return new Map([
    [anchor, color],
    [nodeId, color],
  ])
}

// --- Zuordnungsfarben der offenen Klasse ---------------------------------------------------------
// Dieselbe Palette wie beim Hover, nur bleibend: sobald eine Klasse rechts aufgeschlagen ist,
// bekommt jeder ihrer direkten Nachbarn eine eigene Farbe – und die Linie dorthin dieselbe. Damit
// beantwortet das Bild „welche dieser zwoelf Linien endet an welcher Karte?" ohne Mauszeiger.
// Gerechnet wird hier (der Graph kennt Nachbarschaft und Lage), abgelegt im Composable, weil
// `ManagedEdge` selbst liest – sonst muesste bei jeder Auswahl der komplette Kanten-Store neu
// geschrieben werden.
watchEffect(() => {
  const a = anchorId.value
  // Nur wenn die offene Klasse auch GEZEICHNET ist: eine Palette um einen Knoten, den niemand
  // sieht, faerbte Karten nach einem Bezugspunkt ausserhalb des Bildes.
  if (!a || !neighbours.value.has(a)) {
    setSelectionColors(null)
    return
  }
  setSelectionColors(a, neighbourPalette(a))
})
// Die Farbe, die eine Karte durch die offene Klasse traegt. Der Anker selbst bleibt neutral – er
// ist der Bezugspunkt, nicht eines der unterschiedenen Dinge (gleiche Regel wie beim Hover), und
// traegt ohnehin den Auswahl-Ring in seiner Rollenfarbe.
function kinColor(nodeId) {
  const a = selectionAnchor.value
  if (!a || a === nodeId) return null
  return selectionPalette.value?.get(nodeId) || null
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
  // Ankerfall: BEIDE Enden tragen die Farbe der Verbindung – hier gibt es keinen „Bezugspunkt
  // gegen den Rest", sondern zwei gleichrangige Enden einer einzigen Aussage.
  if (h && hoverAnchor.value) return hoverPalette.value?.get(nodeId) || null
  if (h) return h === nodeId ? null : hoverPalette.value?.get(nodeId) || null
  // Angeklickte Kante: dieselbe Regel wie beim Kanten-Hover, nur bleibend – die Karte traegt die
  // Farbe der Linie, die zu ihr fuehrt.
  const he = hoveredEdge.value || pinnedEdge.value
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
    // Haengt die Karte an der offenen Klasse, ist EINE Verbindung gemeint – sonst wie bisher die
    // Nachbarschaft dieser Karte. Palette und Anker entstehen genau hier, einmal je Hover, nicht
    // als computed pro Karte: beide haengen an der Nachbarschaft, und die aendert sich waehrend
    // eines Hovers nicht.
    const anchor = id ? anchorFor(id) : null
    setHoveredNode(id, id ? (anchor ? pairPalette(anchor, id) : neighbourPalette(id)) : null, anchor)
    // …und rechts steht sie dann auch. Ein Bild, das eine Beziehung isoliert, aber nicht sagt,
    // WAS sie ist, laesst genau die Frage offen, wegen der man hingezeigt hat.
    if (anchor) previewSoon('node', () => showConnection(anchor, id))
  }, NODE_HOVER_INTENT_MS)
}
function onNodeLeave() {
  clearTimeout(nodeHoverTimer)
  setHoveredNode(null)
  endPreviewFrom('node')
}
// Modul-State: beim Verlassen des Code-Tabs koennte sonst ein gedimmter Graph zurueckbleiben.
onUnmounted(() => {
  clearTimeout(nodeHoverTimer)
  clearTimeout(previewTimer)
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
  if (node?.data?.fileId == null) return
  // Kam die Karte mit einer Vorschau daher, gibt ihr der Klick Halt: die Beziehung bleibt rechts
  // stehen, das Bild markiert sie weiter (Pin auf dem PAAR – eine Verbindung besteht oft aus
  // mehreren Linien), und die angeklickte Klasse wird der neue Anker. So laeuft man die Kante
  // entlang, statt bei jedem Schritt neu suchen zu muessen.
  const anchor = anchorFor(node.id)
  if (anchor) {
    clearTimeout(previewTimer)
    // Schneller geklickt als die Vorschau steht -> dieselbe Ansicht jetzt aufbauen.
    if (!previewing.value) showConnection(anchor, node.id)
    dropPreview()
    relationPick.value++
    pinnedRaw.value = { pair: true, sourceId: anchor, targetId: node.id, color: connectionColor(anchor, node.id) }
  }
  emit('select', node.data.fileId)
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
    // waehrend die Karten unnoetig klein blieben. Der Einzelknoten laeuft ueber `centerOnNode`
    // (s. dort: fitView mit Knotenliste bewegt hier gar nichts).
    const fit = () =>
      hasFocus ? centerOnNode(focusId) : fitView({ padding: 0.18, maxZoom: 1.15, duration: 200 })
    if (hasFocus) pendingFocusNode.value = null
    requestAnimationFrame(fit)
    // Zweiter Anlauf: fitView rechnet mit den GEMESSENEN Knotengroessen. Werden viele Knoten auf
    // einmal ausgetauscht (Ebenenwechsel: 8 Packages -> 125 Klassen), sind die neuen im ersten
    // Frame noch nicht vermessen und der Ausschnitt bliebe halb ausserhalb des Canvas.
    setTimeout(fit, 280)
  },
)

// --- Kanten-Detail (Spalte 3 von CodeView) ------------------------------------
// Die Call-Sites werden erst beim Klick fuer das konkrete Klassenpaar + Methode berechnet
// (rein zur Anzeige; die Existenz der Kante kommt aus dem Backend). Gezeigt wird das Ergebnis
// nicht mehr hier, sondern rechts neben dem Graphen: der Code zu einer Beziehung ist dasselbe
// Lesen wie der Code einer Klasse und gehoert an dieselbe Stelle. Ein Modal darueber verdeckte
// ausgerechnet den Graphen, aus dem man kam, und liess sich nicht neben ihm lesen.
const activeEdge = ref(null)
// Laeuft, waehrend die Methodenruempfe fuer das Edge-Panel nachgeladen werden (s. methodsOf).
const edgePanelLoading = ref(false)
// Startzeitpunkt der Wartemeldung (die Uhr laeuft in `BusyState`) und ein Zaehler, der eine
// ueberholte Antwort erkennt: wer waehrend des Ladens eine andere Kante klickt oder schliesst,
// soll nicht Sekunden spaeter das alte Ergebnis vorgesetzt bekommen.
const edgePanelSince = ref(0)
let edgeToken = 0

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

// Dieselbe Rechnung wie `computeCallEdgeData`, nur fuer FELDER: gesucht wird der Feldname als
// ganzes Wort statt als Aufruf mit Klammern. Zwei Unterschiede, beide notwendig:
//   * Ein Feld hat keine Aufrufstelle, sondern eine ZUGRIFFSSTELLE – und die kann auch in einem
//     Feld-Initialisierer stehen (`private String mode = Status.ACTIVE;`). Der Aufrufer ist dann
//     selbst ein Feld, kein Methodenrumpf; das Panel muss ihn ohne `()` anschreiben.
//   * „Please review" gibt es hier nicht: eine Feld-Kante entsteht nur, wenn die Zielklasse das
//     Feld deklariert – geraten wird nichts.
function computeFieldEdgeData(callerFile, definerFile, fields, edgeMeta = {}) {
  const list = (fields || []).filter((f) => f && f.method)
  const callSites = []
  const panelMethods = []
  for (const meta of list) {
    const name = meta.method
    const safe = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![\\w$])${safe}(?![\\w$])`, 'g')
    for (const ca of callerFile.methods || []) {
      const body = ca.body || ''
      if (!body) continue
      const base = ca.body_start_line ?? ca.start_line ?? null
      const lineExact = ca.body_start_line != null
      let m
      while ((m = re.exec(body)) !== null) {
        const relLine = (body.slice(0, m.index).match(/\n/g) || []).length
        callSites.push({
          callerMethod: ca.method_name,
          callerIsField: (ca.member_kind || 'method') === 'field',
          calleeMethod: name,
          callerBody: body,
          bodyStartLine: base,
          line: base != null ? base + relLine : (ca.start_line ?? 1) + relLine,
          lineExact,
        })
      }
    }
    const def = (definerFile.methods || []).find((mm) => mm.method_name === name)
    panelMethods.push({
      edgeId: meta.edgeId ?? null,
      name,
      signature: def ? buildFieldSignature(def) : '',
      isManual: !!meta.isManual,
      confidence: 1,
      needsReview: false,
    })
  }
  const single = panelMethods.length === 1
  return {
    kind: 'field',
    bundleCount: panelMethods.length,
    methods: panelMethods,
    needsReview: false,
    edgeId: single ? panelMethods[0].edgeId : null,
    method: single ? panelMethods[0].name : null,
    isManual: !!edgeMeta.isManual,
    fromClass: callerFile.class_name,
    toClass: definerFile.class_name,
    fromFileId: callerFile.id,
    toFileId: definerFile.id,
    callSites,
    callees: panelMethods.map((p) => p.name),
    calleeSignatures: panelMethods.map((p) => ({ name: p.name, signature: p.signature })),
  }
}

// Signatur eines Feldes: `public static final String ACCEPT` – ohne Klammern (s. Backend).
const buildFieldSignature = (m) =>
  `${(m.modifiers || []).join(' ')} ${m.return_type || ''} ${m.method_name}`.replace(/\s+/g, ' ').trim()

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
    // Aufrufstellen -> der Verwendung-Abschnitt zeigt dann einen leeren Zustand). Feld-Kanten
    // gehen denselben Weg: sie benennen ebenfalls ein Mitglied, nur ohne Klammern.
    if (!d || (d.kind !== 'call' && d.kind !== 'field')) return
    const isFieldEdge = d.kind === 'field'
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
    // Der Klick wird SOFORT beantwortet. Kopfzeile und Methodennamen sind bereits bekannt (die
    // Dateiliste liegt im Store, die Namen stecken in den Kantendaten) – es fehlen nur die
    // Ruempfe beider Klassen, und genau die kosten die Zeit. Das Panel oeffnet deshalb mit dem,
    // was da ist, und traegt die Wartemeldung darin. Vorher passierte nach dem Klick sichtbar
    // nichts, bis alles geladen war: auf dem Pi las sich das wie ein verschluckter Klick.
    const token = ++edgeToken
    edgePanelSince.value = Date.now()
    edgePanelLoading.value = true
    activeEdge.value = {
      kind: d.kind,
      fromClass: callerFile.class_name,
      toClass: definerFile.class_name,
      fromFileId: callerFile.id,
      toFileId: definerFile.id,
      // Dieselbe Form wie `computeCallEdgeData` sie liefert – nur ohne Signatur und Aufrufstellen,
      // die beide erst aus den Ruempfen entstehen. So rendert der Kopf schon richtig (inklusive
      // „Please review", das aus den Kantendaten kommt und nicht aus dem Code).
      methods: methodList.map((m) => ({
        edgeId: m.edgeId ?? null,
        name: m.method,
        signature: '',
        isManual: !!m.isManual,
        confidence: m.confidence ?? 1,
        needsReview: !!m.needsReview,
      })),
      needsReview: methodList.some((m) => m.needsReview),
      bundleCount: methodList.length,
      isManual: !!d.isManual,
      callSites: [],
      callees: methodList.map((m) => m.method),
      calleeSignatures: [],
    }
    try {
      const [callerMethods, definerMethods] = await Promise.all([
        methodsOf(d.fromFileId),
        methodsOf(d.toFileId),
      ])
      // Inzwischen eine andere Kante geklickt oder das Panel geschlossen -> dieses Ergebnis
      // gehoert zu einer Frage, die niemand mehr stellt.
      if (token !== edgeToken) return
      const compute = isFieldEdge ? computeFieldEdgeData : computeCallEdgeData
      activeEdge.value = compute(
        { ...callerFile, methods: callerMethods },
        { ...definerFile, methods: definerMethods },
        methodList,
        { isManual: d.isManual },
      )
    } finally {
      if (token === edgeToken) edgePanelLoading.value = false
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
  // Nachbarklassen, die als EIGENE KARTE gezeichnet sind, sind im Bild Klassen und nicht ihr
  // Package – sonst faende die Verbindung zwischen zwei gezeichneten Karten nichts. Sicher, weil
  // genau dann kein Aggregatknoten existiert (`relatedNodes` ist leer, s. dort): die Warnung oben
  // gilt dem umgekehrten Fall, in dem ein `c:`-Schluessel eine Package-Zuordnung ueberschrieb.
  if (relatedAsClasses.value) for (const f of relatedFiles.value) m.set(f.id, `c:${f.id}`)
  return m
})

// Die eine Rechnung hinter zwei Fragen: „was steckt in dieser Aggregatkante?" (`relationsBetween`,
// gerichtet) und „was verbindet diese beiden Karten?" (`connectionRelations`, beide Richtungen).
// `accepts(provider, consumer)` entscheidet, welche Paare mitzaehlen – alles andere (Gruppierung,
// Rangfolge, Import-Fallback) ist fuer beide identisch und darf es deshalb nur einmal geben.
function collectRelations(accepts) {
  const files = props.files || []
  const groups = new Map()
  const add = (provider, consumer, kind, method) => {
    const k = `${provider.id}->${consumer.id}`
    let g = groups.get(k)
    if (!g) {
      g = { key: k, provider, consumer, kind, methods: [] }
      groups.set(k, g)
    }
    // Ein Paar kann mehrere Kantenarten haben – die staerkste Aussage gewinnt fuer das Badge.
    // Die staerkste Aussage gewinnt fuer das Badge der Zeile: Aufruf > Feldzugriff > Typbezug >
    // Import. Ein Paar kann mehrere Arten haben; die Zeile trägt aber nur eine Beschriftung.
    const RANK = { call: 3, field: 2, uses: 1, import: 0 }
    if ((RANK[kind] ?? 0) > (RANK[g.kind] ?? 0)) g.kind = kind
    if (method) g.methods.push(method)
  }

  for (const e of serverEdges.value || []) {
    // Dieselbe Zuordnung wie in `allClassEdges` – sonst nennt das Panel andere Paare, als der
    // Graph gezählt hat, und die angeschriebene Zahl stimmte nicht mehr mit der Liste überein.
    const { consumer, provider } = endsOf(e, resolveClass)
    if (!consumer || !provider || consumer.id === provider.id) continue
    if (!accepts(provider, consumer)) continue
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
      const provider = resolveImport(filesByName.value, dep)
      if (!provider || provider.id === f.id) continue
      if (!accepts(provider, f)) continue
      if (groups.has(`${provider.id}->${f.id}`)) continue
      add(provider, f, 'import', null)
    }
  }

  const rank = { call: 0, field: 1, uses: 2, import: 3 }
  return [...groups.values()].sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      a.provider.class_name.localeCompare(b.provider.class_name) ||
      a.consumer.class_name.localeCompare(b.consumer.class_name),
  )
}

// Aggregatkante: alles, was von `sourceKey` nach `targetKey` zeigt.
function relationsBetween(sourceKey, targetKey) {
  const keyOf = bundleKeys.value
  return collectRelations((p, c) => keyOf.get(p.id) === sourceKey && keyOf.get(c.id) === targetKey)
}

// Verbindung zweier Knoten: dasselbe in BEIDE Richtungen. Eine Verbindung hat keine Richtung – ihre
// einzelnen Beziehungen schon, und genau die stehen dann als Zeilen untereinander. In EINEM Lauf,
// nicht zweimal `relationsBetween`: sonst zaehlt derselbe Kantenbestand doppelt durch.
function connectionRelations(aKey, bKey) {
  const keyOf = bundleKeys.value
  return collectRelations((p, c) => {
    const kp = keyOf.get(p.id)
    const kc = keyOf.get(c.id)
    return (kp === aKey && kc === bKey) || (kp === bKey && kc === aKey)
  })
}

function openBundlePanel(d) {
  if (!d || d.kind !== 'aggregate') return
  const relations = relationsBetween(d.sourceId, d.targetId)
  activeBundle.value = {
    mode: 'aggregate',
    fromLabel: labelForKey(d.sourceId),
    toLabel: labelForKey(d.targetId),
    fromIsClass: String(d.sourceId).startsWith('c:'),
    toIsClass: String(d.targetId).startsWith('c:'),
    count: d.count,
    relations,
  }
}

// --- Die VERBINDUNG zweier Knoten zeigen --------------------------------------------------------
// Antwort auf „was genau haengt zwischen diesen beiden?" – also auf den Hover ueber einen Nachbarn
// der offenen Klasse und auf den Klick darauf. Zwei Auspraegungen, EINE Frage:
//   * genau eine Beziehung mit Mitgliedern -> direkt die reiche Kanten-Ansicht. Eine Liste mit
//     einem einzigen Eintrag waere ein Umweg um dieselbe Auskunft, und sie zeigt weniger
//     (Signaturen, alle Aufrufstellen, eigene Suche).
//   * sonst -> die Liste, gruppiert nach Klassenpaar und Richtung. Auch reine `uses`/`import`-
//     Beziehungen stehen darin: das Panel belegt sie mit den Zeilen, in denen der Typ auftaucht,
//     statt leer zu bleiben.
// Rueckgabe: ob es ueberhaupt etwas zu zeigen gab.
//
// Spalte 3 zeigt IMMER genau eines von beidem – deshalb wird der jeweils andere Zustand geloescht
// und ein noch laufender Ladevorgang entwertet (`edgeToken`), bevor etwas Neues Platz nimmt.
function clearRelationState() {
  edgeToken++
  edgePanelLoading.value = false
  activeEdge.value = null
  activeBundle.value = null
}

// Was zeigt eine einzelne LINIE? Genau sich selbst – ausser sie traegt keine Mitglieder
// (`uses`/`import`): dann ist die Verbindung ihrer beiden Enden die einzige Auskunft, die es gibt,
// und die Linie steht darin als eigene Zeile mit ihren Fundstellen im Quelltext.
function showEdgeRelation(data) {
  if (!data) return false
  if (data.kind === 'aggregate' || data.kind === 'call' || data.kind === 'field') {
    clearRelationState()
    if (data.kind === 'aggregate') openBundlePanel(data)
    else openEdgePanel(data)
    return true
  }
  return showConnection(data.sourceId, data.targetId)
}

function showConnection(aKey, bKey) {
  const relations = connectionRelations(aKey, bKey)
  if (!relations.length) return false
  const single = relations.length === 1 && relations[0].methods.length ? relations[0] : null
  clearRelationState()
  if (single) {
    // Nicht awaiten: das Panel oeffnet sofort mit dem, was ohne Request bekannt ist (s. dort).
    openRelationCode(single)
    return true
  }
  activeBundle.value = {
    mode: 'connection',
    fromLabel: labelForKey(aKey),
    toLabel: labelForKey(bKey),
    fromIsClass: String(aKey).startsWith('c:'),
    toIsClass: String(bKey).startsWith('c:'),
    count: relations.length,
    relations,
  }
  return true
}

// --- Vorschau: die Beziehung unter der Maus, ohne Klick ------------------------------------------
// Wer auf eine Linie oder auf einen Nachbarn der offenen Klasse zeigt, liest die Beziehung rechts
// schon, bevor er klickt. Der geklickte Stand wird dafuer beiseitegelegt und beim Verlassen Zeichen
// fuer Zeichen zurueckgeholt: eine Vorschau darf nichts wegnehmen, was jemand ausgewaehlt hat.
// Der Klick macht aus ihr den Stand – ohne irgendetwas neu zu laden, es steht ja bereits da.
const previewing = ref(false)
// Zaehler statt Flag: „der Nutzer hat DAS hier gewaehlt" ist ein Ereignis – ein Flag muesste jemand
// wieder zuruecksetzen, und genau das vergisst man an der dritten Aufrufstelle.
const relationPick = ref(0)
let stashed = null
// Woher kam die Vorschau? Knoten- und Kanten-Hover loeschen sich gegenseitig, und nur die Geste,
// die sie geoeffnet hat, darf sie auch wieder schliessen.
let previewSource = null // 'node' | 'edge' | null
// Der Hover-Fokus im Bild sitzt nach 90 ms (s. NODE_HOVER_INTENT_MS); das PANEL wartet laenger.
// Beim Queren eines dichten Feldes ist jede Vorschau sonst zwei Requests je gestreifter Karte –
// und ein Panel, das im Vorbeiziehen dreimal wechselt, liest ohnehin niemand.
const PREVIEW_DELAY_MS = 180
let previewTimer = null

// Rueckgabe: ob beiseitegelegt werden konnte. Laedt rechts noch der geklickte Stand, gibt es
// nichts sauber Zurueckholbares – eine halb geladene Beziehung waere nach der Vorschau fuer immer
// halb. Dann lieber keine Vorschau als ein Panel, dem der Code fehlt.
function beginPreview() {
  if (previewing.value) return true
  if (edgePanelLoading.value) return false
  stashed = { edge: activeEdge.value, bundle: activeBundle.value }
  previewing.value = true
  return true
}
function endPreview() {
  clearTimeout(previewTimer)
  previewSource = null
  if (!previewing.value) return
  // Ein noch laufender Vorschau-Ladevorgang darf den zurueckgeholten Stand nicht ueberschreiben.
  edgeToken++
  edgePanelLoading.value = false
  activeEdge.value = stashed?.edge ?? null
  activeBundle.value = stashed?.bundle ?? null
  stashed = null
  previewing.value = false
}
// Aus der Vorschau wird der Stand (Klick) – oder sie wird verworfen, weil etwas anderes rechts
// Platz nimmt (ESC, Klick ins Leere). Beides heisst: nichts mehr zurueckholen.
function dropPreview() {
  clearTimeout(previewTimer)
  previewSource = null
  stashed = null
  previewing.value = false
}
// `show` wird erst nach der Verzoegerung gerufen und muss melden, ob es etwas zu zeigen gab: eine
// begonnene Vorschau ohne Inhalt waere ein Zustand, den niemand mehr aufloest.
function previewSoon(source, show) {
  clearTimeout(previewTimer)
  previewSource = source
  previewTimer = setTimeout(() => {
    if (!beginPreview()) return
    if (!show()) endPreview()
  }, PREVIEW_DELAY_MS)
}
// Nur die Geste beenden, die auch begonnen hat (Knoten-Hover loescht den Kanten-Hover und
// umgekehrt – ohne die Pruefung raeumte die eine der anderen die Vorschau weg).
function endPreviewFrom(source) {
  if (previewSource === source) endPreview()
}

// Der Kanten-Hover entsteht in ManagedEdge (die Kante liest den geteilten Zustand selbst, s. dort).
// Also hoert der Graph darauf, statt einen weiteren Rueckkanal zu bauen: er allein kennt die
// Kantendaten und die Dateiliste, aus denen die Beziehung rechts entsteht.
watch(hoveredEdge, (he) => {
  if (!he) return endPreviewFrom('edge')
  const data = layout.value.edges.find((e) => e.id === he.id)?.data
  previewSoon('edge', () => showEdgeRelation(data))
})
function closeBundlePanel() {
  activeBundle.value = null
  // Steht darueber noch eine Einzelkante aus dieser Liste, gehoert der Pin weiterhin ihr.
  if (!activeEdge.value) pinnedRaw.value = null
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
  // Feld-Beziehungen rechnen dieselbe Form, suchen aber den Namen OHNE Klammern.
  const compute = rel.kind === 'field' ? computeFieldEdgeData : computeCallEdgeData
  return compute(
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
    kind: rel.kind === 'field' ? 'field' : 'call',
    fromFileId: rel.consumer.id, // Aufrufer
    toFileId: rel.provider.id, // Definition
    methods: rel.methods,
    isManual: rel.methods.every((m) => m.isManual),
  })
}

// EIN Weg fuer beide Klickflaechen einer Kante: die Linie (@edge-click) und das Label
// (`data.onOpen` in ManagedEdge, das den Klick abfaengt und deshalb nie bei @edge-click ankommt).
// Vorher stand die Pin-Logik nur am ersten – gemessen: Klick auf das Label oeffnete das Detail,
// markierte im Bild aber nichts.
function openRelation(d, edgeId = null) {
  if (!d || (d.kind !== 'aggregate' && d.kind !== 'call' && d.kind !== 'field')) return
  // Der Klick uebernimmt, was die Vorschau schon zeigt – ohne das Verwerfen wuerde das naechste
  // `mouseleave` den beiseitegelegten Stand zurueckholen und die eben geoeffnete Beziehung wieder
  // wegnehmen.
  dropPreview()
  relationPick.value++
  // Der Pin ist die Ortsangabe zum Detail rechts: dieselbe Form wie beim Kanten-Hover, damit
  // Karten, Linie und Label ihn ohne zweite Regel lesen koennen.
  pinnedRaw.value = {
    id: d.edgeKey || edgeId,
    sourceId: d.sourceId,
    targetId: d.targetId,
    color: d.edgeStyle?.stroke || 'var(--color-accent)',
  }
  if (d.kind === 'aggregate') return openBundlePanel(d)
  openEdgePanel(d)
}
function onEdgeClick({ edge }) {
  openRelation(edge?.data, edge?.id)
}
function closeEdgePanel() {
  dropPreview()
  // Ein noch laufender Ladevorgang darf das Panel nicht wieder aufziehen.
  edgeToken++
  edgePanelLoading.value = false
  activeEdge.value = null
  // Kam die Kante aus einer Aggregatliste („Full details"), steht die Liste darunter noch – dann
  // ist das Schliessen der Rueckweg dorthin und nicht das Ende der Untersuchung.
  if (!activeBundle.value) pinnedRaw.value = null
}

// --- Was steht gerade rechts? ------------------------------------------------------------------
// EINE Meldung fuer beide Panelarten, gesendet bei jeder Aenderung ihres Zustands (auch waehrend
// des Ladens – das Detail oeffnet sofort mit dem, was bekannt ist, s. `openEdgePanel`).
// Die Einzelkante gewinnt gegen das Buendel: „Full details" oeffnet sie AUS der Liste heraus, und
// beim Schliessen kommt genau diese Liste wieder zum Vorschein.
// `preview` unterscheidet „das steht hier, weil die Maus darauf zeigt" von „das wurde gewaehlt":
// eine Vorschau darf sich keine Spaltenbreite leihen und den Reiter nur voruebergehend nach vorn
// holen. `pick` zaehlt die bewussten Entscheidungen – daran erkennt CodeView, ob die Vorschau
// zurueckgefallen oder per Klick uebernommen worden ist (ein Flag muesste jemand zuruecksetzen).
watch(
  [activeEdge, edgePanelLoading, edgePanelSince, activeBundle, previewing],
  () => {
    const meta = { preview: previewing.value, pick: relationPick.value }
    if (activeEdge.value) {
      emit('relation', {
        kind: 'edge',
        edge: activeEdge.value,
        loading: edgePanelLoading.value,
        since: edgePanelSince.value,
        back: activeBundle.value ? (activeBundle.value.mode === 'connection' ? 'Connection' : 'Bundled relations') : null,
        ...meta,
      })
    } else if (activeBundle.value) {
      emit('relation', {
        kind: 'bundle',
        bundle: activeBundle.value,
        loadDetail: loadRelationDetail,
        openRelation: openRelationCode,
        ...meta,
      })
    } else {
      emit('relation', null)
    }
  },
  { deep: false },
)

// Klick ins Leere: frueher war das der Klick auf den Backdrop des Modals – dieselbe Geste, gleiche
// Wirkung. Bewusst NICHT in `clearHighlights`: die laeuft auch beim Klick auf eine Karte, und dort
// waehlt man eine Klasse aus, ohne die untersuchte Beziehung aufzugeben.
function onPaneClick() {
  clearHighlights()
  closeRelation()
}

// Alles zu, in einem Zug: ×/ESC in Spalte 3 und der Klick auf die freie Graphflaeche meinen „ich
// bin fertig mit dieser Beziehung" – dann auch die Liste darunter, sonst spraenge sie beim
// Schliessen der Einzelkante wieder auf.
function closeRelation() {
  // Auch die beiseitegelegte Vorschau: „fertig" heisst fertig, sonst kaeme sie beim naechsten
  // Verlassen einer Karte wieder hervor.
  dropPreview()
  edgeToken++
  edgePanelLoading.value = false
  activeEdge.value = null
  activeBundle.value = null
  pinnedRaw.value = null
}

// --- Pin: die angeklickte Kante im Bild markieren ---------------------------------------------
// `pinnedRaw` ist die Absicht, `pinnedEdge` (Composable) die Wirkung. Dazwischen zwei Bedingungen,
// beide gemessen an dem, was sonst passiert:
//   * Das Detail muss rechts SICHTBAR sein (`relationVisible`) – sonst daempft der Graph fuer
//     etwas, das gerade niemand ansieht.
//   * Mindestens ein Endpunkt muss gezeichnet sein. Wer nach dem Klick eine Ebene hoeher geht,
//     haette sonst einen Pin auf zwei Knoten, die es im Bild nicht gibt – und weil die Daempfung
//     „alles ausser diesen beiden" lautet, waere das Bild vollstaendig leer.
const pinnedRaw = ref(null)
watchEffect(() => {
  const p = pinnedRaw.value
  if (!p || !props.relationVisible) return setPinnedEdge(null)
  const ids = new Set(layout.value.nodes.map((n) => n.id))
  setPinnedEdge(ids.has(p.sourceId) || ids.has(p.targetId) ? p : null)
})
// Modul-State: beim Verlassen des Code-Tabs bliebe sonst ein gedimmter Graph zurueck.
onUnmounted(() => setPinnedEdge(null))

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
    // Package beider Seiten mitschicken: der Nutzer hat auf KARTEN gezogen, meint also genau
    // diese zwei Dateien. Ohne das Package wäre die Kante wieder nur namensbasiert und träfe bei
    // zwei gleichnamigen Klassen die falsche.
    await createEdge({
      source: c.targetFile.class_name,
      sourcePkg: c.targetFile.package || undefined,
      target: c.sourceFile.class_name,
      targetPkg: c.sourceFile.package || undefined,
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
    <div
      v-if="files.length && zones.length"
      class="vf-zonelayer"
      :class="{ 'vf-zonelayer--muted': focusActive, 'vf-zonelayer--lit': graphPreview?.zones }"
      :style="viewportStyle"
    >
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
      @pane-click="onPaneClick"
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
              'vf-card--near': isFindNeighbour(`c:${data.fileId}`),
              'vf-card--context': data.isContext,
              'vf-card--dim': dimLevel(`c:${data.fileId}`) === 'soft',
              'vf-card--mute': dimLevel(`c:${data.fileId}`) === 'hard',
              'vf-card--focus': !!focusColor(`c:${data.fileId}`),
              'vf-card--kin': !focusColor(`c:${data.fileId}`) && !!kinColor(`c:${data.fileId}`),
              'vf-card--pinned': isPinnedEnd(`c:${data.fileId}`),
              'vf-card--find': findNodeHitSet.has(`c:${data.fileId}`),
            },
          ]"
          :style="{ '--pkg': data.color, '--edge': focusColor(`c:${data.fileId}`) || kinColor(`c:${data.fileId}`) }"
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
            'vf-card--near': isFindNeighbour(`p:${data.path}`),
            'vf-card--dim': dimLevel(`p:${data.path}`) === 'soft',
            'vf-card--mute': dimLevel(`p:${data.path}`) === 'hard',
            'vf-card--focus': !!focusColor(`p:${data.path}`),
            'vf-card--kin': !focusColor(`p:${data.path}`) && !!kinColor(`p:${data.path}`),
            'vf-card--pinned': isPinnedEnd(`p:${data.path}`),
            'vf-card--find': findNodeHitSet.has(`p:${data.path}`),
          }"
          :style="{ '--pkg': data.color, '--edge': focusColor(`p:${data.path}`) || kinColor(`p:${data.path}`) }"
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
    <div
      v-if="files.length && zones.length"
      class="vf-zonelayer vf-zonelayer--front"
      :class="{ 'vf-zonelayer--muted': focusActive, 'vf-zonelayer--lit': graphPreview?.zones }"
      :style="viewportStyle"
    >
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
    <!-- Oben links stehen ZWEI Dinge, und sie beantworten zwei Fragen: „wieviel Umgebung will ich
         sehen?" (Layer-Karte) und „wo bin ich, was ist im Bild?" (Leiste darunter). Frueher war
         der Regler der dritte Abschnitt der Leiste – zwischen Pfad und Warnungen eingeklemmt und
         entsprechend klein. Als eigene Karte darueber ist er das, was er ist: die einzige
         Einstellung, die der Suchmodus verlangt. -->
    <div v-if="files.length && (searchActive || level.groups.length || basePath)" class="vf-topleft">
      <!-- Umgebungs-Auswahl: jede Stufe eine Zeile, alle gleichzeitig sichtbar. Kein Regler –
           „20" sagt nichts, „+33 folded into packages" schon. -->
      <div
        v-if="contextAvailable"
        class="vf-layers"
        role="radiogroup"
        aria-label="How many related classes to draw"
        @keydown.up.prevent="stepContext(-1)"
        @keydown.left.prevent="stepContext(-1)"
        @keydown.down.prevent="stepContext(1)"
        @keydown.right.prevent="stepContext(1)"
      >
        <div class="vf-layers-head">
          <Icon icon="lucide:layers" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span class="vf-layers-title">Context</span>
          <span class="vf-layers-total">{{ searchScope.related }} related</span>
        </div>

        <button
          v-for="l in contextLayers"
          :key="l.step"
          type="button"
          class="vf-layer"
          :class="{ 'is-on': contextBudget === l.step }"
          role="radio"
          :aria-checked="contextBudget === l.step"
          @click="setContextBudget(l.step)"
        >
          <span class="vf-layer-mark" />
          <span class="vf-layer-num">{{ l.label }}</span>
          <span class="vf-layer-note">{{ l.note }}</span>
        </button>

        <!-- Bilanz der GEWAEHLTEN Stufe: die genaue Paketzahl kennt nur sie (aufgeklappte Packages
             verschieben sie). Steht deshalb hier und nicht in jeder Zeile. -->
        <p v-if="contextLevel.nodes.length || contextLevel.hiddenPackages" class="vf-layers-foot">
          <template v-if="contextLevel.nodes.length">
            <b>{{ contextLevel.aggregatedClasses }}</b> in {{ contextLevel.nodes.length }}
            package{{ contextLevel.nodes.length === 1 ? '' : 's' }}
          </template>
          <span
            v-if="contextLevel.hiddenPackages"
            class="vf-crumb-warn"
            v-tip="{ title: `${contextLevel.hiddenPackages} more packages`, hint: `${contextLevel.hiddenRelations} further relations are not drawn — raise the step or open a package.` }"
          >
            <Icon icon="lucide:alert-triangle" class="h-3 w-3" />
            +{{ contextLevel.hiddenPackages }}
          </span>
        </p>

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

      <div class="vf-rail">
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
        <!-- Eine Zeile statt zweier gerahmter Zaehler: es ist EINE Aussage ueber das Ergebnis. -->
        <p class="vf-rail-sub">
          <b>{{ searchScope.matches }}</b> match{{ searchScope.matches === 1 ? '' : 'es' }}
          <template v-if="searchScope.relations">
            <span class="vf-dot">·</span><b>{{ searchScope.relations }}</b> relation{{ searchScope.relations === 1 ? '' : 's' }}
          </template>
        </p>
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
      </div>
    </div>

    <!-- ===== Karte oben rechts: WAS wird gezeichnet? ==========================================
         Ebene, Gruppierung, Umgebung und die Kantenarten standen bis zuletzt im Dock unten links,
         in einer Zeile mit Zoom und Fit: „wo schaue ich hin?" und „was ist ueberhaupt im Bild?"
         sahen damit gleich aus, obwohl das zwei Fragen sind – und die Kanten-Pillen brachen bei
         schmaler Spalte in eine zweite Zeile um. Als eigene Karte hat die Auswahl Platz fuer das,
         was eine Pille nie tragen konnte: die Anzahl je Art und die Vorschau (s. `startPreview`).
         Gegenueber der Context-Karte oben links, gleiche Materialsprache. -->
    <div v-if="files.length" class="vf-topright">
      <div class="vf-view" @mouseleave="endViewPreview">
        <div class="vf-view-head">
          <Icon icon="lucide:sliders-horizontal" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span class="vf-view-title">View</span>
        </div>

        <!-- Ebene: Packages oder Klassen. Als Segment statt als Wechselknopf, weil ein
             Wechselknopf immer den ANDEREN Zustand beschriftet – man liest „Classes" und ist in
             der Package-Ebene. -->
        <div v-if="level.groups.length" class="vf-seg vf-seg--wide">
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

        <!-- Zonen an/aus. Auf der Package-Ebene gibt es nichts zu gruppieren – dort ist jeder
             Knoten bereits ein Package. Die Vorschau daempft hier nichts, sie laesst die Zonen
             hervortreten: eine Ordnung waehlt keine Karten aus. -->
        <button
          v-if="!packageMode"
          type="button"
          class="vf-opt"
          :class="{ 'is-on': groupByPackage }"
          v-tip="groupByPackage
            ? { title: 'Grouped by package', hint: 'Click to lay out all classes in one run, without zones.' }
            : { title: 'Group by package', hint: 'One layout per package, then over the zones — faster and easier to read.' }"
          @mouseenter="startViewPreview('zones')"
          @focus="startViewPreview('zones')"
          @mouseleave="endViewPreview"
          @blur="endViewPreview"
          @click="endViewPreview(); toggleGrouping()"
        >
          <span class="vf-opt-box"><Icon v-if="groupByPackage" icon="lucide:check" class="h-3 w-3" /></span>
          <Icon icon="lucide:package" class="vf-opt-ic" />
          <span class="vf-opt-label">Group by package</span>
        </button>

        <!-- Umgebung an/aus. Gilt in BEIDEN Modi: die Frage „wen beruehrt das hier?" haengt nicht
             daran, wie fein der Ausschnitt gerade gezeichnet wird. Auf der obersten Ebene gibt es
             kein Aussen -> gesperrt statt wirkungslos. -->
        <button
          type="button"
          class="vf-opt"
          :class="{ 'is-on': showRelated }"
          :disabled="!basePath || basePath === rootPath"
          v-tip="!basePath || basePath === rootPath
            ? { title: 'Nothing outside this scope', hint: 'You are at the top level — everything is already in the picture.' }
            : showRelated
              ? { title: 'Neighbours shown', hint: 'Click to hide what this scope connects to outside itself.' }
              : { title: 'Show neighbours', hint: 'Draws what this scope uses and what uses it, outside itself.' }"
          @mouseenter="startViewPreview('related')"
          @focus="startViewPreview('related')"
          @mouseleave="endViewPreview"
          @blur="endViewPreview"
          @click="endViewPreview(); toggleRelated()"
        >
          <span class="vf-opt-box"><Icon v-if="showRelated" icon="lucide:check" class="h-3 w-3" /></span>
          <Icon icon="lucide:share-2" class="vf-opt-ic" />
          <span class="vf-opt-label">Neighbours</span>
          <span v-if="showRelated && relatedSummary" class="vf-opt-num">
            +{{ relatedSummary.classes || relatedSummary.packages }}
          </span>
        </button>

        <!-- Kantenarten einzeln abschaltbar: die schnellste Art, ein ueberladenes Bild
             aufzuraeumen. Ausgeblendete Kanten wirken auch nicht mehr auf die Platzierung.
             Die Zahl ist das, was im Bild steht – auf der Package-Ebene sind alle Linien Buendel,
             dort steht deshalb „–" statt einer erfundenen Zahl. -->
        <div class="vf-view-sep" />
        <button
          v-for="k in EDGE_KINDS"
          :key="k.key"
          type="button"
          class="vf-opt vf-opt--kind"
          :class="{ 'is-on': edgeFilter[k.key] }"
          :style="{ '--c': k.color }"
          v-tip="edgeFilter[k.key]
            ? { title: `Hide ${k.label.toLowerCase()}`, hint: 'Hidden edges also stop steering the layout.' }
            : { title: `Show ${k.label.toLowerCase()}`, hint: 'Edges steer the layout — showing them changes the placement.' }"
          @mouseenter="startViewPreview(k.key)"
          @focus="startViewPreview(k.key)"
          @mouseleave="endViewPreview"
          @blur="endViewPreview"
          @click="endViewPreview(); toggleEdgeKind(k.key)"
        >
          <span class="vf-opt-box"><Icon v-if="edgeFilter[k.key]" icon="lucide:check" class="h-3 w-3" /></span>
          <span class="vf-opt-line" :class="`vf-opt-line--${k.key}`" />
          <span class="vf-opt-label">{{ k.label }}</span>
          <span class="vf-opt-num">{{ edgeKindCounts[k.key] || '–' }}</span>
        </button>
      </div>
    </div>

    <!-- Hier stand das zweite Suchfeld („Find in graph"). Die Suche der Ansicht steht jetzt EINMAL,
         links im Kopf der Klassenliste (CodeView): sie filtert den Baum, stellt diesen Ausschnitt
         auf ihre Treffer und markiert sie hier. Zwei Felder waren zwei Antworten auf dieselbe
         Frage – und die Facetten (m:, review:, manual:) waren nur im Bild erreichbar, obwohl sie
         Klassen betreffen, die links stehen. Die Trefferzahl steht am Feld, die Bilanz des
         Ausschnitts weiterhin in der Leiste rechts. -->

    <!-- Hier stand die Schaltflaeche „Show N related classes" mittig ueber dem Graphen. Sie ist in
         die Leiste links gewandert und dort zur Stufenleiter geworden: dieselbe Frage wie beim
         einzelnen Treffer, deshalb dieselbe Bedienung an derselben Stelle – und statt „alles oder
         nichts" eine Stufe, die zum Ergebnis passt. -->

    <!-- Canvas-Chrome unten: Kamera-Werkzeuge links, Legende rechts. Beide schweben am unteren
         Rand, damit die obere Canvas-Haelfte (wo dagre die Wurzelknoten setzt) frei bleibt.
         Hier standen bis zuletzt auch Ebene, Gruppierung, Umgebung und die Kanten-Filter – sie
         sind in die Ansichts-Karte oben rechts gewandert: „wo schaue ich hin?" und „was ist
         ueberhaupt im Bild?" sahen in einer Zeile gleich aus, sind aber zwei Fragen. -->
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
            <span><b>Uncertain</b> match — the target was guessed</span>
          </div>
          <div class="legend-row">
            <span class="legend-line" style="background: var(--color-lavender)" />
            <span><b>Reads a field</b> — <code>Http.GET</code>, click for the code</span>
          </div>
          <div class="legend-row">
            <span class="legend-line legend-line--dashed" style="color: var(--color-cyan)" />
            <span><b>Uses</b> the type — parameter, cast, <code>new X()</code></span>
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
          <!-- Vierter Abschnitt: die LINIE sagt die Art der Beziehung, das LABEL das Mitglied.
               Ohne ihn erklaerte die Legende jede Farbe und keinen einzigen Text – und genau der
               Text ist das, was man liest. Die Muster spiegeln `.me-label` in ManagedEdge. -->
          <div class="legend-head mt-1.5">Edge labels · what the text says</div>
          <div class="legend-row">
            <span class="legend-label">getDisp()</span>
            <span>One <b>call</b> — click for the code</span>
          </div>
          <div class="legend-row">
            <span class="legend-label"><Icon icon="lucide:braces" class="legend-label-ic" />3 methods</span>
            <span>Several calls <b>bundled</b> — click to list them</span>
          </div>
          <div class="legend-row">
            <span class="legend-label legend-label--field"
              ><Icon icon="lucide:variable" class="legend-label-ic" />CANCL</span
            >
            <span>A <b>field</b>, not a call — no parentheses</span>
          </div>
          <div v-if="packageMode || relatedNodes.length" class="legend-row">
            <span class="legend-label legend-label--agg"
              ><Icon icon="lucide:git-fork" class="legend-label-ic" />4 class relations</span
            >
            <span>A whole <b>package</b> pair — click to list them</span>
          </div>
          <!-- Die kursive Schreibweise am Kanten-Label ist eine Aussage, keine Typografie – ohne
               diesen Eintrag waere sie eine huebsche Luege. -->
          <div class="legend-row">
            <span class="legend-label"
              ><Icon icon="lucide:component" class="legend-label-ic" /><i>getDisp()</i></span
            >
            <span><b>Interface or abstract</b> — impl. not fixed</span>
          </div>
          <div class="legend-row">
            <span class="legend-badge"><Icon icon="lucide:alert-triangle" class="legend-label-ic" />Please review</span>
            <span><b>Guessed</b> by method name alone</span>
          </div>
          <div class="legend-row">
            <span class="legend-label legend-label--find">getDisp()</span>
            <span>Its edge is a <b>search match</b></span>
          </div>
          <!-- Ohne diesen Eintrag stimmten die Kantenfarben oben nur noch fuer einen Teil des
               Bildes: was zur offenen Klasse fuehrt, traegt eine ZUORDNUNGS-, keine Art-Farbe. -->
          <div class="legend-row">
            <span class="legend-line legend-line--kin" />
            <span><b>Leads to the open class</b> — one shared colour</span>
          </div>
          <p class="legend-sub">
            A label carries the colour of its line. It steps aside to stay readable — never on a
            card, never on another label.
          </p>

          <p class="legend-hint">
            Arrows point from the definition to the class using it.<br />
            Hover a class to isolate its connections —<br />
            With a class open on the right, hovering a neighbour keeps<br />
            just that one connection — and reads it out beside the graph.<br />
            Click it to keep it and step over to that class.
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
          <!-- Die drei Stufen einer Suche in der Reihenfolge, in der man sie liest: was gesucht war,
               was daran haengt, was gerade nicht gemeint ist. -->
          <div class="legend-row">
            <span class="legend-state legend-state--match" />
            <span>Search match</span>
          </div>
          <div class="legend-row">
            <span class="legend-state legend-state--near" />
            <span>Connected to a match · keeps its own role colour</span>
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

    <!-- Kanten-Detail und Aggregat-Aufloesung stehen in Spalte 3 (CodeView), nicht mehr hier als
         Modal ueber dem Graphen: der Klick auf eine Kante soll neben dem Bild lesbar sein, in dem
         sie liegt. Gemeldet wird sie ueber `relation`. -->

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

/* --- Umgebungs-Auswahl: eine Liste von Ebenen, kein Regler ----------------------------------
   Ein Regler zeigt eine POSITION; die Frage hier ist aber „was sehe ich bei dieser Stufe?", und
   die beantwortet ein Satz, keine Position. Jede Stufe steht deshalb als eigene, grosse Zeile da –
   Zahl links, Bedeutung rechts, alle gleichzeitig sichtbar. Und sie steht als EIGENE Karte ueber
   der Leiste: vorher war sie deren dritter Abschnitt, zwischen Pfad und Warnungen eingeklemmt und
   entsprechend klein, obwohl sie die einzige Einstellung ist, die der Suchmodus verlangt. */
.vf-layers {
  flex: none;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 8px 8px 6px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.1);
}
.vf-layers-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 6px;
}
.vf-layers-title {
  flex: 1;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text);
}
.vf-layers-total {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  white-space: nowrap;
}
/* Eine Ebene = eine Zeile. Grosszuegige Trefferflaeche: das ist die Einstellung, die man im
   Suchmodus am haeufigsten anfasst. */
.vf-layer {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  padding: 6px 6px;
  text-align: left;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.vf-layer:hover {
  background: var(--color-surface-offset);
}
.vf-layer.is-on {
  background: var(--color-accent-soft);
}
.vf-layer:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
/* Auswahlpunkt: gefuellter Ring statt Haken – „eines von mehreren", und das sagt die Form. */
.vf-layer-mark {
  height: 0.875rem;
  width: 0.875rem;
  flex-shrink: 0;
  border-radius: 999px;
  border: 2px solid var(--color-border-strong);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.vf-layer.is-on .vf-layer-mark {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 3px var(--color-accent);
}
.vf-layer-num {
  min-width: 2.25rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.875rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.vf-layer.is-on .vf-layer-num {
  color: var(--color-accent);
}
/* Die Bedeutung der Stufe. Sie darf umbrechen – abgeschnitten waere sie keine Auskunft. */
.vf-layer-note {
  min-width: 0;
  flex: 1;
  font-size: 0.6875rem;
  line-height: 1.35;
  color: var(--color-text-muted);
}
.vf-layers-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  border-top: 1px solid var(--color-border);
  margin-top: 4px;
  padding: 6px 4px 0;
  font-size: 0.625rem;
  color: var(--color-text-muted);
}
.vf-layers-foot b {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
/* Fliesstext der Leiste: eine Aussage je Zeile, Zahlen hervorgehoben. Ersetzt die gerahmten
   Einzelzaehler (`.vf-crumb-count`), die nebeneinander wie eine Werkzeugleiste aussahen. */
.vf-rail-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  padding: 0 4px;
  font-size: 0.625rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}
.vf-rail-sub b {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.vf-dot {
  opacity: 0.6;
  padding: 0 1px;
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
/* Zwei Karten in einer Spalte oben links: die Umgebungs-Auswahl (`.vf-layers`) und darunter die
   Ortsangabe (`.vf-rail`). Die Positionierung liegt hier, damit beide sie sich nicht gegenseitig
   ausrechnen muessen; gedeckelt wird die Spalte, gescrollt nur die Leiste. */
.vf-topleft {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  display: flex;
  width: 15rem;
  max-width: calc(100% - 20px);
  max-height: calc(100% - 92px); /* Dock unten bleibt frei */
  flex-direction: column;
  gap: 8px;
}
/* --- Ansichts-Karte oben rechts ------------------------------------------------------------
   Gegenstueck zur Context-Karte oben links, gleiche Materialsprache: „wieviel Umgebung?" links,
   „was wird gezeichnet?" rechts. Deckend statt `backdrop-filter` (s. Stolperfalle „kein filter im
   Graphen") – die Karte liegt ueber der gesamten Layoutflaeche.
   Breite bewusst schmal: sie darf bei 1280×800 nicht in die Karten hineinragen. */
.vf-topright {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
  width: 12.5rem;
  max-width: calc(100% - 20px);
}
.vf-view {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 8px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.1);
}
.vf-view-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 6px;
}
.vf-view-title {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text);
}
.vf-view-sep {
  height: 1px;
  margin: 5px 2px;
  background: var(--color-border);
}
/* Eine Zeile = eine An/Aus-Entscheidung. Das Kaestchen sagt den Zustand, das Muster die Sache,
   die Zahl rechts, wieviel davon im Bild steht. */
.vf-opt {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  border-radius: 8px;
  padding: 4px 5px;
  text-align: left;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.vf-opt:hover:not(:disabled) {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.vf-opt.is-on {
  color: var(--color-text);
}
.vf-opt:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.vf-opt:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.vf-opt-box {
  display: grid;
  height: 0.875rem;
  width: 0.875rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 4px;
  border: 1.5px solid var(--color-border-strong);
  color: transparent;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.vf-opt.is-on .vf-opt-box {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-surface);
}
.vf-opt-ic {
  height: 0.875rem;
  width: 0.875rem;
  flex-shrink: 0;
  opacity: 0.75;
}
.vf-opt.is-on .vf-opt-ic {
  color: var(--color-accent);
  opacity: 1;
}
.vf-opt-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vf-opt-num {
  flex-shrink: 0;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
/* Das Muster spiegelt die Linie im Canvas (und die Legende): durchgezogen = call/field,
   gestrichelt = uses, gepunktet = import. Aendert sich dort die Strichform, aendert sie sich hier
   mit – sonst benennt die Karte eine Linie, die es so nicht gibt. */
.vf-opt-line {
  width: 14px;
  height: 0;
  flex-shrink: 0;
  border-top: 2px solid var(--c);
  border-radius: 999px;
  opacity: 0.9;
}
.vf-opt-line--uses {
  border-top-style: dashed;
}
.vf-opt-line--import {
  border-top-style: dotted;
}
.vf-opt:not(.is-on) .vf-opt-line {
  border-color: currentColor;
  opacity: 0.4;
}

.vf-rail {
  display: flex;
  min-height: 0;
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




/* Das Suchfeld im Bild ist entfallen – die Suche der Ansicht steht links im Kopf der Klassenliste
   (CodeView). Zwei Felder waren zwei Antworten auf dieselbe Frage; die Begruendung steht im
   Template an der Stelle, an der das Feld sass. */

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
/* Suchtreffer: klarer Ring in der Akzentfarbe – die Rolle bleibt an Streifen und Glyph ablesbar.
   Dazu einen Hauch groesser: eine Trefferkarte soll aus dem Feld hervortreten, nicht nur „die
   anderen sind blasser" sein. Der Faktor ist bewusst klein – 1.04 liest sich als Betonung, alles
   darueber als anderes Layout (die Karten stehen dicht, und das Layout kennt die Skalierung nicht). */
.vf-card--match {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 55%, transparent), 0 6px 18px color-mix(in srgb, var(--color-accent) 28%, transparent);
  transform: scale(1.04);
}
/* Der Hover setzt `transform` sonst zurueck und die Karte schrumpfte beim Draufzeigen. */
.vf-card--match:hover {
  transform: translateY(-1px) scale(1.04);
}
/* DER Treffer, der gerade rechts aufgeschlagen ist: das Bild sagt, welche der Karten gemeint ist.
   Ein Ring laeuft zweimal nach aussen – lange genug, um den Blick zu holen, kurz genug, um nicht
   zu blinken. Kein `filter`/`drop-shadow` (s. Stolperfalle: der Compositor zeichnet den Graphen
   sonst schwarz) – der Schein sind gestapelte `box-shadow`-Ringe, und animiert wird nur EINE Karte. */
.vf-card--match.vf-card--selected {
  border-color: var(--color-accent);
  transform: scale(1.07);
  animation: vf-match-pulse 1.05s ease-out 2 both;
}
.vf-card--match.vf-card--selected:hover {
  transform: translateY(-1px) scale(1.07);
}
@keyframes vf-match-pulse {
  0% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 90%, transparent),
      0 0 0 0 color-mix(in srgb, var(--color-accent) 45%, transparent);
  }
  70% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 70%, transparent),
      0 0 0 16px transparent;
  }
  100% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 60%, transparent),
      0 10px 26px color-mix(in srgb, var(--color-accent) 32%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .vf-card--match.vf-card--selected {
    animation: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 60%, transparent),
      0 10px 26px color-mix(in srgb, var(--color-accent) 32%, transparent);
  }
}
/* An einem Treffer haengende Karte: voll lesbar, aber ohne Akzent – ihre Farben bleiben die
   eigenen (Rolle im Streifen, Typ im Chip, Package im Punkt), damit die Akzentfarbe weiterhin
   „Treffer" heisst und nicht „irgendwie beteiligt". Der Ring ist ihre ROLLENfarbe, also dieselbe
   Sprache wie der Streifen daneben – gedaempfter als der Ring der ausgewaehlten Karte, sonst saehen
   zwanzig Nachbarn aus wie zwanzig Auswahlen. */
/* Zwei Klassen im Selektor, weil dieselbe Karte im Suchmodus auch `--context` traegt (sie ist ja
   nicht der Treffer) – und dessen halbe Deckkraft stuende sonst weiter darueber. */
.vf-card.vf-card--near {
  opacity: 1;
  border-color: color-mix(in srgb, var(--role) 50%, var(--color-border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--role) 30%, transparent),
    0 3px 12px color-mix(in srgb, var(--role) 18%, transparent);
}
/* Mitgezeigte Nachbarschaft: sichtbar, aber eindeutig zweite Reihe. Bewusst NICHT weiter gedaempft,
   um Treffer hervorzuheben: waehrend einer Suche traegt dieselbe Karte ohnehin `--dim` (0.14, die
   Sprache fuer „gerade nicht gemeint"), und dieser Wert gilt dann. Der Treffer tritt stattdessen
   selbst hervor – s. `--match` oben. */
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
  max-height: min(760px, 76vh);
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
/* Zuordnungsfarbe: hier steht keine EINE Farbe, sondern die Reihe – genau das ist die Aussage
   („jede Linie eine andere"). Dieselben Tokens wie `HOVER_COLORS` im Skript. */
.legend-line--kin {
  background: linear-gradient(
    to right,
    var(--mc-0) 0 25%,
    var(--mc-1) 25% 50%,
    var(--mc-2) 50% 75%,
    var(--mc-3) 75% 100%
  );
}
.legend-hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
  font-size: 0.625rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}
/* Label-Muster: spiegelt `.me-label` in ManagedEdge (Rahmen, Radius, Gewicht, Akzentfarbe) – eine
   Legende, die das Kaestchen anders zeichnet als der Graph, erklaert ein anderes Bild. Nur die
   Schrift ist eine Stufe kleiner, damit die Zeile so hoch bleibt wie die uebrigen. */
.legend-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.625rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-accent);
}
.legend-label-ic {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
}
/* Feld statt Methode: dieselbe Lavendel-Familie wie die Feld-Kante. */
.legend-label--field {
  border-color: color-mix(in srgb, var(--color-lavender) 60%, var(--color-border));
  color: var(--color-lavender);
}
/* Aggregat-Label: Distel wie die gebuendelte Package-Kante, Ziffern tabellarisch wie im Canvas. */
.legend-label--agg {
  border-color: color-mix(in srgb, var(--color-thistle) 45%, var(--color-border));
  color: var(--color-thistle);
  font-variant-numeric: tabular-nums;
}
/* Suchtreffer: Goldrahmen samt Ring – identisch zu `.me-label--find`. */
.legend-label--find {
  border-color: var(--color-warning);
  color: var(--color-warning);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-warning) 30%, transparent);
}
/* „Please review"-Badge: deckend gefuellt wie am Kanten-Label (`.me-badge`). */
.legend-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  color: #fff;
  background: var(--color-review);
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
/* In der Ansichts-Karte fuellt das Segment die Zeile: zwei gleich breite Haelften lesen sich als
   Entweder-oder, zwei unterschiedlich breite als Knopf mit Anhaengsel. */
.vf-seg--wide {
  margin-bottom: 3px;
}
.vf-seg--wide .vf-seg-btn {
  flex: 1;
  justify-content: center;
  padding: 3px 4px;
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
  transition: opacity 0.15s ease;
}
.vf-zonelayer--front {
  z-index: 3;
}
/* Isoliert der Graph gerade EINE Verbindung, treten auch die Zonen zurueck. Sie liegen ausserhalb
   von Vue Flow und wurden von der Knoten-Daempfung nie erfasst – eine vollflaechige Package-Ordnung
   in voller Deckkraft hinter zwei isolierten Karten nimmt genau den Fokus wieder zurueck, um den es
   geht. Auf dem ganzen Layer statt je Zone: der Layer ist ohnehin eine Ebene, und ein Wert schlaegt
   nicht auf jede einzelne Zone durch. Die Koepfe bleiben bedienbar (pointer-events unveraendert),
   nur eben leise – der Weg in ein Package geht waehrend eines Hovers nicht verloren. */
.vf-zonelayer--muted {
  opacity: 0.18;
}
/* Gegenstueck zur Daempfung: zeigt die Maus in der Ansichts-Karte auf „Group by package", tritt
   die Ordnung selbst hervor. Sie waehlt keine Karten aus – gedaempft wird deshalb nichts, es wird
   nur die Zone deutlicher, die man sonst kaum sieht. */
.vf-zonelayer--lit .vf-zone {
  border-style: solid;
  border-color: color-mix(in srgb, var(--pkg) 75%, transparent);
  background: color-mix(in srgb, var(--pkg) 18%, transparent);
}
.vf-zone {
  position: absolute;
  border-radius: 18px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
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
/* Fokus auf GENAU EINE Sache (Hover mit Anker, gehoverte oder angeklickte Kante): alles andere geht
   so weit zurueck wie die Linien (0.07) – eine Karte traegt Rahmen, Grund und Schatten und ist bei
   gleicher Deckkraft deutlich praesenter als eine 2 px schmale Linie, deshalb noch etwas darunter.
   Kein `filter: grayscale/blur` als Ergaenzung: der Compositor zeichnet den Graphen dann schwarz
   (s. Stolperfalle im Projekt-Wissen). Zwei Klassen im Selektor, weil dieselbe Karte im Suchmodus
   `--near` (opacity 1) tragen kann und die Regel sonst unterliegt. */
.vf-card.vf-card--mute,
.vf-pkgcard.vf-card--mute {
  opacity: 0.04;
}
/* Auch beim Darueberfahren: waehrend eine Verbindung isoliert ist, gehoert das Bild ihr. Sonst
   leuchtet jede Karte wieder auf, ueber die der Weg der Maus zufaellig fuehrt. */
.vf-card.vf-card--mute:hover,
.vf-pkgcard.vf-card--mute:hover {
  opacity: 0.04;
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

/* ⚠️ Zwei Klassen im Selektor UND eine eigene :hover-Fassung: `.vf-card:hover` ist (0,2,0) und
   ueberschrieb hier sonst Ring und Transform – ausgerechnet an der Karte unter der Maus, also der
   einen, die den Fokus am deutlichsten tragen muesste. Gemessen: sie trug `--focus`, zeigte aber
   den allgemeinen Hover-Schatten.
   Der Ring liegt aussen (box-shadow) und die Karte waechst nur um 3 % – gross genug, um vor dem
   ausgeblendeten Feld zu stehen, klein genug, dass das Layout nicht verspringt. */
.vf-card.vf-card--focus,
.vf-card.vf-card--focus:hover,
.vf-pkgcard.vf-card--focus,
.vf-pkgcard.vf-card--focus:hover {
  border-color: var(--edge);
  /* Vier gestapelte Schatten statt eines: schmale Trennlinie zum Grund, deckender Ring, weicher
     Schein, tiefe Ablage. Der Schein ist der Ersatz fuer `filter: drop-shadow` (dort zeichnet der
     Compositor den Graphen schwarz). */
  box-shadow: 0 0 0 1px var(--color-surface),
    0 0 0 4px color-mix(in srgb, var(--edge) 62%, transparent),
    0 0 26px 2px color-mix(in srgb, var(--edge) 32%, transparent),
    0 12px 30px color-mix(in srgb, var(--edge) 24%, transparent);
  transform: translateY(-1px) scale(1.03);
  z-index: 3;
}
/* Nachbar der OFFENEN Klasse: traegt seine Zuordnungsfarbe dauerhaft, aber leise – Rahmen und ein
   1-px-Ring, sonst nichts. Bewusst NICHT `--focus`: dessen kraeftiger Ring, das Anheben und die
   Ring-Expansion sind die Sprache fuer „genau diese eine Verbindung ist gemeint". Zwoelf Nachbarn
   mit dieser Sprache waeren zwoelf Betonungen und damit keine. Die Rolle bleibt am Streifen und am
   Badge ablesbar: die Zuordnungsfarbe sagt WELCHE Linie hierher fuehrt, nicht was die Klasse ist. */
.vf-card.vf-card--kin,
.vf-pkgcard.vf-card--kin {
  border-color: color-mix(in srgb, var(--edge) 70%, var(--color-border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--edge) 45%, transparent),
    0 3px 12px color-mix(in srgb, var(--edge) 16%, transparent);
}
/* Einmalige Ring-Expansion beim Setzen des Fokus – derselbe Gedanke wie `vf-match-pulse` bei der
   Suche, nur kuerzer und nur einmal: sie holt den Blick auf die Verbindung, ohne beim Verweilen
   weiterzublinken. */
/* Bewusst OHNE `both`: mit fill-mode bliebe der Endkeyframe stehen und wuerde den weichen Schein
   der Regel oben dauerhaft ueberschreiben. So gilt nach 0.4 s wieder der Normalzustand. */
.vf-card.vf-card--focus {
  animation: vf-focus-in 0.4s ease-out 1;
}
@keyframes vf-focus-in {
  0% {
    box-shadow: 0 0 0 1px var(--color-surface),
      0 0 0 4px color-mix(in srgb, var(--edge) 62%, transparent),
      0 0 0 0 color-mix(in srgb, var(--edge) 45%, transparent),
      0 12px 30px color-mix(in srgb, var(--edge) 24%, transparent);
  }
  100% {
    box-shadow: 0 0 0 1px var(--color-surface),
      0 0 0 4px color-mix(in srgb, var(--edge) 62%, transparent),
      0 0 0 14px transparent,
      0 12px 30px color-mix(in srgb, var(--edge) 24%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .vf-card.vf-card--focus {
    animation: none;
  }
}
/* Endpunkt der ANGEKLICKTEN Kante (ihr Detail steht rechts offen). Dieselbe Farbe wie der
   Hover-Ring – es ist dieselbe Aussage –, aber deutlich fester: der Hover-Ring verschwindet, sobald
   die Maus weiterzieht, dieser bleibt, waehrend man rechts liest. Ring per `box-shadow`, damit
   keine Karte ihre Groesse aendert (das Layout wuerde sonst verspringen). */
.vf-card--pinned,
.vf-pkgcard.vf-card--pinned {
  border-color: var(--edge);
  box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 5px var(--edge),
    0 10px 26px color-mix(in srgb, var(--edge) 34%, transparent);
  z-index: 2;
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
/* „Haengt an einem Treffer": derselbe zurueckhaltende Ring wie im Canvas, in der Rollenfarbe –
   hier stellvertretend die Hub-Farbe, weil die Legende keine einzelne Karte meint. */
.legend-state--near {
  border-color: color-mix(in srgb, var(--color-role-hub) 55%, var(--color-border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-role-hub) 30%, transparent);
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
