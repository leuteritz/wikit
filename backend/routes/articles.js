import express from 'express'
import {
  db, serializeArticle, setArticleTags, indexArticle,
} from '../db.js'
import { renderMarkdown, slugify } from '../markdown.js'

const router = express.Router()

// Liste fuer Sidebar + Fuse.js-Index (ohne grossen content-Body).
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY title COLLATE NOCASE').all()
  res.json(rows.map(r => serializeArticle(r, { withContent: false })))
})

// Voller Artikel inkl. gerendertem HTML, TOC und Relationen.
router.get('/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug)
  if (!row) return res.status(404).json({ error: 'Artikel nicht gefunden' })
  res.json(serializeArticle(row))
})

router.post('/', async (req, res) => {
  const { title, content = '', summary = '', category_id = null, tags = [] } = req.body || {}
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titel ist erforderlich' })

  const slug = uniqueSlug(req.body.slug || title)
  const { html, toc } = await renderMarkdown(content)

  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO articles (slug, title, summary, content, content_html, toc, category_id)
       VALUES (?,?,?,?,?,?,?)`
    ).run(slug, title.trim(), summary, content, html, JSON.stringify(toc), category_id || null)
    const id = info.lastInsertRowid
    setArticleTags(id, normalizeTags(tags))
    indexArticle(id)
    return id
  })()

  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(created)
  res.status(201).json(serializeArticle(row))
})

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id)
  if (!existing) return res.status(404).json({ error: 'Artikel nicht gefunden' })

  const title = (req.body.title ?? existing.title).trim()
  const content = req.body.content ?? existing.content
  const summary = req.body.summary ?? existing.summary
  const category_id = req.body.category_id ?? existing.category_id
  const slug = req.body.slug && req.body.slug !== existing.slug
    ? uniqueSlug(req.body.slug, id)
    : existing.slug
  const { html, toc } = await renderMarkdown(content)

  db.transaction(() => {
    db.prepare(
      `UPDATE articles
       SET slug=?, title=?, summary=?, content=?, content_html=?, toc=?, category_id=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(slug, title, summary, content, html, JSON.stringify(toc), category_id || null, id)
    if (Array.isArray(req.body.tags)) setArticleTags(id, normalizeTags(req.body.tags))
    indexArticle(id)
  })()

  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id)
  res.json(serializeArticle(row))
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  db.transaction(() => {
    db.prepare('DELETE FROM articles_fts WHERE rowid = ?').run(id)
    db.prepare('DELETE FROM articles WHERE id = ?').run(id) // CASCADE raeumt tags/relations
  })()
  res.status(204).end()
})

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean)
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean)
  return []
}

function uniqueSlug(base, ignoreId = null) {
  let slug = slugify(base) || 'artikel'
  let candidate = slug
  let n = 2
  while (true) {
    const row = db.prepare('SELECT id FROM articles WHERE slug = ?').get(candidate)
    if (!row || row.id === ignoreId) return candidate
    candidate = `${slug}-${n++}`
  }
}

export default router
