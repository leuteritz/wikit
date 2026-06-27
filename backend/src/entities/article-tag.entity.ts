import { Entity, PrimaryColumn } from 'typeorm';

// M:N-Verknuepfung Artikel<->Tag. Eigene Join-Entity (statt ManyToOne-Magie), weil die
// Pflege-Logik (DELETE+INSERT OR IGNORE + Orphan-Prune) in TagsService bewusst explizit bleibt.
@Entity('article_tags')
export class ArticleTag {
  @PrimaryColumn({ name: 'article_id', type: 'integer' })
  article_id: number;

  @PrimaryColumn({ name: 'tag_id', type: 'integer' })
  tag_id: number;
}
