<script setup>
// Der vierte Modus von `/wiki`: „wie komme ich hier wieder raus – und wieder rein?"
//
// Die anderen drei fragen den Bestand ab (was gibt es · was hängt woran · woran muss ich ran).
// Dieser hier fragt nichts, sondern gibt heraus. Er steht trotzdem hier und nicht unter `/bot`:
// dort geht es um die lokale KI, und ein Backup des Wikis hat damit nichts zu tun.
//
// Zwei Ebenen, und die Trennung ist keine Kür:
//   • **Artikel als Markdown** – zum Lesen, Weitergeben, in ein anderes Werkzeug tragen. Verliert
//     absichtlich alles, was nicht Text ist (Beziehungen, Fassungen, Einstellungen).
//   • **Backup als JSON** – zum Zurückspielen. Nicht zum Lesen gedacht, dafür vollständig.
// Ein Format für beides wäre entweder ein unleserliches Markdown oder ein unvollständiges Backup.
import { ref, computed } from 'vue'
import { api } from '../lib/api.js'
import { BIG_CLIPBOARD_BYTES, copyToClipboard, downloadText } from '../lib/clipboard.js'
import { formatBytes } from '../lib/format.js'
import { useArticles } from '../composables/useArticles.js'
import { useNotifications } from '../composables/useNotifications.js'
import { Icon } from '../lib/icons.js'
import SectionLabel from './ui/SectionLabel.vue'
import ConfirmDialog from './ui/ConfirmDialog.vue'

const { notify } = useNotifications()
const store = useArticles()

// --- Artikel als Markdown -----------------------------------------------------------------------
const md = ref(null)
const mdBusy = ref(false)
const copied = ref(false)
const mdBig = computed(() => (md.value?.bytes || 0) > BIG_CLIPBOARD_BYTES)
const stamp = () => new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)

async function loadMarkdown() {
  mdBusy.value = true
  try {
    md.value = await api.exportArticles()
  } finally {
    mdBusy.value = false
  }
}
async function copyMarkdown() {
  const ok = await copyToClipboard(md.value?.text)
  copied.value = ok
  if (ok) setTimeout(() => (copied.value = false), 2500)
  else notify('The clipboard refused the text — use Download instead.', 'warning')
}

// --- Voll-Backup ---------------------------------------------------------------------------------
const withVersions = ref(false)
const backupBusy = ref(false)

async function downloadBackup() {
  backupBusy.value = true
  try {
    const data = await api.getBackup(withVersions.value)
    downloadText(JSON.stringify(data, null, 2), `wikit-backup-${stamp()}.json`, 'application/json')
    notify(`Backup written — ${data.articles.length} article(s).`, 'success')
  } catch (e) {
    notify(e.message, 'error')
  } finally {
    backupBusy.value = false
  }
}

// --- Zurückspielen -------------------------------------------------------------------------------
// ⚠️ Die Datei wird GELESEN und geprüft, bevor irgendetwas passiert – und die Rückfrage nennt dann
// Zahlen aus ihr. „Restore?" ohne zu sagen, WAS darin steht, ist keine Frage, die man beantworten
// kann.
const fileInput = ref(null)
const pending = ref(null)
const mode = ref('merge')
const restoring = ref(false)

async function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    if (data?.format !== 'wikit-backup') {
      notify('That is not a Wikit backup file.', 'error')
      return
    }
    pending.value = { data, name: file.name }
  } catch {
    notify('The file could not be read as JSON.', 'error')
  }
}

async function confirmRestore() {
  restoring.value = true
  try {
    const res = await api.restoreBackup(pending.value.data, mode.value)
    if (!res?.ok) {
      notify(res?.error || 'The backup could not be restored.', 'error')
      return
    }
    await store.reload()
    notify(
      `Restored: ${res.articles} new, ${res.updated} replaced, ${res.skipped} left alone, ${res.relations} relation(s).`,
      'success',
    )
    pending.value = null
  } catch (e) {
    notify(e.message, 'error')
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <!-- ============ Artikel als Markdown ============ -->
    <section class="rounded-lg border border-line bg-surface-2 p-5">
      <SectionLabel as="h2" class="mb-1">ARTICLES AS MARKDOWN</SectionLabel>
      <p class="mb-4 text-sm text-muted">
        Every article as one text, each with a small header (slug, title, summary, category, tags).
        Plain Markdown — readable anywhere, and the same format this wiki reads back.
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition hover:border-accent hover:text-accent disabled:opacity-50"
          :disabled="mdBusy"
          @click="loadMarkdown"
        >
          <Icon :icon="mdBusy ? 'lucide:loader-2' : 'lucide:file-text'" class="h-4 w-4" :class="mdBusy ? 'animate-spin' : ''" />
          {{ md ? 'Refresh' : 'Prepare export' }}
        </button>

        <template v-if="md">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition"
            :class="mdBig ? 'border border-line text-muted hover:bg-surface-offset' : 'bg-accent text-accent-contrast elev-1 hover:bg-accent-hover'"
            @click="copyMarkdown"
          >
            <Icon :icon="copied ? 'lucide:check' : 'lucide:clipboard-copy'" class="h-4 w-4" />
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition"
            :class="mdBig ? 'bg-accent text-accent-contrast elev-1 hover:bg-accent-hover' : 'border border-line text-muted hover:bg-surface-offset'"
            @click="downloadText(md.text, `wikit-articles-${stamp()}.md`, 'text/markdown;charset=utf-8')"
          >
            <Icon icon="lucide:download" class="h-4 w-4" />
            Download
          </button>
        </template>
      </div>

      <dl v-if="md" class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div
          v-for="s in [
            { k: 'Articles', v: md.articles },
            { k: 'Categories', v: md.categories },
            { k: 'Tags', v: md.tags },
            { k: 'Size', v: formatBytes(md.bytes) },
          ]"
          :key="s.k"
          class="rounded-lg border border-line bg-surface px-3 py-2"
        >
          <dt class="font-mono text-3xs uppercase tracking-[0.12em] text-muted">{{ s.k }}</dt>
          <dd class="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">{{ s.v }}</dd>
        </div>
      </dl>

      <!-- Was NICHT mitfährt. Ohne diesen Satz wäre „every article" eine Zusage, die der Text
           nicht halten kann – dieselbe Regel wie beim Klassenexport. -->
      <p v-if="md" class="mt-3 flex gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-2xs leading-relaxed text-muted">
        <Icon icon="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <span>
          Text only. Typed relations, version history and settings are not in here — for those,
          take the backup below.
        </span>
      </p>

      <p v-if="md" class="mt-3 max-h-40 overflow-auto whitespace-pre rounded-lg border border-line bg-surface p-3 font-mono text-2xs leading-relaxed text-muted">{{ md.text.split('\n').slice(0, 12).join('\n') }}</p>
    </section>

    <!-- ============ Voll-Backup ============ -->
    <section class="rounded-lg border border-line bg-surface-2 p-5">
      <SectionLabel as="h2" class="mb-1">BACKUP</SectionLabel>
      <p class="mb-4 text-sm text-muted">
        One JSON file with articles, categories, tags, typed relations, architecture rules and every
        setting you changed. This is the one you keep — it is what a restore reads.
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-contrast elev-1 transition hover:bg-accent-hover disabled:opacity-50"
          :disabled="backupBusy"
          @click="downloadBackup"
        >
          <Icon :icon="backupBusy ? 'lucide:loader-2' : 'lucide:download'" class="h-4 w-4" :class="backupBusy ? 'animate-spin' : ''" />
          Download backup
        </button>
        <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input v-model="withVersions" type="checkbox" class="accent-[var(--color-accent)]" />
          include version history
        </label>
      </div>
      <p class="mt-2 text-2xs text-muted">
        Every version holds the full article text — with history the file grows by a multiple.
        Java classes are not in here: they have their own export under Code.
      </p>

      <div class="mt-5 border-t border-line pt-4">
        <h3 class="mb-2 text-sm font-semibold text-ink">Restore</h3>
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition hover:border-accent hover:text-accent"
            @click="fileInput.click()"
          >
            <Icon icon="lucide:upload" class="h-4 w-4" />
            Choose a backup file…
          </button>
          <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="onFile" />

          <div class="flex items-center rounded-lg border border-line p-0.5">
            <button
              v-for="m in [
                { key: 'merge', label: 'Keep what is here' },
                { key: 'replace', label: 'Replace by slug' },
              ]"
              :key="m.key"
              type="button"
              class="rounded-md px-2.5 py-1.5 font-mono text-3xs font-semibold transition"
              :class="mode === m.key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'"
              :aria-pressed="mode === m.key"
              @click="mode = m.key"
            >{{ m.label }}</button>
          </div>
        </div>
        <p class="mt-2 text-2xs text-muted">
          Nothing is deleted either way. “Replace by slug” overwrites an article that is already
          here — as a new version, so the state before the restore stays in its history.
        </p>
      </div>
    </section>

    <ConfirmDialog
      :open="!!pending"
      tone="accent"
      icon="lucide:upload"
      size="md"
      title="Restore this backup?"
      :subtitle="pending?.name"
      confirm-label="Restore"
      :busy="restoring"
      busy-label="Restoring…"
      @cancel="pending = null"
      @confirm="confirmRestore"
    >
      <ul v-if="pending" class="mb-3 space-y-1 rounded-lg border border-line bg-surface p-3 font-mono text-xs text-ink">
        <li>{{ pending.data.articles?.length || 0 }} article(s)</li>
        <li>{{ pending.data.categories?.length || 0 }} category(s)</li>
        <li>{{ pending.data.relations?.length || 0 }} relation(s)</li>
        <li>{{ pending.data.settings?.length || 0 }} changed setting(s)</li>
        <li class="text-muted">written {{ (pending.data.generatedAt || '').slice(0, 16).replace('T', ' ') }}</li>
      </ul>
      {{ mode === 'replace'
        ? 'Articles whose slug is already here will be overwritten — as a new version.'
        : 'Articles whose slug is already here will be left alone.' }}
    </ConfirmDialog>
  </div>
</template>
