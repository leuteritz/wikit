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

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  @Get()
  async search(@Query('q') q?: string): Promise<any[]> {
    const query = (q || '').toString().trim();
    if (!query) return [];

    const [articleRows, javaRows, javaMethodRows] = await Promise.all([
      this.fts.search(query),
      this.fts.searchJavaFiles(query),
      this.fts.searchJavaMethods(query),
    ]);

    // Artikel (mit serialisierter Shape) zuerst, danach Code-Treffer. Jede Quelle traegt ein
    // `type`-Feld, damit das Frontend gruppieren kann ('article' | 'java_entity' | 'java_file').
    const articles = await Promise.all(
      articleRows.map(async (r) => ({
        ...(await this.serializer.serializeArticle(r, { withContent: false })),
        type: 'article',
        snippet: r.snippet,
      })),
    );

    // Methoden-Treffer: zeilengenauer Sprung (lineNumber + symbolKind) ins Quellcode-Panel.
    const javaMethods = javaMethodRows.map((r) => ({
      type: 'java_entity',
      symbolKind: 'method',
      fileId: r.file_id,
      lineNumber: r.start_line ?? 1,
      name: r.method_name,
      className: r.class_name,
      package: r.package || '',
      signature: this.serializer.buildSignature({
        return_type: r.return_type,
        method_name: r.method_name,
        parameters: this.safeJson(r.parameters, []),
      }),
    }));

    // Klassen-/Datei-Treffer: Typ bleibt 'java_file' (abwaertskompatibel), zusaetzlich
    // fileId/lineNumber/symbolKind fuers zeilengenaue Oeffnen der Klassendeklaration.
    const javaFiles = javaRows.map((r) => ({
      id: r.id,
      fileId: r.id,
      name: r.class_name || r.filename,
      package: r.package || '',
      type: 'java_file',
      symbolKind: 'class',
      lineNumber: r.class_line ?? 1,
      snippet: r.snippet,
    }));

    return [...articles, ...javaMethods, ...javaFiles];
  }
}
