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

-- Persistente Einstellungen (aktuell: der Bot-Bereich unter /bot). Bewusst key/value statt einer
-- Spalte je Feld: eine FEHLENDE Zeile heisst "nicht gesetzt" und laesst damit den Default aus der
-- Env bzw. dem Code gelten. Genau diese Unterscheidung braucht der Reset-Knopf je Feld -- mit
-- einem NULL-faehigen Spalten-Schema waere "leerer Prompt" und "kein eigener Prompt" dasselbe.
-- value ist immer TEXT (Zahlen als Dezimalstring), die Typisierung leistet BOT_FIELDS.
-- Hinweis: KEIN Semikolon in diesem Kommentar (SCHEMA wird beim Init daran gesplittet).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS java_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id       INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  filename         TEXT NOT NULL,
  package          TEXT,
  class_name       TEXT NOT NULL,
  -- Ohne CHECK: die zulaessigen Werte kommen aus dem Parser (jetzt inkl. 'record'), und ein
  -- CHECK-Constraint laesst sich in SQLite nur ueber einen Tabellen-Rebuild aendern. Genau den
  -- macht DatabaseService.migrateJavaFilesCheck() einmalig fuer bestehende DBs.
  class_type       TEXT,
  stereotype       TEXT,           -- Charakter der Klasse (data/util/exception/abstract/...)
  class_modifiers  TEXT,           -- JSON-Array: ['public','abstract']
  extends_name     TEXT,           -- einfacher Name der Oberklasse
  field_count      INTEGER,        -- deklarierte Felder (Record: Komponenten)
  ctor_count       INTEGER,        -- deklarierte Konstruktoren
  -- Groesse und Verzweigungsdichte (s. common/code-metrics.ts). Beim Analysieren gefuellt, fuer
  -- Altbestand im Hintergrund nachgetragen. NULL heisst "noch nicht gerechnet", NICHT "null Zeilen"
  -- -- genau daran erkennt der Nachtragslauf seine Arbeit.
  loc              INTEGER,        -- Codezeilen ohne Leer- und reine Kommentarzeilen
  complexity       INTEGER,        -- Summe der zyklomatischen Komplexitaet aller Mitglieder
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
  modifiers   TEXT,                -- JSON-Array der Java-Modifier (z. B. ["public","static"])
  javadoc     TEXT,
  ai_summary  TEXT,
  body        TEXT,                -- geparster Methodenrumpf (Offset-basiert, KI-Kontext)
  start_line  INTEGER,             -- 1-basierte Quellzeile der Methodendeklaration (Such-Sprung/Highlight)
  body_start_line INTEGER,         -- 1-basierte Quellzeile der Body-Klammer (Basis fuer exakte Aufrufzeilen)
  -- 'method' | 'constructor' | 'initializer'. Die Tabelle haelt jedes Mitglied MIT Rumpf, nicht
  -- nur Methoden: eine Klasse, die ihre Abhaengigkeiten im Konstruktor verdrahtet, hat dort die
  -- einzige Benutzung einer importierten Klasse, und ohne die Zeile koennte das Edge-Panel die
  -- Aufrufstelle einer so entstandenen Kante nicht zeigen. NULL im Altbestand = 'method'.
  member_kind TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_methods_file ON java_methods(file_id);

CREATE TABLE IF NOT EXISTS java_dependencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id  INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  to_class_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_java_deps_from ON java_dependencies(from_file_id);

-- Versionsverlauf ("Changelog") einer analysierten Java-Klasse: bei erneutem Hochladen
-- derselben Klasse (class_name + package) wird der Datensatz aktualisiert (java_files.id
-- bleibt stabil) UND hier ein Snapshot abgelegt. version_number ist 1-basiert je Klasse.
-- diff = Unified-Diff zur Vorversion (NULL bei Version 1). ai_summary(_html) = KI-Zusammenfassung
-- der Aenderung, asynchron nachgetragen (NULL bei Version 1 oder wenn Ollama fehlt).
-- batch = Zeitstempel des LAUFS, der diese Zeile geschrieben hat (alle Klassen eines Imports
-- teilen ihn). Er ist der Bezugspunkt des Drift-Berichts und die einzige Angabe, die sich NICHT
-- ableiten laesst: created_at streut ueber die Sekunden eines Massen-Imports, und wer daraus
-- Laeufe gruppieren wollte, brauchte eine erfundene Toleranz. NULL = Altbestand, dort bleibt
-- der Kalendertag der Bezugspunkt.
-- Hinweis: KEIN Semikolon in diesem Kommentar (SCHEMA wird beim Init daran gesplittet).
CREATE TABLE IF NOT EXISTS java_file_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  java_file_id    INTEGER NOT NULL REFERENCES java_files(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  source          TEXT NOT NULL,
  diff            TEXT,
  ai_summary      TEXT,
  ai_summary_html TEXT,
  batch           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (java_file_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_java_file_versions_file ON java_file_versions(java_file_id);

-- Persistente Klassen-Kanten des Code-Graphen (ersetzt die alte rein client-seitige
-- Substring-Heuristik). source_class ruft method_name auf einer Instanz von target_class auf.
-- is_manual=1 -> vom Nutzer per Drag-to-Connect angelegt (ueberlebt Neuanalyse).
-- dismissed=1 -> vom Nutzer verworfene Auto-Kante (Tombstone: wird NICHT neu erzeugt).
-- confidence < 1 -> unsicherer Auto-Treffer ("Bitte pruefen"-Badge im Frontend).
-- kind='call' -> getypter Methoden-Aufruf (mit method_name-Label). kind='uses' ->
-- struktureller Typ-Bezug (Feld-/Variablen-/Parameter-/Rueckgabetyp, new X(),
-- statischer Aufruf ohne Methoden-Treffer) – kein Label, Fallback je Klassenpaar.
-- SQLite kennt kein BOOLEAN -> INTEGER 0/1.
-- source_pkg/target_pkg machen die Kante EINDEUTIG: der einfache Klassenname allein ist es nicht
-- (zwei Klassen 'Header' in verschiedenen Packages sind zwei verschiedene Klassen, und ohne das
-- Package verschmolzen ihre Kanten zu einer). Der Name bleibt trotzdem die fuehrende Angabe --
-- er ueberlebt einen Re-Import, waehrend eine java_files.id das nicht tut. NULL = Altbestand
-- oder default package, dann faellt die Zuordnung auf den Namen zurueck.
-- Hinweis: KEIN Semikolon in diesem Kommentar (SCHEMA wird beim Init daran gesplittet).
CREATE TABLE IF NOT EXISTS java_edges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_class TEXT NOT NULL,
  source_pkg   TEXT,
  target_class TEXT NOT NULL,
  target_pkg   TEXT,
  method_name  TEXT,
  is_manual    INTEGER NOT NULL DEFAULT 0,
  dismissed    INTEGER NOT NULL DEFAULT 0,
  confidence   REAL DEFAULT 1.0,
  kind         TEXT NOT NULL DEFAULT 'call',
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_java_edges_source ON java_edges(source_class);

-- Bedeutungssuche: EIN Vektor je Klasse, erzeugt von einem Embedding-Modell ueber Ollama.
--
-- Warum eine Zeile je Klasse und kein Chunking je Methode: die Frage, die diese Suche beantwortet,
-- lautet „welche Klasse kuemmert sich um X?" -- und die Klasse ist auch sonst ueberall die Einheit
-- (Karte, Artikel, Kante). Methodenweise waeren es zehnmal so viele Vektoren fuer eine Frage, die
-- so niemand stellt.
--
-- source_hash ist der sha1 des EINGEBETTETEN Textes, nicht des Quelltexts: der Text enthaelt auch
-- die KI-Beschreibung, und die entsteht spaeter als die Klasse. Damit ist "veraltet" ableitbar
-- statt gemerkt -- es gibt keinen Schreibpfad, der an eine Invalidierung denken muesste.
-- model steht dabei, weil Vektoren verschiedener Modelle NICHT vergleichbar sind: ein Wechsel
-- macht den ganzen Index ungueltig, und genau das erkennt die Suche daran.
-- vector ist Float32 als BLOB (768 Dim = 3072 Bytes) -- als JSON-TEXT waere es das Dreifache und
-- muesste bei jeder Anfrage geparst werden.
-- Hinweis: KEIN Semikolon und KEIN Backtick in diesem Kommentar -- SCHEMA wird am Semikolon
-- gesplittet, und ein Backtick beendet das Template-Literal mitten im DDL.
CREATE TABLE IF NOT EXISTS java_embeddings (
  file_id     INTEGER PRIMARY KEY REFERENCES java_files(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  vector      BLOB NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Dasselbe fuer Artikel -- damit /ask den zweiten Wissensspeicher dieses Wikis sieht.
--
-- Warum eine EIGENE Tabelle und keine Spalte mehr in java_embeddings: der Primaerschluessel traegt
-- dort die CASCADE auf java_files, und zwei Fremdschluessel in einer Zeile waeren nur einer, der
-- meistens NULL ist. Die Spalten sind absichtlich Zeichen fuer Zeichen dieselben -- was fuer den
-- einen Index gilt, gilt fuer den anderen (siehe der Block darueber): source_hash macht "veraltet"
-- ableitbar, model macht einen Modellwechsel erkennbar.
--
-- ⚠️ Beide Indizes MUESSEN dasselbe Modell benutzen. /ask mischt ihre Treffer in EINE Rangliste,
-- und Vektoren aus verschiedenen Raeumen haben keinen vergleichbaren Abstand -- die gemischte Liste
-- waere dann nach einer Zahl sortiert, die auf beiden Seiten etwas anderes bedeutet.
CREATE TABLE IF NOT EXISTS article_embeddings (
  article_id  INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  vector      BLOB NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

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

// Zweiter Index ueber DENSELBEN Rohquelltext – mit `trigram` statt `unicode61`, und genau darin
// liegt der Zweck: unicode61 matcht nur Token-PRAEFIXE, die Code-Suche fragt aber nach beliebigen
// TEILSTRINGEN (`ById` in `findById`), nach Interpunktion (`repo.get(`, die der Wort-Tokenizer
// wegwirft) und ohne Ruecksicht auf Gross-/Kleinschreibung. Jede solche Anfrage fiel bisher auf den
// Vollscan zurueck – gemessen 1500 gelesene Quelltexte pro Tastendruck; mit Trigram sind es 0-1 ms
// Kandidatenauswahl (s. „Warum die Code-Suche einen zweiten Index hat" in CLAUDE.md).
//
// `content=''`, weil der Text bereits in `java_files.raw_source` steht – ein zweites Mal speichern
// wuerde die DB unnoetig aufblaehen (gemessen 84,5 MB statt 53,7 MB bei 28,3 MB Quelltext).
// `contentless_delete=1` (SQLite >= 3.47) haelt trotzdem ein normales DELETE offen, damit die
// Pflege exakt dieselbe Form hat wie bei java_fts: DELETE + INSERT.
//
// NICHT Teil von SCHEMA: `contentless_delete` kennt aeltere SQLite nicht, und SCHEMA laeuft als
// eine Kette – ein Fehler darin risse den Start mit. Angelegt wird die Tabelle deshalb einzeln und
// mit Fallback in DatabaseService.ensureJavaSourceIndex().
export const JAVA_SRC_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS java_src_fts USING fts5(
  source,
  tokenize = 'trigram',
  content = '',
  contentless_delete = 1
)`;

// Kuerzeste Anfrage, die der Trigram-Index beantworten kann. Darunter (1-2 Zeichen) gibt es kein
// vollstaendiges Trigramm -> der Index kann nichts ausschliessen, es bleibt beim alten Weg.
export const TRIGRAM_MIN_CHARS = 3;

// Spaltenweise Nachruest-Migration fuer bestehende DBs: SQLite kann kein
// `ADD COLUMN IF NOT EXISTS`, daher pro Spalte ueber PRAGMA table_info pruefen.
// Wird nach SCHEMA in DatabaseService.onModuleInit ausgefuehrt (idempotent).
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'java_files', column: 'description', ddl: 'ALTER TABLE java_files ADD COLUMN description TEXT' },
  { table: 'java_files', column: 'description_html', ddl: 'ALTER TABLE java_files ADD COLUMN description_html TEXT' },
  { table: 'java_files', column: 'generated_at', ddl: 'ALTER TABLE java_files ADD COLUMN generated_at TEXT' },
  { table: 'java_files', column: 'class_line', ddl: 'ALTER TABLE java_files ADD COLUMN class_line INTEGER' },
  { table: 'java_files', column: 'stereotype', ddl: 'ALTER TABLE java_files ADD COLUMN stereotype TEXT' },
  { table: 'java_files', column: 'class_modifiers', ddl: 'ALTER TABLE java_files ADD COLUMN class_modifiers TEXT' },
  { table: 'java_files', column: 'extends_name', ddl: 'ALTER TABLE java_files ADD COLUMN extends_name TEXT' },
  { table: 'java_files', column: 'field_count', ddl: 'ALTER TABLE java_files ADD COLUMN field_count INTEGER' },
  { table: 'java_files', column: 'ctor_count', ddl: 'ALTER TABLE java_files ADD COLUMN ctor_count INTEGER' },
  { table: 'java_files', column: 'loc', ddl: 'ALTER TABLE java_files ADD COLUMN loc INTEGER' },
  { table: 'java_files', column: 'complexity', ddl: 'ALTER TABLE java_files ADD COLUMN complexity INTEGER' },
  { table: 'java_methods', column: 'modifiers', ddl: 'ALTER TABLE java_methods ADD COLUMN modifiers TEXT' },
  { table: 'java_methods', column: 'body', ddl: 'ALTER TABLE java_methods ADD COLUMN body TEXT' },
  { table: 'java_methods', column: 'start_line', ddl: 'ALTER TABLE java_methods ADD COLUMN start_line INTEGER' },
  { table: 'java_methods', column: 'body_start_line', ddl: 'ALTER TABLE java_methods ADD COLUMN body_start_line INTEGER' },
  { table: 'java_methods', column: 'member_kind', ddl: 'ALTER TABLE java_methods ADD COLUMN member_kind TEXT' },
  { table: 'java_edges', column: 'kind', ddl: "ALTER TABLE java_edges ADD COLUMN kind TEXT NOT NULL DEFAULT 'call'" },
  { table: 'java_edges', column: 'source_pkg', ddl: 'ALTER TABLE java_edges ADD COLUMN source_pkg TEXT' },
  { table: 'java_edges', column: 'target_pkg', ddl: 'ALTER TABLE java_edges ADD COLUMN target_pkg TEXT' },
  { table: 'java_file_versions', column: 'batch', ddl: 'ALTER TABLE java_file_versions ADD COLUMN batch TEXT' },
];
