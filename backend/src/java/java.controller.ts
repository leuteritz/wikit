import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JavaService } from './java.service';
import { JavaQueueService } from './java-queue.service';
import { JavaBatchProgressService } from './java-batch-progress.service';

@Controller('java')
export class JavaController {
  constructor(
    private readonly svc: JavaService,
    private readonly queue: JavaQueueService,
    private readonly batchProgress: JavaBatchProgressService,
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

  // Fortschritt eines laufenden analyze-batch (SSE). Der Client erzeugt die jobId, oeffnet damit
  // diesen Stream und schickt sie im analyze-batch-Body mit. Statische Route -> vor keiner
  // parametrisierten Route in Konflikt, `:jobId` ist hier der einzige Parameter.
  @Sse('analyze-progress/:jobId')
  analyzeProgress(@Param('jobId') jobId: string): Observable<{ data: unknown }> {
    return this.batchProgress.stream(jobId);
  }

  // --- KI-Generierungs-Queue (Backend-Zustand, HTTP-Polling) ---------------

  // Alle aktiven + abgeschlossenen Queues (fuer /java/queues).
  @Get('queues')
  listQueues() {
    return this.queue.list();
  }

  // SSE-Live-Strom aller Queues: Token-by-Token-Output von Ollama (phase start|token|done) +
  // Heartbeat. Statische Route -> MUSS vor queues/:id stehen, sonst captured :id "stream".
  @Sse('queues/stream')
  queueStream(): Observable<{ data: unknown }> {
    return this.queue.getStream();
  }

  // Kompakte Gesamtbilanz (Zaehler + Restzeit-Schaetzung) fuer das Dauer-Polling der Command-Bar.
  // Statische Route -> MUSS vor queues/:id stehen.
  @Get('queues/summary')
  queueSummary() {
    return this.queue.summary();
  }

  // Snapshot der Queue einer Datei (fuer das Live-Banner in der Analyzer-View).
  @Get('queues/:id')
  getQueue(@Param('id') id: string) {
    const job = this.queue.get(Number(id));
    if (!job) throw new NotFoundException('No queue entry for this file');
    return job;
  }

  // Alle noch nicht KI-analysierten Klassen + Methoden gesammelt einreihen. Statische Route ->
  // vor queues/:id, sonst faengt :id "analyze-all" ab.
  @Post('queues/analyze-all')
  @HttpCode(202)
  analyzeAll(@Body() body: any) {
    return this.queue.enqueueAllUnanalyzed(body?.userContext);
  }

  // Genau die uebergebenen Klassen gesammelt einreihen (nach einem Paste). EIN Request statt
  // eines Requests je Klasse. Statische Route -> vor queues/:id.
  @Post('queues/batch')
  @HttpCode(202)
  queueBatch(@Body() body: any) {
    return this.queue.enqueueMany(body?.fileIds || [], body?.userContext);
  }

  // Gesamte Queue leeren (aktive Jobs abbrechen + History entfernen). Muss vor den
  // parametrisierten DELETE-Routen stehen.
  @Delete('queues')
  @HttpCode(204)
  cancelAllQueues() {
    this.queue.cancelAll();
  }

  // Abgeschlossene Eintraege ausblenden ("alle als gelesen markieren"). Statische Route -> MUSS
  // vor queues/:fileId stehen, sonst captured :fileId "finished".
  @Delete('queues/finished')
  @HttpCode(204)
  clearFinishedQueues() {
    this.queue.clearFinished();
  }

  // Die (eine) Analyse-Einheit einer Datei abbrechen/entfernen.
  @Delete('queues/:fileId')
  @HttpCode(204)
  cancelQueue(@Param('fileId') fileId: string) {
    this.queue.cancel(Number(fileId));
  }

  // Vollstaendige KI-Analyse einer Klasse in die Queue einreihen (Methoden -> Klasse, laeuft im
  // Hintergrund weiter). Body optional: { userContext?, force? } -> force erzwingt Neu-Generieren.
  @Post('files/:id/queue-class')
  @HttpCode(202)
  queueClass(@Param('id') id: string, @Body() body: any) {
    return this.queue.enqueueClass(Number(id), body?.userContext, body?.force === true);
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

  // Versionsverlauf (Changelog) einer Klasse, neueste zuerst. Ohne Quelltext (kleine Payload).
  @Get('files/:id/versions')
  listVersions(@Param('id') id: string) {
    return this.svc.listVersions(id);
  }

  // Quelltext einer einzelnen Version (on-demand).
  @Get('files/:id/versions/:versionId/source')
  getVersionSource(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.svc.getVersionSource(id, versionId);
  }

  // KI-Summary signalisiert "Ollama down" ueber ein Flag in einer 200-Antwort (kein Fehlerstatus).
  // Body optional: { userContext } -> Projekt-Kontext fuer den Prompt.
  @Post('methods/:id/summarize')
  @HttpCode(200)
  summarize(@Param('id') id: string, @Body() body: any) {
    return this.svc.summarize(id, body);
  }

  // Komplett-Reset (alle Klassen). Statische Route -> MUSS vor files/:id stehen, sonst faengt
  // :id den Aufruf ab. Optionale jobId schaltet den Fortschritts-Stream ein.
  @Delete('files')
  @HttpCode(200)
  resetAllFiles(@Query('jobId') jobId?: string) {
    return this.svc.resetAllFiles(jobId || null);
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
