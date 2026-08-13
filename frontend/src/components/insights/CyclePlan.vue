<script setup>
/**
 * Der Umbauplan zu EINEM Zyklus – aufklappbar, für Package- wie Klassenzyklen dieselbe Komponente.
 *
 * ⚠️ Der Code steht als ZWEI FENSTER nebeneinander (vorher · nachher), nicht als Diff. Ein Diff
 * setzt voraus, dass man Diffs liest; „links steht der Code von heute, rechts derselbe Code nach
 * der Änderung" setzt nichts voraus. Über jedem Paar steht in einem Satz, WARUM dieser Schritt
 * nötig ist – in Anfänger-Java erklärt, nicht in Architektursprache.
 *
 * Die Namen sind ECHT (tragende Klassen, tragendes Mitglied, beide Packages); geraten ist allein
 * die Signatur des neuen Interfaces, und genau das steht als Kommentar IM Beispiel.
 */
import { computed } from 'vue'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  cycle: { type: Object, required: true },
  level: { type: String, default: 'package' }, // 'package' | 'class'
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle', 'open-class'])

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : '')
const low = (w) => (w ? w[0].toLowerCase() + w.slice(1) : '')
const simple = (path) => String(path || '').split('.').pop()
// Das Wurzel-Package (com.acme.shop aus com.acme.shop.repo) – der Ort, an dem ein geteilter Typ
// liegen kann, ohne dass eine Seite die andere sieht.
const rootOf = (path) => {
  const parts = String(path || '').split('.')
  return parts.length > 1 ? parts.slice(0, -1).join('.') : path
}

// Das eine Klassenpaar, an dem der Plan hängt. Auf Package-Ebene nennt es die Kante beim Namen
// (`weakest.links[0]`), auf Klassenebene IST der Zyklus schon das Paar – dieselben vier Felder,
// damit alles darunter ohne Fallunterscheidung auskommt.
const subject = computed(() => {
  const w = props.cycle.weakest
  if (!w) return null
  if (props.level === 'package') {
    const l = w.links?.[0]
    if (!l) return null
    return { from: l.from, to: l.to, kind: l.kind, member: l.members?.[0] || '', fromPkg: w.fromLabel, toPkg: w.toLabel }
  }
  return {
    from: simple(w.fromLabel),
    to: simple(w.toLabel),
    kind: w.kind,
    member: w.members?.[0] || '',
    fromPkg: null,
    toPkg: null,
  }
})

// --- Die Bilanz in drei Zeilen ------------------------------------------------------------------
// ⚠️ Vor dem Code steht, WAS sich ändert, WAS es bringt und WARUM hier – je EIN Satz. Die
// Richtungszeile darüber ist die eigentliche Zusammenfassung: derselbe Pfeil, einmal so und einmal
// andersherum – das sagt in einem Bild, was drei Sätze umschreiben.
const summary = computed(() => {
  const w = props.cycle.weakest
  const s = subject.value
  if (!w || !s) return null
  const a = props.level === 'package' ? simple(w.fromLabel) : s.from
  const b = props.level === 'package' ? simple(w.toLabel) : s.to
  const moved = movesType.value

  return {
    beforeFrom: a,
    beforeTo: b,
    afterFrom: moved ? a : b,
    afterTo: moved ? 'shared' : a,
    afterVia: moved ? b : null,
    difference: moved ? `${s.to} moves to a package both may use.` : `One interface in ${a}; ${s.to} implements it.`,
    gain: `${a} builds and tests without ${b}.`,
    // ⚠️ Zwei verschieden starke Sätze, und der Unterschied ist nicht kosmetisch: liegt eine
    // `layers`-Regel vor, IST diese Kante ein Verstoß gegen eine Festlegung – ohne sie ist es eine
    // Vermutung aus einer Liste üblicher Packagenamen, und die darf nicht klingen wie ein Befund.
    why: w.againstLayers
      ? w.layerSource === 'rule'
        ? 'The only arrow running against your layer rule.'
        : 'The only arrow running against what looks like the layer order.'
      : `The cheapest cut — ${w.count === 1 ? 'one relation' : `${w.count} relations`}, a ${w.kind}.`,
  }
})

// Ein reiner TYPBEZUG hat kein Mitglied, das man umkehren könnte – dort lautet der Weg „den Typ
// dorthin legen, wo beide ihn sehen dürfen". Das braucht aber Packages: auf Klassenebene gibt es
// keine, also bleibt auch dort die Umkehr über ein Interface (sie trägt einen Feldtyp genauso).
const movesType = computed(() => props.level === 'package' && subject.value?.kind === 'uses')

const L = (text, hit = false) => ({ text, hit })

// --- Die Schritte: je EIN Fensterpaar ----------------------------------------------------------
const steps = computed(() => {
  const s = subject.value
  if (!s) return []
  const { from: a, to: b, fromPkg, toPkg } = s
  const member = s.member || 'run'

  if (movesType.value) {
    const shared = `${rootOf(fromPkg)}.shared`
    return [
      {
        title: `Move ${b} where both may see it`,
        why: `${a} only needs ${b} as a type — as a field or a parameter. If that file sits in a package both may look into, nobody has to point backwards.`,
        file: `${toPkg}.${b}`,
        before: [L(`package ${toPkg};`, true), L(''), L(`public class ${b} { … }`)],
        after: [L(`package ${shared};`, true), L(''), L(`public class ${b} { … }`)],
      },
      {
        title: 'Point the import at the new home',
        why: 'Only the import line changes — the code below stays exactly as it is.',
        file: `${fromPkg}.${a}`,
        before: [L(`import ${toPkg}.${b};`, true), L(''), L(`public class ${a} { … }`)],
        after: [L(`import ${shared}.${b};`, true), L(''), L(`public class ${a} { … }`)],
      },
    ]
  }

  // Aufruf oder Feldzugriff: die klassische Umkehr. Das Interface gehört in das Package, das die
  // Leistung BRAUCHT – nur dadurch dreht sich der Pfeil.
  const iface = s.member ? `${cap(s.member)}Port` : `${b}Port`
  const field = s.member ? `${s.member}Port` : 'port'
  const bVar = low(b)
  const file = (pkg, name) => (pkg ? `${pkg}.${name}` : `${name}.java`)
  const pkgLine = (pkg) => (pkg ? [L(`package ${pkg};`), L('')] : [])

  return [
    {
      title: `Write down what ${a} needs`,
      why: `An interface is just a list of method names — no code inside. It belongs to ${a}, because ${a} is the side that decides what it wants done.`,
      file: file(fromPkg, iface),
      before: [L('// this file does not exist yet')],
      after: [
        ...pkgLine(fromPkg).map((l) => L(l.text, true)),
        L(`// copy the signature from ${b}.${member}`, true),
        L(`public interface ${iface} {`, true),
        L(`    String ${member}(String value);`, true),
        L('}', true),
      ],
    },
    {
      title: `${a} talks to the interface`,
      why: `${a} stops naming ${b} anywhere. It gets the object handed in through its constructor — so ${a} compiles even when ${b} does not exist.`,
      file: file(fromPkg, a),
      before: [
        ...(toPkg ? [L(`import ${toPkg}.${b};`, true), L('')] : []),
        L(`public class ${a} {`),
        L(`    private ${b} ${bVar} = new ${b}();`, true),
        L(''),
        L('    void handle(String value) {'),
        L(`        ${bVar}.${member}(value);`, true),
        L('    }'),
        L('}'),
      ],
      after: [
        L(`public class ${a} {`),
        L(`    private final ${iface} ${field};`, true),
        L(''),
        L(`    public ${a}(${iface} ${field}) {`, true),
        L(`        this.${field} = ${field};`, true),
        L('    }'),
        L(''),
        L('    void handle(String value) {'),
        L(`        ${field}.${member}(value);`, true),
        L('    }'),
        L('}'),
      ],
    },
    {
      title: `${b} fills it in — here the arrow turns around`,
      why: `${b} keeps its code and only adds "implements". From now on ${b} points at ${a} instead of the other way round, and that is the moment the loop opens.`,
      file: file(toPkg, b),
      before: [L(`public class ${b} {`), L(`    public String ${member}(String value) { … }`), L('}')],
      after: [
        ...(fromPkg ? [L(`import ${fromPkg}.${iface};`, true), L('')] : []),
        L(`public class ${b} implements ${iface} {`, true),
        L('    @Override', true),
        L(`    public String ${member}(String value) { … }`),
        L('}'),
      ],
    },
    {
      title: 'Choose the real class once',
      why: `Somebody still has to pick ${b}. Do it where the program starts — that place may know both sides, because nothing depends on it.`,
      file: 'your main / config / factory',
      before: [L(`// ${a} reached for ${b} on its own`), L(`${a} ${low(a)} = new ${a}();`, true)],
      after: [L('// only this one place knows both'), L(`${a} ${low(a)} = new ${a}(new ${b}());`, true)],
    },
  ]
})
</script>

<template>
  <div>
    <!-- ⚠️ Der Plan ist AUFGEKLAPPT eine eigene Ebene: „was ändere ich, was bringt es, warum hier"
         beantwortet man einmal je Zyklus – dauerhaft sichtbar wären es bei sechs Zyklen sechs
         Aufsätze übereinander. -->
    <button
      type="button"
      class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-accent transition hover:underline"
      @click="emit('toggle')"
    >
      <Icon :icon="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="h-3 w-3" />
      {{ open ? 'Hide the plan' : 'What should I change here?' }}
    </button>

    <div v-if="open" class="mt-2 space-y-3 rounded-md bg-surface-offset p-3">
      <template v-if="summary">
        <!-- ⚠️ Die beiden Richtungen UNTEREINANDER und in einem Raster: nebeneinander liest man
             zwei Zeilen, untereinander SIEHT man den Pfeil sich umdrehen. -->
        <div class="grid items-center gap-x-2 gap-y-1 font-mono text-2xs" style="grid-template-columns: max-content max-content max-content max-content 1fr">
          <span class="text-3xs uppercase text-muted">now</span>
          <span class="justify-self-end text-ink">{{ summary.beforeFrom }}</span>
          <Icon icon="lucide:arrow-right" class="h-3 w-3 text-danger" />
          <span class="text-ink">{{ summary.beforeTo }}</span>
          <span class="text-3xs text-danger">closes the loop</span>

          <span class="text-3xs uppercase text-muted">after</span>
          <span class="justify-self-end text-ink">{{ summary.afterFrom }}</span>
          <Icon icon="lucide:arrow-right" class="h-3 w-3 text-success" />
          <span class="text-ink">
            {{ summary.afterTo }}
            <template v-if="summary.afterVia"> ← {{ summary.afterVia }}</template>
          </span>
          <span class="text-3xs text-success">no loop</span>
        </div>

        <dl class="grid gap-x-3 gap-y-1 text-2xs" style="grid-template-columns: max-content 1fr">
          <dt class="text-3xs uppercase tracking-wide text-muted">Change</dt>
          <dd class="text-ink">{{ summary.difference }}</dd>
          <dt class="text-3xs uppercase tracking-wide text-muted">Gain</dt>
          <dd class="text-ink">{{ summary.gain }}</dd>
          <dt class="text-3xs uppercase tracking-wide text-muted">Why here</dt>
          <dd class="text-muted">{{ summary.why }}</dd>
        </dl>
      </template>

      <!-- Was die Richtung hält – mit Namen, sonst bleibt es eine Aussage über zwei Ordner. Auf
           Klassenebene sagt das schon die „Easiest cut"-Zeile darüber. -->
      <div v-if="level === 'package' && cycle.weakest?.links?.length">
        <p class="text-3xs font-semibold uppercase tracking-wide text-muted">
          The relation to remove
        </p>
        <ul class="mt-1 space-y-0.5">
          <li v-for="l in cycle.weakest.links" :key="`${l.fromId}-${l.toId}`" class="text-2xs">
            <button
              type="button"
              class="font-mono text-ink underline-offset-2 hover:text-accent hover:underline"
              @click="emit('open-class', l.fromId)"
            >{{ l.from }}</button>
            <span class="text-muted"> → </span>
            <button
              type="button"
              class="font-mono text-ink underline-offset-2 hover:text-accent hover:underline"
              @click="emit('open-class', l.toId)"
            >{{ l.to }}</button>
            <span class="text-muted">
              ({{ l.kind }}<template v-if="l.members?.length">, {{ l.members.join(', ') }}</template>)
            </span>
          </li>
        </ul>
        <p v-if="cycle.weakest.more" class="mt-0.5 text-3xs text-muted">
          … and {{ cycle.weakest.more }} more.
        </p>
      </div>

      <!-- Je Schritt: Begründung, dann zwei Fenster. -->
      <div v-if="steps.length">
        <p class="text-3xs font-semibold uppercase tracking-wide text-muted">
          Step by step
        </p>
        <div class="mt-1 space-y-3">
          <div v-for="(step, si) in steps" :key="si">
            <p class="text-2xs font-medium text-ink">{{ si + 1 }}. {{ step.title }}</p>
            <p class="mt-0.5 text-2xs text-muted">{{ step.why }}</p>
            <p class="mt-0.5 truncate font-mono text-3xs text-muted">{{ step.file }}</p>
            <div class="mt-1 grid gap-2 lg:grid-cols-2">
              <figure class="min-w-0 overflow-hidden rounded border border-line bg-surface">
                <figcaption class="border-b border-line px-2 py-0.5 text-3xs uppercase tracking-wide text-danger">
                  before — how it looks today
                </figcaption>
                <pre class="overflow-x-auto py-1 font-mono text-3xs leading-relaxed"><span
                  v-for="(l, li) in step.before"
                  :key="li"
                  class="block border-l-2 pr-2 pl-1.5"
                  :class="l.hit ? 'border-danger bg-danger/10 text-ink' : 'border-transparent text-muted'"
                >{{ l.text || ' ' }}</span></pre>
              </figure>
              <figure class="min-w-0 overflow-hidden rounded border border-line bg-surface">
                <figcaption class="border-b border-line px-2 py-0.5 text-3xs uppercase tracking-wide text-success">
                  after — how it should look
                </figcaption>
                <pre class="overflow-x-auto py-1 font-mono text-3xs leading-relaxed"><span
                  v-for="(l, li) in step.after"
                  :key="li"
                  class="block border-l-2 pr-2 pl-1.5"
                  :class="l.hit ? 'border-success bg-success/10 text-ink' : 'border-transparent text-muted'"
                >{{ l.text || ' ' }}</span></pre>
              </figure>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
