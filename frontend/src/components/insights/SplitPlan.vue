<script setup>
/**
 * Wie man EINE Klasse aufteilen würde – aufklappbar unter ihrer Zeile in der Hotspot-Rangliste.
 *
 * Die Rangliste beantwortet „welche Klasse kostet mich Zeit?". Die Frage direkt dahinter lautet
 * „und was mache ich mit ihr?" – und genau dort hört ein Bericht sonst auf: „split this class" ist
 * derselbe Satz für jede Klasse und damit keine Auskunft.
 *
 * ⚠️ **Die Antwort sind fertige JAVA-DATEIEN, keine Skizze.** Die erste Fassung zeigte Karten mit
 * Signaturlisten und Vorher/Nachher-Fenster voller `{ … }` – fachlich richtig und trotzdem nicht zu
 * gebrauchen: wer Java kann, aber keine Architekturbegriffe (die Zielgruppe des ganzen Berichts),
 * kann an einem Gerüst nicht erkennen, ob der Vorschlag stimmt. Jetzt steht dort der Quelltext, den
 * die neue Klasse hätte – mit den ECHTEN Methodenrümpfen aus dem Bestand –, und man kann ihn
 * kopieren und übersetzen. Das ist überprüfbar, ein Gerüst ist es nicht.
 *
 * ⚠️ **Drei Schnitte, und man kann zwischen ihnen umschalten.** Der Server rechnet alle drei und
 * nennt den, der hier am besten trägt (`lead`); die anderen bleiben erreichbar. Ein Schnitt, der
 * nichts hergibt, sagt WARUM – ein leerer Reiter ohne Grund liest sich wie „mit dieser Klasse ist
 * alles in Ordnung".
 *
 * Die Namen der Dateien sind der einzige GERATENE Teil und werden als solcher angeschrieben.
 */
import { computed, ref, watch } from 'vue'
import { Icon } from '../../lib/icons.js'
import { vTip } from '../../lib/tooltip.js'
import { api } from '../../lib/api.js'
import { copyToClipboard } from '../../lib/clipboard.js'
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
const copied = ref('')

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

// Icon und Kurzwort je Schnitt. Das Wort steht am Chip, der Satz steht darunter – zwei Zeilen
// nebeneinander wären dieselbe Aussage zweimal.
const STRATEGY = {
  cohesion: { icon: 'lucide:layers', short: 'by state' },
  roles: { icon: 'lucide:users', short: 'by callers' },
  branching: { icon: 'lucide:git-fork', short: 'by method' },
}

// ⚠️ Was eine Datei IST – und die dritte Marke ist eine WARNUNG, keine Beschriftung. `new` legt man
// an, `rewritten` ersetzt die alte Datei ganz; ein `excerpt` ist nur der Teil, um den es geht.
// Wer einen Ausschnitt für eine ganze Datei hält und ihn einsetzt, löscht den Rest seiner Klasse –
// deshalb steht die Marke direkt neben dem Kopierknopf und nicht in der Zeile darunter.
const FILE_KIND = {
  new: { label: 'new file', icon: 'lucide:file-plus', color: 'var(--color-success)' },
  rewritten: { label: 'replaces the old file', icon: 'lucide:file-edit', color: 'var(--color-accent)' },
  excerpt: { label: 'excerpt — not a whole file', icon: 'lucide:file-search', color: 'var(--color-warning)' },
}

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

// Kopieren je Datei. ⚠️ Kopiert wird `code`, nicht das angezeigte HTML – und beide entstehen im
// Server aus DEMSELBEN eingerückten Text, also stimmt das Kopierte mit dem Gezeigten Zeichen für
// Zeichen überein. Kein Download-Zweig wie im Themen-Bündel: eine einzelne Klassendatei bleibt
// weit unter jeder Zwischenablagegrenze.
async function copyFile(file) {
  await copyToClipboard(file.code)
  copied.value = file.path
  setTimeout(() => {
    if (copied.value === file.path) copied.value = ''
  }, 2000)
}
</script>

<template>
  <div class="border-t border-line bg-surface-offset px-3 py-3">
    <BusyState
      v-if="loading"
      variant="inline"
      title="Working out how this class comes apart…"
      reason="Reading the method bodies, grouping them by the fields they touch."
      :since="startedAt"
    />

    <div v-else-if="!plan" class="text-2xs text-muted">
      The split plan could not be computed for this class.
    </div>

    <template v-else>
      <!-- ⚠️ „Kein Vorschlag" ist ein ERGEBNIS und steht deshalb ganz oben, mit Haken und nicht
           mit Warnfarbe: eine Klasse kann groß sein und trotzdem genau eine Sache tun. Ohne diesen
           Satz sähen drei leere Schnitte darunter wie ein Fehler der Rechnung aus. -->
      <div
        v-if="plan.summary"
        class="mb-3 flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2"
      >
        <Icon icon="lucide:check-circle" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
        <p class="max-w-3xl text-2xs leading-relaxed text-ink">{{ plan.summary }}</p>
      </div>

      <!-- ⚠️ Die Bilanz ZUERST: „was wird daraus?" beantwortet man an zwei Zeilen. Untereinander
           und in einem Raster, damit man den Umbau SIEHT statt ihn zu lesen (gleiche Bauart wie
           die Richtungszeile in `CyclePlan`). -->
      <div
        v-if="active && active.parts.length"
        class="grid items-baseline gap-x-3 gap-y-1 font-mono text-2xs"
        style="grid-template-columns: max-content 1fr"
      >
        <span class="text-3xs uppercase text-muted">now</span>
        <span class="text-ink">
          {{ plan.class.className }}
          <span class="text-muted">
            · {{ num(plan.class.loc) }} lines · {{ num(plan.class.methods) }} methods ·
            {{ num(plan.class.fields) }} fields<template v-if="plan.class.callers">
              · {{ num(plan.class.callers) }} callers</template>
          </span>
        </span>

        <span class="text-3xs uppercase text-muted">after</span>
        <span class="min-w-0">
          <span v-for="p in active.parts" :key="p.name" class="block text-ink">
            <Icon icon="lucide:corner-down-right" class="mr-1 inline h-3 w-3 text-success" />
            {{ p.name }}
            <span class="text-muted">· {{ partMeta(p, active.id) }}</span>
            <!-- ⚠️ Ein geratener Name wird ANGESCHRIEBEN. Er ist das einzige am Vorschlag, das
                 nicht im Code steht – ihn stillschweigend hinzuschreiben hiesse behaupten, die
                 Rechnung habe ihn gefunden. -->
            <span
              v-if="p.nameGuessed"
              v-tip="'No word in these members carries the group — pick a name that fits, this one is only a placeholder.'"
              class="ml-1 rounded bg-surface px-1 text-3xs text-muted"
              >name is a placeholder</span
            >
          </span>
          <span v-if="active.shared.length" class="mt-0.5 block text-muted">
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
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-line text-muted hover:border-line-strong hover:text-ink'"
          @click="picked = s.id"
        >
          <Icon :icon="STRATEGY[s.id].icon" class="h-3 w-3" />
          {{ STRATEGY[s.id].short }}
          <span v-if="s.verdict === 'none'" class="rounded bg-surface px-1 text-3xs opacity-70">—</span>
          <span
            v-else-if="s.id === plan.lead"
            class="rounded bg-success/15 px-1 text-3xs text-success"
          >best fit</span>
        </button>
      </div>

      <template v-if="active">
        <p class="mt-2.5 text-sm font-medium leading-snug text-ink">{{ active.headline }}</p>
        <p class="mt-0.5 max-w-3xl text-2xs leading-relaxed text-muted">{{ active.why }}</p>

        <!-- ⚠️ Der Vorschlag SIND die Dateien. Über jeder steht in einem Satz, warum es sie gibt
             (`caption`) und was sie ist (neu · umgeschrieben · so wie heute) – ohne diese Marke
             legt man die Klasse neu an, die man eigentlich ändern soll. -->
        <div v-if="active.files?.length" class="mt-3 space-y-2.5">
          <figure
            v-for="f in active.files"
            :key="f.path"
            class="min-w-0 overflow-hidden rounded-md border border-line bg-surface"
          >
            <figcaption class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2.5 py-1.5">
              <Icon :icon="FILE_KIND[f.kind].icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: FILE_KIND[f.kind].color }" />
              <span class="font-mono text-xs font-semibold text-ink">{{ f.name }}</span>
              <span
                class="rounded px-1 text-3xs"
                :style="{ color: FILE_KIND[f.kind].color, background: 'var(--color-surface-offset)' }"
                >{{ FILE_KIND[f.kind].label }}</span
              >
              <span class="font-mono text-3xs text-muted">{{ plural(f.lines, 'line') }}</span>
              <button
                type="button"
                class="ml-auto inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-3xs text-muted transition hover:border-line-strong hover:text-ink"
                @click="copyFile(f)"
              >
                <Icon :icon="copied === f.path ? 'lucide:check' : 'lucide:copy'" class="h-3 w-3" />
                {{ copied === f.path ? 'Copied' : 'Copy' }}
              </button>
            </figcaption>
            <p class="border-b border-line px-2.5 py-1.5 text-2xs leading-relaxed text-muted">
              {{ f.caption }}
            </p>
            <!-- Shiki-HTML vom Server – kein zweiter Highlighter im Client, und `split-code` teilt
                 sich die Regel mit den Code-Blöcken des Edge-Panels. -->
            <div class="split-code overflow-x-auto px-2.5" v-html="f.html" />
          </figure>
        </div>

        <!-- Was der Schnitt KOSTET, steht neben dem, was er bringt. Ein Vorschlag, der nur den
             Gewinn nennt, ist eine Werbung. -->
        <dl
          v-if="active.cost || active.gain"
          class="mt-3 grid gap-x-3 gap-y-1 text-2xs"
          style="grid-template-columns: max-content 1fr"
        >
          <template v-if="active.gain">
            <dt class="text-3xs uppercase tracking-wide text-muted">Gain</dt>
            <dd class="text-ink">{{ active.gain }}</dd>
          </template>
          <template v-if="active.cost">
            <dt class="text-3xs uppercase tracking-wide text-muted">Cost</dt>
            <dd class="text-muted">{{ active.cost }}</dd>
          </template>
        </dl>
      </template>

      <!-- ⚠️ Die Grenze der Auskunft steht UNTER dem Vorschlag, nicht in einem Tooltip: die
           Zuordnung „Methode benutzt Feld" ist eine Textsuche, und wer das nicht weiß, liest die
           Gruppen als Messung. Gleiche Regel wie der Satz unter der Outside-Liste. -->
      <ul v-if="plan.limits?.length" class="mt-3 space-y-0.5 border-t border-line pt-2">
        <li v-for="l in plan.limits" :key="l" class="flex items-start gap-1.5 text-3xs text-muted">
          <Icon icon="lucide:info" class="mt-0.5 h-2.5 w-2.5 shrink-0" />
          <span>{{ l }}</span>
        </li>
      </ul>

      <button
        type="button"
        class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-accent transition hover:underline"
        @click="emit('open-class', plan.class.id)"
      >
        <Icon icon="lucide:arrow-right" class="h-3 w-3" />
        Open {{ plan.class.className }} in the code view
      </button>
    </template>
  </div>
</template>
