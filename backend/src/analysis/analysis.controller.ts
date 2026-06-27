import { Body, Controller, HttpCode, Param, Post, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AnalysisQueue } from './analysis.queue';
import { AnalysisService } from './analysis.service';

@Controller('analysis')
export class AnalysisController {
  constructor(
    private readonly svc: AnalysisService,
    private readonly queue: AnalysisQueue,
  ) {}

  // Startet die Queue-basierte Analyse fuer die mit dem Artikel verknuepfte Java-Klasse.
  // Body: { userContext?: string }. Das Frontend ruft dies VOR dem Oeffnen des SSE-Streams.
  @Post(':articleId/start')
  @HttpCode(202)
  start(@Param('articleId') articleId: string, @Body() body: any) {
    return this.svc.start(Number(articleId), body?.userContext);
  }

  // Server-Sent-Events-Stream des Analyse-Fortschritts (class_done | method_done | all_done | error).
  @Sse('stream/:articleId')
  stream(@Param('articleId') articleId: string): Observable<{ data: unknown }> {
    return this.queue.getStream(Number(articleId));
  }
}
