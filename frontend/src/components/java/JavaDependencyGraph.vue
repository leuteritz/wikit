<script setup>
import { ref, watch, onMounted } from 'vue'
import { VueFlow, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

const props = defineProps({
  reloadToken: { type: Number, default: 0 },
})
const emit = defineEmits(['select'])

const { fetchGraph } = useJavaAnalyzer()
const nodes = ref([])
const edges = ref([])
const loading = ref(true)
const error = ref('')

// Farbe je class_type -> auf einen Blick erkennbar.
const TYPE_COLORS = {
  class: '#6366f1',
  interface: '#10b981',
  enum: '#f59e0b',
  annotation: '#ec4899',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { nodes: rawNodes, edges: rawEdges } = await fetchGraph()

    const n = rawNodes.length
    const radius = Math.max(220, n * 50)
    const cx = radius + 120
    const cy = radius + 120

    nodes.value = rawNodes.map((node, i) => {
      const angle = n > 1 ? (2 * Math.PI * i) / n - Math.PI / 2 : 0
      const color = TYPE_COLORS[node.class_type] || '#64748b'
      // Analysierte Klassen (KI-Klassenbeschreibung vorhanden) erhalten ein ✨ + Glow.
      const label = node.analyzed ? `✨ ${node.class_name}` : node.class_name
      return {
        id: String(node.id),
        position: n > 1
          ? { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
          : { x: cx, y: cy },
        data: { fileId: node.id, analyzed: node.analyzed, methodsAnalyzed: node.methods_analyzed },
        label,
        style: {
          background: color,
          color: '#fff',
          border: node.analyzed ? '2px solid #fbbf24' : 'none',
          borderRadius: '10px',
          padding: '8px 12px',
          fontSize: '12px',
          fontWeight: '600',
          width: '180px',
          textAlign: 'center',
          boxShadow: node.analyzed
            ? '0 0 0 3px rgba(251,191,36,0.35), 0 2px 8px rgba(0,0,0,0.15)'
            : '0 2px 8px rgba(0,0,0,0.15)',
        },
      }
    })

    edges.value = rawEdges.map((e) => ({
      id: 'je' + e.id,
      source: String(e.source_id),
      target: String(e.target_id),
      style: { stroke: '#94a3b8', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    }))
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)

function onNodeClick({ node }) {
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
    <div v-if="loading" class="absolute inset-0 grid place-items-center text-sm text-slate-400">Graph wird geladen…</div>
    <div v-else-if="error" class="absolute inset-0 grid place-items-center text-sm text-rose-500">{{ error }}</div>
    <div v-else-if="!nodes.length" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-400">
      Noch keine Java-Dateien analysiert. Wechsle zum Tab „Hochladen", um zu starten.
    </div>
    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      fit-view-on-init
      :min-zoom="0.2"
      :max-zoom="2"
      @node-click="onNodeClick"
    >
      <Background :gap="20" pattern-color="#cbd5e1" />
      <Controls />
    </VueFlow>

    <!-- Legende -->
    <div class="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
      <div v-for="(color, type) in TYPE_COLORS" :key="type" class="flex items-center gap-2">
        <span class="h-3 w-3 rounded-full" :style="{ background: color }" />
        <span class="capitalize text-slate-600 dark:text-slate-300">{{ type }}</span>
      </div>
      <div class="mt-1 flex items-center gap-2 border-t border-slate-200 pt-1 dark:border-slate-700">
        <span class="grid h-3 w-3 place-items-center rounded-full ring-2 ring-amber-400" />
        <span class="text-slate-600 dark:text-slate-300">✨ KI-analysiert</span>
      </div>
    </div>
  </div>
</template>
