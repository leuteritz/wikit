import { ref } from 'vue'

// Globale Benachrichtigungen (Toasts).
//
// Warum zentral: Ein fehlgeschlagener Request landete bisher bestenfalls in einem lokalen
// `error`-Ref der jeweiligen Ansicht – und an mehreren Stellen in einem leeren `catch {}`. Der
// Nutzer sah dann gar nichts ausser einer roten Zeile in der Browser-Konsole, obwohl das Backend
// den Grund praezise mitliefert (`{ error: "…" }`). Meldet stattdessen `lib/api.js` JEDEN Fehler
// hier, gilt die Zusage: egal welcher Knopf, der Nutzer erfaehrt was passiert ist und warum.
//
// Modul-Singleton wie die uebrigen Composables (kein Pinia).

const items = ref([])
let seq = 0

// Lebensdauer je Art. Fehler bleiben stehen (0): Sie sind das Einzige, was der Nutzer
// moeglicherweise noch braucht, wenn er den Blick von der Seite genommen hat.
const TTL = { success: 5000, info: 6000, warning: 9000, error: 0 }

const timers = new Map() // id -> { handle, restMs, startedAt }

function clearTimer(id) {
  const t = timers.get(id)
  if (t?.handle) clearTimeout(t.handle)
  timers.delete(id)
}

function arm(id, ms) {
  if (!ms) return
  const handle = setTimeout(() => dismiss(id), ms)
  timers.set(id, { handle, restMs: ms, startedAt: Date.now() })
}

function dismiss(id) {
  clearTimer(id)
  items.value = items.value.filter((n) => n.id !== id)
}

/**
 * @param {{kind?: 'success'|'info'|'warning'|'error', title?: string, message?: string,
 *          detail?: string, meta?: string}} n
 *   `message` = was der Nutzer wissen muss, `detail` = Technisches zum Aufklappen/Kopieren.
 */
function push(n) {
  const kind = n.kind || 'info'
  const item = {
    id: ++seq,
    kind,
    title: n.title || '',
    message: n.message || '',
    detail: n.detail || '',
    meta: n.meta || '',
    ttl: TTL[kind] ?? 6000,
    count: 1,
  }

  // Derselbe Fehler mehrfach (Retry-Klicks, parallele Requests) stapelt sich sonst zu einer
  // Wand aus identischen Karten -> stattdessen die vorhandene hochzaehlen und neu anstossen.
  const key = `${item.kind}|${item.title}|${item.message}`
  const existing = items.value.find((x) => `${x.kind}|${x.title}|${x.message}` === key)
  if (existing) {
    existing.count++
    existing.meta = item.meta
    clearTimer(existing.id)
    arm(existing.id, existing.ttl)
    return existing.id
  }

  // Deckel: aelteste zuerst raus. Ein Massen-Import mit 50 fehlschlagenden Requests soll den
  // Bildschirm nicht vollstellen.
  items.value = [...items.value, item].slice(-4)
  arm(item.id, item.ttl)
  return item.id
}

export function useNotifications() {
  return {
    items,
    push,
    dismiss,
    notify: (message, kind = 'info', extra = {}) => push({ ...extra, kind, message }),
    notifyError: (message, extra = {}) => push({ ...extra, kind: 'error', message }),
    // Mauszeiger auf der Karte -> Countdown anhalten. Wer liest, soll nicht mitten im Satz
    // verlieren, was er liest.
    pause(id) {
      const t = timers.get(id)
      if (!t?.handle) return
      clearTimeout(t.handle)
      timers.set(id, { handle: null, restMs: Math.max(600, t.restMs - (Date.now() - t.startedAt)), startedAt: 0 })
    },
    resume(id) {
      const t = timers.get(id)
      if (!t || t.handle) return
      arm(id, t.restMs)
    },
    clearAll() {
      for (const n of items.value) clearTimer(n.id)
      items.value = []
    },
  }
}
