<script setup>
// Der Bedeutungsindex: Stand und Aufbau, direkt unter dem Feld, das sein Modell wählt.
//
// Warum hier und nicht in der Code-Ansicht: der Index ist eine EIGENSCHAFT des Modells, nicht des
// Codes. Wer das Modell wechselt, macht jeden Vektor ungültig – und diese Folge gehört an die
// Stelle, an der man wechselt, nicht in eine andere Ansicht.
//
// ⚠️ **Eine Karte, zwei Bestände.** Klassen und Wiki-Artikel liegen in getrennten Tabellen, aber
// sie beantworten dieselbe Frage („worauf kann Ask antworten?") und müssen dasselbe Modell
// benutzen – ihre Treffer landen in einer Rangliste. Zwei Karten wären zwei Knöpfe für einen Lauf,
// den man ohnehin nie halb machen will. Die Aufteilung steht deshalb als zwei Zeilen unter EINEM
// Balken: die Bilanz oben, die Herkunft darunter.
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
const { java, articles, known, indexed, total, todo, enabled, model, loading, load: refresh } = useEmbeddings()
const busy = ref(false)

onMounted(refresh)

const percent = computed(() => (total.value ? Math.round((indexed.value / total.value) * 100) : 0))

// Die beiden Zeilen unter dem Balken. Eine Seite ohne Bestand steht trotzdem da – „0/0" sagt
// „zählt hier mit, du hast nur keine", und das ist die Auskunft, die eine fehlende Zeile schuldig
// bliebe.
const rows = computed(() => [
  { key: 'code', label: 'Classes', icon: 'lucide:file-code', s: java.value },
  { key: 'wiki', label: 'Articles', icon: 'lucide:book-open', s: articles.value },
])

async function build(force = false) {
  if (busy.value) return
  busy.value = true
  try {
    // EIN Lauf über beide Bestände. Die Klassen laufen mit Fortschritt (SSE über die jobId), die
    // Artikel hängen hinten dran – sie sind Dutzende, keine Tausende, und ein zweiter Balken für
    // zwei Sekunden wäre mehr Anzeige als Vorgang.
    const res = await trackRun(
      'embed',
      async (jobId) => {
        const code = await api.rebuildJavaEmbeddings(jobId, force)
        const wiki = await api.rebuildArticleEmbeddings(force)
        return { code, wiki }
      },
      {
        summarize: (r) => {
          const n = (r?.code?.indexed ?? 0) + (r?.wiki?.indexed ?? 0)
          const blocked = r?.code?.started === false ? r.code.reason : r?.wiki?.started === false ? r.wiki.reason : null
          return blocked || `Embedded ${n} source(s)`
        },
      },
    )

    const blocked = res?.code?.started === false ? res.code.reason : res?.wiki?.started === false ? res.wiki.reason : null
    const failed = (res?.code?.failed ?? 0) + (res?.wiki?.failed ?? 0)
    const done = (res?.code?.indexed ?? 0) + (res?.wiki?.indexed ?? 0)
    if (blocked) {
      push({ kind: 'warning', title: 'Index not built', message: blocked })
    } else if (failed) {
      // Abgebrochen heisst nicht „nichts passiert": was geschrieben wurde, bleibt gültig, und der
      // nächste Lauf macht dort weiter. Genau das muss dastehen, sonst startet man von vorn.
      push({
        kind: 'warning',
        title: `${done} of ${done + failed} sources embedded`,
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
  if (!confirm('Delete every stored vector, for classes and articles alike? Meaning-based search and Ask stop working until the index is rebuilt.')) return
  // Beide – ein halb gelöschter Index wäre ein Zustand, den kein Knopf wieder herstellt.
  await api.clearJavaEmbeddings()
  await api.clearArticleEmbeddings()
  await refresh()
}
</script>

<template>
  <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
      <h3 class="text-sm font-semibold text-[var(--color-text)]">Meaning index</h3>
      <span class="text-2xs text-[var(--color-text-muted)]">
        Lets search and Ask find a class or an article by what it means, not by the words in it.
      </span>
    </div>

    <template v-if="known">
      <!-- Der Zustand hat drei Fälle, und sie bedeuten Verschiedenes: kein Modell (nichts
           möglich), leerer Index (nichts gebaut), teilweise (nutzbar, aber unvollständig). -->
      <p v-if="!enabled" class="mt-2 text-2xs text-[var(--color-warning)]">
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
            {{ indexed }}/{{ total }}
          </span>
        </div>

        <!-- ⚠️ Woher die Summe kommt. Ohne diese zwei Zeilen sagt „40/52" nicht, ob die Artikel
             fehlen oder die Klassen – und genau das entscheidet, was Ask gerade nicht beantworten
             kann. -->
        <dl class="mt-2 space-y-1">
          <div v-for="r in rows" :key="r.key" class="flex items-center gap-2 font-mono text-3xs text-[var(--color-text-muted)]">
            <Icon :icon="r.icon" class="h-3 w-3 shrink-0 opacity-70" />
            <dt class="w-14 shrink-0 font-sans">{{ r.label }}</dt>
            <dd class="tabular-nums">{{ r.s?.indexed ?? 0 }}/{{ r.s?.total ?? 0 }}</dd>
            <dd v-if="r.s?.stale" class="text-[var(--color-warning)]">{{ r.s.stale }} out of date</dd>
            <dd v-if="r.s?.missing">{{ r.s.missing }} never indexed</dd>
          </div>
        </dl>
        <p class="mt-1.5 font-mono text-3xs text-[var(--color-text-muted)]">model {{ model }}</p>
      </template>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          v-tip="todo
            ? { title: `Embed ${todo} source(s)`, hint: 'Only what is missing or out of date — unchanged classes and articles keep their vector.' }
            : { title: 'Everything is indexed', hint: 'Nothing changed since the last run.' }"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          :disabled="busy || !enabled || !todo"
          @click="build(false)"
        >
          <Icon :icon="busy ? 'lucide:loader-2' : 'lucide:sparkles'" class="h-3.5 w-3.5" :class="busy ? 'animate-spin' : ''" />
          {{ todo ? `Index ${todo} source${todo === 1 ? '' : 's'}` : 'Up to date' }}
        </button>
        <button
          v-tip="{ title: 'Rebuild everything', hint: 'Needed after switching models — old vectors are not comparable to new ones, and both indexes must share one model.' }"
          type="button"
          class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-40"
          :disabled="busy || !enabled || !total"
          @click="build(true)"
        >
          Rebuild all
        </button>
        <button
          v-if="indexed || todo"
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
