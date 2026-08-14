<script setup>
// Der Rumpf unter `PageHeader`: der Scroll-Container und die EINE Inhaltsbreite.
//
// Er sieht nach nichts aus und traegt trotzdem die halbe Struktur: `min-h-0 flex-1
// overflow-y-auto` ist die Zeile, ohne die eine Flex-Spalte in voller Hoehe nicht scrollt,
// sondern ueber den Bildschirm hinauswaechst. Sie stand in jeder dieser Ansichten erneut, und
// „min-h-0" ist genau die Sorte Detail, die beim naechsten Kopieren wegbleibt.
//
// ⚠️ Die Breite MUSS dieselbe sein wie am Kopf darueber, sonst sitzt der Titel gegen den Inhalt
// versetzt. Deshalb tragen beide dieselbe Prop und dieselbe Tabelle – und deshalb steht die
// Tabelle nicht in einem geteilten Helfer: zwei Komponenten, die immer zusammen auftreten, teilen
// besser einen Wert als eine Abhaengigkeit.
defineProps({
  width: { type: String, default: '6xl' }, // 4xl | 5xl | 6xl | 7xl
  /** Innenabstand des Rumpfes. `none`, wenn der Inhalt selbst bis an den Rand geht. */
  pad: { type: String, default: 'md' }, // none | md
})

const WIDTHS = { '4xl': 'max-w-4xl', '5xl': 'max-w-5xl', '6xl': 'max-w-6xl', '7xl': 'max-w-7xl' }
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto" :class="pad === 'none' ? '' : 'px-5 py-5'">
    <div :class="['mx-auto w-full', WIDTHS[width] || WIDTHS['6xl']]">
      <slot />
    </div>
  </div>
</template>
