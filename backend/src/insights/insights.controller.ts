import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { InsightsService } from './insights.service';

@Controller('insights')
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

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
  @Get('split/:fileId')
  split(@Param('fileId', ParseIntPipe) fileId: number, @Query('driver') driver?: string) {
    return this.svc.splitPlan(fileId, driver);
  }
}
