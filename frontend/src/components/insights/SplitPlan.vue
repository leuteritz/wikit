<script setup>
/**
 * Wie man EINE Klasse aufteilen würde – aufklappbar unter ihrer Zeile in der Hotspot-Rangliste.
 *
 * Die Rangliste beantwortet „welche Klasse kostet mich Zeit?". Die Frage direkt dahinter lautet
 * „und was mache ich mit ihr?" – und genau dort hört ein Bericht sonst auf: „split this class" ist
 * derselbe Satz für jede Klasse und damit keine Auskunft.
 *
 * ⚠️ **Drei Schnitte, und man kann zwischen ihnen umschalten.** Der Server rechnet alle drei und
 * nennt den, der hier am besten trägt (`lead`); die anderen bleiben erreichbar, weil „welcher
 * Schnitt ist der richtige?" eine Frage ist, die man mit dem Code vor Augen anders beantworten darf
 * als eine Rechnung. Ein Schnitt, der hier nichts hergibt, sagt WARUM – ein leerer Reiter ohne
 * Grund liest sich wie „mit dieser Klasse ist alles in Ordnung".
 *
 * ⚠️ **Die Bilanz steht ZUERST und in je einer Zeile** – dieselbe Regel wie in `CyclePlan`:
 * „lohnt sich das?" beantwortet man an einer Zeile, nicht an einem Aufsatz. Erst darunter kommen
 * die Teile, und erst danach der Code.
 *
 * Die Namen der Teile sind der einzige GERATENE Teil und werden als solcher angeschrieben – alles
 * andere (Mitglieder, Felder, Nutzer, Zeilen) steht so im Code.
 */
import { computed, ref, watch } from 'vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'
import { api } from '../../lib/api.js'
import BusyState from '../BusyState.vue'

const props = defineProps({
  fileId: { type: Number, required: true },
  driver: { type: String, default: '' },
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['open-class'])

const plan = ref(null)
const loading = ref(false)
const startedAt = ref(0)
// Welchen Schnitt der Nutzer angesehen hat. `null` = „noch nicht gewählt" und heißt: der geführte.
// Als eigener Ref und nicht als Vorbelegung, damit eine neue Antwort den geführten wieder zeigt,
// eine bewusste Wahl aber stehen bleibt.
const picked = ref(null)

// ⚠️ Nachladen hängt an den DATEN, nicht am blossen „ist offen?": geladen wird, sobald diese Zeile
// offen ist UND eine Klasse trägt. Ein überholter Lauf (schnell auf- und wieder zugeklappt, andere
// Zeile) wird über das Token verworfen – sonst schriebe die erste Antwort in die zweite Karte.
let token = 0
watch(
  () => (props.open ? props.fileId : null),
  async (id) => {
    if (!id) return
    if (plan.value?.class?.id === id) return
    const mine = ++token
    loading.value = true
    startedAt.value = Date.now()
    plan.value = null
    picked.value = null
    try {
      const res = await api.getSplitPlan(id, props.driver)
      if (mine === token) plan.value = res
    } finally {
      if (mine === token) loading.value = false
    }
  },
  { immediate: true },
)

const strategies = computed(() => plan.value?.strategies || [])
const active = computed(
  () =>
    strategies.value.find((s) => s.id === picked.value) ||
    strategies.value.find((s) => s.id === plan.value?.lead) ||
    strategies.value[0] ||
    null,
)

// Icon und Kurzwort je Schnitt. Das Wort steht am Chip, der Satz steht in der Karte – zwei Zeilen
// nebeneinander wären dieselbe Aussage zweimal.
const STRATEGY = {
  cohesion: { icon: 'lucide:layers', short: 'by state' },
  roles: { icon: 'lucide:users', short: 'by callers' },
  branching: { icon: 'lucide:git-fork', short: 'by method' },
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : '')
const low = (w) => (w ? w[0].toLowerCase() + w.slice(1) : '')
const num = (n) => (n ?? 0).toLocaleString('en-US')
// Die Mehrzahl steht daneben, statt ein „s" anzuhängen: „1 branchs" ist die Sorte Fehler, die eine
// sonst sorgfältige Ansicht billig aussehen lässt (gleiche Regel wie `plural` in der InsightsView).
const plural = (n, word, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`

// Was in der Bilanz hinter einem Teil steht – und das ist je Schnitt etwas ANDERES. „3 methods"
// ist beim Zustands-Schnitt die Aussage (so viel wandert), beim Rollen-Schnitt nicht (dort wandert
// nichts, es wird nur weniger sichtbar) und beim Verzweigungs-Schnitt schon gar nicht (dort geht es
// um eine einzige Methode). Eine Zeile für alle drei wäre in zwei Fällen daneben.
function partMeta(p, strategyId) {
  if (strategyId === 'roles') return `${plural(p.memberCount, 'method')} it exposes`
  if (strategyId === 'branching') return plural(p.complexity, 'branch', 'branches')
  const fields = p.fields.length ? `, ${plural(p.fields.length, 'field')}` : ''
  return `${plural(p.memberCount, 'method')}${fields}`
}

// --- Die Code-Fenster ---------------------------------------------------------------------------
// ⚠️ ZWEI FENSTER (vorher · nachher), kein Diff – dieselbe Begründung wie in `CyclePlan`: ein Diff
// setzt voraus, dass man Diffs liest. Die geänderten Zeilen sind markiert, ohne Syntax-Highlighting
// (die Farbe trägt hier die Änderung, nicht `public`), und mit den echten Namen.
const L = (text, hit = false) => ({ text, hit })

const steps = computed(() => {
  const s = active.value
  const c = plan.value?.class
  if (!s || !c || !s.parts.length) return []
  if (s.id === 'cohesion') return cohesionSteps(s, c)
  if (s.id === 'roles') return roleSteps(s, c)
  return branchingSteps(s, c)
})

function cohesionSteps(s, c) {
  const part = s.parts[0]
  const rest = s.parts.slice(1).map((p) => p.name)
  const shared = s.shared.slice(0, 2)
  const field = low(part.name)
  const method = part.members[0]?.name || 'run'
  const own = part.fields.slice(0, 3)

  return [
    {
      title: `Give ${part.name} its own file`,
      why: `These ${part.memberCount} methods only work on ${own.length ? own.map((f) => f.name).join(', ') : 'their own data'}. A class is a bundle of fields plus the methods that use them — that is exactly what this group already is.`,
      file: `${c.package ? `${c.package}.` : ''}${part.name}`,
      before: [L('// this file does not exist yet')],
      after: [
        ...(c.package ? [L(`package ${c.package};`, true), L('')] : []),
        L(`public class ${part.name} {`, true),
        ...own.map((f) => L(`    private final ${f.type} ${f.name};`, true)),
        ...(shared.length ? [L(''), L('    // handed in — the other part needs these too', true)] : []),
        ...shared.map((f) => L(`    private final ${f.type} ${f.name};`, true)),
        L(''),
        ...part.members.slice(0, 3).map((m) => L(`    public ${m.signature} { … }`)),
        ...(part.memberCount > 3 ? [L(`    // … ${part.memberCount - 3} more, moved unchanged`)] : []),
        L('}', true),
      ],
    },
    {
      title: `${c.className} keeps the rest and asks for it`,
      why: `${c.className} stops holding ${own.length ? own.map((f) => f.name).join(', ') : 'that data'} itself. It gets ${part.name} handed in, so it only knows what it can ask for — not how it is done.`,
      file: `${c.package ? `${c.package}.` : ''}${c.className}`,
      before: [
        L(`public class ${c.className} {`),
        ...own.map((f) => L(`    private final ${f.type} ${f.name};`, true)),
        ...shared.map((f) => L(`    private final ${f.type} ${f.name};`)),
        L(''),
        L(`    public ${part.members[0]?.signature || `void ${method}()`} { … }`, true),
        L(`    // … ${c.methods} methods in total`),
        L('}'),
      ],
      after: [
        L(`public class ${c.className} {`),
        ...shared.map((f) => L(`    private final ${f.type} ${f.name};`)),
        L(`    private final ${part.name} ${field};`, true),
        L(''),
        L(`    public ${c.className}(${part.name} ${field}) {`, true),
        L(`        this.${field} = ${field};`, true),
        L('    }'),
        L(''),
        L(`    // whoever needed ${method} now asks ${field} for it`, true),
        L(`    // … ${Math.max(0, c.methods - part.memberCount)} methods left here`),
        L('}'),
      ],
    },
    {
      title: 'Build it once, where the program starts',
      why: `Somebody still has to create both${rest.length ? ` (and ${rest.join(', ')})` : ''}. Do it in your main, config or factory — that place may know every part, because nothing depends on it.`,
      file: 'your main / config / factory',
      before: [L(`// one object did all of it`), L(`${c.className} x = new ${c.className}();`, true)],
      after: [
        L('// each part built on its own, then handed over'),
        L(`${part.name} ${field} = new ${part.name}(${shared.map((f) => f.name).join(', ')});`, true),
        L(`${c.className} x = new ${c.className}(${field});`, true),
      ],
    },
  ]
}

function roleSteps(s, c) {
  const [a, b] = s.parts
  const user = a.reason.split(',')[0].split(' ')[0] || 'Caller'
  const sig = a.members[0]?.signature || 'void run()'

  return [
    {
      title: `Write down what each side actually uses`,
      why: `An interface is just a list of method names — no code inside. One per group of callers, and each one holds only the methods that group really calls.`,
      file: `${c.package ? `${c.package}.` : ''}${a.name}`,
      before: [L('// these files do not exist yet')],
      after: [
        ...(c.package ? [L(`package ${c.package};`, true), L('')] : []),
        L(`public interface ${a.name} {`, true),
        ...a.members.slice(0, 4).map((m) => L(`    ${m.signature};`, true)),
        ...(a.memberCount > 4 ? [L(`    // … ${a.memberCount - 4} more`)] : []),
        L('}', true),
        L(''),
        L(`public interface ${b?.name || 'OtherApi'} {`, true),
        ...(b?.members || []).slice(0, 3).map((m) => L(`    ${m.signature};`, true)),
        L('}', true),
      ],
    },
    {
      title: `${c.className} keeps every line and only adds "implements"`,
      why: `Nothing inside the class moves. It simply says which of the two lists it can serve — and it can serve both, because it already does.`,
      file: `${c.package ? `${c.package}.` : ''}${c.className}`,
      before: [L(`public class ${c.className} {`), L(`    public ${sig} { … }`), L(`    // … ${c.publicMethods} public methods`), L('}')],
      after: [
        L(`public class ${c.className} implements ${a.name}, ${b?.name || 'OtherApi'} {`, true),
        L('    @Override', true),
        L(`    public ${sig} { … }`),
        L(`    // … ${c.publicMethods} public methods, unchanged`),
        L('}'),
      ],
    },
    {
      title: `${user} asks for the smaller list`,
      why: `From now on ${user} names ${a.name} instead of ${c.className}. Adding a method for somebody else stops being a change ${user} can even see — and a test can hand in a three-line stand-in.`,
      file: `${c.package ? `${c.package}.` : ''}${user}`,
      before: [
        L(`public class ${user} {`),
        L(`    private final ${c.className} ${low(c.className)};`, true),
        L(`    // sees all ${c.publicMethods} methods, uses ${a.memberCount}`, true),
        L('}'),
      ],
      after: [
        L(`public class ${user} {`),
        L(`    private final ${a.name} ${low(a.name)};`, true),
        L(`    // sees exactly the ${a.memberCount} it calls`, true),
        L('}'),
      ],
    },
  ]
}

function branchingSteps(s, c) {
  const part = s.parts[0]
  const worst = part.members[0]
  const name = worst?.name || 'run'
  const dispatch = /dispatch/i.test(s.why)

  if (dispatch) {
    return [
      {
        title: 'One name for "handles a case"',
        why: 'Every case in that switch does the same kind of job on different data. Written down as an interface, each case can become its own small class.',
        file: `${c.package ? `${c.package}.` : ''}${part.name}`,
        before: [L('// this file does not exist yet')],
        after: [
          L(`public interface ${part.name} {`, true),
          L('    boolean handles(String kind);', true),
          L('    void handle(Input input);', true),
          L('}', true),
        ],
      },
      {
        title: `${name} stops deciding and starts picking`,
        why: `The method keeps its name and its callers. What disappears is the chain of cases — it asks the list who can do the job instead of knowing every answer itself.`,
        file: `${c.package ? `${c.package}.` : ''}${c.className}`,
        before: [
          L(`    ${worst?.signature || `void ${name}()`} {`),
          L('        switch (kind) {', true),
          L('            case "a": … break;', true),
          L('            case "b": … break;', true),
          L(`            // … ${worst?.complexity || 0} branches in total`, true),
          L('        }'),
          L('    }'),
        ],
        after: [
          L(`    private final List<${part.name}> handlers;`, true),
          L(''),
          L(`    ${worst?.signature || `void ${name}()`} {`),
          L('        handlers.stream()', true),
          L('            .filter(h -> h.handles(kind))', true),
          L('            .findFirst().orElseThrow()', true),
          L('            .handle(input);', true),
          L('    }'),
        ],
      },
      {
        title: 'A new case becomes a new file',
        why: 'This is the whole point: from here on, adding a case does not touch a line that already works — so it cannot break one either.',
        file: `${c.package ? `${c.package}.` : ''}ACase`,
        before: [L(`// add another "case" inside ${name}`), L('case "c": … break;', true)],
        after: [
          L(`public class ACase implements ${part.name} {`, true),
          L('    public boolean handles(String kind) { return "c".equals(kind); }', true),
          L('    public void handle(Input input) { … }', true),
          L('}', true),
        ],
      },
    ]
  }

  return [
    {
      title: `Name the steps inside ${name}`,
      why: `${worst?.complexity || 0} branches in ${part.loc} lines means you have to read all of it to know what any of it does. Every block that you would put a comment above is a method waiting for a name.`,
      file: `${c.package ? `${c.package}.` : ''}${c.className}`,
      before: [
        L(`    ${worst?.signature || `void ${name}()`} {`),
        L('        // check the input', true),
        L('        if (…) { … }', true),
        L('        // work out the result', true),
        L('        for (…) { if (…) … }', true),
        L('        // write it back', true),
        L('        if (…) { … }', true),
        L('    }'),
      ],
      after: [
        L(`    ${worst?.signature || `void ${name}()`} {`),
        L('        validate(input);', true),
        L('        Result result = calculate(input);', true),
        L('        store(result);', true),
        L('    }'),
        L(''),
        L('    private void validate(Input input) { … }', true),
        L('    private Result calculate(Input input) { … }', true),
        L('    private void store(Result result) { … }', true),
      ],
    },
    {
      title: 'Then look again',
      why: `Once the steps have names, the groups become visible: if validate and store never touch the same fields, that is a split along the state — and the "${STRATEGY.cohesion.short}" tab can say so with the real numbers.`,
      file: 'nothing to change yet',
      before: [L(`// one method, ${worst?.complexity || 0} branches`)],
      after: [L(`// ${'3'} methods, each one readable on its own`), L('// and now measurable separately', true)],
    },
  ]
}
</script>

<template>
  <div class="border-t border-[var(--color-border)] bg-[var(--color-surface-offset)] px-3 py-3">
    <BusyState
      v-if="loading"
      variant="inline"
      title="Working out how this class comes apart…"
      reason="Reading the method bodies, grouping them by the fields they touch."
      :since="startedAt"
    />

    <div v-else-if="!plan" class="text-2xs text-[var(--color-text-muted)]">
      The split plan could not be computed for this class.
    </div>

    <template v-else>
      <!-- ⚠️ „Kein Vorschlag" ist ein ERGEBNIS und steht deshalb ganz oben, mit Haken und nicht
           mit Warnfarbe: eine Klasse kann groß sein und trotzdem genau eine Sache tun. Ohne diesen
           Satz sähen drei leere Schnitte darunter wie ein Fehler der Rechnung aus. -->
      <div
        v-if="plan.summary"
        class="mb-3 flex items-start gap-2 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 px-3 py-2"
      >
        <Icon icon="lucide:check-circle" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" />
        <p class="max-w-3xl text-2xs leading-relaxed text-[var(--color-text)]">{{ plan.summary }}</p>
      </div>

      <!-- ⚠️ Die Bilanz ZUERST: „was wird daraus?" beantwortet man an zwei Zeilen. Untereinander
           und in einem Raster, damit man den Umbau SIEHT statt ihn zu lesen (gleiche Bauart wie
           die Richtungszeile in `CyclePlan`). -->
      <div v-if="active && active.parts.length" class="grid items-baseline gap-x-3 gap-y-1 font-mono text-2xs" style="grid-template-columns: max-content 1fr">
        <span class="text-3xs uppercase text-[var(--color-text-muted)]">now</span>
        <span class="text-[var(--color-text)]">
          {{ plan.class.className }}
          <span class="text-[var(--color-text-muted)]">
            · {{ num(plan.class.loc) }} lines · {{ num(plan.class.methods) }} methods ·
            {{ num(plan.class.fields) }} fields<template v-if="plan.class.callers">
              · {{ num(plan.class.callers) }} callers</template>
          </span>
        </span>

        <span class="text-3xs uppercase text-[var(--color-text-muted)]">after</span>
        <span class="min-w-0">
          <span v-for="(p, i) in active.parts" :key="p.name" class="block text-[var(--color-text)]">
            <Icon icon="lucide:corner-down-right" class="mr-1 inline h-3 w-3 text-[var(--color-success)]" />
            {{ p.name }}
            <span class="text-[var(--color-text-muted)]">· {{ partMeta(p, active.id) }}</span>
            <!-- ⚠️ Ein geratener Name wird ANGESCHRIEBEN. Er ist das einzige am Vorschlag, das
                 nicht im Code steht – ihn stillschweigend hinzuschreiben hiesse behaupten, die
                 Rechnung habe ihn gefunden. -->
            <span
              v-if="p.nameGuessed"
              v-tip="'No word in these members carries the group — pick a name that fits, this one is only a placeholder.'"
              class="ml-1 rounded bg-[var(--color-surface)] px-1 text-3xs text-[var(--color-text-muted)]"
              >name is a placeholder</span
            >
            <span v-else-if="i === 0" class="ml-1 text-3xs text-[var(--color-text-muted)]">(name suggested from its members)</span>
          </span>
          <span v-if="active.shared.length" class="mt-0.5 block text-[var(--color-text-muted)]">
            shared: {{ active.shared.slice(0, 4).map((s) => s.name).join(', ')
            }}<template v-if="active.shared.length > 4"> and {{ active.shared.length - 4 }} more</template>
          </span>
        </span>
      </div>

      <!-- Die drei Schnitte. Der geführte steht zuerst; einer, der hier nichts hergibt, bleibt
           anklickbar und sagt seinen Grund – ein ausgegrauter Knopf ohne Antwort wäre schlechter
           als der Satz dahinter. -->
      <div class="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          v-for="s in strategies"
          :key="s.id"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs font-medium transition"
          :class="active && active.id === s.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'"
          @click="picked = s.id"
        >
          <Icon :icon="STRATEGY[s.id].icon" class="h-3 w-3" />
          {{ STRATEGY[s.id].short }}
          <span
            v-if="s.verdict === 'none'"
            class="rounded bg-[var(--color-surface)] px-1 text-3xs opacity-70"
          >—</span>
          <span
            v-else-if="s.id === plan.lead"
            class="rounded bg-[var(--color-success)]/15 px-1 text-3xs text-[var(--color-success)]"
          >best fit</span>
        </button>
      </div>

      <template v-if="active">
        <p class="mt-2.5 text-sm font-medium leading-snug text-[var(--color-text)]">{{ active.headline }}</p>
        <p class="mt-0.5 max-w-3xl text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ active.why }}</p>

        <!-- Die Teile mit ihren echten Mitgliedern. Ohne sie bliebe „zwei Gruppen" eine Behauptung. -->
        <div v-if="active.parts.length" class="mt-3 grid gap-2 lg:grid-cols-2">
          <article
            v-for="p in active.parts"
            :key="p.name"
            class="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5"
          >
            <p class="flex items-baseline gap-1.5">
              <Icon icon="lucide:box" class="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
              <span class="truncate font-mono text-xs font-semibold text-[var(--color-text)]">{{ p.name }}</span>
              <span class="shrink-0 font-mono text-3xs text-[var(--color-text-muted)]">
                <template v-if="p.loc">{{ num(p.loc) }} lines · </template>{{ num(p.complexity) }} branches
              </span>
            </p>
            <p class="mt-1 text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ p.reason }}</p>

            <ul v-if="p.fields.length" class="mt-1.5 flex flex-wrap gap-1">
              <li
                v-for="f in p.fields"
                :key="f.name"
                class="rounded bg-[var(--color-accent-soft)] px-1 font-mono text-3xs text-[var(--color-accent)]"
              >
                {{ f.type }} {{ f.name }}
              </li>
            </ul>

            <ul class="mt-1.5 space-y-0.5">
              <li v-for="m in p.members" :key="m.name" class="flex items-baseline gap-1.5 font-mono text-3xs">
                <span class="min-w-0 flex-1 truncate text-[var(--color-text)]">{{ m.signature }}</span>
                <span v-if="m.complexity" class="shrink-0 text-[var(--color-text-muted)]">{{ m.complexity }} br</span>
                <span v-if="m.line" class="w-8 shrink-0 text-right text-[var(--color-text-muted)]">:{{ m.line }}</span>
              </li>
            </ul>
            <p v-if="p.moreMembers" class="mt-0.5 text-3xs text-[var(--color-text-muted)]">
              … and {{ p.moreMembers }} more.
            </p>
          </article>
        </div>

        <!-- Was der Schnitt KOSTET, steht neben dem, was er bringt. Ein Vorschlag, der nur den
             Gewinn nennt, ist eine Werbung. -->
        <dl
          v-if="active.cost || active.gain"
          class="mt-3 grid gap-x-3 gap-y-1 text-2xs"
          style="grid-template-columns: max-content 1fr"
        >
          <template v-if="active.gain">
            <dt class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">Gain</dt>
            <dd class="text-[var(--color-text)]">{{ active.gain }}</dd>
          </template>
          <template v-if="active.cost">
            <dt class="text-3xs uppercase tracking-wide text-[var(--color-text-muted)]">Cost</dt>
            <dd class="text-[var(--color-text-muted)]">{{ active.cost }}</dd>
          </template>
        </dl>

        <!-- Je Schritt: Begründung, dann zwei Fenster – gleiche Bauart wie `CyclePlan`. -->
        <div v-if="steps.length" class="mt-3">
          <p class="text-3xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Step by step</p>
          <div class="mt-1 space-y-3">
            <div v-for="(step, si) in steps" :key="si">
              <p class="text-2xs font-medium text-[var(--color-text)]">{{ si + 1 }}. {{ step.title }}</p>
              <p class="mt-0.5 max-w-3xl text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ step.why }}</p>
              <p class="mt-0.5 truncate font-mono text-3xs text-[var(--color-text-muted)]">{{ step.file }}</p>
              <div class="mt-1 grid gap-2 lg:grid-cols-2">
                <figure class="min-w-0 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <figcaption class="border-b border-[var(--color-border)] px-2 py-0.5 text-3xs uppercase tracking-wide text-[var(--color-danger)]">
                    before — how it looks today
                  </figcaption>
                  <pre class="overflow-x-auto py-1 font-mono text-3xs leading-relaxed"><span
                    v-for="(l, li) in step.before"
                    :key="li"
                    class="block border-l-2 pr-2 pl-1.5"
                    :class="l.hit ? 'border-[var(--color-danger)] bg-[var(--color-danger)]/10 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)]'"
                  >{{ l.text || ' ' }}</span></pre>
                </figure>
                <figure class="min-w-0 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <figcaption class="border-b border-[var(--color-border)] px-2 py-0.5 text-3xs uppercase tracking-wide text-[var(--color-success)]">
                    after — how it should look
                  </figcaption>
                  <pre class="overflow-x-auto py-1 font-mono text-3xs leading-relaxed"><span
                    v-for="(l, li) in step.after"
                    :key="li"
                    class="block border-l-2 pr-2 pl-1.5"
                    :class="l.hit ? 'border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)]'"
                  >{{ l.text || ' ' }}</span></pre>
                </figure>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ⚠️ Die Grenze der Auskunft steht UNTER dem Vorschlag, nicht in einem Tooltip: die
           Zuordnung „Methode benutzt Feld" ist eine Textsuche, und wer das nicht weiß, liest die
           Gruppen als Messung. Gleiche Regel wie der Satz unter der Outside-Liste. -->
      <ul v-if="plan.limits?.length" class="mt-3 space-y-0.5 border-t border-[var(--color-border)] pt-2">
        <li v-for="l in plan.limits" :key="l" class="flex items-start gap-1.5 text-3xs text-[var(--color-text-muted)]">
          <Icon icon="lucide:info" class="mt-0.5 h-2.5 w-2.5 shrink-0" />
          <span>{{ l }}</span>
        </li>
      </ul>

      <button
        type="button"
        class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-[var(--color-accent)] transition hover:underline"
        @click="emit('open-class', plan.class.id)"
      >
        <Icon icon="lucide:arrow-right" class="h-3 w-3" />
        Open {{ plan.class.className }} in the code view
      </button>
    </template>
  </div>
</template>
