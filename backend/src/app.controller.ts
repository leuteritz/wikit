import { Controller, Get } from '@nestjs/common';

// Health-Check. Mit globalem Prefix 'api' -> GET /api/health.
@Controller()
export class AppController {
  @Get('health')
  health() {
    return { ok: true };
  }
}
