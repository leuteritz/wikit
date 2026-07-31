import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';

// SettingsService und OllamaService kommen aus dem globalen CommonModule.
@Module({
  controllers: [BotController],
  providers: [BotService],
})
export class BotModule {}
