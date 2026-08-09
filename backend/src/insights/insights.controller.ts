import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { DriftService } from './drift.service';
import { InsightsService } from './insights.service';
import { parseChanges } from './what-if';

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
  // Die Architektur-Regeln samt ihrem Befund. Sie stehen zwar auch in der Uebersicht, aber der
  // Editor braucht die Antwort auf eine GEAENDERTE Regel sofort – und dafuer den ganzen Bericht neu
  // zu rechnen hiesse, fuer zwei getippte Zeichen alles noch einmal zu lesen.
  //
  // ⚠️ `rules` steht VOR `split/:fileId` und `drift`, was hier folgenlos ist (verschiedene Pfade),
  // aber der Reihenfolge im Articles-Controller entspricht: feste Segmente vor Parametern.
  @Get('rules')
  rules() {
    return this.svc.rules();
  }

  // Ganzer Text statt einzelner Zeilen: der Editor IST ein Textfeld, und Reihenfolge, Leerzeilen
  // und die `#`-Begruendungen gehoeren zur Eingabe. PUT und nicht PATCH – die Antwort ersetzt den
  // Stand vollstaendig.
  @Put('rules')
  saveRules(@Body() body: any) {
    if (typeof body?.text !== 'string') throw new BadRequestException('Expected { text } with the rule lines');
    return this.svc.saveRules(body.text);
  }

  @Get('drift')
  drift(@Query('since') since?: string) {
    return this.driftSvc.drift(since || null);
  }

  // Ein vorgemerkter Umbau, durchgerechnet. **POST, obwohl nichts geschrieben wird** – die Eingriffe
  // sind eine Liste und gehoeren in einen Body: als Query-String waere ein Umbau aus zwoelf
  // Schritten eine URL, die kein Proxy mehr durchlaesst. Die Antwort ist trotzdem reine Auskunft;
  // am Bestand aendert sich nichts (s. `what-if.ts`).
  //
  // Die Eingaben prueft `parseChanges` – dieselbe Datei, die sie auch anwendet. Eine zweite Pruefung
  // hier liefe beim naechsten neuen Eingriff auseinander.
  @Post('simulate')
  simulate(@Body() body: any) {
    const { changes, error } = parseChanges(body?.changes);
    if (error) throw new BadRequestException(error);
    return this.svc.simulate(changes);
  }

  @Get('split/:fileId')
  split(@Param('fileId', ParseIntPipe) fileId: number, @Query('driver') driver?: string) {
    return this.svc.splitPlan(fileId, driver);
  }
}
