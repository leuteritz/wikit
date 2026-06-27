# 📚 Wikit

A tiny, **self-hosted personal wiki**. Markdown articles, instant full-text search, a relationship
graph, local Java code analysis (with optional AI summaries) and dark mode — all backed by a single
SQLite file. Light enough to run on a Raspberry Pi.

> No login, no cloud, no accounts. One `.db` file — your data stays on your machine.

## Features

- **Markdown articles** with server-side syntax highlighting (Shiki), rendered once on save.
- **Instant search** — `Ctrl/Cmd + K` fuzzy search plus SQLite **FTS5** full-text search.
- **Browser editor** — split-view Markdown with live preview (CodeMirror).
- **Categories & tags**, plus a **relationship graph** of typed links between articles (Vue Flow).
- **Java code analysis** — parse `.java` locally (no JDK), explore a dependency graph, export classes
  as searchable articles, optionally generate **AI summaries** via [Ollama](https://ollama.com).
- **Light & dark mode**, and a **single SQLite file** as the whole database (backup = copy one file).

## Tech stack

| Layer    | Tech |
|----------|------|
| Frontend | Vue 3 (Composition API) · Vite · TailwindCSS v4 · Vue Flow · CodeMirror · Fuse.js |
| Backend  | NestJS 11 (TypeScript) · TypeORM (better-sqlite3) |
| Content  | markdown-it + Shiki + sanitize-html (server-side, cached in the DB) |
| Database | SQLite + FTS5 full-text index |
| AI       | [Ollama](https://ollama.com) — optional, local, no API key (default `qwen2.5-coder:3b`) |

Architecture: the browser talks to NestJS over `/api`; an **nginx** container serves the built SPA
and reverse-proxies `/api` to the **Node** backend; SQLite lives on the host as a bind-mount.

## Deploy with Docker

The recommended way to self-host Wikit is **two containers** via Docker Compose: nginx (SPA + `/api`
proxy) and the NestJS API. The SQLite database lives on the **host** (bind-mount), so it survives
image rebuilds and `docker compose down`.

### Prerequisites

Docker Engine + Docker Compose v2:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then re-login
```

> **`better-sqlite3` is a native module** → build the images on the **same architecture** they run
> on. On a Raspberry Pi, just build natively on the Pi (ARM64). Cross-building ARM64 images on an x86
> machine needs `docker buildx --platform linux/arm64` (QEMU, slow) — building on the Pi avoids that.

### Run it

```bash
git clone https://github.com/leuteritz/wikit && cd wikit
cp .env.example .env          # then edit — see Configuration below
docker compose up -d --build
# open http://<host>:${HTTP_PORT}   (default http://localhost)
```

On first start the SQLite DB is created under `DATA_DIR` and seeded with a few demo articles.

> Prefer a UI? In **Portainer**: *Stacks → Add stack → Repository*, point it at this repo's
> `docker-compose.yml`, set the same env vars, deploy.

## Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional; the Docker-relevant ones:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_WIKI_TITLE` | `Wikit` | Display name in the header / browser tab. **Baked in at build time** — change it and rebuild. |
| `HTTP_PORT` | `80` | Public port the nginx frontend is published on (`HTTP_PORT:80` → container `80`). |
| `DATA_DIR` | `./data` | Host directory holding the SQLite DB (bind-mounted to `/data`). On a Pi use an **absolute** path. |
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama endpoint for AI summaries (optional). In Docker use `http://host.docker.internal:11434/api/generate`. |
| `OLLAMA_MODEL` | `qwen2.5-coder:3b` | Model for AI summaries (optional). |
| `OLLAMA_TIMEOUT_MS` | `20000` | Abort + fall back if the model is too slow (optional). |

> `PORT`, `HOST` and `WIKI_DB` in `.env.example` are for bare-metal runs — in Docker the backend
> always listens on `3000` internally and uses `/data/wiki.db`, so you don't set them.

**Pi note:** for an absolute `DATA_DIR`, create it once and give it to the container user (UID 1000):

```bash
sudo mkdir -p /opt/wikit/data
sudo chown -R 1000:1000 /opt/wikit/data   # backend runs as non-root UID 1000
# then set DATA_DIR=/opt/wikit/data in .env
```

## Data & backup

The entire knowledge base is **one SQLite file** (plus its `-wal` / `-shm` sidecars) under your
`DATA_DIR`. Because it's a host bind-mount, image rebuilds and `docker compose down` never touch it.

```bash
# Backup: copy the whole directory (safe to copy while running, thanks to WAL)
cp -a /opt/wikit/data /opt/wikit/backups/wiki-$(date +%F)
# Restore: docker compose down → copy the directory back → docker compose up -d
```

Your content stays local: the live DB (`DATA_DIR`, `backend/data/*.db`) and your personal seed
(`backend/seed/manifest.js`, `backend/seed/articles/`) are git-ignored. Only the app and a small demo
seed are committed. To reset everything, delete the DB files and restart.

## Java code analysis

Open the **Java Analyzer** (code icon in the top bar, route `/java`):

1. **Paste or upload** a `.java` file and click **Analyze**. The source is parsed **locally** with
   `java-parser` (pure JS — no JDK, no `javac`). Class, methods, parameters, imports and Javadoc are
   extracted and stored.
2. **Explore the graph.** Classes become nodes (colored by type: class / interface / enum /
   annotation); edges are import dependencies **between analyzed classes** (external imports like
   `java.util.List` are listed in the detail panel, not drawn).
3. **Inspect & export.** Click a node for per-method signatures, Javadoc and optional AI summaries.
   **"Wiki-Artikel erstellen"** turns the class into a normal Markdown article — from then on it's in
   the sidebar and **full-text searchable** (FTS5) like any other note.

### AI summaries (Ollama, optional)

AI summaries are powered by a **separate, local** [Ollama](https://ollama.com) server. Without it
everything works — method summaries simply fall back to the parsed Javadoc.

```bash
curl -fsSL https://ollama.com/install.sh | sh   # Linux / Pi (Win/macOS: installer from ollama.com)
ollama pull qwen2.5-coder:3b                     # ~2 GB, code-tuned, small enough for a Pi
```

Then open a wiki article linked to a Java class and click **"KI-Analyse starten"**: the class
summary and each method are generated sequentially by a server-side queue and streamed onto the page
via Server-Sent Events. Three ways to run the model:

- **Same host** (default) — install Ollama on the Wikit machine; set
  `OLLAMA_URL=http://host.docker.internal:11434/api/generate` for the container.
- **Stronger LAN machine** — run `OLLAMA_HOST=0.0.0.0 ollama serve` elsewhere and point
  `OLLAMA_URL=http://<host>:11434/api/generate`.
- **No AI** — don't install Ollama; summaries use the Javadoc fallback.

## Auto-deploy on push (optional)

A GitHub Actions **self-hosted runner on the Pi** gives push-to-deploy without exposing any inbound
port: the runner polls GitHub outbound over HTTPS and builds **natively on ARM64** (sidestepping the
better-sqlite3 cross-compile problem). Flow: `push to master` → runner on the Pi →
`docker compose up -d --build`.

The workflow is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): a GitHub-hosted
`build-check` (`npm ci && npm run build`) gates the self-hosted `deploy` job. Setup:

1. **Repo → Settings → Actions → Runners → New self-hosted runner** (Linux/ARM64). Run the shown
   `config.sh` with `--labels self-hosted,linux,ARM64`, then `sudo ./svc.sh install && sudo ./svc.sh
   start` (runs as a service, survives reboots). Give it Docker access (`usermod -aG docker`).
2. Provide the persistent env file **once** outside the checkout: `sudo cp .env /opt/wikit/.env`
   (the deploy job copies it in before running compose; the checkout itself has no `.env`).

Every push to `master` then redeploys automatically (or trigger **Actions → Deploy to Raspberry Pi
→ Run workflow**).

## License

[MIT](LICENSE) © 2026 Adrian Leuteritz
