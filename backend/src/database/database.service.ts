import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { COLUMN_MIGRATIONS, JAVA_FTS_DDL, SCHEMA } from './schema';
import { FtsService } from './fts.service';

// Entspricht initDb() aus dem alten db.js: legt Schema + FTS5-Index an (idempotent).
// Laeuft beim Modul-Init VOR dem Seeding (SeedService nutzt OnApplicationBootstrap).
@Injectable()
export class DatabaseService implements OnModuleInit {
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

    await this.migrateJavaFtsSource();
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
