<script setup>
/**
 * **Was hat sich verändert?** – die Ansicht zum Drift-Bericht (`GET /api/insights/drift`).
 *
 * Die Reihenfolge ist die ganze Gestaltung: **Zyklen zuerst**, dann Abhängigkeiten, dann Größe.
 * Ein neu entstandener Kreis ist der einzige Befund hier, der bei Nichtbeachtung teurer wird –
 * die anderen sind Auskunft. Deshalb steht er oben und trägt als einziger die Warnfarbe.
 *
 * ⚠️ **Der geheilte Zyklus steht gleichberechtigt daneben.** Ein Bericht, der nur Verschlechterung
 * zeigt, wird als Nörgeln gelesen und irgendwann nicht mehr geöffnet; „diesen Kreis hast du
 * aufgelöst" ist dieselbe Rechnung mit umgekehrtem Vorzeichen und kostet keine Zeile mehr.
 */
import { computed, ref } from 'vue'
import BusyState from '../BusyState.vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'
import { formatDateTime } from '../../lib/format.js'

const props = defineProps({
  report: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['open-class', 'pick-point'])

const num = (n) => new Intl.NumberFormat().format(n ?? 0)
// ⚠️ Die Mehrzahl wird MITGEGEBEN, nicht aus einem angehängten „s" gebildet: die häufigste Vokabel
// dieser Ansicht ist „class", und „2 classs" macht aus einem Bericht ein Provisorium.
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

const totals = computed(() => props.report?.totals || null)

// Die Bilanz in der Reihenfolge, in der sie gelesen wird: was ist passiert (Klassen), was hat es
// mit den Beziehungen gemacht, und was heisst das fuer die Struktur. ⚠️ Nur `newCycles` faerbt
// sich – eine Ansicht, in der sechs Zahlen warnen, warnt vor nichts.
const kpis = computed(() => {
  const t = totals.value
  if (!t) return []
  return [
    { label: 'Classes changed', value: num(t.changed), icon: 'lucide:file-text' },
    { label: 'Classes added', value: num(t.added), icon: 'lucide:file-plus' },
    { label: 'Code lines', value: (t.lines > 0 ? '+' : '') + num(t.lines), icon: 'lucide:list' },
    { label: 'New dependencies', value: num(t.addedDeps), icon: 'lucide:share-2' },
    { label: 'Dependencies gone', value: num(t.removedDeps), icon: 'lucide:unlink' },
    { label: 'New cycles', value: num(t.newCycles), icon: 'lucide:repeat', warn: t.newCycles > 0 },
  ]
})

// Nichts passiert ist ein ERGEBNIS und bekommt seinen Satz – mit Haken, nicht mit Warnfarbe.
const quiet = computed(() => {
  const t = totals.value
  return t && !t.changed && !t.added && !t.addedDeps && !t.removedDeps
})

// Der Balken vergleicht eine Klasse mit der groessten Aenderung des Laufs, nicht mit ihrer eigenen
// Groesse: die Frage lautet „was war der grosse Umbau?", und dafuer ist der Bestand der Massstab.
const maxDelta = computed(() =>
  Math.max(1, ...(props.report?.classes?.changed || []).map((c) => Math.abs(c.delta))),
)
const barWidth = (delta) => Math.max(4, Math.round((Math.abs(delta) / maxDelta.value) * 100))

// Ein Punkt der Auswahl: der Zeitstempel als Datum, dazu wie viele Klassen der Lauf geschrieben
// hat. ⚠️ Ohne die Zahl sind zwei Laeufe desselben Tages nicht auseinanderzuhalten.
const pointLabel = (p) => `${formatDateTime(p.at)} · ${plural(p.classes, 'class', 'classes')}`

// Warten hat EINE Form (BusyState). Sie greift nur beim ERSTEN Lauf: steht schon ein Bericht da,
// bleibt er stehen und die Zeile am Auswahlfeld sagt, dass gerechnet wird – ein Skelett anstelle
// eines gelesenen Berichts wäre ein Rückschritt.
const startedAt = ref(Date.now())
</script>

<template>
  <section class="space-y-5">
    <!-- ================= Bezugspunkt ================= -->
    <!-- ⚠️ Er steht GANZ oben und nicht am Rand: jede Zahl darunter ist relativ zu ihm, und ein
         Bericht, dessen Bezug man suchen muss, wird falsch gelesen. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5">
      <span class="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-text)]">
        <Icon icon="lucide:history" class="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
        Compared against
      </span>
      <select
        v-tip="'Every number below is measured against the state right after this import'"
        class="max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-2xs text-[var(--color-text)]"
        :value="report?.since || ''"
        :disabled="loading || !(report?.points || []).length"
        @change="emit('pick-point', $event.target.value)"
      >
        <option v-for="p in report?.points || []" :key="p.point" :value="p.point">
          {{ pointLabel(p) }}
        </option>
      </select>
      <span v-if="loading" class="inline-flex items-center gap-1.5 text-2xs text-[var(--color-text-muted)]">
        <Icon icon="lucide:loader-2" class="h-3 w-3 animate-spin" />
        Rebuilding that state…
      </span>
      <span v-else-if="report?.available" class="text-2xs text-[var(--color-text-muted)]">
        everything since then is shown below
      </span>
    </div>

    <BusyState
      v-if="!report"
      variant="panel"
      title="Rebuilding the earlier state…"
      reason="Reading the saved sources from back then and computing their dependency graph."
      :since="startedAt"
    />

    <!-- ================= Leerzustände: jeder mit seinem Grund ================= -->
    <p
      v-else-if="!report.available"
      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs leading-relaxed text-[var(--color-text-muted)]"
    >
      <template v-if="report.reason === 'no-history'">
        No import has been recorded yet. Add Java code in the Code view — from the second import on,
        this tab can tell you what changed.
      </template>
      <template v-else-if="report.reason === 'single-point'">
        Only one import so far. Drift needs two states to compare — come back after the next upload.
      </template>
      <template v-else>No classes analysed yet.</template>
    </p>

    <template v-else-if="totals">
      <!-- ================= Bilanz ================= -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div
          v-for="k in kpis"
          :key="k.label"
          class="rounded-lg border bg-[var(--color-surface-2)] px-3 py-2"
          :class="k.warn ? 'border-[var(--color-danger)]/40' : 'border-[var(--color-border)]'"
        >
          <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <Icon :icon="k.icon" class="h-3 w-3" />
            {{ k.label }}
          </p>
          <p
            class="mt-0.5 font-mono text-lg font-semibold tabular-nums"
            :style="{ color: k.warn ? 'var(--color-danger)' : 'var(--color-text)' }"
          >{{ k.value }}</p>
        </div>
      </div>

      <p
        v-if="quiet"
        class="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs text-[var(--color-text-muted)]"
      >
        <Icon icon="lucide:check-circle" class="h-4 w-4 text-[var(--color-success)]" />
        Nothing has changed since then — same classes, same relations.
      </p>

      <!-- ================= Neue Zyklen ================= -->
      <!-- Der teuerste Befund zuerst, und mit der KANTE, die ihn geschlossen hat: „ein Zyklus ist
           entstanden" ohne Adresse ist eine Sorge, keine Aufgabe. -->
      <section v-if="report.cycles.appeared.length" class="space-y-2">
        <header class="flex flex-wrap items-baseline gap-x-2">
          <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-danger)]">
            <Icon icon="lucide:repeat" class="h-3.5 w-3.5" />
            Cycles that appeared
          </span>
          <span class="font-mono text-3xs text-[var(--color-text-muted)]">{{ plural(totals.newCycles, 'cycle') }}</span>
          <p class="w-full text-3xs leading-relaxed text-[var(--color-text-muted)]">
            These classes now need each other. Caught here, it is usually one arrow; found a year
            later, it is a rebuild.
          </p>
        </header>

        <ul class="space-y-2">
          <li
            v-for="(c, i) in report.cycles.appeared"
            :key="`app${i}`"
            class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-surface-2)] px-3 py-2.5"
          >
            <!-- Die Kette liest sich wie ein Satz und ist deshalb eine Zeile, keine Liste. -->
            <p class="flex flex-wrap items-center gap-1 font-mono text-2xs">
              <template v-for="(name, k) in c.chain" :key="`${name}${k}`">
                <span class="text-[var(--color-text)]">{{ name }}</span>
                <Icon v-if="k < c.chain.length - 1" icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
              </template>
            </p>

            <p v-if="c.closing.length" class="mt-1.5 flex flex-wrap items-center gap-1 text-3xs text-[var(--color-text-muted)]">
              <Icon icon="lucide:alert-triangle" class="h-3 w-3 text-[var(--color-danger)]" />
              <span>closed by</span>
              <button
                type="button"
                class="rounded bg-[var(--color-surface-offset)] px-1 py-px font-mono text-3xs text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', c.closing[0].from.id)"
              >{{ c.closing[0].from.name }}</button>
              <Icon icon="lucide:arrow-right" class="h-3 w-3" />
              <button
                type="button"
                class="rounded bg-[var(--color-surface-offset)] px-1 py-px font-mono text-3xs text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', c.closing[0].to.id)"
              >{{ c.closing[0].to.name }}</button>
              <span v-if="c.closing[0].members.length" class="font-mono">
                ({{ c.closing[0].members.join(', ') }})
              </span>
              <span v-if="c.closing.length > 1">and {{ c.closing.length - 1 }} more new arrows on this loop</span>
            </p>
            <!-- ⚠️ Kein Kreis ohne Erklärung: liegt die schließende Kante ausserhalb der gezeigten
                 Kette (ein grosser SCC hat mehr Kanten als seinen kuerzesten Kreis), sagt die Zeile
                 das, statt zu schweigen. -->
            <p v-else class="mt-1.5 text-3xs text-[var(--color-text-muted)]">
              The arrow that closed it is not on the shortest loop — one of the classes below grew
              into it. Open them side by side in the Cycles tab.
            </p>

            <p v-if="c.more" class="mt-1 text-3xs text-[var(--color-text-muted)]">
              {{ plural(c.length, 'class', 'classes') }} are tangled here in total.
            </p>
          </li>
        </ul>
        <p v-if="report.cycles.moreAppeared" class="text-3xs text-[var(--color-text-muted)]">
          … and {{ plural(report.cycles.moreAppeared, 'cycle') }} more.
        </p>
      </section>

      <!-- ================= Geheilte Zyklen ================= -->
      <section v-if="report.cycles.healed.length" class="space-y-2">
        <header class="flex flex-wrap items-baseline gap-x-2">
          <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-success)]">
            <Icon icon="lucide:check-circle" class="h-3.5 w-3.5" />
            Cycles that are gone
          </span>
          <span class="font-mono text-3xs text-[var(--color-text-muted)]">{{ plural(totals.healedCycles, 'cycle') }}</span>
        </header>
        <ul class="space-y-1.5">
          <li
            v-for="(c, i) in report.cycles.healed"
            :key="`heal${i}`"
            class="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-2xs"
          >
            <button
              v-for="cl in c.classes"
              :key="cl.id"
              type="button"
              class="rounded bg-[var(--color-surface-offset)] px-1 py-px text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
              @click="emit('open-class', cl.id)"
            >{{ cl.name }}</button>
            <span v-if="c.more" class="text-3xs text-[var(--color-text-muted)]">and {{ c.more }} more</span>
          </li>
        </ul>
      </section>

      <!-- ================= Beziehungen ================= -->
      <div class="grid gap-4 lg:grid-cols-2">
        <section v-if="report.dependencies.added.length" class="space-y-2">
          <header class="flex flex-wrap items-baseline gap-x-2">
            <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-accent)]">
              <Icon icon="lucide:plus" class="h-3.5 w-3.5" />
              New dependencies
            </span>
            <span class="font-mono text-3xs text-[var(--color-text-muted)]">{{ num(totals.addedDeps) }}</span>
          </header>
          <ul class="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <li
              v-for="(d, i) in report.dependencies.added"
              :key="`add${i}`"
              class="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-2xs last:border-0"
            >
              <button
                type="button"
                class="font-mono text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', d.from.id)"
              >{{ d.from.name }}</button>
              <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
              <button
                type="button"
                class="font-mono text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', d.to.id)"
              >{{ d.to.name }}</button>
              <!-- Die Art sagt, wie schwer die Beziehung wieder wegzubekommen ist – dieselbe
                   Sprache wie die Linien im Graphen. -->
              <span class="ml-auto shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                {{ d.kind }}<template v-if="d.members.length"> · {{ d.members.join(', ') }}</template>
              </span>
            </li>
          </ul>
          <p v-if="report.dependencies.moreAdded" class="text-3xs text-[var(--color-text-muted)]">
            … and {{ num(report.dependencies.moreAdded) }} more.
          </p>
        </section>

        <section v-if="report.dependencies.removed.length" class="space-y-2">
          <header class="flex flex-wrap items-baseline gap-x-2">
            <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-muted)]">
              <Icon icon="lucide:minus" class="h-3.5 w-3.5" />
              Dependencies gone
            </span>
            <span class="font-mono text-3xs text-[var(--color-text-muted)]">{{ num(totals.removedDeps) }}</span>
          </header>
          <ul class="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <li
              v-for="(d, i) in report.dependencies.removed"
              :key="`rem${i}`"
              class="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-2xs last:border-0"
            >
              <button
                type="button"
                class="font-mono text-[var(--color-text-muted)] line-through transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', d.from.id)"
              >{{ d.from.name }}</button>
              <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
              <button
                type="button"
                class="font-mono text-[var(--color-text-muted)] line-through transition hover:text-[var(--color-accent)]"
                @click="emit('open-class', d.to.id)"
              >{{ d.to.name }}</button>
              <span class="ml-auto shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">{{ d.kind }}</span>
            </li>
          </ul>
          <p v-if="report.dependencies.moreRemoved" class="text-3xs text-[var(--color-text-muted)]">
            … and {{ num(report.dependencies.moreRemoved) }} more.
          </p>
        </section>
      </div>

      <!-- ================= Klassen ================= -->
      <section v-if="report.classes.changed.length" class="space-y-2">
        <header class="flex flex-wrap items-baseline gap-x-2">
          <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
            <Icon icon="lucide:file-text" class="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            What changed, by size
          </span>
          <span class="font-mono text-3xs text-[var(--color-text-muted)]">
            {{ num(totals.grew) }} grew · {{ num(totals.shrank) }} shrank
          </span>
        </header>
        <ul class="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <li
            v-for="c in report.classes.changed"
            :key="c.id"
            class="border-b border-[var(--color-border)] last:border-0"
          >
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-1.5 text-left transition hover:bg-[var(--color-surface-offset)]"
              @click="emit('open-class', c.id)"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text)]">{{ c.name }}</span>
              <span class="hidden shrink-0 truncate font-mono text-3xs text-[var(--color-text-muted)] sm:block">{{ c.package }}</span>
              <span class="hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)] sm:block">
                <span
                  class="block h-full rounded-full"
                  :style="{ width: `${barWidth(c.delta)}%`, background: c.delta >= 0 ? 'var(--color-accent)' : 'var(--color-text-muted)' }"
                />
              </span>
              <span
                v-tip="`${c.locBefore} → ${c.locAfter} code lines`"
                class="w-16 shrink-0 text-right font-mono text-3xs tabular-nums"
                :style="{ color: c.delta >= 0 ? 'var(--color-accent)' : 'var(--color-text-muted)' }"
              >{{ c.delta > 0 ? '+' : '' }}{{ num(c.delta) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="report.classes.moreChanged" class="text-3xs text-[var(--color-text-muted)]">
          … and {{ plural(report.classes.moreChanged, 'class', 'classes') }} more with smaller changes.
        </p>
      </section>

      <section v-if="report.classes.added.length" class="space-y-2">
        <header class="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
          <Icon icon="lucide:file-plus" class="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          New classes
        </header>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="c in report.classes.added"
            :key="c.id"
            v-tip="c.package"
            type="button"
            class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-2xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            @click="emit('open-class', c.id)"
          >{{ c.name }}</button>
        </div>
        <p v-if="report.classes.moreAdded" class="text-3xs text-[var(--color-text-muted)]">
          … and {{ plural(report.classes.moreAdded, 'class', 'classes') }} more.
        </p>
      </section>

      <!-- ================= Grenze der Auskunft ================= -->
      <!-- ⚠️ Unter die Liste, nicht in einen Tooltip: ohne diesen Satz liest sich „0 dependencies
           gone" als „nichts wurde gelöscht" – und eine gelöschte Klasse kann hier gar nicht
           auftauchen. -->
      <p class="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-3xs leading-relaxed text-[var(--color-text-muted)]">
        <Icon icon="lucide:info" class="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Only what is still here can be compared: a class you deleted takes its history with it.
          Edges you drew or dismissed by hand count on both sides and never show up as drift.
          <template v-if="totals.withoutHistory">
            {{ plural(totals.withoutHistory, 'class', 'classes') }} predate version history and count as
            unchanged.
          </template>
          <template v-if="totals.unresolved">
            {{ num(totals.unresolved) }} relations could not be tied to a class and were skipped.
          </template>
        </span>
      </p>
    </template>
  </section>
</template>
