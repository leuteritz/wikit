import { Module } from '@nestjs/common';
import { DriftService } from './drift.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  controllers: [InsightsController],
  providers: [InsightsService, DriftService],
})
export class InsightsModule {}
