import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { SerializerService } from '../common/serializer.service';
import { TagsService } from '../common/tags.service';
import { Article } from '../entities/article.entity';
import { ArticleVersionsService } from './article-versions.service';

@Injectable()
export class ArticlesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
    private readonly serializer: SerializerService,
    private readonly tags: TagsService,
    private readonly fts: FtsService,
    private readonly versions: ArticleVersionsService,
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
    if (!row) throw new NotFoundException('Article not found');
    return this.serializer.serializeArticle(row);
  }

  async create(body: any): Promise<any> {
    const b = body || {};
    const { title, content = '', summary = '', category_id = null, tags = [] } = b;
    if (!title || !title.trim()) throw new BadRequestException('A title is required');

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
      // Der Anlagestand IST Fassung 1 – sonst waere er der einzige, den man nie zurueckholen kann.
      await this.versions.initial(manager, id, { title: title.trim(), summary, content });
    });

    const row = await this.ds.getRepository(Article).findOne({ where: { id } });
    return this.serializer.serializeArticle(row);
  }

  /**
   * @param opts Nur fuer den internen Aufruf aus `restoreVersion`: eine Wiederherstellung ist
   *        IMMER eine eigene Fassung (`forceNew`) und traegt ihren Grund (`note`). Ohne beides
   *        verschwaende sie im Zusammenfass-Fenster den Stand, den sie gerade ersetzt hat – und
   *        stuende in der Liste da wie eine gewoehnliche Bearbeitung.
   */
  async update(idParam: string, body: any, opts: { note?: string; forceNew?: boolean } = {}): Promise<any> {
    const id = Number(idParam);
    const b = body || {};
    const existing = await this.ds.getRepository(Article).findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Article not found');

    const title = (b.title ?? existing.title).trim();
    const content = b.content ?? existing.content;
    const summary = b.summary ?? existing.summary;
    const category_id = b.category_id ?? existing.category_id;
    const slug = b.slug && b.slug !== existing.slug ? await this.uniqueSlug(b.slug, id) : existing.slug;
    const { html, toc } = await this.markdown.renderMarkdown(content);

    // Der Auftrag für die Zusammenfassung faellt IN der Transaktion an (nur dort steht fest, ob
    // eine Fassung entstanden ist) und wird von ihr herausgereicht – die KI-Arbeit selbst gehoert
    // nach draussen (TypeORM-Regel: in der Transaktion nur awaited DB-Operationen).
    const job = await this.ds.transaction(async (manager) => {
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
      return this.versions.record(
        manager,
        id,
        { title: existing.title, summary: existing.summary, content: existing.content, updated_at: existing.updated_at },
        { title, summary, content },
        opts,
      );
    });

    // Fire-and-forget wie bei der Klassen-Version: schlaegt sie fehl, bleibt die Spalte NULL und
    // die Ansicht zeigt den Diff – der ist die Hauptsache, die Zusammenfassung die Abkuerzung.
    if (job) void this.versions.summarize(job);

    const row = await this.ds.getRepository(Article).findOne({ where: { id } });
    return this.serializer.serializeArticle(row);
  }

  /**
   * Eine alte Fassung zurueckholen.
   *
   * ⚠️ Als NEUE Fassung, nie durch Beschneiden der Historie: was man wiederherstellt, will man
   * hinterher womoeglich doch wieder rueckgaengig machen – und eine Historie, die beim
   * Zurueckgehen ihre juengsten Eintraege verliert, kann genau das nicht.
   *
   * Slug, Kategorie und Tags bleiben, wie sie sind: die Fassung haelt den TEXT (s. schema.ts).
   * Ein Wiederherstellen, das nebenbei eine Verschlagwortung zuruecknimmt, taete mehr als das,
   * wonach gefragt wurde.
   */
  async restoreVersion(idParam: string, versionParam: string): Promise<any> {
    const id = Number(idParam);
    const version = Number(versionParam);
    const v = await this.versions.getOne(id, version);
    return this.update(
      idParam,
      { title: v.title, summary: v.summary, content: v.content },
      { note: `Restored from version ${v.version_number}`, forceNew: true },
    );
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
