import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Persistente Kante des Code-Graphen: source_class ruft `method_name` auf einer
// Instanz von target_class auf. Siehe Schema-Kommentar in database/schema.ts.
@Entity('java_edges')
export class JavaEdge {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'source_class', type: 'text' })
  source_class: string;

  @Column({ name: 'target_class', type: 'text' })
  target_class: string;

  @Column({ name: 'method_name', type: 'text', nullable: true })
  method_name: string | null;

  @Column({ name: 'is_manual', type: 'integer', default: 0 })
  is_manual: number; // 0 = Auto-Analyse, 1 = manuell angelegt

  @Column({ name: 'dismissed', type: 'integer', default: 0 })
  dismissed: number; // 1 = vom Nutzer verworfene Auto-Kante (Tombstone)

  @Column({ name: 'confidence', type: 'real', default: 1.0 })
  confidence: number; // < 1 -> "Bitte pruefen"

  @Column({ name: 'kind', type: 'text', default: 'call' })
  kind: string; // 'call' = Methoden-Aufruf (mit Label), 'uses' = struktureller Typ-Bezug

  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false, update: false })
  created_at: string;
}
