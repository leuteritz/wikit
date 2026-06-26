# Welcome to Wikit

**Wikit** is a tiny, self-hosted knowledge base. Markdown articles, instant search, a relationship
graph, dark mode — all running from a single SQLite file. It's light enough for a Raspberry Pi and
generic enough for *any* topic: dev notes, ops runbooks, recipes, study notes, you name it.

> This is demo content. Your own articles live only on your machine — see **Make it yours** below.

## Why it exists

Most note tools are either heavyweight (databases, accounts, cloud) or too simple (a folder of
files with no search or structure). Wikit sits in between: one process, one file, zero login,
but with real full-text search and a visual map of how your notes connect.

## How it works

- Write articles in **Markdown**. They render server-side and are cached, so reading is instant.
- Organize with **categories** and **tags**.
- **Search** anything with `Ctrl/Cmd + K`.
- **Link** articles with typed relations and explore them in the **Graph** view.

## Make it yours

1. Click **+ New article** in the sidebar and start writing — that's it.
2. Everything you create is stored in `backend/data/wiki.db`, which is **git-ignored**. Your notes
   never leave your machine.
3. Want a custom name in the header? Set `VITE_WIKI_TITLE` in a `.env` file (see `.env.example`).

## Next steps

- See how Markdown and code blocks render → **Markdown & Code Highlighting**.
- Learn about links and the graph → **Linking Articles & the Graph**.
