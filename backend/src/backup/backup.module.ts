import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { ArticlesModule } from '../articles/articles.module';

// Der Restore schreibt ueber `ArticlesService` – deshalb haengt dieses Modul am ArticlesModule und
// baut keinen eigenen Schreibpfad. `SettingsService` kommt aus dem @Global CommonModule.
@Module({
  imports: [ArticlesModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
