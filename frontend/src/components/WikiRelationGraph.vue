<script setup>
// Das Beziehungsnetz der Artikel. Bewusst schlanker als der Java-Graph: dort tragen die Kanten
// vier Arten, Mitglieder und Konfidenzen, hier ist eine Beziehung genau das, was jemand von Hand
// eingetragen hat. Also keine Kontextstufen, keine Zonen, keine Aggregatknoten – die Zahl der
// Artikel ist ueberschaubar, und ein Bedienelement, das nichts zu entscheiden hat, ist Ballast.
//
// ⚠️ **Was diese Ansicht kann und die Liste nicht:** Die Liste gruppiert nach Kategorie – das ist
// eine ZUORDNUNG. Der Graph zeigt die BEZIEHUNGEN, und damit drei Dinge, die dort unsichtbar
// bleiben: welche Artikel zusammenhaengen, welcher das Drehkreuz ist, und welche **verwaist** sind.
// Der verwaiste Artikel ist der eigentliche Befund: in der Liste steht er so prominent wie jeder
// andere.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { Icon } from '../lib/icons.js'
import { api } from '../lib/api.js'
import { layoutFlat } from '../lib/graphLayout.js'
import { buildWikiGraph, categoryColors, colorFor, neighboursOf, suggestionEdges } from '../lib/wikiGraph.js'
import { useRootScale } from '../composables/useRootScale.js'
import BusyState from './BusyState.vue'

const props = defineProps({
  categories: { type: Array, default: () => [] },
  /**
   * Die Treffer des Filters als Artikel-Ids – der Graph MARKIERT sie, statt sie zu isolieren.
   *
   * ⚠️ Bewusst die fertigen Ids und nicht der Suchbegriff: die Liste filtert ueber Titel, Summary
   * UND Tags, der Graph kennt von `GET /api/relations` aber nur Titel und Kategorie. Selbst zu
   * filtern hiesse also, mit weniger Feldern zu einer anderen Antwort zu kommen – gemessen stand
   * „2 results" im Kopf, waehrend im Bild genau eine Karte leuchtete.
   */
  matchIds: { type: Object, default: () => new Set() },
})

const router = useRouter()
const { scale } = useRootScale()
// Eigene Instanz-Id: `useVueFlow()` ohne Id greift auf einen geteilten Default-Store zu, und beim
// Routenwechsel leben Code- und Wiki-Graph fuer einen Moment nebeneinander.
const { fitView } = useVueFlow({ id: 'wiki-graph' })

// Kartenmass in px – Vue Flow positioniert in px, die Karte selbst rendert in rem. Beide muessen
// denselben Faktor sehen (gleiche Regel wie im Java-Graphen).
const NODE_W = computed(() => 208 * scale.value)
const NODE_H = computed(() => 62 * scale.value)

const raw = ref({ nodes: [], edges: [] })
const loading = ref(true)
const error = ref('')
const startedAt = ref(Date.now())
const hoverId = ref(null)
// Verwaiste ausblenden: sie sind der Befund, aber bei vielen erschlagen sie das Bild. Default
// „zeigen" – sie auszublenden waere die stille Behauptung, es gebe sie nicht.
const showOrphans = ref(true)

// Link-Vorschläge: bewusst NICHT beim Laden geholt. Der Endpunkt vergleicht jeden Artikel mit jedem,
// und wer die Ansicht nur ansieht, hat danach nicht gefragt. Geholt wird beim ersten Einschalten,
// danach gemerkt (bis eine Verknüpfung entsteht – dann stimmt die Antwort nicht mehr).
const showSuggestions = ref(false)
const suggestions = ref(null)
const suggestLoading = ref(false)

const graph = computed(() => buildWikiGraph(raw.value))
const colors = computed(() => categoryColors(props.categories))

/** Die gezeichneten Vorschlagskanten – leer, solange der Umschalter aus ist. */
const suggested = computed(() =>
  showSuggestions.value && suggestions.value
    ? suggestionEdges(graph.value.items, suggestions.value.articles || [])
    : [],
)

const visible = computed(() =>
  showOrphans.value ? graph.value.items : graph.value.items.filter((n) => !n.orphan),
)

// ⚠️ Vorschlagskanten zählen beim Hover als Nachbarschaft mit. Ohne das dämpft der Fokus auf einen
// verwaisten Artikel ausgerechnet die Karten weg, die er gerade vorschlägt – und die Frage beim
// Draufzeigen lautet dort „wohin könnte der?".
const neighbours = computed(() =>
  hoverId.value == null ? new Set() : neighboursOf([...graph.value.edges, ...suggested.value], hoverId.value),
)

// Gedaempft wird nur beim Hover – und nur, was weder der Anker noch sein Nachbar ist (dieselbe
// Regel wie im Java-Graphen: „soft", weil mehrere Karten gemeint sind).
function dimmed(id) {
  if (hoverId.value == null) return false
  return id !== hoverId.value && !neighbours.value.has(id)
}

const nodes = computed(() => {
  const list = visible.value
  if (!list.length) return []
  const ids = new Set(list.map((n) => n.id))
  const boxes = list.map((n) => ({ id: String(n.id), width: NODE_W.value, height: NODE_H.value }))
  // ⚠️ Die Vorschläge gehen INS LAYOUT, nicht nur ins Bild. Gemessen ohne sie: `layoutFlat` hält
  // einen verwaisten Artikel für unverbunden und legt ihn ans Ende – die gestrichelte Linie lief
  // dann quer über den ganzen Ausschnitt zu einer Karte am anderen Rand, und „der gehört
  // vielleicht dorthin" ist genau die Aussage, die man auf einen Blick sehen soll. Als eigene
  // `kind` (Gewicht 1 über `EDGE_WEIGHT`s Default): der Vorschlag zieht die Karten zusammen,
  // sticht aber keine echte Beziehung aus.
  const links = [
    ...graph.value.edges
      .filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
      .map((e) => ({ source: String(e.source_id), target: String(e.target_id), kind: 'related' })),
    ...suggested.value
      .filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
      .map((e) => ({ source: String(e.source_id), target: String(e.target_id), kind: 'suggest' })),
  ]
  const { pos } = layoutFlat({ nodes: boxes, edges: links, scale: scale.value })

  return list.map((n) => {
    const p = pos.get(String(n.id)) || { x: 0, y: 0 }
    return {
      id: String(n.id),
      type: 'article',
      // Vue Flow positioniert die linke obere Ecke, `layoutFlat` liefert Mittelpunkte.
      position: { x: p.x - NODE_W.value / 2, y: p.y - NODE_H.value / 2 },
      data: n,
      draggable: true,
    }
  })
})

/**
 * Die gestrichelten Vorschläge – dieselbe Kantenform, andere Aussage.
 *
 * ⚠️ Gestrichelt und ohne Pfeilspitze: eine durchgezogene Linie behauptet eine Beziehung, die
 * niemand eingetragen hat. Dieselbe Sprache wie beim verwaisten Artikel selbst (gestrichelter
 * Rahmen, kein Rot) – „noch nicht" ist kein Fehler.
 */
const suggestEdges = computed(() => {
  const ids = new Set(visible.value.map((n) => String(n.id)))
  return suggested.value
    .filter((e) => ids.has(String(e.source_id)) && ids.has(String(e.target_id)))
    .map((e) => {
      const lit = hoverId.value != null && (e.source_id === hoverId.value || e.target_id === hoverId.value)
      const dim = hoverId.value != null && !lit
      return {
        id: e.id,
        source: String(e.source_id),
        target: String(e.target_id),
        type: 'smoothstep',
        // Das Label ist der Wert, nicht die Geste: „0.81" sagt, wie sicher der Vorschlag ist, und
        // dass man klicken kann, sagt die Zeile unter der Bilanz einmal für alle.
        label: e.score.toFixed(2),
        data: { suggestion: true, source_id: e.source_id, target_id: e.target_id },
        class: 'wg-suggest',
        style: {
          stroke: lit ? 'var(--color-accent)' : 'var(--color-text-muted)',
          strokeWidth: lit ? 2 : 1.2,
          strokeDasharray: '5 4',
          opacity: dim ? 0.12 : 0.75,
        },
        labelStyle: { fill: 'var(--color-text-muted)', fontSize: `${10 * scale.value}px` },
        labelBgStyle: { fill: 'var(--color-surface)' },
        labelBgPadding: [3, 2],
        labelBgBorderRadius: 4,
      }
    })
})

const edges = computed(() => {
  const ids = new Set(visible.value.map((n) => String(n.id)))
  const real = graph.value.edges
    .filter((e) => ids.has(String(e.source_id)) && ids.has(String(e.target_id)))
    .map((e) => {
      const lit = hoverId.value != null && (e.source_id === hoverId.value || e.target_id === hoverId.value)
      const dim = hoverId.value != null && !lit
      return {
        id: `r${e.id}`,
        source: String(e.source_id),
        target: String(e.target_id),
        type: 'smoothstep',
        // Das Label ist die Art der Beziehung – ohne sie sagt eine Linie nur „irgendwie verwandt".
        label: e.label || e.relation_type || '',
        animated: lit,
        markerEnd: MarkerType.ArrowClosed,
        style: {
          stroke: lit ? 'var(--color-accent)' : 'var(--color-border-strong, var(--color-border))',
          strokeWidth: lit ? 2.2 : 1.4,
          opacity: dim ? 0.15 : 1,
        },
        labelStyle: { fill: 'var(--color-text-muted)', fontSize: `${11 * scale.value}px` },
        labelBgStyle: { fill: 'var(--color-surface)' },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
      }
    })
  // Die Vorschläge liegen ZUERST, damit eine echte Beziehung über einer gestrichelten zeichnet.
  return [...suggestEdges.value, ...real]
})

async function load() {
  loading.value = true
  error.value = ''
  startedAt.value = Date.now()
  try {
    raw.value = await api.getRelationGraph()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

// Nach jedem Layoutwechsel einpassen. `fitView` ohne `nodes` ist der dokumentierte Weg für
// „alles einpassen" – mit `nodes` waere es ein stiller No-Op (s. Stolperfallen).
// Auch die Zahl der Vorschlagskanten zählt mit: sie gehen ins Layout ein, also ordnet sich das Bild
// beim Umschalten neu – und ein Ausschnitt, der auf das alte Layout passte, passt dann nicht mehr.
watch(
  () => `${nodes.value.length}:${suggested.value.length}`,
  async () => {
    if (!nodes.value.length) return
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    fitView({ padding: 0.18 })
  },
)

function openArticle(node) {
  const slug = node?.data?.slug
  if (slug) router.push(`/article/${slug}`)
}

async function loadSuggestions() {
  suggestLoading.value = true
  try {
    suggestions.value = await api.getLinkSuggestions()
  } catch {
    // Still: ohne Antwort bleibt der Umschalter an und es erscheinen keine Linien. Warum, sagt
    // die Zeile darunter – Ollama ist optional, ein Toast wäre eine Beschwerde darüber.
    suggestions.value = null
  } finally {
    suggestLoading.value = false
  }
}

async function toggleSuggestions() {
  showSuggestions.value = !showSuggestions.value
  if (!showSuggestions.value) return
  // Vorschläge betreffen die Verwaisten – sie auszublenden und zugleich ihre Vorschläge zu
  // verlangen wäre eine Ansicht, die auf ihre eigene Frage nichts zeigt.
  showOrphans.value = true
  if (!suggestions.value) await loadSuggestions()
}

/**
 * Klick auf eine gestrichelte Linie: die Beziehung anlegen.
 *
 * Danach werden BEIDE Bestände neu geholt – der Graph, weil aus dem verwaisten Artikel gerade ein
 * verknüpfter wurde, und die Vorschläge, weil dieses Paar jetzt keiner mehr ist. Sie nur aus der
 * lokalen Liste zu streichen hiesse, die Regel „bestehende Beziehungen fallen raus" ein zweites Mal
 * zu kennen.
 */
async function onEdgeClick(edge) {
  const d = edge?.data
  if (!d?.suggestion) return
  await api.createRelation({ source_id: d.source_id, target_id: d.target_id, relation_type: 'related' })
  await Promise.all([load(), loadSuggestions()])
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
    <BusyState
      v-if="loading"
      variant="overlay"
      title="Loading the relation graph…"
      detail="articles and their typed links"
      :since="startedAt"
    />

    <p v-else-if="error" class="p-4 text-sm text-[var(--color-danger)]">{{ error }}</p>

    <!-- Leerzustand mit Grund: „keine Beziehungen" ist eine andere Auskunft als „keine Artikel",
         und nur die erste hat einen naechsten Schritt. -->
    <div
      v-else-if="!graph.totals.relations"
      class="grid h-full place-items-center px-8 text-center"
    >
      <div>
        <Icon icon="lucide:network" class="mx-auto h-7 w-7 text-[var(--color-text-muted)]" />
        <p class="mt-2 text-sm font-semibold text-[var(--color-text)]">
          {{ graph.totals.articles ? 'No relations yet' : 'No articles yet' }}
        </p>
        <p class="mx-auto mt-1 max-w-sm text-xs text-[var(--color-text-muted)]">
          {{
            graph.totals.articles
              ? 'Link two articles from the editor and the net starts here — the list can group them, only this shows what points where.'
              : 'Write an article first, then link it to another.'
          }}
        </p>
      </div>
    </div>

    <template v-else>
      <VueFlow
        id="wiki-graph"
        :nodes="nodes"
        :edges="edges"
        fit-view-on-init
        :min-zoom="0.2"
        :max-zoom="1.8"
        :nodes-connectable="false"
        :edges-updatable="false"
        @node-click="openArticle($event.node)"
        @edge-click="onEdgeClick($event.edge)"
        @node-mouse-enter="hoverId = $event.node.data.id"
        @node-mouse-leave="hoverId = null"
        @pane-click="hoverId = null"
      >
        <Background :gap="22" :size="1" pattern-color="var(--color-border)" />

        <template #node-article="{ data }">
          <div
            class="wg-card"
            :class="{
              'wg-card--orphan': data.orphan,
              'wg-card--match': props.matchIds.has(data.id),
              'wg-card--hover': hoverId === data.id,
              'wg-card--near': neighbours.has(data.id),
              'wg-card--dim': dimmed(data.id),
            }"
            :style="{ '--cat': colorFor(colors, data.category_id) }"
          >
            <Handle type="target" :position="Position.Top" class="wg-handle" />
            <span class="wg-stripe" />
            <span class="wg-title">{{ data.title }}</span>
            <span class="wg-meta">
              <span v-if="data.category" class="truncate">{{ data.category }}</span>
              <span v-else class="italic opacity-70">uncategorized</span>
              <!-- ⚠️ Die Richtung steht getrennt: „von hier fuehrt nichts weiter" und „hierher
                   fuehrt nichts" sind zwei verschiedene Luecken. -->
              <span v-if="!data.orphan" class="ml-auto shrink-0 tabular-nums opacity-70">
                {{ data.in }}↓ {{ data.out }}↑
              </span>
              <span v-else class="ml-auto shrink-0 font-semibold uppercase tracking-wide">unlinked</span>
            </span>
            <Handle type="source" :position="Position.Bottom" class="wg-handle" />
          </div>
        </template>
      </VueFlow>

      <!-- Bilanz oben links: was im Bild steht, in Zahlen. Die verwaisten stehen dabei, weil sie
           der Grund sind, aus dem man diese Ansicht ueberhaupt oeffnet. -->
      <div class="wg-stats">
        <span><strong>{{ graph.totals.articles }}</strong> articles</span>
        <span><strong>{{ graph.totals.relations }}</strong> relations</span>
        <button
          type="button"
          class="wg-toggle"
          :class="showOrphans ? 'wg-toggle--on' : ''"
          :title="showOrphans ? 'Hide articles with no relation' : 'Show articles with no relation'"
          @click="showOrphans = !showOrphans"
        >
          <Icon :icon="showOrphans ? 'lucide:eye' : 'lucide:eye-off'" class="h-3.5 w-3.5" />
          <strong>{{ graph.totals.orphans }}</strong> unlinked
        </button>
        <span v-if="graph.totals.busiest?.degree" class="wg-busiest" :title="`Most connected: ${graph.totals.busiest.title}`">
          <Icon icon="lucide:share-2" class="h-3.5 w-3.5" />
          {{ graph.totals.busiest.title }}
        </span>
        <!-- Nur wenn es Verwaiste gibt: ein Knopf, der nichts zu finden hätte, stellt eine Frage,
             die die Ansicht gerade mit „nichts offen" beantwortet hat. -->
        <button
          v-if="graph.totals.orphans"
          type="button"
          class="wg-toggle"
          :class="showSuggestions ? 'wg-toggle--active' : ''"
          v-tip="{
            title: 'Suggest links for unlinked articles',
            hint: 'Compares every article with every other one using the meaning index — no new AI call. Needs an embedding model and a built index.',
          }"
          @click="toggleSuggestions"
        >
          <Icon
            :icon="suggestLoading ? 'lucide:loader-2' : 'lucide:sparkles'"
            class="h-3.5 w-3.5"
            :class="suggestLoading ? 'animate-spin' : ''"
          />
          suggest
        </button>
      </div>

      <!-- Was die gestrichelte Linie ist und dass man sie anklicken kann – einmal für alle statt
           an jeder Kante. Steht nur, solange der Modus an ist. -->
      <div v-if="showSuggestions" class="wg-hint">
        <template v-if="suggested.length">
          <Icon icon="lucide:mouse-pointer-click" class="h-3.5 w-3.5 shrink-0" />
          <span>Dashed lines are suggestions — click one to link the two articles.</span>
        </template>
        <template v-else-if="!suggestLoading">
          <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
          <!-- Ein leeres Ergebnis hat vier Gründe, und jeder hat einen anderen nächsten Schritt –
               deshalb steht der Grund da und nicht „nothing found" (gleiche Regel wie bei /ask). -->
          <span>{{ suggestions?.reason || 'Nothing close enough to suggest — the unlinked articles have no near neighbour here.' }}</span>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

.wg-card {
  @apply relative flex w-[13rem] flex-col justify-center gap-0.5 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-3.5 pr-2.5 transition;
  height: 3.875rem;
  cursor: pointer;
}
.wg-card:hover {
  border-color: var(--cat);
}

/* Kategoriestreifen – dieselbe Farbe wie der Punkt vor der Gruppe in der Liste. */
.wg-stripe {
  @apply absolute inset-y-0 left-0 w-1;
  background: var(--cat);
}

.wg-title {
  @apply truncate text-xs font-semibold leading-tight text-[var(--color-text)];
}
.wg-meta {
  @apply flex items-center gap-1.5 truncate text-3xs text-[var(--color-text-muted)];
}

/* Verwaist: gestrichelter Rahmen statt einer Warnfarbe. Ein Artikel ohne Beziehung ist kein
   Fehler – er ist nur noch nicht verknuepft, und Rot waere eine Bewertung. */
.wg-card--orphan {
  @apply border-dashed;
  background: color-mix(in srgb, var(--color-surface-offset) 60%, transparent);
}

/* Filtertreffer: Ring in der Akzentfarbe, wie die Treffer im Java-Graphen. */
.wg-card--match {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

.wg-card--hover {
  border-color: var(--cat);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--cat) 35%, transparent);
  transform: scale(1.03);
}
/* Der Nachbar behaelt seine eigene Farbe – traege er den Akzent, saehen zwanzig Nachbarn aus wie
   zwanzig Treffer (gleiche Regel wie bei der Suche im Java-Graphen). */
.wg-card--near {
  border-color: color-mix(in srgb, var(--cat) 60%, var(--color-border));
}
.wg-card--dim {
  opacity: 0.14;
}

/* Die Handles tragen hier keine Bedienung (nodes-connectable=false) – sie sind nur die Anker der
   Kanten und deshalb unsichtbar. */
.wg-handle {
  @apply pointer-events-none opacity-0;
}

.wg-stats {
  @apply pointer-events-auto absolute left-3 top-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-3xs text-[var(--color-text-muted)] shadow-sm;
}
.wg-stats strong {
  @apply font-semibold tabular-nums text-[var(--color-text)];
}
.wg-toggle {
  @apply inline-flex items-center gap-1 rounded px-1 py-0.5 transition;
}
.wg-toggle:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.wg-toggle--on strong {
  color: var(--color-text);
}
/* Der Vorschlagsmodus ist ein ZUSTAND, kein Klick – also bleibt er sichtbar an. */
.wg-toggle--active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.wg-hint {
  @apply pointer-events-none absolute left-3 right-3 top-[3.4rem] flex items-center gap-1.5 text-3xs text-[var(--color-text-muted)];
}

/* Die gestrichelte Linie ist die einzige, die eine Handlung anbietet – der Zeiger sagt es, und die
   breitere unsichtbare Trefferfläche von Vue Flow macht sie bei 1,2 px Strichstärke treffbar. */
:deep(.wg-suggest) {
  cursor: pointer;
}
:deep(.wg-suggest:hover) .vue-flow__edge-path {
  stroke: var(--color-accent) !important;
  stroke-width: 2.2 !important;
  opacity: 1 !important;
}
.wg-busiest {
  @apply inline-flex max-w-[12rem] items-center gap-1 truncate;
}
</style>
