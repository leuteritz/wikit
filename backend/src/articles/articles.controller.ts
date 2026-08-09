import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ArticlesService } from './articles.service';
import { ArticleEmbeddingsService } from './article-embeddings.service';

@Controller('articles')
export class ArticlesController {
  constructor(
    private readonly svc: ArticlesService,
    private readonly embeddings: ArticleEmbeddingsService,
  ) {}

  @Get()
  list() {
    return this.svc.list();
  }

  // --- Bedeutungsindex der Artikel -----------------------------------------
  // ⚠️ Statische Routen VOR `:slug` – sonst schluckt der Slug-Parameter „embeddings" und die
  // Antwort ist ein 404 auf einen Artikel, den nie jemand angelegt hat.
  //
  // Eigener Endpunktsatz statt einer Erweiterung von `/java/embeddings`: es ist ein zweiter Index
  // über einen anderen Bestand, und Artikelzahlen unter `/java/` zu führen wäre eine Lüge über die
  // Herkunft. Die EINE Bilanz daraus bildet der Client (`useEmbeddings`), nicht zwei Ansichten
  // getrennt.
  @Get('embeddings')
  embeddingStatus() {
    return this.embeddings.status();
  }

  // Ohne jobId und ohne SSE: ein persönliches Wiki hat Dutzende Artikel, der Lauf dauert Sekunden.
  @Post('embeddings/rebuild')
  @HttpCode(200)
  rebuildEmbeddings(@Body() body: any) {
    return this.embeddings.rebuild(body?.force === true);
  }

  @Delete('embeddings')
  @HttpCode(204)
  clearEmbeddings() {
    return this.embeddings.clear();
  }

  // --- Link-Vorschläge aus demselben Index ---------------------------------
  // Sie stehen unter `articles/` und nicht unter `relations/`, obwohl sie Beziehungen vorschlagen:
  // gerechnet werden sie aus dem Artikel-Bedeutungsindex, und der Pfad soll sagen, WOHER eine
  // Auskunft kommt, nicht wer sie abholt (gleiche Begründung wie beim eigenen Endpunktsatz oben).
  //
  // ⚠️ Ebenfalls VOR `:slug` – „suggestions" ist kein Artikel.
  @Get('suggestions')
  suggestions() {
    return this.embeddings.suggestAll();
  }

  // Zweisegmentig, kollidiert also nicht mit `:slug`. Über die **Id**, nicht den Slug: der Aufrufer
  // hat den Artikel bereits geladen und kennt beide – und die Vorschläge sind über Ids geschlüsselt.
  @Get(':id/related')
  related(@Param('id') id: string) {
    return this.embeddings.suggestFor(Number(id));
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.svc.getBySlug(slug);
  }

  @Post()
  create(@Body() body: any) {
    return this.svc.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
