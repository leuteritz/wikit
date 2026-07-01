// Schmaler REST-Client. Alle Aufrufe gehen relativ an /api (Dev: Vite-Proxy, Prod: gleicher Host).
const BASE = '/api'

async function http(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
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

  listTags: () => http('GET', '/tags'),
  search: (q) => http('GET', `/search?q=${encodeURIComponent(q)}`),

  getGraph: () => http('GET', '/relations'),
  createRelation: (data) => http('POST', '/relations', data),
  deleteRelation: (id) => http('DELETE', `/relations/${id}`),

  analyzeJava: (data) => http('POST', '/java/analyze', data),
  // Mehrklassen-/Roh-Paste-Analyse: { source, overwrite? }. Bei Duplikaten ohne overwrite
  // liefert das Backend { needsConfirm:true, conflicts:[...] } (200) statt zu schreiben.
  analyzeJavaBatch: (data) => http('POST', '/java/analyze-batch', data),
  listJavaFiles: () => http('GET', '/java/files'),
  getJavaFile: (id) => http('GET', `/java/files/${id}`),
  getJavaFileByArticle: (articleId) => http('GET', `/java/files/by-article/${articleId}`),
  getJavaGraph: () => http('GET', '/java/graph'),
  // Shiki-gehighlightetes Quellcode-Snippet einer Methode (Graph-Edge-Panel).
  getJavaMethodSnippet: (fileId, methodName) =>
    http('GET', `/java/method-snippet?fileId=${encodeURIComponent(fileId)}&methodName=${encodeURIComponent(methodName)}`),
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
  summarizeJavaClass: (id, data) => http('POST', `/java/files/${id}/summarize-class`, data),
  linkJavaArticle: (id, data) => http('PUT', `/java/files/${id}`, data),

  // Backend-gehaltene KI-Generierungs-Queue (HTTP-Polling, kein SSE). Der Zustand lebt im
  // Server -> der Nutzer darf die Seite verlassen, die Queue laeuft weiter.
  // queue-class = atomare Analyse-Einheit der Klasse (Methoden -> Klasse). Body: { userContext?, force? }.
  queueJavaClass: (id, data) => http('POST', `/java/files/${id}/queue-class`, data),
  // Alle noch nicht analysierten Klassen gesammelt (topologisch) einreihen.
  analyzeAllJava: (data) => http('POST', '/java/queues/analyze-all', data),
  listJavaQueues: () => http('GET', '/java/queues'),
  getJavaQueue: (id) => http('GET', `/java/queues/${id}`),
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
