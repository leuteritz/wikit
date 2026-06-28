import { Controller, Get, Query } from '@nestjs/common';
import { FtsService } from '../database/fts.service';
import { SerializerService } from '../common/serializer.service';

// Serverseitige FTS5-Volltextsuche mit Snippet-Highlights.
// Wird vom Frontend als "Deep Search"-Fallback genutzt (Fuse.js deckt den Sofort-Fall ab).
@Controller('search')
export class SearchController {
  constructor(
    private readonly fts: FtsService,
    private readonly serializer: SerializerService,
  ) {}

  @Get()
  async search(@Query('q') q?: string): Promise<any[]> {
    const query = (q || '').toString().trim();
    if (!query) return [];

    const [articleRows, javaRows] = await Promise.all([
      this.fts.search(query),
      this.fts.searchJavaFiles(query),
    ]);

    // Artikel (mit serialisierter Shape) zuerst, danach Code-Treffer. Beide Quellen tragen ein
    // `type`-Feld, damit das Frontend gruppieren kann ('article' vs. 'java_file').
    const articles = await Promise.all(
      articleRows.map(async (r) => ({
        ...(await this.serializer.serializeArticle(r, { withContent: false })),
        type: 'article',
        snippet: r.snippet,
      })),
    );
    const javaFiles = javaRows.map((r) => ({
      id: r.id,
      name: r.class_name || r.filename,
      package: r.package || '',
      type: 'java_file',
      snippet: r.snippet,
    }));

    return [...articles, ...javaFiles];
  }
}
