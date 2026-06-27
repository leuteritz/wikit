import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';
import { AnalysisQueue } from './analysis.queue';

// Takt der Lebenszeichen waehrend eines (langsamen) Ollama-Calls.
const HEARTBEAT_MS = 3000;

// Orchestriert die gestreamte KI-Analyse einer Java-Klasse: zuerst Klassenbeschreibung,
// dann Methode fuer Methode. Jeder Schritt: erst async (Ollama + Markdown), DANN Transaktion.
@Injectable()
export class AnalysisService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
    private readonly fts: FtsService,
    private readonly queue: AnalysisQueue,
  ) {}

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  // Sendet waehrend eines langsamen (auf dem Pi ~40s+) Ollama-Calls periodisch ein
  // Lebenszeichen mit der server-gemessenen Schritt-Laufzeit. Der Single-Worker garantiert,
  // dass immer nur EIN Timer aktiv ist; clearInterval im finally -> kein Heartbeat nach Done.
  private async withHeartbeat<T>(
    articleId: number,
    index: number,
    total: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const timer = setInterval(
      () =>
        this.queue.emitHeartbeat(articleId, {
          type: 'heartbeat',
          index,
          total,
          elapsedMs: Date.now() - startedAt,
        }),
      HEARTBEAT_MS,
    );
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  // Startet einen Analyse-Lauf fuer den der articleId zugeordneten Java-Datei.
  // Reihenfolge: resetStream (vor enqueue) -> Jobs bauen -> enqueue. Das Frontend ruft
  // start() VOR dem Oeffnen des SSE-Streams auf; der ReplaySubject puffert die Events.
  async start(articleId: number, userContext?: string): Promise<{ queued: boolean; total: number }> {
    this.queue.resetStream(articleId);

    const file = await this.ds.getRepository(JavaFile).findOne({ where: { article_id: articleId } });
    if (!file) {
      this.queue.emit(articleId, { type: 'error', message: 'Keine Java-Klasse mit diesem Artikel verknuepft.' });
      this.queue.emit(articleId, { type: 'all_done', total: 0 });
      this.queue.complete(articleId);
      return { queued: false, total: 0 };
    }

    const methods = await this.ds.getRepository(JavaMethod).find({
      where: { file_id: file.id },
      order: { id: 'ASC' },
    });
    const total = methods.length;

    // Kontext = Nutzer-Kontext (Windchill o. ae.) + Wissen aus frueheren Analysen (Java-FTS).
    const query = [file.class_name, ...methods.map((m) => m.method_name)].join(' ');
    const known = await this.fts.searchJava(query, 4);
    const context = this.buildContext(userContext, file.id, known);

    const jobs: Array<(signal: AbortSignal) => Promise<void>> = [];

    // 1) Klassenbeschreibung
    jobs.push(async (signal) => {
      this.queue.emit(articleId, { type: 'class_start', index: 0, total });
      try {
        const aiText =
          (await this.withHeartbeat(articleId, 0, total, () =>
            this.ollama.generateClassSummary(
              {
                classInfo: {
                  class_name: file.class_name,
                  class_type: file.class_type,
                  package: file.pkg,
                  methods: methods.map((m) => ({ method_name: m.method_name })),
                },
                context,
              },
              signal,
            ),
          )) || '';
        if (signal.aborted) return; // mitten im Call abgebrochen -> nichts persistieren
        const aiGenerated = aiText.trim().length > 0;
        const md = aiText || file.description || '';
        const { html } = await this.markdown.renderMarkdown(md);
        const generatedAt = new Date().toISOString();
        await this.ds.transaction(async (manager) => {
          await manager.getRepository(JavaFile).update(
            { id: file.id },
            { description: md, description_html: html, generated_at: generatedAt },
          );
          await this.fts.indexJavaFile(manager, file.id);
          await this.fts.indexArticle(manager, articleId);
        });
        this.queue.emit(articleId, { type: 'class_done', index: 0, total, content: html, aiGenerated });
      } catch (e: any) {
        this.queue.emit(articleId, { type: 'error', index: 0, message: e?.message || 'Fehler' });
      }
    });

    // 2) Je Methode eine Beschreibung (geordnet ueber methodIndex)
    methods.forEach((m, i) => {
      const idx = i + 1;
      jobs.push(async (signal) => {
        this.queue.emit(articleId, { type: 'method_start', index: idx, total });
        try {
          const aiText =
            (await this.withHeartbeat(articleId, idx, total, () =>
              this.ollama.generateMethodDescription(
                {
                  className: file.class_name,
                  method: { ...m, parameters: this.safeJson(m.parameters, []) },
                  context,
                },
                signal,
              ),
            )) || '';
          if (signal.aborted) return; // mitten im Call abgebrochen -> nichts persistieren
          const aiGenerated = aiText.trim().length > 0;
          const md = aiText || m.ai_summary || m.javadoc || '';
          const { html } = await this.markdown.renderMarkdown(md);
          await this.ds.transaction(async (manager) => {
            await manager.getRepository(JavaMethod).update({ id: m.id }, { ai_summary: md });
            await this.fts.indexJavaFile(manager, file.id);
            await this.fts.indexArticle(manager, articleId);
          });
          this.queue.emit(articleId, {
            type: 'method_done',
            index: idx,
            total,
            content: { id: m.id, ai_summary: md, summary_html: html },
            aiGenerated,
          });
        } catch (e: any) {
          this.queue.emit(articleId, { type: 'error', index: idx, message: e?.message || 'Fehler' });
        }
      });
    });

    // 3) Abschluss
    jobs.push(async () => {
      this.queue.emit(articleId, { type: 'all_done', total });
      this.queue.complete(articleId);
    });

    this.queue.enqueue(articleId, jobs);
    return { queued: true, total };
  }

  private buildContext(userContext: string | undefined, _fileId: number, known: string[]): string {
    const parts: string[] = [];
    const uc = (userContext || '').trim();
    if (uc) parts.push(uc);
    if (known.length) {
      parts.push('Bekanntes Wissen aus frueheren Analysen:\n' + known.map((k) => `- ${k}`).join('\n'));
    }
    return parts.join('\n\n');
  }
}
