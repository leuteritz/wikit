import { Module } from '@nestjs/common';
import { JavaController } from './java.controller';
import { JavaService } from './java.service';

@Module({
  controllers: [JavaController],
  providers: [JavaService],
})
export class JavaModule {}
