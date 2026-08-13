<script setup>
// Was man dem Wiki nicht ansieht – dritter Modus von `/wiki`, neben Liste und Beziehungsnetz.
//
// Die drei Modi sind drei Fragen an denselben Bestand: die Liste sagt „was gibt es?", der Graph
// „was haengt woran?", und hier steht „woran muss ich ran?". Deshalb ist es kein eigener
// Sidebar-Eintrag: es ist derselbe Bestand und dieselbe Ansicht, nur eine andere Frage – und eine
// zweite Befund-Zahl neben der von `/insights` waeren zwei Zahlen, die man verwechselt.
//
// ⚠️ **Verwaiste Artikel stehen hier NICHT**, obwohl sie der bekannteste Wiki-Befund sind: das
// Beziehungsnetz zaehlt sie bereits und bietet dort auch die Handlung an (Link-Vorschlaege als
// Kanten). Zweimal gezaehlt waeren es ueber kurz oder lang zwei verschiedene Zahlen. Die Zeile
// unter der Bilanz sagt stattdessen, wo sie stehen – und schaltet dorthin.
//
// ⚠️ Die Erklaerungen folgen der Regel aus `/insights`: Kernaussage GROSS in einem Satz, darunter
// EIN Satz, der sie erklaert. Wer nur die grosse Zeile liest, hat den Abschnitt verstanden.
// Geschrieben fuer jemanden, der sein Wiki kennt, aber keine Lust auf Werkzeugbegriffe hat.
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '../lib/api.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import BusyState from './BusyState.vue'
import { Icon } from '../lib/icons.js'
import { vTip } from '../lib/tooltip.js'
import { formatRelative } from '../lib/format.js'

const emit = defineEmits(['show-graph'])

const router = useRouter()
const { lastFileId } = useJavaAnalyzer()

const data = ref(null)
const loading = ref(false)
const error = ref('')
const startedAt = ref(Date.now())
// Aufgeklappt ist immer nur EINE Zeile – gleiche Bauart wie der Aufteilungsvorschlag in
// `/insights`: die Aenderungsnotizen sind mehrere Absaetze, und drei davon uebereinander sind
// wieder die Wand aus Text, gegen die der Bericht antritt.
const openId = ref(null)

async function load() {
  loading.value = true
  startedAt.value = Date.now()
  error.value = ''
  try {
    data.value = await api.getWikiHealth()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const totals = computed(() => data.value?.totals || null)
const clean = computed(() => !!totals.value && totals.value.findings === 0)

// Derselbe Hand-off, den `/insights` und die globale Suche benutzen: Ziel setzen, Route wechseln.
// Ohne mitgegebene Suche schlaegt `CodeView` das Ego der Klasse auf.
function openClass(fileId) {
  lastFileId.value = fileId
  router.push('/code')
}

function toggle(id) {
  openId.value = openId.value === id ? null : id
}

/** „3 more" statt eines stillen Deckels – was nicht dasteht, wird gezaehlt. */
function hidden(group) {
  if (!group) return 0
  return Math.max(0, (group.total || 0) - (group.items?.length || 0))
}

// Die Aehnlichkeit als Prozentzahl: der rohe Kosinus ist eine Zahl aus einem Vektorraum, und wer
// sie zum ersten Mal sieht, kann 0,83 nicht einordnen. Als „83 % alike" ist sie wenigstens eine
// Groessenordnung – was „aehnlich genug" heisst, entscheidet ohnehin der Bestand (s. Backend).
function alike(score) {
  return `${Math.round(score * 100)}% alike`
}

// Welche Felder dieses Wiki ueberhaupt fuehrt – die Ansicht sagt es, weil sonst unerklaerlich
// bleibt, warum „ohne Tags" hier auftaucht und dort nicht.
const usedFields = computed(() => {
  const f = data.value?.fields
  if (!f) return []
  return ['summary', 'tags', 'category'].filter((k) => f[k])
})
</script>

<template>
  <div class="flex flex-col gap-7">
    <BusyState
      v-if="loading && !data"
      variant="panel"
      title="Checking the wiki…"
      detail="links, class articles, similar pairs"
      :since="startedAt"
      :rows="4"
    />

    <p v-else-if="error" class="notice-warning rounded-lg px-4 py-3 text-sm">{{ error }}</p>

    <template v-else-if="data">
      <!-- Bilanz. Bei 0 Befunden steht hier die gute Nachricht und keine Reihe von Nullen:
           „nichts zu tun" ist ein Ergebnis und verdient einen Satz. -->
      <section
        class="rounded-xl border border-line bg-surface-2 px-5 py-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <Icon
              :icon="clean ? 'lucide:check-circle' : 'lucide:activity'"
              class="h-5 w-5 shrink-0"
              :class="clean ? 'text-success' : 'text-accent'"
            />
            <div>
              <p class="text-base font-semibold text-ink">
                {{ clean ? 'Nothing to fix' : `${totals.findings} ${totals.findings === 1 ? 'finding' : 'findings'}` }}
              </p>
              <p class="mt-0.5 text-xs text-muted">
                Checked
                <span class="font-mono font-semibold text-ink">{{ totals.articles }}</span>
                {{ totals.articles === 1 ? 'article' : 'articles' }} — nothing left this machine.
              </p>
            </div>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-mono text-3xs font-semibold text-muted transition hover:text-ink"
            :disabled="loading"
            @click="load"
          >
            <Icon icon="lucide:refresh-cw" class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
            Re-check
          </button>
        </div>

        <!-- ⚠️ Der bekannteste Wiki-Befund steht bewusst woanders – und das gehoert dazugesagt,
             sonst liest sich seine Abwesenheit als „gibt es hier nicht". -->
        <p
          class="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-xs text-muted"
        >
          <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
          Articles nothing links to are a finding of the relation graph, counted there.
          <button
            type="button"
            class="inline-flex items-center gap-1 font-semibold text-accent transition hover:underline"
            @click="emit('show-graph')"
          >
            Open the graph
            <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5" />
          </button>
        </p>
      </section>

      <!-- 1. Veraltete Klassenartikel — der einzige Befund, den sonst niemand finden kann -->
      <section>
        <header class="mb-3">
          <h2 class="flex items-center gap-2.5">
            <Icon icon="lucide:clock" class="h-4.5 w-4.5 shrink-0 text-muted" />
            <span class="text-xl font-semibold tracking-tight text-ink">
              Articles that describe code that moved on
            </span>
            <span
              v-if="data.outdated.total"
              class="count-badge"
            >{{ data.outdated.total }}</span>
          </h2>
          <p class="mt-1.5 text-[0.8125rem] text-muted">
            The class was uploaded again after the article was last touched — so what it says about
            it is at least one version behind.
          </p>
        </header>

        <p
          v-if="!data.outdated.total"
          class="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-4 text-[0.8125rem] text-muted"
        >
          <Icon icon="lucide:check" class="h-4 w-4 text-success" />
          Every class article is as new as its class.
        </p>

        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="a in data.outdated.items"
            :key="a.id"
            class="overflow-hidden rounded-lg border border-line bg-surface-2"
          >
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <button
                type="button"
                class="shrink-0 text-muted transition hover:text-ink"
                :aria-expanded="openId === a.id"
                :title="openId === a.id ? 'Hide what changed' : 'Show what changed'"
                @click="toggle(a.id)"
              >
                <Icon
                  :icon="openId === a.id ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                  class="h-4 w-4"
                />
              </button>
              <RouterLink
                :to="`/article/${a.slug}`"
                class="text-sm font-semibold text-ink transition hover:text-accent"
              >{{ a.title }}</RouterLink>
              <span
                class="count-badge"
              >{{ a.behind }} {{ a.behind === 1 ? 'version' : 'versions' }} behind</span>
              <span class="flex-1" />
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 font-mono text-3xs text-muted transition hover:border-accent hover:text-accent"
                v-tip="a.class.package ? `${a.class.package}.${a.class.name}` : a.class.name"
                @click="openClass(a.class.fileId)"
              >
                <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                {{ a.class.name }}
              </button>
              <span class="font-mono text-3xs text-muted">
                changed {{ formatRelative(a.latestAt) }}
              </span>
            </div>

            <!-- Was sich geaendert hat – die KI-Zusammenfassung, die der Re-Import ohnehin
                 erzeugt hat. Der Befund endet damit nicht bei „veraltet", sondern bei
                 „das steht jetzt anders drin". -->
            <div
              v-if="openId === a.id"
              class="border-t border-line bg-surface px-4 py-3"
            >
              <div v-for="n in a.notes" :key="n.version" class="mb-3 last:mb-0">
                <p class="mb-1 font-mono text-3xs font-semibold uppercase tracking-[0.12em] text-muted">
                  Version {{ n.version }} · {{ formatRelative(n.at) }}
                </p>
                <blockquote
                  v-if="n.summaryHtml"
                  class="prose prose-sm max-w-none border-l-2 border-accent pl-3 dark:prose-invert"
                  v-html="n.summaryHtml"
                />
                <p v-else class="text-xs italic text-muted">
                  No change summary — Ollama was not available when this version arrived.
                </p>
              </div>
              <p
                v-if="a.notesTotal > a.notes.length"
                class="font-mono text-3xs text-muted"
              >
                + {{ a.notesTotal - a.notes.length }} older
                {{ a.notesTotal - a.notes.length === 1 ? 'change' : 'changes' }} — the full history is
                on the class.
              </p>
            </div>
          </li>
        </ul>

        <p v-if="hidden(data.outdated)" class="mt-2 font-mono text-3xs text-muted">
          + {{ hidden(data.outdated) }} more, not shown.
        </p>
        <!-- ⚠️ Die Grenze der Auskunft steht unter der Liste, nicht in einem Tooltip: ohne sie liest
             sich ein leerer Abschnitt als Garantie. -->
        <p v-if="data.outdated.total" class="mt-2 text-xs leading-relaxed text-muted">
          Compared by date, not by meaning: if you edited the article after the class came in — even
          just a typo — it counts as current here.
        </p>
      </section>

      <!-- 2. Tote interne Links -->
      <section>
        <header class="mb-3">
          <h2 class="flex items-center gap-2.5">
            <Icon icon="lucide:unlink" class="h-4.5 w-4.5 shrink-0 text-muted" />
            <span class="text-xl font-semibold tracking-tight text-ink">
              Links that go nowhere
            </span>
            <span
              v-if="data.broken.total"
              class="count-badge"
            >{{ data.broken.total }}</span>
          </h2>
          <p class="mt-1.5 text-[0.8125rem] text-muted">
            A link inside the text is just characters — it survives renaming the article it points
            at, and deleting it, without a word.
          </p>
        </header>

        <p
          v-if="!data.broken.total"
          class="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-4 text-[0.8125rem] text-muted"
        >
          <Icon icon="lucide:check" class="h-4 w-4 text-success" />
          Every link between your articles lands somewhere.
        </p>

        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="a in data.broken.items"
            :key="a.id"
            class="rounded-lg border border-line bg-surface-2 px-4 py-3"
          >
            <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <RouterLink
                :to="`/article/${a.slug}`"
                class="text-sm font-semibold text-ink transition hover:text-accent"
              >{{ a.title }}</RouterLink>
              <RouterLink
                :to="`/edit/${a.slug}`"
                class="inline-flex items-center gap-1 font-mono text-3xs text-muted transition hover:text-accent"
              >
                <Icon icon="lucide:pencil" class="h-3 w-3" />
                fix
              </RouterLink>
            </div>
            <ul class="flex flex-wrap gap-1.5">
              <!-- Zwei Formen desselben Befunds – und zwei verschiedene Handgriffe: bei einem
                   Wikilink korrigiert man die doppelte Klammer (oder legt den Artikel an), bei
                   einem Markdown-Link die URL. Deshalb steht die Form an der Zeile. -->
              <li
                v-for="(l, i) in a.links"
                :key="i"
                class="inline-flex items-center gap-1.5 rounded border border-dashed border-line px-2 py-1 font-mono text-3xs text-muted"
                v-tip="l.kind === 'wikilink'
                  ? `[[${l.slug}]] — no article with this slug`
                  : `“${l.label || l.slug}” points at ${l.href}`"
              >
                <Icon icon="lucide:unlink" class="h-3 w-3" />
                <span v-if="l.kind === 'wikilink'" class="opacity-60">[[</span>{{ l.slug || l.href }}<span v-if="l.kind === 'wikilink'" class="opacity-60">]]</span>
              </li>
            </ul>
          </li>
        </ul>

        <p v-if="hidden(data.broken)" class="mt-2 font-mono text-3xs text-muted">
          + {{ hidden(data.broken) }} more, not shown.
        </p>
        <p class="mt-2 text-xs leading-relaxed text-muted">
          Only links between articles are checked. An external link can be dead too — but finding
          that out means going online, and Wikit never does.
        </p>
      </section>

      <!-- 3. Beinah-Duplikate — derselbe Bedeutungsindex, der die Link-Vorschlaege traegt -->
      <section>
        <header class="mb-3">
          <h2 class="flex items-center gap-2.5">
            <Icon icon="lucide:copy" class="h-4.5 w-4.5 shrink-0 text-muted" />
            <span class="text-xl font-semibold tracking-tight text-ink">
              Two articles, one subject
            </span>
            <span
              v-if="data.duplicates.total"
              class="count-badge"
            >{{ data.duplicates.total }}</span>
          </h2>
          <p class="mt-1.5 text-[0.8125rem] text-muted">
            Pairs that are far more alike than any two articles here usually are — you probably
            wrote the same thing twice, months apart.
          </p>
        </header>

        <!-- Eine leere Antwort ist ein GRUND, keine Auskunft ueber das Wiki – gleiche Regel wie
             bei `/ask`. Ohne Modell, ohne Index oder mit zu wenigen Artikeln steht hier, was
             fehlt, und nicht „nichts gefunden". -->
        <p
          v-if="data.duplicates.reason"
          class="flex items-start gap-2 rounded-lg border border-dashed border-line px-4 py-4 text-[0.8125rem] text-muted"
        >
          <Icon icon="lucide:info" class="mt-0.5 h-4 w-4 shrink-0" />
          {{ data.duplicates.reason }}.
        </p>
        <p
          v-else-if="!data.duplicates.total"
          class="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-4 text-[0.8125rem] text-muted"
        >
          <Icon icon="lucide:check" class="h-4 w-4 text-success" />
          No two articles stand out as saying the same thing.
        </p>

        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(p, i) in data.duplicates.items"
            :key="i"
            class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-2 px-4 py-3"
          >
            <RouterLink
              :to="`/article/${p.a.slug}`"
              class="text-sm font-semibold text-ink transition hover:text-accent"
            >{{ p.a.title }}</RouterLink>
            <Icon icon="lucide:arrow-left-right" class="h-3.5 w-3.5 shrink-0 text-muted" />
            <RouterLink
              :to="`/article/${p.b.slug}`"
              class="text-sm font-semibold text-ink transition hover:text-accent"
            >{{ p.b.title }}</RouterLink>
            <span class="flex-1" />
            <span
              v-if="p.linked"
              class="rounded border border-line px-1.5 py-0.5 font-mono text-3xs text-muted"
              v-tip="'These two are already related — that says they belong together, not that both are needed.'"
            >already linked</span>
            <span class="font-mono text-3xs font-semibold text-accent">{{ alike(p.score) }}</span>
          </li>
        </ul>

        <p v-if="hidden(data.duplicates)" class="mt-2 font-mono text-3xs text-muted">
          + {{ hidden(data.duplicates) }} more, not shown.
        </p>
        <p v-if="data.duplicates.total" class="mt-2 text-xs leading-relaxed text-muted">
          Read by meaning, not by wording — two texts can share a subject without sharing a
          sentence. Whether one of them should go is your call.
        </p>
      </section>

      <!-- 4. Angefangen statt geschrieben -->
      <section>
        <header class="mb-3">
          <h2 class="flex items-center gap-2.5">
            <Icon icon="lucide:file-edit" class="h-4.5 w-4.5 shrink-0 text-muted" />
            <span class="text-xl font-semibold tracking-tight text-ink">
              Started, not written
            </span>
            <span
              v-if="data.incomplete.total"
              class="count-badge"
            >{{ data.incomplete.total }}</span>
          </h2>
          <p class="mt-1.5 text-[0.8125rem] text-muted">
            Barely any text, or missing something the rest of your wiki carries
            <template v-if="usedFields.length">— here that means {{ usedFields.join(', ') }}</template>.
          </p>
        </header>

        <p
          v-if="!data.incomplete.total"
          class="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-4 text-[0.8125rem] text-muted"
        >
          <Icon icon="lucide:check" class="h-4 w-4 text-success" />
          Every article is written and filled in.
        </p>

        <ul v-else class="flex flex-wrap gap-2">
          <li
            v-for="a in data.incomplete.items"
            :key="a.id"
            class="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2"
          >
            <RouterLink
              :to="`/edit/${a.slug}`"
              class="text-[0.8125rem] font-semibold text-ink transition hover:text-accent"
            >{{ a.title }}</RouterLink>
            <span
              v-if="a.is_class"
              class="rounded border border-line px-1 py-0.5 font-mono text-3xs text-muted"
            >class</span>
            <span
              v-if="a.stub"
              class="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-3xs text-accent"
              v-tip="`${a.words} words of prose`"
            >stub</span>
            <span
              v-for="m in a.missing"
              :key="m"
              class="rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-3xs text-muted"
            >no {{ m }}</span>
          </li>
        </ul>

        <p v-if="hidden(data.incomplete)" class="mt-2 font-mono text-3xs text-muted">
          + {{ hidden(data.incomplete) }} more, not shown.
        </p>
        <p v-if="data.incomplete.total" class="mt-2 text-xs leading-relaxed text-muted">
          A short note can be a finished note — this is a list to glance at, not to empty. Class
          articles are never called stubs: their content is the code, and that is not counted as
          prose.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Der Zaehler eines Befundes – viermal dieselbe Aussage, also einmal geschrieben.
   Die Warnfarbe ist das Token `--color-review` (dasselbe, das im Graphen das
   "Please review"-Badge traegt): eine Zahl, die auffordert, sieht ueberall gleich aus. Der
   weiche Grund entsteht per `color-mix` statt als zweites Token – genau wie bei den
   Hinweisflaechen in `style.css`. */
.count-badge {
  border-radius: 9999px;
  padding: 0.125rem 0.5rem;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.625rem;
  font-weight: 600;
  background-color: color-mix(in srgb, var(--color-review) 16%, transparent);
  color: var(--color-review);
}
</style>
