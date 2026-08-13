<script setup>
// „Wer verlinkt hierher?" – aus `[[Wikilinks]]` im Text anderer Artikel.
//
// ⚠️ **Die dritte Art von Zusammenhang, und deshalb ein dritter Abschnitt.** Am Artikel stehen
// jetzt untereinander:
//   Relations       – von Hand eingetragen   -> eine ENTSCHEIDUNG
//   Linked mentions – steht so im Text       -> eine TATSACHE
//   Related         – aus dem Bedeutungsindex -> eine VERMUTUNG
// In der Reihenfolge, in der ihre Verbindlichkeit abnimmt. Sie zu einer Liste zu verschmelzen
// hiesse, diese drei Aussagen gleich aussehen zu lassen – genau das, was das Projekt zwischen
// `Relations` und `Related` schon einmal ausdrücklich abgelehnt hat.
//
// ⚠️ **Ohne Backlinks erscheint der Abschnitt gar nicht** (gleiche Regel wie bei `RelatedArticles`):
// drei leere Überschriften unter jedem Artikel wären eine Daueraussage über einen Normalzustand.
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../lib/api.js'
import { Icon } from '../lib/icons.js'

const props = defineProps({ article: { type: Object, required: true } })

const items = ref([])

async function load(id) {
  items.value = []
  if (!id) return
  try {
    const res = await api.getBacklinks(id)
    items.value = res?.items || []
  } catch {
    // Still: der Abschnitt entfällt dann einfach (s. Kopf).
    items.value = []
  }
}

watch(() => props.article?.id, load, { immediate: true })
</script>

<template>
  <section v-if="items.length" class="mt-10 border-t border-line pt-6">
    <h2 class="mb-4 flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted">
      <Icon icon="lucide:link" class="h-3.5 w-3.5" />
      Linked mentions
      <span class="rounded-full border border-line px-1.5 py-0.5 tabular-nums">{{ items.length }}</span>
    </h2>
    <div class="grid gap-3 sm:grid-cols-2">
      <RouterLink
        v-for="a in items"
        :key="a.id"
        :to="`/article/${a.slug}`"
        class="group flex flex-col gap-1 rounded-lg border border-line bg-surface-2 p-3 transition hover:-translate-y-0.5 hover:border-accent"
      >
        <span class="text-sm font-semibold leading-snug text-ink group-hover:text-accent">{{ a.title }}</span>
        <!-- Der Anzeigetext des Links, wenn er vom Titel abweicht: er sagt, WIE dort auf diesen
             Artikel verwiesen wird – und das ist oft die interessantere Angabe als das Ziel. -->
        <span v-if="a.label" class="font-mono text-3xs text-muted">as “{{ a.label }}”</span>
        <span v-else-if="a.summary" class="line-clamp-1 text-xs text-muted">{{ a.summary }}</span>
      </RouterLink>
    </div>
  </section>
</template>
