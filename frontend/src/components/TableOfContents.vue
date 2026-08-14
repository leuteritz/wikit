<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import SectionLabel from './ui/SectionLabel.vue'

const props = defineProps({
  toc: { type: Array, default: () => [] }, // [{ level, text, id }]
  /** Aus, wo die Überschrift bereits daneben steht (z. B. im `<summary>` der schmalen Fassung). */
  heading: { type: Boolean, default: true },
})

const activeId = ref('')
let observer = null

function setup() {
  observer?.disconnect()
  if (!props.toc.length) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) activeId.value = e.target.id
      }
    },
    { rootMargin: '0px 0px -75% 0px', threshold: 0 }
  )
  for (const item of props.toc) {
    const el = document.getElementById(item.id)
    if (el) observer.observe(el)
  }
}

onMounted(setup)
watch(() => props.toc, () => requestAnimationFrame(setup))
onBeforeUnmount(() => observer?.disconnect())

function jump(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <!-- ⚠️ Die Liste scrollt SELBST. Sie sitzt in einem `sticky`-Kasten, und ohne eigene Höhe lief
       ein Artikel mit vierzig Überschriften unten aus dem Bild – unerreichbar, weil die Seite
       darunter längst weitergescrollt ist. `5rem` ist der Abstand, den `sticky top-6` plus die
       Kopfhöhe belegen. -->
  <nav v-if="toc.length" class="max-h-[calc(100vh-5rem)] overflow-y-auto text-sm">
    <SectionLabel v-if="heading" class="mb-3">On this page</SectionLabel>
    <ul class="space-y-1 border-l border-line">
      <li v-for="item in toc" :key="item.id">
        <a
          href="javascript:void(0)"
          class="-ml-px block border-l-2 py-1 transition"
          :class="[
            item.level === 3 ? 'pl-6' : 'pl-3',
            activeId === item.id
              ? 'border-accent font-medium text-accent'
              : 'border-transparent text-muted hover:text-ink',
          ]"
          @click="jump(item.id)"
        >{{ item.text }}</a>
      </li>
    </ul>
  </nav>
</template>
