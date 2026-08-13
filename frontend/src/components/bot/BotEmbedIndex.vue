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
import { copyToClipboard } from '../../lib/clipboard.js'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'

// ⚠️ Der Verbindungsstand kommt als PROP, nicht aus einem eigenen Request. `BotHealthCard` holt ihn
// oben auf derselben Seite ohnehin, und der Katalog, aus dem beide Aussagen stammen, ist derselbe
// (`/api/tags`). Zweimal zu fragen waere zweimal derselbe Ollama-Aufruf für eine Karte, die
// danebensteht -- und zwei Staende, die sich für einen Moment widersprechen können.
const props = defineProps({
  /** Antwort von `GET /api/bot/health`, oder `null` solange nicht geprüft. */
  health: { type: Object, default: null },
  /** Das Modell aus dem FORMULAR – die Karte soll auch für einen noch nicht gespeicherten Wert gelten. */
  draftModel: { type: String, default: '' },
})

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

// --- Liegt das Modell überhaupt auf dem Server? ------------------------------------------------
//
// ⚠️ Die Frage gehört VOR den Knopf, nicht hinter ihn. Ohne sie ist der einzige Weg, das Fehlen zu
// bemerken, ein Lauf, der bei „0 of 2688" abbricht – und der Statuspunkt oben sagt nichts dazu, er
// prüft das Textmodell. Ein gepulltes Textmodell neben einem fehlenden Embedding-Modell ist dabei
// der Normalfall: es kommt bei keinem anderen Pull mit.

/** Das Modell, über das `health` tatsächlich eine Aussage gemacht hat. */
const checkedModel = computed(() => props.health?.embedModel || '')

// Ein geändertes, noch nicht geprüftes Feld erzeugt KEINE Aussage: sie handelte sonst von einem
// Modell, das gar nicht mehr gemeint ist. Gleiche Regel wie beim Verbindungstest darüber.
const unchecked = computed(() => !!props.draftModel && !!checkedModel.value && props.draftModel !== checkedModel.value)

// Drei Zustände, und nur einer ist eine Aussage: `false` = liegt nicht dort, `true` = alles gut,
// `null` = Katalog nicht abrufbar oder noch nicht geprüft. Aus `null` eine Warnung zu machen wäre
// eine erfundene Auskunft – dieselbe Regel wie bei `modelInstalled`.
const modelMissing = computed(
  () => !unchecked.value && props.health?.online === true && props.health?.embedModelInstalled === false,
)

const pullCommand = computed(() => `ollama pull ${checkedModel.value}`)
const copied = ref(false)

async function copyPull() {
  if (!(await copyToClipboard(pullCommand.value))) {
    push({ kind: 'error', title: 'Copy failed', message: 'Select the command and copy it by hand.' })
    return
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

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
          if (blocked) return blocked
          // Der Grund gehört auch hierher, nicht nur in den Toast: der verschwindet, die
          // Aktivitätszeile bleibt stehen. „Embedded 0 source(s)" ohne ihn ist kein Ergebnis.
          const why = r?.code?.reason || r?.wiki?.reason
          return why ? `Embedded ${n} source(s) — ${why}` : `Embedded ${n} source(s)`
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
      //
      // ⚠️ Davor steht der GRUND vom Server, nicht mehr ein Satz für jeden Fall. „Ollama stopped
      // answering" war bei einem nicht gepullten Modell und bei einem zu knappen Timeout gleich
      // falsch – und ausgerechnet beim Erst-Index scheitert der allererste Stapel, es steht also
      // „0 of 2688" da und der einzige Hinweis darauf, was zu tun ist, fehlte.
      const why = res?.code?.reason || res?.wiki?.reason || 'Ollama stopped answering'
      push({
        kind: 'warning',
        title: `${done} of ${done + failed} sources embedded`,
        message: `${why} — the rest stays for the next run.`,
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
  <div class="rounded-lg border border-line bg-surface-2 p-4">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Icon icon="lucide:sparkles" class="h-4 w-4 shrink-0 text-accent" />
      <h3 class="text-sm font-semibold text-ink">Meaning index</h3>
      <span class="text-2xs text-muted">
        Lets search and Ask find a class or an article by what it means, not by the words in it.
      </span>
    </div>

    <template v-if="known">
      <!-- Der Zustand hat drei Fälle, und sie bedeuten Verschiedenes: kein Modell (nichts
           möglich), leerer Index (nichts gebaut), teilweise (nutzbar, aber unvollständig). -->
      <p v-if="!enabled" class="mt-2 text-2xs text-warning">
        No embedding model set above — meaning-based search is off.
      </p>
      <template v-else>
        <div class="mt-3 flex items-center gap-3">
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-offset">
            <span
              class="block h-full rounded-full bg-accent transition-[width]"
              :style="{ width: `${percent}%` }"
            />
          </span>
          <span class="shrink-0 font-mono text-2xs text-muted">
            {{ indexed }}/{{ total }}
          </span>
        </div>

        <!-- ⚠️ Woher die Summe kommt. Ohne diese zwei Zeilen sagt „40/52" nicht, ob die Artikel
             fehlen oder die Klassen – und genau das entscheidet, was Ask gerade nicht beantworten
             kann. -->
        <dl class="mt-2 space-y-1">
          <div v-for="r in rows" :key="r.key" class="flex items-center gap-2 font-mono text-3xs text-muted">
            <Icon :icon="r.icon" class="h-3 w-3 shrink-0 opacity-70" />
            <dt class="w-14 shrink-0 font-sans">{{ r.label }}</dt>
            <dd class="tabular-nums">{{ r.s?.indexed ?? 0 }}/{{ r.s?.total ?? 0 }}</dd>
            <dd v-if="r.s?.stale" class="text-warning">{{ r.s.stale }} out of date</dd>
            <dd v-if="r.s?.missing">{{ r.s.missing }} never indexed</dd>
          </div>
        </dl>
        <p class="mt-1.5 font-mono text-3xs text-muted">model {{ model }}</p>

        <!-- ⚠️ Der Befund steht VOR dem Knopf und nennt den fertigen Befehl. „Model not installed"
             allein ist ein Befund, den man erst noch übersetzen muss – und die Übersetzung ist
             immer dieselbe Zeile. Der Knopf bleibt trotzdem bedienbar: der Katalog kann
             unvollständig sein, und ein gesperrter Knopf bei einer Fehlvermutung wäre schlimmer
             als ein Lauf, der mit einer klaren Meldung endet. -->
        <div
          v-if="modelMissing"
          class="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2.5"
        >
          <p class="flex items-start gap-1.5 text-2xs text-warning">
            <Icon icon="lucide:alert-triangle" class="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              <strong class="font-semibold">{{ checkedModel }}</strong> is not pulled on
              {{ props.health?.host }} — indexing will stop at the first batch. It does not come with
              any other model.
            </span>
          </p>
          <div class="mt-2 flex items-center gap-2">
            <code
              class="min-w-0 flex-1 overflow-x-auto rounded bg-surface-offset px-2 py-1 font-mono text-3xs text-ink"
            >{{ pullCommand }}</code>
            <button
              v-tip="{ title: 'Copy the command', hint: 'Run it on the machine Ollama runs on, not inside the Wikit container.' }"
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-3xs font-medium text-muted transition hover:border-line-strong hover:text-ink"
              @click="copyPull"
            >
              <Icon :icon="copied ? 'lucide:check' : 'lucide:copy'" class="h-3 w-3" />
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>
      </template>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          v-tip="todo
            ? { title: `Embed ${todo} source(s)`, hint: 'Only what is missing or out of date — unchanged classes and articles keep their vector.' }
            : { title: 'Everything is indexed', hint: 'Nothing changed since the last run.' }"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-40"
          :disabled="busy || !enabled || !todo"
          @click="build(false)"
        >
          <Icon :icon="busy ? 'lucide:loader-2' : 'lucide:sparkles'" class="h-3.5 w-3.5" :class="busy ? 'animate-spin' : ''" />
          {{ todo ? `Index ${todo} source${todo === 1 ? '' : 's'}` : 'Up to date' }}
        </button>
        <button
          v-tip="{ title: 'Rebuild everything', hint: 'Needed after switching models — old vectors are not comparable to new ones, and both indexes must share one model.' }"
          type="button"
          class="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:border-line-strong hover:text-ink disabled:opacity-40"
          :disabled="busy || !enabled || !total"
          @click="build(true)"
        >
          Rebuild all
        </button>
        <button
          v-if="indexed || todo"
          type="button"
          class="ml-auto text-2xs text-muted underline-offset-2 transition hover:text-danger hover:underline"
          :disabled="busy"
          @click="clear"
        >
          Delete index
        </button>
      </div>
    </template>

    <p v-else-if="loading" class="mt-2 text-2xs text-muted">Checking the index…</p>
    <p v-else class="mt-2 text-2xs text-muted">Index status unavailable.</p>
  </div>
</template>
