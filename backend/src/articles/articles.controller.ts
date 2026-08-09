import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ArticlesService } from './articles.service';
import { ArticleEmbeddingsService } from './article-embeddings.service';
import { ArticleHealthService } from './article-health.service';
import { ArticleVersionsService } from './article-versions.service';

@Controller('articles')
export class ArticlesController {
  constructor(
    private readonly svc: ArticlesService,
    private readonly embeddings: ArticleEmbeddingsService,
    private readonly health: ArticleHealthService,
    private readonly versions: ArticleVersionsService,
  ) {}

  @Get()
  list() {
    return this.svc.list();
  }

  // --- Was man dem Wiki nicht ansieht ---------------------------------------
  // EIN Endpunkt, EINE Antwort – gleiche Begründung wie bei `/insights`: die vier Befunde entstehen
  // aus demselben Durchlauf über denselben Bestand, und auf vier Routen verteilt könnten zwei
  // Abschnitte derselben Seite verschiedene Stände zeigen.
  //
  // ⚠️ Einsegmentig, also zwingend VOR `:slug` – sonst sucht die Anwendung einen Artikel namens
  // „health" und antwortet mit 404 auf eine Frage, die niemand gestellt hat.
  @Get('health')
  healthReport() {
    return this.health.report();
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

  // --- Fassungsverlauf -----------------------------------------------------
  // Zweisegmentig, kollidiert also nicht mit `:slug`. Ueber die **Id** wie `:id/related`: der
  // Aufrufer hat den Artikel bereits geladen, und eine Fassung haengt an der Id, nicht am Slug –
  // der kann sich aendern, ohne dass sich am Text etwas tut.
  @Get(':id/versions')
  listVersions(@Param('id') id: string) {
    return this.versions.list(Number(id));
  }

  // ⚠️ VOR `:version` – sonst sucht die Anwendung eine Fassung mit der Nummer „diff".
  //
  // `from` darf 0 sein („gegen nichts"): nur so laesst sich die aelteste vorhandene Fassung
  // ansehen, ohne dass die Ansicht dafuer einen zweiten Modus braucht.
  @Get(':id/versions/diff')
  compareVersions(@Param('id') id: string, @Query('from') from: string, @Query('to') to: string) {
    return this.versions.compare(Number(id), Number(from) || 0, Number(to));
  }

  @Get(':id/versions/:version')
  getVersion(@Param('id') id: string, @Param('version') version: string) {
    return this.versions.getOne(Number(id), Number(version));
  }

  // POST, weil es schreibt: die Fassung wird zum neuen Stand des Artikels – und zwar als weitere
  // Fassung, nicht durch Beschneiden der Historie (s. ArticlesService.restoreVersion).
  @Post(':id/versions/:version/restore')
  @HttpCode(200)
  restoreVersion(@Param('id') id: string, @Param('version') version: string) {
    return this.svc.restoreVersion(id, version);
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
