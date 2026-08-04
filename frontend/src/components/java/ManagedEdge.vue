<script setup>
// Custom Vue-Flow-Kante fuer ALLE Klassen-Kanten (Call + Import).
// - Call-Kante: Label am (gestaffelten) Mittelpunkt zeigt den aufgerufenen Methodennamen,
//   ist klickbar und hat Hover-Schnellaktionen (Bearbeiten/Loeschen). Manuelle Kanten:
//   gestrichelt + Link-Icon. Unsichere Auto-Kanten: "Bitte pruefen"-Badge.
// - Import-Kante (data.kind === 'import'): nur die Linie, KEIN Label, nicht klickbar.
// Callbacks kommen aus edge.data (von JavaDependencyGraph gesetzt; Vue Flow leitet keine
// Custom-Emits an den Parent).
//
// Parallele Kanten desselben Knotenpaars teilen sich Bottom-/Top-Handle und laegen sonst
// deckungsgleich. Loesung in ZWEI Achsen, gesteuert ueber parallelIndex/parallelCount (vom
// Parent ueber das UNGEORDNETE Knotenpaar vergeben, Call + Import gemeinsam):
//   1) Linien: Endpunkte (und damit der Pfad) horizontal auffaechern (fanOffset).
//   2) Labels: zusaetzlich vertikal staffeln (labelStagger) statt rotieren – rotierte Labels
//      sind schlechter lesbar; gestapelte, leicht versetzte Labels bleiben waagerecht lesbar.
import { computed, ref, onUnmounted } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@vue-flow/core'
import { Icon } from '../../lib/icons.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { useRootScale } from '../../composables/useRootScale.js'
import { parseGraphQuery, matchEdge } from '../../lib/graphQuery.js'

const props = defineProps({
  id: { type: String, required: true },
  sourceX: { type: Number, default: 0 },
  sourceY: { type: Number, default: 0 },
  targetX: { type: Number, default: 0 },
  targetY: { type: Number, default: 0 },
  sourcePosition: { type: String, default: 'bottom' },
  targetPosition: { type: String, default: 'top' },
  markerEnd: { type: String, default: '' },
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
})

const { scale: rootScale } = useRootScale()

// Basiswerte bei 16px-Root – beide haengen an der Root-Schriftgroesse, weil das Label mit ihr
// waechst: bei festem Versatz wuerden gestapelte Labels auf einem 2K-Schirm uebereinanderlaufen.
const SPREAD = 26 // px horizontaler Abstand zwischen parallelen Linien
const PROBE_W = 100 // px angenommene Labelbreite bei 16px-Root (gemessen: 85–106)
const PROBE_H = 22 // px Labelhoehe (Text + Innenabstand + Rahmen)
const PROBE_GAP = 7 // px Luft zwischen fremdem Rand und Label
// ⚠️ Der Versatz gestapelter Labels muss GROESSER sein als ein Label hoch ist – sonst ueberlappen
// sich zwei Beschriftungen desselben Paares schon per Konstruktion, ganz ohne fremdes Hindernis
// (gemessen: 20 px Versatz bei 22 px Hoehe = 2 px Ueberlappung an JEDEM Stapel). Deshalb steht hier
// keine eigene Zahl, sondern die Labelhoehe plus Luft.
const LABEL_GAP_Y = 4 // px Luft zwischen zwei gestapelten Labels
const LABEL_STEP = PROBE_H + LABEL_GAP_Y // px vertikaler Versatz gestapelter Labels

// Symmetrisch um die Mitte verteilen: jeder Index erhaelt einen eindeutigen Offset.
const spread = (step) => {
  const count = props.data?.parallelCount || 1
  const index = props.data?.parallelIndex || 0
  return count > 1 ? (index - (count - 1) / 2) * step : 0
}
const fanOffset = computed(() => spread(SPREAD * rootScale.value))
const labelStagger = computed(() => spread(LABEL_STEP * rootScale.value))

// Inline-Loesch-Bestaetigung direkt am Label (nur Einzelkante). Bei einem Buendel uebernimmt
// das Detail-Panel das gezielte Loeschen pro Methode.
const confirming = ref(false)
// Einzelkante = genau eine Methode + bekannte edgeId -> direkt loeschbar.
const isSingle = computed(() => (props.data?.bundleCount || 1) <= 1 && props.data?.edgeId != null)

function onDeleteClick(e) {
  const dd = props.data || {}
  if (isSingle.value) {
    confirming.value = true
  } else if (dd.onOpen) {
    // Buendel: gezielt im Detail-Panel loeschen.
    dd.onOpen(dd, e)
  }
}
function confirmDelete() {
  const dd = props.data || {}
  if (dd.onDelete && dd.edgeId != null) dd.onDelete(dd.edgeId)
  confirming.value = false
}
function cancelDelete() {
  confirming.value = false
}

const pathData = computed(() =>
  getSmoothStepPath({
    sourceX: props.sourceX + fanOffset.value,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX + fanOffset.value,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  }),
)
const edgePath = computed(() => pathData.value[0])

// --- Das Label weicht den Karten UND den anderen Labels aus -------------------------------------
// Karten liegen ueber den Labels (`.vue-flow__nodes` in style.css) – ein Label auf einer Karte
// waere also ein halb abgeschnittenes Wort. Statt die Stapelreihenfolge umzudrehen (dann deckte
// die Beschriftung den Gegenstand zu), rueckt das Label an seiner eigenen Linie, bis es frei steht;
// `reserveLabelSpot` kennt dafuer die Rechtecke aller gezeichneten Karten – und die der bereits
// platzierten Labels: zwei Beschriftungen verschiedener Kanten koennen denselben Punkt treffen
// (gemessen: „autoClose()" genau ueber „{} 3 methods"), und zwei uebereinanderliegende
// Methodennamen sind so unlesbar wie einer unter einer Karte.
//
// Gerechnet wird auf dem UNGEFAECHERTEN Mittelpunkt (labelX = Mitte beider Enden, also genau um
// fanOffset verschoben): so sehen alle parallelen Kanten desselben Paars dieselbe Ausgangslage,
// bekommen dieselbe Verschiebung – und der gestaffelte Stapel bleibt ein Stapel, statt beim
// Ausweichen auseinanderzufallen. Aus demselben Grund ist die Sondenbreite eine KONSTANTE und
// nicht die (je Methodenname andere) echte Labelbreite: eine Breite pro Label ergaebe pro Label
// eine andere Verschiebung.

// Traegt diese Kante ueberhaupt eine Beschriftung? Dieselbe Bedingung wie die beiden
// EdgeLabelRenderer im Template – eine zweite Formulierung waere die Gelegenheit, sie
// auseinanderlaufen zu lassen.
const hasLabel = computed(() => {
  const kind = props.data?.kind
  return kind === 'aggregate' || (kind !== 'import' && kind !== 'uses')
})

const baseX = computed(() => pathData.value[1] - fanOffset.value)
const baseY = computed(() => pathData.value[2])
// Halbe Masse des GANZEN Stapels (alle parallelen Labels weichen als ein Block aus).
const probeHalfW = computed(() => ((PROBE_W + SPREAD * ((props.data?.parallelCount || 1) - 1)) * rootScale.value) / 2)
const probeHalfH = computed(
  () => ((PROBE_H + LABEL_STEP * ((props.data?.parallelCount || 1) - 1)) * rootScale.value) / 2,
)

// Das waagerechte Mittelstueck der Smoothstep-Kante – dort, und nur dort, darf das Label seitlich
// rutschen, ohne seine Linie zu verlassen. Es gibt es nur bei einer nach unten laufenden Kante
// (Handles bottom -> top); geht die Kante aufwaerts, legt Vue Flow den Weg aussen herum und der
// Mittelpunkt liegt nicht mehr auf einer Waagerechten. Der Rand `CORNER` haelt das Label von den
// abgerundeten Ecken fern, `halfW` sorgt dafuer, dass es GANZ auf dem Stueck liegt.
const CORNER = 12 // px Abstand zur Kurve am Ende des Mittelstuecks (16px-Root)
const slideRange = computed(() => {
  const margin = CORNER * rootScale.value + probeHalfW.value
  const min = Math.min(props.sourceX, props.targetX) + margin
  const max = Math.max(props.sourceX, props.targetX) - margin
  if (max <= min) return null
  // Zu flach: dann ist kein waagerechtes Stueck da, auf das man ruecken koennte.
  if (props.targetY - props.sourceY < 4 * CORNER * rootScale.value) return null
  return { min, max }
})

const labelSpot = computed(() => {
  // Neu rechnen, sobald der Graph ein neues Layout gemeldet hat (die Boxen selbst sind nicht
  // reaktiv – s. useJavaGraph).
  void labelObstacleVersion.value
  const base = { x: baseX.value, y: baseY.value }
  // Kante ohne Beschriftung (import/uses) belegt auch keinen Platz – sonst verdraengte ein Label,
  // das gar nicht gezeichnet wird, ein echtes.
  if (!hasLabel.value) return base
  // Schluessel = das ungeordnete Knotenpaar, also GENAU die Gruppierung, nach der auch der Faecher
  // `parallelIndex` vergibt (s. JavaDependencyGraph). ⚠️ Nicht die POSITION als Schluessel nehmen:
  // zwei verschiedene Paare koennen exakt denselben Mittelpunkt haben (gemessen: 22 Labelpaare mit
  // dx = dy = 0) – sie teilten sich dann einen Platz und laegen weiter uebereinander, statt
  // einander auszuweichen.
  const sid = props.data?.sourceId
  const tid = props.data?.targetId
  const key = sid != null && tid != null ? [sid, tid].sort().join('|') : `edge:${props.id}`
  return reserveLabelSpot(
    key,
    base.x,
    base.y,
    probeHalfW.value,
    probeHalfH.value,
    PROBE_GAP * rootScale.value,
    slideRange.value,
  )
})
// Der Faecher (waagerecht) und die Staffelung (senkrecht) kommen NACH dem Ausweichen dazu: der
// Stapel bewegt sich als Block, und jedes Label behaelt seinen Platz darin.
const labelX = computed(() => labelSpot.value.x + fanOffset.value)
const labelY = computed(() => labelSpot.value.y + labelStagger.value)

const d = computed(() => props.data || {})
// Feldzugriff statt Methodenaufruf: dieselbe Kante, aber der Name traegt keine Klammern und die
// Kursiv-Regel (offene Implementierung) gilt nicht – ein Feld ist nie polymorph.
const isField = computed(() => d.value.kind === 'field')

// Steht die Implementierung fest? Bei Interface und abstrakter Klasse nicht – das Label sagt es
// mit der UML-Notation (kursiv + Typzeichen). Die Icons sind dieselben wie im Typ-Chip der Karte,
// damit „◈" am Label und „◈" auf der Klasse dasselbe bedeuten.
const OPEN_ICON = { interface: 'lucide:component', abstract: 'lucide:layers' }
const openTitle = computed(() =>
  d.value.openKind === 'interface'
    ? `Defined by the interface ${d.value.toClass} — which implementation runs is not fixed here`
    : d.value.openKind === 'abstract'
      ? `Defined by the abstract class ${d.value.toClass} — a subclass may override it`
      : '',
)

// --- Hover-Fokus ---------------------------------------------------------------------------
// Zeigt die Maus auf einen Knoten, bleiben nur dessen eigene Kanten stehen; alles andere faellt
// fast auf null. Der Zustand kommt aus dem Composable, NICHT ueber `data`: sonst muesste der
// Parent bei jeder Mausbewegung saemtliche Kanten neu in den Vue-Flow-Store schreiben.
// `labelObstacleVersion`/`freeLabelY` gehoeren zum Ausweichen der Labels (s. oben bei labelDodge)
// und liegen aus demselben Grund im Composable: die Kante fragt selbst, statt dass der Parent bei
// jedem Layout Positionen in den Kanten-Store schreibt.
const {
  hoveredNode,
  hoverPalette,
  hoverAnchor,
  hoveredEdge,
  setHoveredEdge,
  clearHoveredEdge,
  pinnedEdge,
  pinCovers,
  samePair,
  graphQuery,
  graphHitNodes,
  labelObstacleVersion,
  reserveLabelSpot,
  selectionAnchor,
  selectionPalette,
  graphPreview,
} = useJavaGraph()

// --- Vorschau aus der Ansichts-Karte ------------------------------------------------------------
// Zeigt die Maus dort auf „Calls", bleiben genau die Call-Linien stehen. Die Kante prueft nur ihre
// Mitgliedschaft in einer fertigen Menge (der Graph kennt sie, s. `setPreview` dort) – so gilt
// dasselbe fuer Kantenarten, Nachbarn und Zonen, ohne dass die Kante die Frage kennen muss.
// Waehrend der Vorschau liegt die Maus ausserhalb des Canvas: Hover, Pin und Suche koennen also
// gar nicht widersprechen, und die Vorschau steht deshalb ganz vorn.
const previewSet = computed(() => graphPreview.value?.edges || null)
const previewHit = computed(() => !!previewSet.value?.has(props.id))

// Verbindet diese Kante den gehoverten Knoten mit dem Anker (der rechts offenen Klasse)?
const isAnchorPair = computed(() => {
  const a = hoverAnchor.value
  const h = hoveredNode.value
  return !!a && !!h && samePair(a, h, d.value.sourceId, d.value.targetId)
})

// Knoten-Hover: die Linie traegt die Identitaetsfarbe des Nachbarn an ihrem ANDEREN Ende – genau
// die Farbe, die dort auch die Karte traegt (Palette: `neighbourPalette` in JavaDependencyGraph).
// Vorher trugen alle Linien eines Hubs dieselbe Art-Farbe und liefen im dichten Feld ineinander;
// welche Linie an welcher Karte endet, war nicht mehr zu sehen. Die Kantenart geht dabei nicht
// verloren: sie steckt in der Strichform (durchgezogen = call, gestrichelt = uses/import), und die
// Faerbung gilt nur, solange die Maus steht.
// Dieselbe Zuordnung gilt BLEIBEND, sobald eine Klasse rechts offen ist (`selectionAnchor`): die
// Linien zu ihren Nachbarn tragen deren Identitaetsfarbe, ohne dass man zeigen muss. Alle uebrigen
// Linien behalten ihre ART-Farbe – umgefaerbt wird nur, was zur offenen Klasse fuehrt, sonst waere
// die Legende (Calls/Fields/Uses/Imports) eine Luege. Die Art bleibt ohnehin an der Strichform
// ablesbar (durchgezogen = call/field, gestrichelt = uses/import).
// Vorrang Hover > Auswahl: die feinere Geste gewinnt. Ein Farbsprung entsteht dabei nicht, weil
// `pairPalette` dieselbe Farbe uebernimmt (s. JavaDependencyGraph).
const neighbourColor = computed(() => {
  const h = hoveredNode.value
  const palette = hoverPalette.value
  const anchor = h && palette ? h : selectionAnchor.value
  const pal = h && palette ? palette : selectionPalette.value
  if (!anchor || !pal) return null
  const other =
    d.value.sourceId === anchor ? d.value.targetId : d.value.targetId === anchor ? d.value.sourceId : null
  return other ? pal.get(other) || null : null
})

// --- Suche im Graphen ---------------------------------------------------------------------------
// Die Kante prueft sich selbst (statt dass der Parent bei jedem Tastendruck den Kanten-Store neu
// schreibt). Getroffen ist sie, wenn ihr Methodenname passt – oder wenn sie zwei getroffene Karten
// verbindet: eine gedaempfte Linie zwischen zwei leuchtenden Knoten waere die halbe Aussage.
const findQuery = computed(() => parseGraphQuery(graphQuery.value))
const isFindHit = computed(() => {
  const q = findQuery.value
  if (!q) return false
  if (matchEdge(d.value, q)) return true
  const hits = graphHitNodes.value
  return hits.has(d.value.sourceId) && hits.has(d.value.targetId)
})
// Eine Linie, die AN einem Treffer haengt, gehoert zu ihm: sie sagt, woran die gefundene Klasse
// haengt. Sie mit 0.07 wegzublenden liess den Treffer im Bild schweben, ohne eine einzige seiner
// Beziehungen – und genau die sind der Grund, warum er in einem Graphen steht.
const touchesHit = computed(() => {
  const hits = graphHitNodes.value
  return hits.has(d.value.sourceId) || hits.has(d.value.targetId)
})
// Bei aktiver Suche tritt alles zurueck, was nicht dazugehoert – dieselbe Daempfung wie beim Hover,
// damit im Bild nur EINE Sprache fuer „gerade nicht gemeint" existiert.
const findDimmed = computed(() => !!findQuery.value && !isFindHit.value && !touchesHit.value)

// --- Hover auf der KANTE ---------------------------------------------------------------------
// Die Linie selbst ist 2 px schmal und damit kaum zu treffen. Darum liegt ein unsichtbarer,
// breiter Pfad darueber, der nur die Maus einsammelt (`me-hit`) – dasselbe Muster, das Vue Flow
// intern fuer seine Standardkanten nutzt.
// Eine Quelle fuer Linie, Schein, Richtungspunkt und Label: steht die Maus auf einem Knoten, ist
// das die Nachbarfarbe, sonst die Farbe der Kantenart.
const kindColor = computed(() => d.value.edgeStyle?.stroke || 'var(--color-accent)')
const edgeColor = computed(() => neighbourColor.value || kindColor.value)
const isHovered = computed(() => hoveredEdge.value?.id === props.id)
// Angeklickt = ihr Detail steht rechts offen. Dieselbe Wirkung wie der Hover, nur bleibend – der
// Blick wandert zwischen Code und Bild hin und her, und die Linie muss beim Zurueckschauen noch
// dieselbe sein. Ein Klick auf eine KARTE pinnt die ganze Verbindung, also womoeglich mehrere
// Linien – welche gemeint sind, entscheidet `pinCovers` (eine Regel, s. useJavaGraph).
const isPinned = computed(() => pinCovers(pinnedEdge.value, props.id, d.value.sourceId, d.value.targetId))

// Hover-ABSICHT, nicht blosse Beruehrung: wer die Maus quer ueber ein dichtes Kantenfeld zieht,
// streift Dutzende Trefferflaechen und liess dabei den halben Graphen im Stroboskop auf- und
// abblenden – jedes Aufleuchten schreibt den geteilten Zustand und laesst ALLE Knoten und Kanten
// ihre Daempfung neu bewerten. Deshalb zaehlt eine Kante erst als gemeint, wenn die Maus kurz auf
// ihr bleibt. Verlassen wirkt weiterhin sofort: eine Hervorhebung, die noch nachhaengt, waere ein
// falscher Zustand, waehrend die Verzoegerung beim Eintreten nur ein spaeterer richtiger ist.
const HOVER_INTENT_MS = 90
let hoverTimer = null
function onEdgeEnter() {
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    setHoveredEdge({
      id: props.id,
      sourceId: d.value.sourceId,
      targetId: d.value.targetId,
      // Bewusst die ART-Farbe: der Kanten-Hover ist ein eigener Zustand und faerbt seine beiden
      // Endpunkte in der Farbe DIESER Kante – eine Nachbarfarbe aus einem gerade verlassenen
      // Knoten-Hover wuerde hier nur nachhaengen.
      color: kindColor.value,
    })
  }, HOVER_INTENT_MS)
}
function onEdgeLeave() {
  clearTimeout(hoverTimer)
  clearHoveredEdge(props.id)
}
onUnmounted(() => clearTimeout(hoverTimer))

const dimmed = computed(() => {
  // Vorschau aus der Ansichts-Karte: sie steht vorn (die Maus ist dann nicht im Bild, s. oben).
  if (previewSet.value) return !previewHit.value
  const h = hoveredNode.value
  // Anker gesetzt (offene Klasse + der gehoverte Knoten haengt an ihr): dann ist EINE Verbindung
  // gemeint, nicht eine Nachbarschaft – es bleiben nur die Linien zwischen genau diesen beiden.
  if (h && hoverAnchor.value) return !isAnchorPair.value
  if (h) return d.value.sourceId !== h && d.value.targetId !== h
  // Steht die Maus auf einer anderen Kante, tritt diese hier zurueck – sonst bliebe die
  // hervorgehobene Beziehung in einem dichten Graphen genauso unlesbar wie vorher.
  if (hoveredEdge.value) return !isHovered.value
  // Ohne Maus im Bild: die angeklickte Kante (Detail rechts offen) isoliert wie ein Hover. Der
  // Hover steht davor, weil er die feinere Geste ist – wer bei offenem Detail woanders hinzeigt,
  // fragt gerade nach etwas anderem.
  if (pinnedEdge.value) return !isPinned.value
  // Sonst bestimmt die Suche (gleiche Vorrangregel wie bei den Karten).
  return findDimmed.value
})
const focused = computed(
  () =>
    (!!hoveredNode.value || !!hoveredEdge.value || !!pinnedEdge.value || !!previewSet.value) && !dimmed.value,
)

// Die Kanten-Grundfarbe steht in data.edgeStyle; hier kommt nur der Fokus-Zustand darueber.
const pathStyle = computed(() => {
  // Die Transition steht inline, nicht im <style>: BaseEdge rendert mehrere Wurzelelemente, an die
  // sich weder eine Klasse noch ein scoped-Selektor zuverlaessig haengen laesst.
  const base = {
    transition: 'opacity 0.15s ease, stroke-width 0.15s ease, stroke 0.15s ease',
    ...(d.value.edgeStyle || {}),
  }
  if (dimmed.value) return { ...base, opacity: 0.07 }
  // Knoten-Hover: Identitaetsfarbe des Nachbarn statt der Art-Farbe (s. neighbourColor). Gilt auch
  // im Suchmodus – Hover schlaegt Suche, dieselbe Vorrangregel wie bei der Daempfung.
  const tint = neighbourColor.value ? { stroke: neighbourColor.value } : null
  // Direkt gehoverte oder angeklickte Kante: kraeftiger als der blosse Nachbarschafts-Fokus. Der
  // Schein kommt NICHT von `filter: drop-shadow` (s. .me-glow unten), sondern von zwei breiteren
  // Pfaden darunter. Die Linie zwischen offener Klasse und gehovertem Nachbarn zaehlt genauso: sie
  // IST in diesem Moment die Frage, nicht bloss eine von zwanzig Linien am selben Knoten.
  if (isHovered.value || isPinned.value || isAnchorPair.value)
    return { ...base, ...tint, opacity: 1, strokeWidth: (base.strokeWidth || 2) + 1.4 }
  // Suchtreffer: kraeftig wie eine gehoverte Kante, aber ohne deren Extra-Breite – bei zwanzig
  // Treffern gleichzeitig waere das ein Balkenbild.
  if (isFindHit.value) return { ...base, ...tint, opacity: 1, strokeWidth: (base.strokeWidth || 2) + 0.7 }
  if (focused.value) return { ...base, ...tint, opacity: 1, strokeWidth: (base.strokeWidth || 2) + 0.7 }
  // Ruhezustand – und trotzdem faerbig, wenn diese Linie zur OFFENEN Klasse fuehrt: dann traegt sie
  // die Zuordnungsfarbe ihres Nachbarn (`neighbourColor` liest dafuer die bleibende
  // `selectionPalette`). Nur die Farbe, keine Extra-Breite: betont wird weiterhin nur, worauf man
  // zeigt. Ohne offene Klasse ist `tint` null und es bleibt bei der Art-Farbe.
  return { ...base, ...tint }
})

// --- Schein um die betonte Kante ---------------------------------------------------------------
// Frueher `filter: drop-shadow(...)` auf dem Pfad. Ein CSS-Filter zwingt den Compositor, eine
// Offscreen-Textur ueber die GESAMTE Bounding-Box des Pfads anzulegen – bei bis zu 400 Karten ist
// das Layout mehrere tausend Pixel gross, und eine Kante quer darueber hat eine entsprechend
// riesige Box. Das Ergebnis waren schwarze Flaechen im ganzen Fenster, sobald man so eine Kante
// hoverte (stehen blieb nur, was einen eigenen Layer hat: Legende, Dock, Breadcrumb).
// Zwei breitere, halbtransparente Pfade unter der Linie sehen praktisch gleich aus und sind
// gewoehnliche Vektor-Zeichnungen ohne Zwischentextur.
// Das Label sitzt an der Linie und ist damit der dritte Ort derselben Aussage – es traegt die
// Nachbarfarbe mit, sonst bliebe genau in der Bildmitte ein neutral gerahmtes Kaestchen stehen.
const tinted = computed(() => !!neighbourColor.value && !dimmed.value)

const baseWidth = computed(() => Number(d.value.edgeStyle?.strokeWidth) || 2)
const glowing = computed(
  () => isHovered.value || isPinned.value || isAnchorPair.value || !!d.value.isHighlighted || isFindHit.value,
)
// Nur die „aufleuchtende" Kante (Code-Tab-Klick) pulsiert – beim Hover waere Bewegung unruhig,
// und bei der angeklickten Kante erst recht: ihr Detail steht minutenlang offen.
const pulsing = computed(() => !!d.value.isHighlighted && !isHovered.value && !isPinned.value)
</script>

<template>
  <!-- Schein UNTER der Linie (Dokumentreihenfolge = Malreihenfolge): zwei breitere, blasse Pfade
       in der Kantenfarbe. Ersetzt den frueheren drop-shadow-Filter, s. Kommentar im Script. -->
  <template v-if="glowing">
    <path
      class="me-glow me-glow--outer"
      :class="{ 'me-glow--pulse': pulsing }"
      :d="edgePath"
      fill="none"
      :stroke="edgeColor"
      :stroke-width="baseWidth + 9"
      stroke-linecap="round"
    />
    <path
      class="me-glow me-glow--inner"
      :class="{ 'me-glow--pulse': pulsing }"
      :d="edgePath"
      fill="none"
      :stroke="edgeColor"
      :stroke-width="baseWidth + 4"
      stroke-linecap="round"
    />
  </template>

  <BaseEdge :id="id" :path="edgePath" :marker-end="markerEnd" :style="pathStyle" />

  <!-- Unsichtbare Trefferflaeche: macht die schmale Linie ueberhaupt erst hoverbar. `stroke` als
       pointer-events -> nur der Strichverlauf faengt die Maus, nicht die umschlossene Flaeche. -->
  <path
    class="me-hit"
    :d="edgePath"
    fill="none"
    stroke="transparent"
    :stroke-width="20 * rootScale"
    @mouseenter="onEdgeEnter"
    @mouseleave="onEdgeLeave"
  />

  <!-- Laufender Punkt auf der gehoverten Kante: zeigt die RICHTUNG der Beziehung, die aus einer
       ruhenden Linie mit Pfeilspitze allein nur schwer abzulesen ist. Nur EINE Kante ist je
       gehovert -> genau eine Animation, unabhaengig von der Graph-Groesse. -->
  <circle v-if="isHovered || isAnchorPair" class="me-flow" :r="3.5 * rootScale" :fill="edgeColor">
    <animateMotion dur="1.4s" repeatCount="indefinite" :path="edgePath" />
  </circle>

  <!-- Aggregierte Package-Kante: nur die Zahl der zusammengefassten Klassenbeziehungen. Keine
       Aktionen – verwaltet wird immer auf Klassenebene, eine Ebene tiefer. -->
  <EdgeLabelRenderer v-if="d.kind === 'aggregate'">
    <div
      class="me-label me-label--agg"
      :class="{
        'me-label--dim': dimmed,
        'me-label--hot': isHovered || isPinned || isAnchorPair,
        'me-label--pinned': isPinned,
        'me-label--find': isFindHit && !isHovered,
        'me-label--tint': tinted,
      }"
      :style="{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, '--edge': edgeColor }"
      :title="`${d.count} class-to-class relation${d.count === 1 ? '' : 's'} bundled here — click to list them`"
      @mouseenter="onEdgeEnter"
      @mouseleave="onEdgeLeave"
      @click.stop="d.onOpen && d.onOpen(d, $event)"
    >
      <!-- Ausgeschrieben: die Zahl allein liess offen, WAS gezaehlt wird, und „links" laesst sich
           im deutschen Lesefluss als Richtungsangabe missverstehen. -->
      <span class="me-method me-count"
        ><Icon icon="lucide:git-fork" class="me-ic" />{{ d.count }} class relation{{ d.count === 1 ? '' : 's' }}</span
      >
      <Icon icon="lucide:chevron-right" class="me-ic me-agg-go" />
    </div>
  </EdgeLabelRenderer>

  <!-- Import- und uses-Kanten haben kein Label (nur die Linie). -->
  <EdgeLabelRenderer v-else-if="d.kind !== 'import' && d.kind !== 'uses'">
    <!-- Inline-Bestaetigung (Einzelkante): ersetzt das Label, bis bestaetigt/abgebrochen. -->
    <div
      v-if="confirming"
      class="me-label me-confirm"
      :style="{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }"
    >
      <span class="me-confirm-text">Delete?</span>
      <button type="button" class="me-confirm-btn me-confirm-btn--yes" title="Delete connection" @click.stop="confirmDelete">
        <Icon icon="lucide:check" class="me-ic" />
      </button>
      <button type="button" class="me-confirm-btn" title="Cancel" @click.stop="cancelDelete">
        <Icon icon="lucide:x" class="me-ic" />
      </button>
    </div>

    <div
      v-else
      class="me-label"
      :class="{
        'me-label--manual': d.isManual,
        'me-label--review': d.needsReview,
        'me-label--selected': selected,
        'me-label--lit': d.isHighlighted,
        'me-label--dim': dimmed,
        'me-label--hot': isHovered || isPinned || isAnchorPair,
        'me-label--pinned': isPinned,
        'me-label--find': isFindHit && !isHovered,
        'me-label--tint': tinted,
      }"
      :style="{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, '--edge': edgeColor }"
      title="Show details"
      @mouseenter="onEdgeEnter"
      @mouseleave="onEdgeLeave"
      @click.stop="d.onOpen && d.onOpen(d, $event)"
    >
      <Icon v-if="d.isManual" icon="lucide:link" class="me-ic me-ic--manual" title="Manual edge" />
      <!-- Gebuendelte Kante (>1 Methode): kompaktes Chip „n Methoden"; sonst der Methodenname.
           Beide tragen die Auskunft, OB die Implementierung feststeht: kursiv + Typzeichen, wenn
           die Definition ein Interface oder abstrakt ist (UML-Notation, s. `openKindOf` im Graphen).
           Alle Methoden einer Kante stammen aus derselben Klasse – die Aussage gilt fuer beide
           Faelle gleich. -->
      <span
        v-if="d.bundleCount > 1"
        class="me-method me-count"
        :class="{ 'me-method--open': d.openKind }"
        :title="openTitle || (isField ? 'Multiple fields – show details' : 'Multiple methods – show details')"
      >
        <Icon
          :icon="isField ? 'lucide:variable' : d.openKind ? OPEN_ICON[d.openKind] : 'lucide:braces'"
          class="me-ic"
        />{{ d.bundleCount }} {{ isField ? 'fields' : 'methods' }}
      </span>
      <!-- Ein Feld traegt KEINE Klammern – `ACCEPT()` waere kein Java und laese sich wie eine
           parameterlose Methode. Das Zeichen davor sagt die Art, damit ein einzelnes Wort am
           Pfeil nicht raten laesst, ob es Methode oder Feld ist. Die Kursiv-Auszeichnung
           (offene Implementierung) gilt nur fuer Methoden: ein Feld ist nie polymorph. -->
      <span v-else class="me-method" :class="{ 'me-method--open': !isField && d.openKind }" :title="openTitle || null">
        <Icon v-if="isField" icon="lucide:variable" class="me-ic me-ic--open" />
        <Icon v-else-if="d.openKind" :icon="OPEN_ICON[d.openKind]" class="me-ic me-ic--open" />{{
          d.method ? (isField ? d.method : d.method + '()') : '—'
        }}
      </span>

      <span
        v-if="d.needsReview"
        class="me-badge"
        title="Call without a named object – the target class was matched by method name only. Open the edge for details."
      >
        <Icon icon="lucide:alert-triangle" class="me-ic" />Please review
      </span>

      <!-- Hover-Loeschen: dezentes ×, erscheint erst beim Hover ueber dem Label. -->
      <button
        v-if="d.onDelete"
        type="button"
        class="me-del"
        :title="d.bundleCount > 1 ? 'Delete methods in the detail panel' : 'Delete connection'"
        aria-label="Delete connection"
        @click.stop="onDeleteClick($event)"
      >
        <Icon icon="lucide:x" class="me-ic" />
      </button>
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
@reference "../../assets/style.css";

/* EdgeLabelRenderer-Overlay ist pointer-events:none -> Label muss Klicks wieder annehmen. */
/* Trefferflaeche der Kante: unsichtbar, faengt aber die Maus auf dem gesamten Strichverlauf. */
.me-hit {
  pointer-events: stroke;
  cursor: pointer;
  fill: none;
}
/* Laufender Richtungspunkt – reine Dekoration, darf keine Klicks abfangen. */
.me-flow {
  pointer-events: none;
}

/* Schein der betonten Kante: zwei blasse Pfade statt eines Filters (Begruendung im Script).
   Deckkraft so gewaehlt, dass der Schein die Linie umgibt, ohne sie zu ueberstrahlen. */
.me-glow {
  pointer-events: none;
  fill: none;
}
.me-glow--outer {
  opacity: 0.13;
}
.me-glow--inner {
  opacity: 0.26;
}
/* „Aufleuchtende" Kante (Code-Tab-Klick): der Puls laeuft auf der Deckkraft der Schein-Pfade –
   eine Eigenschaft, die der Compositor ohne Neurasterung animiert. */
@keyframes me-glow-pulse {
  0%,
  100% {
    opacity: 0.1;
  }
  50% {
    opacity: 0.32;
  }
}
.me-glow--inner.me-glow--pulse {
  animation: me-glow-pulse 1.1s ease-in-out infinite;
}
.me-glow--outer.me-glow--pulse {
  animation: me-glow-pulse 1.1s ease-in-out infinite;
  animation-delay: 0.12s;
}
@media (prefers-reduced-motion: reduce) {
  .me-glow--pulse {
    animation: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .me-flow {
    display: none;
  }
}

.me-label {
  position: absolute;
  pointer-events: all;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* rem statt px: waechst mit der Root-Schriftgroesse mit, wie das Label selbst. */
  max-width: 15rem;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  /* Das Label sagt, WELCHE Methode aufgerufen wird – die eigentliche Aussage der Kante. Zu klein
     gesetzt ist sie beim Ueberfliegen wertlos, deshalb bewusst ueber der frueheren Micro-Groesse. */
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-accent);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
}
/* Hover-Fokus auf einem Knoten: fremde Labels verschwinden ganz. Nur auszublenden reicht nicht –
   sie liegen im Label-Overlay und wuerden sonst weiter Klicks abfangen. */
.me-label--dim {
  opacity: 0;
  pointer-events: none;
}
.me-label--manual {
  border-style: dashed;
}
/* Treffer der Graph-Suche: dieselbe Gold-Familie wie die getroffenen Karten und wie jeder andere
   Suchtreffer in Wikit. Bewusst schwaecher als `--hot`: gehovert ist immer genau eine Kante,
   getroffen koennen zwanzig sein. */
.me-label--find {
  border-color: var(--color-warning);
  color: var(--color-warning);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-warning) 30%, transparent);
}
/* Label der gehoverten Kante: uebernimmt deren Farbe und tritt vor. Der Rahmen ist dieselbe
   Farbe, die auch die Linie und die Ringe an den beiden Endkarten tragen – daran haengt die
   ganze Aussage zusammen. */
.me-label--hot {
  border-color: var(--edge);
  color: var(--edge);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--edge) 28%, transparent), 0 4px 14px rgb(0 0 0 / 0.22);
  transform-origin: center;
  z-index: 2;
}
/* Angeklickte Kante: ihr Detail steht rechts offen. Ein Hover geht vorueber, das hier bleibt –
   deshalb ein deckender Grund in der Kantenfarbe statt nur eines Rings. So bleibt genau eine
   Beschriftung im Bild „eingeschaltet", auch wenn die Maus laengst im Panel steht. */
.me-label--pinned {
  background-color: color-mix(in srgb, var(--edge) 16%, var(--color-surface-2));
  box-shadow: 0 0 0 2px var(--edge), 0 6px 18px rgb(0 0 0 / 0.28);
  font-weight: 700;
  z-index: 3;
}
/* Aggregat-Label: reine Zahl, nicht klickbar -> Cursor + Hover-Affordanz zuruecknehmen. */
/* Aggregat-Label traegt die Farbe seiner Kante -> Linie und Beschriftung sind als EINE Aussage
   lesbar, und der Unterschied zur Call-Kante (Akzent) bleibt auch beim Ueberfliegen bestehen. */
.me-label--agg {
  border-color: color-mix(in srgb, var(--color-thistle) 45%, var(--color-border));
  color: var(--color-thistle);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
.me-label--agg:hover {
  border-color: var(--color-thistle);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-thistle) 30%, transparent);
}
/* Knoten-Hover: das Label uebernimmt die Identitaetsfarbe seiner Kante – Linie, Beschriftung und
   die Karte am anderen Ende sind damit eine Aussage. Bewusst schwaecher als `--hot` (kein Ring,
   gemischter Rahmen): gehovert ist genau EINE Kante, im Nachbarschafts-Fokus stehen oft zwanzig,
   und zwanzig leuchtende Kaesten waeren wieder das Bild, das der Fokus aufloesen soll. Steht NACH
   `--agg`, damit auch das Aggregat-Label seine Nachbarfarbe traegt. */
.me-label--tint:not(.me-label--hot) {
  border-color: color-mix(in srgb, var(--edge) 60%, var(--color-border));
  color: var(--edge);
}
/* Kleiner Pfeil als Affordanz „hier geht es weiter" – erscheint erst beim Hover, damit das Label
   im Ruhezustand nur die Zahl zeigt. */
.me-agg-go {
  width: 12px;
  height: 12px;
  margin-left: -1px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.me-label--agg:hover .me-agg-go {
  opacity: 0.8;
}
.me-label--review {
  border-color: color-mix(in srgb, var(--color-review) 60%, var(--color-border));
}
.me-label--selected {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 45%, transparent);
}
/* „Aufleuchtende" Kante (Code-Tab-Klick): Label in --color-edge-highlight, identisch zum
   Code-Token- und Pfad-Glow. */
.me-label--lit {
  border-color: var(--color-edge-highlight);
  color: var(--color-edge-highlight);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-edge-highlight) 45%, transparent),
    0 0 10px color-mix(in srgb, var(--color-edge-highlight) 55%, transparent);
}
/* inline-flex, nicht inline: ein Icon IM Textfluss steht auf der Grundlinie und zieht die Zeilenbox
   um seine Unterlaenge auf – das Feld-Label („◇ CANCL") war dadurch anderthalbmal so hoch wie ein
   Methoden-Label (gemessen: 31 statt 20 px) und passte nicht mehr in die Sonde, mit der die
   Platzierung rechnet (PROBE_H). Alle Labels sind jetzt gleich hoch. */
.me-method {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* Implementierung steht nicht fest (Interface / abstrakte Klasse) – UML setzt genau das kursiv.
   Dazu das Typzeichen der Klassenkarte davor: die Konvention allein erkennt nicht jeder, das
   Symbol schon. Bewusst KEINE eigene Farbe und keine andere Strichform – beide Achsen sind im
   Graphen vergeben (Rolle/Typ/Gruppe bzw. call/uses/import). */
.me-method--open {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-style: italic;
}
.me-ic--open {
  opacity: 0.85;
}
/* Buendel-Chip „n Methoden": dezent abgesetzt, mit fuehrendem Icon. */
.me-count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-weight: 700;
}
.me-ic {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.me-ic--manual {
  color: var(--color-text-muted);
}
.me-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  color: #fff;
  background: var(--color-review);
}

/* Hover-Loeschen: × erscheint nur beim Hover ueber dem Label – haelt den Graphen ruhig. */
.me-del {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  margin-left: 1px;
  border-radius: 4px;
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.me-label:hover .me-del {
  opacity: 1;
}
.me-del:hover {
  background: color-mix(in srgb, var(--color-danger) 16%, transparent);
  color: var(--color-danger);
}

/* Inline-Bestaetigung direkt am Label. */
.me-confirm {
  cursor: default;
  border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border));
}
.me-confirm-text {
  color: var(--color-danger);
  font-weight: 700;
}
.me-confirm-btn {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 4px;
  color: var(--color-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
.me-confirm-btn:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.me-confirm-btn--yes:hover {
  background: color-mix(in srgb, var(--color-danger) 18%, transparent);
  color: var(--color-danger);
}
</style>
