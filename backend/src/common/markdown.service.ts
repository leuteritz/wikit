import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

// Server-seitige Markdown-Pipeline: markdown-it + Shiki + Sanitisierung.
// Wird beim Speichern eines Artikels einmal ausgefuehrt; das Ergebnis (HTML + TOC) wird in
// der DB gecached, damit der Pi nicht bei jedem Request rendern muss. 1:1 aus backend/markdown.js.
//
// STOLPERFALLE: @shikijs/markdown-it (und markdown-it-anchor v9) sind reine ESM-Pakete. Da NestJS
// nach CommonJS kompiliert, wuerde `import` zu `require` -> Bruch. Daher echtes dynamisches
// import() ueber einen Function-Wrapper erzwingen (TS schreibt diesen nicht in require um).
const dynamicImport: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier)',
) as any;

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
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
};

@Injectable()
export class MarkdownService {
  private mdPromise: Promise<any> | null = null;

  slugify(text: string): string {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async getMd(): Promise<any> {
    if (this.mdPromise) return this.mdPromise;
    this.mdPromise = (async () => {
      const MarkdownIt = (await dynamicImport('markdown-it')).default;
      const anchor = (await dynamicImport('markdown-it-anchor')).default;
      const Shiki = (await dynamicImport('@shikijs/markdown-it')).default;

      const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
      md.use(anchor, {
        slugify: (s: string) => this.slugify(s),
        level: [1, 2, 3, 4],
        permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'before' }),
      });
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
        }),
      );
      return md;
    })();
    return this.mdPromise;
  }

  // Liefert { html, toc }. toc = [{ level, text, id }] aus H2/H3.
  async renderMarkdown(content: string): Promise<{ html: string; toc: Array<{ level: number; text: string; id: string }> }> {
    const md = await this.getMd();
    const src = content || '';
    const env: any = {};
    const tokens = md.parse(src, env);

    const toc: Array<{ level: number; text: string; id: string }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'heading_open' && (t.tag === 'h2' || t.tag === 'h3')) {
        const text = tokens[i + 1]?.content || '';
        toc.push({ level: Number(t.tag[1]), text, id: this.slugify(text) });
      }
    }

    const rawHtml = md.renderer.render(tokens, md.options, env);
    const html = sanitizeHtml(rawHtml, SANITIZE_OPTS);
    return { html, toc };
  }
}
