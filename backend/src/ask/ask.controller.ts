import { Body, Controller, HttpCode, Param, Post, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AskEvent, AskService } from './ask.service';

@Controller('ask')
export class AskController {
  constructor(private readonly svc: AskService) {}

  // Frage starten (antwortet sofort, Quellen und Text kommen ueber den Strom unten). Der Client
  // erzeugt die jobId, oeffnet damit den Strom und schickt sie hier im Body mit -- dieselbe Bauart
  // wie analyze-progress und der Bot-Playground.
  @Post()
  @HttpCode(202)
  start(@Body() body: any) {
    return this.svc.start(body);
  }

  // Statische Route -> MUSS vor der parametrisierten stehen, sonst faengt :jobId "cancel" ab.
  @Post(':jobId/cancel')
  @HttpCode(204)
  cancel(@Param('jobId') jobId: string) {
    this.svc.cancel(jobId);
  }

  @Sse('stream/:jobId')
  stream(@Param('jobId') jobId: string): Observable<{ data: AskEvent }> {
    return this.svc.stream(jobId);
  }
}
