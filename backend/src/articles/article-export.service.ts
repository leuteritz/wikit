import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ArticleDoc, joinDocs, toMarkdown } from './article-markdown';

/**
 * Das Wiki als Text – das Gegenstueck zu `GET /api/java/export`.
 *
 * Der Code hatte seinen Rueckweg seit langem, das Wiki keinen: die einzige Sicherung war „kopier
 * die Datei wiki.db", und die setzt Zugriff auf den Pi voraus. Hier kommt heraus, was man lesen,
 * ablegen und wieder einspielen kann.
 *
 * Die Antwortform ist ABSICHTLICH dieselbe wie beim Java-Export (`text` + `files`-Landkarte):
 * dieselbe Vorschau, dieselben Zahlen, dieselben zwei Wege raus (Zwischenablage/Download) – und
 * damit dieselbe Komponente im Frontend statt einer zweiten, die dasselbe anders zeigt.
 */
@Injectable()
export class ArticleExportService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private async docs(where = '', params: any[] = []): Promise<ArticleDoc[]> {
    const rows = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.summary, a.content, c.slug AS category
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
         ${where}
        ORDER BY a.title COLLATE NOCASE`,
      params,
    );
    if (!rows.length) return [];
    // Schlagwoerter in EINER Abfrage statt einer je Artikel – bei hundert Artikeln waeren das
    // hundert Roundtrips fuer eine Zeile Text.
    const tagRows = await this.ds.query(
      `SELECT at.article_id, t.name
         FROM article_tags at JOIN tags t ON t.id = at.tag_id
        ORDER BY t.name COLLATE NOCASE`,
    );
    const byArticle = new Map<number, string[]>();
    for (const r of tagRows) {
      const list = byArticle.get(Number(r.article_id)) || [];
      list.push(r.name);
      byArticle.set(Number(r.article_id), list);
    }
    return rows.map((r: any) => ({
      slug: r.slug,
      title: r.title,
      summary: r.summary || '',
      category: r.category || null,
      tags: byArticle.get(r.id) || [],
      content: r.content || '',
    }));
  }

  /** Ein Artikel als eigenstaendiges Dokument. */
  async one(id: number): Promise<{ text: string; filename: string }> {
    const [doc] = await this.docs('WHERE a.id = ?', [id]);
    if (!doc) throw new NotFoundException('Article not found');
    return { text: toMarkdown(doc), filename: `${doc.slug}.md` };
  }

  /** Alle Artikel als EIN Text – samt Landkarte, damit die Vorschau springen kann. */
  async all(): Promise<any> {
    const docs = await this.docs();
    const text = joinDocs(docs);
    // Startzeilen aus dem fertigen Text ableiten statt beim Zusammensetzen mitzuzaehlen: so kann
    // die Landkarte nicht von dem abweichen, was tatsaechlich dasteht (gleiche Regel wie beim
    // Java-Export).
    const lines = text ? text.split('\n') : [];
    const files: any[] = [];
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^slug:\s*(.*)$/.exec(lines[i]);
      if (m && lines[i - 1] === '---') {
        const d = docs[seen++];
        if (d) files.push({ slug: d.slug, title: d.title, startLine: i, tags: d.tags.length });
      }
    }
    return {
      text,
      articles: docs.length,
      categories: new Set(docs.map((d) => d.category).filter(Boolean)).size,
      tags: new Set(docs.flatMap((d) => d.tags)).size,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: lines.length,
      generatedAt: new Date().toISOString(),
      files,
    };
  }
}
