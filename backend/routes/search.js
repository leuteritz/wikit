import express from 'express'
import { db, serializeArticle } from '../db.js'

const router = express.Router()

// Serverseitige FTS5-Volltextsuche mit Snippet-Highlights.
// Wird vom Frontend als "Deep Search"-Fallback genutzt (Fuse.js deckt den Sofort-Fall ab).
router.get('/', (req, res) => {
  const q = (req.query.q || '').toString().trim()
  if (!q) return res.json([])

  const match = buildMatch(q)
  let rows
  try {
    rows = db.prepare(
      `SELECT a.*,
              snippet(articles_fts, 2, '<mark>', '</mark>', ' … ', 16) AS snippet,
              bm25(articles_fts) AS rank
       FROM articles_fts
       JOIN articles a ON a.id = articles_fts.rowid
       WHERE articles_fts MATCH ?
       ORDER BY rank
       LIMIT 30`
    ).all(match)
  } catch {
    return res.json([])
  }

  res.json(rows.map(r => ({
    ...serializeArticle(r, { withContent: false }),
    snippet: r.snippet,
  })))
})

// Nutzereingabe in eine sichere FTS5-Query mit Prefix-Suche umwandeln.
function buildMatch(q) {
  const terms = q
    .replace(/["()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"*`)
  return terms.join(' ')
}

export default router
