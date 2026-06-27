import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { COLUMN_MIGRATIONS, SCHEMA } from './schema';

// Entspricht initDb() aus dem alten db.js: legt Schema + FTS5-Index an (idempotent).
// Laeuft beim Modul-Init VOR dem Seeding (SeedService nutzt OnApplicationBootstrap).
@Injectable()
export class DatabaseService implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
  }
}
