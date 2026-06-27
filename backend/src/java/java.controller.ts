import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { JavaService } from './java.service';

@Controller('java')
export class JavaController {
  constructor(private readonly svc: JavaService) {}

  @Post('analyze')
  analyze(@Body() body: any) {
    return this.svc.analyze(body);
  }

  @Get('files')
  listFiles() {
    return this.svc.listFiles();
  }

  @Get('graph')
  graph() {
    return this.svc.graph();
  }

  // Spezifischer als /files/:id -> MUSS davor stehen, sonst faengt :id "by-article" ab.
  @Get('files/by-article/:articleId')
  getFileByArticle(@Param('articleId') articleId: string) {
    return this.svc.getFileByArticle(articleId);
  }

  @Get('files/:id')
  getFile(@Param('id') id: string) {
    return this.svc.getFile(id);
  }

  // KI-Summary signalisiert "Ollama down" ueber ein Flag in einer 200-Antwort (kein Fehlerstatus).
  // Body optional: { userContext } -> Projekt-Kontext fuer den Prompt.
  @Post('methods/:id/summarize')
  @HttpCode(200)
  summarize(@Param('id') id: string, @Body() body: any) {
    return this.svc.summarize(id, body);
  }

  @Delete('files/:id')
  @HttpCode(204)
  deleteFile(@Param('id') id: string) {
    return this.svc.deleteFile(id);
  }

  @Put('files/:id')
  linkArticle(@Param('id') id: string, @Body() body: any) {
    return this.svc.linkArticle(id, body);
  }
}
