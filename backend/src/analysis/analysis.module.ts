import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AnalysisQueue } from './analysis.queue';

// Queue + SSE fuer die gestreamte KI-Analyse. Ollama/Markdown/Fts kommen aus dem globalen
// CommonModule. AnalysisQueue ist hier Singleton (ein Worker fuer alle Laeufe).
@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisQueue],
})
export class AnalysisModule {}
