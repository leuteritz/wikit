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
}
