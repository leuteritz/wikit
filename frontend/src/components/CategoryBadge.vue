<script setup>
defineProps({
  category: { type: Object, default: null },
  size: { type: String, default: 'sm' }, // 'sm' | 'xs'
})
</script>

<template>
  <span
    v-if="category"
    class="inline-flex items-center gap-1 rounded-full border border-line bg-surface-offset font-medium text-muted"
    :class="size === 'xs' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-xs'"
  >
    <span v-if="category.icon">{{ category.icon }}</span>
    {{ category.name }}
  </span>
</template>
