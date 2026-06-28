import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { JavaService } from './java.service';
import { JavaQueueService } from './java-queue.service';

@Controller('java')
export class JavaController {
  constructor(
    private readonly svc: JavaService,
    private readonly queue: JavaQueueService,
  ) {}

  @Post('analyze')
  analyze(@Body() body: any) {
    return this.svc.analyze(body);
  }

  // Mehrklassen-/Roh-Paste-Analyse: trennt mehrere Klassen, erkennt Duplikate. Body:
  // { source, overwrite? }. Bei Konflikt ohne overwrite -> 200 { needsConfirm, conflicts, ... }.
  @Post('analyze-batch')
  analyzeBatch(@Body() body: any) {
    return this.svc.analyzeBatch(body);
  }

  @Get('files')
  listFiles() {
    return this.svc.listFiles();
  }

  @Get('graph')
  graph() {
    return this.svc.graph();
  }

  // --- Klassen-Graph-Kanten (auto + manuell) -------------------------------
  // Eigener `edges`-Namensraum -> kollidiert nicht mit files/:id.

  @Get('edges')
  listEdges() {
    return this.svc.listEdges();
  }

  @Post('edges')
  createEdge(@Body() body: any) {
    return this.svc.createEdge(body);
  }

  // Alle Auto-Call-Edges neu berechnen + persistieren (nach Massen-Imports). Statische Route ->
  // vor edges/:id, sonst faengt :id "recompute" ab.
  @Post('edges/recompute')
  @HttpCode(200)
  recomputeEdges() {
    return this.svc.recomputeEdges();
  }

  @Patch('edges/:id')
  updateEdge(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateEdge(id, body);
  }

  @Delete('edges/:id')
  @HttpCode(204)
  deleteEdge(@Param('id') id: string) {
    return this.svc.deleteEdge(id);
  }

  // Shiki-gehighlightetes Code-Snippet einer Methode (Graph-Edge-Panel). Statische Route ->
  // steht vor den parametrisierten files/:id-Routen, damit kein :id-Capture greift.
  @Get('method-snippet')
  methodSnippet(@Query('fileId') fileId: string, @Query('methodName') methodName: string) {
    return this.svc.getMethodSnippet(fileId, methodName);
  }

  // --- KI-Generierungs-Queue (Backend-Zustand, HTTP-Polling) ---------------

  // Alle aktiven + abgeschlossenen Queues (fuer /java/queues).
  @Get('queues')
  listQueues() {
    return this.queue.list();
  }

  // Snapshot der Queue einer Datei (fuer das Live-Banner in der Analyzer-View).
  @Get('queues/:id')
  getQueue(@Param('id') id: string) {
    const job = this.queue.get(Number(id));
    if (!job) throw new NotFoundException('Keine Queue fuer diese Datei');
    return job;
  }

  // Alle noch nicht KI-analysierten Klassen + Methoden gesammelt einreihen. Statische Route ->
  // vor queues/:id, sonst faengt :id "analyze-all" ab.
  @Post('queues/analyze-all')
  @HttpCode(202)
  analyzeAll(@Body() body: any) {
    return this.queue.enqueueAllUnanalyzed(body?.userContext);
  }

  // Gesamte Queue leeren (aktive Jobs abbrechen + History entfernen). Muss vor der
  // parametrisierten DELETE-Route stehen.
  @Delete('queues')
  @HttpCode(204)
  cancelAllQueues() {
    this.queue.cancelAll();
  }

  // Einzelnen Job (Klassen- oder Methoden-Queue einer Datei) abbrechen/entfernen.
  @Delete('queues/:fileId/:kind')
  @HttpCode(204)
  cancelQueue(@Param('fileId') fileId: string, @Param('kind') kind: string) {
    this.queue.cancel(Number(fileId), kind === 'class' ? 'class' : 'methods');
  }

  // Klassen-Zusammenfassung in die Queue einreihen (laeuft im Hintergrund weiter).
  @Post('files/:id/queue-class')
  @HttpCode(202)
  queueClass(@Param('id') id: string, @Body() body: any) {
    return this.queue.enqueueClass(Number(id), body?.userContext);
  }

  // Alle Methoden der Datei sequentiell in die Queue einreihen.
  @Post('files/:id/queue-methods')
  @HttpCode(202)
  queueMethods(@Param('id') id: string, @Body() body: any) {
    return this.queue.enqueueMethods(Number(id), body?.userContext);
  }

  // Spezifischer als /files/:id -> MUSS davor stehen, sonst faengt :id "by-article" ab.
  @Get('files/by-article/:articleId')
  getFileByArticle(@Param('articleId') articleId: string) {
    return this.svc.getFileByArticle(articleId);
  }

  @Get('files/:id')
  getFile(@Param('id') id: string) {
    return this.svc.getFile(id);
  }

  // KI-Summary signalisiert "Ollama down" ueber ein Flag in einer 200-Antwort (kein Fehlerstatus).
  // Body optional: { userContext } -> Projekt-Kontext fuer den Prompt.
  @Post('methods/:id/summarize')
  @HttpCode(200)
  summarize(@Param('id') id: string, @Body() body: any) {
    return this.svc.summarize(id, body);
  }

  // Klassen-Summary: schreibt description/description_html. Ollama-down -> 200 + Flag.
  @Post('files/:id/summarize-class')
  @HttpCode(200)
  summarizeClass(@Param('id') id: string, @Body() body: any) {
    return this.svc.summarizeClass(id, body);
  }

  @Delete('files/:id')
  @HttpCode(204)
  deleteFile(@Param('id') id: string) {
    return this.svc.deleteFile(id);
  }

  @Put('files/:id')
  linkArticle(@Param('id') id: string, @Body() body: any) {
    return this.svc.linkArticle(id, body);
  }
}
