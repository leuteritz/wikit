<script setup>
/**
 * **Was wäre, wenn?** – der Sandkasten (`POST /api/insights/simulate`).
 *
 * Neun Reiter sagen, wie es steht, und zwei Pläne sagen, was man tun könnte. Die Frage direkt
 * dahinter beantwortet keiner von ihnen: **was bringt es?** – und zwar für den ganzen Bestand, nicht
 * für den einen Befund. Genau daran scheitert ein Umbau im Kopf: eine Kante wegzunehmen löst einen
 * Zyklus und bricht dabei eine Regel, die vorher hielt.
 *
 * Vier Festlegungen:
 *
 * 1. ⚠️ **Die Bilanz ist eine TABELLE mit vorher, nachher und Δ** – nicht sechs Kacheln. Die Frage
 *    lautet „hat es sich gelohnt?", und die beantwortet man an einer Bewegung, nicht an einem
 *    Zustand. Gefärbt wird nur, was sich bewegt hat; eine Ansicht, in der sechs Zahlen leuchten,
 *    hebt nichts hervor.
 *
 * 2. ⚠️ **Der PREIS steht neben dem Gewinn**, in derselben Karte. Ein Vorschlag, der nur den Gewinn
 *    nennt, ist eine Werbung – dieselbe Regel wie `shared` im Aufteilungsvorschlag.
 *
 * 3. ⚠️ **Ein wirkungsloser Eingriff sagt es** (`applied: false` samt Grund). Ein Klick, der stumm
 *    nichts tut, macht die ganze Bilanz unglaubwürdig – dieselbe Regel wie der `inert`-Zustand
 *    einer Architektur-Regel.
 *
 * 4. **Gerechnet wird sofort.** Vormerken und dann auf einen „Run"-Knopf zu zeigen wäre ein zweiter
 *    Schritt für dieselbe Absicht; der Lauf kostet einen Request über Tabellen, die der Bericht
 *    ohnehin liest.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useWhatIf } from '../../composables/useWhatIf.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { useJavaGraph } from '../../composables/useJavaGraph.js'
import { buildGraph } from '../../lib/graphPaths.js'
import { copyToClipboard, BIG_CLIPBOARD_BYTES } from '../../lib/clipboard.js'
import BusyState from '../BusyState.vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'

const props = defineProps({
  classes: { type: Array, default: () => [] },
  packages: { type: Array, default: () => [] },
})
const emit = defineEmits(['open-class'])

const { changes, result, running, error, full, max, add, removeAt, clear, run } = useWhatIf()

// Die Beziehungen kommen aus denselben geteilten Stores wie im Lesepfad – der Kantenbestand liegt
// im Client ohnehin, und ein eigener Endpunkt wäre ein Roundtrip für eine Rechnung im Speicher.
const { files, fetchFiles } = useJavaAnalyzer()
const { edges, fetchEdges } = useJavaGraph()
const edgesReady = ref(false)
const startedAt = ref(Date.now())

onMounted(async () => {
  if (!files.value.length) await fetchFiles()
  if (!edges.value.length) await fetchEdges()
  edgesReady.value = true
  // Ein gemerkter Umbau muss beim Öffnen seine Bilanz zeigen – sonst steht eine Liste da, deren
  // Antwort man erst durch eine Änderung wieder hervorlocken müsste.
  if (changes.value.length && !result.value) run()
})

const graph = computed(() =>
  edgesReady.value ? buildGraph(files.value, edges.value) : { out: new Map(), in: new Map() },
)

// Jede Änderung rechnet neu. Kurz verzögert, weil zwei Klicks hintereinander sonst zwei Läufe
// auslösen, von denen der erste niemanden interessiert.
let timer = null
watch(changes, () => {
  clearTimeout(timer)
  if (!changes.value.length) return
  timer = setTimeout(() => run(), 200)
})

// --- Einen Eingriff vormerken -------------------------------------------------------------------

const term = ref('')
const picked = ref(null)
const mergeTerm = ref('')
const movePkg = ref('')

const byId = computed(() => {
  const map = new Map()
  for (const c of props.classes) map.set(c.id, c)
  return map
})
const nameOf = (id) => byId.value.get(id)?.className || `#${id}`

// Die Suche ist absichtlich schlicht: Name oder Package, Treffer am Anfang zuerst. Die reiche
// Fassung (`c: p: m: …`) steht in `/code` – hier sucht man EINE Klasse, um sie anzufassen.
const SUGGEST_LIMIT = 8
function search(q) {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const hits = []
  for (const c of props.classes) {
    const name = c.className.toLowerCase()
    const at = name.indexOf(needle)
    const inPkg = at < 0 && (c.package || '').toLowerCase().includes(needle)
    if (at < 0 && !inPkg) continue
    hits.push({ c, rank: at === 0 ? 0 : at > 0 ? 1 : 2 })
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.c.className.localeCompare(b.c.className))
    .slice(0, SUGGEST_LIMIT)
    .map((h) => h.c)
}
const matches = computed(() => (picked.value ? [] : search(term.value)))
const mergeMatches = computed(() => search(mergeTerm.value).filter((c) => c.id !== picked.value?.id))

// Die Beziehungen der gewählten Klasse – beide Richtungen, denn „wen benutze ich" und „wer benutzt
// mich" sind zwei verschiedene Umbauten.
const relations = computed(() => {
  const id = picked.value?.id
  if (id == null) return []
  const out = [...(graph.value.out.get(id) || [])].map((to) => ({ from: id, to, dir: 'out' }))
  const inn = [...(graph.value.in.get(id) || [])].map((from) => ({ from, to: id, dir: 'in' }))
  return [...out, ...inn]
    .filter((r) => byId.value.has(r.from) && byId.value.has(r.to))
    .sort((a, b) => a.dir.localeCompare(b.dir) || nameOf(a.dir === 'out' ? a.to : a.from).localeCompare(nameOf(b.dir === 'out' ? b.to : b.from)))
})

function choose(c) {
  picked.value = c
  term.value = c.className
  movePkg.value = ''
  mergeTerm.value = ''
}
function reset() {
  picked.value = null
  term.value = ''
  mergeTerm.value = ''
  movePkg.value = ''
}
function stage(change) {
  add(change)
  reset()
}

// --- Was in der Liste steht ---------------------------------------------------------------------

const OP_META = {
  'remove-edge': { icon: 'lucide:scissors', label: 'Cut' },
  'invert-edge': { icon: 'lucide:rotate-ccw', label: 'Turn around' },
  'move-class': { icon: 'lucide:package', label: 'Move' },
  'merge-classes': { icon: 'lucide:git-merge', label: 'Merge' },
  'remove-class': { icon: 'lucide:trash-2', label: 'Delete' },
}

// Solange der Server noch nicht geantwortet hat, beschriftet der Client die Zeile selbst – sonst
// stünde die frisch vorgemerkte Zeile für einen Moment leer da.
function localTitle(c) {
  if (c.op === 'remove-edge') return `Remove ${nameOf(c.from)} → ${nameOf(c.to)}`
  if (c.op === 'invert-edge') return `Turn around ${nameOf(c.from)} → ${nameOf(c.to)}`
  if (c.op === 'move-class') return `Move ${nameOf(c.id)} to ${c.package || '(default)'}`
  if (c.op === 'merge-classes') return `Merge ${nameOf(c.id)} into ${nameOf(c.into)}`
  return `Delete ${nameOf(c.id)}`
}
const rowFor = (index) => result.value?.applied?.[index] || null

// --- Die Bilanz ---------------------------------------------------------------------------------

const totals = computed(() => result.value?.totals || null)

// ⚠️ `better` sagt, in welche Richtung eine Bewegung gut ist – und `none` heisst „das ist eine
// Auskunft, kein Urteil". Ohne diese Unterscheidung stünde ein grüner Haken an einer gesunkenen
// Klassenzahl, obwohl Löschen für sich genommen keine Verbesserung ist.
const ROWS = [
  { key: 'classCycles', label: 'Dependency cycles', better: 'lower', lead: true },
  { key: 'inCycle', label: 'Classes stuck in one', better: 'lower' },
  { key: 'packageCycles', label: 'Package cycles', better: 'lower' },
  { key: 'ruleViolations', label: 'Rule violations', better: 'lower', rules: true, lead: true },
  { key: 'offMainSequence', label: 'Packages off balance', better: 'lower' },
  { key: 'avgInstability', label: 'Average instability', better: 'none', decimal: true },
  { key: 'worstScore', label: 'Heaviest class', better: 'none', named: 'worstClass' },
  { key: 'classes', label: 'Classes', better: 'none' },
  { key: 'relations', label: 'Relations', better: 'none' },
]

const rows = computed(() => {
  const t = totals.value
  if (!t) return []
  return ROWS.filter((r) => !r.rules || result.value?.hasRules).map((r) => {
    const before = t.before[r.key]
    const after = t.after[r.key]
    const delta = before == null || after == null ? null : Math.round((after - before) * 100) / 100
    const moved = delta != null && Math.abs(delta) > 0.001
    return {
      ...r,
      before,
      after,
      delta,
      moved,
      nameBefore: r.named ? t.before[r.named] : null,
      nameAfter: r.named ? t.after[r.named] : null,
      good: moved && r.better === 'lower' ? delta < 0 : null,
    }
  })
})

const fmt = (v, decimal) => (v == null ? '—' : decimal ? v.toFixed(2) : new Intl.NumberFormat().format(v))
const signed = (v, decimal) => (v > 0 ? '+' : '') + (decimal ? v.toFixed(2) : new Intl.NumberFormat().format(v))
const plural = (n, one, many = `${one}s`) => `${new Intl.NumberFormat().format(n ?? 0)} ${n === 1 ? one : many}`

const cost = computed(() => result.value?.cost || null)
const cycles = computed(() => result.value?.cycles || null)
const ruleChanges = computed(() => result.value?.rules || [])
// Eine Regel, die vorher hielt und jetzt bricht, ist der stärkste Einzelbefund dieser Ansicht: alles
// andere hat Wikit selbst für auffällig befunden, dies hier hat der Betreiber ausdrücklich verboten.
const newlyBroken = computed(() => ruleChanges.value.filter((r) => r.before.status !== 'violated' && r.after.status === 'violated'))

// Ein Umbau ohne jede Wirkung ist ein ERGEBNIS und bekommt seinen Satz – mit Haken, nicht mit
// Warnfarbe. „Nichts passiert" zu verschweigen wäre die schlechteste Antwort auf eine Simulation.
const quiet = computed(() => rows.value.length > 0 && !rows.value.some((r) => r.moved))

// --- Den Plan mitnehmen -------------------------------------------------------------------------

const copying = ref(false)
const copied = ref(false)

const planText = computed(() => {
  const t = totals.value
  if (!t) return ''
  const lines = ['# What if', '', '## Changes']
  for (const [i, c] of changes.value.entries()) {
    const row = rowFor(i)
    lines.push(`${i + 1}. ${row?.title || localTitle(c)}${row && !row.applied ? ' — no effect: ' + row.reason : ''}`)
    if (row?.applied && row.detail) lines.push(`   ${row.detail}`)
    if (row?.warning) lines.push(`   ! ${row.warning}`)
  }
  lines.push('', '## Effect')
  for (const r of rows.value) {
    if (!r.moved) continue
    lines.push(`- ${r.label}: ${fmt(r.before, r.decimal)} -> ${fmt(r.after, r.decimal)} (${signed(r.delta, r.decimal)})`)
  }
  if (!rows.value.some((r) => r.moved)) lines.push('- nothing measurable changed')
  if (cost.value) {
    lines.push('', '## Cost')
    lines.push(
      `- ${plural(cost.value.classes, 'class', 'classes')} to touch, ${plural(cost.value.sites, 'call site')}` +
        (cost.value.newFiles ? `, ${plural(cost.value.newFiles, 'new file')}` : '') +
        (cost.value.movedLines ? `, ${plural(cost.value.movedLines, 'line')} moved` : ''),
    )
  }
  lines.push('', 'Simulated in Wikit — nothing was written.')
  return lines.join('\n')
})

async function copyPlan() {
  copying.value = true
  try {
    await copyToClipboard(planText.value, 'what-if-plan.md')
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } finally {
    copying.value = false
  }
}
const planBytes = computed(() => new Blob([planText.value]).size)
</script>

<template>
  <div class="space-y-5">
    <!-- ======================= Vorgemerkt ======================= -->
    <section class="rounded-xl border border-line bg-surface-2">
      <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon icon="lucide:git-fork" class="h-4 w-4 text-accent" />
        <h3 class="text-sm font-semibold text-ink">Staged changes</h3>
        <span class="rounded bg-surface-offset px-1.5 font-mono text-2xs text-muted">
          {{ changes.length }} / {{ max }}
        </span>
        <span v-if="running" class="inline-flex items-center gap-1 text-2xs text-muted">
          <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
          recomputing
        </span>
        <div class="ml-auto flex items-center gap-2">
          <button
            v-if="changes.length"
            v-tip="'Forget every staged change'"
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-2xs text-muted transition hover:border-line-strong hover:text-ink"
            @click="clear"
          >
            <Icon icon="lucide:rotate-ccw" class="h-3 w-3" />
            Reset all
          </button>
        </div>
      </header>

      <!-- Die Liste selbst. Jede Zeile trägt, was sie bedeutet und was sie kostet – und sagt es,
           wenn sie gar nichts bewirkt hat. -->
      <ul v-if="changes.length" class="divide-y divide-line">
        <li v-for="(c, i) in changes" :key="i" class="flex items-start gap-3 px-4 py-2.5">
          <span
            class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md"
            :class="rowFor(i) && !rowFor(i).applied
              ? 'bg-surface-offset text-muted'
              : 'bg-accent-soft text-accent'"
          >
            <Icon :icon="OP_META[c.op].icon" class="h-3.5 w-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <p
              class="font-mono text-xs"
              :class="rowFor(i) && !rowFor(i).applied ? 'text-muted line-through' : 'text-ink'"
            >
              {{ rowFor(i)?.title || localTitle(c) }}
            </p>
            <p v-if="rowFor(i) && !rowFor(i).applied" class="mt-0.5 text-2xs text-muted">
              No effect — {{ rowFor(i).reason }}
            </p>
            <p v-else-if="rowFor(i)?.detail" class="mt-0.5 text-2xs text-muted">
              {{ rowFor(i).detail }}
            </p>
            <p v-if="rowFor(i)?.warning" class="mt-0.5 inline-flex items-start gap-1 text-2xs text-warning">
              <Icon icon="lucide:alert-triangle" class="mt-0.5 h-3 w-3 shrink-0" />
              {{ rowFor(i).warning }}
            </p>
          </div>
          <button
            v-tip="'Remove this change'"
            type="button"
            class="shrink-0 rounded p-1 text-muted transition hover:bg-surface-offset hover:text-ink"
            @click="removeAt(i)"
          >
            <Icon icon="lucide:x" class="h-3.5 w-3.5" />
          </button>
        </li>
      </ul>

      <!-- Leerzustand: er sagt, dass die Befunde selbst der Einstieg sind – sonst sucht man hier
           nach einer Klasse, die man auf dem Zyklen-Reiter längst vor sich hatte. -->
      <div v-else class="px-4 py-5 text-center">
        <p class="text-xs text-muted">
          Nothing staged yet. Pick a class below — or take a suggestion straight from the
          <span class="font-medium text-ink">Cycles</span> and
          <span class="font-medium text-ink">Rules</span> tabs, where every finding
          now carries a “try this” button.
        </p>
      </div>
    </section>

    <!-- ======================= Etwas vormerken ======================= -->
    <section class="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <Icon icon="lucide:search" class="h-3.5 w-3.5 text-muted" />
        <input
          v-model="term"
          type="text"
          placeholder="Find a class to change…"
          class="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-muted"
          @input="picked = null"
        />
        <button
          v-if="picked || term"
          type="button"
          class="rounded p-1 text-muted transition hover:text-ink"
          @click="reset"
        >
          <Icon icon="lucide:x" class="h-3.5 w-3.5" />
        </button>
      </div>

      <ul v-if="matches.length" class="mt-2 space-y-0.5 border-t border-line pt-2">
        <li v-for="c in matches" :key="c.id">
          <button
            type="button"
            class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left transition hover:bg-surface-offset"
            @click="choose(c)"
          >
            <span class="font-mono text-xs text-ink">{{ c.className }}</span>
            <span class="truncate font-mono text-3xs text-muted">{{ c.package || '(default)' }}</span>
          </button>
        </li>
      </ul>

      <!-- Ist eine Klasse gewählt, stehen hier ihre möglichen Umbauten – und zwar alle vier
           nebeneinander, weil „welcher davon hilft?" genau die Frage ist, die der Sandkasten
           beantworten soll. -->
      <div v-if="picked" class="mt-3 space-y-3 border-t border-line pt-3">
        <p v-if="full" class="text-2xs text-warning">
          That is as many changes as one simulation carries ({{ max }}). Remove one first.
        </p>

        <!-- Beziehungen -->
        <div>
          <p class="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
            Its relations
          </p>
          <BusyState v-if="!edgesReady" variant="inline" title="Loading relations…" :since="startedAt" />
          <p v-else-if="!relations.length" class="text-2xs text-muted">
            No relations — nothing to cut or turn around here.
          </p>
          <ul v-else class="max-h-48 space-y-0.5 overflow-y-auto">
            <li
              v-for="r in relations"
              :key="r.dir + r.from + '-' + r.to"
              class="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-offset"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {{ nameOf(r.from) }}
                <Icon icon="lucide:arrow-right" class="mx-0.5 inline h-3 w-3 text-muted" />
                {{ nameOf(r.to) }}
              </span>
              <button
                v-tip="'Simulate removing this dependency'"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-3xs text-muted transition hover:border-line-strong hover:text-ink disabled:opacity-40"
                :disabled="full"
                @click="stage({ op: 'remove-edge', from: r.from, to: r.to })"
              >
                <Icon icon="lucide:scissors" class="h-3 w-3" />
                Cut
              </button>
              <button
                v-tip="'Simulate inverting it — an interface flips the direction'"
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-3xs text-muted transition hover:border-line-strong hover:text-ink disabled:opacity-40"
                :disabled="full"
                @click="stage({ op: 'invert-edge', from: r.from, to: r.to })"
              >
                <Icon icon="lucide:rotate-ccw" class="h-3 w-3" />
                Turn
              </button>
            </li>
          </ul>
        </div>

        <!-- Umziehen, zusammenlegen, löschen -->
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <p class="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
              Move it
            </p>
            <div class="flex items-center gap-1.5">
              <select
                v-model="movePkg"
                class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-3xs text-ink"
              >
                <option value="">Choose a package…</option>
                <option v-for="p in packages" :key="p.path" :value="p.path" :disabled="p.path === (picked.package || '(default)')">
                  {{ p.path }}
                </option>
              </select>
              <button
                type="button"
                class="shrink-0 rounded-md border border-line px-2 py-1 text-3xs text-muted transition hover:text-ink disabled:opacity-40"
                :disabled="!movePkg || full"
                @click="stage({ op: 'move-class', id: picked.id, package: movePkg === '(default)' ? '' : movePkg })"
              >
                Stage
              </button>
            </div>
          </div>

          <div>
            <p class="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
              Merge it into
            </p>
            <input
              v-model="mergeTerm"
              type="text"
              placeholder="Other class…"
              class="w-full rounded-md border border-line bg-surface px-2 py-1 font-mono text-3xs text-ink outline-none"
            />
            <ul v-if="mergeMatches.length" class="mt-1 space-y-0.5">
              <li v-for="m in mergeMatches.slice(0, 4)" :key="m.id">
                <button
                  type="button"
                  class="w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-3xs text-muted transition hover:bg-surface-offset hover:text-ink disabled:opacity-40"
                  :disabled="full"
                  @click="stage({ op: 'merge-classes', id: picked.id, into: m.id })"
                >
                  → {{ m.className }}
                </button>
              </li>
            </ul>
          </div>

          <div>
            <p class="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
              Or drop it
            </p>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-3xs text-muted transition hover:border-danger/50 hover:text-danger disabled:opacity-40"
              :disabled="full"
              @click="stage({ op: 'remove-class', id: picked.id })"
            >
              <Icon icon="lucide:trash-2" class="h-3 w-3" />
              Delete {{ picked.className }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ======================= Die Bilanz ======================= -->
    <p v-if="error" class="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2.5 text-xs text-ink">
      {{ error }}
    </p>

    <div
      v-else-if="result && !result.available"
      class="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-ink"
    >
      <p class="font-medium">
        {{ result.reason === 'no-classes' ? 'No classes analysed yet.' : 'No relations computed yet.' }}
      </p>
      <p class="mt-0.5 text-muted">
        {{ result.reason === 'no-classes'
          ? 'Add Java code in the Code view — a simulation needs something to change.'
          : 'Without computed edges every change looks harmless. Run “Recompute edges” in the Code view.' }}
      </p>
    </div>

    <template v-else-if="totals">
      <section class="rounded-xl border border-line bg-surface-2">
        <header class="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Icon icon="lucide:scale" class="h-4 w-4 text-accent" />
          <h3 class="text-sm font-semibold text-ink">What it would change</h3>
          <button
            v-tip="'Copy the whole plan — changes, effect and cost'"
            type="button"
            class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-2xs text-muted transition hover:border-line-strong hover:text-ink"
            :disabled="copying"
            @click="copyPlan"
          >
            <Icon :icon="copied ? 'lucide:check' : planBytes > BIG_CLIPBOARD_BYTES ? 'lucide:download' : 'lucide:clipboard-copy'" class="h-3 w-3" />
            {{ copied ? 'Copied' : 'Copy plan' }}
          </button>
        </header>

        <!-- ⚠️ Vorher, nachher, Δ – nebeneinander in EINER Zeile. Zwei Kachelreihen („so ist es" /
             „so wäre es") wären dieselbe Aussage in zwei Bildern, und die Bewegung dazwischen, um
             die es geht, müsste man selbst ausrechnen. -->
        <div class="overflow-x-auto">
          <table class="w-full min-w-[30rem] text-xs">
            <thead>
              <!-- ⚠️ Feste, schmale Zahlenspalten: auf 1920 px zieht eine Tabelle mit vier gleich
                   verteilten Spalten „1" und „0" einen halben Bildschirm auseinander, und der
                   Vergleich, um den es geht, findet dann zwischen zwei weit entfernten Ziffern
                   statt. Die Beschriftung nimmt den Rest. -->
              <tr class="border-b border-line text-2xs uppercase tracking-wide text-muted">
                <th class="px-4 py-1.5 text-left font-medium"></th>
                <th class="w-24 px-3 py-1.5 text-right font-medium">now</th>
                <th class="w-24 px-3 py-1.5 text-right font-medium">after</th>
                <th class="w-20 px-4 py-1.5 text-right font-medium">Δ</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr v-for="r in rows" :key="r.key" :class="r.moved ? '' : 'text-muted'">
                <td class="px-4 py-1.5" :class="r.lead && r.moved ? 'font-semibold text-ink' : ''">
                  {{ r.label }}
                  <span v-if="r.named && r.nameAfter" class="ml-1 font-mono text-3xs text-muted">
                    {{ r.nameBefore === r.nameAfter ? r.nameAfter : r.nameBefore + ' → ' + r.nameAfter }}
                  </span>
                </td>
                <td class="px-3 py-1.5 text-right font-mono tabular-nums">{{ fmt(r.before, r.decimal) }}</td>
                <td class="px-3 py-1.5 text-right font-mono tabular-nums" :class="r.moved ? 'text-ink' : ''">
                  {{ fmt(r.after, r.decimal) }}
                </td>
                <td class="px-4 py-1.5 text-right font-mono tabular-nums">
                  <span
                    v-if="r.moved"
                    :class="r.good === true ? 'text-success' : r.good === false ? 'text-danger' : 'text-ink'"
                  >
                    {{ signed(r.delta, r.decimal) }}
                  </span>
                  <span v-else class="text-muted">·</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Nichts bewegt ist ein Ergebnis, kein Fehler. -->
        <p v-if="quiet" class="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
          <Icon icon="lucide:check-circle" class="h-3.5 w-3.5 text-success" />
          Nothing measurable moved. The structure does not hang on these relations.
        </p>

        <!-- ⚠️ Der Preis steht in DERSELBEN Karte wie der Gewinn. -->
        <p v-if="cost" class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-2xs text-muted">
          <span class="font-semibold uppercase tracking-wide">Cost</span>
          <span class="inline-flex items-center gap-1">
            <Icon icon="lucide:file-code" class="h-3 w-3" />
            {{ plural(cost.classes, 'class', 'classes') }} to touch
          </span>
          <span class="inline-flex items-center gap-1">
            <Icon icon="lucide:target" class="h-3 w-3" />
            {{ plural(cost.sites, 'call site') }}
          </span>
          <span v-if="cost.newFiles" class="inline-flex items-center gap-1">
            <Icon icon="lucide:file-plus" class="h-3 w-3" />
            {{ plural(cost.newFiles, 'new interface') }}
          </span>
          <span v-if="cost.movedLines" class="inline-flex items-center gap-1">
            <Icon icon="lucide:list" class="h-3 w-3" />
            {{ plural(cost.movedLines, 'line') }} on the move
          </span>
        </p>
      </section>

      <!-- Regeln: der stärkste Einzelbefund zuerst -->
      <section v-if="ruleChanges.length" class="rounded-xl border px-4 py-3"
        :class="newlyBroken.length
          ? 'border-danger/40 bg-danger/5'
          : 'border-success/40 bg-success/5'"
      >
        <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
          <Icon icon="lucide:scale" class="h-4 w-4" :class="newlyBroken.length ? 'text-danger' : 'text-success'" />
          {{ newlyBroken.length ? 'This breaks a rule you wrote' : 'Rules move in your favour' }}
        </h3>
        <ul class="mt-2 space-y-2">
          <li v-for="r in ruleChanges" :key="r.line" class="text-xs">
            <p class="font-mono text-ink">{{ r.text }}</p>
            <p class="mt-0.5 text-2xs text-muted">
              <span v-if="r.note">{{ r.note }} — </span>
              {{ r.before.count }} violation{{ r.before.count === 1 ? '' : 's' }} →
              {{ r.after.count }}
              <span v-if="r.after.status === 'inert'"> (nothing matches it any more)</span>
            </p>
            <p
              v-for="v in r.violations.slice(0, 3)"
              :key="v.fromId + '-' + v.toId"
              class="mt-0.5 font-mono text-3xs text-muted"
            >
              {{ v.from }} → {{ v.to }}
            </p>
          </li>
        </ul>
      </section>

      <!-- Zyklen -->
      <section v-if="cycles" class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon icon="lucide:check-circle" class="h-4 w-4 text-success" />
            Loops that would be gone
            <span class="font-mono text-2xs text-muted">
              {{ cycles.classes.healed.length + cycles.packages.healed.length }}
            </span>
          </h3>
          <p v-if="!cycles.classes.healed.length && !cycles.packages.healed.length" class="mt-1.5 text-2xs text-muted">
            None — these changes do not open any loop.
          </p>
          <ul v-else class="mt-2 space-y-1.5">
            <li v-for="(c, i) in cycles.classes.healed" :key="'c' + i" class="font-mono text-2xs text-muted">
              {{ c.chain.join(' → ') }}
            </li>
            <li v-for="(c, i) in cycles.packages.healed" :key="'p' + i" class="font-mono text-2xs text-muted">
              <span class="mr-1 rounded bg-surface-offset px-1 text-3xs">pkg</span>
              {{ c.chain.join(' → ') }}
            </li>
          </ul>
        </div>

        <div class="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon icon="lucide:repeat" class="h-4 w-4" :class="cycles.classes.appeared.length ? 'text-danger' : 'text-muted'" />
            Loops it would create
            <span class="font-mono text-2xs text-muted">
              {{ cycles.classes.appeared.length + cycles.packages.appeared.length }}
            </span>
          </h3>
          <p v-if="!cycles.classes.appeared.length && !cycles.packages.appeared.length" class="mt-1.5 text-2xs text-muted">
            None. Nothing here closes a new circle.
          </p>
          <ul v-else class="mt-2 space-y-2">
            <li v-for="(c, i) in cycles.classes.appeared" :key="'c' + i" class="text-2xs">
              <p class="font-mono text-ink">{{ c.chain.join(' → ') }}</p>
              <p v-for="(e, j) in c.closedBy" :key="j" class="mt-0.5 font-mono text-3xs text-warning">
                closed by {{ e.from }} → {{ e.to }} ({{ e.kind }})
              </p>
            </li>
            <li v-for="(c, i) in cycles.packages.appeared" :key="'p' + i" class="font-mono text-2xs text-ink">
              <span class="mr-1 rounded bg-surface-offset px-1 text-3xs">pkg</span>
              {{ c.chain.join(' → ') }}
            </li>
          </ul>
        </div>
      </section>

      <!-- Wohin sich das Gewicht verschiebt -->
      <section
        v-if="result.classes && (result.classes.shifted.length || result.classes.gone.length)"
        class="rounded-xl border border-line bg-surface-2 px-4 py-3"
      >
        <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
          <Icon icon="lucide:flame" class="h-4 w-4 text-muted" />
          Where the weight moves
        </h3>
        <ul class="mt-2 divide-y divide-line">
          <li v-for="c in result.classes.shifted" :key="c.id" class="flex items-center gap-3 py-1.5 text-xs">
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left font-mono text-ink transition hover:text-accent"
              @click="emit('open-class', c.id)"
            >
              {{ c.className }}
            </button>
            <span v-if="c.cycle.before !== c.cycle.after" class="shrink-0 rounded px-1 text-3xs"
              :class="c.cycle.after
                ? 'bg-danger/15 text-danger'
                : 'bg-success/15 text-success'"
            >
              {{ c.cycle.after ? 'now in a loop' : 'out of its loop' }}
            </span>
            <span class="shrink-0 font-mono text-2xs text-muted">
              {{ c.fanIn.before }}/{{ c.fanOut.before }} → {{ c.fanIn.after }}/{{ c.fanOut.after }}
            </span>
            <span
              class="w-14 shrink-0 text-right font-mono tabular-nums"
              :class="c.delta < 0 ? 'text-success' : c.delta > 0 ? 'text-warning' : 'text-muted'"
            >
              {{ c.score.before }} → {{ c.score.after }}
            </span>
          </li>
          <li v-for="c in result.classes.gone" :key="'g' + c.id" class="flex items-center gap-3 py-1.5 text-xs">
            <span class="min-w-0 flex-1 truncate font-mono text-muted line-through">{{ c.className }}</span>
            <span class="shrink-0 text-2xs text-muted">gone — {{ plural(c.loc, 'line') }}</span>
          </li>
        </ul>
        <p v-if="result.classes.moreShifted" class="mt-2 text-2xs text-muted">
          {{ result.classes.moreShifted }} more classes shift by a smaller amount.
        </p>
      </section>

      <!-- ⚠️ Die Grenze der Auskunft steht UNTER dem Ergebnis, nicht in einem Tooltip. Ohne diese
           Sätze liest sich „−3 cycles" wie ein erledigter Umbau. -->
      <div class="rounded-lg border border-line px-4 py-3 text-2xs leading-relaxed text-muted">
        <p class="font-semibold uppercase tracking-wide">What this does not know</p>
        <ul class="mt-1.5 space-y-1">
          <li>
            <span class="font-medium text-ink">Nothing here is written.</span>
            Your classes, relations and the graph stay exactly as they are — this is a question, not
            an edit. The way back is still: change the code, upload it, read the Drift tab.
          </li>
          <li>
            <span class="font-medium text-ink">It moves relations, not code.</span>
            Whether that method can actually be turned around, and what the compiler says about it,
            is not something a dependency graph can answer.
          </li>
          <li>
            <span class="font-medium text-ink">A score is a rank inside its own state.</span>
            Removing a class shifts the scale for every other one — that is why small moves are left
            out of the list above instead of being counted as an improvement.
          </li>
          <li v-if="result.unresolved">
            {{ plural(result.unresolved, 'relation') }} could not be identified and sat out on both
            sides — same limit as everywhere else in this report.
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
