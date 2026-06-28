<script setup>
// Klassen-Abhaengigkeitsgraph (Vue Flow + dagre Auto-Layout).
// Knoten = NUR geladene Klassen (in Imports referenzierte, nicht geladene Klassen werden
// bewusst NICHT als Knoten dargestellt). Kanten = direkte Abhaengigkeiten zwischen geladenen
// Klassen:
//   * Call-Edge ("Methoden-Nutzung"): durchgezogen + animiert + Akzentfarbe, Label = aufgerufene
//     Methode(n), KLICKBAR -> oeffnet ein Code-Panel mit dem verwendenden Code (CodeMirror).
//   * Import-Edge: gestrichelt + gedaempft, nicht klickbar.
// Farbe je Package rotierend. Alles client-seitig aus der Dateiliste (props.files enthaelt
// methods[].body + dependencies[]) -> kein Request, kein Backend noetig. Icons via Iconify.
import { computed, ref } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { Icon } from '../../lib/icons.js'
import JavaEdgeDetailPanel from './JavaEdgeDetailPanel.vue'

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
})
const emit = defineEmits(['select'])

const { theme } = useTheme()
const { fitView, zoomIn, zoomOut, setViewport } = useVueFlow()

// Genau drei Package-Farben, rotierend nach Package-Index.
const PKG_COLORS = ['#4281a4', '#48a9a6', '#d4b483']
const NODE_W = 208
const NODE_H = 66

const simpleName = (fqn) => String(fqn).split('.').pop()

// Methodensignatur fuers Edge-Panel: `return_type name(type name, …)` (parameters sind geparst).
const buildSignature = (m) => {
  const params = (m.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ')
  return `${m.return_type || 'void'} ${m.method_name}(${params})`
}

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

  // 1) Methoden-Nutzungs-Kanten: fremder Methodenname taucht im Body einer Methode auf.
  //    fx = aufrufende Klasse (Anwender), fy = definierende Klasse (Quelle der Methode).
  //    Pro gerichtetem Paar fx->fy die konkreten Call-Sites sammeln – inkl. EXAKTER Aufrufzeile
  //    (aus body_start_line + Newlines bis zur Fundstelle), damit das Edge-Panel die Stelle
  //    zeilengenau hervorheben kann.
  for (const fx of files) {
    const callerMethods = fx.methods || []
    for (const fy of files) {
      if (fy.id === fx.id) continue
      const calleeMethods = fy.methods || []
      const callSites = []
      for (const ca of callerMethods) {
        const body = ca.body || ''
        if (!body) continue
        // Basis-Zeile fuer absolute Aufrufzeilen: bevorzugt der Body-`{` (exakt), sonst die
        // Deklarationszeile (Bestandsdaten), sonst rein relativ.
        const base = ca.body_start_line ?? ca.start_line ?? null
        const lineExact = ca.body_start_line != null
        for (const ce of calleeMethods) {
          if (!ce.method_name) continue
          const safe = ce.method_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp(`\\b${safe}\\s*\\(`, 'g')
          let m
          while ((m = re.exec(body)) !== null) {
            const relLine = (body.slice(0, m.index).match(/\n/g) || []).length
            const line = base != null ? base + relLine : relLine + 1
            callSites.push({
              callerMethod: ca.method_name,
              calleeMethod: ce.method_name,
              callerBody: body,
              bodyStartLine: base,
              line,
              lineExact,
            })
          }
        }
      }
      if (!callSites.length) continue

      callPairs.add(`${fx.id}->${fy.id}`)
      const callees = [...new Set(callSites.map((c) => c.calleeMethod))]
      // Ziel-Methodensignatur (falls auffindbar) fuers Edge-Panel mitgeben – rein client-seitig
      // aus fy.methods (return_type + geparste parameters).
      const calleeSignatures = callees.map((name) => {
        const m = calleeMethods.find((mm) => mm.method_name === name)
        return { name, signature: m ? buildSignature(m) : '' }
      })
      const label = callees.length === 1 ? `${callees[0]}()` : `${callees[0]}() +${callees.length - 1}`
      edges.push({
        id: `call:${fx.id}-${fy.id}`,
        // Pfeilrichtung „Definition -> Nutzung": Quelle = definierende Klasse (fy),
        // Ziel (Pfeilspitze) = aufrufende Klasse (fx). Die data-Felder bleiben fachlich
        // (fromClass/fromFileId = Aufrufer, toClass/toFileId = Definition).
        source: `c:${fy.id}`,
        target: `c:${fx.id}`,
        label,
        animated: true,
        type: 'smoothstep',
        style: { stroke: 'var(--color-accent)', strokeWidth: 2, cursor: 'pointer' },
        labelStyle: { fill: 'var(--color-accent)', fontSize: '10px', fontWeight: 600, cursor: 'pointer' },
        labelBgStyle: { fill: 'var(--color-surface-2)' },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-accent)' },
        data: {
          kind: 'call',
          fromClass: fx.class_name,
          toClass: fy.class_name,
          fromFileId: fx.id,
          toFileId: fy.id,
          callSites,
          callees,
          calleeSignatures,
        },
      })
    }
  }

  // 2) Interne Import-Kanten (nur, wenn nicht bereits Call-Kante; nur geladene Ziele).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      const target = known.get(simpleName(dep))
      if (!target || target.id === f.id) continue
      if (callPairs.has(`${f.id}->${target.id}`)) continue
      callPairs.add(`${f.id}->${target.id}`)
      edges.push({
        id: `imp:${f.id}-${target.id}`,
        // Einheitlicher „Definition -> Nutzung"-Fluss: importierte Klasse = Quelle,
        // importierende Klasse = Ziel (Pfeilspitze).
        source: `c:${target.id}`,
        target: `c:${f.id}`,
        type: 'smoothstep',
        style: { stroke: 'var(--color-text-muted)', strokeWidth: 1.5, strokeDasharray: '5 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-text-muted)' },
        data: { kind: 'import' },
      })
    }
  }

  // --- dagre-Auto-Layout ---
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const f of files) g.setNode(`c:${f.id}`, { width: NODE_W, height: NODE_H })
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  const nodes = files.map((f) => {
    const pkg = f.package || '(default)'
    const nd = g.node(`c:${f.id}`)
    return {
      id: `c:${f.id}`,
      type: 'klass',
      // dagre liefert die Mitte -> Vue Flow erwartet die obere linke Ecke.
      position: { x: (nd?.x ?? 0) - NODE_W / 2, y: (nd?.y ?? 0) - NODE_H / 2 },
      data: {
        fileId: f.id,
        className: f.class_name,
        pkg,
        methodCount: (f.methods || []).length,
        color: pkgColor.get(pkg),
        analyzed: !!(f.description && f.description.trim()),
      },
    }
  })

  return { nodes, edges }
})

const nodes = computed(() => layout.value.nodes)
const edges = computed(() => layout.value.edges)

const dotColor = computed(() => (theme.value === 'dark' ? '#33485a' : '#cdc6bd'))

function onNodeClick({ node }) {
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
function resetView() {
  setViewport({ x: 0, y: 0, zoom: 1 })
}

// --- Edge-Detail-Panel fuer angeklickte Call-Edges (eigene Komponente, ESC dort) ---
const activeEdge = ref(null)
function onEdgeClick({ edge }) {
  // Nur Methoden-Nutzungs-Kanten haben Call-Sites; Import-Kanten ignorieren.
  if (edge?.data?.callSites?.length) activeEdge.value = edge.data
}
function closeEdgePanel() {
  activeEdge.value = null
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
    <div v-if="!files.length" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[var(--color-text-muted)]">
      Noch keine Java-Klassen analysiert. Lade über „Code analysieren" eine <code class="mx-1">.java</code>-Datei hoch.
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      fit-view-on-init
      :min-zoom="0.2"
      :max-zoom="2"
      :default-edge-options="{ type: 'smoothstep' }"
      @node-click="onNodeClick"
      @edge-click="onEdgeClick"
    >
      <!-- Custom Node: kompaktes Card-Design, Farbe nach Package -->
      <template #node-klass="{ data }">
        <div
          class="vf-card"
          :class="{ 'vf-card--selected': selectedId === data.fileId }"
          :style="{ '--pkg': data.color }"
        >
          <Handle type="target" :position="Position.Top" class="vf-handle" />
          <span class="vf-strip" />
          <div class="vf-body">
            <div class="vf-name">
              <Icon v-if="data.analyzed" icon="lucide:sparkles" class="vf-ai" title="KI-analysiert" />{{ data.className }}
            </div>
            <div class="vf-pkg">{{ data.pkg }}</div>
          </div>
          <span class="vf-badge">{{ data.methodCount }}</span>
          <Handle type="source" :position="Position.Bottom" class="vf-handle" />
        </div>
      </template>

      <Background :gap="22" :pattern-color="dotColor" />
    </VueFlow>

    <!-- Toolbar: Zoom / Fit / Reset -->
    <div v-if="files.length" class="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 p-1 shadow-sm backdrop-blur">
      <button type="button" class="vf-tool" title="Hineinzoomen" @click="zoomIn()">
        <Icon icon="lucide:zoom-in" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" title="Herauszoomen" @click="zoomOut()">
        <Icon icon="lucide:zoom-out" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" title="Einpassen" @click="fitView()">
        <Icon icon="lucide:maximize" class="h-4 w-4" />
      </button>
      <button type="button" class="vf-tool" title="Zurücksetzen" @click="resetView">
        <Icon icon="lucide:rotate-ccw" class="h-4 w-4" />
      </button>
    </div>

    <!-- Legende -->
    <div v-if="files.length" class="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-accent)" />
        <span class="text-[var(--color-text-muted)]">definiert → genutzt · klickbar</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-text-muted); border-top: 1px dashed" />
        <span class="text-[var(--color-text-muted)]">importiert von</span>
      </div>
      <div class="flex items-center gap-2">
        <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span class="text-[var(--color-text-muted)]">KI-analysiert</span>
      </div>
    </div>

    <!-- Edge-Detail-Panel: Parent -> Target einer Methoden-Nutzungs-Kante (ESC / Close schliesst) -->
    <JavaEdgeDetailPanel :edge="activeEdge" :visible="!!activeEdge" @close="closeEdgePanel" />
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

.vf-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 208px;
  padding: 8px 10px 8px 0;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-2);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--pkg) 22%, transparent);
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
}
.vf-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--pkg) 32%, transparent);
}
.vf-card--selected {
  border-color: var(--pkg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pkg) 35%, transparent), 0 6px 16px color-mix(in srgb, var(--pkg) 30%, transparent);
}
.vf-strip {
  width: 4px;
  align-self: stretch;
  border-radius: 12px 0 0 12px;
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
  background: var(--pkg);
}
.vf-handle {
  width: 6px;
  height: 6px;
  background: var(--color-border);
  border: none;
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
