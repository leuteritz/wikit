import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticleEmbeddingsService } from './article-embeddings.service';

// `ArticleEmbeddingsService` wird exportiert, weil `/ask` ihn braucht: dort werden Artikel- und
// Klassentreffer zu einer Rangliste gemischt. Der Vektor-Cache lebt im Service, also gibt es ihn
// genau einmal – gleiche Bauart wie JavaModule und sein Embeddings-Dienst.
@Module({
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticleEmbeddingsService],
  exports: [ArticleEmbeddingsService],
})
export class ArticlesModule {}
