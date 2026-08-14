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

// --- Vorschau aus der Ansichts-Karte (oben rechts im Graphen) -----------------------------------
// `{ edges: Set<edgeId> | null, nodes: Set<nodeId> | null, zones: boolean }` | null.
// Wer mit der Maus auf „Calls" zeigt, fragt: WELCHE Linien sind das? Die Karte beantwortet das
// nicht mit Text, sondern im Bild – die gemeinte Teilmenge bleibt stehen, der Rest tritt zurueck.
// Deshalb eine fertige MENGE und kein Schluessel: so gilt dieselbe Mechanik fuer die Kantenarten
// wie fuer „Neighbours" (Knoten) und „Group by package" (Zonen), und die Kante muss keine
// Fallunterscheidung kennen. Liegt hier und nicht in der Graph-Komponente, weil ManagedEdge sie
// SELBST liest – gleiche Begruendung wie bei `hoveredNode`.
const graphPreview = ref(null)

// --- Fokus aus dem CODE (Klick auf einen Methoden-Token im Source-Tab) ---------------------------
// `{ edges: Set<vueFlowEdgeId>, nodes: Set<nodeId>, key: string }` | null.
//
// `highlightedCall`/`highlightedDef` sagen, WELCHE Methode gemeint ist – aber „gemeint" heisst im
// Bild: diese eine Verbindung und sonst nichts. Eine goldene Linie zwischen dreihundert gleich
// hellen Karten ist keine Aussage, sie ist ein Suchbild. Deshalb tritt bei gesetztem Highlight
// alles zurueck, was nicht dazugehoert.
//
// Dieselbe FORM wie `graphPreview` mit Absicht: die Kante prueft nur ihre Mitgliedschaft in einer
// fertigen Menge und muss die Frage nicht kennen (s. dort). Trotzdem ein EIGENER Zustand, denn er
// beantwortet eine andere Frage und steht an einer anderen Stelle der Vorrangordnung: die Vorschau
// gilt, solange die Maus auf einem Eintrag der Ansichts-Karte steht, dieser Fokus dagegen bleibt –
// er ist ein Klick, und der Blick wandert danach zwischen Code und Bild hin und her.
//
// `key` identifiziert den Fokus als GESTE (`call:<fileId>:<method>`), nicht als Menge: die Kamera
// soll einmal je neuem Fokus reagieren und nicht bei jedem Layout-Lauf, der dieselbe Menge neu
// berechnet.
const codeFocus = ref(null)

// --- Dieselbe Zuordnung, ohne dass man zeigen muss ----------------------------------------------
// `selectionAnchor` ist die rechts GEOEFFNETE Klasse (`c:<fileId>` | null), `selectionPalette` die
// Identitaetsfarbe je direktem Nachbarn – gleiche Bauart wie `hoverPalette`, nur bleibend.
//
// Warum: die Farbzuordnung „diese Karte gehoert an diese Linie" beantwortet eine Frage, die man
// hat, sobald eine Klasse aufgeschlagen ist – nicht erst, wenn man mit der Maus darauf zeigt. Wer
// ueber die globale Suche in eine Klasse springt, sieht ihre Beziehungen sofort; welche der zwoelf
// Linien an welcher Karte endet, war bis dahin nur mit der Maus zu erfahren.
//
// Vorrang: Hover > Auswahl (die feinere Geste gewinnt, wie ueberall im Graphen). Der Hover FAERBT
// dabei nicht um – er nimmt dieselbe Farbe (s. `pairPalette`), sonst spraenge die Verbindung beim
// Draufzeigen in einen anderen Ton und die Zuordnung waere fuer einen Moment eine andere.
const selectionAnchor = ref(null)
const selectionPalette = ref(null)

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
// Ausgewichen wird ENTLANG DER EIGENEN LINIE, in beiden Richtungen, in denen sie verlaeuft: eine
// Smoothstep-Kante (Handles oben/unten) laeuft senkrecht aus den Karten heraus und WAAGERECHT
// dazwischen – und genau auf diesem Mittelstueck sitzt der Label-Punkt. Deshalb wird zuerst
// waagerecht gerueckt (Bewegung AUF der Linie) und erst danach senkrecht. Was in keiner der beiden
// Richtungen einen Platz findet, bleibt liegen.
// Warum ein Raster und keine Liste: ein Ausschnitt hat bis zu 400 Karten und ebenso viele Labels –
// jedes gegen jedes waere je Layout ein sechsstelliges Produkt.
const OBSTACLE_CELL = 200 // px Kantenlaenge einer Rasterzelle (Flow-Koordinaten)
// Weiter als das weicht kein Label aus: was zwei Kartenreihen entfernt steht, liest niemand mehr
// als Beschriftung DIESER Linie. Findet sich darin nichts, bleibt das Label, wo es war.
const LABEL_SHIFT_MAX = 260
let obstacleGrid = new Map()
// --- Labels weichen auch EINANDER aus -----------------------------------------------------------
// Die Karten sind nicht das einzige, was ein Label unlesbar macht: zwei Labels verschiedener Kanten
// koennen an derselben Stelle landen (gemessen im dichten Feld: „autoClose()" genau ueber
// „{} 3 methods"). Deshalb ist ein platziertes Label selbst ein Hindernis – es traegt sich nach
// seiner Wahl in ein zweites Raster ein, und wer danach rechnet, weicht ihm aus.
//
// Reserviert wird je STAPEL, nicht je Kante: Schluessel ist das ungeordnete Knotenpaar, also genau
// die Gruppierung, nach der auch der Faecher `parallelIndex` vergibt. Damit bekommt der ganze
// Stapel EINE Verschiebung (er faellt beim Ausweichen nicht auseinander) und belegt EIN Rechteck,
// statt sich selbst als Hindernis zu sehen.
let labelGrid = new Map()
const labelSlots = new Map() // stapelKey -> { x, y, halfW, halfH, result, rect }
// Nur eine Version als Ref, nicht die Boxen selbst: die Labels lesen die Rechtecke nie, sie
// brauchen bloss den Anstoss, ihre Position nach einem neuen Layout neu zu rechnen.
const labelObstacleVersion = ref(0)

// Ein Rechteck in ein Raster eintragen bzw. daraus entfernen. Ein Rechteck liegt in bis zu vier
// Zellen; entfernt wird ueber die IDENTITAET des Objekts, nicht ueber seine Werte.
function gridCells(grid, b, fn) {
  const cx1 = Math.floor((b.x + b.w) / OBSTACLE_CELL)
  const cy1 = Math.floor((b.y + b.h) / OBSTACLE_CELL)
  for (let cx = Math.floor(b.x / OBSTACLE_CELL); cx <= cx1; cx++) {
    for (let cy = Math.floor(b.y / OBSTACLE_CELL); cy <= cy1; cy++) fn(`${cx}|${cy}`)
  }
}
function gridInsert(grid, b) {
  gridCells(grid, b, (key) => {
    const bucket = grid.get(key)
    if (bucket) bucket.push(b)
    else grid.set(key, [b])
  })
}
function gridRemove(grid, b) {
  gridCells(grid, b, (key) => {
    const bucket = grid.get(key)
    if (!bucket) return
    const i = bucket.indexOf(b)
    if (i >= 0) bucket.splice(i, 1)
    if (!bucket.length) grid.delete(key)
  })
}

// boxes: [{ x, y, w, h }] – linke obere Ecke + Groesse, wie Vue Flow die Knoten fuehrt.
function setLabelObstacles(boxes) {
  const grid = new Map()
  for (const b of boxes || []) gridInsert(grid, b)
  obstacleGrid = grid
  // Neues Layout = neue Belegung. Wuerden die alten Label-Rechtecke stehen bleiben, wichen die
  // Labels Plaetzen aus, an denen laengst nichts mehr steht.
  labelGrid = new Map()
  labelSlots.clear()
  labelObstacleVersion.value++
}

// Alle Rechtecke im Ausschnitt einsammeln – Karten UND bereits platzierte Labels, jedes genau
// einmal (ein Rechteck liegt in bis zu vier abgefragten Zellen).
function eachRect(x0, y0, x1, y1, fn) {
  const seen = new Set()
  const cx1 = Math.floor(x1 / OBSTACLE_CELL)
  const cy1 = Math.floor(y1 / OBSTACLE_CELL)
  for (const grid of [obstacleGrid, labelGrid]) {
    for (let cx = Math.floor(x0 / OBSTACLE_CELL); cx <= cx1; cx++) {
      for (let cy = Math.floor(y0 / OBSTACLE_CELL); cy <= cy1; cy++) {
        const bucket = grid.get(`${cx}|${cy}`)
        if (!bucket) continue
        for (const b of bucket) {
          if (seen.has(b)) continue
          seen.add(b)
          fn(b)
        }
      }
    }
  }
}

// Naechster freier Punkt auf EINER Achse, gegeben die Sperrintervalle. `at` selbst, wenn dort
// nichts liegt; sonst der naechstgelegene Intervallrand innerhalb von [lo, hi]. `null` heisst
// „kein Platz" – erst das erlaubt dem Aufrufer, es auf der anderen Achse zu versuchen, statt
// (wie frueher) stillschweigend auf dem besetzten Punkt liegen zu bleiben.
function nearestFree(blocked, at, lo, hi) {
  if (at < lo || at > hi) return null
  if (!blocked.length) return at
  blocked.sort((a, b) => a[0] - b[0])
  // Ueberlappende Sperren verschmelzen: erst danach ist die GRENZE eines Intervalls garantiert
  // frei – ohne den Schritt landete das Label womoeglich im naechsten Hindernis.
  const merged = [[blocked[0][0], blocked[0][1]]]
  for (let i = 1; i < blocked.length; i++) {
    const last = merged[merged.length - 1]
    if (blocked[i][0] <= last[1]) last[1] = Math.max(last[1], blocked[i][1])
    else merged.push([blocked[i][0], blocked[i][1]])
  }
  for (const [a, b] of merged) {
    if (at < a) break // sortiert -> ab hier liegt alles jenseits des Labels
    if (at <= b) {
      // Beide Raender pruefen: der naehere kann ausserhalb des erlaubten Bereichs liegen, der
      // fernere noch darin – nur einen zu betrachten hiesse Plaetze zu verschenken.
      const ok = [a, b].filter((v) => v >= lo && v <= hi)
      if (!ok.length) return null
      return ok.reduce((best, v) => (Math.abs(v - at) < Math.abs(best - at) ? v : best))
    }
  }
  return at
}

// Naechstgelegenes freies y fuer einen Label-MITTELPUNKT bei (x, y): das Label rutscht an den
// Endstuecken seiner Linie entlang. `gap` ist der Mindestabstand zwischen fremdem Rand und
// Labelrand.
function freeLabelY(x, y, halfW, halfH, gap) {
  const left = x - halfW
  const right = x + halfW
  const blocked = []
  eachRect(left, y - LABEL_SHIFT_MAX, right, y + LABEL_SHIFT_MAX, (b) => {
    if (b.x + b.w <= left || b.x >= right) return
    blocked.push([b.y - halfH - gap, b.y + b.h + halfH + gap])
  })
  return nearestFree(blocked, y, y - LABEL_SHIFT_MAX, y + LABEL_SHIFT_MAX)
}

// Ein Schritt zur Seite kostet mehr als derselbe Weg an der Linie entlang – er fuehrt von ihr weg.
const SIDE_COST = 1.6

// Dasselbe auf der WAAGERECHTEN: [lo, hi] ist das Stueck der eigenen Linie, auf dem das Label noch
// vollstaendig liegt (der Mittelteil der Smoothstep-Kante, s. `slideRange` in ManagedEdge).
function freeLabelX(x, y, halfW, halfH, gap, lo, hi) {
  const top = y - halfH - gap
  const bottom = y + halfH + gap
  const blocked = []
  eachRect(lo - halfW, top, hi + halfW, bottom, (b) => {
    if (b.y + b.h <= top || b.y >= bottom) return
    blocked.push([b.x - halfW - gap, b.x + b.w + halfW + gap])
  })
  return nearestFree(blocked, x, Math.max(lo, x - LABEL_SHIFT_MAX), Math.min(hi, x + LABEL_SHIFT_MAX))
}

// Der Platz fuer EIN Label(stapel), in der Reihenfolge, in der die Stelle noch zur Linie gehoert:
//   1. waagerecht auf dem Mittelstueck – eine Bewegung AUF der Linie,
//   2. senkrecht an den Endstuecken – dito, und der einzige Weg fuer fast senkrechte Kanten,
//   3. eine Labelbreite DANEBEN, dort wieder senkrecht.
// Stufe 3 ist noetig, weil in einer Kartenspalte pro Reihenluecke nur EIN Stapel Platz hat: eine
// Karte sperrt ihre Hoehe plus zweimal die halbe Labelhoehe, und was davon uebrig bleibt, belegt
// das erste Label ganz. Ohne sie blieben in einem dichten Ausschnitt Dutzende Beschriftungen genau
// dort liegen, wo schon eine steht – zwei Labels aufeinander sind beide unlesbar, eines eine
// Labelbreite neben seiner Linie ist noch zuzuordnen.
//
// Zwei Durchgaenge: erst mit der vollen Luft, dann auf Kante genaeht. Ein Label, das einen Rand
// beruehrt, ist gelesen; zwei uebereinander sind es nicht – der Mindestabstand ist eine
// Schoenheits-, keine Lesbarkeitsfrage und faellt deshalb zuerst.
function placeLabel(x, y, halfW, halfH, gap, slide) {
  return placeWithGap(x, y, halfW, halfH, gap, slide) || placeWithGap(x, y, halfW, halfH, 0, slide) || { x, y }
}

function placeWithGap(x, y, halfW, halfH, gap, slide) {
  if (slide && slide.max > slide.min) {
    const sx = freeLabelX(x, y, halfW, halfH, gap, slide.min, slide.max)
    if (sx != null) return { x: sx, y }
  }
  const sy = freeLabelY(x, y, halfW, halfH, gap)
  if (sy != null) return { x, y: sy }
  // In halben Labelbreiten nach aussen: die feineren Stufen sind nicht ueberfluessig, weil eine zu
  // kleine Verschiebung ohnehin nicht frei ist (die Rechtecke ueberlappten sich dann) – sie geben
  // der Suche nur die Chance, den NAECHSTEN freien Platz zu finden statt den uebernaechsten.
  let best = null
  for (const step of [0.5, 1, 1.5, 2, 2.5, 3]) {
    for (const dir of [1, -1]) {
      const dx = step * halfW * dir
      const cy = freeLabelY(x + dx, y, halfW, halfH, gap)
      if (cy == null) continue
      const cost = Math.abs(cy - y) + Math.abs(dx) * SIDE_COST
      if (!best || cost < best.cost) best = { x: x + dx, y: cy, cost }
    }
  }
  // Nichts frei: `null` heisst „mit diesem Abstand nicht" – der Aufrufer versucht es enger.
  return best
}

// Platz SUCHEN und zugleich BELEGEN. `key` ist der Stapel (das ungeordnete Knotenpaar) – alle
// parallelen Labels eines Paares fragen mit demselben Schluessel und denselben Massen und bekommen
// daher dieselbe Antwort, ohne dass der Stapel sich selbst im Weg steht.
//
// ⚠️ Die Reihenfolge entscheidet, WER ausweicht: wer zuerst rechnet, bleibt stehen. Das ist die
// Renderreihenfolge der Kanten und damit stabil, solange das Layout steht; bei einem neuen Layout
// leert `setLabelObstacles` die Belegung und alle rechnen erneut. Bewegt sich nur eine Kante,
// verliert sie ihren alten Platz (er wird ausgetragen) und weicht dem Rest aus – auch das ist die
// gewuenschte Lesart: wer sich bewegt, sucht sich einen neuen Platz.
//
// Die Belegung liegt bewusst NICHT in einem Ref: sie ist Zwischenergebnis einer Rechnung, kein
// Zustand, den jemand beobachtet. Ein reaktives Raster wuerde jede Label-Platzierung sofort alle
// anderen neu rechnen lassen – eine Kettenreaktion je Layout statt eines Durchlaufs.
//
// ZWEI Achsen, und die Reihenfolge folgt der Linie: `slide` ist das waagerechte Mittelstueck der
// Smoothstep-Kante – genau dort sitzt der Label-Punkt, also ist ein Ruecken NACH LINKS ODER RECHTS
// eine Bewegung AUF der Linie und damit die treueste. Senkrecht fuehrt vom Mittelstueck weg und ist
// deshalb der zweite Versuch (er stimmt fuer die fast senkrechten Kanten, die gar kein Mittelstueck
// haben – dort ist `slide` null). Gemessen im dichten Ausschnitt: senkrecht allein fand fuer 89 von
// 146 Beschriftungen keinen Platz (naechste Luecke 300–450 px weit, Deckel ist LABEL_SHIFT_MAX) –
// die blieben alle liegen und stapelten sich gegenseitig. Das war der Grund, dass „ausweichen"
// zwischen den Kartenreihen praktisch nie stattfand.
function reserveLabelSpot(key, x, y, halfW, halfH, gap = 6, slide = null) {
  const prev = labelSlots.get(key)
  // Unveraenderte Anfrage desselben Stapels: dieselbe Antwort. Ohne das wuerde das zweite Label
  // eines Stapels dem ersten ausweichen – sie sollen aber uebereinander stehen (`labelStagger`).
  if (prev && prev.x === x && prev.y === y && prev.halfW === halfW && prev.halfH === halfH)
    return prev.result
  if (prev) {
    gridRemove(labelGrid, prev.rect)
    labelSlots.delete(key)
  }
  const result = placeLabel(x, y, halfW, halfH, gap, slide)
  const rect = { x: result.x - halfW, y: result.y - halfH, w: halfW * 2, h: halfH * 2 }
  gridInsert(labelGrid, rect)
  labelSlots.set(key, { x, y, halfW, halfH, result, rect })
  return result
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
    // --- Vorschau aus der Ansichts-Karte (Begruendung oben) -----------------------------------
    graphPreview,
    setGraphPreview(p) {
      graphPreview.value = p || null
    },
    // --- Fokus aus dem Code (Begruendung oben) ------------------------------------------------
    codeFocus,
    // Referenzgleichheit pruefen, gleiche Begruendung wie bei `setPinnedEdge`: der Graph schreibt
    // diesen Zustand aus einem watch ueber dem Layout, und ein unveraenderter Wert liesse sonst
    // bei jedem Layout-Lauf jede Karte und jede Kante ihre Daempfung neu bewerten.
    setCodeFocus(payload) {
      if (codeFocus.value !== payload) codeFocus.value = payload || null
    },
    // --- Bleibende Zuordnungsfarben der offenen Klasse (Begruendung oben) ----------------------
    selectionAnchor,
    selectionPalette,
    // Anker und Palette immer zusammen: eine Farbzuordnung ohne den Knoten, auf den sie sich
    // bezieht, waere ein Zustand, den niemand mehr aufloest (gleiche Regel wie beim Hover).
    setSelectionColors(anchor, palette = null) {
      selectionAnchor.value = anchor || null
      selectionPalette.value = anchor ? palette : null
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
    reserveLabelSpot,
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
