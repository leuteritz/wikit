<script setup>
// Slide-over (rechter Rand): loest eine AGGREGATKANTE des Package-Graphen auf.
//
// Auf der Package-Ebene steht eine Kante fuer viele Klassenbeziehungen und traegt nur deren Zahl
// („17 class relations"). Das ist eine Behauptung, die man nicht nachpruefen kann – man musste
// erst in beide Packages hineinzoomen und die Kanten selbst suchen. Dieses Panel zeigt die Paare
// direkt, gruppiert nach Klassenpaar und sortiert nach Aussagekraft (Aufruf > Typbezug > Import).
//
// Jede Zeile klappt auf und zeigt DEN CODE: die definierte Methode und darunter jede Stelle, an
// der sie aufgerufen wird (Aufrufzeile hervorgehoben). Dazu je ein Satz in einfacher Sprache, was
// die Beziehung ueberhaupt bedeutet – das Panel ist die Stelle, an der jemand den Graphen zum
// ersten Mal versteht, nicht die Stelle fuer Fachjargon.
//
// Der Code kommt server-gerendert (Shiki) ueber `api.getJavaMethodSnippet` und wird mit den
// geteilten Helfern aus lib/javaCode.js aufbereitet – identisch zum Edge-Detail-Modal, kein
// zweiter Highlighter im Client. Die Aufrufstellen selbst rechnet der Parent (`loadDetail`).
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../lib/api.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { addLineNumbers, buildCallWindow } from '../../lib/javaCode.js'
// Identitaetsfarbe je Methode – dieselben Helfer wie im Edge-Detail-Modal. Die Zuordnung MUSS
// dort und hier gleich ausfallen: „Full details" zeigt genau diese Beziehung noch einmal, und
// eine Methode, die dabei die Farbe wechselt, waere blosse Dekoration statt einer Aussage.
import { buildMethodColorMap, methodColorVars, markMethodCalls } from '../../lib/javaMethodColors.js'
import { Icon } from '../../lib/icons.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  // { fromLabel, toLabel, fromIsClass, toIsClass, count, relations: [{ key, provider, consumer, kind, methods }] }
  bundle: { type: Object, default: null },
  // async (rel) => computeCallEdgeData(...) – liefert Methoden-Signaturen + Aufrufstellen.
  loadDetail: { type: Function, default: null },
})
// `select` gibt es bewusst nicht mehr: jeder „geh dorthin"-Klick laeuft ueber goTo(), das die
// Datei UND (wo bekannt) die Zeile ansteuert – ein Weg statt zwei mit unterschiedlichem Ergebnis.
const emit = defineEmits(['close', 'open'])

// Sprung in den Quellcode – exakt die Mechanik des Edge-Detail-Modals: Ziel-Datei + Zeile im
// Analyzer-Store hinterlegen, CodeView hoert darauf, oeffnet den Quellcode-Tab und markiert die
// Stelle. Kein eigener Weg dafuer, sonst gibt es zwei Arten, „geh dorthin" zu sagen.
const router = useRouter()
const { lastFileId, lastTargetLine, lastTargetEndLine } = useJavaAnalyzer()
function goTo(fileId, line = null, endLine = null) {
  if (fileId == null) return
  lastFileId.value = fileId
  lastTargetLine.value = line
  lastTargetEndLine.value = endLine
  // 'navigate' unterscheidet das Schliessen HIER (Sprung in den Code) vom Schliessen per ESC/×.
  // Nur im ersten Fall bietet der Graph anschliessend den Rueckweg zu dieser Beziehung an.
  emit('close', 'navigate') // sonst verdeckt das Panel genau den Code, zu dem gesprungen wurde
  router.push('/code')
}
// Klick auf einen Codeblock springt an die Stelle – ausser der Nutzer hat gerade Text markiert
// (dann wollte er kopieren, nicht navigieren).
function onCodeClick(fileId, line, endLine) {
  if (String(window.getSelection?.() || '').trim()) return
  goTo(fileId, line, endLine)
}

const query = ref('')
const expanded = ref(new Set())
// rel.key -> { loading, error, defs: [...], usages: [...], moreDefs, moreUsages }
const details = ref({})

// Wieviel wird INLINE gezeigt? Darueber hinaus verweist die Zeile auf das volle Detail-Modal.
// Ohne Deckel wuerde eine Beziehung mit 20 Methoden das Panel zu einer endlosen Codewand machen.
const MAX_DEFS = 2
const MAX_CALLERS = 2
const MAX_SITES = 2

// Kantenart -> Beschriftung, Farbe und ein Satz Klartext. Spiegelt das Vokabular des Graphen;
// eine eigene Benennung an dieser Stelle waere eine zweite Sprache fuer dieselbe Sache.
const KIND_META = {
  call: {
    label: 'calls',
    color: 'var(--color-accent)',
    explain: (r, m) =>
      `${r.consumer.class_name} calls ${m} on ${r.provider.class_name}. That is a real dependency: change the method and ${r.consumer.class_name} has to follow.`,
  },
  field: {
    label: 'reads field',
    color: 'var(--color-lavender)',
    explain: (r, m) =>
      `${r.consumer.class_name} reads ${m} on ${r.provider.class_name}. That is a real dependency: rename or remove the field and ${r.consumer.class_name} stops compiling.`,
  },
  uses: {
    label: 'uses type',
    color: 'var(--color-cyan)',
    explain: (r) =>
      `${r.consumer.class_name} works with the type ${r.provider.class_name} — as a field, a parameter, a return type, a cast, a static member such as ${r.provider.class_name}.CONSTANT, or a new ${r.provider.class_name}(). No method call was detected, so the lines below show where the type itself appears.`,
  },
  import: {
    label: 'imports',
    color: 'var(--color-text-muted)',
    // Bewusst KEINE Behauptung mehr ("nothing uses it"): darueber entscheiden die Zeilen unten,
    // und genau diese Behauptung war falsch, solange der Parser Konstruktoren nicht las.
    explain: (r) =>
      `${r.consumer.class_name} imports ${r.provider.class_name}, and neither a call nor a type use was detected. The lines below are every place the name appears in the source.`,
  },
}

const relations = computed(() => props.bundle?.relations || [])
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return relations.value
  return relations.value.filter(
    (r) =>
      r.provider.class_name.toLowerCase().includes(q) ||
      r.consumer.class_name.toLowerCase().includes(q) ||
      (r.methods || []).some((m) => (m.method || '').toLowerCase().includes(q)),
  )
})
// Bilanz im Kopf: wieviele der Beziehungen sind echte Aufrufe, wieviele nur Imports?
const tally = computed(() => {
  const t = { call: 0, field: 0, uses: 0, import: 0 }
  for (const r of relations.value) t[r.kind] = (t[r.kind] || 0) + 1
  return t
})

const methodsOf = (r) => (r.methods || []).filter((m) => m && m.method)

// Farbindex je Methode, EINE Map pro Beziehung. Die Reihenfolge ist dieselbe, aus der auch
// `computeCallEdgeData` seine Methodenliste baut (`rel.methods`, gefiltert auf `m.method`) –
// deshalb vergibt das Edge-Modal fuer dieselbe Beziehung exakt dieselben Farben.
// Vorab fuer ALLE Zeilen berechnet, damit die Chips in der Kopfzeile die Farbe schon tragen,
// bevor der Code nachgeladen ist.
const colorMaps = computed(() => {
  const out = new Map()
  for (const r of relations.value) out.set(r.key, buildMethodColorMap(methodsOf(r).map((m) => m.method)))
  return out
})
// Inline-Vars (`--mc` fuer Panel-Flaechen, `--mc-code` fuer den dunklen Code-Block). Unbekannter
// Name -> leeres Objekt, die CSS-Fallbacks greifen dann auf den Akzent.
function mcVars(rel, name) {
  return methodColorVars(colorMaps.value.get(rel.key)?.get(name))
}
// Farbe einer Aufrufstelle: nur bei GENAU einem Callee. Stehen zwei Aufrufe in derselben Zeile,
// gaebe eine der beiden Farben eine Zuordnung vor, die es nicht gibt – dann bleibt es beim Akzent
// und die Zuordnung passiert ueber die farbigen Namen in der Bildunterschrift.
function siteVars(rel, site) {
  return site.callees?.length === 1 ? mcVars(rel, site.callees[0]) : {}
}
const explainFor = (r) => {
  // Ein Feld traegt keine Klammern – `ACCEPT()` waere kein Java.
  const names = methodsOf(r).map((m) => (r.kind === 'field' ? m.method : `${m.method}()`))
  const list = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ')
  return KIND_META[r.kind].explain(r, list || (r.kind === 'field' ? 'a field' : 'a method'))
}

// --- Code nachladen (lazy, einmal je Beziehung) ----------------------------------------------
async function fetchDetail(rel) {
  if (details.value[rel.key] || !props.loadDetail) return
  details.value = { ...details.value, [rel.key]: { loading: true } }
  try {
    const data = (await props.loadDetail(rel)) || {}
    const wanted = (data.methods || []).slice(0, MAX_DEFS)
    // Basis ist die Kopfzeilen-Map (gleiche Reihenfolge wie im Edge-Modal); Callees, die nur an
    // einer Aufrufstelle auftauchen, haengen hinten an – bestehende Indizes bleiben damit stabil.
    const colors = buildMethodColorMap([
      ...methodsOf(rel).map((m) => m.method),
      ...(data.callSites || []).map((s) => s.calleeMethod),
    ])

    // 1) Definitionen: die aufgerufene Methode im Original.
    const defs = []
    for (const m of wanted) {
      try {
        const snip = await api.getJavaMethodSnippet(rel.provider.id, m.name)
        defs.push({
          name: m.name,
          signature: m.signature || snip.signature,
          filename: snip.filename,
          startLine: snip.startLine,
          endLine: snip.endLine ?? snip.startLine,
          // In der Definition nur die eigene Methode einfaerben – andere Namen der Beziehung
          // waeren hier Rauschen (identisch zum Edge-Modal).
          html: markMethodCalls(
            addLineNumbers(snip.combinedHtml ?? snip.html, snip.startLine),
            new Map([[m.name, colors.get(m.name) ?? 0]]),
          ),
        })
      } catch (e) {
        defs.push({ name: m.name, signature: m.signature, error: e.message })
      }
    }

    // 2) Aufrufstellen, gruppiert nach aufrufender Methode.
    const byCaller = new Map()
    for (const s of data.callSites || []) {
      if (!byCaller.has(s.callerMethod)) byCaller.set(s.callerMethod, [])
      byCaller.get(s.callerMethod).push(s)
    }
    const callerList = [...byCaller.entries()].slice(0, MAX_CALLERS)
    const usages = []
    for (const [callerMethod, sites] of callerList) {
      try {
        const snip = await api.getJavaMethodSnippet(rel.consumer.id, callerMethod)
        const base = sites[0]?.bodyStartLine ?? snip.startLine ?? null
        // Mehrere Treffer in DERSELBEN Zeile (z. B. `a.run(); b.run();`) ergeben denselben
        // Ausschnitt – zweimal identischer Code untereinander sieht nach einem Fehler aus.
        // Eine Zeile = ein Block, die betroffenen Methodennamen werden gesammelt.
        const byLine = new Map()
        for (const s of sites) {
          const cur = byLine.get(s.line)
          if (cur) {
            if (!cur.callees.includes(s.calleeMethod)) cur.callees.push(s.calleeMethod)
          } else {
            byLine.set(s.line, { line: s.line, lineExact: s.lineExact, callees: [s.calleeMethod] })
          }
        }
        const uniq = [...byLine.values()]
        usages.push({
          callerMethod,
          filename: snip.filename,
          // Im Aufrufer-Fenster ALLE Methoden der Beziehung markieren: im Kontext stehen oft
          // weitere Aufrufe derselben Kante, die dann ihre eigene Farbe tragen.
          sites: uniq
            .slice(0, MAX_SITES)
            .map((s) => ({ ...s, html: markMethodCalls(buildCallWindow(snip.html, base, s.line), colors) })),
          moreSites: Math.max(0, uniq.length - MAX_SITES),
        })
      } catch (e) {
        usages.push({ callerMethod, error: e.message, sites: [] })
      }
    }

    details.value = {
      ...details.value,
      [rel.key]: {
        loading: false,
        defs,
        usages,
        moreDefs: Math.max(0, (data.methods || []).length - wanted.length),
        moreUsages: Math.max(0, byCaller.size - callerList.length),
        siteCount: (data.callSites || []).length,
      },
    }
  } catch (e) {
    details.value = { ...details.value, [rel.key]: { loading: false, error: e.message } }
  }
}

// --- Beleg fuer eine Beziehung OHNE Methode (`uses` / `import`) -------------------------------
//
// Eine solche Zeile stand bisher ohne Code da („No call site to show"), obwohl der Typ im
// Quelltext des Nutzers an genau benennbaren Stellen erscheint (`Http.GET`, `catch (Foo ex)`,
// `(Foo) x`). Der Server liefert sie zeilengenau und bereits gehighlightet – hier wird nur noch
// der Gutter gesetzt und die Fundzeile markiert, mit denselben Helfern wie ueberall.
// rel.key -> { loading, error, total, imports, truncated, usages: [{ line, html }] }
const typeUsages = ref({})

async function fetchTypeUsages(rel) {
  if (typeUsages.value[rel.key]) return
  typeUsages.value = { ...typeUsages.value, [rel.key]: { loading: true } }
  try {
    const data = await api.getJavaTypeUsages(rel.consumer.id, rel.provider.class_name)
    typeUsages.value = {
      ...typeUsages.value,
      [rel.key]: {
        loading: false,
        total: data.total,
        imports: data.imports,
        truncated: data.truncated,
        usages: (data.usages || []).map((u) => ({
          ...u,
          html: addLineNumbers(u.html, u.startLine, { keepBlank: true, highlight: u.line }),
        })),
      },
    }
  } catch (e) {
    typeUsages.value = { ...typeUsages.value, [rel.key]: { loading: false, error: e.message } }
  }
}

function toggle(rel) {
  const next = new Set(expanded.value)
  if (next.has(rel.key)) next.delete(rel.key)
  else {
    next.add(rel.key)
    if (methodsOf(rel).length) fetchDetail(rel)
    else fetchTypeUsages(rel)
  }
  expanded.value = next
}

function close() {
  emit('close')
}
// An den DATEN haengen, nicht an `visible`: das Panel steht in der Detail-Spalte, und wer dort eine
// zweite Aggregatkante anklickt, tauscht nur `bundle` – `visible` bliebe durchgehend true, der
// Watch liefe nie wieder und die Liste zeigte weiter die Beziehungen der ersten Kante. (Dieselbe
// Falle wie beim Nachladen im Kanten-Detail, s. CLAUDE.md.)
watch(
  () => (props.visible ? props.bundle : null),
  (bundle) => {
    query.value = ''
    expanded.value = new Set()
    details.value = {}
    typeUsages.value = {}
    if (!bundle) return
    // Die erste Beziehung gleich aufklappen: das Panel soll Code ZEIGEN, nicht erst anbieten.
    const first = relations.value.find((r) => methodsOf(r).length) || relations.value[0]
    if (first) toggle(first)
  },
  { immediate: true },
)
</script>

<template>
  <!-- Panel der Detail-Spalte (frueher ein Slide-over ueber dem Graphen): dieselbe Liste, nur neben
       dem Bild statt darueber. Hoehe vom Elternteil, gescrollt wird nur die Liste. -->
  <div
    v-if="visible && bundle"
    class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
    aria-label="Bundled class relations"
  >
          <header class="shrink-0 border-b border-[var(--color-border)] px-3 py-2.5">
            <!-- Kein ×: geschlossen wird ueber den Umschalter direkt darueber (bzw. ESC). Zwei
                 Schliessen-Knoepfe im selben Blickfeld lassen offen, ob sie dasselbe tun. -->
            <h2 class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
              <Icon icon="lucide:git-fork" class="h-4 w-4 shrink-0 text-[var(--color-thistle)]" />
              <span class="truncate">Bundled relations</span>
            </h2>

            <!-- Richtung des Buendels: definierende Seite -> nutzende Seite, wie der Pfeil im Graph. -->
            <div class="mt-2 flex items-center gap-2 text-[0.8125rem]">
              <span class="bundle-end">
                <Icon :icon="bundle.fromIsClass ? 'lucide:box' : 'lucide:folder'" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ bundle.fromLabel }}</span>
              </span>
              <Icon icon="lucide:arrow-right" class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
              <span class="bundle-end">
                <Icon :icon="bundle.toIsClass ? 'lucide:box' : 'lucide:folder'" class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ bundle.toLabel }}</span>
              </span>
            </div>

            <!-- Bilanz als Label/Wert-Paare statt als Satz: „1 relations" oder „8 with a method
                 calls" waere sonst kaum grammatisch sauber zu bekommen. -->
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span v-if="tally.call" class="tally" style="--k: var(--color-accent)">calls <b>{{ tally.call }}</b></span>
              <span v-if="tally.field" class="tally" style="--k: var(--color-lavender)">fields <b>{{ tally.field }}</b></span>
              <span v-if="tally.uses" class="tally" style="--k: var(--color-cyan)">type usage <b>{{ tally.uses }}</b></span>
              <span v-if="tally.import" class="tally" style="--k: var(--color-text-muted)">import-only <b>{{ tally.import }}</b></span>
              <span class="tally tally--total">total <b>{{ relations.length }}</b></span>
            </div>

            <!-- Einordnung fuer alle, die den Graphen zum ersten Mal sehen. -->
            <p class="bp-intro">
              This one edge stands for every connection between the two boxes above. Each row below is
              <b>one class using another</b> — the left class defines something, the right class uses it.
              Open a row to see the exact lines of code.
            </p>

            <label v-if="relations.length > 8" class="mt-2 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
              <Icon icon="lucide:search" class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <input
                v-model="query"
                type="text"
                placeholder="Filter by class or method…"
                class="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
              />
            </label>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <p v-if="!filtered.length" class="px-1 py-6 text-center text-xs text-[var(--color-text-muted)]">
              Nothing matches “{{ query }}”.
            </p>

            <ul v-else class="flex flex-col gap-2">
              <li v-for="r in filtered" :key="r.key" class="rel-card" :style="{ '--kind': KIND_META[r.kind].color }">
                <!-- Kopfzeile: klappt den Code auf/zu. Kein <button>, weil die beiden
                     Klassennamen darin selbst klickbar sind (verschachtelte Buttons sind
                     ungueltig) – dafuer role/tabindex/Tastatur von Hand. -->
                <div
                  class="rel-row"
                  role="button"
                  tabindex="0"
                  :aria-expanded="expanded.has(r.key)"
                  @click="toggle(r)"
                  @keydown.enter.prevent="toggle(r)"
                  @keydown.space.prevent="toggle(r)"
                >
                  <span class="rel-kind">{{ KIND_META[r.kind].label }}</span>
                  <span class="rel-pair">
                    <button
                      type="button"
                      class="rel-class rel-class--link"
                      :title="`Open ${r.provider.class_name} — ${r.provider.package || 'default package'}`"
                      @click.stop="goTo(r.provider.id)"
                    >{{ r.provider.class_name }}</button>
                    <Icon icon="lucide:arrow-right" class="h-3 w-3 shrink-0 opacity-50" />
                    <button
                      type="button"
                      class="rel-class rel-class--link"
                      :title="`Open ${r.consumer.class_name} — ${r.consumer.package || 'default package'}`"
                      @click.stop="goTo(r.consumer.id)"
                    >{{ r.consumer.class_name }}</button>
                  </span>
                  <!-- Die Methoden-Chips sind zugleich die Legende der Zeile: dieselbe Farbe steht
                       unten am Definitionsblock, an der Aufrufstelle und am Token im Code. -->
                  <span v-if="methodsOf(r).length" class="rel-methods">
                    <span
                      v-for="m in methodsOf(r).slice(0, 3)"
                      :key="m.edgeId ?? m.method"
                      class="rel-method"
                      :style="mcVars(r, m.method)"
                    >{{ r.kind === 'field' ? m.method : m.method + '()' }}</span>
                    <span v-if="methodsOf(r).length > 3" class="rel-more">+{{ methodsOf(r).length - 3 }}</span>
                  </span>
                  <Icon
                    icon="lucide:chevron-down"
                    class="rel-go h-4 w-4 shrink-0"
                    :class="{ 'rotate-180': expanded.has(r.key) }"
                  />
                </div>

                <!-- Aufgeklappt: Klartext + Code. -->
                <div v-if="expanded.has(r.key)" class="rel-body">
                  <p class="rel-explain">{{ explainFor(r) }}</p>

                  <!-- Kein Methoden-Label -> kein Aufruf, aber sehr wohl Code: die Stellen, an
                       denen der Typ im Quelltext des Nutzers steht. Ohne sie war diese Zeile eine
                       Behauptung ohne Beleg – und genau dort lag der gemeldete Fehler. -->
                  <template v-if="!methodsOf(r).length">
                    <p v-if="typeUsages[r.key]?.loading" class="rel-note">
                      <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                      Looking for {{ r.provider.class_name }} in the source of {{ r.consumer.class_name }}…
                    </p>
                    <p v-else-if="typeUsages[r.key]?.error" class="rel-note rel-note--warn">
                      <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
                      {{ typeUsages[r.key].error }}
                    </p>

                    <template v-else-if="typeUsages[r.key]">
                      <div v-for="u in typeUsages[r.key].usages" :key="`t-${u.line}`" class="rel-site">
                        <div
                          class="edge-usage-code rel-clickable"
                          :title="`Open ${r.consumer.class_name} at line ${u.line}`"
                          @click="onCodeClick(r.consumer.id, u.line)"
                          v-html="u.html"
                        />
                        <p class="rel-caption">
                          Line {{ u.line }} — the highlighted line names
                          <code class="rel-mc-code">{{ r.provider.class_name }}</code>.
                          <button type="button" class="rel-jump" @click="goTo(r.consumer.id, u.line)">
                            Go to line {{ u.line }}
                            <Icon icon="lucide:arrow-up-right" class="rel-loc-go" />
                          </button>
                        </p>
                      </div>

                      <p v-if="typeUsages[r.key].truncated" class="rel-note">
                        Showing the first {{ typeUsages[r.key].usages.length }} of
                        {{ typeUsages[r.key].total }} place(s) in {{ r.consumer.class_name }}.
                      </p>
                      <!-- Belegte Aussage statt Vermutung: null Fundstellen ausser dem Import
                           heisst wirklich „ungenutzt", und das darf dann auch dastehen. -->
                      <p v-else-if="!typeUsages[r.key].total" class="rel-note">
                        <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
                        <template v-if="typeUsages[r.key].imports">
                          {{ r.provider.class_name }} appears only in the import line of {{ r.consumer.class_name }} — an unused import.
                        </template>
                        <template v-else>
                          The name {{ r.provider.class_name }} does not appear in the source of {{ r.consumer.class_name }} — this may be a manual link.
                        </template>
                      </p>
                    </template>

                    <div class="rel-actions">
                      <button type="button" class="rel-btn" @click="goTo(r.provider.id)">
                        <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                        Open {{ r.provider.class_name }}
                      </button>
                      <button type="button" class="rel-btn" @click="goTo(r.consumer.id, typeUsages[r.key]?.usages?.[0]?.line ?? null)">
                        <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                        Open {{ r.consumer.class_name }}
                      </button>
                    </div>
                  </template>

                  <template v-else>
                    <p v-if="details[r.key]?.loading" class="rel-note">
                      <Icon icon="lucide:loader-2" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                      Loading the code…
                    </p>
                    <p v-else-if="details[r.key]?.error" class="rel-note rel-note--warn">
                      <Icon icon="lucide:alert-triangle" class="h-3.5 w-3.5 shrink-0" />
                      {{ details[r.key].error }}
                    </p>

                    <template v-else-if="details[r.key]">
                      <!-- 1 · Definition -->
                      <div v-for="d in details[r.key].defs" :key="`d-${d.name}`" class="rel-block rel-block--mc" :style="mcVars(r, d.name)">
                        <!-- Herkunft: Package · Datei · Zeile, komplett anklickbar -> oeffnet die
                             Datei und markiert den ganzen Methodenbereich. -->
                        <button
                          type="button"
                          class="rel-block-head rel-block-head--link"
                          :title="`Open ${d.filename || r.provider.class_name} at line ${d.startLine ?? '?'}`"
                          @click="goTo(r.provider.id, d.startLine, d.endLine)"
                        >
                          <span class="rel-step rel-step--mc">1</span>
                          <span class="rel-block-title">
                            Comes from <b>{{ r.provider.class_name }}.<span class="rel-mc-name">{{ d.name }}()</span></b>
                          </span>
                          <span class="rel-loc">
                            <span v-if="r.provider.package" class="rel-pkg">{{ r.provider.package }}</span>
                            {{ d.filename }}<template v-if="d.startLine"> · L{{ d.startLine }}</template>
                            <Icon icon="lucide:arrow-up-right" class="rel-loc-go" />
                          </span>
                        </button>
                        <div
                          v-if="d.html"
                          class="edge-code rel-clickable"
                          title="Open this method in the source"
                          @click="onCodeClick(r.provider.id, d.startLine, d.endLine)"
                          v-html="d.html"
                        />
                        <p v-else class="rel-note">{{ d.error || 'No source available.' }}</p>
                      </div>
                      <p v-if="details[r.key].moreDefs" class="rel-note">
                        +{{ details[r.key].moreDefs }} more method<template v-if="details[r.key].moreDefs !== 1">s</template> — open the full details below.
                      </p>

                      <!-- 2 · Aufrufstellen -->
                      <div v-for="u in details[r.key].usages" :key="`u-${u.callerMethod}`" class="rel-block">
                        <!-- Nutzungsort: Klasse.Methode + Package/Datei, ebenfalls anspringbar. -->
                        <button
                          type="button"
                          class="rel-block-head rel-block-head--link"
                          :title="`Open ${u.filename || r.consumer.class_name} at line ${u.sites[0]?.line ?? '?'}`"
                          @click="goTo(r.consumer.id, u.sites[0]?.line ?? null)"
                        >
                          <span class="rel-step">2</span>
                          <span class="rel-block-title">
                            Used in <b>{{ r.consumer.class_name }}.{{ u.callerMethod }}()</b>
                          </span>
                          <span class="rel-loc">
                            <span v-if="r.consumer.package" class="rel-pkg">{{ r.consumer.package }}</span>
                            {{ u.filename }}
                            <Icon icon="lucide:arrow-up-right" class="rel-loc-go" />
                          </span>
                        </button>
                        <!-- Farbe der Aufrufstelle = Farbe ihrer Methode (nur bei genau einer;
                             s. siteVars). Sie faerbt den Streifen und die markierte Zeile. -->
                        <div v-for="(s, i) in u.sites" :key="i" class="rel-site rel-site--mc" :style="siteVars(r, s)">
                          <div
                            class="edge-usage-code rel-clickable"
                            :title="`Open ${r.consumer.class_name} at line ${s.line}`"
                            @click="onCodeClick(r.consumer.id, s.line)"
                            v-html="s.html"
                          />
                          <p class="rel-caption">
                            Line {{ s.line }}<template v-if="!s.lineExact"> (approx.)</template> — the highlighted line is where
                            <template v-for="(c, ci) in s.callees" :key="c">
                              <template v-if="ci"> and </template><code class="rel-mc-code" :style="mcVars(r, c)">{{ c }}()</code>
                            </template>
                            <template v-if="s.callees.length > 1"> are</template><template v-else> is</template> called.
                            <button type="button" class="rel-jump" @click="goTo(r.consumer.id, s.line)">
                              Go to line {{ s.line }}
                              <Icon icon="lucide:arrow-up-right" class="rel-loc-go" />
                            </button>
                          </p>
                        </div>
                        <p v-if="u.moreSites" class="rel-note">+{{ u.moreSites }} more call site<template v-if="u.moreSites !== 1">s</template> in this method.</p>
                        <p v-if="u.error" class="rel-note rel-note--warn">{{ u.error }}</p>
                      </div>
                      <p v-if="details[r.key].moreUsages" class="rel-note">
                        +{{ details[r.key].moreUsages }} more calling method<template v-if="details[r.key].moreUsages !== 1">s</template> — open the full details below.
                      </p>
                      <p v-if="!details[r.key].usages.length" class="rel-note">
                        <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
                        The edge is recorded, but no call could be located in the source — it may be a manual link.
                      </p>

                      <div class="rel-actions">
                        <button type="button" class="rel-btn rel-btn--primary" @click="emit('open', r)">
                          <Icon icon="lucide:code-2" class="h-3.5 w-3.5" />
                          Full details
                        </button>
                        <button type="button" class="rel-btn" @click="goTo(r.provider.id, details[r.key].defs[0]?.startLine, details[r.key].defs[0]?.endLine)">
                          <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                          Open {{ r.provider.class_name }}
                        </button>
                        <button type="button" class="rel-btn" @click="goTo(r.consumer.id, details[r.key].usages[0]?.sites[0]?.line)">
                          <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                          Open {{ r.consumer.class_name }}
                        </button>
                      </div>
                    </template>
                  </template>
                </div>
              </li>
            </ul>
          </div>

          <footer class="shrink-0 border-t border-[var(--color-border)] px-3 py-2 text-2xs text-[var(--color-text-muted)]">
            Arrows read “defines → uses”. Open a row for the code, “Full details” for every call site.
          </footer>
  </div>
</template>

<style scoped>
@reference "../../assets/style.css";

.bundle-end {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  border-radius: 8px;
  background: var(--color-surface-offset);
  padding: 2px 8px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text);
}

/* Zaehler im Kopf: Kategorie + Zahl, in der Farbe der jeweiligen Kantenart. */
.tally {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--k) 32%, transparent);
  background: color-mix(in srgb, var(--k) 12%, transparent);
  padding: 1px 8px;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--k);
}
.tally b {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}
.tally--total {
  --k: var(--color-text-muted);
  border-style: dashed;
  background: none;
}
/* Einordnung fuer Erstleser – bewusst ganze Saetze, nicht noch mehr Fachbegriffe. */
.bp-intro {
  margin-top: 8px;
  border-radius: 8px;
  background: var(--color-surface);
  padding: 7px 9px;
  font-size: 0.6875rem;
  line-height: 1.55;
  color: var(--color-text-muted);
}
.bp-intro b {
  color: var(--color-text);
}

/* Eine Karte = ein Klassenpaar (Kopfzeile + aufklappbarer Codeteil). Der farbige Balken links
   traegt die Kantenart, damit sich die Liste in derselben Sprache liest wie der Graph. */
.rel-card {
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--kind);
  background: var(--color-surface);
}
.rel-row {
  display: grid;
  width: 100%;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 4px 8px;
  padding: 7px 9px;
  text-align: left;
  transition: background 0.15s ease;
}
.rel-row:hover {
  background: var(--color-surface-2);
}
.rel-kind {
  grid-column: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--kind) 16%, transparent);
  padding: 1px 7px;
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--kind);
  white-space: nowrap;
}
.rel-pair {
  display: flex;
  min-width: 0;
  grid-column: 2;
  align-items: center;
  gap: 5px;
}
.rel-class {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text);
}
/* Klassenname als Sprungmarke: unterstrichen erst beim Hover, damit die Kopfzeile ruhig bleibt. */
.rel-class--link {
  border-radius: 4px;
  transition: color 0.15s ease, background 0.15s ease;
}
.rel-class--link:hover {
  background: color-mix(in srgb, var(--kind) 14%, transparent);
  color: var(--kind);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rel-methods {
  display: flex;
  min-width: 0;
  grid-column: 2;
  flex-wrap: wrap;
  gap: 3px;
}
/* Methoden-Chip in der Kopfzeile = Legende der Zeile. Traegt `--mc` (s. mcVars), faellt ohne
   Zuordnung auf das bisherige gedaempfte Grau zurueck. */
.rel-method {
  border-radius: 5px;
  background: color-mix(in srgb, var(--mc, var(--color-text-muted)) 14%, transparent);
  padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--mc, var(--color-text-muted));
}
.rel-more {
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--color-text-muted);
}
.rel-go {
  grid-column: 3;
  grid-row: 1 / span 2;
  color: var(--color-text-muted);
  opacity: 0.6;
  transition: transform 0.2s ease, opacity 0.15s ease;
}
.rel-row:hover .rel-go {
  opacity: 1;
}

/* --- Aufgeklappter Teil ------------------------------------------------------------------- */
.rel-body {
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-2);
  padding: 9px;
}
/* Der Satz, der die Beziehung in Alltagssprache erklaert. */
.rel-explain {
  border-radius: 8px;
  border-left: 2px solid var(--kind);
  background: color-mix(in srgb, var(--kind) 7%, transparent);
  padding: 6px 9px;
  font-size: 0.71875rem;
  line-height: 1.55;
  color: var(--color-text);
}
.rel-block {
  margin-top: 10px;
}
/* Definitionsblock in der Farbe seiner Methode: schmaler Streifen links als gemeinsamer Anker zu
   Chip, Aufrufstelle und Code-Token. Kein Rahmen, kein Kasten – die Zeile ist schon eingerueckt
   genug, hier soll nur die Zugehoerigkeit sichtbar werden. */
.rel-block--mc {
  border-left: 3px solid var(--mc, transparent);
  padding-left: 7px;
  margin-left: -10px;
}
.rel-site--mc {
  border-left: 3px solid var(--mc, transparent);
  padding-left: 7px;
  margin-left: -10px;
}
/* Doppelte Klasse fuer die Spezifitaet: `.rel-step` steht weiter unten in dieser Datei und
   gewaenne bei gleichem Gewicht ueber die Reihenfolge. */
.rel-step.rel-step--mc {
  background: color-mix(in srgb, var(--mc, var(--color-text-muted)) 18%, transparent);
  color: var(--mc, var(--color-text-muted));
}
.rel-mc-name {
  color: var(--mc, inherit);
}
/* Die Code-Bloecke hier sind – anders als im Edge-Modal – NICHT immer dunkel: im Light-Mode
   sitzen sie auf hellem Grund. `--mc-code` ist fuer github-dark gedacht und dort zu blass, also
   die markierte Aufrufzeile auf die kraeftige UI-Farbe umbiegen. Eine Zeile statt einer zweiten
   Regelmenge in style.css – die Container sind Template-Elemente, scoped greift. */
.rel-site--mc .edge-usage-code,
.rel-block--mc .edge-code {
  --mc-code: var(--mc);
}
/* Methodenname in der Bildunterschrift: bei mehreren Aufrufen in einer Zeile ist DAS die
   Zuordnung – der Streifen bleibt dort bewusst neutral. */
.rel-mc-code {
  background: color-mix(in srgb, var(--mc, var(--color-text-muted)) 16%, transparent) !important;
  color: var(--mc, var(--color-text));
  font-weight: 600;
}
.rel-block-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  text-align: left;
}
.rel-block-title b {
  color: var(--color-text);
}
/* Herkunft/Nutzungsort sind Sprungmarken: die ganze Zeile ist die Klickflaeche, der Pfeil rechts
   erscheint beim Hover. */
.rel-block-head--link {
  border-radius: 6px;
  padding: 2px 4px;
  margin-left: -4px;
  transition: background 0.15s ease, color 0.15s ease;
}
.rel-block-head--link:hover {
  background: var(--color-surface-offset);
  color: var(--color-text);
}
.rel-block-head--link:hover .rel-loc-go {
  opacity: 1;
}
/* Package der Klasse – „woher der Code kommt", direkt vor Datei und Zeile. */
.rel-pkg {
  border-radius: 4px;
  background: var(--color-surface-offset);
  padding: 0 4px;
  opacity: 0.9;
}
.rel-loc-go {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}
/* Codeblock als Ganzes anklickbar (Textmarkierung wird respektiert, s. onCodeClick). */
.rel-clickable {
  cursor: pointer;
  border-radius: 8px;
  outline: 1px solid transparent;
  transition: outline-color 0.15s ease;
}
.rel-clickable:hover {
  outline-color: color-mix(in srgb, var(--kind) 55%, transparent);
}
/* Sprung-Link in der Bildunterschrift. */
.rel-jump {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  font-weight: 700;
  color: var(--kind);
  transition: opacity 0.15s ease;
}
.rel-jump .rel-loc-go {
  opacity: 0.7;
}
.rel-jump:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rel-jump:hover .rel-loc-go {
  opacity: 1;
}
/* Schrittnummer: macht die Leserichtung „erst Definition, dann Aufruf" explizit. */
.rel-step {
  display: grid;
  height: 16px;
  width: 16px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 999px;
  background: var(--color-surface-offset);
  font-size: 0.5625rem;
  font-weight: 800;
  color: var(--color-text-muted);
}
.rel-loc {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.625rem;
  opacity: 0.85;
}
.rel-site + .rel-site {
  margin-top: 8px;
}
/* Bildunterschrift unter einem Codefenster – sagt, was die markierte Zeile bedeutet. */
.rel-caption {
  margin-top: 3px;
  font-size: 0.65625rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}
.rel-caption code {
  border-radius: 3px;
  background: var(--color-surface-offset);
  padding: 0 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.rel-note {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
.rel-note--warn {
  color: var(--color-warning);
}
.rel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.rel-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 4px 9px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-text-muted);
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.rel-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.rel-btn--primary {
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
</style>
