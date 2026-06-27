import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('articles')
export class Article {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'content_html', type: 'text', default: '' })
  content_html: string;

  @Column({ type: 'text', default: '[]' })
  toc: string;

  @Column({ name: 'category_id', type: 'integer', nullable: true })
  category_id: number | null;

  // created_at/updated_at haben in der DB DEFAULT (datetime('now')). Beim INSERT NICHT setzen,
  // dann greift der DB-Default (gleiche 'YYYY-MM-DD HH:MM:SS'-Form wie zuvor). Beim UPDATE wird
  // updated_at via QueryBuilder mit `() => "datetime('now')"` gesetzt (siehe ArticlesService).
  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false, update: false })
  created_at: string;

  // insert:false -> DB-Default greift beim Anlegen; beim UPDATE wird der Wert via QueryBuilder
  // explizit auf datetime('now') gesetzt (deshalb hier KEIN update:false).
  @Column({ name: 'updated_at', type: 'text', nullable: true, insert: false })
  updated_at: string;
}
