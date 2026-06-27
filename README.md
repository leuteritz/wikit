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
- **Java code analysis**: paste/upload `.java`, parse it locally (no JDK), explore a dependency graph, get optional **local AI** method summaries (Ollama), and export any class as a searchable wiki article
- **Light & dark mode**
- **One SQLite file** as the database → backup = copy the file

## Tech stack

| Layer     | Tech |
|-----------|------|
| Frontend  | Vue 3 (Composition API), Vite, Vue Router, TailwindCSS v4, Fuse.js, Vue Flow, CodeMirror |
| Backend   | Node.js, NestJS (TypeScript), TypeORM (better-sqlite3 driver) |
| Rendering | markdown-it + Shiki + sanitize-html (server-side; result cached in the DB) |
| Java parsing | `java-parser` (pure JS, no JDK/`javac` — runs on a Pi/ARM64) |
| AI summaries | [Ollama](https://ollama.com) — optional, local, no API key (defaults to `phi3:mini`) |
| Database  | SQLite with a normalized schema (articles, categories, tags, relations) + FTS5 (full-text index kept via raw SQL — TypeORM has no FTS5 support) |

## Architecture

```text
Browser (Vue 3 SPA)  ──/api──►  NestJS  ──TypeORM──►  SQLite (better-sqlite3 + FTS5)
        ▲                            │
        └──── static SPA  ◄──────────┘     (one process, one port)
```

Markdown is rendered **once on save** (HTML + table of contents cached in the DB), so reading is
instant and the client bundle stays small. The NestJS backend compiles to plain JavaScript
(`backend/dist`) — at runtime it's still a single Node process serving the API + SPA on one port.

## Quick start

Requires **Node.js ≥ 20**.

```bash
npm install        # installs backend + frontend (npm workspaces)
npm run dev        # NestJS API on :3000 (nest start --watch) + Vite dev on :5173 (proxied)
# open http://localhost:5173
```

On first run an SQLite database is created and seeded with a few demo articles.

### Production

```bash
npm run build      # backend (nest build -> backend/dist) + frontend (-> frontend/dist)
npm start          # runs node backend/dist/main.js — serves API + SPA on one port
# open http://localhost:3000
```

> **Note:** the backend is TypeScript now, so `npm run build` is required before `npm start`
> (and after pulling updates). `npm run dev` compiles on the fly and needs no separate build.

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

## Java code analysis

Open the **Java Analyzer** (code icon in the top bar, route `/java`):

1. **Paste or upload** a `.java` file and click **Analyze**. The source is parsed **locally** with
   `java-parser` (pure JS — no JDK, no `javac`). Class, methods, parameters, imports and Javadoc are
   extracted and stored.
2. **Explore the graph.** Classes become nodes (colored by type: class / interface / enum /
   annotation); edges are import dependencies **between analyzed classes** (external imports like
   `java.util.List` are listed in the detail panel, not drawn).
3. **Inspect & export.** Click a node to open the detail panel: per-method signature, Javadoc and an
   optional AI summary. **"Wiki-Artikel erstellen"** turns the class into a normal Markdown article —
   from then on it shows up in the sidebar and is **full-text searchable** (FTS5) like any other note.

> It's *code analysis with AI summaries*, not an "AI search": a class becomes searchable once you
> export it as an article.

### Enabling AI summaries (Ollama)

AI summaries are **optional** and powered by a **separate, local** [Ollama](https://ollama.com)
server — it does **not** start with Wikit. Without it everything works; method summaries simply fall
back to the parsed Javadoc.

```bash
# Linux / Raspberry Pi:
curl -fsSL https://ollama.com/install.sh | sh
# Windows / macOS: download the installer from https://ollama.com

ollama pull phi3:mini      # ~2 GB, small enough for a Pi
ollama list                # verify it's there; the server listens on :11434
```

Then start Wikit and click **"KI-Zusammenfassung erzeugen"** on a method.

You can run the model server three ways:

| Setup | How |
|---|---|
| **A. Same host** (default) | Install Ollama on the Wikit machine — nothing else to configure. |
| **B. Stronger LAN machine** | Run Ollama on a desktop (`OLLAMA_HOST=0.0.0.0 ollama serve`) and point Wikit at it: `OLLAMA_URL=http://<host>:11434/api/generate`. |
| **C. No AI** | Don't install Ollama — summaries use the Javadoc fallback. |

Configuration (all optional, set as env vars):

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama `generate` endpoint |
| `OLLAMA_MODEL` | `phi3:mini` | model to use (e.g. `mistral:7b`) |
| `OLLAMA_TIMEOUT_MS` | `20000` | abort + fall back if the model is too slow |

## Deploy on a Raspberry Pi

```bash
# Node 20 LTS (the distro package can be old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3   # build tools for native better-sqlite3 (ARM64)

git clone https://github.com/leuteritz/wikit wikit && cd wikit
npm install
npm run build
npm start          # reachable at http://raspberrypi.local:3000
```

### Optional: AI summaries on the Pi

Ollama runs on a Pi 4/5 (ARM64), but a 7B model is slow — stick to a small one like `phi3:mini`,
and remember generation is **on demand per method**, so the rest of the app stays snappy:

```bash
curl -fsSL https://ollama.com/install.sh | sh   # installs + enables the `ollama` systemd service
ollama pull phi3:mini
```

If the Pi feels too slow, run Ollama on a stronger machine in your LAN and point Wikit at it via
`OLLAMA_URL` (see [setup B](#enabling-ai-summaries-ollama)). With no Ollama at all, summaries simply
fall back to the Javadoc — nothing breaks.

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
| POST | `/api/java/analyze` | parse a `.java` source, store it, return file + graph |
| GET | `/api/java/files`, `/api/java/files/:id` | analyzed files (list / detail) |
| GET | `/api/java/graph` | global class dependency graph |
| POST | `/api/java/methods/:id/summarize` | generate an AI summary for a method (Ollama) |
| PUT / DELETE | `/api/java/files/:id` | link an article / delete the file |

## License

[MIT](LICENSE) © 2026 Adrian Leuteritz
