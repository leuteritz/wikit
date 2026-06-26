<script setup>
import RelationGraph from '../components/RelationGraph.vue'
</script>

<template>
  <div class="flex h-[calc(100vh-3.5rem)] flex-col px-5 py-6">
    <div class="mb-4 shrink-0">
      <h1 class="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Zusammenhang-Graph</h1>
      <p class="text-sm text-slate-500 dark:text-slate-400">
        Knoten = Artikel, Pfeile = Beziehungen. Knoten ziehen zum Umordnen, klicken zum Öffnen.
      </p>
    </div>
    <div class="min-h-0 flex-1">
      <RelationGraph />
    </div>
  </div>
</template>
