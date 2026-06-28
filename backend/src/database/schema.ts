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
  class_line       INTEGER,        -- 1-basierte Quellzeile des Klassennamens (Such-Sprung/Highlight)
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
  start_line  INTEGER,             -- 1-basierte Quellzeile der Methodendeklaration (Such-Sprung/Highlight)
  body_start_line INTEGER,         -- 1-basierte Quellzeile der Body-Klammer (Basis fuer exakte Aufrufzeilen)
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_methods_file ON java_methods(file_id);

CREATE TABLE IF NOT EXISTS java_dependencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id  INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  to_class_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_java_deps_from ON java_dependencies(from_file_id);

-- Persistente Klassen-Kanten des Code-Graphen (ersetzt die alte rein client-seitige
-- Substring-Heuristik). source_class ruft method_name auf einer Instanz von target_class auf.
-- is_manual=1 -> vom Nutzer per Drag-to-Connect angelegt (ueberlebt Neuanalyse).
-- dismissed=1 -> vom Nutzer verworfene Auto-Kante (Tombstone: wird NICHT neu erzeugt).
-- confidence < 1 -> unsicherer Auto-Treffer ("Bitte pruefen"-Badge im Frontend).
-- kind='call' -> getypter Methoden-Aufruf (mit method_name-Label). kind='uses' ->
-- struktureller Typ-Bezug (Feld-/Variablen-/Parameter-/Rueckgabetyp, new X(),
-- statischer Aufruf ohne Methoden-Treffer) – kein Label, Fallback je Klassenpaar.
-- SQLite kennt kein BOOLEAN -> INTEGER 0/1.
CREATE TABLE IF NOT EXISTS java_edges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_class TEXT NOT NULL,
  target_class TEXT NOT NULL,
  method_name  TEXT,
  is_manual    INTEGER NOT NULL DEFAULT 0,
  dismissed    INTEGER NOT NULL DEFAULT 0,
  confidence   REAL DEFAULT 1.0,
  kind         TEXT NOT NULL DEFAULT 'call',
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_edges_source ON java_edges(source_class);

-- Eigener FTS5-Index fuer analysierte Java-Klassen/Methoden: macht gespeicherte
-- KI-Beschreibungen als Prompt-Kontext (Wissensquelle) UND den Rohquelltext (globale
-- Code-Suche: Klassen-/Methoden-/Variablennamen) durchsuchbar. rowid = java_files.id.
-- Spaltenreihenfolge ist stabil (snippet()/bm25() referenzieren per Index): source = Index 4.
CREATE VIRTUAL TABLE IF NOT EXISTS java_fts USING fts5(
  class_name, package, methods, descriptions, source,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

// CREATE-Statement der java_fts-Tabelle, separat exportiert fuer die Rebuild-Migration
// (FTS5 kann keine Spalte per ALTER ergaenzen -> bei fehlender `source`-Spalte DROP+CREATE+Reindex).
export const JAVA_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS java_fts USING fts5(
  class_name, package, methods, descriptions, source,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

// Spaltenweise Nachruest-Migration fuer bestehende DBs: SQLite kann kein
// `ADD COLUMN IF NOT EXISTS`, daher pro Spalte ueber PRAGMA table_info pruefen.
// Wird nach SCHEMA in DatabaseService.onModuleInit ausgefuehrt (idempotent).
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'java_files', column: 'description', ddl: 'ALTER TABLE java_files ADD COLUMN description TEXT' },
  { table: 'java_files', column: 'description_html', ddl: 'ALTER TABLE java_files ADD COLUMN description_html TEXT' },
  { table: 'java_files', column: 'generated_at', ddl: 'ALTER TABLE java_files ADD COLUMN generated_at TEXT' },
  { table: 'java_files', column: 'class_line', ddl: 'ALTER TABLE java_files ADD COLUMN class_line INTEGER' },
  { table: 'java_methods', column: 'body', ddl: 'ALTER TABLE java_methods ADD COLUMN body TEXT' },
  { table: 'java_methods', column: 'start_line', ddl: 'ALTER TABLE java_methods ADD COLUMN start_line INTEGER' },
  { table: 'java_methods', column: 'body_start_line', ddl: 'ALTER TABLE java_methods ADD COLUMN body_start_line INTEGER' },
  { table: 'java_edges', column: 'kind', ddl: "ALTER TABLE java_edges ADD COLUMN kind TEXT NOT NULL DEFAULT 'call'" },
];
