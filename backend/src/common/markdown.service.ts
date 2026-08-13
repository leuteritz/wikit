import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { CodeFormatterService } from './code-formatter.service';
import { parseWikiLink, WIKILINK_AT_POS, WikiLink } from './wikilink';

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

  constructor(private readonly codeFormatter: CodeFormatterService) {}

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

      // Java-Bloecke serverseitig neu einruecken – core-Ruler laeuft VOR dem Shiki-Renderer,
      // sodass Shiki den bereits eingerueckten Text highlightet (reiner Text-Transform).
      //
      // ⚠️ **Abschaltbar ueber `env`, und das ist keine Kuer.** Wer das HTML zeilenweise in einen
      // Text aus `raw_source` einsetzt (Themen-Buendel), braucht GENAU dessen Zeilen. Der Weg
      // darueber – `getSourceWindow(raw=1)` – uebersprang zwar seinen eigenen `reindentJava`-Aufruf,
      // lief danach aber durch diese Pipeline und wurde doch eingerueckt: gemessen kam
      // `    public int …` (4) zurueck, wo im Buendel `  public int …` (2) steht. Folge waren eine
      // beim Hover sichtbar umspringende Einrueckung und Suchoffsets, die um genau diese Differenz
      // danebenlagen. Der Default bleibt „einruecken" – Artikel sind davon unberuehrt.
      md.core.ruler.push('reindent-java', (state: any) => {
        if (state.env?.reindentJava === false) return;
        for (const t of state.tokens) {
          if (t.type === 'fence' && (t.info || '').trim().split(/\s+/)[0] === 'java') {
            t.content = this.codeFormatter.reindentJava(t.content);
          }
        }
      });

      // --- [[Wikilinks]] ----------------------------------------------------------------------
      // Als INLINE-Ruler und ausdruecklich VOR `link`. Diese Position liefert zwei Eigenschaften
      // geschenkt, die man sonst nachbauen muesste:
      //   * `backticks` laeuft davor  -> `[[Foo]]` in Backticks bleibt Inline-Code,
      //   * Fences sind Block-Tokens  -> sie erreichen die Inline-Kette nie.
      // Und vor `link`, damit markdown-it die doppelte Klammer nicht als geschachtelten
      // Link-Versuch zerlegt.
      //
      // ⚠️ Der Ruler ist SYNCHRON und darf deshalb keine Datenbank fragen. Welche Slugs es gibt,
      // reicht der Aufrufer ueber `env.knownSlugs` herein – dasselbe Muster wie `reindentJava`.
      // Fehlt die Menge (z. B. beim Rendern einer Vorschau), gilt jeder Link als aufloesbar: eine
      // Behauptung „gibt es nicht" ohne Kenntnis des Bestands waere schlimmer als keine.
      md.inline.ruler.before('link', 'wikilink', (state: any, silent: boolean) => {
        if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false;
        if (state.src.charCodeAt(state.pos + 1) !== 0x5b) return false;
        const m = WIKILINK_AT_POS.exec(state.src.slice(state.pos, state.posMax));
        if (!m) return false;
        const link = parseWikiLink(m[1], (s) => this.slugify(s));
        if (!link) return false;
        if (!silent) {
          const known: Set<string> | undefined = state.env?.knownSlugs;
          const missing = known ? !known.has(link.slug) : false;
          const token = state.push('wikilink', '', 0);
          token.meta = { ...link, missing };
          // ⚠️ Hier entsteht auch der INDEX. Der Ruler ist die einzige Stelle, die Markdowns
          // Blockregeln kennt – wer die Links stattdessen aus dem Rohtext holte, faende in einem
          // eingerueckten Codeblock `new int[[3]][3]` einen Artikel namens „3" (gemessen).
          // Mehrfach genanntes Ziel = EIN Eintrag: der Index beantwortet „verlinkt A auf B?",
          // nicht „wie oft".
          if (state.env?.wikiLinks && !state.env.wikiLinks.has(link.slug)) {
            state.env.wikiLinks.set(link.slug, link);
          }
        }
        state.pos += m[0].length;
        return true;
      });
      md.renderer.rules.wikilink = (tokens: any[], idx: number) => {
        const { slug, label, raw, missing } = tokens[idx].meta;
        const text = md.utils.escapeHtml(label || raw);
        // Ein fehlendes Ziel wird NICHT zum Link: ein Klick, der auf eine 404 fuehrt, ist keine
        // Navigation. Es bleibt sichtbar als das, was es ist – eine offene Stelle.
        // ⚠️ `title`/`data-*` ueberleben die Sanitisierung nicht (s. SANITIZE_OPTS) – die
        // Erklaerung traegt deshalb die Klasse, nicht ein Attribut.
        if (missing) return `<span class="wikilink wikilink--missing">${text}</span>`;
        return `<a class="wikilink" href="/article/${encodeURIComponent(slug)}">${text}</a>`;
      };

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

  // Liefert { html, toc, links }.
  //   toc   = [{ level, text, id }] aus H2/H3
  //   links = die `[[Wikilinks]]`, die beim Rendern tatsaechlich als Link galten – die Grundlage
  //           des Backlink-Index. Sie kommen von hier und nicht aus einem zweiten Textscan, weil
  //           nur der Parser Markdowns Blockregeln kennt (s. Ruler).
  //
  // `knownSlugs`: welche Artikel es gibt. Nur damit kann der Wikilink-Ruler „fehlt" von „ist da"
  // unterscheiden – ohne die Menge gilt jeder Link als gueltig (s. Ruler).
  async renderMarkdown(
    content: string,
    opts: { reindentJava?: boolean; knownSlugs?: Set<string> } = {},
  ): Promise<{ html: string; toc: Array<{ level: number; text: string; id: string }>; links: WikiLink[] }> {
    const md = await this.getMd();
    const src = content || '';
    // `env` traegt die Optionen bis in die Ruler – eine zweite `md`-Instanz nur fuer diese
    // Schalter waere ein zweites Shiki-Setup fuer einen Aufrufer.
    const env: any = {
      reindentJava: opts.reindentJava !== false,
      knownSlugs: opts.knownSlugs,
      wikiLinks: new Map<string, WikiLink>(),
    };
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
    return { html, toc, links: [...env.wikiLinks.values()] };
  }
}
