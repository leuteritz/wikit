<script setup>
/**
 * **Was du festgelegt hast – und wo der Code es gerade nicht einhält.**
 *
 * Der einzige Reiter des Berichts, in dem nicht gemessen, sondern **vereinbart** wird. Alle anderen
 * beobachten und müssen dabei raten, was davon gewollt ist; am deutlichsten die Zyklen-Bruchstelle,
 * die ihre Schichten bis hierher aus einer Wortliste erraten musste und deshalb „looks like"
 * schreiben musste. Steht hier eine `layers`-Zeile, wird daraus eine Feststellung.
 *
 * ⚠️ **Der Editor ist ein Textfeld, kein Formular.** Eine Regel ist eine Zeile, und die Begründung
 * dahinter (`#`) ist der halbe Wert der Sache: „web geht nie direkt an die Datenbank" erklärt in
 * fünf Wörtern, was drei Klicks in einer Maske nicht erklären. Reihenfolge, Leerzeilen und
 * Kommentare gehören deshalb zur Eingabe – in Formularzeilen zerlegt wären sie beim ersten
 * Speichern weg.
 *
 * ⚠️ **Das leere Textfeld ist der eigentliche Gegner dieser Ansicht.** „Schreib deine Architektur
 * auf" ist eine Aufforderung, der niemand nachkommt, solange er dafür erst eine Sprache lernen
 * muss. Deshalb steht der Vorschlagsblock beim leeren Stand GANZ oben und nicht unten: der Bestand
 * weiss längst, welche Richtungen hier eingehalten werden, und ein Klick macht daraus eine Regel.
 */
import { computed, ref, watch } from 'vue'
import BusyState from '../BusyState.vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'
import { useWhatIf } from '../../composables/useWhatIf.js'

const props = defineProps({
  report: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  startedAt: { type: Number, default: 0 },
})
const emit = defineEmits(['open-class', 'save'])

const num = (n) => new Intl.NumberFormat().format(n ?? 0)
// Die Mehrzahl wird mitgegeben, nicht aus einem angehängten „s" gebildet – gleiche Regel wie im
// Drift-Bericht („2 classs" macht aus einem Bericht ein Provisorium).
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

// Ein Verstoss lässt sich direkt in den Sandkasten legen: „diese Beziehung darf nicht sein" ist
// eine Feststellung, „was passiert, wenn sie weg ist" die Frage danach. Der Store ist geteilt, der
// Reiter daneben zeigt das Ergebnis (s. `useWhatIf`).
const whatIf = useWhatIf()
const cutOf = (v) => ({ op: 'remove-edge', from: v.fromId, to: v.toId })
const staged = (v) => whatIf.has(cutOf(v))
const stage = (v) => whatIf.add(cutOf(v))

// --- Der Editor ---------------------------------------------------------------------------------
// ⚠️ Der getippte Text lebt HIER und wird vom Server nur nachgezogen, wenn er sich dort wirklich
// geändert hat. Ihn an jeder Antwort neu zu setzen hiesse, dem Tippenden mitten im Satz den Cursor
// zu verschieben – die Antwort auf ein Speichern kommt schliesslich zurück, während man schon
// weiterschreibt.
const text = ref('')
let lastServerText = null
watch(
  () => props.report?.text,
  (t) => {
    if (t == null || t === lastServerText) return
    lastServerText = t
    text.value = t
  },
  { immediate: true },
)

const dirty = computed(() => text.value !== (props.report?.text ?? ''))
// Mindestens sechs Zeilen, damit das Feld nicht als einzeilige Eingabe missverstanden wird, und
// immer zwei Zeilen Luft am Ende – ein Feld, in dem man scrollen muss, um weiterzuschreiben, lädt
// nicht dazu ein.
const rows = computed(() => Math.max(6, text.value.split('\n').length + 2))

const totals = computed(() => props.report?.totals || null)
const rules = computed(() => props.report?.rules || [])
const errors = computed(() => props.report?.errors || [])
const suggestions = computed(() => props.report?.suggestions || [])
const empty = computed(() => !rules.value.length && !errors.value.length)

function save() {
  emit('save', text.value)
}
function revert() {
  text.value = props.report?.text ?? ''
}

/**
 * Einen Vorschlag übernehmen: anhängen und sofort speichern.
 *
 * ⚠️ Gespeichert wird der Stand, der IM FELD steht – nicht der vom Server. Was man sieht, ist was
 * gespeichert wird; ein Vorschlag, der ungespeicherte Zeilen darüber stillschweigend verwirft,
 * wäre die unangenehmste Überraschung, die diese Ansicht anbieten kann. Und kein Dialog davor: die
 * Geste heisst „ja, das gilt hier" (gleiche Regel wie beim Link-Vorschlag im Wiki-Graphen).
 */
function adopt(s) {
  const base = text.value.replace(/\s+$/, '')
  const note = s.kind === 'layers' ? '# The layers of this codebase, outermost first.' : `# ${s.why}`
  text.value = `${base ? `${base}\n\n` : ''}${note}\n${s.text}\n`
  emit('save', text.value)
}

// --- Darstellung --------------------------------------------------------------------------------

// Drei Zustände, drei Aussagen. ⚠️ `inert` ist der Grund, warum es nicht bei zwei bleibt: eine
// Regel, die keine einzige Klasse trifft, ist fast immer ein Tippfehler im Packagenamen – als
// grüner Haken gelesen behauptet sie, geprüft zu haben.
const STATUS = {
  violated: {
    icon: 'lucide:alert-triangle',
    color: 'var(--color-danger)',
    label: 'broken',
  },
  holds: {
    icon: 'lucide:check-circle',
    color: 'var(--color-success)',
    label: 'holds',
  },
  inert: {
    icon: 'lucide:circle-slash',
    color: 'var(--color-warning)',
    label: 'never applies',
  },
}
const statusOf = (r) => STATUS[r.status] || STATUS.holds

// Was eine Regel unter ihrem Titel sagt. Der Satz ist die eigentliche Auskunft: „holds" allein ist
// schwach, „gilt für 42 Beziehungen, keine verletzt sie" ist eine Aussage über den Bestand.
function summaryOf(r) {
  if (r.status === 'violated') {
    return `${plural(r.count, 'relation')} ${r.count === 1 ? 'breaks' : 'break'} this rule.`
  }
  if (r.status === 'inert') {
    const names = r.unmatched.map((u) => `“${u}”`).join(' and ')
    return `No class here matches ${names} — check the spelling, or upload the code it refers to.`
  }
  if (!r.checked) return 'No relation in this codebase touches it yet — it holds by default.'
  return `${plural(r.checked, 'relation')} checked, none breaks it.`
}

// Welche Regelart hier steht – als Wort, weil die Zeile selbst schon Zeichen genug trägt.
const KIND_LABEL = { forbid: 'forbidden', only: 'restricted', layers: 'layer order' }

// Aufgeklappt ist immer nur EINE Regel: zwei Verstosslisten übereinander sind zwei Arbeitslisten,
// und man arbeitet an einer (gleiche Regel wie beim Zyklen- und Aufteilungsplan).
const open = ref(null)
const toggle = (line) => (open.value = open.value === line ? null : line)

const help = ref(false)
</script>

<template>
  <section class="space-y-5">
    <BusyState
      v-if="!report && loading"
      variant="panel"
      title="Checking your rules…"
      reason="Reading the class relations and testing every rule against them."
      :since="startedAt"
    />

    <template v-else-if="report">
      <!-- ================= Bilanz ================= -->
      <!-- Nur bei vorhandenen Regeln: eine Bilanz über nichts ist eine Reihe von Nullen, und die
           beantwortet die Frage „womit fange ich an?" nicht. -->
      <div v-if="!empty" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <Icon icon="lucide:scale" class="h-3 w-3" />
            Rules
          </p>
          <p class="mt-0.5 font-mono text-lg font-semibold tabular-nums text-[var(--color-text)]">{{ num(totals?.rules) }}</p>
        </div>
        <div
          class="rounded-lg border bg-[var(--color-surface-2)] px-3 py-2"
          :class="totals?.violations ? 'border-[var(--color-danger)]/40' : 'border-[var(--color-border)]'"
        >
          <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <Icon icon="lucide:alert-triangle" class="h-3 w-3" />
            Relations breaking them
          </p>
          <p
            class="mt-0.5 font-mono text-lg font-semibold tabular-nums"
            :style="{ color: totals?.violations ? 'var(--color-danger)' : 'var(--color-text)' }"
          >{{ num(totals?.violations) }}</p>
        </div>
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <Icon icon="lucide:circle-slash" class="h-3 w-3" />
            Never applying
          </p>
          <p
            class="mt-0.5 font-mono text-lg font-semibold tabular-nums"
            :style="{ color: totals?.inert ? 'var(--color-warning)' : 'var(--color-text)' }"
          >{{ num(totals?.inert) }}</p>
        </div>
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <Icon icon="lucide:layers" class="h-3 w-3" />
            Layer order
          </p>
          <!-- ⚠️ Ein WORT an der Stelle, an der die anderen drei eine Zahl tragen – nicht ein Satz
               in Kleinschrift. „Habe ich die Schichten festgelegt?" ist eine Ja/Nein-Frage, und in
               einer Reihe aus drei grossen Zahlen liest sich eine graue Zeile wie eine fehlende. -->
          <p
            class="mt-0.5 text-lg font-semibold leading-tight"
            :style="{ color: totals?.hasLayers ? 'var(--color-text)' : 'var(--color-text-muted)' }"
          >{{ totals?.hasLayers ? 'Yours' : 'Not set' }}</p>
          <p class="text-3xs leading-tight text-[var(--color-text-muted)]">
            {{ totals?.hasLayers ? 'the cycle tab uses it' : 'cycles fall back to a guess' }}
          </p>
        </div>
      </div>

      <!-- ================= Vorschläge ================= -->
      <!-- ⚠️ Beim LEEREN Stand stehen sie ganz oben – ohne eigenes Zutun: die Bilanz darüber
           entfällt dann (eine Reihe von Nullen beantwortet keine Frage), und damit ist der
           Vorschlag das Erste, was man sieht. Genau so ist es gemeint, denn das leere Textfeld ist
           der eigentliche Gegner dieser Ansicht. -->
      <div
        v-if="suggestions.length"
        class="rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 p-4"
      >
        <p class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
          <Icon icon="lucide:sparkles" class="h-4 w-4 text-[var(--color-accent)]" />
          {{ empty ? 'Start from what your code already does' : 'Suggested from your code' }}
        </p>
        <p class="mt-1 text-2xs leading-relaxed text-[var(--color-text-muted)]">
          These are not opinions — every line below is a direction this codebase already keeps today.
          Adopting one writes it down, so the next import cannot quietly reverse it.
        </p>
        <ul class="mt-3 space-y-2">
          <li
            v-for="s in suggestions"
            :key="s.text"
            class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            <code class="font-mono text-xs text-[var(--color-text)]">{{ s.text }}</code>
            <span class="text-3xs text-[var(--color-text-muted)]">{{ s.why }}</span>
            <!-- ⚠️ Ein Vorschlag, der heute schon Verstösse hätte, verschweigt das nicht. Sonst
                 wird die Regel im Moment ihrer Übernahme rot, und das sieht aus wie ein Fehler des
                 Werkzeugs statt wie ein Befund über den Code. -->
            <span
              v-if="s.wouldFlag"
              class="rounded px-1.5 py-0.5 text-3xs"
              :style="{ background: 'color-mix(in oklab, var(--color-warning) 18%, transparent)', color: 'var(--color-warning)' }"
            >would flag {{ plural(s.wouldFlag, 'relation') }} today</span>
            <button
              type="button"
              class="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-3xs font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              :disabled="saving"
              @click="adopt(s)"
            >
              <Icon icon="lucide:plus" class="h-3 w-3" />
              Adopt
            </button>
          </li>
        </ul>
      </div>

      <!-- ================= Der Editor ================= -->
      <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] px-4 py-2.5">
          <span class="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-text)]">
            <Icon icon="lucide:scale" class="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            Your rules
          </span>
          <span class="text-3xs text-[var(--color-text-muted)]">one per line · <code class="font-mono">#</code> for why</span>
          <button
            type="button"
            class="ml-auto inline-flex items-center gap-1 text-3xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
            @click="help = !help"
          >
            <Icon :icon="help ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3 w-3" />
            How do I write one?
          </button>
          <button
            v-if="dirty"
            type="button"
            class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-3xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
            :disabled="saving"
            @click="revert"
          >
            <Icon icon="lucide:rotate-ccw" class="h-3 w-3" />
            Revert
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-3xs font-medium transition disabled:opacity-40"
            :style="{
              background: dirty ? 'var(--color-accent)' : 'var(--color-surface)',
              color: dirty ? 'var(--color-on-accent, #fff)' : 'var(--color-text-muted)',
            }"
            :disabled="!dirty || saving"
            @click="save"
          >
            <Icon :icon="saving ? 'lucide:loader-2' : 'lucide:save'" class="h-3 w-3" :class="saving ? 'animate-spin' : ''" />
            {{ saving ? 'Checking…' : 'Save and check' }}
          </button>
        </div>

        <!-- Die Syntax in vier Zeilen. Zugeklappt, weil sie beim ersten Mal die Rettung und danach
             im Weg ist – gleiche Regel wie „What do I do with this?" über den Reitern. -->
        <div v-if="help" class="border-b border-[var(--color-border)] px-4 py-3 text-2xs leading-relaxed text-[var(--color-text-muted)]">
          <dl class="grid gap-2 sm:grid-cols-2">
            <div>
              <dt><code class="font-mono text-[var(--color-text)]">web -/-> repo</code></dt>
              <dd>Nothing in <code class="font-mono">web</code> may use <code class="font-mono">repo</code>.</dd>
            </div>
            <div>
              <dt><code class="font-mono text-[var(--color-text)]">only service -> repo</code></dt>
              <dd>Only <code class="font-mono">service</code> may reach into <code class="font-mono">repo</code>. Everything else is a violation.</dd>
            </div>
            <div>
              <dt><code class="font-mono text-[var(--color-text)]">domain -/-> *</code></dt>
              <dd><code class="font-mono">domain</code> may not depend on anything outside itself.</dd>
            </div>
            <div>
              <dt><code class="font-mono text-[var(--color-text)]">layers: web > service > repo</code></dt>
              <dd>Outermost first. Every arrow pointing back out is a violation — and the cycle tab uses this order too.</dd>
            </div>
          </dl>
          <p class="mt-3">
            A name without a dot matches any package carrying that segment
            (<code class="font-mono">web</code> hits <code class="font-mono">com.acme.shop.web</code>).
            With dots it is a package and its subpackages, and a capitalised name is a single class
            (<code class="font-mono">OrderService</code>).
          </p>
        </div>

        <textarea
          v-model="text"
          :rows="rows"
          spellcheck="false"
          placeholder="# The web layer never talks to the database directly.&#10;web -/-> repo"
          class="w-full resize-y bg-transparent px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
        />
      </div>

      <!-- ================= Fehlerhafte Zeilen ================= -->
      <!-- ⚠️ Sie werden gespeichert und nicht abgelehnt: wer mitten im Schreiben unterbrochen wird,
           darf seinen Text nicht verlieren. Die Zeile gilt eben nicht, und das steht hier. -->
      <ul v-if="errors.length" class="space-y-1.5">
        <li
          v-for="e in errors"
          :key="e.line"
          class="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-2xs"
        >
          <span class="font-mono text-3xs text-[var(--color-text-muted)]">line {{ e.line }}</span>
          <code class="font-mono text-[var(--color-text)]">{{ e.source }}</code>
          <span class="text-[var(--color-text-muted)]">— {{ e.message }}</span>
        </li>
      </ul>

      <!-- ================= Der Befund je Regel ================= -->
      <ul v-if="rules.length" class="space-y-2">
        <li
          v-for="r in rules"
          :key="r.line"
          class="overflow-hidden rounded-lg border bg-[var(--color-surface-2)]"
          :class="r.status === 'violated' ? 'border-[var(--color-danger)]/40' : 'border-[var(--color-border)]'"
        >
          <!-- Die ganze Kopfzeile klappt auf, aber nur wenn es etwas zu zeigen gibt: ein Chevron
               über einer erfüllten Regel verspricht einen Inhalt, den es nicht gibt. -->
          <component
            :is="r.count ? 'button' : 'div'"
            :type="r.count ? 'button' : undefined"
            class="flex w-full items-start gap-3 px-4 py-3 text-left"
            :class="r.count ? 'transition hover:bg-[var(--color-surface)]' : ''"
            @click="r.count && toggle(r.line)"
          >
            <Icon :icon="statusOf(r).icon" class="mt-0.5 h-4 w-4 shrink-0" :style="{ color: statusOf(r).color }" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <code class="font-mono text-xs font-medium text-[var(--color-text)]">{{ r.text }}</code>
                <span class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">{{ KIND_LABEL[r.kind] }}</span>
              </div>
              <p class="mt-1 text-2xs text-[var(--color-text-muted)]">{{ summaryOf(r) }}</p>
              <!-- Das WARUM aus der `#`-Zeile darüber. Es ist der halbe Wert einer Regel: ohne ihn
                   weiss in einem halben Jahr niemand mehr, ob sie noch gelten soll. -->
              <p v-if="r.note" class="mt-1 border-l-2 border-[var(--color-border)] pl-2 text-2xs italic text-[var(--color-text-muted)]">
                {{ r.note }}
              </p>
            </div>
            <span
              v-if="r.count"
              class="shrink-0 rounded px-1.5 py-0.5 font-mono text-3xs tabular-nums"
              :style="{ background: 'color-mix(in oklab, var(--color-danger) 18%, transparent)', color: 'var(--color-danger)' }"
            >{{ num(r.count) }}</span>
            <Icon
              v-if="r.count"
              :icon="open === r.line ? 'lucide:chevron-down' : 'lucide:chevron-right'"
              class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]"
            />
          </component>

          <!-- Die Verstösse mit NAMEN. „2 violations" ist eine Sorge, diese Liste ist eine Aufgabe:
               jede Zeile ist die Stelle, an der man etwas ändert, und springt dorthin. -->
          <div v-if="open === r.line && r.violations.length" class="border-t border-[var(--color-border)] px-4 py-3">
            <ul class="space-y-1">
              <li
                v-for="v in r.violations"
                :key="`${v.fromId}-${v.toId}`"
                class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs"
              >
                <button
                  type="button"
                  class="font-mono text-[var(--color-text)] underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-accent)]"
                  v-tip="v.fromPkg || 'default package'"
                  @click="emit('open-class', v.fromId)"
                >{{ v.from }}</button>
                <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                <button
                  type="button"
                  class="font-mono text-[var(--color-text)] underline decoration-dotted underline-offset-2 transition hover:text-[var(--color-accent)]"
                  v-tip="v.toPkg || 'default package'"
                  @click="emit('open-class', v.toId)"
                >{{ v.to }}</button>
                <span class="text-3xs text-[var(--color-text-muted)]">
                  {{ v.kind }}<template v-if="v.members.length"> · {{ v.members.join(', ') }}</template>
                  <template v-if="v.count > 1"> · {{ v.count }}×</template>
                </span>
                <!-- ⚠️ Die Zeile sagt, WO die Regel bricht. Ob es sich lohnt, sie hier zu heilen,
                     sagt erst der Sandkasten – eine Regel einzuhalten kann anderswo einen Zyklus
                     schliessen, und das sieht man dieser Zeile nicht an. -->
                <button
                  v-tip="'Stage removing this relation and see what else it would change'"
                  type="button"
                  class="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-3xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  :class="staged(v) ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'"
                  @click="stage(v)"
                >
                  <Icon :icon="staged(v) ? 'lucide:check' : 'lucide:git-fork'" class="h-3 w-3" />
                  {{ staged(v) ? 'Staged' : 'Try this' }}
                </button>
              </li>
            </ul>
            <p v-if="r.more" class="mt-2 text-3xs text-[var(--color-text-muted)]">
              … and {{ plural(r.more, 'more relation') }} not listed.
            </p>
          </div>
        </li>
      </ul>

      <!-- ================= Leerzustand ================= -->
      <p
        v-else-if="empty"
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs leading-relaxed text-[var(--color-text-muted)]"
      >
        No rules yet — so nothing here can be broken.
        <template v-if="!suggestions.length">
          <br />
          There is also nothing to suggest: rules are checked against computed relations, and this
          workspace has none yet. Recompute edges in the Code view first.
        </template>
      </p>

      <!-- ================= Die Grenze der Auskunft ================= -->
      <!-- Sie steht unter der Liste, nicht in einem Tooltip: „holds" ohne diesen Satz liest sich
           als Freispruch, und er gilt nur für das, was Wikit überhaupt sehen kann. -->
      <p v-if="!empty" class="text-3xs leading-relaxed text-[var(--color-text-muted)]">
        Checked against computed relations, never against import lines — an import that is never used
        is not a dependency. Reflection, dependency injection by name and code that is not uploaded
        leave no relation, so they cannot break a rule either.
        <template v-if="report.unresolved">
          {{ plural(report.unresolved, 'relation') }} could not be resolved to a class and
          {{ report.unresolved === 1 ? 'was' : 'were' }} left out.
        </template>
      </p>
    </template>
  </section>
</template>
