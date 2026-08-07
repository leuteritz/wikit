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
      signal: opts.signal,
    })
  } catch (e) {
    // Abgebrochen (der Aufrufer hat weitergetippt) ist kein Fehler: durchreichen, ohne Toast und
    // ohne die „Server nicht erreichbar"-Meldung, die hier sonst folgen wuerde.
    if (e?.name === 'AbortError') throw e
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

  // Das ganze Beziehungsnetz in EINER Antwort ({ nodes, edges }) – Grundlage des Wiki-Graphen.
  getRelationGraph: () => http('GET', '/relations'),
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
  // Alle Quelltexte als EIN Text + Kennzahlen (Export-Modal). Bewusst ein eigener Endpunkt und
  // nicht `listJavaFiles`: die Liste traegt absichtlich KEINE Quelltexte.
  // `ids` schneidet denselben Text auf eine Auswahl zu (Themen-Buendel, `/topic`) – ein zweiter
  // Endpunkt waere dasselbe Format ein zweites Mal, und `topic` steht nur im Kopf des Textes.
  // `silent`, weil die Buendel-Ansicht bei jeder Auswahl neu holt: ein Toast je Haken waere Laerm.
  exportJavaAll: (ids = null, topic = '') =>
    ids
      ? http(
          'GET',
          `/java/export?ids=${ids.join(',')}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`,
          null,
          { silent: true },
        )
      : http('GET', '/java/export'),

  // Zeilengenaue Suche im Quelltext aller Klassen (globale Suchpalette). Gleiche Schalter wie die
  // Suchleiste im Quellcode-Tab. `silent`: die Palette tippt – ein Toast je Anschlag waere eine
  // Kaskade; der Fehler steht dort an Ort und Stelle in der Ergebnisliste.
  // `signal`: die Palette bricht die vorige Suche ab, sobald weitergetippt wird – sonst arbeitet
  // der Server (better-sqlite3 blockiert synchron) noch Anfragen ab, deren Ergebnis niemand mehr
  // sehen will, und die aktuelle steht dahinter in der Schlange.
  // `limit`/`context` sind fuer das Themen-Buendel da: dort zaehlt, WELCHE Klassen den Begriff
  // enthalten (moeglichst viele), nicht wie die Fundstelle aussieht – also mehr Dateien und keine
  // Kontextzeilen. Ohne die beiden bleibt es beim Zuschnitt der Palette.
  searchJavaCode: (
    q,
    { caseSensitive = false, wholeWord = false, regex = false, limit = 0, context = null } = {},
    signal,
  ) =>
    http(
      'GET',
      `/java/code-search?q=${encodeURIComponent(q)}&case=${caseSensitive ? 1 : 0}` +
        `&word=${wholeWord ? 1 : 0}&regex=${regex ? 1 : 0}` +
        (limit ? `&limit=${limit}` : '') +
        (context != null ? `&context=${context}` : ''),
      null,
      { silent: true, signal },
    ),
  // Shiki-gehighlightetes Fenster um eine Quellzeile (Vorschau der Suchpalette).
  // `full`: statt des Fensters die GANZE Klasse (Treffer auf den Klassennamen meint die Klasse).
  // `silent`: die Vorschau zeigt bereits den unformatierten Ausschnitt aus dem Suchergebnis.
  // Wo steht dieser Typ im Quelltext jener Klasse? Belegt eine `uses`-/`import`-Kante, die kein
  // Methoden-Label traegt und deshalb sonst ohne Code dastuende.
  getJavaTypeUsages: (fileId, typeName) =>
    http(
      'GET',
      `/java/type-usages?fileId=${encodeURIComponent(fileId)}&typeName=${encodeURIComponent(typeName)}`,
      null,
      { silent: true },
    ),
  // `raw`: ohne Einruecken – fuer Aufrufer, die das Shiki-HTML zeilenweise in einen Text aus
  // `raw_source` einsetzen (Themen-Buendel) statt es fuer sich anzuzeigen.
  getJavaSourceWindow: (fileId, line, { full = false, raw = false } = {}) =>
    http(
      'GET',
      `/java/source-window?fileId=${encodeURIComponent(fileId)}&line=${encodeURIComponent(line)}` +
        (full ? '&full=1' : '') +
        (raw ? '&raw=1' : ''),
      null,
      { silent: true },
    ),

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
  // `jobId` (optional) schaltet den Fortschritts-Stream ein (javaAnalyzeProgressUrl).
  recomputeJavaEdges: (jobId = null) => http('POST', '/java/edges/recompute', { jobId }),

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

  // --- Bedeutungssuche (Embeddings) -----------------------------------------
  // `silent`, weil ein nicht erreichbarer Ollama hier kein Fehler ist: die Palette zeigt ihre
  // uebrigen Quellen und schreibt an, dass diese fehlt (ein Toast je Tastendruck waere Laerm).
  // `limit` nur fuer das Themen-Buendel: die Palette will die Handvoll bester Treffer neben ihren
  // anderen Quellen, das Buendel die Klassen, die zum Thema gehoeren. Der relative Schnitt gilt
  // in beiden Faellen – der Deckel verschiebt nur, wo er ueberhaupt greifen kann.
  semanticSearchJava: (q, signal, limit = 0) =>
    http(
      'GET',
      `/java/semantic-search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
      null,
      { silent: true, signal },
    ),
  getJavaEmbeddingStatus: () => http('GET', '/java/embeddings', null, { silent: true }),
  rebuildJavaEmbeddings: (jobId = null, force = false) =>
    http('POST', '/java/embeddings/rebuild', { jobId, force }),
  clearJavaEmbeddings: () => http('DELETE', '/java/embeddings'),

  // --- Ask the codebase (/ask) ----------------------------------------------
  // Erst den Strom oeffnen, dann starten (dieselbe Bauart wie Playground und analyze-progress):
  // die Quellen gehen VOR dem ersten Token raus, und ein spaeter geoeffneter Strom haette genau
  // die Auskunft verpasst, an der die Antwort haengt.
  startAsk: (data) => http('POST', '/ask', data),
  cancelAsk: (jobId) => http('POST', `/ask/${encodeURIComponent(jobId)}/cancel`),
  askStreamUrl: (jobId) => `${BASE}/ask/stream/${encodeURIComponent(jobId)}`,

  // --- Insights (/insights) -------------------------------------------------
  // EINE Antwort fuer Klassenkennzahlen, Package-Kennzahlen und Zyklen: sie entstehen aus
  // demselben aufgeloesten Graphen, und zwei Requests koennten zwei Staende zeigen.
  getInsights: () => http('GET', '/insights'),

  // --- Bot (Ollama-Konfiguration, /bot) -------------------------------------
  // Eine Antwort traegt Stand, Defaults, Overrides UND die Feldbeschreibung (Grenzen/Hinweise) –
  // deshalb baut das Formular seine Eingabefelder daraus, statt dieselben Grenzen zu wiederholen.
  getBotSettings: () => http('GET', '/bot/settings'),
  updateBotSettings: (data) => http('PUT', '/bot/settings', data),
  // Ohne `paths` faellt ALLES auf Env/Code-Default zurueck (die Zeilen werden geloescht).
  resetBotSettings: (paths = null) => http('POST', '/bot/settings/reset', paths ? { paths } : {}),
  // `host`/`model` optional: pruefen, BEVOR gespeichert wird. `silent`, weil die Antwort den Grund
  // bereits an Ort und Stelle anzeigt – ein Toast daneben waere dieselbe Meldung zweimal.
  botHealth: ({ host = '', model = '' } = {}) => {
    const q = new URLSearchParams()
    if (host) q.set('host', host)
    if (model) q.set('model', model)
    const s = q.toString()
    return http('GET', `/bot/health${s ? `?${s}` : ''}`, null, { silent: true })
  },
  botModels: (host = '') =>
    http('GET', `/bot/models${host ? `?host=${encodeURIComponent(host)}` : ''}`, null, { silent: true }),
  // Probelauf: erst den Strom oeffnen, dann starten (dieselbe Bauart wie analyze-progress).
  startBotPlayground: (data) => http('POST', '/bot/playground', data),
  cancelBotPlayground: (jobId) => http('POST', `/bot/playground/${encodeURIComponent(jobId)}/cancel`),
  botPlaygroundStreamUrl: (jobId) => `${BASE}/bot/playground/${encodeURIComponent(jobId)}`,
}
