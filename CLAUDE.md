# CLAUDE.md

Guide for Claude Code (and contributors) working on **this** repo. Operational knowledge about the
code — the user-facing intro lives in `README.md`.

> The primary maintainer communicates in **German**; code, identifiers and commits are English.

## Project overview

**Wikit** is a tiny, self-hosted personal wiki / knowledge base. Single-page app, light enough for
a Raspberry Pi 4 (`http://raspberrypi.local:3000`). **No login, fully local.** The data model is
deliberately generic — it ships with a small demo seed and is meant to hold *any* kind of knowledge
(the maintainer e.g. uses it for PTC Windchill PLM notes, which stay local and out of this repo).
Design goals: **extensibility, scalability, instant search, clean presentation.**

Zusätzlich gibt es einen **Java-Analyzer** (`/java`): `.java`-Quellen werden **lokal** geparst
(`java-parser`, kein JDK), als Klassen-Abhängigkeitsgraph dargestellt und können pro Methode eine
**optionale** KI-Zusammenfassung via **Ollama** (lokal, kein API-Key) bekommen. Eine analysierte
Klasse lässt sich als normaler Wiki-Artikel exportieren — erst dann ist sie über FTS5 durchsuchbar.

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Frontend | Vue 3 (**nur** Composition API mit `<script setup>`), Vite, Vue Router (History-Mode), TailwindCSS **v4** |
| UI-Bausteine | Fuse.js (Sofortsuche), Vue Flow (Graph), CodeMirror 6 (Editor) |
| Backend | NestJS (TypeScript, kompiliert nach `backend/dist`), TypeORM mit **better-sqlite3**-Treiber |
| Markdown | markdown-it + markdown-it-anchor + Shiki + sanitize-html (**server-seitig**) |
| Java-Analyse | `java-parser` (reines JS, **kein JDK/`javac`**, ARM64-tauglich) |
| KI (optional) | Ollama (lokaler LLM-Server, kein API-Key; Default-Modell `phi3:mini`) |
| Datenbank | SQLite (eine Datei) mit FTS5-Volltextindex |

Voraussetzung: **Node ≥ 20**. Das **Frontend** ist ESM (`"type": "module"`); das **Backend** ist
TypeScript und kompiliert via `nest build` nach **CommonJS** (`backend/dist`) — daher steht in
`backend/package.json` **kein** `"type": "module"` mehr. ESM-only-Pakete (Shiki, markdown-it-anchor)
werden im Backend per dynamischem `import()` geladen (s. Stolperfallen). **Optional** für den
Java-Analyzer: ein laufender **Ollama**-Dienst (separat, startet nicht mit der App) — ohne ihn
fallen Methoden-Zusammenfassungen auf den geparsten Javadoc zurück.

## Befehle

```bash
npm install        # installiert Backend + Frontend (npm workspaces, im Root ausführen)
npm run dev        # Entwicklung: NestJS-API :3000 (nest start --watch) + Vite-Dev :5173 (Proxy /api -> :3000)
npm run build      # Backend (nest build -> backend/dist) UND Frontend (-> frontend/dist)
npm start          # Produktion: node backend/dist/main.js serviert API + SPA auf :3000
npm run dev:api    # nur API (nest start --watch)
npm run dev:web    # nur Frontend (vite)
```

Es gibt **keine** Tests und **kein** Lint-Setup. Verifikation = `npm run build` + Server starten +
API/SPA manuell prüfen. **Wichtig:** Das Backend ist jetzt TypeScript — `npm start` braucht ein
vorheriges `npm run build` (`backend/dist`). `npm run dev` kompiliert on-the-fly.

## Architektur

```text
Browser (Vue 3 SPA)  ──/api──►  NestJS  ──TypeORM──►  SQLite (better-sqlite3 + FTS5)
        ▲                            │
        └──── statische SPA ◄────────┘     (EIN Prozess, EIN Port 3000)
```

Kernprinzip: **Markdown wird beim Speichern server-seitig gerendert** (`renderMarkdown` →
HTML + TOC) und in der DB gecacht (`content_html`, `toc`). Der Pi rendert **nicht pro Request**,
der Client lädt kein Highlighter-Bundle. Im Dev läuft das Frontend separat über Vite mit Proxy;
in Produktion liefert NestJS via `ServeStaticModule` `frontend/dist` aus (History-Fallback auf
`index.html`, `exclude: ['/api/(.*)']` damit API-404 nicht vom SPA-Fallback geschluckt werden).

## Projektstruktur

```text
wikit/
├── package.json            # Root, npm workspaces, dev/build/start-Scripts
├── backend/                # NestJS (TypeScript). nest-cli.json, tsconfig*.json; Build -> backend/dist
│   ├── seed/               # Laufzeit-Daten (NICHT kompiliert): manifest.example.js + articles.example/
│   │                       #   (committed demo); manifest.js + articles/ = personal (gitignored).
│   │                       #   seed/package.json hat "type":"module" -> Manifeste bleiben ESM.
│   └── src/
│       ├── main.ts         # Bootstrap: reflect-metadata, JSON-Limit 8mb, globaler Prefix /api, listen
│       ├── app.module.ts   # TypeOrmModule.forRoot(better-sqlite3) + ServeStaticModule + Feature-Module
│       ├── app.controller.ts  # GET /api/health
│       ├── database/       # schema.ts (DDL 1:1), database.service.ts (DDL on init), fts.service.ts (FTS5 raw)
│       ├── entities/       # TypeORM-Entities (article, category, tag, article-tag, relation, java-*)
│       ├── common/         # markdown.service, ollama.service, java-parser, serializer.service,
│       │                   #   tags.service (Tag-Pflege), all-exceptions.filter, seed.service, common.module
│       └── <domain>/       # articles/ categories/ tags/ search/ relations/ java/ je Module+Controller+Service
└── frontend/src/
    ├── App.vue             # Shell: Topbar (inkl. Graph- + Java-Link), Sidebar, Strg+K-Suche, Theme
    ├── router.js           # Routen (lazy-geladene Views)
    ├── components/         # AppSidebar, SearchPalette, ArticleView, TableOfContents,
    │                       # MarkdownEditor, RelationGraph, CategoryBadge, ThemeToggle
    │   └── java/           # JavaDependencyGraph.vue (Vue Flow), JavaClassDetail.vue (Side-Panel)
    ├── views/              # HomeView, ArticleDetail, ArticleEdit, GraphView, JavaAnalyzerView
    ├── composables/        # useArticles (Store), useSearch (Fuse), useTheme, useJavaAnalyzer
    ├── lib/                # api.js (REST-Client), clientMarkdown.js (Editor-Vorschau)
    └── assets/style.css    # Tailwind-Import, Dark-Variante, Shiki-/Prose-Styles
```

## Datenmodell & Konventionen (Backend)

Schema in `backend/src/database/schema.ts` (`SCHEMA`-Konstante, 1:1 aus dem alten `db.js`). Wird
beim Start von `DatabaseService.onModuleInit` per `dataSource.query()` ausgeführt (idempotent,
`CREATE … IF NOT EXISTS`). TypeORM läuft mit **`synchronize: false`** — das Schema (FTS5-Virtual-
Table, `CHECK`, rowid-Kopplung) ist **nicht** ORM-modellierbar, die Entities mappen nur darauf.
**Normalisiert**, nicht free-text:

- `articles` – `slug` (stabile URL, eindeutig), `title`, `summary`, `content` (Markdown =
  **Source of Truth**), `content_html` + `toc` (**Cache**, beim Speichern erzeugt), `category_id`.
- `categories`, `tags`, `article_tags` (M:N), `relations` (gerichteter Graph: `source_id` →
  `target_id`, `relation_type`, `label`).
- `articles_fts` – **eigenständige** FTS5-Tabelle. Wird **nicht per Trigger**, sondern manuell über
  `FtsService.indexArticle(manager, id)` gepflegt (nach jeder Inhalts-/Tag-Änderung, auf dem
  Transaktions-`manager` aufrufen).
- **Java-Analyse:** `java_files` (`class_name`, `class_type`, `package`, `raw_source`, optional
  `article_id` → Artikel-Verknüpfung mit `ON DELETE SET NULL`), `java_methods` (M:1 zu `java_files`,
  CASCADE; `parameters` als JSON-TEXT, `javadoc`, `ai_summary`), `java_dependencies` (Import-FQNs).
  **Wichtig:** Java-Klassen landen **nicht** automatisch im FTS-Index — erst wenn per Button ein
  Wiki-Artikel erzeugt + via `PUT /api/java/files/:id` verknüpft wird (dort `indexArticle`).

**Helfer als Services wiederverwenden statt neu zu schreiben** (alle DI-injizierbar, da
`CommonModule` `@Global` ist):
- `SerializerService` – `serializeArticle(row, {withContent})`, `serializeJavaFile(row, {withSource})`,
  `graphForJavaFiles()`, `tagsForArticle(id)`, `relationsForArticle(id)`. Erzeugt die **exakten**
  JSON-Shapes (Frontend-Contract!) via Repository/QueryBuilder.
- `TagsService` – `getTagId(manager, name)`, `setArticleTags(manager, id, names)` (inkl. Orphan-Prune).
- `FtsService` – `indexArticle(manager, id)`, `search(q)` (FTS5, **Raw-SQL-Ausnahme**).
- `MarkdownService` – `renderMarkdown()`, `slugify()`. `OllamaService` – `generateSummary()`.

Pragmas sind via `prepareDatabase` in `TypeOrmModule.forRoot` gesetzt (`WAL`, `foreign_keys=ON`).
Löschen kaskadiert auf DB-Ebene (Tags/Relationen) – beim Artikel-Delete zusätzlich die
`articles_fts`-Zeile entfernen (siehe `articles/articles.service.ts`).

### REST-API (Kurzform)

`GET/POST /api/articles`, `GET /api/articles/:slug`, `PUT|DELETE /api/articles/:id`,
`GET/POST /api/categories` (`PUT|DELETE /:id`), `GET /api/tags`, `GET /api/search?q=`,
`GET/POST /api/relations` (`DELETE /:id`), `GET /api/health`.
**Java:** `POST /api/java/analyze` (parsen+speichern, liefert Datei + Graph),
`GET /api/java/files` (+ `/:id`), `GET /api/java/graph`,
`POST /api/java/methods/:id/summarize` (KI on-demand), `PUT|DELETE /api/java/files/:id`.
Vollständige Tabelle: `README.md`.

## Frontend-Konventionen

- **Nur** Composition API mit `<script setup>`. Kein Options API.
- **Kein Pinia/Vuex** – Zustand über Composables: `useArticles()` (zentraler Store: Liste,
  Kategorien, CRUD), `useSearch(articlesRef)` (Fuse-Sofortsuche), `useTheme()` (Dark/Light).
- HTTP **ausschließlich** über `lib/api.js` – keine `fetch`-Aufrufe in Komponenten streuen.
- Styling über **Tailwind-Utilities inline** im Template. Scoped `<style>` nur für Sonderfälle.
- **Dark-Mode** über `.dark`-Klasse am `<html>` (gesetzt in `useTheme` + Inline-Script in
  `index.html` gegen FOUC) – **nicht** `prefers-color-scheme` zur Laufzeit.

## ⚠️ Wichtige Stolperfallen (vor dem Editieren lesen)

- **Tailwind v4 + `@apply` in `<style scoped>`**: braucht `@reference "../assets/style.css";` als
  erste Zeile des Style-Blocks, sonst Build-Fehler „Cannot apply unknown utility class". Beispiel:
  `views/ArticleEdit.vue`. Die `dark:`-Variante ist klassenbasiert via `@custom-variant dark` in
  `assets/style.css` definiert (nicht Tailwind-Default).
- **Shiki Dual-Theme**: in `markdown.js` mit `defaultColor: false` gerendert → Farben kommen aus
  CSS-Variablen, die Umschaltung passiert per `html.dark .shiki { … }` in `style.css`. Neue
  Code-Sprache? In die `langs`-Liste in `markdown.js` aufnehmen.
- **TypeORM-Transaktionsregel (korrigiert ggü. better-sqlite3)**: `renderMarkdown()`/`parseJava()`/
  `generateSummary()` sind **async/teuer/extern** → **erst diese ausführen, DANN**
  `dataSource.transaction(async manager => { … })`. Innerhalb der Transaktion **müssen** DB-Calls
  awaited werden (`manager.getRepository(...)`, `manager.query(...)`, `FtsService.indexArticle(manager, …)`).
  Die alte Regel „nie `await` in der Transaktion" galt nur für **synchrones** better-sqlite3 — bei
  TypeORM heißt sie: **kein render/fetch/parse innerhalb**, nur awaited DB-Operationen. Muster:
  `articles/articles.service.ts`, `java/java.service.ts`, `common/seed.service.ts`.
- **FTS aktuell halten**: nach Inhalts- **oder** Tag-Änderung `FtsService.indexArticle(manager, id)`
  aufrufen (auf dem Transaktions-`manager`).
- **FTS5 = einzige Raw-SQL-Ausnahme**: TypeORM kann FTS5 nicht. `indexArticle`/`search` (inkl.
  `snippet()`/`bm25()`/`MATCH`) laufen bewusst über `EntityManager.query()`/`dataSource.query()`
  in `database/fts.service.ts` (dort dokumentiert). Ebenfalls Raw, weil SQLite-spezifisch und vom
  ORM nicht 1:1 abbildbar: das Schema-DDL und einige **`COLLATE NOCASE`-Sortierungen / Aggregat-
  Subqueries** in den List-Endpunkten (articles/categories/tags/java-files). Sonst: Repository/QueryBuilder.
- **TypeORM `synchronize: false`** ist zwingend — sonst zerstört TypeORM die FTS5-Tabelle/das Schema.
  Schema kommt aus `database/schema.ts` (`DatabaseService.onModuleInit`). Entity-`onDelete` ist nur
  Doku; die echten Cascades/`SET NULL` liefert das DDL + `foreign_keys=ON` (Pragma via `prepareDatabase`).
- **ESM-only-Pakete aus CommonJS**: `@shikijs/markdown-it` und `markdown-it-anchor` (v9) sind reine
  ESM-Module, das Backend kompiliert aber nach CommonJS. Laden daher über einen
  `new Function('s','return import(s)')`-Wrapper (echtes dynamisches `import()`, das TS nicht in
  `require()` umschreibt) — siehe `common/markdown.service.ts` und `common/seed.service.ts`.
- **Seed-Pfad nach Build**: `__dirname` zeigt zur Laufzeit auf `backend/dist/…`. `SeedService`
  löst die Seed-Daten daher relativ zur kompilierten Datei auf (`path.resolve(__dirname, '..', '..',
  'seed')` == `backend/seed`). Die Manifeste (`manifest.js`/`manifest.example.js`) sind ESM und
  werden per dynamischem `import(pathToFileURL(...).href)` geladen — `backend/seed/package.json`
  (`"type":"module"`) sorgt dafür, dass sie trotz CommonJS-Backend als ESM gelesen werden.
- **Ollama (KI) ist async + optional**: `OllamaService.generateSummary()` nutzt `fetch` mit hartem
  `AbortController`-Timeout. **Erst generieren (async), dann** Transaktion (Muster:
  `java/java.service.ts`, Route `POST /methods/:id/summarize`). Ist Ollama nicht erreichbar/zu langsam
  → leerer String, der Aufrufer fällt sauber auf Javadoc zurück und liefert `ollama_unavailable: true`
  in einer **200**-Antwort (kein Fehlerstatus!). Konfig über Env: `OLLAMA_URL`, `OLLAMA_MODEL`,
  `OLLAMA_TIMEOUT_MS`.
- **Fehler-Shape**: Alle Fehler gehen über `common/all-exceptions.filter.ts` (global) als
  `{ error: "<Meldung>" }` raus (deutsche Meldungen via `BadRequest/NotFound/ConflictException`,
  500 → „Interner Serverfehler"). DELETE → `@HttpCode(204)`. **Nicht** das Default-Nest-`{statusCode,
  message,error}`-Format verwenden — das Frontend liest nur `err.error`.
- **`java-parser` ist reines JS** (kein JDK/`javac`): bewusst gewählt für ARM64/Pi. CST-Navigation
  läuft über generische Walker-Helfer in `common/java-parser.ts` (`findAll`, `collectTokens`), nicht
  über feste Pfade — robust gegen Grammatik-Details.
- **better-sqlite3 ist nativ**: auf dem Pi (ARM64) ggf. `build-essential` + `python3` nötig, falls
  kein Prebuilt-Binary passt (steht in der README).
- **Seeding**: `runSeed()` füllt **nur bei leerer DB**. Es wird `manifest.js` geladen falls
  vorhanden (persönliches, gitignored), sonst `manifest.example.js` (committed Demo). Jedes Manifest
  exportiert `articlesDir`; `seed.js` liest die `.md` aus diesem Ordner. DB-Reset =
  `backend/data/wiki.db*` löschen und neu starten. **Niemals persönliche Inhalte committen** —
  `backend/seed/articles/`, `backend/seed/manifest.js` und `backend/data/*.db` sind gitignored.
- **Branding/Titel**: Anzeigename kommt aus `frontend/src/config.js` (`WIKI_TITLE`, gespeist aus
  `VITE_WIKI_TITLE`). Keine harten „Wikit"-/Domänen-Strings in Komponenten — immer `WIKI_TITLE` nutzen.
- **Editor-Vorschau** (`lib/clientMarkdown.js`) nutzt bewusst **kein** Shiki (Bundle klein halten) –
  die maßgebliche Darstellung erzeugt immer der Server. Nicht „angleichen" wollen.
- **better-sqlite3 / Server läuft** = DB-Datei gesperrt; vor manuellen DB-Eingriffen Server stoppen.

## Erweitern – typische Aufgaben

- **Seed-Artikel hinzufügen**: `.md` in `backend/seed/articles/` ablegen **und** in
  `backend/seed/manifest.js` eintragen (Metadaten + optional Relationen). Greift nur bei leerer DB;
  bestehende Instanz: per `POST /api/articles` oder im Browser anlegen.
- **Neue API-Ressource**: Modul-Ordner unter `backend/src/<domain>/` anlegen (Controller + Service +
  Module), das Module in `app.module.ts` zu `imports` hinzufügen. Repositories/Services aus
  `CommonModule` (`@Global`) sind überall injizierbar. Controller-Pfade ohne `/api` (globaler Prefix).
- **Neue Frontend-Seite**: View in `frontend/src/views/`, Route in `frontend/src/router.js`
  (lazy `import()`).
- **Neues Schema-Feld**: `SCHEMA` in `src/database/schema.ts` erweitern (`ALTER`/Spalte), passende
  Entity in `src/entities/` + `SerializerService` anpassen; bei durchsuchbarem Text auch
  `FtsService.indexArticle` berücksichtigen.
- **KI-Modell wechseln**: kein Code nötig — `OLLAMA_MODEL` (z. B. `mistral:7b`) bzw. `OLLAMA_URL`
  als Env setzen (Modell vorher per `ollama pull` laden). KI auf anderem LAN-Host: dort
  `OLLAMA_HOST=0.0.0.0`, hier `OLLAMA_URL=http://<host>:11434/api/generate`.

## Deployment (Kurz)

`npm run build && npm start`. Autostart per systemd: `deploy/wikit.service`
(`User`/`WorkingDirectory` anpassen, `systemctl enable --now`). **Backup = `backend/data/wiki.db`
kopieren.** Vollständige Pi-Anleitung in der `README.md`.
