import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DriftService } from './drift.service';
import { InsightsService } from './insights.service';

@Controller('insights')
export class InsightsController {
  constructor(
    private readonly svc: InsightsService,
    private readonly driftSvc: DriftService,
  ) {}

  // EIN Endpunkt, EINE Antwort: Klassenkennzahlen, Package-Kennzahlen und Zyklen entstehen aus
  // demselben aufgeloesten Graphen. Sie auf drei Routen zu verteilen hiesse, ihn dreimal zu bauen –
  // und zwei Ansichten koennten dann verschiedene Staende zeigen.
  @Get()
  overview() {
    return this.svc.overview();
  }

  // Der Aufteilungsvorschlag zu EINER Klasse – bewusst ein eigener Endpunkt und nicht Teil der
  // Uebersicht: er liest die Methodenruempfe (die groesste Spalte der Datenbank) und wird fuer eine
  // einzige Klasse gefragt, wenn jemand ihre Zeile aufklappt. Ihn mitzuliefern hiesse, ihn fuer
  // tausend Klassen zu rechnen, von denen niemand eine ansieht.
  //
  // `driver` ist die Auskunft der Rangliste, aus der man hierher klickt (Stichentscheid zwischen
  // zwei gleich gut passenden Schnitten) – optional, weil ein fehlender Wert folgenlos ist.
  // Was hat sich seit `since` (Tag, `YYYY-MM-DD`) veraendert? Eigener Endpunkt und nicht Teil der
  // Uebersicht: der Lauf liest alte Quelltexte und rechnet einen ZWEITEN Graphen – niemand zahlt
  // das mit, wer nur die Kennzahlen aufschlaegt. Ohne `since` waehlt der Bericht den Tag vor der
  // letzten Aenderung, also die Frage, mit der man ihn oeffnet.
  @Get('drift')
  drift(@Query('since') since?: string) {
    return this.driftSvc.drift(since || null);
  }

  @Get('split/:fileId')
  split(@Param('fileId', ParseIntPipe) fileId: number, @Query('driver') driver?: string) {
    return this.svc.splitPlan(fileId, driver);
  }
}
