import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from '../entities';
import { DatabaseService } from '../database/database.service';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from './markdown.service';
import { OllamaService } from './ollama.service';
import { SeedService } from './seed.service';
import { SerializerService } from './serializer.service';
import { TagsService } from './tags.service';

// Global: stellt Repositories (forFeature) + gemeinsame Services allen Feature-Modulen bereit.
// DatabaseService (Schema) laeuft via onModuleInit, SeedService via onApplicationBootstrap.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature(ALL_ENTITIES)],
  providers: [
    DatabaseService,
    FtsService,
    MarkdownService,
    OllamaService,
    SerializerService,
    TagsService,
    SeedService,
  ],
  exports: [
    TypeOrmModule,
    FtsService,
    MarkdownService,
    OllamaService,
    SerializerService,
    TagsService,
  ],
})
export class CommonModule {}
