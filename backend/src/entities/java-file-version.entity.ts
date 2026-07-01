import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Ein Versions-Snapshot einer analysierten Java-Klasse (Changelog). Haengt ueber
// java_file_id an einem stabilen java_files-Datensatz (bleibt bei Re-Upload erhalten).
@Entity('java_file_versions')
export class JavaFileVersion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'java_file_id', type: 'integer' })
  java_file_id: number;

  @Column({ name: 'version_number', type: 'integer' })
  version_number: number;

  @Column({ type: 'text' })
  source: string; // vollstaendiger Java-Quelltext dieser Version

  @Column({ type: 'text', nullable: true })
  diff: string | null; // Unified-Diff zur Vorversion (NULL bei Version 1)

  @Column({ name: 'ai_summary', type: 'text', nullable: true })
  ai_summary: string | null; // KI-Zusammenfassung der Aenderung (Markdown)

  @Column({ name: 'ai_summary_html', type: 'text', nullable: true })
  ai_summary_html: string | null; // gerenderte Zusammenfassung (Cache)

  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false, update: false })
  created_at: string;
}
