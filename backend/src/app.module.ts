import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppController } from './app.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { CommonModule } from './common/common.module';
import { ALL_ENTITIES } from './entities';
import { AnalysisModule } from './analysis/analysis.module';
import { ArticlesModule } from './articles/articles.module';
import { CategoriesModule } from './categories/categories.module';
import { JavaModule } from './java/java.module';
import { RelationsModule } from './relations/relations.module';
import { SearchModule } from './search/search.module';
import { TagsModule } from './tags/tags.module';

// dist/app.module.js liegt im Backend-Root von dist -> ../data == backend/data, ../../frontend/dist.
const DB_PATH = process.env.WIKI_DB || path.resolve(__dirname, '..', 'data', 'wiki.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
// Gebaute SPA ausliefern (History-Fallback auf index.html). Im Dev laeuft das Frontend ueber Vite
// (Proxy /api -> :3000), dann existiert dist nicht -> Static-Serving entfaellt, /api funktioniert weiter.
const staticImports = fs.existsSync(FRONTEND_DIST)
  ? [
      ServeStaticModule.forRoot({
        rootPath: FRONTEND_DIST,
        // Wichtig: /api NICHT vom SPA-Fallback schlucken lassen (sonst HTML statt JSON-404).
        // Express 5 / path-to-regexp v8: Wildcards muessen benannt sein ('(.*)' ist ungueltig).
        exclude: ['/api/{*splat}'],
      }),
    ]
  : [];

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: DB_PATH,
      entities: ALL_ENTITIES,
      // synchronize:false -> Schema/DDL besitzt DatabaseService (FTS5 etc. nicht ORM-modellierbar).
      synchronize: false,
      // Pragmas wie zuvor (WAL + foreign_keys ON, damit Cascades/SET NULL greifen).
      prepareDatabase: (db: any) => {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
      },
    } as any),
    CommonModule,
    ...staticImports,
    ArticlesModule,
    CategoriesModule,
    TagsModule,
    SearchModule,
    RelationsModule,
    JavaModule,
    AnalysisModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
