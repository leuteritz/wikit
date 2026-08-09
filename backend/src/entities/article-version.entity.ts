import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Ein Fassungs-Snapshot eines Artikels. Haelt den vollen Text (title/summary/content) --
// der Unterschied zur Vorfassung wird gerechnet, nicht gespeichert (s. schema.ts).
@Entity('article_versions')
export class ArticleVersion {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'article_id', type: 'integer' })
  article_id: number;

  @Column({ name: 'version_number', type: 'integer' })
  version_number: number;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'text' })
  content: string;

  // Warum diese Fassung entstand, sofern es nicht die gewoehnliche Bearbeitung war.
  // NULL = Normalfall.
  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'ai_summary', type: 'text', nullable: true })
  ai_summary: string | null;

  @Column({ name: 'ai_summary_html', type: 'text', nullable: true })
  ai_summary_html: string | null;

  // Der Zeitpunkt, den die Fassung DARSTELLT.
  //
  // ⚠️ `insert: false` ist zwingend, nicht Geschmackssache: ohne das schreibt TypeORM die Spalte
  // beim INSERT als NULL mit, statt sie wegzulassen -- und der DB-Default (datetime('now'))
  // kaeme nie zum Zug. Die Spalte ist NOT NULL, der Insert schlaegt also fehl. Wer ein anderes
  // Datum braucht (die nachgesicherte Fassung eines Altbestand-Artikels), setzt es danach per
  // UPDATE. Gleiche Bauart wie Article.updated_at.
  @Column({ name: 'created_at', type: 'text', nullable: true, insert: false })
  created_at: string;
}
