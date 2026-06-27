import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { SerializerService } from '../common/serializer.service';
import { TagsService } from '../common/tags.service';
import { Article } from '../entities/article.entity';

@Injectable()
export class ArticlesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
    private readonly serializer: SerializerService,
    private readonly tags: TagsService,
    private readonly fts: FtsService,
  ) {}

  // Liste fuer Sidebar + Fuse.js-Index (ohne grossen content-Body).
  async list(): Promise<any[]> {
    // COLLATE NOCASE -> Raw-SQL (SQLite-spezifische Sortierung, von QueryBuilder nicht abbildbar).
    const rows = await this.ds.query('SELECT * FROM articles ORDER BY title COLLATE NOCASE');
    return Promise.all(rows.map((r: any) => this.serializer.serializeArticle(r, { withContent: false })));
  }

  // Voller Artikel inkl. gerendertem HTML, TOC und Relationen.
  async getBySlug(slug: string): Promise<any> {
    const row = await this.ds.getRepository(Article).findOne({ where: { slug } });
    if (!row) throw new NotFoundException('Artikel nicht gefunden');
    return this.serializer.serializeArticle(row);
  }

  async create(body: any): Promise<any> {
    const b = body || {};
    const { title, content = '', summary = '', category_id = null, tags = [] } = b;
    if (!title || !title.trim()) throw new BadRequestException('Titel ist erforderlich');

    const slug = await this.uniqueSlug(b.slug || title);
    // Muster: erst async rendern, DANN Transaktion (innerhalb nur awaited DB-Calls).
    const { html, toc } = await this.markdown.renderMarkdown(content);

    let id!: number;
    await this.ds.transaction(async (manager) => {
      const res = await manager.getRepository(Article).insert({
        slug,
        title: title.trim(),
        summary,
        content,
        content_html: html,
        toc: JSON.stringify(toc),
        category_id: category_id || null,
      });
      id = res.identifiers[0].id as number;
      await this.tags.setArticleTags(manager, id, this.normalizeTags(tags));
      await this.fts.indexArticle(manager, id);
    });

    const row = await this.ds.getRepository(Article).findOne({ where: { id } });
    return this.serializer.serializeArticle(row);
  }

  async update(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const b = body || {};
    const existing = await this.ds.getRepository(Article).findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Artikel nicht gefunden');

    const title = (b.title ?? existing.title).trim();
    const content = b.content ?? existing.content;
    const summary = b.summary ?? existing.summary;
    const category_id = b.category_id ?? existing.category_id;
    const slug = b.slug && b.slug !== existing.slug ? await this.uniqueSlug(b.slug, id) : existing.slug;
    const { html, toc } = await this.markdown.renderMarkdown(content);

    await this.ds.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(Article)
        .set({
          slug,
          title,
          summary,
          content,
          content_html: html,
          toc: JSON.stringify(toc),
          category_id: category_id || null,
          // datetime('now') exakt wie zuvor (Funktionswert -> kein JS-Date, keine Millisekunden).
          updated_at: () => "datetime('now')",
        })
        .where('id = :id', { id })
        .execute();
      if (Array.isArray(b.tags)) await this.tags.setArticleTags(manager, id, this.normalizeTags(b.tags));
      await this.fts.indexArticle(manager, id);
    });

    const row = await this.ds.getRepository(Article).findOne({ where: { id } });
    return this.serializer.serializeArticle(row);
  }

  async remove(idParam: string): Promise<void> {
    const id = Number(idParam);
    await this.ds.transaction(async (manager) => {
      await manager.query('DELETE FROM articles_fts WHERE rowid = ?', [id]);
      await manager.getRepository(Article).delete({ id }); // CASCADE raeumt tags/relations
    });
  }

  private normalizeTags(tags: any): string[] {
    if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
    if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
    return [];
  }

  private async uniqueSlug(base: string, ignoreId: number | null = null): Promise<string> {
    const slug = this.markdown.slugify(base) || 'artikel';
    let candidate = slug;
    let n = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const row = await this.ds
        .getRepository(Article)
        .findOne({ where: { slug: candidate }, select: { id: true } });
      if (!row || row.id === ignoreId) return candidate;
      candidate = `${slug}-${n++}`;
    }
  }
}
