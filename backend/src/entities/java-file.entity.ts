import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Hinweis: Die Spalte heisst `package`, doch `package` ist im strict-mode (Klassenkoerper sind
// immer strict) ein reserviertes Wort -> Property heisst `pkg`, gemappt auf Spalte 'package'.
@Entity('java_files')
export class JavaFile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'article_id', type: 'integer', nullable: true })
  article_id: number | null;

  @Column({ type: 'text' })
  filename: string;

  @Column({ name: 'package', type: 'text', nullable: true })
  pkg: string | null;

  @Column({ name: 'class_name', type: 'text' })
  class_name: string;

  @Column({ name: 'class_type', type: 'text', nullable: true })
  class_type: string | null;

  @Column({ name: 'raw_source', type: 'text' })
  raw_source: string;

  @Column({ type: 'text', nullable: true })
  description: string | null; // KI-Klassenbeschreibung (Markdown)

  @Column({ name: 'description_html', type: 'text', nullable: true })
  description_html: string | null; // gerenderte Beschreibung (Cache)

  @Column({ name: 'generated_at', type: 'text', nullable: true })
  generated_at: string | null;

  @Column({ name: 'class_line', type: 'integer', nullable: true })
  class_line: number | null; // 1-basierte Quellzeile des Klassennamens

  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false, update: false })
  created_at: string;
}
