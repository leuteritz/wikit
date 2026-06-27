import { Module } from '@nestjs/common';
import { JavaController } from './java.controller';
import { JavaService } from './java.service';
import { JavaQueueService } from './java-queue.service';

@Module({
  controllers: [JavaController],
  providers: [JavaService, JavaQueueService],
})
export class JavaModule {}
