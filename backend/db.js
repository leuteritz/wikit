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
