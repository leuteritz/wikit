import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { BotService, PlaygroundEvent } from './bot.service';

@Controller('bot')
export class BotController {
  constructor(private readonly svc: BotService) {}

  // Aufgeloeste Einstellungen + Defaults + Feldbeschreibung (Grenzen/Erklaerungen) in EINER Antwort.
  @Get('settings')
  getSettings() {
    return this.svc.getSettings();
  }

  // Teil-Update: nur mitgeschickte Felder aendern sich. Antwort = derselbe Stand wie GET.
  @Put('settings')
  updateSettings(@Body() body: any) {
    return this.svc.updateSettings(body);
  }

  // Auf Env/Code-Default zuruecksetzen. Body { paths?: string[] } -> einzelne Felder, sonst alle.
  // Statische Route -> steht vor keiner parametrisierten in Konflikt, aber hinter PUT settings.
  @Post('settings/reset')
  @HttpCode(200)
  resetSettings(@Body() body: any) {
    return this.svc.resetSettings(Array.isArray(body?.paths) ? body.paths : undefined);
  }

  // Verbindungstest. `host`/`model` optional -> pruefen, bevor gespeichert wird.
  @Get('health')
  health(@Query('host') host?: string, @Query('model') model?: string) {
    return this.svc.health(host, model);
  }

  // Installierte Modelle des Ollama-Servers (ollama pull). `host` optional wie oben.
  @Get('models')
  models(@Query('host') host?: string) {
    return this.svc.models(host);
  }

  // Probelauf starten (antwortet sofort, Text kommt ueber den SSE-Strom unten). Der Client erzeugt
  // die jobId, oeffnet damit den Strom und schickt sie hier im Body mit -- dieselbe Bauart wie
  // analyze-progress.
  @Post('playground')
  @HttpCode(202)
  startPlayground(@Body() body: any) {
    return this.svc.startPlayground(body);
  }

  // Statische Route -> MUSS vor playground/:jobId stehen, sonst faengt :jobId "cancel" ab.
  @Post('playground/:jobId/cancel')
  @HttpCode(204)
  cancelPlayground(@Param('jobId') jobId: string) {
    this.svc.cancelPlayground(jobId);
  }

  @Sse('playground/:jobId')
  playgroundStream(@Param('jobId') jobId: string): Observable<{ data: PlaygroundEvent }> {
    return this.svc.stream(jobId);
  }
}
