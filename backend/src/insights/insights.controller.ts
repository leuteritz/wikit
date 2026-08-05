import { Controller, Get } from '@nestjs/common';
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
}
