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

// --- Was jeder Reiter beantwortet ---------------------------------------------------------------
// ⚠️ Ohne diese Sätze ist die Ansicht ein Zahlenfeld für Leute, die Martins Metriken schon kennen.
// Sie stehen deshalb IMMER sichtbar über dem Inhalt und nicht in einem Tooltip: wer nicht weiß,
// wofür ein Reiter da ist, sucht auch keine Erklärung dazu.
//
// Zwei Ebenen: `what` beantwortet „was sehe ich hier?", `fixes` beantwortet „und was mache ich
// damit?". Die zweite ist zugeklappt – sie ist beim ersten Mal die Rettung und danach im Weg.
const EXPLAIN = {
  overview: {
    what: 'Everything here is computed from the classes you already imported — their relations, their size and how often you re-imported them. Nothing leaves this machine.',
    fixes: null,
  },
  cycles: {
    what: 'A cycle means the arrows come back: A needs B, and B needs A again. Neither side can be built, tested or read on its own, and a change in one can surface in the other.',
    fixes: [
      ['Turn one arrow around', 'Let the class being used define an interface, and have the caller depend on that instead. The dependency stays; its direction flips.'],
      ['Move the member that closes the loop', 'Usually a single method or field is the whole reason. Move it into the class that actually needs it.'],
      ['Pull the shared part out', 'If both genuinely need the same thing, it belongs in neither — give it a third class, or its own package.'],
    ],
  },
  hotspots: {
    what: 'The score is a rank, not a measurement: 78 means this class carries more weight than 78 % of the others. Weight is branching, size and how many classes hang on it.',
    fixes: [
      ['Start at the top, not at the worst file', 'The top of this list is where a change is most likely to be slow, risky, or both. A big class nobody touches is not urgent.'],
      ['Fix the driver, not the score', 'The tag on each row says what makes it heavy. Splitting a long method helps a branching problem and does nothing for a coupling one.'],
      ['Check the cycle tag', 'A heavy class inside a dependency loop is the worst combination — you cannot even test it alone.'],
    ],
  },
  packages: {
    what: 'Two things decide whether a package is cut well: how much depends on it, and how much of it is abstract. Healthy is either “used everywhere and mostly interfaces” or “depends on everything and fully concrete”. The trouble sits in between.',
    fixes: [
      ['Concrete and depended upon', 'Everything hangs on it and nothing can be extended. Extract interfaces for the parts other packages use.'],
      ['Abstract and unused', 'Interfaces nobody implements or calls. Delete what is dead, or merge it back into the package that was supposed to use it.'],
      ['Cycles first', 'A package in a loop cannot be judged on these numbers at all — break the loop, then look again.'],
    ],
  },
}
const openFixes = ref(false)

// Konkreter Vorschlag für GENAU diesen Zyklus – aus der Art der schwächsten Kante. Die drei
// allgemeinen Wege stehen oben; das hier sagt, welcher davon hier gemeint ist und mit welchen
// Namen. Ohne das bleibt „easiest cut: A → B" eine Feststellung ohne Handlung.
function cutAdvice(weakest, level = 'class') {
  if (!weakest) return ''
  const { fromLabel: a, toLabel: b, kind, count } = weakest
  // ⚠️ Auf Package-Ebene gibt es kein „Mitglied", das man verschiebt – dort ist die Kante eine
  // Bündelung vieler Klassenbeziehungen, und der Rat lautet entsprechend „such die paar Stellen".
  if (level === 'package') {
    const n = count === 1 ? 'A single relation holds' : `Only ${count} relations hold`
    return `${n} this direction. Search “p: ${b}” in the code view to find ${count === 1 ? 'it' : 'them'} — moving or inverting ${count === 1 ? 'it' : 'those'} breaks the whole loop.`
  }
  if (kind === 'uses') {
    return `${a} only needs ${b} as a type. An interface on the ${b} side — or moving that type somewhere both can see — turns this arrow around.`
  }
  if (kind === 'field') {
    return `${a} reads a field of ${b}. Hand the value in instead of reaching for it, and the dependency disappears.`
  }
  const many = count > 1 ? `${count} calls` : 'a single call'
  return `${a} makes ${many} into ${b}. Move that member to ${a}, or let ${b} hand the result over instead of being called back.`
}

// --- Der Plan zu EINEM Package-Zyklus -----------------------------------------------------------
// „Zwischen web und service liegt eine Kante" ist ein Befund. Gefragt ist: was ändere ich, was
// bringt es, und warum ausgerechnet hier. Die drei Antworten stehen deshalb zusammen und mit den
// echten Namen – sonst muss man sie sich aus vier Zahlen selbst zusammenreimen.
const openPlan = ref(null)
const togglePlan = (i) => (openPlan.value = openPlan.value === i ? null : i)

// --- Die Bilanz in drei Zeilen ------------------------------------------------------------------
// ⚠️ Vor dem Code steht, WAS sich ändert, WAS es bringt und WARUM hier – je EIN Satz, nicht je ein
// Absatz. Die ausführliche Fassung stand vorher als drei Fließtextblöcke da, und genau das ist die
// Form, in der niemand eine Entscheidung liest: die Frage „lohnt sich das?" beantwortet man an
// einer Zeile, nicht an einem Aufsatz. Wer die Begründung ausführlich will, findet sie oben unter
// „How do I fix these?".
//
// Die Richtungszeile darüber ist die eigentliche Zusammenfassung: derselbe Pfeil, einmal so und
// einmal andersherum – das sagt in einem Bild, was drei Sätze umschreiben.
function planSummary(c) {
  const w = c.weakest
  const link = w?.links?.[0]
  if (!w) return null
  const a = simple(w.fromLabel)
  const b = simple(w.toLabel)
  const moved = link?.kind === 'uses'

  return {
    // Vorher/Nachher als Pfeilrichtung. Bei einem Typbezug dreht sich nichts – der Typ zieht um.
    beforeFrom: a,
    beforeTo: b,
    afterFrom: moved ? a : b,
    afterTo: moved ? 'shared' : a,
    afterVia: moved ? b : null,
    difference: moved
      ? `${link.to} moves to a package both may use.`
      : `One interface in ${a}; ${link ? link.to : b} implements it.`,
    gain: `${a} builds and tests without ${b}.`,
    why: w.againstLayers
      ? `The only arrow running against the layers.`
      : `The cheapest cut — ${w.count === 1 ? 'one relation' : `${w.count} relations`}, a ${w.kind}.`,
  }
}

// --- Das Beispiel: wie der Umbau AUSSIEHT ------------------------------------------------------
// ⚠️ Als DIFF und nicht als fertige Datei. Was hier zählt, ist die Änderung – welche Zeile
// verschwindet, welche kommt dazu –, und die sieht man in einem vollständigen Listing gerade
// nicht. Deshalb auch kein Syntax-Highlighting: die Farbe trägt hier `-` und `+`, nicht `public`.
//
// Die Namen sind ECHT (die tragende Klasse, das tragende Mitglied, die beiden Packages); geraten
// ist nur die Signatur des neuen Interfaces – und genau das steht als Kommentar im Beispiel, statt
// so zu tun, als kenne der Bericht sie.
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : '')
const simple = (path) => String(path || '').split('.').pop()

function codeSteps(c) {
  const w = c.weakest
  const link = w?.links?.[0]
  if (!w || !link) return []
  const fromPkg = w.fromLabel
  const toPkg = w.toLabel
  const member = link.members?.[0] || ''

  // Ein reiner TYPBEZUG hat kein Mitglied, das man umkehren könnte – dort ist die Antwort, den Typ
  // dorthin zu legen, wo beide ihn sehen dürfen.
  if (link.kind === 'uses') {
    return [
      {
        title: `Move the type out of ${simple(toPkg)}`,
        file: `${toPkg}.${link.to} → a package both may depend on`,
        badge: 'move',
        lines: [
          { sign: ' ', text: `// ${link.from} only needs ${link.to} as a type, not as part of ${simple(toPkg)}.` },
          { sign: ' ', text: `// Put it where both sides may look — e.g. a shared package:` },
          { sign: '-', text: `package ${toPkg};` },
          { sign: '+', text: `package ${rootOf(fromPkg)}.shared;` },
          { sign: ' ', text: '' },
          { sign: ' ', text: `public class ${link.to} { … }` },
        ],
      },
      {
        title: `Point the import at the new home`,
        file: `${fromPkg}.${link.from}`,
        badge: 'edit',
        lines: [
          { sign: '-', text: `import ${toPkg}.${link.to};` },
          { sign: '+', text: `import ${rootOf(fromPkg)}.shared.${link.to};` },
        ],
      },
    ]
  }

  // Aufruf oder Feldzugriff: die klassische Umkehr. Das Interface gehört in das Package, das die
  // Leistung BRAUCHT – nur dadurch dreht sich der Pfeil.
  const iface = member ? `${cap(member)}Port` : `${link.to}Port`
  const field = member ? `${member}Port` : 'port'
  const call = member ? `${field}.${member}(…)` : `${field}.…`
  return [
    {
      title: `Let ${simple(fromPkg)} state what it needs`,
      file: `${fromPkg}.${iface}`,
      badge: 'new file',
      lines: [
        { sign: '+', text: `package ${fromPkg};` },
        { sign: '+', text: '' },
        { sign: '+', text: `// Copy the signature from ${link.to}.${member || '…'} — and name this` },
        { sign: '+', text: `// interface after what it DOES, not after the class it replaces.` },
        { sign: '+', text: `public interface ${iface} {` },
        { sign: '+', text: `    String ${member || 'run'}(String value);` },
        { sign: '+', text: '}' },
      ],
    },
    {
      title: `Depend on the interface, not on ${simple(toPkg)}`,
      file: `${fromPkg}.${link.from}`,
      badge: 'edit',
      lines: [
        { sign: '-', text: `import ${toPkg}.${link.to};` },
        { sign: ' ', text: '' },
        { sign: ' ', text: `public class ${link.from} {` },
        { sign: '-', text: `    private ${link.to} ${link.to[0].toLowerCase()}${link.to.slice(1)};` },
        { sign: '+', text: `    private final ${iface} ${field};` },
        { sign: '+', text: '' },
        { sign: '+', text: `    public ${link.from}(${iface} ${field}) { this.${field} = ${field}; }` },
        { sign: ' ', text: '        …' },
        { sign: '-', text: `        ${link.to[0].toLowerCase()}${link.to.slice(1)}.${member || '…'}(…);` },
        { sign: '+', text: `        ${call};` },
        { sign: ' ', text: '}' },
      ],
    },
    {
      title: `Have ${link.to} fulfil it — this is where the arrow flips`,
      file: `${toPkg}.${link.to}`,
      badge: 'edit',
      lines: [
        { sign: '+', text: `import ${fromPkg}.${iface};` },
        { sign: ' ', text: '' },
        { sign: '-', text: `public class ${link.to} {` },
        { sign: '+', text: `public class ${link.to} implements ${iface} {` },
        { sign: ' ', text: `    // unchanged` },
        { sign: ' ', text: '}' },
      ],
    },
    {
      title: 'Wire it once, where both are already known',
      file: 'your composition root (main, config, factory)',
      badge: 'edit',
      lines: [
        { sign: '+', text: `new ${link.from}(new ${link.to}());` },
        { sign: ' ', text: `// ${simple(fromPkg)} never mentions ${simple(toPkg)} again —` },
        { sign: ' ', text: `// only this one place knows both, and it sits above them.` },
      ],
    },
  ]
}

// Das Wurzel-Package (com.acme.shop aus com.acme.shop.repo) – der Ort, an dem ein geteilter Typ
// liegen kann, ohne dass eine Seite die andere sieht.
function rootOf(path) {
  const parts = String(path || '').split('.')
  return parts.length > 1 ? parts.slice(0, -1).join('.') : path
}

// Was eine Klasse schwer macht – und was man dagegen tut. Der Server nennt den Treiber, hier steht,
// was er bedeutet.
const DRIVER = {
  branching: { label: 'branching', hint: 'Many decisions in one place — split the longest method out first.' },
  size: { label: 'size', hint: 'Too much in one file — separate the responsibilities into their own classes.' },
  coupling: { label: 'coupling', hint: 'Many classes hang on it — narrow what it exposes, or split it in two.' },
  churn: { label: 'churn', hint: 'Heavy AND touched often — the most expensive combination, and the one that pays back first.' },
}
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

// Was an DIESEM Package zu tun ist. Dieselbe Unterscheidung wie bei `offBalanceLabel` – nur als
// Handlung statt als Diagnose, und nur dort gezeigt, wo die Abweichung wirklich groß ist.
function packageAdvice(p) {
  if (p.cycle != null) return 'In a cycle — break that first, these numbers cannot be judged until then.'
  return p.abstractness + p.instability < 1
    ? 'Everything hangs on it and it is all concrete — extract interfaces for what other packages use.'
    : 'Abstract, but barely used — delete what is dead, or merge it back where it was meant to be used.'
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

          <!-- ⚠️ Wofür der Reiter da ist – IMMER sichtbar, nicht im Tooltip: wer nicht weiß, was er
               sieht, sucht auch keine Erklärung dazu. Die Handlungsanleitung darunter ist
               zugeklappt: beim ersten Mal die Rettung, danach im Weg. -->
          <div class="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
            <p class="flex items-start gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              <Icon icon="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{{ EXPLAIN[tab].what }}</span>
            </p>
            <template v-if="EXPLAIN[tab].fixes">
              <button
                type="button"
                class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-[var(--color-accent)] transition hover:underline"
                @click="openFixes = !openFixes"
              >
                <Icon :icon="openFixes ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3 w-3" />
                How do I fix these?
              </button>
              <ul v-if="openFixes" class="mt-2 space-y-1.5 border-l-2 border-[var(--color-border)] pl-3">
                <li v-for="([title, body]) in EXPLAIN[tab].fixes" :key="title" class="text-2xs leading-relaxed">
                  <span class="font-medium text-[var(--color-text)]">{{ title }}</span>
                  <span class="text-[var(--color-text-muted)]"> — {{ body }}</span>
                </li>
              </ul>
            </template>
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
                  <template v-if="totals.packageCycles || totals.classCycles">
                    Each one names the easiest place to cut it. →
                  </template>
                  <template v-else>Nothing to untangle here.</template>
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
                <p v-if="ranked[0] && DRIVER[ranked[0].driver]" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                  {{ DRIVER[ranked[0].driver].hint }}
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
                    {{ offBalanceLabel(worstPackage) }} ({{ pct(worstPackage.distance) }} off balance).
                  </p>
                  <p class="mt-1 text-2xs text-[var(--color-text-muted)]">{{ packageAdvice(worstPackage) }}</p>
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
                    <!-- Nicht nur WO man schneidet, sondern WIE: „easiest cut: A → B" allein ist
                         eine Feststellung, keine Handlung. -->
                    <div v-if="c.weakest" class="mt-2 flex items-start gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                      <span class="min-w-0">
                        <span class="font-medium text-[var(--color-text)]">Easiest cut</span> —
                        <span class="font-mono">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                        <span class="opacity-70"> ({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                        <br />{{ cutAdvice(c.weakest, 'package') }}
                      </span>
                    </div>
                    <p v-if="c.size > c.chainLabels.length - 1" class="mt-1 text-2xs text-[var(--color-text-muted)]">
                      Part of a group of {{ c.size }} packages that all reach each other.
                    </p>

                    <!-- ⚠️ Der Plan ist AUFGEKLAPPT eine eigene Ebene: „was ändere ich, was bringt
                         es, warum hier" beantwortet man einmal je Zyklus – dauerhaft sichtbar wären
                         es bei sechs Zyklen sechs Aufsätze übereinander. -->
                    <button
                      type="button"
                      class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-[var(--color-accent)] transition hover:underline"
                      @click="togglePlan(i)"
                    >
                      <Icon :icon="openPlan === i ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3 w-3" />
                      {{ openPlan === i ? 'Hide the plan' : 'What should I change here?' }}
                    </button>

                    <div v-if="openPlan === i" class="mt-2 space-y-3 rounded-md bg-[var(--color-surface-offset)] p-3">
                      <!-- ⚠️ Die Zusammenfassung ZUERST und in drei Zeilen: „lohnt sich das?"
                           beantwortet man an einer Zeile, nicht an drei Absätzen. Die Richtungs-
                           zeile darüber sagt in einem Bild, was Text umschreiben müsste. -->
                      <template v-if="planSummary(c)">
                        <!-- ⚠️ Die beiden Richtungen UNTEREINANDER und in einem Raster: nebeneinander liest
                             man zwei Zeilen, untereinander SIEHT man den Pfeil sich umdrehen – und
                             das ist die ganze Zusammenfassung. -->
                        <div class="grid items-center gap-x-2 gap-y-1 font-mono text-2xs" style="grid-template-columns: max-content max-content max-content max-content 1fr">
                          <span class="text-3xs uppercase text-[var(--color-text-muted)]">now</span>
                          <span class="justify-self-end text-[var(--color-text)]">{{ planSummary(c).beforeFrom }}</span>
                          <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-danger)]" />
                          <span class="text-[var(--color-text)]">{{ planSummary(c).beforeTo }}</span>
                          <span class="text-3xs text-[var(--color-danger)]">closes the loop</span>

                          <span class="text-3xs uppercase text-[var(--color-text-muted)]">after</span>
                          <span class="justify-self-end text-[var(--color-text)]">{{ planSummary(c).afterFrom }}</span>
                          <Icon icon="lucide:arrow-right" class="h-3 w-3 text-[var(--color-success)]" />
                          <span class="text-[var(--color-text)]">
                            {{ planSummary(c).afterTo }}
                            <template v-if="planSummary(c).afterVia"> ← {{ planSummary(c).afterVia }}</template>
                          </span>
                          <span class="text-3xs text-[var(--color-success)]">no loop</span>
                        </div>

                        <dl class="grid gap-x-3 gap-y-1 text-2xs" style="grid-template-columns: max-content 1fr">
                          <dt class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">Change</dt>
                          <dd class="text-[var(--color-text)]">{{ planSummary(c).difference }}</dd>
                          <dt class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">Gain</dt>
                          <dd class="text-[var(--color-text)]">{{ planSummary(c).gain }}</dd>
                          <dt class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">Why here</dt>
                          <dd class="text-[var(--color-text-muted)]">{{ planSummary(c).why }}</dd>
                        </dl>
                      </template>

                      <!-- Was die Richtung hält – mit Namen, sonst bleibt es eine Aussage über
                           zwei Ordner. -->
                      <div v-if="c.weakest?.links?.length">
                        <p class="text-3xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                          The relation to remove
                        </p>
                        <ul class="mt-1 space-y-0.5">
                          <li v-for="l in c.weakest.links" :key="`${l.fromId}-${l.toId}`" class="text-2xs">
                            <button
                              type="button"
                              class="font-mono text-[var(--color-text)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline"
                              @click="openClass(l.fromId)"
                            >{{ l.from }}</button>
                            <span class="text-[var(--color-text-muted)]"> → </span>
                            <button
                              type="button"
                              class="font-mono text-[var(--color-text)] underline-offset-2 hover:text-[var(--color-accent)] hover:underline"
                              @click="openClass(l.toId)"
                            >{{ l.to }}</button>
                            <span class="text-[var(--color-text-muted)]">
                              ({{ l.kind }}<template v-if="l.members?.length">, {{ l.members.join(', ') }}</template>)
                            </span>
                          </li>
                        </ul>
                        <p v-if="c.weakest.more" class="mt-0.5 text-3xs text-[var(--color-text-muted)]">
                          … and {{ c.weakest.more }} more.
                        </p>
                      </div>

                      <div v-if="codeSteps(c).length">
                        <p class="text-3xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                          Step by step
                        </p>
                        <div class="mt-1 space-y-2">
                          <div v-for="(step, si) in codeSteps(c)" :key="si">
                            <p class="flex flex-wrap items-baseline gap-x-1.5 text-2xs">
                              <span class="text-[var(--color-text)]">{{ si + 1 }}. {{ step.title }}</span>
                              <span class="rounded bg-[var(--color-surface-2)] px-1 text-3xs text-[var(--color-text-muted)]">{{ step.badge }}</span>
                            </p>
                            <p class="mt-0.5 truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ step.file }}</p>
                            <pre class="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-3xs leading-relaxed"><code><span
                              v-for="(l, li) in step.lines"
                              :key="li"
                              class="block"
                              :class="l.sign === '+' ? 'text-[var(--color-success)]' : l.sign === '-' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'"
                            >{{ l.sign }} {{ l.text }}</span></code></pre>
                          </div>
                        </div>
                      </div>
                    </div>
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
                    <!-- Nicht nur WO man schneidet, sondern WIE: „easiest cut: A → B" allein ist
                         eine Feststellung, keine Handlung. -->
                    <div v-if="c.weakest" class="mt-2 flex items-start gap-1.5 text-2xs text-[var(--color-text-muted)]">
                      <Icon icon="lucide:scissors" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                      <span class="min-w-0">
                        <span class="font-medium text-[var(--color-text)]">Easiest cut</span> —
                        <span class="font-mono">{{ c.weakest.fromLabel }} → {{ c.weakest.toLabel }}</span>
                        <span class="opacity-70"> ({{ c.weakest.kind }}, {{ c.weakest.count }} {{ c.weakest.count === 1 ? 'relation' : 'relations' }})</span>
                        <br />{{ cutAdvice(c.weakest) }}
                      </span>
                    </div>
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
            <p v-if="!totals.hasChurn" class="text-2xs text-[var(--color-text-muted)]">
              Change frequency is not counted yet — it starts once a class is imported a second time.
            </p>

            <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
              <table class="w-full min-w-[42rem] border-collapse text-xs">
                <thead>
                  <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    <th class="px-3 py-2 font-medium">Score</th>
                    <th class="px-3 py-2 font-medium">Class</th>
                    <th class="px-3 py-2 font-medium">Why</th>
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
                    <!-- ⚠️ Der Treiber ist die eigentliche Auskunft: „78" sortiert nur, „branching"
                         sagt, wo man ansetzt. Eine Rangliste ohne ihn schickt jeden auf die
                         gleiche Suche. -->
                    <td class="px-3 py-1.5">
                      <span
                        v-if="DRIVER[c.driver]"
                        v-tip="DRIVER[c.driver].hint"
                        class="rounded bg-[var(--color-surface-offset)] px-1.5 py-0.5 text-3xs text-[var(--color-text-muted)]"
                      >{{ DRIVER[c.driver].label }}</span>
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
                    <!-- ⚠️ Klartext statt „I / A / D". Die Kürzel stehen klein daneben, damit sie
                         für alle, die sie kennen, noch auffindbar sind – aber niemand muss sie
                         kennen, um die Tabelle zu lesen. -->
                    <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface-offset)] text-left text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">
                      <th class="px-3 py-2 font-medium">Package</th>
                      <th class="px-3 py-2 text-right font-medium">Classes</th>
                      <th v-tip="'Classes outside that depend on this package / classes inside that depend outward'" class="px-3 py-2 text-right font-medium">
                        Used by / uses
                      </th>
                      <th v-tip="'0 = everything depends on it. 1 = it depends on everything else.'" class="px-3 py-2 text-right font-medium">
                        Depends outward <span class="normal-case opacity-60">(I)</span>
                      </th>
                      <th v-tip="'Share of interfaces, annotations and abstract classes in this package.'" class="px-3 py-2 text-right font-medium">
                        Abstract <span class="normal-case opacity-60">(A)</span>
                      </th>
                      <th v-tip="'How far the package sits from a healthy combination of the two. 0 is fine, 1 is trouble.'" class="px-3 py-2 text-right font-medium">
                        Off balance <span class="normal-case opacity-60">(D)</span>
                      </th>
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
                        <!-- Erst ab einer echten Abweichung: eine Empfehlung an jeder Zeile wäre
                             Rauschen, und die meisten Packages sind in Ordnung. -->
                        <p v-if="p.distance != null && p.distance > 0.5" class="mt-0.5 text-3xs text-[var(--color-text-muted)]">
                          {{ packageAdvice(p) }}
                        </p>
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
