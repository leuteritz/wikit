import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { BackupService } from './backup.service';

@Controller('backup')
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  /** `versions=1` nimmt den Fassungsverlauf mit – Default aus, s. Service. */
  @Get()
  create(@Query('versions') versions: string) {
    return this.svc.create({ versions: versions === '1' || versions === 'true' });
  }

  // POST mit dem Backup im Body. ⚠️ Die Groesse begrenzt `WIKI_BODY_LIMIT` in `main.ts` (64 mb) –
  // darueber antwortet der Filter dort mit einer 413 samt Grund.
  @Post('restore')
  @HttpCode(200)
  restore(@Body() body: any) {
    return this.svc.restore(body);
  }
}
