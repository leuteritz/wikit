# Markdown & Code Highlighting

Everything you write is standard **Markdown**. Headings, lists, tables, quotes, and fenced code
blocks all work. Code is highlighted **on the server** with [Shiki](https://shiki.style), so the
browser stays fast and the highlighting looks identical in light and dark mode.

## Headings build the table of contents

Every `##` and `###` heading on this page automatically appears in the right-hand outline with
scroll-spy. No configuration needed.

## Code blocks

Just add a language after the opening fence. Each block gets a **copy** button on hover.

```js
// JavaScript
export function greet(name) {
  return `Hello, ${name}!`
}
```

```python
# Python
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

```sql
-- SQL
SELECT title, updated_at
FROM articles
WHERE category_id = ?
ORDER BY updated_at DESC;
```

```bash
# Bash
npm install && npm run build && npm start
```

## Tables, quotes, lists

| Feature        | Supported |
|----------------|-----------|
| Tables         | ✅        |
| Task lists     | ✅        |
| Syntax themes  | light + dark |

> Tip: use the split-view editor — Markdown on the left, live preview on the right.

- [x] Write in Markdown
- [x] Get instant highlighting
- [ ] Add your own articles

## See also

- Connect this article to others → **Linking Articles & the Graph**.
