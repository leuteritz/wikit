// Leichter Client-Renderer NUR fuer die Editor-Live-Vorschau.
// Bewusst ohne Shiki (Bundle klein halten) – die "echte" Darstellung rendert der Server.
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

export function renderClientMarkdown(src) {
  return md.render(src || '')
}
