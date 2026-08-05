<script setup>
// Der Insights-Bereich: was man einer Codebasis nicht ansieht.
//
// Warum eine eigene Ansicht neben `/code`: das sind zwei verschiedene Fragen. `/code` beantwortet
// „wie haengt das zusammen?" und tut es im Bild; hier steht „wie steht es darum?", und die Antwort
// ist eine RANGLISTE. Eine Rangliste in einen Graphen zu legen hiesse, sie in einen Ausschnitt zu
// legen – aber der schlimmste Brandherd ist selten der, den man gerade ansieht.
//
// Vier Reiter, weil es vier Fragen sind: Wie ist die Lage (Overview)? Was ist verklebt (Cycles)?
// Wo tut es weh (Hotspots)? Wie sind die Schichten geschnitten (Packages)?
//
// Jede Zeile ist ein Absprung: der Bericht endet nicht bei der Erkenntnis, sondern an der Stelle,
// an der man etwas tun kann (`/code` mit der Klasse bzw. dem Package im Bild).
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useInsights } from '../composables/useInsights.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import BusyState from '../components/BusyState.vue'
import { Icon } from '../lib/icons.js'
import { vTip } from '../lib/tooltip.js'

const router = useRouter()
const { data, loading, ensure, reload } = useInsights()
const { lastFileId, lastPackage } = useJavaAnalyzer()

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'lucide:layout-grid', hint: 'Totals and the three headline findings' },
  { id: 'cycles', label: 'Cycles', icon: 'lucide:repeat', hint: 'Dependency loops, and where to cut them' },
  { id: 'hotspots', label: 'Hotspots', icon: 'lucide:flame', hint: 'Where size, branching and coupling meet' },
  { id: 'packages', label: 'Packages', icon: 'lucide:package', hint: 'Abstractness against instability' },
]
const tab = ref('overview')
const startedAt = ref(Date.now())

// Wie viele Zeilen eine Rangliste zeigt, bevor sie ausklappt. Zwanzig Brandherde sind eine
// Arbeitsliste; tausend sind wieder nur die Codebasis.
const TOP_N = 20
const showAllHotspots = ref(false)

const totals = computed(() => data.value?.totals || null)
const classes = computed(() => data.value?.classes || [])
const packages = computed(() => data.value?.packages || [])
const cycles = computed(() => data.value?.cycles || { classes: [], packages: [] })

const ranked = computed(() => [...classes.value].sort((a, b) => b.score - a.score || b.complexity - a.complexity))
const hotspots = computed(() => (showAllHotspots.value ? ranked.value : ranked.value.slice(0, TOP_N)))

// Das Package, das am weitesten von der Hauptsequenz weg liegt – die eine Zahl, die auf der
// Uebersicht fuer „Schichtung" steht. Ohne Beziehungen ist sie nicht definiert (null), und dann
// gibt es hier auch nichts zu melden.
const worstPackage = computed(() => {
  const withDistance = packages.value.filter((p) => p.distance != null)
  if (!withDistance.length) return null
  return withDistance.reduce((a, b) => (b.distance > a.distance ? b : a))
})

// Der Leerzustand hat drei GRUENDE, und sie sind nicht dasselbe. Ohne Klassen ist nichts zu
// analysieren; ohne berechnete Kanten sieht der Bericht aus wie „alles in Ordnung", obwohl nur
// niemand die Beziehungen berechnet hat; und ein laufender Nachtrag ist ein dritter Fall.
const emptyReason = computed(() => {
  if (!totals.value) return null
  if (!totals.value.classes) return 'no-classes'
  if (!totals.value.relations) return 'no-relations'
  return null
})

onMounted(() => ensure())

function refresh() {
  startedAt.value = Date.now()
  reload()
}

// --- Absprung nach /code ------------------------------------------------------------------------
// Derselbe Hand-off, den die globale Suche benutzt: Ziel setzen, Route wechseln. Ohne mitgegebene
// Suche schlaegt CodeView das Ego der Klasse auf – genau die Antwort auf „zeig mir sie".
function openClass(id) {
  lastFileId.value = id
  router.push('/code')
}
function openPackage(path) {
  lastPackage.value = path
  router.push('/code')
}

// --- Darstellung --------------------------------------------------------------------------------

// Der Score faerbt sich, aber er faerbt sich nicht linear: die oberen zwanzig Prozent sind die
// Arbeitsliste, alles darunter ist Grundrauschen und soll auch so aussehen.
function scoreColor(score) {
  if (score >= 75) return 'var(--color-danger)'
  if (score >= 50) return 'var(--color-warning)'
  return 'var(--color-text-muted)'
}

// Instabilitaet als Wort statt als Zahl – „0.83" beantwortet die Frage nicht, „depends on others"
// schon. Die Zahl steht daneben, für alle, die sie lesen wollen.
function instabilityLabel(i) {
  if (i == null) return 'no relations'
  if (i >= 0.8) return 'depends outward'
  if (i <= 0.2) return 'depended upon'
  return 'balanced'
}

// Auf WELCHER Seite der Hauptsequenz ein Package liegt, entscheidet die Summe – nicht eine
// Schwelle je Achse. `A + I < 1` heisst konkret UND vielbenutzt (starr, "zone of pain"),
// `A + I > 1` abstrakt UND ungenutzt. Zwei getrennte Schwellen liessen genau die Faelle
// dazwischen in die falsche Diagnose fallen (gemessen: ein Package mit I = 0.33 wurde als
// „abstract and barely used" gemeldet, obwohl es das Gegenteil ist).
function offBalanceLabel(p) {
  return p.abstractness + p.instability < 1 ? 'concrete and hard to change' : 'abstract and barely used'
}

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`
const num = (n) => (n ?? 0).toLocaleString('en-US')

// --- A/I-Diagramm -------------------------------------------------------------------------------
// Punkt = Package. x = Instabilitaet (0 links: alle haengen an ihm), y = Abstraktheit (1 oben).
// Die Hauptsequenz ist die Diagonale von oben links nach unten rechts: dort ist ein Package
// entweder abstrakt UND vielbenutzt oder konkret UND von niemandem benutzt – beides ist gesund.
// Die beiden Ecken daneben sind die Diagnosen, und genau deshalb steht das als Bild und nicht als
// Spalte in einer Tabelle: „weit weg von der Diagonale" sieht man, 0.67 muss man deuten.
const PLOT = 100
// Wie weit deckungsgleiche Punkte auseinandergerueckt werden. 2,2 von 100 liegt unter der
// Ablesegenauigkeit der Achse und ueber dem Punktradius – die Position bleibt richtig, die
// Haeufung wird sichtbar.
const SPREAD = 2.2

const plotted = computed(() => {
  const base = packages.value
    .filter((p) => p.instability != null)
    .map((p) => ({
      ...p,
      x: p.instability * PLOT,
      y: (1 - p.abstractness) * PLOT,
      // Flaeche proportional zur Klassenzahl, Radius also ueber die Wurzel – sonst wirkt ein
      // Package mit viermal so vielen Klassen sechzehnmal so schwer.
      r: 1.6 + Math.sqrt(p.classes) * 0.9,
    }))

  // ⚠️ Zwei Packages mit denselben Kennzahlen liegen auf DEMSELBEN Punkt – und dann sieht man
  // einen statt zweier. Das ist kein Randfall: A = 0 gilt fuer jedes Package ohne eine einzige
  // Schnittstelle, und I nimmt bei kleinen Packages nur wenige Werte an (0, ⅓, ½, 1). Gemessen
  // an der Demo-Codebasis: 2 von 5 Punkten deckungsgleich.
  //
  // Sie werden deshalb kreisfoermig um ihren gemeinsamen Ort verteilt – nicht zufaellig, sondern
  // nach Reihenfolge, damit dasselbe Bild bei jedem Laden dasselbe ist. Der echte Ort bleibt die
  // Mitte des Rings; die Zahlen daneben stehen ohnehin in der Tabelle.
  const groups = new Map()
  for (const p of base) {
    const key = `${Math.round(p.x)}|${Math.round(p.y)}`
    const list = groups.get(key) || []
    list.push(p)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.forEach((p, i) => {
      const angle = (i / list.length) * Math.PI * 2
      p.x += Math.cos(angle) * SPREAD
      p.y += Math.sin(angle) * SPREAD
      p.stacked = list.length
    })
  }
  return base
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- ======================= Kopfzeile ======================= -->
    <header
      class="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-5 py-3 backdrop-blur"
    >
      <div class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon icon="lucide:activity" class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <h1 class="font-mono text-base font-semibold tracking-tight text-[var(--color-text)]">Insights</h1>
          <p class="truncate text-2xs text-[var(--color-text-muted)]">
            <template v-if="totals">
              {{ num(totals.classes) }} classes · {{ num(totals.packages) }} packages ·
              {{ num(totals.relations) }} relations
            </template>
            <template v-else>What the codebase does not tell you by reading it</template>
          </p>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <button
            v-tip="'Recompute every metric from the current data'"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-40"
            :disabled="loading"
            @click="refresh"
          >
            <Icon :icon="loading ? 'lucide:loader-2' : 'lucide:refresh-cw'" class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
            Refresh
          </button>
        </div>
      </div>

      <nav class="mx-auto mt-3 flex w-full max-w-6xl flex-wrap gap-1">
        <button
          v-for="t in TABS"
          :key="t.id"
          v-tip="t.hint"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition"
          :class="tab === t.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : 'border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-offset)]'"
          @click="tab = t.id"
        >
          <Icon :icon="t.icon" class="h-3.5 w-3.5" />
          {{ t.label }}
          <span
            v-if="t.id === 'cycles' && totals && (totals.classCycles || totals.packageCycles)"
            class="rounded bg-[var(--color-danger)]/15 px-1 font-mono text-3xs text-[var(--color-danger)]"
          >
            {{ totals.classCycles + totals.packageCycles }}
          </span>
        </button>
      </nav>
    </header>

    <!-- ======================= Inhalt ======================= -->
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div class="mx-auto w-full max-w-6xl">
        <BusyState
          v-if="!data"
          variant="panel"
          title="Reading the dependency graph…"
          reason="Resolving relations, tracing cycles and ranking classes."
          :since="startedAt"
        />

        <template v-else>
          <!-- Ein leerer Bericht braucht seinen GRUND: ohne ihn liest er sich wie ein guter Befund. -->
          <div
            v-if="emptyReason"
            class="mb-5 flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3"
          >
            <Icon icon="lucide:alert-triangle" class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
            <div class="min-w-0 text-xs text-[var(--color-text)]">
              <p v-if="emptyReason === 'no-classes'" class="font-medium">No classes analysed yet.</p>
              <p v-else class="font-medium">No relations computed yet.</p>
              <p class="mt-0.5 text-[var(--color-text-muted)]">
                <template v-if="emptyReason === 'no-classes'">
                  Add Java code in the Code view — every number here is derived from it.
                </template>
                <template v-else>
                  Size and branching are shown below, but cycles, coupling and instability need the
                  class relations. Run “Recompute edges” in the Code view.
                </template>
              </p>
            </div>
          </div>

          <!-- Ein Deckel wird ANGESCHRIEBEN: eine still weggelassene Kante liest sich wie keine. -->
          <div
            v-if="totals.unresolved || totals.pending"
            class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-2xs text-[var(--color-text-muted)]"
          >
            <span v-if="totals.unresolved" class="inline-flex items-center gap-1.5">
              <Icon icon="lucide:unlink" class="h-3.5 w-3.5" />
              {{ num(totals.unresolved) }} relations skipped — their class could not be identified
              (two classes share a name, and the edge predates package-aware storage).
            </span>
            <span v-if="totals.pending" class="inline-flex items-center gap-1.5">
              <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 animate-spin" />
              {{ num(totals.pending) }} classes still being measured — refresh in a moment.
            </span>
          </div>

          <!-- ==================== Overview ==================== -->
          <section v-if="tab === 'overview'" class="space-y-5">
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div
                v-for="k in [
                  { label: 'Classes', value: num(totals.classes), icon: 'lucide:box' },
                  { label: 'Packages', value: num(totals.packages), icon: 'lucide:package' },
                  { label: 'Relations', value: num(totals.relations), icon: 'lucide:share-2' },
                  { label: 'Code lines', value: num(totals.loc), icon: 'lucide:code-2' },
                  { label: 'Branches', value: num(totals.complexity), icon: 'lucide:git-fork' },
                  { label: 'Cycles', value: num(totals.classCycles + totals.packageCycles), icon: 'lucide:repeat' },
                ]"
                :key="k.label"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5"
              >
                <p class="flex items-center gap-1.5 text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon :icon="k.icon" class="h-3 w-3" />
                  {{ k.label }}
                </p>
                <p class="mt-1 font-mono text-lg font-semibold text-[var(--color-text)]">{{ k.value }}</p>
              </div>
            </div>

            <div class="grid gap-3 lg:grid-cols-3">
              <!-- Zyklen -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'cycles'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:repeat" class="h-3.5 w-3.5" /> Tangles
                </p>
                <p v-if="totals.packageCycles || totals.classCycles" class="mt-2 text-sm text-[var(--color-text)]">
                  <span class="font-mono text-xl font-semibold text-[var(--color-danger)]">{{ totals.packageCycles }}</span>
                  package {{ totals.packageCycles === 1 ? 'cycle' : 'cycles' }},
                  <span class="font-mono font-semibold">{{ totals.classCycles }}</span> between classes.
                </p>
                <p v-else class="mt-2 text-sm text-[var(--color-text)]">
                  No dependency loops — every relation points one way.
                </p>
                <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  A package cycle means neither side can be built, tested or understood alone.
                </p>
              </button>

              <!-- Brandherd -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'hotspots'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:flame" class="h-3.5 w-3.5" /> Hottest class
                </p>
                <p v-if="ranked[0]" class="mt-2 truncate font-mono text-sm font-semibold text-[var(--color-text)]">
                  {{ ranked[0].className }}
                </p>
                <p v-if="ranked[0]" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  {{ num(ranked[0].loc) }} code lines · {{ num(ranked[0].complexity) }} branches ·
                  {{ ranked[0].fanIn + ranked[0].fanOut }} neighbours
                </p>
              </button>

              <!-- Hauptsequenz -->
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left transition hover:border-[var(--color-border-strong)]"
                @click="tab = 'packages'"
              >
                <p class="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:target" class="h-3.5 w-3.5" /> Furthest off balance
                </p>
                <template v-if="worstPackage">
                  <p class="mt-2 truncate font-mono text-sm font-semibold text-[var(--color-text)]">
                    {{ worstPackage.path }}
                  </p>
                  <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                    {{ pct(worstPackage.distance) }} off the main sequence — {{ offBalanceLabel(worstPackage) }}
                  </p>
                </template>
                <p v-else class="mt-2 text-2xs text-[var(--color-text-muted)]">
                  Needs relations between packages.
                </p>
              </button>
            </div>

            <!-- Die Uebersicht endet nicht bei der Bilanz: „wo fange ich an?" ist die Frage, mit
                 der man herkommt, und fuenf Zeilen beantworten sie, ohne einen Reiter zu wechseln. -->
            <div v-if="ranked.length">
              <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                <Icon icon="lucide:flame" class="h-3.5 w-3.5" /> Where to start
              </h2>
              <ul class="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <li v-for="c in ranked.slice(0, 5)" :key="c.id">
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--color-surface-offset)]"
                    @click="openClass(c.id)"
                  >
                    <span class="w-6 shrink-0 text-right font-mono text-2xs" :style="{ color: scoreColor(c.score) }">
                      {{ c.score }}
                    </span>
                    <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                      <span class="block h-full rounded-full" :style="{ width: `${c.score}%`, background: scoreColor(c.score) }" />
                    </span>
                    <span class="min-w-0 flex-1 truncate">
                      <span class="font-mono text-xs text-[var(--color-text)]">{{ c.className }}</span>
                      <span class="ml-1.5 text-2xs text-[var(--color-text-muted)]">{{ c.package }}</span>
                    </span>
                    <span class="shrink-0 font-mono text-2xs text-[var(--color-text-muted)]">
                      {{ num(c.loc) }} lines · {{ num(c.complexity) }} branches · {{ c.fanIn + c.fanOut }} neighbours
                    </span>
                    <Icon icon="lucide:arrow-right" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  </button>
                </li>
              </ul>
            </div>
          </section>

          <!-- ==================== Cycles ==================== -->
          <section v-else-if="tab === 'cycles'" class="space-y-6">
            <div v-if="!cycles.packages.length && !cycles.classes.length" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center">
              <Icon icon="lucide:check-circle" class="mx-auto h-6 w-6 text-[var(--color-success)]" />
              <p class="mt-2 text-sm text-[var(--color-text)]">No cycles found.</p>
              <p class="mt-1 text-2xs text-[var(--color-text-muted)]">
                Every dependency points one way — packages and classes can be read in isolation.
              </p>
            </div>

            <template v-else>
              <!-- Package-Zyklen zuerst: sie treffen die Architektur, nicht eine Datei. -->
              <div v-if="cycles.packages.length">
                <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:package" class="h-3.5 w-3.5" />
                  Package cycles
                  <span class="font-mono normal-case">({{ cycles.packages.length }})</span>
                </h2>
                <div class="space-y-2">
                  <article
                    v-for="(c, i) in cycles.packages"
                    :key="`p${i}`"
                    class="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-surface-2)] p-3"
                  >
                    <div class="flex flex-wrap items-center gap-1.5">
                      <template v-for="(p, k) in c.chainLabels" :key="k">
                        <button
                          type="button"
                          class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          @click="openPackage(p)"
                        >
                          {{ p }}
                        </button>
                        <Icon v-if="k < c.chainLabels.length - 1" icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                      </template>
                    </div>
                    <p v-if="c.weakest" class="mt-2 flex items-center gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="h-3.5 w-3.5 text-[var(--color-warning)]" />
                      Easiest cut:
                      <span class="font-mono text-[var(--color-text)]">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                      <span>({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                    </p>
                    <p v-if="c.size > c.chainLabels.length - 1" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                      Part of a group of {{ c.size }} packages that all reach each other.
                    </p>
                  </article>
                </div>
              </div>

              <div v-if="cycles.classes.length">
                <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  <Icon icon="lucide:box" class="h-3.5 w-3.5" />
                  Class cycles
                  <span class="font-mono normal-case">({{ cycles.classes.length }})</span>
                </h2>
                <div class="space-y-2">
                  <article
                    v-for="(c, i) in cycles.classes"
                    :key="`c${i}`"
                    class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                  >
                    <div class="flex flex-wrap items-center gap-1.5">
                      <template v-for="(name, k) in c.chainLabels" :key="k">
                        <button
                          type="button"
                          class="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          @click="openClass(c.chain[k])"
                        >
                          {{ name }}
                        </button>
                        <Icon v-if="k < c.chainLabels.length - 1" icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-text-muted)]" />
                      </template>
                    </div>
                    <p v-if="c.weakest" class="mt-2 flex items-center gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="h-3.5 w-3.5 text-[var(--color-warning)]" />
                      Easiest cut:
                      <span class="font-mono text-[var(--color-text)]">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                      <span>({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                    </p>
                    <p v-if="c.size > c.chainLabels.length - 1" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                      Part of a group of {{ c.size }} classes that all reach each other.
                    </p>
                  </article>
                </div>
              </div>
            </template>
          </section>

          <!-- ==================== Hotspots ==================== -->
          <section v-else-if="tab === 'hotspots'" class="space-y-3">
            <p class="text-2xs text-[var(--color-text-muted)]">
              Size, branching and coupling, each as a rank against every other class.
              <template v-if="totals.hasChurn">
                How often a class was re-imported lifts the score on top of that.
              </template>
              <template v-else>
                Change frequency would lift the score further — it starts counting once a class is
                imported a second time.
              </template>
            </p>

            <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
              <table class="w-full min-w-[42rem] border-collapse text-xs">
                <thead>
                  <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    <th class="px-3 py-2 font-medium">Score</th>
                    <th class="px-3 py-2 font-medium">Class</th>
                    <th class="px-3 py-2 text-right font-medium">Code lines</th>
                    <th class="px-3 py-2 text-right font-medium">Branches</th>
                    <th class="px-3 py-2 text-right font-medium">In / Out</th>
                    <th v-if="totals.hasChurn" class="px-3 py-2 text-right font-medium">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="c in hotspots"
                    :key="c.id"
                    class="cursor-pointer border-b border-[var(--color-border)] last:border-0 transition hover:bg-[var(--color-surface-offset)]"
                    @click="openClass(c.id)"
                  >
                    <td class="px-3 py-1.5">
                      <div class="flex items-center gap-2">
                        <span class="w-6 shrink-0 text-right font-mono text-2xs" :style="{ color: scoreColor(c.score) }">
                          {{ c.score }}
                        </span>
                        <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-offset)]">
                          <span class="block h-full rounded-full" :style="{ width: `${c.score}%`, background: scoreColor(c.score) }" />
                        </span>
                      </div>
                    </td>
                    <td class="px-3 py-1.5">
                      <span class="font-mono text-[var(--color-text)]">{{ c.className }}</span>
                      <span class="ml-1.5 text-2xs text-[var(--color-text-muted)]">{{ c.package }}</span>
                      <span
                        v-if="c.cycle != null"
                        v-tip="'This class sits in a dependency cycle'"
                        class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-3xs text-[var(--color-danger)]"
                      >
                        <Icon icon="lucide:repeat" class="h-2.5 w-2.5" /> cycle
                      </span>
                    </td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.loc) }}</td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(c.complexity) }}</td>
                    <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ c.fanIn }} / {{ c.fanOut }}</td>
                    <td v-if="totals.hasChurn" class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ c.churn }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <button
              v-if="ranked.length > TOP_N"
              type="button"
              class="text-2xs text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
              @click="showAllHotspots = !showAllHotspots"
            >
              {{ showAllHotspots ? `Show top ${TOP_N} only` : `Show all ${num(ranked.length)} classes` }}
            </button>
          </section>

          <!-- ==================== Packages ==================== -->
          <section v-else class="space-y-5">
            <div v-if="!plotted.length" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-8 text-center text-2xs text-[var(--color-text-muted)]">
              Abstractness against instability needs relations between packages.
            </div>

            <div v-else class="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <!-- Das Bild: eine Diagonale und zwei Ecken. -->
              <figure class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
                <svg viewBox="-14 -10 128 128" class="w-full" role="img" aria-label="Abstractness against instability">
                  <!-- Zonen zuerst, damit die Punkte darauf liegen -->
                  <rect x="0" y="70" width="30" height="30" fill="var(--color-danger)" opacity="0.09" />
                  <rect x="70" y="0" width="30" height="30" fill="var(--color-text-muted)" opacity="0.09" />
                  <!-- Beschriftung an der INNEREN Kante ihrer Zone: an der aeusseren stand sie auf
                       der Achse, und genau dort liegen die Punkte mit A = 0 bzw. I = 1. -->
                  <text x="2" y="67" class="plot-zone" fill="var(--color-danger)">zone of pain</text>
                  <text x="98" y="36" text-anchor="end" class="plot-zone" fill="var(--color-text-muted)">zone of uselessness</text>

                  <line x1="0" y1="0" x2="100" y2="100" stroke="var(--color-border-strong)" stroke-width="0.7" stroke-dasharray="3 2" />
                  <rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--color-border)" stroke-width="0.7" />

                  <circle
                    v-for="p in plotted"
                    :key="p.path"
                    v-tip="`${p.path} — ${p.classes} classes, I=${p.instability}, A=${p.abstractness}, D=${p.distance}`"
                    :cx="p.x"
                    :cy="p.y"
                    :r="p.r"
                    :fill="p.cycle != null ? 'var(--color-danger)' : 'var(--color-accent)'"
                    fill-opacity="0.55"
                    :stroke="p.cycle != null ? 'var(--color-danger)' : 'var(--color-accent)'"
                    stroke-width="0.6"
                    class="cursor-pointer transition-[fill-opacity] hover:fill-opacity-90"
                    @click="openPackage(p.path)"
                  />

                  <text x="50" y="112" text-anchor="middle" class="plot-axis">instability →</text>
                  <text x="-6" y="50" text-anchor="middle" class="plot-axis" transform="rotate(-90 -6 50)">abstractness →</text>
                </svg>
                <figcaption class="mt-2 text-3xs leading-relaxed text-[var(--color-text-muted)]">
                  On the dashed line a package is either abstract and widely used, or concrete and
                  used by nobody. Bottom left is rigid and concrete — everything depends on it and
                  it cannot be extended. Top right is abstract with nobody to serve.
                </figcaption>
              </figure>

              <!-- Die Tabelle: dieselben Zahlen, nur lesbar. -->
              <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                <table class="w-full min-w-[30rem] border-collapse text-xs">
                  <thead>
                    <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                      <th class="px-3 py-2 font-medium">Package</th>
                      <th class="px-3 py-2 text-right font-medium">Classes</th>
                      <th class="px-3 py-2 text-right font-medium">In / Out</th>
                      <th class="px-3 py-2 text-right font-medium">I</th>
                      <th class="px-3 py-2 text-right font-medium">A</th>
                      <th class="px-3 py-2 text-right font-medium">D</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="p in packages"
                      :key="p.path"
                      class="cursor-pointer border-b border-[var(--color-border)] last:border-0 transition hover:bg-[var(--color-surface-offset)]"
                      @click="openPackage(p.path)"
                    >
                      <td class="px-3 py-1.5">
                        <span class="font-mono text-[var(--color-text)]">{{ p.path }}</span>
                        <span
                          v-if="p.cycle != null"
                          v-tip="'This package sits in a cycle'"
                          class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-3xs text-[var(--color-danger)]"
                        >
                          <Icon icon="lucide:repeat" class="h-2.5 w-2.5" /> cycle
                        </span>
                        <span class="ml-1.5 text-3xs text-[var(--color-text-muted)]">{{ instabilityLabel(p.instability) }}</span>
                      </td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ num(p.classes) }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.ca }} / {{ p.ce }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.instability ?? '–' }}</td>
                      <td class="px-3 py-1.5 text-right font-mono text-[var(--color-text-muted)]">{{ p.abstractness }}</td>
                      <td
                        class="px-3 py-1.5 text-right font-mono"
                        :style="{ color: p.distance != null && p.distance > 0.6 ? 'var(--color-danger)' : 'var(--color-text-muted)' }"
                      >
                        {{ p.distance ?? '–' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/style.css";

/* Beschriftungen im SVG: die Groessen sind viewBox-Einheiten, nicht rem – das Diagramm skaliert
   als Ganzes mit seiner Breite, und eine rem-Schrift darin wuerde bei schmaler Spalte den Rahmen
   sprengen. */
.plot-axis {
  font-size: 5px;
  fill: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
}
.plot-zone {
  font-size: 4.5px;
  font-family: var(--font-mono, monospace);
}
</style>
