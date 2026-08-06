// Der Arbeitsstand des Themen-Bündels – geteilt zwischen `TopicView` (schreibt) und der Sidebar
// in `App.vue` (liest die Zahl). Modul-Singleton-State wie überall in diesem Programm, kein Pinia.
//
// ⚠️ **Die Zahl neben „Topic" ist ein ARBEITSSTAND – weder Bestand noch Befund.** Code und Wiki
// zählen, was da liegt; Insights zählt, was auffällt; hier zählt, was man gerade in der Hand hat.
// Genau deshalb ist sie die einzige Zahl der Sidebar, die auch FEHLEN darf: ohne eingesammeltes
// Bündel steht dort nichts. Eine „0" wäre die Behauptung, hier fehle etwas – und niemand hat
// gefragt. (Das war der Grund, warum die Zeile lange gar keine Zahl trug.)
//
// ⚠️ **Gemerkt wird das THEMA mit, nicht nur die Zahl.** Eine Sidebar, die „12" zeigt, und eine
// Ansicht, die sich beim Öffnen leer meldet, wäre die schlechteste Fassung von beidem: der Klick
// auf die Zahl muss das Bündel zurückbringen, sonst ist sie eine Erinnerung an etwas Verlorenes.
// Derselbe Gedanke wie `lib/codeState.js` in der Code-Ansicht, nur mit einem eigenen Schlüssel:
// zwei Ansichten, zwei Arbeitsstände.
import { computed, ref } from 'vue'

const KEY = 'wikit:topic-state:v1'

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return null
    return {
      term: String(raw.term || ''),
      opts: {
        caseSensitive: !!raw.opts?.caseSensitive,
        wholeWord: !!raw.opts?.wholeWord,
        regex: !!raw.opts?.regex,
      },
      // Ids kommen aus fremdem Speicher – alles, was keine Zahl ist, fliegt raus, sonst steht in
      // der Sidebar eine Zahl über Einträge, die kein Bestand je hergibt.
      picked: Array.isArray(raw.picked) ? raw.picked.filter((n) => Number.isInteger(n)) : [],
    }
  } catch {
    return null
  }
}

const saved = read()
const term = ref(saved?.term || '')
const opts = ref(saved?.opts || { caseSensitive: false, wholeWord: false, regex: false })
const picked = ref(saved?.picked || [])

function write() {
  try {
    if (!term.value || !picked.value.length) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify({ term: term.value, opts: opts.value, picked: picked.value }))
  } catch {
    /* Quota/Privatmodus: der Stand geht verloren, die Ansicht läuft weiter */
  }
}

/** Was gerade eingesammelt ist – `null`, wenn nichts (die Sidebar zeigt dann keine Zahl). */
const pickedCount = computed(() => (term.value && picked.value.length ? picked.value.length : null))

export function useTopic() {
  return {
    topicTerm: term,
    pickedCount,
    /** Der laufende Stand aus `TopicView`. Leere Auswahl = kein Bündel, der Eintrag verschwindet. */
    rememberTopic(nextTerm, nextOpts, ids) {
      term.value = String(nextTerm || '')
      opts.value = { ...nextOpts }
      picked.value = [...(ids || [])]
      write()
    },
    /** Was beim Öffnen der Ansicht wiederhergestellt wird (oder `null`). */
    savedTopic: () => (term.value && picked.value.length ? { term: term.value, opts: opts.value, picked: [...picked.value] } : null),
    forgetTopic() {
      term.value = ''
      picked.value = []
      write()
    },
  }
}
