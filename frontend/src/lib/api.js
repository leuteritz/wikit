// Schmaler REST-Client. Alle Aufrufe gehen relativ an /api (Dev: Vite-Proxy, Prod: gleicher Host).
import { useNotifications } from '../composables/useNotifications.js'

const BASE = '/api'

// Was der Statuscode fuer den Nutzer bedeutet. Die eigentliche Begruendung liefert das Backend
// als `{ error: "…" }` (all-exceptions.filter.ts) – hier steht nur die Ueberschrift darueber,
// damit „400" nicht das Erste ist, was jemand liest.
const TITLES = {
  400: 'Request rejected',
  401: 'Not authorized',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  413: 'Too large',
  422: 'Request rejected',
  500: 'Server error',
  502: 'Server unreachable',
  503: 'Server unavailable',
  504: 'Server timed out',
}
const titleFor = (status) => TITLES[status] || (status >= 500 ? 'Server error' : 'Request failed')

/**
 * @param {string} method
 * @param {string} url    Pfad unterhalb von /api
 * @param {any}    body
 * @param {{silent?: boolean}} opts  `silent` unterdrueckt den globalen Toast – nur fuer Aufrufe
 *        setzen, deren Fehler an Ort und Stelle bereits sichtbar erklaert wird.
 */
async function http(method, url, body, opts = {}) {
  const { push } = useNotifications()
  const endpoint = `${method} ${BASE}${url}`
  let res
  try {
    res = await fetch(BASE + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    // fetch wirft nur, wenn die Anfrage gar nicht erst ankam: Server aus, Netz weg, DNS. Die
    // Browser-Meldung dazu („Failed to fetch") sagt niemandem etwas – hier steht, was zu tun ist.
    const err = new Error('Cannot reach the server. Is the backend running?')
    err.status = 0
    err.endpoint = endpoint
    if (!opts.silent) {
      push({
        kind: 'error',
        title: 'No connection',
        message: err.message,
        meta: endpoint,
        detail: e?.message || String(e),
      })
    }
    throw err
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null)
    // Backend-Meldung bevorzugen: sie nennt den konkreten Grund („Keine Klasse/Interface/Enum im
    // Quelltext gefunden") statt nur die Statuszeile.
    // 413 kommt NICHT aus all-exceptions.filter.ts, sondern direkt aus dem JSON-Parser in
    // main.ts – also ohne unser `{ error: … }`. Uebrig bliebe "Payload Too Large", und damit
    // weiss niemand, dass dahinter eine einstellbare Grenze steht.
    const tooLarge =
      res.status === 413
        ? 'The request is larger than the server accepts. Paste fewer classes at once, or raise WIKI_BODY_LIMIT on the server.'
        : ''
    const reason = payload?.error || tooLarge || res.statusText || `HTTP ${res.status}`
    const err = new Error(reason)
    err.status = res.status
    err.endpoint = endpoint
    if (!opts.silent) {
      push({
        kind: 'error',
        title: titleFor(res.status),
        message: reason,
        meta: `HTTP ${res.status} · ${endpoint}`,
        detail: payload && !payload.error ? JSON.stringify(payload, null, 2) : '',
      })
    }
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  listArticles: () => http('GET', '/articles'),
  getArticle: (slug) => http('GET', `/articles/${encodeURIComponent(slug)}`),
  createArticle: (data) => http('POST', '/articles', data),
  updateArticle: (id, data) => http('PUT', `/articles/${id}`, data),
  deleteArticle: (id) => http('DELETE', `/articles/${id}`),

  listCategories: () => http('GET', '/categories'),
  createCategory: (data) => http('POST', '/categories', data),

  search: (q) => http('GET', `/search?q=${encodeURIComponent(q)}`),

  createRelation: (data) => http('POST', '/relations', data),
  deleteRelation: (id) => http('DELETE', `/relations/${id}`),

  analyzeJava: (data) => http('POST', '/java/analyze', data),
  // Mehrklassen-/Roh-Paste-Analyse: { source, overwrite? }. Bei Duplikaten ohne overwrite
  // liefert das Backend { needsConfirm:true, conflicts:[...] } (200) statt zu schreiben.
  analyzeJavaBatch: (data) => http('POST', '/java/analyze-batch', data),
  listJavaFiles: () => http('GET', '/java/files'),
  getJavaFile: (id) => http('GET', `/java/files/${id}`),
  getJavaFileByArticle: (articleId) => http('GET', `/java/files/by-article/${articleId}`),
  // Shiki-gehighlightetes Quellcode-Snippet einer Methode (Graph-Edge-Panel).
  // `silent`: Das Edge-/Bundle-Panel holt je Methode ein Snippet und zeigt fehlende an Ort und
  // Stelle als leeren Abschnitt. Ein Toast je Methode waere daneben eine Kaskade ohne Mehrwert.
  getJavaMethodSnippet: (fileId, methodName) =>
    http(
      'GET',
      `/java/method-snippet?fileId=${encodeURIComponent(fileId)}&methodName=${encodeURIComponent(methodName)}`,
      null,
      { silent: true },
    ),
  // Zeilengenaue Suche im Quelltext aller Klassen (globale Suchpalette). Gleiche Schalter wie die
  // Suchleiste im Quellcode-Tab. `silent`: die Palette tippt – ein Toast je Anschlag waere eine
  // Kaskade; der Fehler steht dort an Ort und Stelle in der Ergebnisliste.
  searchJavaCode: (q, { caseSensitive = false, wholeWord = false, regex = false } = {}) =>
    http(
      'GET',
      `/java/code-search?q=${encodeURIComponent(q)}&case=${caseSensitive ? 1 : 0}` +
        `&word=${wholeWord ? 1 : 0}&regex=${regex ? 1 : 0}`,
      null,
      { silent: true },
    ),
  // Shiki-gehighlightetes Fenster um eine Quellzeile (Vorschau der Suchpalette).
  // `silent`: die Vorschau zeigt bereits den unformatierten Ausschnitt aus dem Suchergebnis.
  getJavaSourceWindow: (fileId, line) =>
    http('GET', `/java/source-window?fileId=${encodeURIComponent(fileId)}&line=${encodeURIComponent(line)}`, null, {
      silent: true,
    }),

  deleteJavaFile: (id) => http('DELETE', `/java/files/${id}`),

  // Versionsverlauf (Changelog) einer Klasse. Liste = ohne Quelltext (Diff + KI-Summary);
  // Quelltext einer einzelnen Version separat on-demand.
  getJavaFileVersions: (id) => http('GET', `/java/files/${id}/versions`),
  getJavaFileVersionSource: (id, versionId) =>
    http('GET', `/java/files/${id}/versions/${versionId}/source`),

  // Persistente Klassen-Graph-Kanten (auto + manuell). Quelle der Wahrheit fuers Frontend.
  listJavaEdges: () => http('GET', '/java/edges'),
  createJavaEdge: (data) => http('POST', '/java/edges', data),
  updateJavaEdge: (id, data) => http('PATCH', `/java/edges/${id}`, data),
  deleteJavaEdge: (id) => http('DELETE', `/java/edges/${id}`),
  // Alle Auto-Call-Edges neu berechnen + persistieren (nach Massen-Imports).
  recomputeJavaEdges: () => http('POST', '/java/edges/recompute'),

  summarizeJavaMethod: (id, data) => http('POST', `/java/methods/${id}/summarize`, data),
  linkJavaArticle: (id, data) => http('PUT', `/java/files/${id}`, data),

  // Backend-gehaltene KI-Generierungs-Queue (HTTP-Polling, kein SSE). Der Zustand lebt im
  // Server -> der Nutzer darf die Seite verlassen, die Queue laeuft weiter.
  // queue-class = atomare Analyse-Einheit der Klasse (Methoden -> Klasse). Body: { userContext?, force? }.
  queueJavaClass: (id, data) => http('POST', `/java/files/${id}/queue-class`, data),
  // Alle noch nicht analysierten Klassen gesammelt (topologisch) einreihen.
  // Fortschritt eines laufenden analyze-batch ODER Resets (SSE). EventSource ist kein fetch.
  javaAnalyzeProgressUrl: (jobId) => `${BASE}/java/analyze-progress/${encodeURIComponent(jobId)}`,
  // Komplett-Reset: EIN Request statt eines DELETE je Klasse.
  resetAllJavaFiles: (jobId) => http('DELETE', `/java/files${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`),
  analyzeAllJava: (data) => http('POST', '/java/queues/analyze-all', data),
  // Bulk nach einem Paste: genau diese fileIds einreihen – EIN Request statt einem je Klasse.
  queueJavaBatch: (fileIds, data) => http('POST', '/java/queues/batch', { fileIds, ...data }),
  // `silent`: laeuft im Hintergrund-Polling (alle 3 s). Ohne die Unterdrueckung wuerde ein
  // ausgefallener Server im Minutentakt Fehlerkarten nachschieben – der Nutzer hat den Ausfall
  // nach der ersten begriffen, und eine Meldung, die er nicht ausgeloest hat, ist Laerm.
  listJavaQueues: () => http('GET', '/java/queues', null, { silent: true }),
  // Kompakte Bilanz (Zaehler + Restzeit) fuer das Dauer-Polling; die volle Liste holt nur, wer
  // sie anzeigt (Queue-Modal) – bei 1000 Jobs sind das ~390 KB pro Abruf.
  getJavaQueueSummary: () => http('GET', '/java/queues/summary', null, { silent: true }),
  // Queue-Jobs abbrechen: einzeln (fileId), alle, oder nur die abgeschlossenen ("als gelesen").
  cancelJavaQueue: (fileId) => http('DELETE', `/java/queues/${fileId}`),
  cancelAllJavaQueues: () => http('DELETE', '/java/queues'),
  clearFinishedJavaQueues: () => http('DELETE', '/java/queues/finished'),
  // Live-Token-Strom der KI-Queue (SSE). EventSource ist kein fetch -> nur die URL hier zentral
  // halten (gleiche dokumentierte Ausnahme wie analysisStreamUrl).
  javaQueueStreamUrl: () => `${BASE}/java/queues/stream`,

  // KI-Analyse-Queue: erst start (POST), dann den SSE-Stream oeffnen (EventSource ist kein
  // fetch, daher bleibt nur die URL-Konstruktion hier in api.js zentralisiert).
  startJavaAnalysis: (articleId, data) => http('POST', `/analysis/${articleId}/start`, data),
  cancelJavaAnalysis: (articleId) => http('POST', `/analysis/${articleId}/cancel`),
  analysisStreamUrl: (articleId) => `${BASE}/analysis/stream/${articleId}`,
}
