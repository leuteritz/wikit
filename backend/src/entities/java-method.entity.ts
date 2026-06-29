import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('java_methods')
export class JavaMethod {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'file_id', type: 'integer' })
  file_id: number;

  @Column({ name: 'method_name', type: 'text' })
  method_name: string;

  @Column({ name: 'return_type', type: 'text', nullable: true })
  return_type: string | null;

  @Column({ type: 'text', nullable: true })
  parameters: string | null; // JSON-Array als TEXT

  @Column({ type: 'text', nullable: true })
  modifiers: string | null; // JSON-Array der Java-Modifier als TEXT (z. B. ["public","static"])

  @Column({ type: 'text', nullable: true })
  javadoc: string | null;

  @Column({ name: 'ai_summary', type: 'text', nullable: true })
  ai_summary: string | null;

  @Column({ type: 'text', nullable: true })
  body: string | null; // geparster Methodenrumpf (Offset-basiert)

  @Column({ name: 'start_line', type: 'integer', nullable: true })
  start_line: number | null; // 1-basierte Quellzeile der Methodendeklaration

  @Column({ name: 'body_start_line', type: 'integer', nullable: true })
  body_start_line: number | null; // 1-basierte Quellzeile des Body-`{` (Basis fuer exakte Aufrufzeilen)

  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false, update: false })
  created_at: string;
}
