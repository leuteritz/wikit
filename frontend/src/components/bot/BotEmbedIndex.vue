<script setup>
// Der Bedeutungsindex: Stand und Aufbau, direkt unter dem Feld, das sein Modell wählt.
//
// Warum hier und nicht in der Code-Ansicht: der Index ist eine EIGENSCHAFT des Modells, nicht des
// Codes. Wer das Modell wechselt, macht jeden Vektor ungültig – und diese Folge gehört an die
// Stelle, an der man wechselt, nicht in eine andere Ansicht.
//
// Der Lauf hängt an keinem Dialog: er läuft im Server weiter, wenn man wegnavigiert (dieselbe
// Bauart wie Import und Kantenberechnung, s. useActivity).
import { computed, onMounted, ref } from 'vue'
import { api } from '../../lib/api.js'
import { useActivity } from '../../composables/useActivity.js'
import { useNotifications } from '../../composables/useNotifications.js'
import { useEmbeddings } from '../../composables/useEmbeddings.js'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'

const { trackRun } = useActivity()
const { push } = useNotifications()

// Geteilter Store: dieselbe Zahl steht in der Sidebar neben „Ask". Ein eigenes ref hier hiesse,
// dass die Sidebar nach einem Indexlauf noch den alten Stand zeigt.
const { status, loading, load: refresh } = useEmbeddings()
const busy = ref(false)

onMounted(refresh)

// Was zu tun ist – als eine Zahl. „1250 indexed, 30 stale, 5 missing" ist eine Bilanz; „35 to do"
// ist die Antwort auf die Frage, warum der Knopf da ist.
const todo = computed(() => (status.value ? status.value.stale + status.value.missing : 0))
const percent = computed(() => {
  const s = status.value
  if (!s?.total) return 0
  return Math.round((s.indexed / s.total) * 100)
})

async function build(force = false) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await trackRun('embed', (jobId) => api.rebuildJavaEmbeddings(jobId, force), {
      summarize: (r) => (r?.started ? `Embedded ${r.indexed ?? 0} class(es)` : r?.reason || 'Nothing to do'),
    })
    if (res?.started === false) {
      push({ kind: 'warning', title: 'Index not built', message: res.reason })
    } else if (res?.failed) {
      // Abgebrochen heisst nicht „nichts passiert": was geschrieben wurde, bleibt gültig, und der
      // nächste Lauf macht dort weiter. Genau das muss dastehen, sonst startet man von vorn.
      push({
        kind: 'warning',
        title: `${res.indexed} of ${res.indexed + res.failed} classes embedded`,
        message: 'Ollama stopped answering — the rest stays for the next run.',
      })
    }
    await refresh()
  } catch (e) {
    push({ kind: 'error', title: 'Index failed', message: e.message })
  } finally {
    busy.value = false
  }
}

async function clear() {
  if (!confirm('Delete every stored vector? Meaning-based search stops working until the index is rebuilt.')) return
  await api.clearJavaEmbeddings()
  await refresh()
}
</script>

<template>
  <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
      <h3 class="text-sm font-semibold text-[var(--color-text)]">Meaning index</h3>
      <span class="text-2xs text-[var(--color-text-muted)]">
        Lets search find a class by what it does, not by the words in it.
      </span>
    </div>

    <template v-if="status">
      <!-- Der Zustand hat drei Fälle, und sie bedeuten Verschiedenes: kein Modell (nichts
           möglich), leerer Index (nichts gebaut), teilweise (nutzbar, aber unvollständig). -->
      <p v-if="!status.enabled" class="mt-2 text-2xs text-[var(--color-warning)]">
        No embedding model set above — meaning-based search is off.
      </p>
      <template v-else>
        <div class="mt-3 flex items-center gap-3">
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
            <span
              class="block h-full rounded-full bg-[var(--color-accent)] transition-[width]"
              :style="{ width: `${percent}%` }"
            />
          </span>
          <span class="shrink-0 font-mono text-2xs text-[var(--color-text-muted)]">
            {{ status.indexed }}/{{ status.total }}
          </span>
        </div>
        <p class="mt-1.5 font-mono text-3xs text-[var(--color-text-muted)]">
          <span v-if="status.stale">{{ status.stale }} out of date · </span>
          <span v-if="status.missing">{{ status.missing }} never indexed · </span>
          model {{ status.model }}
        </p>
      </template>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          v-tip="todo
            ? { title: `Embed ${todo} class(es)`, hint: 'Only what is missing or out of date — unchanged classes keep their vector.' }
            : { title: 'Everything is indexed', hint: 'Nothing changed since the last run.' }"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          :disabled="busy || !status.enabled || !todo"
          @click="build(false)"
        >
          <Icon :icon="busy ? 'lucide:loader-2' : 'lucide:sparkles'" class="h-3.5 w-3.5" :class="busy ? 'animate-spin' : ''" />
          {{ todo ? `Index ${todo} class${todo === 1 ? '' : 'es'}` : 'Up to date' }}
        </button>
        <button
          v-tip="{ title: 'Rebuild everything', hint: 'Needed after switching models — old vectors are not comparable to new ones.' }"
          type="button"
          class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-40"
          :disabled="busy || !status.enabled || !status.total"
          @click="build(true)"
        >
          Rebuild all
        </button>
        <button
          v-if="status.indexed || status.stale"
          type="button"
          class="ml-auto text-2xs text-[var(--color-text-muted)] underline-offset-2 transition hover:text-[var(--color-danger)] hover:underline"
          :disabled="busy"
          @click="clear"
        >
          Delete index
        </button>
      </div>
    </template>

    <p v-else-if="loading" class="mt-2 text-2xs text-[var(--color-text-muted)]">Checking the index…</p>
    <p v-else class="mt-2 text-2xs text-[var(--color-text-muted)]">Index status unavailable.</p>
  </div>
</template>
