<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useArticles } from '../composables/useArticles.js'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const router = useRouter()
const { analyzeCode, analyzing, error, userContext, linkArticle } = useJavaAnalyzer()
const { create } = useArticles()

const source = ref('')
const filename = ref('')
const result = ref(null) // serialisierte java_file nach erfolgreicher Analyse
const busy = ref(false)
const notice = ref('')

async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  filename.value = f.name
  source.value = await f.text()
}

function reset() {
  source.value = ''
  filename.value = ''
  result.value = null
  notice.value = ''
}

function close() {
  reset()
  emit('close')
}

async function analyze() {
  if (!source.value.trim()) return
  notice.value = ''
  try {
    const res = await analyzeCode(source.value, filename.value)
    result.value = res.file
  } catch {
    // Fehler steht in `error` (Composable) und wird im Template angezeigt.
  }
}

function openInAnalyzer() {
  close()
  router.push('/java')
}

// Kompakter Markdown-Body fuer den Wiki-Artikel (Signaturen kommen spaeter via KI-Panel dazu).
function buildMarkdown(f) {
  const lines = [`# ${f.class_name}`, '']
  if (f.package) lines.push(`**Package:** \`${f.package}\``, '')
  lines.push(`**Typ:** ${f.class_type}`, '')
  if (f.dependencies?.length) {
    lines.push('## Abhängigkeiten', '')
    for (const d of f.dependencies) lines.push(`- \`${d}\``)
    lines.push('')
  }
  return lines.join('\n')
}

async function createArticle() {
  const f = result.value
  if (!f) return
  busy.value = true
  notice.value = ''
  try {
    const article = await create({
      title: f.class_name,
      summary: f.package ? `${f.package}.${f.class_name}` : f.class_name,
      content: buildMarkdown(f),
      tags: ['java', f.class_type],
    })
    await linkArticle(f.id, article.id)
    close()
    router.push(`/article/${article.slug}`)
  } catch (e) {
    notice.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      @keydown.esc="close"
    >
      <div class="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" @click="close" />

      <div class="relative z-10 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950">
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <span class="grid h-9 w-9 place-items-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 16-4-4 4-4M16 8l4 4-4 4M14 4l-4 16" /></svg>
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-lg font-bold text-slate-900 dark:text-white">Java analysieren</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">Lokal geparst – kein Cloud-Dienst. KI-Beschreibungen folgen on-demand.</p>
          </div>
          <button
            type="button"
            class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Schließen"
            @click="close"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <!-- Body -->
        <div class="max-h-[70vh] overflow-y-auto px-5 py-4">
          <!-- Eingabe -->
          <template v-if="!result">
            <div class="mb-3 flex items-center gap-3">
              <label class="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M5 11l7-7 7 7M5 20h14" /></svg>
                .java-Datei wählen
                <input type="file" accept=".java" class="hidden" @change="onFile" />
              </label>
              <span v-if="filename" class="truncate text-sm text-slate-500 dark:text-slate-400">{{ filename }}</span>
            </div>

            <textarea
              v-model="source"
              spellcheck="false"
              placeholder="// Java-Code hier einfügen…"
              class="h-56 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm text-slate-800 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />

            <!-- Projekt-Kontext -->
            <label class="mt-4 block">
              <span class="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8h.01M11 12h1v4h1" /></svg>
                Projekt-Kontext (optional)
              </span>
              <textarea
                v-model="userContext"
                spellcheck="false"
                placeholder="z. B. Windchill-Hintergrund, Modulzweck, Konventionen… – fließt in jeden KI-Prompt ein und bleibt für die Session erhalten."
                class="h-20 w-full resize-y rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
            </label>

            <p v-if="error" class="mt-2 text-sm text-rose-500">{{ error }}</p>
          </template>

          <!-- Ergebnis -->
          <template v-else>
            <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <p class="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                ✓ {{ result.class_name }} analysiert
              </p>
              <p class="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/70">
                {{ result.methods.length }} Methode(n){{ result.package ? ` · ${result.package}` : '' }}.
                Als Wiki-Artikel anlegen, um die gestreamte KI-Analyse zu starten.
              </p>
            </div>
            <p v-if="notice" class="mt-2 text-sm text-rose-500">{{ notice }}</p>
          </template>
        </div>

        <!-- Footer -->
        <footer class="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <template v-if="!result">
            <button
              type="button"
              class="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
              @click="close"
            >Abbrechen</button>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-sm transition hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              :disabled="analyzing || !source.trim()"
              @click="analyze"
            >
              <svg v-if="analyzing" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
              {{ analyzing ? 'Analysiere…' : 'Analysieren' }}
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              @click="openInAnalyzer"
            >Im Analyzer öffnen</button>
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-60"
              :disabled="busy"
              @click="createArticle"
            >
              <svg v-if="busy" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
              {{ busy ? 'Erstelle…' : 'Wiki-Artikel erstellen' }}
            </button>
          </template>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
@reference "../assets/style.css";

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
