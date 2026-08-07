import { Module } from '@nestjs/common';
import { JavaController } from './java.controller';
import { JavaService } from './java.service';
import { JavaQueueService } from './java-queue.service';
import { JavaBatchProgressService } from './java-batch-progress.service';
import { JavaEmbeddingsService } from './java-embeddings.service';

@Module({
  controllers: [JavaController],
  providers: [JavaService, JavaQueueService, JavaBatchProgressService, JavaEmbeddingsService],
  // `/ask` baut seine Quellen auf derselben Bedeutungssuche auf, mit der die Palette ihre Treffer
  // findet -- der Vektor-Cache lebt im Service, also wird er geteilt und nicht nachgebaut.
  exports: [JavaEmbeddingsService],
})
export class JavaModule {}
