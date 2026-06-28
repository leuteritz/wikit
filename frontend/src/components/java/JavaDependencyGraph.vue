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
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { VueFlow, MarkerType, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from '@dagrejs/dagre'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { useTheme } from '../../composables/useTheme.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { Icon } from '../../lib/icons.js'
import JavaEdgeDetailPanel from './JavaEdgeDetailPanel.vue'
import ManagedEdge from './ManagedEdge.vue'

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
})
const emit = defineEmits(['select'])

const { theme } = useTheme()
const { fitView, zoomIn, zoomOut, setViewport } = useVueFlow()

// Persistierte Call-Edges (auto + manuell) – Quelle der Wahrheit ist jetzt das Backend.
const { edges: serverEdges, fetchEdges, createEdge, updateEdge, deleteEdge } = useJavaGraph()

// Custom-Edge-Typ registrieren.
const edgeTypes = { managed: ManagedEdge }

// Genau drei Package-Farben, rotierend nach Package-Index.
const PKG_COLORS = ['#4281a4', '#48a9a6', '#d4b483']
const NODE_W = 208
const NODE_H = 66
const REVIEW_COLOR = '#d4a017'

const simpleName = (fqn) => String(fqn).split('.').pop()
const nodeFileId = (id) => Number(String(id).replace(/^c:/, ''))

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

  // 1) Persistierte Call-Edges aus dem Backend (auto + manuell). source_class = Aufrufer (A),
  //    target_class = definierende Klasse (B). Pfeilrichtung im Graph bleibt „Definition ->
  //    Nutzung": Graph-Quelle = B, Graph-Ziel (Pfeilspitze) = A. Nur Kanten rendern, deren
  //    beide Endpunkte geladen sind.
  for (const e of serverEdges.value || []) {
    const callerFile = known.get(e.source_class) // A
    const definerFile = known.get(e.target_class) // B
    if (!callerFile || !definerFile || callerFile.id === definerFile.id) continue
    callPairs.add(`${callerFile.id}->${definerFile.id}`)

    const needsReview = !e.is_manual && e.confidence < 1
    const stroke = needsReview ? REVIEW_COLOR : 'var(--color-accent)'
    edges.push({
      id: `edge:${e.id}`,
      source: `c:${definerFile.id}`,
      target: `c:${callerFile.id}`,
      type: 'managed',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        kind: 'call',
        edgeId: e.id,
        method: e.method_name,
        isManual: !!e.is_manual,
        confidence: e.confidence,
        needsReview,
        fromClass: e.source_class, // Aufrufer A
        toClass: e.target_class, // Definition B
        fromFileId: callerFile.id,
        toFileId: definerFile.id,
        edgeStyle: {
          stroke,
          strokeWidth: 2,
          strokeDasharray: e.is_manual ? '6 4' : undefined,
          cursor: 'pointer',
        },
        onEdit: openEdgeEditor,
        onDelete: removeEdge,
      },
    })
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

// --- Edge-Detail-Panel fuer angeklickte Auto-Call-Edges -----------------------
// Die Call-Sites werden erst beim Klick fuer das konkrete Klassenpaar + Methode berechnet
// (rein zur Anzeige; die Existenz der Kante kommt aus dem Backend). Manuelle Kanten haben
// keinen verifizierbaren Quellcode -> oeffnen das Panel nicht.
const activeEdge = ref(null)

function computeCallEdgeData(callerFile, definerFile, methodName, edgeMeta = {}) {
  const callSites = []
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
  return {
    kind: 'call',
    // Kanten-Metadaten fuer die Footer-Aktionen (Bearbeiten/Loeschen) im Modal.
    edgeId: edgeMeta.edgeId ?? null,
    method: methodName,
    isManual: !!edgeMeta.isManual,
    fromClass: callerFile.class_name,
    toClass: definerFile.class_name,
    fromFileId: callerFile.id,
    toFileId: definerFile.id,
    callSites,
    callees: [methodName],
    calleeSignatures: [{ name: methodName, signature: ce ? buildSignature(ce) : '' }],
  }
}

function onEdgeClick({ edge }) {
  const d = edge?.data
  // Auto- UND manuelle Call-Kanten oeffnen das Modal (manuelle haben ggf. keine verifizierten
  // Aufrufstellen -> der Verwendung-Abschnitt zeigt dann einen leeren Zustand).
  if (!d || d.kind !== 'call' || !d.method) return
  const callerFile = filesById.value.get(d.fromFileId)
  const definerFile = filesById.value.get(d.toFileId)
  if (!callerFile || !definerFile) return
  activeEdge.value = computeCallEdgeData(callerFile, definerFile, d.method, {
    edgeId: d.edgeId,
    isManual: d.isManual,
  })
}
function closeEdgePanel() {
  activeEdge.value = null
}

// --- Footer-Aktionen des Modals (wirken auf die KANTE) -----------------------
// Bearbeiten: Modal schliessen, den vorhandenen Floating-Editor (Methodenname) zentriert oeffnen.
function onEdgeEditFromModal() {
  const e = activeEdge.value
  if (!e) return
  const data = {
    edgeId: e.edgeId,
    method: e.method,
    fromClass: e.fromClass,
    toClass: e.toClass,
    isManual: e.isManual,
  }
  closeEdgePanel()
  openEdgeEditor(data, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 })
}

// Loeschen: Kante entfernen (zeigt zusaetzlich den bestehenden Undo-Toast), dann Modal schliessen.
async function onEdgeDeleteFromModal() {
  const e = activeEdge.value
  if (!e) return
  await removeEdge({
    edgeId: e.edgeId,
    method: e.method,
    isManual: e.isManual,
    fromClass: e.fromClass,
    toClass: e.toClass,
  })
  closeEdgePanel()
}

// --- Drag-to-Connect: manuelle Kante anlegen ---------------------------------
// Letzte Zeigerposition merken -> Floating-Editor erscheint direkt an der Abwurfstelle.
const lastPointer = { x: 0, y: 0 }
function onPointerMove(e) {
  lastPointer.x = e.clientX
  lastPointer.y = e.clientY
}

// Floating-Editor (Anlegen ODER Bearbeiten). null = geschlossen.
const editor = ref(null)
const methodInput = ref(null)

function onConnect(conn) {
  // Graph-Quelle = definierende Klasse (B), Graph-Ziel = aufrufende Klasse (A).
  const definerFile = filesById.value.get(nodeFileId(conn.source))
  const callerFile = filesById.value.get(nodeFileId(conn.target))
  if (!definerFile || !callerFile || definerFile.id === callerFile.id) return
  editor.value = {
    mode: 'create',
    method: '',
    sourceClass: callerFile.class_name, // A (Aufrufer)
    targetClass: definerFile.class_name, // B (Definition)
    x: lastPointer.x,
    y: lastPointer.y,
  }
  focusEditor()
}

function openEdgeEditor(data, event) {
  closeContextMenu()
  editor.value = {
    mode: 'edit',
    edgeId: data.edgeId,
    method: data.method || '',
    sourceClass: data.fromClass,
    targetClass: data.toClass,
    isManual: data.isManual,
    x: event?.clientX ?? window.innerWidth / 2,
    y: event?.clientY ?? window.innerHeight / 2,
  }
  focusEditor()
}

function focusEditor() {
  requestAnimationFrame(() => methodInput.value?.focus())
}

async function saveEditor() {
  const ed = editor.value
  if (!ed) return
  const method = (ed.method || '').trim()
  try {
    if (ed.mode === 'create') {
      await createEdge({ source: ed.sourceClass, target: ed.targetClass, methodName: method })
    } else {
      await updateEdge(ed.edgeId, { methodName: method })
    }
    editor.value = null
  } catch (e) {
    ed.error = e.message
  }
}
function cancelEditor() {
  editor.value = null
}

// --- Rechtsklick-Kontextmenue auf einer Kante --------------------------------
const contextMenu = ref(null)
function onEdgeContextMenu({ event, edge }) {
  event.preventDefault()
  if (!edge?.data || edge.data.kind !== 'call') return
  contextMenu.value = { x: event.clientX, y: event.clientY, data: edge.data }
}
function closeContextMenu() {
  contextMenu.value = null
}

// --- Loeschen + Undo-Toast ---------------------------------------------------
const toast = ref(null)
let toastTimer = null

async function removeEdge(data, event) {
  closeContextMenu()
  if (event?.stopPropagation) event.stopPropagation()
  await deleteEdge(data.edgeId)
  showUndo(data)
}

function showUndo(data) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { message: `Kante „${data.method || ''}()" entfernt`, data }
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 5000)
}

async function undoDelete() {
  const t = toast.value
  if (!t) return
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = null
  const d = t.data
  // Manuell -> war hart geloescht: neu anlegen. Auto -> war Tombstone: dismissed zuruecksetzen.
  if (d.isManual) await createEdge({ source: d.fromClass, target: d.toClass, methodName: d.method })
  else await updateEdge(d.edgeId, { dismissed: 0 })
}

// Overlays bei Pane-Interaktion / ESC schliessen.
function onPaneClick() {
  closeContextMenu()
  cancelEditor()
}
function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (editor.value) cancelEditor()
  else if (contextMenu.value) closeContextMenu()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    @pointermove="onPointerMove"
  >
    <div v-if="!files.length" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[var(--color-text-muted)]">
      Noch keine Java-Klassen analysiert. Lade über „Code analysieren" eine <code class="mx-1">.java</code>-Datei hoch.
    </div>

    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      :edge-types="edgeTypes"
      fit-view-on-init
      :min-zoom="0.2"
      :max-zoom="2"
      :default-edge-options="{ type: 'smoothstep' }"
      @node-click="onNodeClick"
      @edge-click="onEdgeClick"
      @edge-context-menu="onEdgeContextMenu"
      @connect="onConnect"
      @pane-click="onPaneClick"
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
        <span class="h-0.5 w-4 rounded" style="background: var(--color-accent); border-top: 1px dashed; border-color: var(--color-accent)" />
        <span class="text-[var(--color-text-muted)]">manuelle Kante</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="h-0.5 w-4 rounded" style="background: #d4a017" />
        <span class="text-[var(--color-text-muted)]">unsicher · „Bitte prüfen"</span>
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

    <!-- Hinweis: Drag-to-Connect -->
    <div
      v-if="files.length > 1"
      class="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)] shadow-sm backdrop-blur"
    >
      <Icon icon="lucide:link" class="h-3.5 w-3.5" />
      Ziehe von Knoten zu Knoten, um eine Kante zu verbinden
    </div>

    <!-- Edge-Detail-Modal: Definition -> Nutzung + Footer-Aktionen auf die Kante (ESC / Close schliesst) -->
    <JavaEdgeDetailPanel
      :edge="activeEdge"
      :visible="!!activeEdge"
      @close="closeEdgePanel"
      @edit="onEdgeEditFromModal"
      @delete="onEdgeDeleteFromModal"
    />

    <!-- Floating-Editor: Methodenname fuer neue/bearbeitete Kante (direkt an der Abwurfstelle) -->
    <Teleport to="body">
      <div
        v-if="editor"
        class="edge-editor fixed z-[60] w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 shadow-2xl"
        :style="{ left: editor.x + 'px', top: editor.y + 'px' }"
        @click.stop
      >
        <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-muted)]">
          <Icon :icon="editor.mode === 'create' ? 'lucide:link' : 'lucide:pencil'" class="h-3.5 w-3.5" />
          {{ editor.mode === 'create' ? 'Kante anlegen' : 'Kante bearbeiten' }}
        </div>
        <div class="mb-2 flex items-center gap-1 text-xs font-medium text-[var(--color-text)]">
          <span class="truncate font-mono">{{ editor.sourceClass }}</span>
          <Icon icon="lucide:arrow-right" class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
          <span class="truncate font-mono">{{ editor.targetClass }}</span>
        </div>
        <form @submit.prevent="saveEditor">
          <input
            ref="methodInput"
            v-model="editor.method"
            type="text"
            placeholder="Methodenname (z. B. execute)"
            class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            @keydown.esc.prevent="cancelEditor"
          />
          <p v-if="editor.error" class="mt-1 text-[11px] text-[var(--color-danger)]">{{ editor.error }}</p>
          <div class="mt-2.5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              @click="cancelEditor"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90"
            >
              <Icon icon="lucide:check" class="h-3.5 w-3.5" />
              Speichern
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- Rechtsklick-Kontextmenue auf einer Kante -->
    <Teleport to="body">
      <div v-if="contextMenu" class="fixed inset-0 z-[55]" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu">
        <div
          class="absolute min-w-[160px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] py-1 shadow-2xl"
          :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
          @click.stop
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-text)] transition hover:bg-[var(--color-surface-offset)]"
            @click="openEdgeEditor(contextMenu.data, { clientX: contextMenu.x, clientY: contextMenu.y })"
          >
            <Icon icon="lucide:pencil" class="h-4 w-4 text-[var(--color-text-muted)]" />
            Bearbeiten
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-surface-offset)]"
            @click="removeEdge(contextMenu.data)"
          >
            <Icon icon="lucide:trash-2" class="h-4 w-4" />
            Löschen
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Undo-Toast nach dem Loeschen -->
    <Teleport to="body">
      <Transition name="toast">
        <div
          v-if="toast"
          class="fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 shadow-2xl"
        >
          <Icon icon="lucide:trash-2" class="h-4 w-4 text-[var(--color-text-muted)]" />
          <span class="text-sm text-[var(--color-text)]">{{ toast.message }}</span>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--color-accent)] transition hover:opacity-80"
            @click="undoDelete"
          >
            <Icon icon="lucide:rotate-ccw" class="h-3.5 w-3.5" />
            Rückgängig
          </button>
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

/* Undo-Toast: kurzes Einblenden von unten. */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
