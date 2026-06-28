<script setup>
// Klassen-Abhaengigkeitsgraph (Vue Flow + dagre Auto-Layout).
// Knoten = NUR geladene Klassen (in Imports referenzierte, nicht geladene Klassen werden
// bewusst NICHT als Knoten dargestellt). Kanten = direkte Abhaengigkeiten zwischen geladenen
// Klassen: Methoden-Aufrufe ("ruft auf") + interne Importe. Farbe je Package rotierend
// (cerulean / tropical-teal / soft-fawn). Alles client-seitig aus der Dateiliste -> kein Request.
import { computed } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { MiniMap } from '@vue-flow/minimap'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import { useTheme } from '../../composables/useTheme.js'

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

  // 1) Methoden-Nutzungs-Kanten ("ruft auf"): fremder Methodenname taucht im Body auf.
  for (const fx of files) {
    const bodies = (fx.methods || []).map((m) => m.body || '').join('\n')
    if (!bodies) continue
    for (const fy of files) {
      if (fy.id === fx.id) continue
      const calls = (fy.methods || []).some((m) => m.method_name && bodies.includes(`${m.method_name}(`))
      if (calls) {
        callPairs.add(`${fx.id}->${fy.id}`)
        edges.push({
          id: `call:${fx.id}-${fy.id}`,
          source: `c:${fx.id}`,
          target: `c:${fy.id}`,
          label: 'ruft auf',
          animated: true,
          type: 'smoothstep',
          style: { stroke: 'var(--color-accent)', strokeWidth: 2 },
          labelStyle: { fill: 'var(--color-accent)', fontSize: '10px', fontWeight: 600 },
          labelBgStyle: { fill: 'var(--color-surface-2)' },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-accent)' },
        })
      }
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
        source: `c:${f.id}`,
        target: `c:${target.id}`,
        type: 'smoothstep',
        style: { stroke: 'var(--color-text-muted)', strokeWidth: 1.5, strokeDasharray: '5 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-text-muted)' },
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
const miniNodeColor = (n) => n.data?.color || '#48a9a6'

function onNodeClick({ node }) {
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
function resetView() {
  setViewport({ x: 0, y: 0, zoom: 1 })
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
              <span v-if="data.analyzed" title="KI-analysiert">✨ </span>{{ data.className }}
            </div>
            <div class="vf-pkg">{{ data.pkg }}</div>
          </div>
          <span class="vf-badge">{{ data.methodCount }}</span>
          <Handle type="source" :position="Position.Bottom" class="vf-handle" />
        </div>
      </template>

      <Background :gap="22" :pattern-color="dotColor" />
      <MiniMap pannable zoomable :node-color="miniNodeColor" />
    </VueFlow>

    <!-- Toolbar: Zoom / Fit / Reset -->
    <div v-if="files.length" class="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 p-1 shadow-sm backdrop-blur">
      <button type="button" class="vf-tool" title="Hineinzoomen" @click="zoomIn()">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" class="vf-tool" title="Herauszoomen" @click="zoomOut()">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" class="vf-tool" title="Einpassen" @click="fitView()">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
      <button type="button" class="vf-tool" title="Zurücksetzen" @click="resetView">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" /></svg>
      </button>
    </div>

    <!-- Legende -->
    <div v-if="files.length" class="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-accent)" />
        <span class="text-[var(--color-text-muted)]">ruft auf</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-text-muted); border-top: 1px dashed" />
        <span class="text-[var(--color-text-muted)]">importiert</span>
      </div>
      <div class="flex items-center gap-2">
        <span>✨</span>
        <span class="text-[var(--color-text-muted)]">KI-analysiert</span>
      </div>
    </div>
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
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
