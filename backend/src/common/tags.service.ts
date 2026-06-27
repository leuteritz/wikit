import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ArticleTag } from '../entities/article-tag.entity';
import { Tag } from '../entities/tag.entity';

// Tag-Pflege fuer Artikel (entspricht getTagId/setArticleTags aus backend/db.js).
// Erwartet jeweils den Transaktions-`manager`, damit alles in derselben Transaktion laeuft
// (Muster: erst async rendern, DANN ds.transaction() -> hier nur awaited DB-Calls).
@Injectable()
export class TagsService {
  // Tag per Name finden oder neu anlegen. Liefert null bei leerem Namen.
  async getTagId(manager: EntityManager, name: string): Promise<number | null> {
    const clean = String(name).trim();
    if (!clean) return null;
    const repo = manager.getRepository(Tag);
    const existing = await repo.findOne({ where: { name: clean } });
    if (existing) return existing.id;
    const saved = await repo.save(repo.create({ name: clean }));
    return saved.id;
  }

  // Setzt die Tags eines Artikels neu (DELETE + Insert) und raeumt verwaiste Tags auf.
  async setArticleTags(manager: EntityManager, articleId: number, tagNames: string[] = []): Promise<void> {
    const atRepo = manager.getRepository(ArticleTag);
    await atRepo.delete({ article_id: articleId });
    const seen = new Set<number>();
    for (const name of tagNames) {
      const id = await this.getTagId(manager, name);
      if (id && !seen.has(id)) {
        seen.add(id); // ersetzt das INSERT OR IGNORE des Originals (keine Duplikate)
        await atRepo.save(atRepo.create({ article_id: articleId, tag_id: id }));
      }
    }
    // verwaiste Tags aufraeumen (Tags ohne jegliche Artikelzuordnung).
    await manager
      .createQueryBuilder()
      .delete()
      .from(Tag)
      .where('id NOT IN (SELECT tag_id FROM article_tags)')
      .execute();
  }
}
