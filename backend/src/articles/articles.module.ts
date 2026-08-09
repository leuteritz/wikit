import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticleEmbeddingsService } from './article-embeddings.service';
import { ArticleHealthService } from './article-health.service';

// `ArticleEmbeddingsService` wird exportiert, weil `/ask` ihn braucht: dort werden Artikel- und
// Klassentreffer zu einer Rangliste gemischt. Der Vektor-Cache lebt im Service, also gibt es ihn
// genau einmal – gleiche Bauart wie JavaModule und sein Embeddings-Dienst.
//
// `ArticleHealthService` bleibt drinnen: sein Bericht ist eine Auskunft über das Wiki, und niemand
// sonst stellt sie. Er hängt seinerseits am Embeddings-Dienst – die Duplikate sind derselbe
// Paarvergleich wie die Link-Vorschläge, nur höher abgeschnitten.
@Module({
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticleEmbeddingsService, ArticleHealthService],
  exports: [ArticleEmbeddingsService],
})
export class ArticlesModule {}
