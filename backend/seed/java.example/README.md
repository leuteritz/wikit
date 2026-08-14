# Demo code — `com.acme.shop`

A small, synthetic shop: catalog, customer, order, payment. **17 classes in 6 packages**,
written for one purpose — to be the codebase in the two README screenshots
(`docs/landing.png`, `docs/screenshot.png`).

Nothing here is used at runtime. `SeedService` only ever reads articles
(`manifest.js` / `manifest.example.js`); Java classes enter Wikit exclusively through
**Add code**. So this folder is material, not a seed.

## Why it is committed

The screenshots have to come from a demo instance, never from a personal one — this is a
public repository. Until now the demo classes existed only inside the database they were
imported into, so re-taking a screenshot meant inventing them again, and a differently
built codebase draws a different graph than the picture it is supposed to replace.

## How to load it

Paste `_export.java` into **Add code** — that single file is the whole set in the format
`analyze-batch` understands (the comment header is dropped on import). Or drag the
individual `.java` files in; the importer splits a multi-class paste on its `package` and
`import` statements.

For a screenshot run, do it against a throwaway database so the real one stays untouched:

```bash
npm run build
WIKI_DB="<somewhere>/demo.db" PORT=3210 node backend/dist/main.js
```

## What the classes are built for

- **Every type reference is imported explicitly.** Edges are only drawn where a type name
  resolves through the package or an import — without those lines the graph comes out empty.
- **`OrderService` is the class the screenshot opens**: five collaborators handed into the
  constructor, five methods, and the flow readable in one screen.
- **No AI descriptions.** The screenshots show `0/17 analyzed` on purpose — the picture is
  about the graph, not about Ollama.
