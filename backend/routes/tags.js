import express from 'express'
import { db } from '../db.js'

const router = express.Router()

// Alle Tags mit Nutzungszahl (fuer Filter/Autocomplete).
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT t.id, t.name, COUNT(at.article_id) AS count
     FROM tags t LEFT JOIN article_tags at ON at.tag_id = t.id
     GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE`
  ).all()
  res.json(rows)
})

export default router
