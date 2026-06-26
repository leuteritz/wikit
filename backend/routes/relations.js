import express from 'express'
import { db } from '../db.js'

const router = express.Router()

// Kompletter Graph fuer die GraphView: Knoten = Artikel, Kanten = relations.
router.get('/', (req, res) => {
  const nodes = db.prepare(
    `SELECT a.id, a.slug, a.title, c.name AS category, c.slug AS category_slug
     FROM articles a LEFT JOIN categories c ON c.id = a.category_id`
  ).all()
  const edges = db.prepare(
    'SELECT id, source_id, target_id, relation_type, label FROM relations'
  ).all()
  res.json({ nodes, edges })
})

router.post('/', (req, res) => {
  const { source_id, target_id, relation_type = 'related', label = '' } = req.body || {}
  if (!source_id || !target_id) return res.status(400).json({ error: 'source_id und target_id erforderlich' })
  if (source_id === target_id) return res.status(400).json({ error: 'Selbstbezug nicht erlaubt' })
  try {
    const info = db.prepare(
      'INSERT INTO relations (source_id, target_id, relation_type, label) VALUES (?,?,?,?)'
    ).run(source_id, target_id, relation_type, label)
    res.status(201).json(db.prepare('SELECT * FROM relations WHERE id = ?').get(info.lastInsertRowid))
  } catch {
    res.status(409).json({ error: 'Relation existiert bereits' })
  }
})

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM relations WHERE id = ?').run(Number(req.params.id))
  res.status(204).end()
})

export default router
