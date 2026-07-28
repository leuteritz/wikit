<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  toc: { type: Array, default: () => [] }, // [{ level, text, id }]
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
  <nav v-if="toc.length" class="text-sm">
    <p class="mb-3 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">On this page</p>
    <ul class="space-y-1 border-l border-[var(--color-border)]">
      <li v-for="item in toc" :key="item.id">
        <a
          href="javascript:void(0)"
          class="-ml-px block border-l-2 py-1 transition"
          :class="[
            item.level === 3 ? 'pl-6' : 'pl-3',
            activeId === item.id
              ? 'border-[var(--color-accent)] font-medium text-[var(--color-accent)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          ]"
          @click="jump(item.id)"
        >{{ item.text }}</a>
      </li>
    </ul>
  </nav>
</template>
