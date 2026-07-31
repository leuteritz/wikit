import { Column, Entity, PrimaryColumn } from 'typeorm';

// Eine Zeile = eine ueberschriebene Einstellung. Fehlt die Zeile, gilt der Default (Env/Code) --
// siehe Kommentar am DDL in database/schema.ts.
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @Column({ type: 'text', nullable: true })
  updated_at: string | null;
}
