// Erst-Befuellung: laeuft nur, wenn die DB noch leer ist (idempotent).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, upsertCategory, setArticleTags, indexArticle } from '../db.js'
import { renderMarkdown, slugify } from '../markdown.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Persoenliches Seed (manifest.js, gitignored) bevorzugen, sonst das mitgelieferte Demo-Seed.
// So startet ein frischer Clone mit Beispielinhalten, ohne dass jemandes Notizen im Repo landen.
async function loadManifest() {
  const hasReal = fs.existsSync(path.join(__dirname, 'manifest.js'))
  const mod = await import(hasReal ? './manifest.js' : './manifest.example.js')
  return {
    categories: mod.categories,
    articles: mod.articles,
    relations: mod.relations,
    articlesDir: mod.articlesDir || 'articles',
  }
}

export async function runSeed() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM articles').get()
  if (c > 0) return

  const { categories, articles, relations, articlesDir } = await loadManifest()

  // Markdown vorab rendern (async), damit der DB-Insert synchron/transaktional bleibt.
  const prepared = []
  for (const a of articles) {
    const content = fs.readFileSync(path.join(__dirname, articlesDir, a.file), 'utf8')
    const { html, toc } = await renderMarkdown(content)
    prepared.push({ ...a, content, html, toc, slug: a.slug || slugify(a.title) })
  }

  const catIdBySlug = {}
  const artIdBySlug = {}

  const insertArticle = db.prepare(
    `INSERT INTO articles (slug, title, summary, content, content_html, toc, category_id)
     VALUES (?,?,?,?,?,?,?)`
  )

  db.transaction(() => {
    for (const cat of categories) catIdBySlug[cat.slug] = upsertCategory(cat)

    for (const a of prepared) {
      const info = insertArticle.run(
        a.slug, a.title, a.summary, a.content, a.html,
        JSON.stringify(a.toc), catIdBySlug[a.category] || null
      )
      const id = info.lastInsertRowid
      artIdBySlug[a.slug] = id
      setArticleTags(id, a.tags)
      indexArticle(id)
    }

    const insertRel = db.prepare(
      'INSERT OR IGNORE INTO relations (source_id, target_id, relation_type, label) VALUES (?,?,?,?)'
    )
    for (const r of relations) {
      const s = artIdBySlug[r.source]
      const t = artIdBySlug[r.target]
      if (s && t) insertRel.run(s, t, r.type || 'related', r.label || '')
    }
  })()

  console.log(`Seed abgeschlossen: ${prepared.length} Artikel, ${categories.length} Kategorien angelegt.`)
}
