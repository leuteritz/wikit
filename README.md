<h1>
  <img src="frontend/public/favicon.svg" alt="Wikit logo" height="30" align="center">
  &nbsp;Wikit
</h1>

A tiny, self-hosted personal wiki — light enough for a Raspberry Pi.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Deploy to Raspberry Pi](https://github.com/leuteritz/wikit/actions/workflows/deploy.yml/badge.svg)](https://github.com/leuteritz/wikit/actions/workflows/deploy.yml)

Wikit stores Markdown articles with full-text search, a relationship graph and local Java code
analysis. There is no login, no cloud and no accounts — the entire knowledge base is a single SQLite
file, so backup is copying one file and the whole app runs comfortably on a Pi.

## Features

- **Markdown editor** — split-view editing (CodeMirror); HTML is rendered once on save with
  server-side syntax highlighting (Shiki).
- **Instant search** — `Ctrl/Cmd + K` fuzzy search backed by SQLite **FTS5** full-text indexing.
- **Relationship graph** — typed links between articles, visualized with [Vue Flow](https://vueflow.dev).
- **Java code analysis** — parse `.java` locally (no JDK), explore a class **dependency graph**, and
  export classes as searchable wiki articles.
- **AI summaries** — optional per-method and per-class summaries via [Ollama](https://ollama.com)
  (local, no API key).
- **Dark mode** — light/dark theme toggle.
- **Backup = copy one file** — the database is a single SQLite file on the host.

## Tech stack

| Layer    | Tech |
|----------|------|
| Frontend | Vue 3 (Composition API) · Vite · TailwindCSS v4 · Vue Flow · CodeMirror · Fuse.js |
| Backend  | NestJS 11 (TypeScript) · TypeORM (better-sqlite3) |
| Content  | markdown-it + Shiki + sanitize-html (server-side, cached in the DB) |
| Database | SQLite + FTS5 full-text index |
| AI       | [Ollama](https://ollama.com) — optional, local, no API key (default `qwen2.5-coder:3b`) |

Architecture: an **nginx** container serves the built SPA and reverse-proxies `/api` to the
**NestJS** backend; SQLite lives on the host as a bind-mount.

## Deploy on Raspberry Pi (Docker)

Two containers via Docker Compose: nginx (SPA + `/api` proxy) and the NestJS API.

```bash
git clone https://github.com/leuteritz/wikit && cd wikit
cp .env.example .env          # then edit — see Configuration below
docker compose up -d --build
# open http://<host>:${HTTP_PORT}   (default http://localhost)
```

On first start the SQLite DB is created under `DATA_DIR` and seeded with a few demo articles.

> **`better-sqlite3` is a native module** — build the images on the architecture they run on. On a
> Pi, build natively (ARM64). Cross-building ARM64 images on x86 requires
> `docker buildx --platform linux/arm64` (QEMU, slow); building on the Pi avoids that.

> **Portainer:** *Stacks → Add stack → Repository*, point it at this repo's `docker-compose.yml`,
> set the same env vars, deploy.

## Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional; the Docker-relevant ones:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_WIKI_TITLE` | `Wikit` | Display name in the header / browser tab. **Baked in at build time** — change it and rebuild. |
| `HTTP_PORT` | `80` | Public port the nginx frontend is published on (`HTTP_PORT:80` → container `80`). |
| `DATA_DIR` | `./data` | Host directory holding the SQLite DB (bind-mounted to `/data`). On a Pi use an **absolute** path owned by UID `1000`. |
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama endpoint for AI summaries. In Docker use `http://host.docker.internal:11434/api/generate`. |
| `OLLAMA_MODEL` | `qwen2.5-coder:3b` | Model used for AI summaries. |
| `OLLAMA_TIMEOUT_MS` | `20000` | Abort and fall back to Javadoc if the model is too slow. |

> `PORT`, `HOST` and `WIKI_DB` in `.env.example` are for **bare-metal** runs only — in Docker the
> backend always listens on `3000` internally and uses `/data/wiki.db`.

## Java code analysis

Open the **Java Analyzer** from the top bar:

1. **Analyze.** Paste or upload a `.java` file. The source is parsed **locally** with `java-parser`
   (pure JS — no JDK, no `javac`); class, methods, parameters, imports and Javadoc are stored.
2. **Explore the graph.** Classes are nodes (colored by type: class / interface / enum /
   annotation); edges are **import dependencies between analyzed classes** (external imports such as
   `java.util.List` are listed in the detail panel, not drawn).
3. **Export.** Turn a class into a normal Markdown article — from then on it is in the sidebar and
   **full-text searchable** (FTS5) like any other note.

## AI summaries (Ollama)

AI summaries are optional and powered by a separate, local [Ollama](https://ollama.com) server.
Without it everything works — summaries fall back to the parsed Javadoc.

```bash
curl -fsSL https://ollama.com/install.sh | sh   # Linux / Pi (Win/macOS: installer from ollama.com)
ollama pull qwen2.5-coder:3b                     # ~2 GB, code-tuned, small enough for a Pi
```

The class summary and each method are generated sequentially by a server-side queue and streamed
onto the page via Server-Sent Events. Three ways to run the model:

- **Same host** — install Ollama on the Wikit machine; set
  `OLLAMA_URL=http://host.docker.internal:11434/api/generate` for the container.
- **Stronger LAN machine** — run `OLLAMA_HOST=0.0.0.0 ollama serve` elsewhere and point
  `OLLAMA_URL=http://<host>:11434/api/generate`.
- **No AI** — don't install Ollama; summaries use the Javadoc fallback.

## Data backup

The entire knowledge base is **one SQLite file** (plus its `-wal` / `-shm` sidecars) under
`DATA_DIR`. Because it is a host bind-mount, image rebuilds and `docker compose down` never touch it.

```bash
# Backup: copy the directory (WAL-safe — fine to copy while running)
cp -a /opt/wikit/data /opt/wikit/backups/wiki-$(date +%F)
# Restore: docker compose down → copy the directory back → docker compose up -d
```

## CI/CD pipeline (GitHub Actions)

A self-hosted runner on the Pi gives push-to-deploy without exposing any inbound port (the runner
polls GitHub outbound over HTTPS and builds **natively on ARM64**). Setup:

1. **Repo → Settings → Actions → Runners → New self-hosted runner** (Linux/ARM64). Run `config.sh`
   with `--labels self-hosted,linux,ARM64`, then `sudo ./svc.sh install && sudo ./svc.sh start`.
2. Give the runner Docker access: `sudo usermod -aG docker $USER` (then restart the service).
3. Place the persistent env file once outside the checkout: `sudo cp .env /opt/wikit/.env` (the
   deploy job copies it in before running compose).

Every push to `master` then runs the GitHub-hosted `build-check` (`npm ci && npm run build`), and on
success the Pi runner redeploys with `docker compose up -d --build`. Workflow:
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE) © 2026 Adrian Leuteritz
