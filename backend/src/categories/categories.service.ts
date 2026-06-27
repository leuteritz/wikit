import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarkdownService } from '../common/markdown.service';
import { Category } from '../entities/category.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
  ) {}

  // Kategorien inkl. Artikelanzahl (fuer Sidebar-Badges). Subquery + COLLATE NOCASE -> Raw-SQL.
  async list(): Promise<any[]> {
    return this.ds.query(
      `SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id) AS article_count
       FROM categories c ORDER BY c.sort_order, c.name COLLATE NOCASE`,
    );
  }

  async create(body: any): Promise<any> {
    const b = body || {};
    const { name, icon = '', sort_order = 0 } = b;
    if (!name || !name.trim()) throw new BadRequestException('Name ist erforderlich');
    const slug = this.markdown.slugify(name);
    try {
      const res = await this.ds.getRepository(Category).insert({ name: name.trim(), slug, icon, sort_order });
      const id = res.identifiers[0].id as number;
      return this.ds.getRepository(Category).findOne({ where: { id } });
    } catch {
      throw new ConflictException('Kategorie existiert bereits');
    }
  }

  async update(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const b = body || {};
    const repo = this.ds.getRepository(Category);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Kategorie nicht gefunden');
    const name = (b.name ?? existing.name).trim();
    const icon = b.icon ?? existing.icon;
    const sort_order = b.sort_order ?? existing.sort_order;
    await repo.update({ id }, { name, slug: this.markdown.slugify(name), icon, sort_order });
    return repo.findOne({ where: { id } });
  }

  async remove(idParam: string): Promise<void> {
    // Artikel behalten ihre Zeile; category_id wird via FK ON DELETE SET NULL geleert.
    await this.ds.getRepository(Category).delete({ id: Number(idParam) });
  }
}
