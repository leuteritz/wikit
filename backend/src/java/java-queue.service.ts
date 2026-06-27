import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';

// Backend-gehaltene KI-Generierungs-Queue fuer die Java-Analyse (kein SSE -> reines HTTP-Polling).
// Der Zustand liegt bewusst im Server (Map<fileId, QueueJob>): der Nutzer darf die Seite verlassen,
// die Queue laeuft weiter und der Fortschritt bleibt ueber /api/java/queues abfragbar.
//
// EIN sequentieller Worker fuer alle Jobs -> Ollama wird nie parallel angefragt (Pi-Schutz),
// Muster wie analysis/analysis.queue.ts. Pro Schritt gilt die TypeORM-Regel: erst async
// (Ollama + Markdown) ausserhalb, DANN eine ds.transaction() mit awaited DB-Writes + FTS-Pflege.

type JobKind = 'class' | 'methods';
type JobStatus = 'queued' | 'running' | 'done' | 'done-with-errors' | 'failed';

interface QueueJob {
  fileId: number;
  className: string;
  package: string | null;
  kind: JobKind;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  current: { id: number; name: string } | null;
  ollamaUnavailable: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  // Zeitstempel des Einreihens -> stabile Sortierung in der Statusseite.
  queuedAt: string;
}

@Injectable()
export class JavaQueueService {
  // Schluessel = `${fileId}:${kind}` -> Klassen- und Methoden-Queue derselben Datei koexistieren.
  private jobs = new Map<string, QueueJob>();
  private worker: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
    private readonly fts: FtsService,
  ) {}

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  private key(fileId: number, kind: JobKind): string {
    return `${fileId}:${kind}`;
  }

  private snapshot(job: QueueJob): QueueJob {
    return { ...job, current: job.current ? { ...job.current } : null };
  }

  // Alle Jobs als sortiertes Snapshot-Array (neueste zuerst) -> Statusseite /java/queues.
  list(): QueueJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .map((j) => this.snapshot(j));
  }

  // Snapshot eines einzelnen Jobs (laufende Queue bevorzugt) -> Polling in der Analyzer-View.
  get(fileId: number): QueueJob | null {
    const methods = this.jobs.get(this.key(fileId, 'methods'));
    const cls = this.jobs.get(this.key(fileId, 'class'));
    // Bevorzugt eine laufende/wartende Queue zurueckgeben, sonst die zuletzt aktualisierte.
    const candidates = [methods, cls].filter(Boolean) as QueueJob[];
    if (!candidates.length) return null;
    const active = candidates.find((j) => j.status === 'running' || j.status === 'queued');
    const pick = active || candidates.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
    return this.snapshot(pick);
  }

  // Klassen-Zusammenfassung einreihen (ein Schritt).
  async enqueueClass(fileId: number, userContext?: string): Promise<QueueJob> {
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    const job: QueueJob = {
      fileId,
      className: file.class_name,
      package: file.pkg ?? null,
      kind: 'class',
      status: 'queued',
      total: 1,
      done: 0,
      failed: 0,
      current: null,
      ollamaUnavailable: false,
      error: null,
      startedAt: null,
      finishedAt: null,
      queuedAt: new Date().toISOString(),
    };
    this.jobs.set(this.key(fileId, 'class'), job);

    this.worker.push(() => this.runClassJob(job, userContext));
    void this.process();
    return this.snapshot(job);
  }

  // Alle Methoden der Datei einreihen (N Schritte, sequentiell).
  async enqueueMethods(fileId: number, userContext?: string): Promise<QueueJob> {
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    const methods = await this.ds
      .getRepository(JavaMethod)
      .find({ where: { file_id: fileId }, order: { id: 'ASC' } });

    const job: QueueJob = {
      fileId,
      className: file.class_name,
      package: file.pkg ?? null,
      kind: 'methods',
      status: methods.length ? 'queued' : 'done',
      total: methods.length,
      done: 0,
      failed: 0,
      current: null,
      ollamaUnavailable: false,
      error: null,
      startedAt: null,
      finishedAt: methods.length ? null : new Date().toISOString(),
      queuedAt: new Date().toISOString(),
    };
    this.jobs.set(this.key(fileId, 'methods'), job);

    if (methods.length) {
      this.worker.push(() => this.runMethodsJob(job, methods, userContext));
      void this.process();
    }
    return this.snapshot(job);
  }

  // --- Worker-Steuerung -----------------------------------------------------

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      let task: (() => Promise<void>) | undefined;
      while ((task = this.worker.shift())) {
        try {
          await task();
        } catch {
          // Defensiv: job-interne Fehler sind dort bereits behandelt; Worker laeuft weiter.
        }
      }
    } finally {
      this.processing = false;
    }
  }

  // --- Job-Implementierungen (Tx-Muster wie JavaService) ---------------------

  private async runClassJob(job: QueueJob, userContext?: string): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: job.fileId } });
      if (!file) {
        job.status = 'failed';
        job.error = 'Datei nicht gefunden';
        job.finishedAt = new Date().toISOString();
        return;
      }
      job.current = { id: file.id, name: file.class_name };

      const methods = await this.ds
        .getRepository(JavaMethod)
        .find({ where: { file_id: file.id }, select: { method_name: true } });

      // 1) async + teuer ausserhalb der Transaktion
      const summary = await this.ollama.generateClassSummary({
        classInfo: {
          class_name: file.class_name,
          class_type: file.class_type,
          package: file.pkg,
          methods: methods.map((m) => ({ method_name: m.method_name })),
        },
        context: userContext,
      });
      if (!summary) job.ollamaUnavailable = true;
      const finalDescription = summary || file.description || '';
      const { html } = await this.markdown.renderMarkdown(finalDescription);
      const generatedAt = new Date().toISOString();

      // 2) DB-Writes + FTS in der Transaktion (awaited)
      await this.ds.transaction(async (manager) => {
        await manager
          .getRepository(JavaFile)
          .update(
            { id: file.id },
            { description: finalDescription, description_html: html, generated_at: generatedAt },
          );
        await this.fts.indexJavaFile(manager, file.id);
        if (file.article_id) await this.fts.indexArticle(manager, file.article_id);
      });

      job.done = 1;
      job.current = null;
      job.status = 'done';
    } catch (e: any) {
      job.failed = 1;
      job.status = 'failed';
      job.error = e?.message || 'Fehler bei der Klassen-Generierung';
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  private async runMethodsJob(
    job: QueueJob,
    methods: JavaMethod[],
    userContext?: string,
  ): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: job.fileId } });
    const className = file?.class_name || job.className;

    for (const m of methods) {
      job.current = { id: m.id, name: m.method_name };
      try {
        // 1) async + teuer ausserhalb der Transaktion
        const summary = await this.ollama.generateMethodDescription({
          className,
          method: { ...m, parameters: this.safeJson(m.parameters, []) },
          context: userContext,
        });
        if (!summary) job.ollamaUnavailable = true;
        const finalSummary = summary || m.ai_summary || m.javadoc || '';
        // Markdown wird im Serializer fuers Frontend gerendert; hier nur DB-Wert sichern.

        // 2) DB-Write + FTS in der Transaktion (awaited)
        await this.ds.transaction(async (manager) => {
          await manager.getRepository(JavaMethod).update({ id: m.id }, { ai_summary: finalSummary });
          await this.fts.indexJavaFile(manager, job.fileId);
          if (file?.article_id) await this.fts.indexArticle(manager, file.article_id);
        });
        job.done++;
      } catch {
        // Netzwerk-/DB-Fehler einer Methode -> als fehlgeschlagen markieren, Queue laeuft weiter.
        job.failed++;
      }
    }

    job.current = null;
    job.status = job.failed ? 'done-with-errors' : 'done';
    job.finishedAt = new Date().toISOString();
  }
}
