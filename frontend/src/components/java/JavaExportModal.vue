<script setup>
// Export aller analysierten Klassen als EIN Text.
//
// Der Zweck ist nicht „Datei rausgeben", sondern der **Rueckweg**: der Text ist genau das Format,
// das „Add code" ohnehin versteht (verkettete Kompilationseinheiten). Alles kopieren, alles
// loeschen, wieder einfuegen – und der Bestand steht. Damit das keine Behauptung bleibt, nennt das
// Modal die Zahl, die danach herauskommen muss, und sagt ausdruecklich, was NICHT mitfaehrt.
//
// Zwei Wege raus, weil beide ausfallen koennen: Zwischenablage (auf dem Pi ueber http, daher
// `copyToClipboard` mit execCommand-Fallback) und Download als Datei (rein clientseitig, ohne
// zweiten Request).
import { ref, computed, watch } from 'vue'
import { api } from '../../lib/api.js'
import { copyToClipboard } from '../../lib/clipboard.js'
import { Icon } from '../../lib/icons.js'
import BusyState from '../BusyState.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const data = ref(null)
const loading = ref(false)
const startedAt = ref(0)
const error = ref('')
const copied = ref(false)
const copyFailed = ref(false)

// Ab hier ist die Zwischenablage kein sicherer Weg mehr (der execCommand-Fallback kopiert ueber ein
// <textarea> – bei einigen Megabyte blockiert das den Tab spuerbar). Dann fuehrt der Download.
const BIG_BYTES = 4 * 1024 * 1024

const sizeLabel = computed(() => {
  const b = data.value?.bytes || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
})
const isBig = computed(() => (data.value?.bytes || 0) > BIG_BYTES)
const preview = computed(() => (data.value?.text || '').split('\n').slice(0, 14).join('\n'))
const filename = computed(() => {
  const stamp = (data.value?.generatedAt || '').replace(/[^0-9]/g, '').slice(0, 14)
  return `wikit-classes-${stamp || 'export'}.txt`
})

async function load() {
  loading.value = true
  startedAt.value = Date.now()
  error.value = ''
  copied.value = false
  copyFailed.value = false
  try {
    data.value = await api.exportJavaAll()
  } catch (e) {
    error.value = e.message
    data.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open && !loading.value) load()
  },
)

async function copyAll() {
  if (!data.value?.text) return
  copyFailed.value = false
  const ok = await copyToClipboard(data.value.text)
  copied.value = ok
  copyFailed.value = !ok
  if (ok) setTimeout(() => (copied.value = false), 2500)
}

// Download ohne Server: der Text liegt bereits im Speicher.
function downloadAll() {
  if (!data.value?.text) return
  const url = URL.createObjectURL(new Blob([data.value.text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename.value
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Erst nach dem Klick freigeben – sonst ist der Blob weg, bevor der Browser ihn liest.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <div class="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-2xl">
          <header class="flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-4">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Icon icon="lucide:clipboard-copy" class="h-4.5 w-4.5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-bold text-[var(--color-text)]">Export all classes</h2>
              <p class="text-xs text-[var(--color-text-muted)]">
                One text with every stored source — paste it back into “Add code” to restore them.
              </p>
            </div>
            <button
              type="button"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)]"
              title="Close"
              aria-label="Close"
              @click="emit('close')"
            >
              <Icon icon="lucide:x" class="h-4 w-4" />
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <BusyState
              v-if="loading"
              variant="panel"
              title="Collecting sources…"
              detail="every stored class, ordered by package"
              hint="The whole codebase is read once — large imports take a moment."
              :since="startedAt"
              :rows="4"
            />

            <p v-else-if="error" class="notice-warning rounded-lg px-3 py-2 text-xs">{{ error }}</p>

            <p v-else-if="!data?.classes" class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
              Nothing to export yet — analyze some classes first.
            </p>

            <template v-else>
              <!-- Kennzahlen: das, was nach dem Wieder-Einlesen wieder herauskommen MUSS. -->
              <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div v-for="stat in [
                  { k: 'Classes', v: data.classes },
                  { k: 'Packages', v: data.packages },
                  { k: 'Lines', v: data.lines.toLocaleString('en-US') },
                  { k: 'Size', v: sizeLabel },
                ]" :key="stat.k" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                  <dt class="font-mono text-3xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{{ stat.k }}</dt>
                  <dd class="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[var(--color-text)]">{{ stat.v }}</dd>
                </div>
              </dl>

              <!-- Der Rueckweg in drei Schritten. Er ist der Grund, warum es diesen Export gibt –
                   also steht er als Anleitung da und nicht als Fussnote. -->
              <ol class="mt-4 space-y-1.5 text-xs text-[var(--color-text-muted)]">
                <li v-for="(step, i) in [
                  'Copy the text (or download it as a file).',
                  'Delete everything here if you want a clean slate.',
                  `Open “Add code”, paste, analyze — it should report ${data.classes} classes again.`,
                ]" :key="i" class="flex gap-2">
                  <span class="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--color-surface-offset)] font-mono text-3xs font-semibold text-[var(--color-text)]">{{ i + 1 }}</span>
                  <span>{{ step }}</span>
                </li>
              </ol>

              <!-- Was NICHT mitfaehrt. Ohne diesen Absatz waere „alles" eine Zusage, die der Text
                   nicht halten kann: er traegt Quelltext, sonst nichts. -->
              <p class="mt-3 flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-2xs leading-relaxed text-[var(--color-text-muted)]">
                <Icon icon="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span>
                  Sources only. AI summaries, hand-made edges, wiki links and version history stay
                  behind — a re-import re-parses the code and recomputes the automatic relations.
                  The import also rebuilds each file header, so a blank line between import groups
                  can collapse once; the code itself is untouched and a second round is identical.
                </span>
              </p>

              <!-- Dubletten: der Import behielte ohnehin nur eine je vollqualifiziertem Namen –
                   dass sie schon hier wegfallen, gehoert gesagt, sonst stimmt die Zahl oben nicht
                   mit dem ueberein, was im Bestand liegt. -->
              <p v-if="data.duplicates" class="mt-2 flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-2xs leading-relaxed text-[var(--color-text-muted)]">
                <Icon icon="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span>
                  {{ data.duplicates }} class name(s) exist more than once here and appear only once in
                  the export — a package cannot hold the same class twice, so a re-import would drop
                  them anyway.
                </span>
              </p>

              <p v-if="isBig" class="mt-2 flex gap-2 notice-warning rounded-lg px-3 py-2 text-2xs leading-relaxed">
                <Icon icon="lucide:alert-triangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{{ sizeLabel }} is a lot for a clipboard — the download is the safer way here.</span>
              </p>

              <!-- Vorschau: der Kopf des Exports, damit sichtbar ist, was in der Ablage landet. -->
              <p class="mt-4 mb-1 font-mono text-3xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]">First lines</p>
              <pre class="export-preview overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-2xs leading-relaxed text-[var(--color-text-muted)]">{{ preview }}</pre>
            </template>
          </div>

          <footer class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-5 py-3">
            <span v-if="data?.classes" class="mr-auto font-mono text-3xs text-[var(--color-text-muted)]">
              {{ filename }}
            </span>
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[0.8125rem] font-medium text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-offset)] hover:text-[var(--color-text)] disabled:opacity-40"
              :disabled="!data?.classes"
              title="Save the export as a .txt file"
              @click="downloadAll"
            >
              <Icon icon="lucide:download" class="h-4 w-4" />
              Download
            </button>
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[0.8125rem] font-semibold shadow-sm transition disabled:opacity-40"
              :class="copied
                ? 'bg-[var(--color-success)] text-[var(--color-accent-contrast)]'
                : 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)]'"
              :disabled="!data?.classes"
              @click="copyAll"
            >
              <Icon :icon="copied ? 'lucide:check' : 'lucide:clipboard-copy'" class="h-4 w-4" />
              {{ copied ? 'Copied' : `Copy ${data?.classes || 0} classes` }}
            </button>
            <p v-if="copyFailed" class="w-full text-2xs text-[var(--color-danger)]">
              The clipboard refused the text — use Download instead.
            </p>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "../../assets/style.css";

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
/* Der Ausschnitt behaelt seine Einrueckung; Umbruch waere hier eine Falschaussage ueber den Text. */
.export-preview {
  white-space: pre;
  max-height: 11rem;
}
</style>
