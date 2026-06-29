import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { interval, map, merge, Observable, Subject } from 'rxjs';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { SerializerService } from '../common/serializer.service';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';

// Backend-gehaltene KI-Generierungs-Queue fuer die Java-Analyse. Der Zustand liegt bewusst im
// Server (Map<fileId, QueueJob>): der Nutzer darf die Seite verlassen, die Queue laeuft weiter und
// der Fortschritt bleibt ueber /api/java/queues abfragbar (Live-Tokens zusaetzlich per SSE).
//
// EIN sequentieller Worker fuer alle Jobs -> Ollama wird nie parallel angefragt (Pi-Schutz).
//
// ATOMARE PRO-KLASSE-EINHEIT: Ein Job analysiert genau EINE Klasse vollstaendig. Reihenfolge
// zwingend (1) alle Methoden, (2) DANACH die Klassen-Zusammenfassung. Der Map-Schluessel ist die
// fileId -> pro Klasse existiert hoechstens ein (aktiver) Eintrag.
//
// Pro Schritt gilt die TypeORM-Regel: erst async (Ollama + Markdown) AUSSERHALB, DANN eine
// ds.transaction() mit awaited DB-Writes + FTS-Pflege (indexJavaFile / ggf. indexArticle).
//
// WISSENSDATENBANK (RAG): Vor jeder Generierung wird Kontext aus dem java_fts-Index gezogen
// (buildKnowledgeContext) -> bereits analysierte, thematisch passende Klassen fliessen als
// Snippet in den Prompt. Gewaehlt ggue. Vektor-RAG, weil FTS5 + indexJavaFile bereits existieren
// (kein Embedding-/sqlite-vss-Overhead, ARM/Pi-tauglich). Beim Batch ("Alle analysieren") werden
// die Klassen zusaetzlich TOPOLOGISCH sortiert (Abhaengigkeiten zuerst), damit beim Analysieren
// einer Klasse das Wissen ihrer Abhaengigkeiten schon im Index liegt. Die Wissensbasis fuellt
// sich so iterativ mit jeder abgeschlossenen Analyse von selbst.

type JobStatus = 'queued' | 'running' | 'done' | 'done-with-errors' | 'failed' | 'cancelled';
type JobPhase = 'methods' | 'class';

const DONE_STATES: JobStatus[] = ['done', 'done-with-errors', 'failed', 'cancelled'];

// Maximale Laenge des serverseitig gehaltenen Live-Puffers (nur die letzten Zeichen, fuer den
// Mid-Stream-Reload-Fallback ueber das Polling-Snapshot). Der Live-Strom selbst laeuft per SSE.
const LIVE_CAP = 4000;

// Live-Ereignis fuer den globalen SSE-Stream der KI-Queue (Token-by-Token-Anzeige).
interface QueueLiveEvent {
  phase: 'start' | 'token' | 'done' | 'heartbeat';
  key?: string; // `${fileId}`
  fileId?: number;
  label?: string; // start: aktueller Methoden-/Klassenname
  delta?: string; // token: neues Textfragment
  tokenCount?: number; // token: laufender Zaehler
}

interface QueueJob {
  fileId: number;
  className: string;
  package: string | null;
  // Aktuelle Phase der atomaren Einheit (Anzeige): erst 'methods', dann 'class'.
  phase: JobPhase;
  status: JobStatus;
  methodTotal: number;
  methodDone: number;
  methodFailed: number;
  classDone: boolean;
  // Beim erzwungenen Re-Run werden auch bereits analysierte Methoden neu generiert.
  force: boolean;
  current: { id: number; name: string } | null;
  ollamaUnavailable: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  // Zeitstempel des Einreihens -> stabile Sortierung in der Statusseite.
  queuedAt: string;
  // Live-Puffer des aktuell generierten Texts (gekappt) + Token-Zaehler. Quelle fuer den
  // Reload-Fallback im Frontend; der fluessige Live-Strom kommt per SSE (siehe live).
  liveText: string;
  tokenCount: number;
}

@Injectable()
export class JavaQueueService {
  // Schluessel = `${fileId}` -> genau eine atomare Analyse-Einheit pro Klasse.
  private jobs = new Map<string, QueueJob>();
  private worker: Array<() => Promise<void>> = [];
  private processing = false;
  // Cancel-Plumbing: laufende Ollama-Calls werden ueber den AbortController abgebrochen,
  // bereits eingereihte (noch nicht gestartete) Jobs ueber das cancelled-Set uebersprungen.
  private inflight = new Map<string, AbortController>();
  private cancelled = new Set<string>();
  // Globaler Live-Strom (alle Jobs) fuer die SSE-Token-Anzeige. Lebt fuer die Modul-Lebenszeit,
  // wird nie completet (EventSource reconnectet ohnehin).
  private live = new Subject<QueueLiveEvent>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
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

  private key(fileId: number): string {
    return String(fileId);
  }

  // SSE-Observable fuer den Queue-Controller: Live-Events + periodischer Heartbeat (haelt die
  // Verbindung durch nginx/Proxies offen). NestJS @Sse() erwartet { data }.
  getStream(): Observable<{ data: QueueLiveEvent }> {
    const heartbeat = interval(15000).pipe(map(() => ({ phase: 'heartbeat' as const })));
    return merge(this.live.asObservable(), heartbeat).pipe(map((data) => ({ data })));
  }

  // Live-Segment fuer einen neuen Generierungsschritt (Klasse/Methode) zuruecksetzen + Start melden.
  private beginLive(job: QueueJob, label: string): void {
    job.liveText = '';
    job.tokenCount = 0;
    this.live.next({ phase: 'start', key: this.key(job.fileId), fileId: job.fileId, label });
  }

  // onToken-Callback: Job-Puffer (gekappt) + Zaehler fortschreiben und Token-Delta per SSE pushen.
  private makeOnToken(job: QueueJob): (delta: string) => void {
    const key = this.key(job.fileId);
    return (delta: string) => {
      job.tokenCount++;
      job.liveText = (job.liveText + delta).slice(-LIVE_CAP);
      this.live.next({ phase: 'token', key, fileId: job.fileId, delta, tokenCount: job.tokenCount });
    };
  }

  // Snapshot eines Jobs mit abgeleiteten Gesamt-Zaehlern (total/done/failed) ueber die
  // Methoden-Phase + den Klassen-Schritt. Das Frontend liest direkt total/done/failed.
  private snapshot(job: QueueJob): any {
    return {
      fileId: job.fileId,
      className: job.className,
      package: job.package,
      phase: job.phase,
      status: job.status,
      methodTotal: job.methodTotal,
      methodDone: job.methodDone,
      methodFailed: job.methodFailed,
      classDone: job.classDone,
      // Gesamtfortschritt: N Methoden + 1 Klassen-Schritt.
      total: job.methodTotal + 1,
      done: job.methodDone + (job.classDone ? 1 : 0),
      failed: job.methodFailed,
      current: job.current ? { ...job.current } : null,
      ollamaUnavailable: job.ollamaUnavailable,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      queuedAt: job.queuedAt,
      liveText: job.liveText,
      tokenCount: job.tokenCount,
    };
  }

  // Alle Jobs als sortiertes Snapshot-Array (neueste zuerst) -> Statusseite /java/queues.
  list(): any[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .map((j) => this.snapshot(j));
  }

  // Snapshot der (einen) Queue einer Datei -> Polling-Banner/Badge in der Analyzer-View.
  get(fileId: number): any | null {
    const job = this.jobs.get(this.key(fileId));
    return job ? this.snapshot(job) : null;
  }

  // --- Einreihen ------------------------------------------------------------

  // Atomare Analyse-Einheit fuer EINE Klasse einreihen (Methoden -> Klassen-Zusammenfassung).
  // Dedupe: laeuft/wartet bereits ein Job fuer diese Datei, wird er unveraendert zurueckgegeben.
  // `force` erzwingt das Neu-Generieren auch bereits analysierter Methoden.
  async enqueueClass(fileId: number, userContext?: string, force = false): Promise<any> {
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    const key = this.key(fileId);
    const existing = this.jobs.get(key);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return this.snapshot(existing); // bereits aktiv -> nicht doppelt einreihen
    }

    const methodTotal = await this.ds
      .getRepository(JavaMethod)
      .count({ where: { file_id: fileId } });

    const job: QueueJob = {
      fileId,
      className: file.class_name,
      package: file.pkg ?? null,
      phase: methodTotal ? 'methods' : 'class',
      status: 'queued',
      methodTotal,
      methodDone: 0,
      methodFailed: 0,
      classDone: false,
      force,
      current: null,
      ollamaUnavailable: false,
      error: null,
      startedAt: null,
      finishedAt: null,
      queuedAt: new Date().toISOString(),
      liveText: '',
      tokenCount: 0,
    };
    this.jobs.set(key, job);
    this.cancelled.delete(key); // evtl. alter Cancel-Marker fuer diese Datei aufheben

    this.worker.push(() => this.runClassUnit(job, userContext));
    void this.process();
    return this.snapshot(job);
  }

  // Bulk: alle noch nicht (vollstaendig) KI-analysierten Klassen einreihen. Eine Klasse gilt als
  // unanalysiert, wenn die Klassenbeschreibung fehlt ODER mind. eine Methode unanalysiert ist
  // (ai_summary leer oder == javadoc). Reihenfolge: topologisch (Abhaengigkeiten zuerst), damit
  // die Wissensdatenbank beim Abarbeiten der abhaengigen Klassen bereits gefuellt ist.
  async enqueueAllUnanalyzed(userContext?: string): Promise<{ queuedClasses: number }> {
    const rows: Array<{ id: number }> = await this.ds.query(
      `SELECT f.id FROM java_files f
       WHERE (f.description IS NULL OR TRIM(f.description) = '')
          OR EXISTS (
            SELECT 1 FROM java_methods m
            WHERE m.file_id = f.id
              AND (m.ai_summary IS NULL OR TRIM(m.ai_summary) = '' OR m.ai_summary = COALESCE(m.javadoc, ''))
          )`,
    );
    const unanalyzed = new Set(rows.map((r) => r.id));

    const order = await this.topologicalOrder();
    const queueIds = order.filter((id) => unanalyzed.has(id));
    // Defensive: falls die Topo-Sortierung eine Datei ausgelassen hat, hinten anhaengen.
    for (const id of unanalyzed) if (!queueIds.includes(id)) queueIds.push(id);

    let queued = 0;
    for (const id of queueIds) {
      await this.enqueueClass(id, userContext);
      queued++;
    }
    return { queuedClasses: queued };
  }

  // Topologische Reihenfolge der Klassen ueber den Abhaengigkeitsgraphen (Kante source -> target
  // bedeutet: source haengt von target ab -> target zuerst). Wiederverwendung der vorhandenen
  // FQN->fileId-Aufloesung aus SerializerService.graphForJavaFiles(). Kahn-Algorithmus, stabil
  // nach id; Zyklen werden am Ende in id-Reihenfolge angehaengt.
  private async topologicalOrder(): Promise<number[]> {
    const { nodes, edges } = await this.serializer.graphForJavaFiles();
    const ids: number[] = nodes.map((n: any) => n.id);
    const prereqCount = new Map<number, number>(); // node -> Anzahl Abhaengigkeiten
    const dependents = new Map<number, number[]>(); // target -> abhaengige sources
    for (const id of ids) {
      prereqCount.set(id, 0);
      dependents.set(id, []);
    }
    const seen = new Set<string>();
    for (const e of edges as any[]) {
      if (!prereqCount.has(e.source_id) || !prereqCount.has(e.target_id)) continue;
      const k = `${e.source_id}->${e.target_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      prereqCount.set(e.source_id, (prereqCount.get(e.source_id) || 0) + 1);
      dependents.get(e.target_id)!.push(e.source_id);
    }

    const out: number[] = [];
    const ready = ids.filter((id) => (prereqCount.get(id) || 0) === 0).sort((a, b) => a - b);
    while (ready.length) {
      const id = ready.shift()!;
      out.push(id);
      for (const dep of dependents.get(id) || []) {
        prereqCount.set(dep, (prereqCount.get(dep) || 0) - 1);
        if ((prereqCount.get(dep) || 0) === 0) {
          ready.push(dep);
          ready.sort((a, b) => a - b);
        }
      }
    }
    if (out.length < ids.length) {
      for (const id of [...ids].sort((a, b) => a - b)) if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  // --- Cancel / Aufraeumen --------------------------------------------------

  // Einzelnen Job abbrechen: laufenden Ollama-fetch abbrechen (falls aktiv) und den Job aus der
  // Map entfernen -> verschwindet sofort aus list()/get(). Eine noch nicht gestartete Worker-
  // Closure sieht beim Start das cancelled-Flag und ueberspringt sich selbst.
  cancel(fileId: number): void {
    const key = this.key(fileId);
    this.cancelled.add(key);
    this.inflight.get(key)?.abort();
    this.jobs.delete(key);
  }

  // Gesamte Queue leeren: alle laufenden Calls abbrechen, ausstehende Closures verwerfen und
  // saemtliche Jobs (aktiv + abgeschlossen) entfernen -> die Statusseite ist danach leer.
  cancelAll(): void {
    for (const ctrl of this.inflight.values()) ctrl.abort();
    for (const key of this.jobs.keys()) this.cancelled.add(key);
    this.worker = [];
    this.jobs.clear();
    this.inflight.clear();
  }

  // Abgeschlossene Eintraege (fertig/fehlerhaft/abgebrochen) entfernen ("alle als gelesen
  // markieren"). Laufende/wartende Jobs bleiben unberuehrt. Die Analyse-Ergebnisse selbst liegen
  // dauerhaft in der DB -> hier verschwindet nur der transiente Queue-Eintrag.
  clearFinished(): void {
    for (const [key, job] of this.jobs) {
      if (DONE_STATES.includes(job.status)) this.jobs.delete(key);
    }
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

  // --- Atomare Klassen-Einheit ----------------------------------------------

  private firstLine(s: string): string {
    const line = (s || '')
      .split('\n')
      .map((x) => x.replace(/[#*`>_-]/g, '').trim())
      .find((x) => x.length > 0);
    return (line || '').slice(0, 160);
  }

  // RAG-Kontext: Nutzer-Kontext + Wissen aus frueheren Analysen (java_fts). Die eigene Datei wird
  // ausgeschlossen, damit sich eine Klasse nicht selbst als "Wissen" zitiert. Muster portiert aus
  // analysis/analysis.service.ts (buildContext), hier um Abhaengigkeitsnamen in der Query erweitert.
  private async buildKnowledgeContext(
    file: JavaFile,
    methods: JavaMethod[],
    userContext?: string,
  ): Promise<string> {
    const deps: Array<{ to_class_name: string }> = await this.ds.query(
      'SELECT to_class_name FROM java_dependencies WHERE from_file_id = ?',
      [file.id],
    );
    const depNames = deps
      .map((d) => (d.to_class_name || '').split('.').pop() || '')
      .filter(Boolean);
    const query = [file.class_name, ...depNames, ...methods.map((m) => m.method_name)].join(' ');
    const known = await this.fts.searchJava(query, 4, file.id);

    const parts: string[] = [];
    const uc = (userContext || '').trim();
    if (uc) parts.push(uc);
    if (known.length) {
      parts.push('Bekanntes Wissen aus frueheren Analysen:\n' + known.map((k) => `- ${k}`).join('\n'));
    }
    return parts.join('\n\n');
  }

  // Fuehrt die komplette Analyse einer Klasse aus: erst alle (ggf. nur unanalysierten) Methoden,
  // DANACH die Klassen-Zusammenfassung. Jeder Schritt: async Ollama+Markdown ausserhalb, dann Tx.
  private async runClassUnit(job: QueueJob, userContext?: string): Promise<void> {
    const key = this.key(job.fileId);
    if (this.cancelled.has(key)) return; // vor Start abgebrochen
    const controller = new AbortController();
    this.inflight.set(key, controller);

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: job.fileId } });
      if (!file) {
        job.status = 'failed';
        job.error = 'Datei nicht gefunden';
        return;
      }
      job.className = file.class_name;
      job.package = file.pkg ?? null;

      const allMethods = await this.ds
        .getRepository(JavaMethod)
        .find({ where: { file_id: file.id }, order: { id: 'ASC' } });
      job.methodTotal = allMethods.length;

      // RAG-Kontext einmal pro Einheit aufbauen (Wissensbasis + Nutzer-Kontext).
      const context = await this.buildKnowledgeContext(file, allMethods, userContext);

      // --- PHASE 1: Methoden ------------------------------------------------
      job.phase = 'methods';
      const isAnalyzed = (m: JavaMethod) =>
        !!m.ai_summary && m.ai_summary.trim() !== '' && m.ai_summary !== (m.javadoc || '');
      const pending = job.force ? allMethods : allMethods.filter((m) => !isAnalyzed(m));
      // Bereits analysierte Methoden zaehlen sofort als erledigt (Fortschritt bleibt korrekt).
      job.methodDone = job.force ? 0 : allMethods.length - pending.length;

      for (const m of pending) {
        if (controller.signal.aborted) break;
        job.current = { id: m.id, name: m.method_name };
        try {
          this.beginLive(job, m.method_name);
          const summary = await this.ollama.generateMethodDescription(
            {
              className: file.class_name,
              method: { ...m, parameters: this.safeJson(m.parameters, []) },
              context,
            },
            controller.signal,
            this.makeOnToken(job),
          );
          this.live.next({ phase: 'done', key });
          if (controller.signal.aborted) break;
          if (!summary) job.ollamaUnavailable = true;
          const finalSummary = summary || m.ai_summary || m.javadoc || '';

          await this.ds.transaction(async (manager) => {
            await manager.getRepository(JavaMethod).update({ id: m.id }, { ai_summary: finalSummary });
            await this.fts.indexJavaFile(manager, file.id);
            if (file.article_id) await this.fts.indexArticle(manager, file.article_id);
          });
          m.ai_summary = finalSummary; // frisch erzeugte Beschreibung in den Klassen-Kontext geben
          job.methodDone++;
        } catch {
          // Netzwerk-/DB-Fehler einer Methode -> markieren, Einheit laeuft weiter.
          job.methodFailed++;
        }
      }

      if (controller.signal.aborted) {
        job.current = null;
        job.status = 'cancelled';
        return;
      }

      // --- PHASE 2: Klassen-Zusammenfassung (erst nach den Methoden) ---------
      job.phase = 'class';
      job.current = { id: file.id, name: file.class_name };
      try {
        // Frisch analysierte Methoden als zusaetzlichen Kontext fuer die Klassenbeschreibung.
        const methodKnowledge = allMethods
          .map((m) => (m.ai_summary && m.ai_summary.trim() ? `- ${m.method_name}: ${this.firstLine(m.ai_summary)}` : ''))
          .filter(Boolean)
          .join('\n');
        const classContext = methodKnowledge
          ? `${context}${context ? '\n\n' : ''}Analysierte Methoden dieser Klasse:\n${methodKnowledge}`
          : context;

        this.beginLive(job, file.class_name);
        const summary = await this.ollama.generateClassSummary(
          {
            classInfo: {
              class_name: file.class_name,
              class_type: file.class_type,
              package: file.pkg,
              methods: allMethods.map((m) => ({ method_name: m.method_name })),
            },
            context: classContext,
          },
          controller.signal,
          this.makeOnToken(job),
        );
        this.live.next({ phase: 'done', key });
        if (!controller.signal.aborted) {
          if (!summary) job.ollamaUnavailable = true;
          const finalDescription = summary || file.description || '';
          const { html } = await this.markdown.renderMarkdown(finalDescription);
          const generatedAt = new Date().toISOString();

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
          job.classDone = true;
        }
      } catch (e: any) {
        job.error = e?.message || 'Fehler bei der Klassen-Generierung';
      }

      job.current = null;
      job.status = controller.signal.aborted
        ? 'cancelled'
        : job.methodFailed || !job.classDone
          ? 'done-with-errors'
          : 'done';
    } catch (e: any) {
      job.status = 'failed';
      job.error = e?.message || 'Fehler bei der Analyse';
    } finally {
      this.inflight.delete(key);
      job.finishedAt = new Date().toISOString();
    }
  }
}
