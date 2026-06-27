import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RelationsService } from './relations.service';

@Controller('relations')
export class RelationsController {
  constructor(private readonly svc: RelationsService) {}

  @Get()
  getGraph() {
    return this.svc.getGraph();
  }

  @Post()
  create(@Body() body: any) {
    return this.svc.create(body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
