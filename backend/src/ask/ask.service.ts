import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMPTY, Observable, Subject, concat, interval, map, merge, of } from 'rxjs';
import { renderPrompt } from '../common/bot-config';
import { OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';
import { safeJson } from '../common/json.util';
import { JavaEmbeddingsService } from '../java/java-embeddings.service';

/**
 * „Ask the codebase" (`/ask`): eine Frage in Prosa, eine belegte Antwort.
 *
 * Die Bedeutungssuche beantwortet „welche Klasse kuemmert sich darum?" mit einer Liste. Diese
 * Ansicht beantwortet dieselbe Frage mit einem Satz -- und genau deshalb ist sie ohne Belege
 * wertlos: eine Trefferliste kann man nachsehen, einen Fliesstext nicht. Drei Festlegungen:
 *
 * 1. **Retrieval schlaegt Gedaechtnis.** Das Modell bekommt ausschliesslich die abgerufenen
 *    Klassen und die Anweisung, nichts anderes zu verwenden. Ein Sprachmodell kennt „OrderService"
 *    aus tausend fremden Projekten -- ohne diese Schranke antwortet es ueber die falsche Codebasis.
 * 2. **Die Quellen gehen VOR dem ersten Token raus** (`sources`-Event). Wer die Frage stellt, sieht
 *    sofort, worauf die Antwort sich stuetzen wird -- und erkennt eine falsche Auswahl, bevor er
 *    einen Text liest, der auf ihr aufbaut. Die Antwort danach ist nur noch die Zusammenfassung.
 * 3. **Ohne Index gibt es keine Antwort, sondern einen Grund.** Kein Embedding-Modell, kein
 *    Index, Ollama weg -- jedes davon ist eine eigene Auskunft mit einem eigenen naechsten
 *    Schritt. Eine leere Antwort „weiss ich nicht" waere die Behauptung, die Codebasis gebe
 *    nichts her.
 */

// Wie viele Klassen in den Prompt wandern. Der relative Schnitt der Bedeutungssuche entscheidet
// zuerst -- das hier ist der Deckel darueber. Mehr als eine Handvoll passt auf einem Pi
// (qwen2.5-coder:3b, kleines Fenster) ohnehin nicht sinnvoll hinein, und ab einer gewissen Menge
// verduennt jede weitere Klasse die relevanten.
const MAX_CLASSES = 6;
// Obergrenze je Klasse und insgesamt. Gekuerzt wird an der Stelle, die am wenigsten aussagt (die
// Mitgliederliste zuletzt) -- ein am Fensterende abgeschnittener Prompt verliert dagegen genau
// das, was das Modell zuletzt gelesen haette: die Frage.
const MAX_CLASS_CHARS = 1400;
const MAX_TOTAL_CHARS = 8000;
// Mitglieder je Klasse im Kontext. Eine Klasse mit 60 Methoden wuerde den Platz aller anderen
// fressen; die ersten sagen ueber die Verantwortlichkeit mehr aus als die letzten.
const MAX_MEMBERS = 14;

// Wie beim Playground: der letzte Stand bleibt kurz abrufbar, falls der Client die Verbindung
// neu aufbaut.
const CLEANUP_MS = 30_000;
// Serverseitig gehaltener Antworttext (Reconnect-Puffer). Eine Antwort ist kurz -- was darueber
// hinausgeht, hat der Client bereits als Token bekommen.
const ANSWER_CAP = 20_000;

export interface AskSourceMember {
  name: string;
  line: number | null;
}

export interface AskSource {
  fileId: number;
  className: string;
  package: string;
  type: string;
  score: number;
  classLine: number | null;
  members: AskSourceMember[];
}

export interface AskEvent {
  phase: 'snapshot' | 'searching' | 'sources' | 'start' | 'token' | 'done' | 'error' | 'heartbeat';
  delta?: string;
  text?: string;
  sources?: AskSource[];
  question?: string;
  model?: string;
  tokenCount?: number;
  elapsedMs?: number;
  stats?: unknown;
  error?: string;
  /** Maschinenlesbarer Grund einer leeren Quellenliste: disabled | not-indexed | unavailable | no-match. */
  reason?: string;
}

interface AskRun {
  controller: AbortController;
  question: string;
  sources: AskSource[];
  text: string;
  tokenCount: number;
  startedAt: number;
  done: boolean;
}

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);
  private streams = new Map<string, Subject<AskEvent>>();
  private runs = new Map<string, AskRun>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly settings: SettingsService,
    private readonly embeddings: JavaEmbeddingsService,
  ) {}

  // --- SSE-Verwaltung (gleiche Bauart wie der Playground) ----------------------------------------

  private subject(jobId: string): Subject<AskEvent> {
    let s = this.streams.get(jobId);
    if (!s) {
      s = new Subject<AskEvent>();
      this.streams.set(jobId, s);
    }
    return s;
  }

  /**
   * Strom eines Laufs. Beim Verbinden geht der bisherige Stand raus (`snapshot`) -- inklusive der
   * Quellen: ein Reconnect mitten in der Antwort darf nicht in einem Text ohne seine Belege enden.
   */
  stream(jobId: string): Observable<{ data: AskEvent }> {
    const subject = this.subject(jobId);
    const run = this.runs.get(jobId);
    const initial: Observable<AskEvent> = run
      ? of({
          phase: 'snapshot' as const,
          text: run.text,
          sources: run.sources,
          question: run.question,
          tokenCount: run.tokenCount,
        })
      : EMPTY;
    const heartbeat = interval(15000).pipe(map(() => ({ phase: 'heartbeat' as const })));
    return merge(concat(initial, subject.asObservable()), heartbeat).pipe(map((data) => ({ data })));
  }

  private emit(jobId: string, event: AskEvent): void {
    this.subject(jobId).next(event);
    if (event.phase === 'done' || event.phase === 'error') this.scheduleCleanup(jobId);
  }

  private scheduleCleanup(jobId: string): void {
    clearTimeout(this.timers.get(jobId));
    this.timers.set(
      jobId,
      setTimeout(() => {
        this.streams.get(jobId)?.complete();
        this.streams.delete(jobId);
        this.runs.delete(jobId);
        this.timers.delete(jobId);
      }, CLEANUP_MS),
    );
  }

  // --- Retrieval ---------------------------------------------------------------------------------

  /**
   * Die abgerufenen Klassen mit dem, was sie ausmacht: Beschreibung und Mitglieder-Signaturen.
   *
   * Der Rohquelltext bleibt draussen -- aus demselben Grund, aus dem er nicht eingebettet wird: er
   * besteht zur Haelfte aus Syntax, und ein Kontextfenster, das mit `import`-Zeilen und
   * Getter-Rumpfen gefuellt ist, hat keinen Platz mehr fuer die Klasse, um die es geht.
   *
   * `start_line` faehrt mit, weil sie den Beleg anklickbar macht: `[OrderService#place]` wird im
   * Client zum Sprung auf genau diese Zeile.
   */
  private async loadSources(hits: Array<{ fileId: number; score: number }>): Promise<AskSource[]> {
    if (!hits.length) return [];
    const ids = hits.map((h) => h.fileId);
    const rows = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, description, class_line
         FROM java_files WHERE id IN (${ids.join(',')})`,
    );
    const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));

    const members = new Map<number, AskSourceMember[]>();
    const signatures = new Map<number, string[]>();
    for (const m of await this.ds.query(
      `SELECT file_id, method_name, return_type, parameters, javadoc, ai_summary, start_line, member_kind
         FROM java_methods WHERE file_id IN (${ids.join(',')}) ORDER BY start_line, id`,
    )) {
      const id = Number(m.file_id);
      // Felder tragen keine Signatur und beantworten keine Frage nach Verhalten.
      if (m.member_kind === 'field') continue;
      const list = members.get(id) || [];
      const sigs = signatures.get(id) || [];
      if (list.length >= MAX_MEMBERS) continue;
      const params = safeJson<Array<{ name?: string; type?: string }>>(m.parameters, []) || [];
      const paramText = params.map((p) => `${p.type || ''} ${p.name || ''}`.trim()).join(', ');
      list.push({ name: m.method_name, line: m.start_line ?? null });
      // Die KI-Zusammenfassung sagt mehr als der Javadoc; ohne beides bleibt die nackte Signatur.
      const doc = (m.ai_summary || m.javadoc || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      sigs.push(
        `- ${m.return_type || 'void'} ${m.method_name}(${paramText})` +
          (m.start_line ? ` [line ${m.start_line}]` : '') +
          (doc ? ` — ${doc}` : ''),
      );
      members.set(id, list);
      signatures.set(id, sigs);
    }

    return hits
      .filter((h) => byId.has(h.fileId))
      .map((h) => {
        const r = byId.get(h.fileId);
        return {
          fileId: h.fileId,
          className: r.class_name,
          package: r.package || '',
          type: r.stereotype || r.class_type || 'class',
          score: h.score,
          classLine: r.class_line ?? null,
          members: members.get(h.fileId) || [],
          // Nicht Teil des Client-Contracts, nur fuer den Prompt unten.
          _text: this.blockFor(r, signatures.get(h.fileId) || []),
        } as AskSource & { _text: string };
      });
  }

  /** Ein Quellenblock im Prompt. Gekuerzt wird hinten -- die Mitgliederliste sagt am wenigsten. */
  private blockFor(row: any, signatures: string[]): string {
    const fqn = row.package ? `${row.package}.${row.class_name}` : row.class_name;
    const kind = row.stereotype || row.class_type || 'class';
    const desc = (row.description || '').replace(/\s+/g, ' ').trim();
    const head = `### ${row.class_name} (${kind}, ${fqn})`;
    const body = [desc, signatures.length ? signatures.join('\n') : ''].filter(Boolean).join('\n');
    return `${head}\n${body}`.slice(0, MAX_CLASS_CHARS);
  }

  // --- Lauf --------------------------------------------------------------------------------------

  /**
   * Frage starten. Antwortet sofort (202) -- Quellen und Text laufen ueber den SSE-Strom.
   *
   * Die Retrieval-Phase steckt bewusst IM Lauf und nicht in einem eigenen Request: sie kostet einen
   * Ollama-Aufruf (Frage einbetten), und zwei Requests koennten zwei Staende sehen. Der Client
   * erfaehrt ueber `searching`, dass gerade gesucht wird.
   */
  async start(body: any): Promise<any> {
    const jobId = String(body?.jobId || '').trim();
    if (!jobId) throw new BadRequestException('jobId is required');
    const question = String(body?.question || '').trim();
    if (!question) throw new BadRequestException('Ask a question first');
    if (this.runs.get(jobId) && !this.runs.get(jobId)!.done) {
      throw new BadRequestException('This question is already in flight');
    }

    const cfg = await this.settings.bot();
    const controller = new AbortController();
    const run: AskRun = {
      controller,
      question,
      sources: [],
      text: '',
      tokenCount: 0,
      startedAt: Date.now(),
      done: false,
    };
    this.runs.set(jobId, run);
    clearTimeout(this.timers.get(jobId));

    // Bewusst NICHT awaited: der Aufruf antwortet sofort, der Lauf schreibt in den Strom weiter.
    void this.run(jobId, run, question, cfg);
    return { jobId, model: cfg.model };
  }

  private async run(jobId: string, run: AskRun, question: string, cfg: any): Promise<void> {
    try {
      this.emit(jobId, { phase: 'searching', question });

      const found = await this.embeddings.search(question, MAX_CLASSES);
      if (!found.results?.length) {
        // ⚠️ Jeder Grund hat einen eigenen naechsten Schritt (Modell setzen, Index bauen, Ollama
        // starten) -- deshalb geht er maschinenlesbar raus und nicht als ein Satz fuer alle vier.
        run.done = true;
        this.emit(jobId, {
          phase: 'done',
          sources: [],
          reason: found.reason || 'no-match',
          text: '',
          elapsedMs: Date.now() - run.startedAt,
        });
        return;
      }

      const withText = (await this.loadSources(
        found.results.map((r: any) => ({ fileId: r.fileId, score: r.score })),
      )) as Array<AskSource & { _text: string }>;

      // Der Client-Contract traegt `_text` nicht: es ist Prompt-Material, keine Anzeige.
      run.sources = withText.map(({ _text, ...rest }) => rest);
      if (!run.sources.length) {
        run.done = true;
        this.emit(jobId, {
          phase: 'done',
          sources: [],
          reason: 'no-match',
          text: '',
          elapsedMs: Date.now() - run.startedAt,
        });
        return;
      }
      this.emit(jobId, { phase: 'sources', sources: run.sources, question });

      // Gesamtdeckel: lieber eine Klasse weniger als eine Frage, die das Fenster nicht mehr sieht.
      const blocks: string[] = [];
      let budget = MAX_TOTAL_CHARS;
      for (const s of withText) {
        if (budget - s._text.length < 0) break;
        blocks.push(s._text);
        budget -= s._text.length;
      }

      const prompt = renderPrompt(cfg.prompts.ask, {
        context: this.ollama.contextBlock(cfg),
        question,
        sources: blocks.join('\n\n'),
      });

      this.emit(jobId, { phase: 'start', model: cfg.model, sources: run.sources });

      const result = await this.ollama.generate({
        prompt,
        signal: run.controller.signal,
        onToken: (delta) => {
          run.tokenCount++;
          run.text = (run.text + delta).slice(-ANSWER_CAP);
          this.emit(jobId, { phase: 'token', delta });
        },
      });

      if (run.done) return; // zwischenzeitlich abgebrochen -> `done` steht bereits im Strom
      run.done = true;
      if (result.error && !result.text) {
        this.emit(jobId, { phase: 'error', error: result.error, sources: run.sources });
        return;
      }
      this.emit(jobId, {
        phase: 'done',
        text: result.text || run.text,
        sources: run.sources,
        tokenCount: run.tokenCount,
        elapsedMs: Date.now() - run.startedAt,
        stats: result.stats,
      });
    } catch (err: any) {
      run.done = true;
      this.logger.warn(`Ask fehlgeschlagen: ${err?.message || err}`);
      this.emit(jobId, { phase: 'error', error: err?.message || String(err), sources: run.sources });
    }
  }

  cancel(jobId: string): void {
    const run = this.runs.get(jobId);
    if (!run || run.done) return;
    run.done = true;
    run.controller.abort();
    this.emit(jobId, {
      phase: 'done',
      text: run.text,
      sources: run.sources,
      tokenCount: run.tokenCount,
      elapsedMs: Date.now() - run.startedAt,
    });
  }
}
