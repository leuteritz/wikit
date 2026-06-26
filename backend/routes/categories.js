import express from 'express'
import { db } from '../db.js'
import { slugify } from '../markdown.js'

const router = express.Router()

// Kategorien inkl. Artikelanzahl (fuer Sidebar-Badges).
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id) AS article_count
     FROM categories c ORDER BY c.sort_order, c.name COLLATE NOCASE`
  ).all()
  res.json(rows)
})

router.post('/', (req, res) => {
  const { name, icon = '', sort_order = 0 } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' })
  const slug = slugify(name)
  try {
    const info = db.prepare('INSERT INTO categories (name, slug, icon, sort_order) VALUES (?,?,?,?)')
      .run(name.trim(), slug, icon, sort_order)
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid))
  } catch {
    res.status(409).json({ error: 'Kategorie existiert bereits' })
  }
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id)
  if (!existing) return res.status(404).json({ error: 'Kategorie nicht gefunden' })
  const name = (req.body.name ?? existing.name).trim()
  const icon = req.body.icon ?? existing.icon
  const sort_order = req.body.sort_order ?? existing.sort_order
  db.prepare('UPDATE categories SET name=?, slug=?, icon=?, sort_order=? WHERE id=?')
    .run(name, slugify(name), icon, sort_order, id)
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id))
})

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id))
  res.status(204).end()
})

export default router
