<script setup>
// „Womit hängt dieser Artikel zusammen?" – beantwortet aus dem Artikel-Bedeutungsindex, der für
// `/ask` ohnehin gebaut wird.
//
// ⚠️ **Warum das kein zweites „Relations" ist.** Der Abschnitt darüber zeigt, was jemand von Hand
// eingetragen hat – eine Aussage. Dieser hier zeigt, was sich ÄHNELT – eine Vermutung, und deshalb
// steht an jeder Zeile ihr Wert und ein Knopf statt eines Links als Hauptgeste. Beides in eine
// Liste zu legen hiesse, eine getroffene Entscheidung und einen Vorschlag gleich aussehen zu lassen.
//
// ⚠️ **Ohne Vorschläge erscheint der Abschnitt gar nicht** – auch nicht als „nothing found" und
// erst recht nicht als „no embedding model". Die Bedeutungssuche ist optional; eine graue Meldung
// unter JEDEM Artikel wäre ein Daueralarm über einen bewusst gewählten Zustand (dieselbe Regel wie
// bei der Ask-Zahl in der Sidebar, die sich nicht färbt). Wo der Index steht und was ihm fehlt,
// sagt die Karte in `/bot` – dort löst man es auch aus.
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../lib/api.js'
import { Icon } from '../lib/icons.js'

const props = defineProps({
  article: { type: Object, required: true },
})
// Eine neue Beziehung gehört in den Abschnitt darüber – die Seite darf nicht zwei Stände zeigen.
const emit = defineEmits(['linked'])

const items = ref([])
// Vorschlag-Id -> { relationId } bzw. 'busy'. Der Vorschlag verschwindet nach dem Klick NICHT:
// er ist die Stelle, an der man die Handlung zurücknimmt.
const linked = ref({})

async function load(id) {
  items.value = []
  linked.value = {}
  if (!id) return
  try {
    const res = await api.getRelatedArticles(id)
    items.value = res?.items || []
  } catch {
    // Still: der Abschnitt entfällt dann einfach (s. Kopf).
    items.value = []
  }
}

watch(() => props.article?.id, load, { immediate: true })

async function link(item) {
  if (linked.value[item.id]) return
  linked.value = { ...linked.value, [item.id]: 'busy' }
  try {
    // Richtung: von dem Artikel, den man liest, zum Vorschlag. Eine Bedeutungsähnlichkeit hat
    // keine Richtung, die Geste schon – „von hier führt es dorthin".
    const rel = await api.createRelation({
      source_id: props.article.id,
      target_id: item.id,
      relation_type: 'related',
    })
    linked.value = { ...linked.value, [item.id]: { relationId: rel?.id ?? null } }
    emit('linked')
  } catch {
    const next = { ...linked.value }
    delete next[item.id]
    linked.value = next
  }
}

async function undo(item) {
  const state = linked.value[item.id]
  if (!state || state === 'busy' || !state.relationId) return
  linked.value = { ...linked.value, [item.id]: 'busy' }
  try {
    await api.deleteRelation(state.relationId)
    const next = { ...linked.value }
    delete next[item.id]
    linked.value = next
    emit('linked')
  } catch {
    linked.value = { ...linked.value, [item.id]: state }
  }
}
</script>

<template>
  <section v-if="items.length" class="mt-8 border-t border-line pt-6">
    <h2 class="mb-1 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted">
      Suggested links
    </h2>
    <!-- Ein Satz sagt, woher die Liste kommt. Ohne ihn liest sie sich wie eine gepflegte
         Beziehung, und der Nutzer wüsste nicht, dass er hier entscheidet. -->
    <p class="mb-4 text-xs text-muted">
      Not linked yet, but close in meaning — the number is how close.
    </p>

    <ul class="grid gap-2 sm:grid-cols-2">
      <li
        v-for="item in items"
        :key="item.id"
        class="ra-row"
        :class="linked[item.id] && linked[item.id] !== 'busy' ? 'ra-row--linked' : ''"
      >
        <RouterLink
          :to="`/article/${item.slug}`"
          class="ra-link"
          :title="item.category ? `In ${item.category}` : 'Uncategorized'"
        >
          <span class="truncate">{{ item.title }}</span>
          <!-- Der Chip sagt, woher der Artikel kommt: ein exportierter Klassenartikel ist eine
               andere Sorte Nachbar als eine Notiz, und ohne die Marke sähe er wie eine aus. -->
          <span v-if="item.is_class" class="ra-chip">class</span>
        </RouterLink>

        <span class="ra-score" v-tip="'Cosine similarity of the two articles — 1.00 would be the same text.'">
          {{ item.score.toFixed(2) }}
        </span>

        <button
          v-if="!linked[item.id]"
          type="button"
          class="ra-btn"
          v-tip="{ title: 'Link these two', hint: 'Creates a “related” relation from this article to that one. It shows up under Relations and in the graph.' }"
          @click="link(item)"
        >
          <Icon icon="lucide:link" class="h-3.5 w-3.5" />
          Link
        </button>
        <button
          v-else
          type="button"
          class="ra-btn ra-btn--done"
          :disabled="linked[item.id] === 'busy'"
          v-tip="'Remove the relation again.'"
          @click="undo(item)"
        >
          <Icon icon="lucide:check" class="h-3.5 w-3.5" />
          Linked
          <span class="ra-undo">undo</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
@reference "../assets/style.css";

.ra-row {
  @apply flex items-center gap-2 rounded-xl border border-line bg-surface-2 py-2 pl-3 pr-2 transition;
}
.ra-row:hover {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
}
/* Verknüpft: derselbe Erfolgston wie sonst, aber nur am Rahmen – die Zeile bleibt eine Zeile,
   sie hat nur ihren Zustand gewechselt. */
.ra-row--linked {
  border-color: color-mix(in srgb, var(--color-success) 55%, var(--color-border));
}

.ra-link {
  @apply flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-ink transition;
}
.ra-link:hover {
  color: var(--color-accent);
}

.ra-chip {
  @apply shrink-0 rounded bg-surface-offset px-1.5 py-0.5 font-mono text-3xs font-medium uppercase tracking-wide text-muted;
}

.ra-score {
  @apply shrink-0 cursor-default font-mono text-2xs tabular-nums text-muted;
}

.ra-btn {
  @apply inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-2xs font-medium text-muted transition;
}
.ra-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.ra-btn--done {
  border-color: transparent;
  color: var(--color-success);
}
.ra-btn--done:hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}
.ra-btn:disabled {
  @apply cursor-default opacity-50;
}

/* „undo" erscheint erst beim Draufzeigen: der Normalfall ist, dass die Verknüpfung bleibt. Es
   steht gedämpft daneben – es benennt die Handlung, das „Linked" davor ist die Aussage. */
.ra-undo {
  @apply hidden;
}
.ra-btn--done:hover .ra-undo {
  @apply inline opacity-70;
}
</style>
