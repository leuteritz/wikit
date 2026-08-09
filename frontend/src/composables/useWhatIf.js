// Der Arbeitsstand des Sandkastens: was man vorgemerkt hat, und was dabei herauskäme.
//
// Geteilter Modul-Singleton wie überall in diesem Programm (kein Pinia). Geteilt sein MUSS er, weil
// die Eingriffe an drei Stellen entstehen und an einer vierten gezeigt werden: der Zyklen-Reiter
// bietet „try this" an der Bruchstelle an, der Regel-Reiter an jedem Verstoß, der Sandkasten selbst
// hat sein eigenes Feld – und die Bilanz steht im Sandkasten. Ohne gemeinsamen Stand wäre jeder
// dieser Knöpfe ein Sprung in eine leere Ansicht.
//
// ⚠️ **Die Zahl am Reiter ist ein ARBEITSSTAND, kein Befund** – dieselbe Art Zahl wie beim
// Themen-Bündel und ausdrücklich nicht die der Sidebar. Deshalb bleibt die Insights-Zahl in der
// Sidebar unberührt: sie zählt Zyklen und Regelverstöße („damit stimmt etwas nicht"), und ein
// vorgemerkter Umbau ist das Gegenteil davon – er ist das, was man dagegen vorhat.
//
// ⚠️ **Gemerkt wird über den Reload** (localStorage), aus demselben Grund wie bei `codeState`: ein
// Umbau aus fünf Schritten ist Arbeit, und ein Klick nach `/code`, um sich eine der Klassen
// anzusehen, darf sie nicht kosten. Was zurückkommt, ist trotzdem eine **Erinnerung, keine
// Garantie**: die Ids stammen aus fremdem Speicher, und ob es die Klassen noch gibt, entscheidet
// die nächste Antwort des Servers (`applied: false` samt Grund – s. `what-if.ts`).
import { computed, ref } from 'vue'
import { api } from '../lib/api.js'

const KEY = 'wikit:whatif:v1'

// Wie viele Eingriffe gemerkt werden. Ein Umbau, den man am Stück durchrechnet, hat eine Handvoll
// Schritte; wer dreißig vormerkt, beantwortet keine Frage mehr, sondern lädt eine zweite Codebasis.
const MAX_CHANGES = 20

const OPS = new Set(['remove-edge', 'invert-edge', 'move-class', 'merge-classes', 'remove-class'])

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!Array.isArray(raw)) return []
    // Fremder Speicher: alles, was nicht die Form eines Eingriffs hat, fliegt raus. Sonst schickt
    // die Ansicht beim ersten Lauf einen 400 los, den niemand ausgelöst hat.
    return raw.filter((c) => c && OPS.has(c.op)).slice(0, MAX_CHANGES)
  } catch {
    return []
  }
}

const changes = ref(read())
const result = ref(null)
const running = ref(false)
const error = ref(null)
let inflight = null

function write() {
  try {
    if (changes.value.length) localStorage.setItem(KEY, JSON.stringify(changes.value))
    else localStorage.removeItem(KEY)
  } catch {
    /* privater Modus o. Ä. – der Stand ist dann eben flüchtig */
  }
}

// Zwei Eingriffe sind derselbe, wenn Art und Ziele übereinstimmen. Ohne diesen Vergleich sammelt
// ein zweiter Klick auf „try this" denselben Schritt ein zweites Mal ein – und der zweite wäre
// wirkungslos, stünde aber als eigene Zeile in der Liste.
const idOf = (c) =>
  [c.op, c.from ?? '', c.to ?? '', c.id ?? '', c.into ?? '', c.package ?? ''].join('|')

export function useWhatIf() {
  return {
    changes,
    result,
    running,
    error,
    count: computed(() => changes.value.length),
    /** Ist dieser Eingriff schon vorgemerkt? Der Knopf sagt damit „staged" statt ihn zu doppeln. */
    has: (change) => changes.value.some((c) => idOf(c) === idOf(change)),
    /**
     * Vormerken. Ein bereits vorhandener Eingriff wird NICHT gedoppelt – zurück kommt, ob er neu
     * war, damit der Aufrufer „staged" von „schon drin" unterscheiden kann.
     */
    add(change) {
      if (!OPS.has(change?.op)) return false
      if (changes.value.some((c) => idOf(c) === idOf(change))) return false
      if (changes.value.length >= MAX_CHANGES) return false
      changes.value = [...changes.value, change]
      write()
      return true
    },
    removeAt(index) {
      changes.value = changes.value.filter((_, i) => i !== index)
      write()
      // ⚠️ Das Ergebnis gehört zu einer Liste, die es nicht mehr gibt. Es stehen zu lassen hiesse,
      // eine Bilanz über einen Umbau zu zeigen, der so nicht mehr vorgemerkt ist.
      result.value = null
    },
    clear() {
      changes.value = []
      result.value = null
      error.value = null
      write()
    },
    /** Ist die Liste voll? Der Knopf sagt es, statt stumm nichts zu tun. */
    full: computed(() => changes.value.length >= MAX_CHANGES),
    max: MAX_CHANGES,
    /**
     * Durchrechnen lassen. Ohne Eingriffe gibt es nichts zu fragen – dann wird der letzte Stand
     * gelöscht statt eine leere Bilanz zu holen.
     */
    async run() {
      if (!changes.value.length) {
        result.value = null
        return null
      }
      if (inflight) return inflight
      running.value = true
      error.value = null
      inflight = api
        .simulateInsights(changes.value)
        .then((res) => {
          result.value = res
          return res
        })
        .catch((e) => {
          // Der Toast meldet sich selbst (s. `api.js`); hier bleibt der Grund an der Ansicht
          // stehen, denn der Toast verschwindet und die Frage bleibt offen.
          error.value = e?.error || 'Could not compute the simulation.'
          result.value = null
          return null
        })
        .finally(() => {
          running.value = false
          inflight = null
        })
      return inflight
    },
  }
}
