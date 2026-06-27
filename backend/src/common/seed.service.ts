import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DataSource, EntityManager } from 'typeorm';
import { Article } from '../entities/article.entity';
import { Category } from '../entities/category.entity';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from './markdown.service';
import { TagsService } from './tags.service';

// Echtes dynamisches import() (TS soll es nicht in require() umschreiben) -> laedt die
// ESM-Manifeste (backend/seed/package.json hat "type":"module").
const dynamicImport: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier)',
) as any;

// Erst-Befuellung: laeuft nur, wenn die DB noch leer ist (idempotent). 1:1 aus backend/seed/seed.js.
// OnApplicationBootstrap -> laeuft NACH DatabaseService.onModuleInit (Schema steht bereits).
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
    private readonly tags: TagsService,
    private readonly fts: FtsService,
  ) {}

  // dist/common/seed.service.js -> ../../seed == backend/seed (Seed-Daten liegen ausserhalb von src).
  private get seedDir(): string {
    return path.resolve(__dirname, '..', '..', 'seed');
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.runSeed();
  }

  private async loadManifest(): Promise<{ categories: any[]; articles: any[]; relations: any[]; articlesDir: string }> {
    // Persoenliches Seed (manifest.js, gitignored) bevorzugen, sonst das mitgelieferte Demo-Seed.
    const hasReal = fs.existsSync(path.join(this.seedDir, 'manifest.js'));
    const file = path.join(this.seedDir, hasReal ? 'manifest.js' : 'manifest.example.js');
    const mod = await dynamicImport(pathToFileURL(file).href);
    return {
      categories: mod.categories,
      articles: mod.articles,
      relations: mod.relations,
      articlesDir: mod.articlesDir || 'articles',
    };
  }

  private async upsertCategory(
    manager: EntityManager,
    { name, slug, icon = '', sort_order = 0 }: any,
  ): Promise<number> {
    const repo = manager.getRepository(Category);
    const existing = await repo.findOne({ where: { slug } });
    if (existing) {
      await repo.update({ id: existing.id }, { name, icon, sort_order });
      return existing.id;
    }
    const res = await repo.insert({ name, slug, icon, sort_order });
    return res.identifiers[0].id as number;
  }

  private async runSeed(): Promise<void> {
    const [{ c }] = await this.ds.query('SELECT COUNT(*) AS c FROM articles');
    if (c > 0) return;

    const { categories, articles, relations, articlesDir } = await this.loadManifest();

    // Markdown vorab rendern (async), damit der DB-Insert in einer Transaktion buendelbar bleibt.
    const prepared: any[] = [];
    for (const a of articles) {
      const content = fs.readFileSync(path.join(this.seedDir, articlesDir, a.file), 'utf8');
      const { html, toc } = await this.markdown.renderMarkdown(content);
      prepared.push({ ...a, content, html, toc, slug: a.slug || this.markdown.slugify(a.title) });
    }

    await this.ds.transaction(async (manager) => {
      const catIdBySlug: Record<string, number> = {};
      for (const cat of categories) catIdBySlug[cat.slug] = await this.upsertCategory(manager, cat);

      const artIdBySlug: Record<string, number> = {};
      const artRepo = manager.getRepository(Article);
      for (const a of prepared) {
        const res = await artRepo.insert({
          slug: a.slug,
          title: a.title,
          summary: a.summary,
          content: a.content,
          content_html: a.html,
          toc: JSON.stringify(a.toc),
          category_id: catIdBySlug[a.category] || null,
        });
        const id = res.identifiers[0].id as number;
        artIdBySlug[a.slug] = id;
        await this.tags.setArticleTags(manager, id, a.tags);
        await this.fts.indexArticle(manager, id);
      }

      for (const r of relations) {
        const s = artIdBySlug[r.source];
        const t = artIdBySlug[r.target];
        if (s && t) {
          // INSERT OR IGNORE: TypeORM hat dafuer keinen sauberen Repo-Weg -> parametrisiertes Raw-SQL.
          await manager.query(
            'INSERT OR IGNORE INTO relations (source_id, target_id, relation_type, label) VALUES (?,?,?,?)',
            [s, t, r.type || 'related', r.label || ''],
          );
        }
      }
    });

    console.log(
      `Seed abgeschlossen: ${prepared.length} Artikel, ${categories.length} Kategorien angelegt.`,
    );
  }
}
