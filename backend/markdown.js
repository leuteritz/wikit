// Server-seitige Markdown-Pipeline: markdown-it + Shiki + Sanitisierung.
// Wird beim Speichern eines Artikels einmal ausgefuehrt; das Ergebnis (HTML + TOC)
// wird in der DB gecached, damit der Pi nicht bei jedem Request rendern muss.
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import Shiki from '@shikijs/markdown-it'
import sanitizeHtml from 'sanitize-html'

export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

const SANITIZE_OPTS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'pre', 'code', 'span', 'img', 'h1', 'h2', 'del', 'sup', 'sub', 'input',
  ],
  allowedAttributes: {
    '*': ['class', 'style', 'id'],
    a: ['href', 'name', 'target', 'rel', 'aria-hidden', 'tabindex'],
    img: ['src', 'alt', 'title', 'loading'],
    input: ['type', 'checked', 'disabled'],
  },
  // allowedStyles bewusst NICHT gesetzt -> Shiki-CSS-Variablen bleiben erhalten.
}

let mdPromise = null

async function getMd() {
  if (mdPromise) return mdPromise
  mdPromise = (async () => {
    const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
    md.use(anchor, {
      slugify,
      level: [1, 2, 3, 4],
      permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'before' }),
    })
    md.use(
      await Shiki({
        defaultColor: false, // beide Themes als CSS-Variablen -> per .dark umschaltbar
        themes: { light: 'github-light', dark: 'github-dark' },
        langs: [
          'java', 'bash', 'shell', 'xml', 'html', 'json', 'sql',
          'javascript', 'typescript', 'properties', 'yaml', 'dockerfile',
          'groovy', 'diff', 'text',
        ],
        fallbackLanguage: 'text',
      })
    )
    return md
  })()
  return mdPromise
}

// Liefert { html, toc }. toc = [{ level, text, id }] aus H2/H3.
export async function renderMarkdown(content) {
  const md = await getMd()
  const src = content || ''
  const env = {}
  const tokens = md.parse(src, env)

  const toc = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'heading_open' && (t.tag === 'h2' || t.tag === 'h3')) {
      const text = tokens[i + 1]?.content || ''
      toc.push({ level: Number(t.tag[1]), text, id: slugify(text) })
    }
  }

  const rawHtml = md.renderer.render(tokens, md.options, env)
  const html = sanitizeHtml(rawHtml, SANITIZE_OPTS)
  return { html, toc }
}
