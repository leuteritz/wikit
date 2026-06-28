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
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { Icon } from '../../lib/icons.js'
import JavaCodeEditor from './JavaCodeEditor.vue'

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

  // 1) Methoden-Nutzungs-Kanten: fremder Methodenname taucht im Body einer Methode auf.
  //    Pro gerichtetem Paar A->B die konkreten Call-Sites sammeln (welche Methode von A ruft
  //    welche Methode von B), damit Label + Code-Panel echte Daten zeigen.
  for (const fx of files) {
    const callerMethods = fx.methods || []
    for (const fy of files) {
      if (fy.id === fx.id) continue
      const calleeMethods = fy.methods || []
      const callSites = []
      for (const ca of callerMethods) {
        const body = ca.body || ''
        if (!body) continue
        for (const ce of calleeMethods) {
          if (ce.method_name && body.includes(`${ce.method_name}(`)) {
            callSites.push({ callerMethod: ca.method_name, calleeMethod: ce.method_name, callerBody: body })
          }
        }
      }
      if (!callSites.length) continue

      callPairs.add(`${fx.id}->${fy.id}`)
      const callees = [...new Set(callSites.map((c) => c.calleeMethod))]
      const label = callees.length === 1 ? `${callees[0]}()` : `${callees[0]}() +${callees.length - 1}`
      edges.push({
        id: `call:${fx.id}-${fy.id}`,
        source: `c:${fx.id}`,
        target: `c:${fy.id}`,
        label,
        animated: true,
        type: 'smoothstep',
        style: { stroke: 'var(--color-accent)', strokeWidth: 2, cursor: 'pointer' },
        labelStyle: { fill: 'var(--color-accent)', fontSize: '10px', fontWeight: 600, cursor: 'pointer' },
        labelBgStyle: { fill: 'var(--color-surface-2)' },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-accent)' },
        data: { kind: 'call', fromClass: fx.class_name, toClass: fy.class_name, callSites, callees },
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
        source: `c:${f.id}`,
        target: `c:${target.id}`,
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

// --- Code-Panel fuer angeklickte Call-Edges ---
const activeEdge = ref(null)
function onEdgeClick({ edge }) {
  // Nur Methoden-Nutzungs-Kanten haben Call-Sites; Import-Kanten ignorieren.
  if (edge?.data?.callSites?.length) activeEdge.value = edge.data
}
function closeEdgePanel() {
  activeEdge.value = null
}
// Pro aufrufende Methode gruppieren -> jeder Methodenrumpf nur einmal anzeigen.
const edgeGroups = computed(() => {
  if (!activeEdge.value) return []
  const map = new Map()
  for (const cs of activeEdge.value.callSites) {
    if (!map.has(cs.callerMethod)) {
      map.set(cs.callerMethod, { callerMethod: cs.callerMethod, callerBody: cs.callerBody, callees: new Set() })
    }
    map.get(cs.callerMethod).callees.add(cs.calleeMethod)
  }
  return [...map.values()].map((g) => ({ ...g, callees: [...g.callees] }))
})

function onKeydown(e) {
  if (e.key === 'Escape' && activeEdge.value) closeEdgePanel()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
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
        <span class="text-[var(--color-text-muted)]">ruft auf · klickbar</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-text-muted); border-top: 1px dashed" />
        <span class="text-[var(--color-text-muted)]">importiert</span>
      </div>
      <div class="flex items-center gap-2">
        <Icon icon="lucide:sparkles" class="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span class="text-[var(--color-text-muted)]">KI-analysiert</span>
      </div>
    </div>

    <!-- Code-Panel: verwendender Code einer Methoden-Nutzungs-Kante (ESC / Close schliesst) -->
    <Teleport to="body">
      <Transition name="edge-drawer">
        <div v-if="activeEdge" class="fixed inset-0 z-50 flex justify-end">
          <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="closeEdgePanel" />
          <aside class="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl">
            <header class="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
              <span class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Icon icon="lucide:code-2" class="h-4 w-4" />
              </span>
              <div class="min-w-0 flex-1">
                <h2 class="flex flex-wrap items-center gap-1.5 text-sm font-bold text-[var(--color-text)]">
                  <span class="truncate">{{ activeEdge.fromClass }}</span>
                  <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                  <span class="truncate">{{ activeEdge.toClass }}</span>
                </h2>
                <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  Verwendet: <code class="font-mono text-[var(--color-accent)]">{{ activeEdge.callees.map((c) => c + '()').join(', ') }}</code>
                </p>
              </div>
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                title="Schließen (ESC)"
                @click="closeEdgePanel"
              >
                <Icon icon="lucide:x" class="h-5 w-5" />
              </button>
            </header>

            <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <section v-for="grp in edgeGroups" :key="grp.callerMethod">
                <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <code class="rounded-md bg-[var(--color-surface-offset)] px-1.5 py-0.5 font-mono font-semibold text-[var(--color-text)]">{{ activeEdge.fromClass }}.{{ grp.callerMethod }}()</code>
                  <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                  <code
                    v-for="c in grp.callees"
                    :key="c"
                    class="rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[var(--color-accent)]"
                  >{{ c }}()</code>
                </div>
                <div class="h-72">
                  <JavaCodeEditor :model-value="grp.callerBody" readonly />
                </div>
              </section>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
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

/* Drawer-Transition (von rechts einschiebend). */
.edge-drawer-enter-active,
.edge-drawer-leave-active {
  transition: opacity 0.2s ease;
}
.edge-drawer-enter-active aside,
.edge-drawer-leave-active aside {
  transition: transform 0.2s ease;
}
.edge-drawer-enter-from,
.edge-drawer-leave-to {
  opacity: 0;
}
.edge-drawer-enter-from aside,
.edge-drawer-leave-to aside {
  transform: translateX(100%);
}
</style>
