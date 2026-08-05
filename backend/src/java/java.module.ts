import { Module } from '@nestjs/common';
import { JavaController } from './java.controller';
import { JavaService } from './java.service';
import { JavaQueueService } from './java-queue.service';
import { JavaBatchProgressService } from './java-batch-progress.service';
import { JavaEmbeddingsService } from './java-embeddings.service';

@Module({
  controllers: [JavaController],
  providers: [JavaService, JavaQueueService, JavaBatchProgressService, JavaEmbeddingsService],
})
export class JavaModule {}
