// SQLite-Setup, Schema, Migrationen und gemeinsame DB-Helfer.
// better-sqlite3 ist synchron -> ideal fuer einen kleinen Single-User-Dienst auf dem Pi.
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = process.env.WIKI_DB || path.join(DATA_DIR, 'wiki.db')

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT NOT NULL UNIQUE,
  icon       TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT DEFAULT '',
  content      TEXT NOT NULL,
  content_html TEXT DEFAULT '',
  toc          TEXT DEFAULT '[]',
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  relation_type TEXT DEFAULT 'related',
  label         TEXT DEFAULT '',
  UNIQUE (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);

-- Volltextindex (eigenstaendige FTS5-Tabelle; wir pflegen sie ueber indexArticle()).
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, summary, content, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Java-Code-Analyse. CREATE ... IF NOT EXISTS ist idempotent -> wirkt als Migration.
CREATE TABLE IF NOT EXISTS java_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  package     TEXT,
  class_name  TEXT NOT NULL,
  class_type  TEXT CHECK(class_type IN ('class','interface','enum','annotation')),
  raw_source  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS java_methods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  method_name TEXT NOT NULL,
  return_type TEXT,
  parameters  TEXT,       -- JSON-Array als TEXT
  javadoc     TEXT,
  ai_summary  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_methods_file ON java_methods(file_id);

CREATE TABLE IF NOT EXISTS java_dependencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id  INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  to_class_name TEXT NOT NULL   -- importierter Fully Qualified Name
);
CREATE INDEX IF NOT EXISTS idx_java_deps_from ON java_dependencies(from_file_id);
`

export function initDb() {
  db.exec(SCHEMA)
  return db
}

// --- gemeinsame Helfer -------------------------------------------------------

export function upsertCategory({ name, slug, icon = '', sort_order = 0 }) {
  const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)
  if (existing) {
    db.prepare('UPDATE categories SET name=?, icon=?, sort_order=? WHERE id=?')
      .run(name, icon, sort_order, existing.id)
    return existing.id
  }
  return db.prepare('INSERT INTO categories (name, slug, icon, sort_order) VALUES (?,?,?,?)')
    .run(name, slug, icon, sort_order).lastInsertRowid
}

export function getTagId(name) {
  const clean = String(name).trim()
  if (!clean) return null
  const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(clean)
  if (row) return row.id
  return db.prepare('INSERT INTO tags (name) VALUES (?)').run(clean).lastInsertRowid
}

export function setArticleTags(articleId, tagNames = []) {
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId)
  const link = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)')
  for (const name of tagNames) {
    const id = getTagId(name)
    if (id) link.run(articleId, id)
  }
  // verwaiste Tags aufraeumen
  db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM article_tags)')
}

export function tagsForArticle(articleId) {
  return db.prepare(
    `SELECT t.name FROM tags t
     JOIN article_tags at ON at.tag_id = t.id
     WHERE at.article_id = ? ORDER BY t.name`
  ).all(articleId).map(r => r.name)
}

// Aktualisiert den FTS-Eintrag eines Artikels (Tags werden mit eingebettet).
export function indexArticle(articleId) {
  const a = db.prepare('SELECT id, title, summary, content FROM articles WHERE id = ?').get(articleId)
  db.prepare('DELETE FROM articles_fts WHERE rowid = ?').run(articleId)
  if (!a) return
  const tags = tagsForArticle(articleId).join(' ')
  db.prepare('INSERT INTO articles_fts (rowid, title, summary, content, tags) VALUES (?,?,?,?,?)')
    .run(a.id, a.title, a.summary, a.content, tags)
}

// Wandelt eine DB-Zeile in das API-Format (mit Kategorie + Tags + Relationen).
export function serializeArticle(row, { withContent = true } = {}) {
  if (!row) return null
  const category = row.category_id
    ? db.prepare('SELECT id, name, slug, icon FROM categories WHERE id = ?').get(row.category_id)
    : null
  const out = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category,
    tags: tagsForArticle(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (withContent) {
    out.content = row.content
    out.content_html = row.content_html
    out.toc = safeJson(row.toc, [])
    out.relations = relationsForArticle(row.id)
  }
  return out
}

export function relationsForArticle(articleId) {
  const outgoing = db.prepare(
    `SELECT r.id, r.relation_type, r.label, a.id AS article_id, a.slug, a.title
     FROM relations r JOIN articles a ON a.id = r.target_id
     WHERE r.source_id = ?`
  ).all(articleId)
  const incoming = db.prepare(
    `SELECT r.id, r.relation_type, r.label, a.id AS article_id, a.slug, a.title
     FROM relations r JOIN articles a ON a.id = r.source_id
     WHERE r.target_id = ?`
  ).all(articleId)
  return { outgoing, incoming }
}

function safeJson(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// --- Java-Analyse-Helfer -----------------------------------------------------

// Wandelt eine java_files-Zeile ins API-Format (mit Methoden + Dependencies).
export function serializeJavaFile(row, { withSource = false } = {}) {
  if (!row) return null
  const methods = db.prepare(
    'SELECT id, method_name, return_type, parameters, javadoc, ai_summary FROM java_methods WHERE file_id = ? ORDER BY id'
  ).all(row.id).map(m => ({
    ...m,
    parameters: safeJson(m.parameters, []),
  }))
  const dependencies = db.prepare(
    'SELECT to_class_name FROM java_dependencies WHERE from_file_id = ? ORDER BY to_class_name'
  ).all(row.id).map(d => d.to_class_name)
  const articleSlug = row.article_id
    ? (db.prepare('SELECT slug FROM articles WHERE id = ?').get(row.article_id)?.slug ?? null)
    : null
  const out = {
    id: row.id,
    article_id: row.article_id,
    article_slug: articleSlug,
    filename: row.filename,
    package: row.package,
    class_name: row.class_name,
    class_type: row.class_type,
    created_at: row.created_at,
    methods,
    dependencies,
  }
  if (withSource) out.raw_source = row.raw_source
  return out
}

// Globaler Abhaengigkeitsgraph: Knoten = alle java_files, Kanten nur zwischen
// analysierten Klassen (Import-FQN matcht package.class_name exakt, sonst class_name).
export function graphForJavaFiles() {
  const files = db.prepare(
    'SELECT id, package, class_name, class_type FROM java_files'
  ).all()

  // Lookup-Maps fuer die Kanten-Aufloesung aufbauen.
  const byFqn = new Map()
  const byClass = new Map() // class_name -> [ids]
  for (const f of files) {
    const fqn = f.package ? `${f.package}.${f.class_name}` : f.class_name
    byFqn.set(fqn, f.id)
    if (!byClass.has(f.class_name)) byClass.set(f.class_name, [])
    byClass.get(f.class_name).push(f.id)
  }

  const deps = db.prepare('SELECT from_file_id, to_class_name FROM java_dependencies').all()
  const edges = []
  const seen = new Set()
  for (const d of deps) {
    let targetId = byFqn.get(d.to_class_name)
    if (targetId == null) {
      // FQN nicht gefunden -> auf einfachen Klassennamen zurueckfallen (eindeutig).
      const simple = d.to_class_name.split('.').pop()
      const matches = byClass.get(simple)
      if (matches && matches.length === 1) targetId = matches[0]
    }
    if (targetId == null || targetId === d.from_file_id) continue // extern oder Self-Edge
    const key = `${d.from_file_id}->${targetId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: edges.length + 1, source_id: d.from_file_id, target_id: targetId })
  }

  return { nodes: files, edges }
}
