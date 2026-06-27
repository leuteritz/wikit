// Datenbankschema — 1:1 aus dem alten backend/db.js uebernommen.
//
// Warum als Raw-DDL statt TypeORM-`synchronize`? Die FTS5-Virtual-Table `articles_fts`,
// der CHECK-Constraint auf `class_type` und die per rowid an `articles.id` gekoppelte
// Volltext-Tabelle lassen sich von TypeORM nicht modellieren. `CREATE ... IF NOT EXISTS`
// ist idempotent und wirkt damit als Migration. Bestehende wiki.db bleibt kompatibel.
export const SCHEMA = `
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

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, summary, content, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS java_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id       INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  filename         TEXT NOT NULL,
  package          TEXT,
  class_name       TEXT NOT NULL,
  class_type       TEXT CHECK(class_type IN ('class','interface','enum','annotation')),
  raw_source       TEXT NOT NULL,
  description      TEXT,           -- KI-Klassenbeschreibung (Markdown, Source of Truth)
  description_html TEXT,           -- gerenderte Beschreibung (Cache, server-seitig)
  generated_at     TEXT,          -- Zeitpunkt der letzten KI-Analyse
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS java_methods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  method_name TEXT NOT NULL,
  return_type TEXT,
  parameters  TEXT,
  javadoc     TEXT,
  ai_summary  TEXT,
  body        TEXT,                -- geparster Methodenrumpf (Offset-basiert, KI-Kontext)
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_methods_file ON java_methods(file_id);

CREATE TABLE IF NOT EXISTS java_dependencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id  INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  to_class_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_java_deps_from ON java_dependencies(from_file_id);

-- Eigener FTS5-Index fuer analysierte Java-Klassen/Methoden: macht gespeicherte
-- KI-Beschreibungen als Prompt-Kontext (Wissensquelle) durchsuchbar. rowid = java_files.id.
CREATE VIRTUAL TABLE IF NOT EXISTS java_fts USING fts5(
  class_name, package, methods, descriptions,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

// Spaltenweise Nachruest-Migration fuer bestehende DBs: SQLite kann kein
// `ADD COLUMN IF NOT EXISTS`, daher pro Spalte ueber PRAGMA table_info pruefen.
// Wird nach SCHEMA in DatabaseService.onModuleInit ausgefuehrt (idempotent).
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'java_files', column: 'description', ddl: 'ALTER TABLE java_files ADD COLUMN description TEXT' },
  { table: 'java_files', column: 'description_html', ddl: 'ALTER TABLE java_files ADD COLUMN description_html TEXT' },
  { table: 'java_files', column: 'generated_at', ddl: 'ALTER TABLE java_files ADD COLUMN generated_at TEXT' },
  { table: 'java_methods', column: 'body', ddl: 'ALTER TABLE java_methods ADD COLUMN body TEXT' },
];
