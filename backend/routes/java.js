// Java-Code-Analyse: parsen (rein JS), speichern, Graph liefern, KI-Summaries on-demand.
// Muster wie routes/articles.js: erst async arbeiten, DANN in einer db.transaction() schreiben.
import express from 'express'
import { db, serializeJavaFile, graphForJavaFiles, indexArticle } from '../db.js'
import { parseJava } from '../javaParser.js'
import { generateSummary } from '../ollama.js'

const router = express.Router()

// Datei analysieren: parsen + speichern (ohne KI -> Graph erscheint sofort).
router.post('/analyze', (req, res) => {
  const { source = '', filename = '' } = req.body || {}
  if (!source.trim()) return res.status(400).json({ error: 'Quellcode ist erforderlich' })

  let parsed
  try {
    parsed = parseJava(source)
  } catch (e) {
    return res.status(400).json({ error: `Parsen fehlgeschlagen: ${e.message}` })
  }

  const cls = parsed.primary
  const name = (filename && filename.trim()) || `${cls.class_name}.java`

  const fileId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO java_files (filename, package, class_name, class_type, raw_source)
       VALUES (?,?,?,?,?)`
    ).run(name, parsed.package || null, cls.class_name, cls.class_type, source)
    const id = info.lastInsertRowid

    const insMethod = db.prepare(
      `INSERT INTO java_methods (file_id, method_name, return_type, parameters, javadoc, ai_summary)
       VALUES (?,?,?,?,?,?)`
    )
    for (const m of cls.methods) {
      // ai_summary initial = Javadoc-Fallback (KI spaeter on-demand pro Methode).
      insMethod.run(id, m.method_name, m.return_type, JSON.stringify(m.parameters), m.javadoc || '', m.javadoc || '')
    }

    const insDep = db.prepare('INSERT INTO java_dependencies (from_file_id, to_class_name) VALUES (?,?)')
    for (const fqn of parsed.imports) insDep.run(id, fqn)

    return id
  })()

  const row = db.prepare('SELECT * FROM java_files WHERE id = ?').get(fileId)
  res.status(201).json({ file: serializeJavaFile(row, { withSource: true }), graph: graphForJavaFiles() })
})

// Liste aller analysierten Dateien (ohne raw_source).
router.get('/files', (req, res) => {
  const rows = db.prepare('SELECT * FROM java_files ORDER BY class_name COLLATE NOCASE').all()
  res.json(rows.map(r => serializeJavaFile(r)))
})

// Globaler Abhaengigkeitsgraph (Knoten = Klassen, Kanten = interne Imports).
router.get('/graph', (req, res) => {
  res.json(graphForJavaFiles())
})

// Detail einer Datei inkl. Methoden, Dependencies und Quelltext.
router.get('/files/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM java_files WHERE id = ?').get(Number(req.params.id))
  if (!row) return res.status(404).json({ error: 'Datei nicht gefunden' })
  res.json(serializeJavaFile(row, { withSource: true }))
})

// On-demand KI-Zusammenfassung fuer eine Methode (async, ausserhalb der Transaktion).
router.post('/methods/:id/summarize', async (req, res) => {
  const id = Number(req.params.id)
  const method = db.prepare('SELECT * FROM java_methods WHERE id = ?').get(id)
  if (!method) return res.status(404).json({ error: 'Methode nicht gefunden' })
  const file = db.prepare('SELECT class_name FROM java_files WHERE id = ?').get(method.file_id)

  const summary = await generateSummary({
    className: file?.class_name || '',
    method: { ...method, parameters: safeJson(method.parameters, []) },
  })

  // Fallback: ist Ollama nicht erreichbar, bleibt der Javadoc/bisherige Text erhalten.
  const ollamaUnavailable = !summary
  const finalSummary = summary || method.ai_summary || method.javadoc || ''

  db.transaction(() => {
    db.prepare('UPDATE java_methods SET ai_summary = ? WHERE id = ?').run(finalSummary, id)
  })()

  const updated = db.prepare('SELECT * FROM java_methods WHERE id = ?').get(id)
  res.json({
    method: { ...updated, parameters: safeJson(updated.parameters, []) },
    ollama_unavailable: ollamaUnavailable,
  })
})

// Datei + Methoden + Dependencies loeschen (CASCADE). Verknuepfter Artikel bleibt bestehen.
router.delete('/files/:id', (req, res) => {
  db.prepare('DELETE FROM java_files WHERE id = ?').run(Number(req.params.id))
  res.status(204).end()
})

// Optional: erstellten Wiki-Artikel mit der Java-Datei verknuepfen (macht sie via FTS auffindbar).
router.put('/files/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT * FROM java_files WHERE id = ?').get(id)
  if (!row) return res.status(404).json({ error: 'Datei nicht gefunden' })
  const articleId = req.body?.article_id ?? null

  db.transaction(() => {
    db.prepare('UPDATE java_files SET article_id = ? WHERE id = ?').run(articleId, id)
    if (articleId) indexArticle(articleId)
  })()

  const updated = db.prepare('SELECT * FROM java_files WHERE id = ?').get(id)
  res.json(serializeJavaFile(updated))
})

function safeJson(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

export default router
