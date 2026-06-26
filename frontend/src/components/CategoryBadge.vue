<script setup>
defineProps({
  category: { type: Object, default: null },
  size: { type: String, default: 'sm' }, // 'sm' | 'xs'
})
</script>

<template>
  <span
    v-if="category"
    class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    :class="size === 'xs' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'"
  >
    <span v-if="category.icon">{{ category.icon }}</span>
    {{ category.name }}
  </span>
</template>
