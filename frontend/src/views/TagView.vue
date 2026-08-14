<script setup>
// Alles zu EINEM Schlagwort.
//
// Der Bestand kannte Schlagwörter schon lange – sie standen an jedem Artikel, wurden von der
// globalen Suche gefunden und vom Wiki-Filter als Substring getroffen. Was fehlte, war die
// Gegenrichtung: „zeig mir alles, was mit diesem hier zusammenhängt". `GET /api/tags` gab es
// bereits, aufgerufen hat ihn keine Zeile im Frontend.
//
// ⚠️ Gerechnet wird aus `listArticles()`, nicht aus einem eigenen Endpunkt: die Liste liegt im
// Store ohnehin (jede Wiki-Ansicht lädt sie), sie trägt die Schlagwörter mit, und ein persönliches
// Wiki hat Dutzende Artikel. Ein Server-Filter wäre ein zweiter Weg zu derselben Auskunft.
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useArticles } from '../composables/useArticles.js'
import BusyState from '../components/BusyState.vue'
import CategoryBadge from '../components/CategoryBadge.vue'
import SectionLabel from '../components/ui/SectionLabel.vue'
import Button from '../components/ui/Button.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { Icon } from '../lib/icons.js'

const props = defineProps({ name: { type: String, required: true } })
const { articles, loading, load } = useArticles()

onMounted(load)

// Schlagwörter werden beim Speichern normalisiert abgelegt, aber die URL kommt vom Nutzer –
// verglichen wird deshalb ohne Rücksicht auf Groß-/Kleinschreibung.
const needle = computed(() => props.name.trim().toLowerCase())
const matches = computed(() =>
  articles.value.filter((a) => (a.tags || []).some((t) => t.toLowerCase() === needle.value)),
)

// „Kommt oft zusammen mit" – aus den Treffern selbst, ohne zweiten Request. Das ist die Frage, die
// nach der Liste kommt: ein Schlagwort allein sagt wenig, seine Nachbarn verorten es.
const neighbours = computed(() => {
  const count = new Map()
  for (const a of matches.value) {
    for (const t of a.tags || []) {
      if (t.toLowerCase() === needle.value) continue
      count.set(t, (count.get(t) || 0) + 1)
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-6 py-9 sm:px-8">
    <div class="mb-7">
      <SectionLabel class="mb-2">Tag</SectionLabel>
      <h1 class="font-mono text-3xl font-semibold tracking-tight text-ink">#{{ name }}</h1>
      <p class="mt-2 text-[0.8125rem] text-muted">
        <span class="font-mono font-semibold text-ink">{{ matches.length }}</span>
        article{{ matches.length === 1 ? '' : 's' }} carry this tag
      </p>
    </div>

    <BusyState v-if="loading" variant="panel" title="Loading articles…" detail="titles, tags and categories" :rows="3" />

    <!-- Ein Schlagwort ohne Artikel heißt fast immer: es steht so nicht im Bestand (Tippfehler im
         Link, oder der letzte Artikel damit ist weg). Das gehört gesagt, statt eine leere Liste
         zu zeigen. -->
    <EmptyState
      v-else-if="!matches.length"
      icon="lucide:tag"
      :title="`No article carries “${name}”`"
      hint="Most likely a typo in a link, or the last article with this tag is gone."
    >
      <Button to="/wiki" size="xs" icon="lucide:arrow-left">Back to the wiki</Button>
    </EmptyState>

    <template v-else>
      <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(258px, 1fr))">
        <RouterLink
          v-for="a in matches"
          :key="a.id"
          :to="`/article/${a.slug}`"
          class="group flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-4 transition hover:-translate-y-0.5 hover:border-accent"
        >
          <CategoryBadge v-if="a.category" :category="a.category" size="xs" />
          <h2 class="font-semibold leading-snug text-ink group-hover:text-accent">{{ a.title }}</h2>
          <p v-if="a.summary" class="line-clamp-2 text-xs leading-relaxed text-muted">{{ a.summary }}</p>
        </RouterLink>
      </div>

      <section v-if="neighbours.length" class="mt-10 border-t border-line pt-6">
        <SectionLabel as="h2" class="mb-3">OFTEN TOGETHER WITH</SectionLabel>
        <div class="flex flex-wrap gap-2">
          <RouterLink
            v-for="[tag, n] in neighbours"
            :key="tag"
            :to="`/tag/${encodeURIComponent(tag)}`"
            class="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-xs text-muted transition hover:border-accent hover:text-accent"
          >
            #{{ tag }}
            <span class="tabular-nums opacity-60">{{ n }}</span>
          </RouterLink>
        </div>
      </section>
    </template>
  </div>
</template>
