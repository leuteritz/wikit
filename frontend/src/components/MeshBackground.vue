<script setup>
// Animierter "Constellation"-Hintergrund (Canvas, kein Framework). Punkte driften einzeln und
// leicht; die Linien werden pro Frame aus den aktuellen Punkt-Positionen neu gezeichnet -> sie
// bleiben waehrend der Animation immer mit den Punkten verbunden. Punkte duerfen ueber den
// Bildschirmrand hinaus (MARGIN) und wrappen -> es sind immer welche off-screen.
// Rein dekorativ (aria-hidden), pointer-events-none. Farbe aus --color-accent (Theme-abhaengig).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useTheme } from '../composables/useTheme.js'

const { theme } = useTheme()

const canvas = ref(null)

const MARGIN = 80 // Knoten leben bis zu 80px ausserhalb des sichtbaren Bereichs
const LINK_DIST = 150 // max. Verbindungsdistanz zweier Punkte
const SPEED = 0.18 // leichte Bewegung pro Frame

let ctx = null
let raf = 0
let ro = null
let W = 0
let H = 0
let dpr = 1
let nodes = []
let rgb = { r: 66, g: 129, b: 164 } // Fallback = Cerulean #4281a4

const reduce =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: () => {}, removeEventListener: () => {} }

function refreshColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  const m = /^#?([0-9a-f]{6})$/i.exec(v)
  if (m) {
    const n = parseInt(m[1], 16)
    rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
}

function initNodes() {
  const count = Math.max(40, Math.min(110, Math.round((W * H) / 16000)))
  nodes = Array.from({ length: count }, () => ({
    x: Math.random() * (W + MARGIN * 2) - MARGIN,
    y: Math.random() * (H + MARGIN * 2) - MARGIN,
    vx: (Math.random() - 0.5) * SPEED,
    vy: (Math.random() - 0.5) * SPEED,
    r: 1.2 + Math.random() * 1.6,
  }))
}

function resize() {
  const el = canvas.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  W = rect.width
  H = rect.height
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  el.width = Math.round(W * dpr)
  el.height = Math.round(H * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  initNodes()
  if (reduce.matches) draw() // statisches Einzelbild
}

function step() {
  for (const n of nodes) {
    n.x += n.vx
    n.y += n.vy
    if (n.x < -MARGIN) n.x = W + MARGIN
    else if (n.x > W + MARGIN) n.x = -MARGIN
    if (n.y < -MARGIN) n.y = H + MARGIN
    else if (n.y > H + MARGIN) n.y = -MARGIN
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H)
  const { r, g, b } = rgb
  // Kanten: pro Frame aus aktuellen Positionen -> bleiben mit den Punkten verbunden.
  ctx.lineWidth = 1
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const c = nodes[j]
      const dx = a.x - c.x
      const dy = a.y - c.y
      const d2 = dx * dx + dy * dy
      if (d2 < LINK_DIST * LINK_DIST) {
        const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.6
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(c.x, c.y)
        ctx.stroke()
      }
    }
  }
  // Punkte
  ctx.fillStyle = `rgba(${r},${g},${b},0.9)`
  for (const n of nodes) {
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fill()
  }
}

function frame() {
  step()
  draw()
  raf = requestAnimationFrame(frame)
}

function start() {
  if (reduce.matches) {
    draw()
    return
  }
  if (!raf) raf = requestAnimationFrame(frame)
}

function stop() {
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

function onVisibility() {
  if (document.hidden) stop()
  else start()
}

function onReduceChange() {
  stop()
  start()
}

onMounted(() => {
  ctx = canvas.value.getContext('2d')
  refreshColor()
  resize()
  ro = new ResizeObserver(resize)
  ro.observe(canvas.value)
  document.addEventListener('visibilitychange', onVisibility)
  reduce.addEventListener?.('change', onReduceChange)
  start()
})

onBeforeUnmount(() => {
  stop()
  ro?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  reduce.removeEventListener?.('change', onReduceChange)
})

// Theme-Wechsel -> Farbe neu lesen (im reduced-motion-Fall einmal neu zeichnen).
watch(theme, () => {
  refreshColor()
  if (reduce.matches) draw()
})
</script>

<template>
  <div class="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
    <canvas ref="canvas" class="mesh-canvas h-full w-full"></canvas>
  </div>
</template>

<style scoped>
.mesh-canvas {
  display: block;
  opacity: 0.22; /* etwas praesenter, aber weiterhin Hintergrund-Textur */
}
</style>
