// Sofort-Suche (clientseitig) ueber die geladene Artikelliste mit Fuse.js.
// Fuer tiefe Volltextsuche im Body steht zusaetzlich api.search() (FTS5) bereit.
import Fuse from 'fuse.js'
import { computed } from 'vue'

export function useSearch(articlesRef) {
  const fuse = computed(
    () =>
      new Fuse(articlesRef.value, {
        keys: [
          { name: 'title', weight: 3 },
          { name: 'summary', weight: 2 },
          { name: 'tags', weight: 2 },
          { name: 'category.name', weight: 1 },
        ],
        threshold: 0.38,
        ignoreLocation: true,
        minMatchCharLength: 2,
        includeScore: true,
      })
  )

  function run(query) {
    const q = (query || '').trim()
    if (!q) return []
    return fuse.value.search(q).slice(0, 20).map((r) => r.item)
  }

  return { run }
}
