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

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Frontend | Vue 3 (**nur** Composition API mit `<script setup>`), Vite, Vue Router (History-Mode), TailwindCSS **v4** |
| UI-Bausteine | Fuse.js (Sofortsuche), Vue Flow (Graph), CodeMirror 6 (Editor) |
| Backend | Node.js (ESM), Express, better-sqlite3 (**kein ORM**, direkte Queries) |
| Markdown | markdown-it + markdown-it-anchor + Shiki + sanitize-html (**server-seitig**) |
| Datenbank | SQLite (eine Datei) mit FTS5-Volltextindex |

Voraussetzung: **Node ≥ 20**. Projekt ist ESM (`"type": "module"` überall).

## Befehle

```bash
npm install        # installiert Backend + Frontend (npm workspaces, im Root ausführen)
npm run dev        # Entwicklung: Express-API :3000 + Vite-Dev :5173 (Proxy /api -> :3000)
npm run build      # Frontend -> frontend/dist
npm start          # Produktion: ein Express-Prozess serviert API + SPA auf :3000
npm run dev:api    # nur API (node --watch)
npm run dev:web    # nur Frontend (vite)
```

Es gibt **keine** Tests und **kein** Lint-Setup. Verifikation = `npm run build` + Server starten +
API/SPA manuell prüfen.

## Architektur

```text
Browser (Vue 3 SPA)  ──/api──►  Express  ──►  SQLite (better-sqlite3 + FTS5)
        ▲                            │
        └──── statische SPA ◄────────┘     (EIN Prozess, EIN Port 3000)
```

Kernprinzip: **Markdown wird beim Speichern server-seitig gerendert** (`renderMarkdown` →
HTML + TOC) und in der DB gecacht (`content_html`, `toc`). Der Pi rendert **nicht pro Request**,
der Client lädt kein Highlighter-Bundle. Im Dev läuft das Frontend separat über Vite mit Proxy;
in Produktion liefert Express `frontend/dist` aus (History-Fallback auf `index.html`).

## Projektstruktur

```text
wikit/
├── package.json            # Root, npm workspaces, dev/build/start-Scripts
├── backend/
│   ├── server.js           # Express: Router einhängen + SPA ausliefern; ruft initDb()+runSeed()
│   ├── db.js               # SQLite-Setup, Schema, gemeinsame Helfer (s.u.)
│   ├── markdown.js         # markdown-it + Shiki + sanitize; renderMarkdown(), slugify()
│   ├── routes/             # articles.js, categories.js, tags.js, search.js, relations.js
│   └── seed/               # seed.js (Runner); manifest.example.js + articles.example/ (committed demo);
│                           #   manifest.js + articles/ = personal content (gitignored, optional)
└── frontend/src/
    ├── App.vue             # Shell: Topbar, Sidebar, Strg+K-Suche, Theme
    ├── router.js           # Routen (lazy-geladene Views)
    ├── components/         # AppSidebar, SearchPalette, ArticleView, TableOfContents,
    │                       # MarkdownEditor, RelationGraph, CategoryBadge, ThemeToggle
    ├── views/              # HomeView, ArticleDetail, ArticleEdit, GraphView
    ├── composables/        # useArticles (Store), useSearch (Fuse), useTheme
    ├── lib/                # api.js (REST-Client), clientMarkdown.js (Editor-Vorschau)
    └── assets/style.css    # Tailwind-Import, Dark-Variante, Shiki-/Prose-Styles
```

## Datenmodell & Konventionen (Backend)

Schema in `backend/db.js` (`SCHEMA`-Konstante). **Normalisiert**, nicht free-text:

- `articles` – `slug` (stabile URL, eindeutig), `title`, `summary`, `content` (Markdown =
  **Source of Truth**), `content_html` + `toc` (**Cache**, beim Speichern erzeugt), `category_id`.
- `categories`, `tags`, `article_tags` (M:N), `relations` (gerichteter Graph: `source_id` →
  `target_id`, `relation_type`, `label`).
- `articles_fts` – **eigenständige** FTS5-Tabelle. Wird **nicht per Trigger**, sondern manuell über
  `indexArticle(id)` gepflegt (nach jeder Inhalts-/Tag-Änderung aufrufen).

**Helfer aus `db.js` wiederverwenden statt neu zu schreiben:**
`serializeArticle(row, {withContent})`, `setArticleTags(id, names)`, `getTagId(name)`,
`upsertCategory(obj)`, `tagsForArticle(id)`, `relationsForArticle(id)`, `indexArticle(id)`.

Pragmas sind gesetzt (`WAL`, `foreign_keys=ON`). Löschen kaskadiert (Tags/Relationen) – beim
Artikel-Delete zusätzlich `articles_fts`-Zeile entfernen (siehe `routes/articles.js`).

### REST-API (Kurzform)

`GET/POST /api/articles`, `GET /api/articles/:slug`, `PUT|DELETE /api/articles/:id`,
`GET/POST /api/categories` (`PUT|DELETE /:id`), `GET /api/tags`, `GET /api/search?q=`,
`GET/POST /api/relations` (`DELETE /:id`), `GET /api/health`. Vollständige Tabelle: `README.md`.

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
- **Async-Render vs. Sync-DB**: `renderMarkdown()` ist **async**, better-sqlite3 ist **synchron**.
  Daher immer **erst rendern, dann** in einer `db.transaction(...)` schreiben (Muster:
  `routes/articles.js`, `seed/seed.js`). Nie `await` innerhalb einer better-sqlite3-Transaktion.
- **FTS aktuell halten**: nach Inhalts- **oder** Tag-Änderung `indexArticle(id)` aufrufen.
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
- **Neue API-Ressource**: Router in `backend/routes/` anlegen, in `backend/server.js` mit
  `app.use('/api/...', router)` einhängen.
- **Neue Frontend-Seite**: View in `frontend/src/views/`, Route in `frontend/src/router.js`
  (lazy `import()`).
- **Neues Schema-Feld**: `SCHEMA` in `db.js` erweitern; `serializeArticle` und die betroffenen
  Routen anpassen; bei durchsuchbarem Text auch `indexArticle` berücksichtigen.

## Deployment (Kurz)

`npm run build && npm start`. Autostart per systemd: `deploy/wikit.service`
(`User`/`WorkingDirectory` anpassen, `systemctl enable --now`). **Backup = `backend/data/wiki.db`
kopieren.** Vollständige Pi-Anleitung in der `README.md`.
