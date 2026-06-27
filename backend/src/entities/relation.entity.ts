import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('relations')
export class Relation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'source_id', type: 'integer' })
  source_id: number;

  @Column({ name: 'target_id', type: 'integer' })
  target_id: number;

  @Column({ name: 'relation_type', type: 'text', default: 'related' })
  relation_type: string;

  @Column({ type: 'text', default: '' })
  label: string;
}
