<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { api } from '../lib/api.js'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

const router = useRouter()
const nodes = ref([])
const edges = ref([])
const loading = ref(true)
const error = ref('')

// Feste Farbpalette je Kategorie -> wiedererkennbare Knotenfarben.
const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444']

function colorFor(slug, index) {
  return PALETTE[index % PALETTE.length]
}

onMounted(async () => {
  try {
    const { nodes: rawNodes, edges: rawEdges } = await api.getGraph()

    // Kategorien einsammeln + Farbe zuordnen.
    const cats = [...new Set(rawNodes.map((n) => n.category_slug || '_none'))]
    const catColor = Object.fromEntries(cats.map((c, i) => [c, colorFor(c, i)]))

    // Kreis-Layout: Knoten gleichmaessig auf einem Ring verteilen (danach frei verschiebbar).
    const n = rawNodes.length
    const radius = Math.max(240, n * 46)
    const cx = radius + 120
    const cy = radius + 120

    nodes.value = rawNodes.map((node, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2
      const color = catColor[node.category_slug || '_none']
      return {
        id: String(node.id),
        position: { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) },
        data: { label: node.title, slug: node.slug },
        label: node.title,
        style: {
          background: color,
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          padding: '8px 12px',
          fontSize: '12px',
          fontWeight: '600',
          width: '170px',
          textAlign: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        },
      }
    })

    edges.value = rawEdges.map((e) => ({
      id: 'e' + e.id,
      source: String(e.source_id),
      target: String(e.target_id),
      label: e.label || e.relation_type,
      labelBgStyle: { fill: 'transparent' },
      labelStyle: { fontSize: '10px', fill: '#94a3b8' },
      style: { stroke: '#94a3b8', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    }))
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function onNodeClick({ node }) {
  if (node?.data?.slug) router.push(`/article/${node.data.slug}`)
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
    <div v-if="loading" class="absolute inset-0 grid place-items-center text-sm text-slate-400">Graph wird geladen…</div>
    <div v-else-if="error" class="absolute inset-0 grid place-items-center text-sm text-rose-500">{{ error }}</div>
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
  </div>
</template>
