# Linking Articles & the Graph

Notes are more useful when they're connected. Wikit lets you create **typed relations** between
articles and then explore the whole web of connections visually.

## Typed relations

When editing an article, open the **Zusammenhänge** (relations) section and link it to another
article with a type and an optional label, for example:

- `depends-on` — this concept builds on another
- `related` — loosely connected, "see also"
- `uses`, `deploys-to`, `integrates`, `calls` — or any custom type you type in

Relations are **directional** (source → target) but show up on both articles, so you always see
incoming *and* outgoing links at the bottom of a page.

## The graph view

Open the **graph** (network icon in the top bar) to see every article as a node and every relation
as an arrow. Nodes are colored by category. You can:

- **drag** nodes to rearrange the layout,
- **zoom / pan** to focus an area,
- **click** a node to jump straight to that article.

This demo seed already contains a few links — this page points back to **Markdown & Code
Highlighting**, and the **Welcome** article points to both. Open the graph to see the little
triangle they form.

## Why it scales

Relations live in their own table in SQLite, independent of the article text. Adding thousands of
articles and links stays fast, and the graph is built from a single query.

## See also

- Back to the basics → **Welcome to Wikit**.
- Formatting reference → **Markdown & Code Highlighting**.
