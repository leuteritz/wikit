# 📚 Wikit

A tiny, **self-hosted personal wiki**. Markdown articles, instant search, a relationship graph and
dark mode — all backed by a single SQLite file. Light enough to run on a Raspberry Pi, generic
enough for any topic: dev notes, ops runbooks, study notes, recipes — whatever you want.

> No login, no cloud, no accounts. One process, one port, one `.db` file. Your data stays on your
> machine.

## Features

- **Markdown articles** with server-side syntax highlighting (Shiki: JS, Python, Java, Bash, XML, JSON, SQL, …)
- **Instant search** (`Ctrl/Cmd + K`) over titles, tags and categories (Fuse.js), plus server-side full-text search (SQLite FTS5)
- **Edit in the browser** with a split-view Markdown editor and live preview (CodeMirror)
- **Categories & tags**, flexible and extensible
- **Per-article table of contents** with scroll-spy (generated from your headings)
- **Relationship graph**: link articles with typed relations and explore them visually (Vue Flow)
- **Light & dark mode**
- **One SQLite file** as the database → backup = copy the file

## Tech stack

| Layer     | Tech |
|-----------|------|
| Frontend  | Vue 3 (Composition API), Vite, Vue Router, TailwindCSS v4, Fuse.js, Vue Flow, CodeMirror |
| Backend   | Node.js, Express, better-sqlite3 (no ORM) |
| Rendering | markdown-it + Shiki + sanitize-html (server-side; result cached in the DB) |
| Database  | SQLite with a normalized schema (articles, categories, tags, relations) + FTS5 |

## Architecture

```text
Browser (Vue 3 SPA)  ──/api──►  Express  ──►  SQLite (better-sqlite3 + FTS5)
        ▲                            │
        └──── static SPA  ◄──────────┘     (one process, one port)
```

Markdown is rendered **once on save** (HTML + table of contents cached in the DB), so reading is
instant and the client bundle stays small.

## Quick start

Requires **Node.js ≥ 20**.

```bash
npm install        # installs backend + frontend (npm workspaces)
npm run dev        # API on :3000 + Vite dev server on :5173 (proxied)
# open http://localhost:5173
```

On first run an SQLite database is created and seeded with a few demo articles.

### Production

```bash
npm run build      # frontend -> frontend/dist
npm start          # Express serves the API + SPA on one port
# open http://localhost:3000
```

## Your data stays local

This repo ships only the **app** and a small generic **demo seed**. Everything you create is
git-ignored, so publishing or pulling updates never touches your notes:

| What | Where | Tracked by git? |
|------|-------|-----------------|
| Your knowledge base | `backend/data/wiki.db` | ❌ ignored |
| Your personal seed (optional) | `backend/seed/articles/`, `backend/seed/manifest.js` | ❌ ignored |
| Demo seed (shipped) | `backend/seed/articles.example/`, `manifest.example.js` | ✅ committed |

On first run the seeder uses your `backend/seed/manifest.js` if it exists, otherwise it falls back
to the demo. To reset everything, delete `backend/data/wiki.db*` and restart.

**Name your instance:** copy `.env.example` to `.env` and set `VITE_WIKI_TITLE=My Notes`.

## Deploy on a Raspberry Pi

```bash
# Node 20 LTS (the distro package can be old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3   # build tools for native better-sqlite3 (ARM64)

git clone <your-fork> wikit && cd wikit
npm install
npm run build
npm start          # reachable at http://raspberrypi.local:3000
```

### Auto-start with systemd

```bash
sudo cp deploy/wikit.service /etc/systemd/system/
# adjust User / WorkingDirectory inside the file
sudo systemctl daemon-reload
sudo systemctl enable --now wikit
```

### Backup & restore

The entire knowledge base is one file:

```bash
cp backend/data/wiki.db ~/backups/wiki-$(date +%F).db   # backup
# restore: stop service, copy the file back, start service
```

## REST API (short)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/articles` | list (sidebar / search) |
| GET | `/api/articles/:slug` | full article (HTML, TOC, relations) |
| POST / PUT / DELETE | `/api/articles[/:id]` | create / update / delete |
| GET | `/api/categories`, `/api/tags` | taxonomy |
| GET | `/api/search?q=` | FTS5 full-text search |
| GET / POST / DELETE | `/api/relations[/:id]` | the graph |

## License

[MIT](LICENSE) © 2026 Adrian Leuteritz
