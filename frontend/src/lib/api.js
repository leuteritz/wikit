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
  listJavaFiles: () => http('GET', '/java/files'),
  getJavaFile: (id) => http('GET', `/java/files/${id}`),
  getJavaFileByArticle: (articleId) => http('GET', `/java/files/by-article/${articleId}`),
  getJavaGraph: () => http('GET', '/java/graph'),
  // Shiki-gehighlightetes Quellcode-Snippet einer Methode (Graph-Edge-Panel).
  getJavaMethodSnippet: (fileId, methodName) =>
    http('GET', `/java/method-snippet?fileId=${encodeURIComponent(fileId)}&methodName=${encodeURIComponent(methodName)}`),
  deleteJavaFile: (id) => http('DELETE', `/java/files/${id}`),
  summarizeJavaMethod: (id, data) => http('POST', `/java/methods/${id}/summarize`, data),
  summarizeJavaClass: (id, data) => http('POST', `/java/files/${id}/summarize-class`, data),
  linkJavaArticle: (id, data) => http('PUT', `/java/files/${id}`, data),

  // Backend-gehaltene KI-Generierungs-Queue (HTTP-Polling, kein SSE). Der Zustand lebt im
  // Server -> der Nutzer darf die Seite verlassen, die Queue laeuft weiter.
  queueJavaClass: (id, data) => http('POST', `/java/files/${id}/queue-class`, data),
  queueJavaMethods: (id, data) => http('POST', `/java/files/${id}/queue-methods`, data),
  listJavaQueues: () => http('GET', '/java/queues'),
  getJavaQueue: (id) => http('GET', `/java/queues/${id}`),
  // Queue-Jobs abbrechen: einzeln (fileId + kind) oder alle auf einmal.
  cancelJavaQueue: (fileId, kind) => http('DELETE', `/java/queues/${fileId}/${kind}`),
  cancelAllJavaQueues: () => http('DELETE', '/java/queues'),

  // KI-Analyse-Queue: erst start (POST), dann den SSE-Stream oeffnen (EventSource ist kein
  // fetch, daher bleibt nur die URL-Konstruktion hier in api.js zentralisiert).
  startJavaAnalysis: (articleId, data) => http('POST', `/analysis/${articleId}/start`, data),
  cancelJavaAnalysis: (articleId) => http('POST', `/analysis/${articleId}/cancel`),
  analysisStreamUrl: (articleId) => `${BASE}/analysis/stream/${articleId}`,
}
