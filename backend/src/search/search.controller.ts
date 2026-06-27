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
    const rows = await this.fts.search(query);
    return Promise.all(
      rows.map(async (r) => ({
        ...(await this.serializer.serializeArticle(r, { withContent: false })),
        snippet: r.snippet,
      })),
    );
  }
}
