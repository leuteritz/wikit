import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Mappt auf die bestehende Tabelle `categories`. Das DDL besitzt db.js (siehe database/schema.ts),
// daher synchronize:false — die Entities beschreiben nur das Mapping fuer Repositories/QueryBuilder.
@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'text', default: '' })
  icon: string;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sort_order: number;
}
