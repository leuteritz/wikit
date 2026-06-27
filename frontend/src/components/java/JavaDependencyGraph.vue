<script setup>
// Package-Dependency-Graph (Vue Flow). Knoten = analysierte Klassen, gruppiert nach Package.
// - interne Kanten: Import-FQN, dessen einfacher Name eine bekannte Klasse ist
// - externe Imports: gestrichelte, halbtransparente Knoten am Rand
// - Methoden-Nutzungs-Kanten ("ruft auf"): String-Match eines fremden Methodennamens im body
// Berechnet alles client-seitig aus der (bereits serialisierten) Dateiliste -> kein Extra-Request.
import { computed } from 'vue'
import { VueFlow, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
})
const emit = defineEmits(['select'])

// Akzent = Dusty Denim (Light) / Periwinkle (Dark) via Token; Typfarben semantisch.
const TYPE_COLORS = {
  class: '#6c91c2',
  interface: '#10b981',
  enum: '#f59e0b',
  annotation: '#ec4899',
}
const FALLBACK_COLOR = '#8b8982'

const NODE_W = 184
const NODE_H = 56
const GAP_X = 44
const LABEL_H = 26
const PAD = 26
const GROUP_GAP_Y = 56

const simpleName = (fqn) => String(fqn).split('.').pop()

const layout = computed(() => {
  const files = props.files || []
  const known = new Map() // class_name -> file
  for (const f of files) known.set(f.class_name, f)

  // Dateien nach Package gruppieren (stabile Sortierung).
  const byPkg = new Map()
  for (const f of files) {
    const pkg = f.package || '(default)'
    if (!byPkg.has(pkg)) byPkg.set(pkg, [])
    byPkg.get(pkg).push(f)
  }
  const pkgNames = [...byPkg.keys()].sort()

  const nodes = []
  const pos = new Map() // fileId -> {x,y}
  let cursorY = 0
  let maxRight = 0

  for (const pkg of pkgNames) {
    const members = byPkg.get(pkg).slice().sort((a, b) => a.class_name.localeCompare(b.class_name))
    const groupW = Math.max(NODE_W, members.length * NODE_W + (members.length - 1) * GAP_X) + PAD * 2
    const groupH = LABEL_H + NODE_H + PAD * 2

    // Hintergrund-Rechteck der Package-Gruppe (nicht interaktiv, liegt hinten).
    nodes.push({
      id: `pkg:${pkg}`,
      type: 'default',
      position: { x: 0, y: cursorY },
      data: {},
      label: pkg,
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: 0,
      style: {
        width: `${groupW}px`,
        height: `${groupH}px`,
        background: 'var(--color-surface-2)',
        border: '1px dashed var(--color-border)',
        borderRadius: '16px',
        color: 'var(--color-text-muted)',
        fontSize: '11px',
        fontWeight: '600',
        textAlign: 'left',
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
      },
    })

    members.forEach((f, i) => {
      const x = PAD + i * (NODE_W + GAP_X)
      const y = cursorY + LABEL_H + PAD
      pos.set(f.id, { x: x + NODE_W / 2, y: y + NODE_H / 2 })
      const analyzed = !!(f.description && f.description.trim())
      const color = TYPE_COLORS[f.class_type] || FALLBACK_COLOR
      const selected = props.selectedId === f.id
      nodes.push({
        id: `c:${f.id}`,
        position: { x, y },
        data: { fileId: f.id },
        label: `${analyzed ? '✨ ' : ''}${f.class_name}`,
        zIndex: 1,
        style: {
          width: `${NODE_W}px`,
          background: color,
          color: '#fff',
          border: selected
            ? '2px solid var(--color-accent)'
            : analyzed
              ? '2px solid #fbbf24'
              : '1px solid rgba(255,255,255,0.25)',
          borderRadius: '12px',
          padding: '8px 12px',
          fontSize: '12px',
          fontWeight: '600',
          textAlign: 'center',
          boxShadow: selected
            ? '0 0 0 4px var(--color-accent-soft), 0 4px 12px rgba(0,0,0,0.18)'
            : analyzed
              ? '0 0 0 3px rgba(251,191,36,0.3), 0 2px 8px rgba(0,0,0,0.15)'
              : '0 2px 8px rgba(0,0,0,0.15)',
        },
      })
    })

    maxRight = Math.max(maxRight, groupW)
    cursorY += groupH + GROUP_GAP_Y
  }

  // Externe Importe als eigene, gestrichelte Knoten rechts daneben sammeln (dedupliziert).
  const externalSet = new Set()
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      if (!known.has(simpleName(dep))) externalSet.add(dep)
    }
  }
  const externals = [...externalSet].sort()
  const extX = maxRight + 160
  externals.forEach((fqn, i) => {
    nodes.push({
      id: `ext:${fqn}`,
      position: { x: extX, y: i * (NODE_H + 18) },
      data: {},
      label: fqn,
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: 1,
      style: {
        width: '220px',
        background: 'transparent',
        border: '1px dashed var(--color-border)',
        borderRadius: '10px',
        padding: '6px 10px',
        fontSize: '10px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--color-text-muted)',
        opacity: 0.6,
        textAlign: 'left',
      },
    })
  })

  // Kanten berechnen.
  const edges = []
  const callPairs = new Set()

  // 1) Methoden-Nutzungs-Kanten ("ruft auf").
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

  // 2) Interne Import-Kanten (nur, wenn nicht bereits als Call-Kante vorhanden).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      const target = known.get(simpleName(dep))
      if (!target || target.id === f.id) continue
      if (callPairs.has(`${f.id}->${target.id}`)) continue
      edges.push({
        id: `imp:${f.id}-${target.id}-${simpleName(dep)}`,
        source: `c:${f.id}`,
        target: `c:${target.id}`,
        style: { stroke: '#94a3b8', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
      })
    }
  }

  // 3) Externe Import-Kanten (gestrichelt, dezent).
  for (const f of files) {
    for (const dep of f.dependencies || []) {
      if (known.has(simpleName(dep))) continue
      edges.push({
        id: `ext:${f.id}-${dep}`,
        source: `c:${f.id}`,
        target: `ext:${dep}`,
        style: { stroke: 'var(--color-border)', strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.6 },
      })
    }
  }

  return { nodes, edges }
})

const nodes = computed(() => layout.value.nodes)
const edges = computed(() => layout.value.edges)

function onNodeClick({ node }) {
  if (node?.data?.fileId != null) emit('select', node.data.fileId)
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
    <div v-if="!files.length" class="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-400">
      Noch keine Java-Klassen analysiert. Lade links eine <code class="mx-1">.java</code>-Datei hoch, um zu starten.
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
      <Background :gap="22" pattern-color="#cbd5e1" />
      <Controls />
    </VueFlow>

    <!-- Legende -->
    <div class="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
      <div v-for="(color, type) in TYPE_COLORS" :key="type" class="flex items-center gap-2">
        <span class="h-3 w-3 rounded-full" :style="{ background: color }" />
        <span class="capitalize text-slate-600 dark:text-slate-300">{{ type }}</span>
      </div>
      <div class="mt-1 flex items-center gap-2 border-t border-slate-200 pt-1 dark:border-slate-700">
        <span class="h-0.5 w-4 rounded" style="background: var(--color-accent)" />
        <span class="text-slate-600 dark:text-slate-300">ruft auf</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="grid h-3 w-3 place-items-center rounded-full ring-2 ring-amber-400" />
        <span class="text-slate-600 dark:text-slate-300">✨ KI-analysiert</span>
      </div>
    </div>
  </div>
</template>
