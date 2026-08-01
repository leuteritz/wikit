import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { COLUMN_MIGRATIONS, JAVA_FTS_DDL, JAVA_SRC_FTS_DDL, SCHEMA } from './schema';
import { FtsService } from './fts.service';

// Entspricht initDb() aus dem alten db.js: legt Schema + FTS5-Index an (idempotent).
// Laeuft beim Modul-Init VOR dem Seeding (SeedService nutzt OnApplicationBootstrap).
@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fts: FtsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // better-sqlite3 .exec() kann mehrere Statements; TypeORMs query() nur eines ->
    // am ';' splitten. Das DDL enthaelt keine ';' innerhalb von String-Literalen.
    for (const stmt of SCHEMA.split(';')) {
      const sql = stmt.trim();
      if (sql) await this.dataSource.query(sql);
    }

    // Nachruest-Migration: neue Spalten nur ergaenzen, wenn sie in einer bestehenden
    // DB noch fehlen (PRAGMA table_info). Bei frischer DB liefert das SCHEMA sie bereits.
    for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
      const cols: Array<{ name: string }> = await this.dataSource.query(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === column)) {
        await this.dataSource.query(ddl);
      }
    }

    await this.migrateJavaFilesCheck();
    await this.migrateJavaFtsSource();
    await this.ensureJavaSourceIndex();
  }

  // Trigram-Index ueber den Rohquelltext anlegen und fuer den Bestand nachtragen.
  //
  // ⚠️ Der Nachbau wird BEWUSST NICHT abgewartet. Bei einigen tausend Klassen laeuft er auf einem
  // Pi in Sekunden bis Minuten, und solange antwortete der Server auf nichts – der Start haengt
  // dann an einer Beschleunigung, die niemand angefordert hat. Bis er durch ist, sucht
  // `codeSearch` ueber den alten Weg weiter (Praefix-Index + Vollscan): langsamer, aber richtig.
  private async ensureJavaSourceIndex(): Promise<void> {
    try {
      await this.dataSource.query(JAVA_SRC_FTS_DDL);
      this.fts.setSourceIndexAvailable(true);
    } catch (e: any) {
      // Aeltere SQLite kennt `contentless_delete` nicht -> ohne Index weiterlaufen, nicht abbrechen.
      this.fts.setSourceIndexAvailable(false);
      this.logger.warn(`Code-Suchindex nicht verfuegbar (${e?.message || e}) – Suche laeuft ohne ihn.`);
      return;
    }
    void this.fts.backfillSourceIndex();
  }

  // Einmalige Constraint-Migration: `java_files.class_type` trug einen CHECK auf
  // ('class','interface','enum','annotation'). Seit Records analysierbar sind, wuerde jeder
  // INSERT mit 'record' daran scheitern – und SQLite kann einen CHECK nicht per ALTER aendern.
  // Also die Tabelle einmal ohne Constraint neu aufbauen (Reihenfolge nach SQLite-Doku:
  // Kopie fuellen, Original droppen, Kopie umbenennen). Laeuft NACH den Spalten-Migrationen,
  // damit die Kopie alle inzwischen ergaenzten Spalten enthaelt.
  private async migrateJavaFilesCheck(): Promise<void> {
    const rows: Array<{ sql: string }> = await this.dataSource.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='java_files'",
    );
    const ddl = rows[0]?.sql || '';
    if (!/CHECK\s*\(\s*class_type/i.test(ddl)) return;

    // Kanonische Definition (ohne CHECK, mit allen Spalten) aus dem SCHEMA holen – keine zweite
    // Wahrheit im Migrationscode. Sie wird unter einem temporaeren Namen angelegt.
    const create = SCHEMA.split(';')
      .map((s) => s.trim())
      .find((s) => /CREATE TABLE IF NOT EXISTS java_files\b/i.test(s));
    if (!create) return;
    const createTmp = create.replace(/CREATE TABLE IF NOT EXISTS java_files\b/i, 'CREATE TABLE java_files_new');

    const cols: Array<{ name: string }> = await this.dataSource.query('PRAGMA table_info(java_files)');
    // Die Spalten-Migrationen liefen bereits -> die alte Tabelle hat alle Spalten.
    const names = cols.map((c) => c.name).join(', ');

    // Fremdschluessel waehrend des Rebuilds aus: `java_methods.file_id` zeigt auf java_files,
    // das DROP wuerde sonst kaskadieren. `prepareDatabase` setzt sie im Normalbetrieb auf ON.
    await this.dataSource.query('PRAGMA foreign_keys = OFF');
    try {
      await this.dataSource.query('DROP TABLE IF EXISTS java_files_new');
      await this.dataSource.query(createTmp);
      await this.dataSource.query(`INSERT INTO java_files_new (${names}) SELECT ${names} FROM java_files`);
      // REIHENFOLGE IST DER GANZE TRICK (SQLite-Doku, „Making Other Kinds Of Table Schema
      // Changes"): erst die alte Tabelle droppen, dann die neue umbenennen. Andersherum – also
      // java_files zuerst nach java_files_old umbenennen – schreibt SQLite (>= 3.25) die
      // FK-Klauseln ALLER anderen Tabellen auf den neuen Namen um: java_methods verwies danach
      // auf `java_files_old`, und nach dessen DROP scheiterte jeder Insert mit „no such table".
      await this.dataSource.query('DROP TABLE java_files');
      await this.dataSource.query('ALTER TABLE java_files_new RENAME TO java_files');

      const broken: any[] = await this.dataSource.query('PRAGMA foreign_key_check');
      if (broken.length) {
        this.logger.error(`java_files-Migration: ${broken.length} verwaiste Fremdschluessel-Zeilen nach dem Rebuild`);
      }
    } finally {
      await this.dataSource.query('PRAGMA foreign_keys = ON');
    }
  }

  // Einmalige FTS-Rebuild-Migration: FTS5 kann keine Spalte per ALTER ergaenzen. Fehlt der
  // `source`-Spalte (alte DBs ohne Rohquelltext-Index) -> java_fts neu aufbauen und alle
  // java_files reindizieren, damit die globale Code-Suche auch Altbestand findet.
  private async migrateJavaFtsSource(): Promise<void> {
    const cols: Array<{ name: string }> = await this.dataSource.query('PRAGMA table_info(java_fts)');
    if (cols.some((c) => c.name === 'source')) return;

    await this.dataSource.query('DROP TABLE IF EXISTS java_fts');
    await this.dataSource.query(JAVA_FTS_DDL);

    const ids: Array<{ id: number }> = await this.dataSource.query('SELECT id FROM java_files');
    if (!ids.length) return;
    await this.dataSource.transaction(async (manager) => {
      for (const { id } of ids) await this.fts.indexJavaFile(manager, id);
    });
  }
}
