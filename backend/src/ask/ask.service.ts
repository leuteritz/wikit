import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMPTY, Observable, Subject, concat, interval, map, merge, of } from 'rxjs';
import { renderPrompt } from '../common/bot-config';
import { OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';
import { safeJson } from '../common/json.util';
import { JavaEmbeddingsService } from '../java/java-embeddings.service';
import { ArticleEmbeddingsService } from '../articles/article-embeddings.service';
import { applyCutoff, embedQuery } from '../common/embedding.util';

/**
 * „Ask your project" (`/ask`): eine Frage in Prosa, eine belegte Antwort.
 *
 * Die Bedeutungssuche beantwortet „welche Klasse kuemmert sich darum?" mit einer Liste. Diese
 * Ansicht beantwortet dieselbe Frage mit einem Satz -- und genau deshalb ist sie ohne Belege
 * wertlos: eine Trefferliste kann man nachsehen, einen Fliesstext nicht. Vier Festlegungen:
 *
 * 1. **Retrieval schlaegt Gedaechtnis.** Das Modell bekommt ausschliesslich die abgerufenen
 *    Quellen und die Anweisung, nichts anderes zu verwenden. Ein Sprachmodell kennt „OrderService"
 *    aus tausend fremden Projekten -- ohne diese Schranke antwortet es ueber die falsche Codebasis.
 * 2. **Die Quellen gehen VOR dem ersten Token raus** (`sources`-Event). Wer die Frage stellt, sieht
 *    sofort, worauf die Antwort sich stuetzen wird -- und erkennt eine falsche Auswahl, bevor er
 *    einen Text liest, der auf ihr aufbaut. Die Antwort danach ist nur noch die Zusammenfassung.
 * 3. **Ohne Index gibt es keine Antwort, sondern einen Grund.** Kein Embedding-Modell, kein
 *    Index, Ollama weg -- jedes davon ist eine eigene Auskunft mit einem eigenen naechsten
 *    Schritt. Eine leere Antwort „weiss ich nicht" waere die Behauptung, die Codebasis gebe
 *    nichts her.
 * 4. ⚠️ **Gefragt werden BEIDE Wissensspeicher dieses Wikis, Klassen und Artikel.** Der Code sagt,
 *    WAS passiert; der Artikel sagt, WARUM -- und „warum laeuft der Import zweistufig?" hat im
 *    Quelltext keine Antwort. Nur die Klassen zu fragen hiess, auf so eine Frage „nichts gefunden"
 *    zu melden: eine Aussage ueber die Auswahl der Quellen, die sich wie eine ueber das Projekt
 *    liest. Gemischt wird in EINE Rangliste (s. `retrieve`), nicht in zwei Abschnitte -- welche
 *    Herkunft eine Frage beantwortet, entscheidet die Frage und nicht die Ansicht.
 */

// Wie viele Quellen in den Prompt wandern -- Klassen und Artikel ZUSAMMEN. Der relative Schnitt
// entscheidet zuerst, das hier ist der Deckel darueber. Mehr als eine Handvoll passt auf einem Pi
// (qwen2.5-coder:3b, kleines Fenster) ohnehin nicht sinnvoll hinein, und ab einer gewissen Menge
// verduennt jede weitere Quelle die relevanten.
//
// ⚠️ Bewusst KEINE Quote je Herkunft („mindestens 2 Klassen"). Eine Quote waere die Behauptung, die
// Ansicht wisse besser als die Frage, woher die Antwort kommen sollte -- und bei einer reinen
// Warum-Frage draengte sie eine Klasse hinein, die nichts beitraegt.
const MAX_SOURCES = 6;
// Obergrenze je Quelle und insgesamt. Gekuerzt wird an der Stelle, die am wenigsten aussagt (die
// Mitgliederliste bzw. das Ende des Fliesstextes) -- ein am Fensterende abgeschnittener Prompt
// verliert dagegen genau das, was das Modell zuletzt gelesen haette: die Frage.
const MAX_SOURCE_CHARS = 1400;
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

/**
 * Eine Quelle, aus der die Antwort entsteht.
 *
 * ⚠️ `kind` ist das erste Feld und nicht ableitbar aus den anderen: der Client gruppiert danach,
 * und vor allem entscheidet es das SPRUNGZIEL eines Belegs -- eine Klasse wird in `/code` an einer
 * Zeile aufgeschlagen, ein Artikel unter seinem Slug geoeffnet. Aus `fileId != null` zu schliessen
 * waere dieselbe Auskunft als Nebenwirkung eines anderen Feldes.
 */
export type AskSource =
  | {
      kind: 'class';
      score: number;
      fileId: number;
      className: string;
      package: string;
      type: string;
      classLine: number | null;
      members: AskSourceMember[];
    }
  | {
      kind: 'article';
      score: number;
      articleId: number;
      slug: string;
      title: string;
      category: string;
    };

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
    private readonly articleEmbeddings: ArticleEmbeddingsService,
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
   * Die Frage einmal einbetten und BEIDE Indizes damit bewerten.
   *
   * Drei Festlegungen:
   *
   * 1. ⚠️ **Die Frage wird EINMAL eingebettet**, nicht je Index. Das ist der einzige Ollama-Aufruf
   *    der Retrieval-Phase; zweimal zu fragen kostete das Doppelte fuer denselben Vektor -- und auf
   *    einem Pi ist genau dieser Aufruf die spuerbare Wartezeit vor der Antwort.
   * 2. ⚠️ **Der relative Schnitt faellt ueber die VEREINIGUNG**, nicht je Herkunft (`applyCutoff`
   *    auf der gemischten Liste). Je Seite zu schneiden waeren zwei Latten: der beste Artikel kaeme
   *    dann neben die beste Klasse, auch wenn er deutlich schlechter passt. Genau deshalb geben die
   *    beiden Dienste ungeschnitten zurueck.
   * 3. **Jeder Grund ist eine eigene Auskunft.** „Nichts indiziert" heisst Index bauen, „nichts
   *    passt" heisst anders fragen -- und beide sehen als leere Liste gleich aus. Deshalb faehrt
   *    `indexed` aus den Diensten mit, statt aus einer leeren Trefferliste geraten zu werden.
   */
  private async retrieve(question: string, model: string): Promise<{
    hits: Array<{ kind: 'class' | 'article'; id: number; score: number }>;
    reason?: string;
  }> {
    const [classCount, articleCount] = await Promise.all([
      this.embeddings.indexedCount(),
      this.articleEmbeddings.indexedCount(),
    ]);
    if (!classCount && !articleCount) return { hits: [], reason: 'not-indexed' };

    const qv = await embedQuery(this.ollama, model, question);
    if (!qv) return { hits: [], reason: 'unavailable' };

    const [fromCode, fromWiki] = await Promise.all([
      this.embeddings.scoreAll(qv),
      this.articleEmbeddings.scoreAll(qv),
    ]);
    const merged = [
      ...fromCode.scored.map((s) => ({ kind: 'class' as const, id: s.id, score: s.score })),
      ...fromWiki.scored.map((s) => ({ kind: 'article' as const, id: s.id, score: s.score })),
    ].sort((a, b) => b.score - a.score);

    const top = applyCutoff(merged, MAX_SOURCES);
    if (!top.length) return { hits: [], reason: 'no-match' };
    return { hits: top };
  }

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
  private async loadClassSources(hits: Array<{ fileId: number; score: number }>): Promise<AskSource[]> {
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
          kind: 'class',
          fileId: h.fileId,
          className: r.class_name,
          package: r.package || '',
          type: r.stereotype || r.class_type || 'class',
          score: h.score,
          classLine: r.class_line ?? null,
          members: members.get(h.fileId) || [],
          // Nicht Teil des Client-Contracts, nur fuer den Prompt unten.
          _text: this.classBlock(r, signatures.get(h.fileId) || []),
        } as AskSource & { _text: string };
      });
  }

  /**
   * Die abgerufenen Artikel -- Titel, Kategorie und der entschlackte Fliesstext.
   *
   * ⚠️ Aufbereitet wird mit `plainText` des Embeddings-Dienstes, also mit GENAU dem Text, der auch
   * eingebettet wurde. Eine zweite Aufbereitung hier hiesse, dass die Auswahl auf einem anderen
   * Text beruht als die Antwort -- und dann waere ein Treffer erklaerbar, dessen Begruendung im
   * Prompt gar nicht mehr steht.
   */
  private async loadArticleSources(hits: Array<{ articleId: number; score: number }>): Promise<AskSource[]> {
    if (!hits.length) return [];
    const ids = hits.map((h) => h.articleId);
    const rows = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.summary, a.content, c.name AS category
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE a.id IN (${ids.join(',')})`,
    );
    const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));

    return hits
      .filter((h) => byId.has(h.articleId))
      .map((h) => {
        const r = byId.get(h.articleId);
        return {
          kind: 'article',
          articleId: h.articleId,
          slug: r.slug,
          title: r.title,
          category: r.category || '',
          score: h.score,
          _text: this.articleBlock(r),
        } as AskSource & { _text: string };
      });
  }

  /** Ein Klassenblock im Prompt. Gekuerzt wird hinten -- die Mitgliederliste sagt am wenigsten. */
  private classBlock(row: any, signatures: string[]): string {
    const fqn = row.package ? `${row.package}.${row.class_name}` : row.class_name;
    const kind = row.stereotype || row.class_type || 'class';
    const desc = (row.description || '').replace(/\s+/g, ' ').trim();
    const head = `### ${row.class_name} (${kind}, ${fqn})`;
    const body = [desc, signatures.length ? signatures.join('\n') : ''].filter(Boolean).join('\n');
    return `${head}\n${body}`.slice(0, MAX_SOURCE_CHARS);
  }

  /**
   * Ein Artikelblock im Prompt.
   *
   * ⚠️ Der SLUG steht in der Kopfzeile, und zwar als fertiges Zitat. Ein Klassenname laesst sich
   * aus dem Block ablesen, ein Slug nicht: „Why the import runs in two passes" gibt
   * `import-two-passes` nicht her. Ohne die Zeile raet das Modell einen Slug, der Client loest ihn
   * nicht auf, und der Artikel steht als Quelle da, ohne dass ein einziger Satz auf ihn zeigt.
   */
  private articleBlock(row: any): string {
    const head = `### ${row.title} (wiki article${row.category ? `, ${row.category}` : ''}) — cite as [wiki:${row.slug}]`;
    const body = [
      (row.summary || '').replace(/\s+/g, ' ').trim(),
      this.articleEmbeddings.plainText(row.content),
    ]
      .filter(Boolean)
      .join('\n');
    return `${head}\n${body}`.slice(0, MAX_SOURCE_CHARS);
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

      // ⚠️ Jeder Grund hat einen eigenen naechsten Schritt (Modell setzen, Index bauen, Ollama
      // starten, anders fragen) -- deshalb geht er maschinenlesbar raus und nicht als ein Satz fuer
      // alle vier. `disabled` faellt schon hier: ohne Modell gibt es nicht einmal eine Suche.
      const model = cfg.embedModel || '';
      const { hits, reason } = model
        ? await this.retrieve(question, model)
        : { hits: [] as Array<{ kind: 'class' | 'article'; id: number; score: number }>, reason: 'disabled' };

      if (!hits.length) {
        run.done = true;
        this.emit(jobId, {
          phase: 'done',
          sources: [],
          reason: reason || 'no-match',
          text: '',
          elapsedMs: Date.now() - run.startedAt,
        });
        return;
      }

      // Beide Herkuenfte laden und wieder in die gemischte Rangfolge bringen: die Reihenfolge ist
      // die Aussage der Suche, und sie bestimmt hier zugleich die Quellenkarte und den Prompt.
      const [classes, articles] = await Promise.all([
        this.loadClassSources(
          hits.filter((h) => h.kind === 'class').map((h) => ({ fileId: h.id, score: h.score })),
        ),
        this.loadArticleSources(
          hits.filter((h) => h.kind === 'article').map((h) => ({ articleId: h.id, score: h.score })),
        ),
      ]);
      const withText = [...classes, ...articles].sort((a, b) => b.score - a.score) as Array<
        AskSource & { _text: string }
      >;

      // Der Client-Contract traegt `_text` nicht: es ist Prompt-Material, keine Anzeige.
      run.sources = withText.map(({ _text, ...rest }) => rest as AskSource);
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

      // Gesamtdeckel: lieber eine Quelle weniger als eine Frage, die das Fenster nicht mehr sieht.
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
