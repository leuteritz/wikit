import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticleEmbeddingsService } from './article-embeddings.service';
import { ArticleHealthService } from './article-health.service';
import { ArticleVersionsService } from './article-versions.service';
import { ArticleLinksService } from './article-links.service';
import { ArticleExportService } from './article-export.service';

// `ArticleEmbeddingsService` wird exportiert, weil `/ask` ihn braucht: dort werden Artikel- und
// Klassentreffer zu einer Rangliste gemischt. Der Vektor-Cache lebt im Service, also gibt es ihn
// genau einmal – gleiche Bauart wie JavaModule und sein Embeddings-Dienst.
//
// `ArticleHealthService` bleibt drinnen: sein Bericht ist eine Auskunft über das Wiki, und niemand
// sonst stellt sie. Er hängt seinerseits am Embeddings-Dienst – die Duplikate sind derselbe
// Paarvergleich wie die Link-Vorschläge, nur höher abgeschnitten.
//
// `ArticleVersionsService` ebenso: der Fassungsverlauf hängt am Schreibpfad der Artikel, und der
// liegt hier. Er wird von `ArticlesService` mitbenutzt, nicht andersherum – so bleibt der
// Wiederherstellen-Pfad frei von einer Rückwärts-Abhängigkeit.
@Module({
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticleEmbeddingsService, ArticleHealthService, ArticleVersionsService, ArticleLinksService, ArticleExportService],
  exports: [ArticleEmbeddingsService, ArticlesService],
})
export class ArticlesModule {}
