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
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../lib/api.js'
import { useJavaAnalyzer } from '../../composables/useJavaAnalyzer.js'
import { addLineNumbers, buildCallWindow } from '../../lib/javaCode.js'
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
  emit('close') // sonst verdeckt das Panel genau den Code, zu dem gesprungen wurde
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
  uses: {
    label: 'uses type',
    color: 'var(--color-cyan)',
    explain: (r) =>
      `${r.consumer.class_name} works with the type ${r.provider.class_name} — as a field, a parameter, a return type or a new ${r.provider.class_name}(). No method call was detected.`,
  },
  import: {
    label: 'imports',
    color: 'var(--color-text-muted)',
    explain: (r) =>
      `${r.consumer.class_name} only imports ${r.provider.class_name}. Nothing in the code uses it — often a leftover import.`,
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
  const t = { call: 0, uses: 0, import: 0 }
  for (const r of relations.value) t[r.kind] = (t[r.kind] || 0) + 1
  return t
})

const methodsOf = (r) => (r.methods || []).filter((m) => m && m.method)
const explainFor = (r) => {
  const names = methodsOf(r).map((m) => `${m.method}()`)
  const list = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ')
  return KIND_META[r.kind].explain(r, list || 'a method')
}

// --- Code nachladen (lazy, einmal je Beziehung) ----------------------------------------------
async function fetchDetail(rel) {
  if (details.value[rel.key] || !props.loadDetail) return
  details.value = { ...details.value, [rel.key]: { loading: true } }
  try {
    const data = (await props.loadDetail(rel)) || {}
    const wanted = (data.methods || []).slice(0, MAX_DEFS)

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
          html: addLineNumbers(snip.combinedHtml ?? snip.html, snip.startLine),
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
          sites: uniq.slice(0, MAX_SITES).map((s) => ({ ...s, html: buildCallWindow(snip.html, base, s.line) })),
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

function toggle(rel) {
  const next = new Set(expanded.value)
  if (next.has(rel.key)) next.delete(rel.key)
  else {
    next.add(rel.key)
    if (methodsOf(rel).length) fetchDetail(rel)
  }
  expanded.value = next
}

function close() {
  emit('close')
}
function onKeydown(e) {
  if (e.key === 'Escape') close()
}
watch(
  () => props.visible,
  (vis) => {
    if (vis) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
    query.value = ''
    expanded.value = new Set()
    details.value = {}
    // Die erste Beziehung gleich aufklappen: das Panel soll Code ZEIGEN, nicht erst anbieten.
    const first = relations.value.find((r) => methodsOf(r).length) || relations.value[0]
    if (vis && first) toggle(first)
  },
)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="slideover">
      <div
        v-if="visible && bundle"
        class="fixed inset-0 z-50"
        role="dialog"
        aria-modal="true"
        aria-label="Bundled class relations"
      >
        <div class="slideover-backdrop absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="close" />

        <aside
          class="slideover-panel absolute right-0 top-0 flex h-full w-[min(96vw,40rem)] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-2xl"
        >
          <header class="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
            <div class="flex items-center justify-between gap-3">
              <h2 class="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--color-text)]">
                <Icon icon="lucide:git-fork" class="h-4 w-4 shrink-0 text-[var(--color-thistle)]" />
                <span class="truncate">Bundled relations</span>
              </h2>
              <button
                type="button"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
                title="Close (ESC)"
                aria-label="Close"
                @click="close"
              >
                <Icon icon="lucide:x" class="h-5 w-5" />
              </button>
            </div>

            <!-- Richtung des Buendels: definierende Seite -> nutzende Seite, wie der Pfeil im Graph. -->
            <div class="mt-2 flex items-center gap-2 text-[13px]">
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
                  <span v-if="methodsOf(r).length" class="rel-methods">
                    <span v-for="m in methodsOf(r).slice(0, 3)" :key="m.edgeId ?? m.method" class="rel-method">{{ m.method }}()</span>
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

                  <!-- Kein Aufruf im Code -> es gibt auch keine Stelle zu zeigen. Ehrlich sagen. -->
                  <template v-if="!methodsOf(r).length">
                    <p class="rel-note">
                      <Icon icon="lucide:info" class="h-3.5 w-3.5 shrink-0" />
                      No call site to show — this relation comes from the type or the import, not from a method call.
                    </p>
                    <div class="rel-actions">
                      <button type="button" class="rel-btn" @click="goTo(r.provider.id)">
                        <Icon icon="lucide:file-code" class="h-3.5 w-3.5" />
                        Open {{ r.provider.class_name }}
                      </button>
                      <button type="button" class="rel-btn" @click="goTo(r.consumer.id)">
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
                      <div v-for="d in details[r.key].defs" :key="`d-${d.name}`" class="rel-block">
                        <!-- Herkunft: Package · Datei · Zeile, komplett anklickbar -> oeffnet die
                             Datei und markiert den ganzen Methodenbereich. -->
                        <button
                          type="button"
                          class="rel-block-head rel-block-head--link"
                          :title="`Open ${d.filename || r.provider.class_name} at line ${d.startLine ?? '?'}`"
                          @click="goTo(r.provider.id, d.startLine, d.endLine)"
                        >
                          <span class="rel-step">1</span>
                          <span class="rel-block-title">
                            Comes from <b>{{ r.provider.class_name }}.{{ d.name }}()</b>
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
                        <div v-for="(s, i) in u.sites" :key="i" class="rel-site">
                          <div
                            class="edge-usage-code rel-clickable"
                            :title="`Open ${r.consumer.class_name} at line ${s.line}`"
                            @click="onCodeClick(r.consumer.id, s.line)"
                            v-html="s.html"
                          />
                          <p class="rel-caption">
                            Line {{ s.line }}<template v-if="!s.lineExact"> (approx.)</template> — the highlighted line is where
                            <template v-for="(c, ci) in s.callees" :key="c">
                              <template v-if="ci"> and </template><code>{{ c }}()</code>
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

          <footer class="shrink-0 border-t border-[var(--color-border)] px-4 py-2.5 text-[11px] text-[var(--color-text-muted)]">
            Arrows read “defines → uses”. Open a row for the code, “Full details” for every call site.
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
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
  font-size: 12px;
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
  font-size: 10px;
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
  font-size: 11px;
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
  font-size: 10px;
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
  font-size: 12px;
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
.rel-method {
  border-radius: 5px;
  background: var(--color-surface-offset);
  padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--color-text-muted);
}
.rel-more {
  font-size: 10px;
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
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--color-text);
}
.rel-block {
  margin-top: 10px;
}
.rel-block-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 11px;
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
  font-size: 9px;
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
  font-size: 10px;
  opacity: 0.85;
}
.rel-site + .rel-site {
  margin-top: 8px;
}
/* Bildunterschrift unter einem Codefenster – sagt, was die markierte Zeile bedeutet. */
.rel-caption {
  margin-top: 3px;
  font-size: 10.5px;
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
  font-size: 11px;
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
  font-size: 11px;
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
