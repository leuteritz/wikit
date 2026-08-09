import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EMPTY, Observable, Subject, concat, interval, map, merge, of } from 'rxjs';
import {
  BOT_FIELDS,
  BotConfig,
  DEFAULT_PROMPTS,
  PLACEHOLDER_HELP,
  PROMPT_PLACEHOLDERS,
  normalizeHost,
  ollamaOptions,
} from '../common/bot-config';
import { GenerateOverrides, OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';

// Der Bot-Bereich (/bot in der Oberflaeche): Einstellungen lesen/schreiben, Verbindung pruefen,
// den Modellkatalog des Servers zeigen und einen Prompt zur Probe laufen lassen.
//
// Warum ein eigenes Modul und nicht ein paar Endpunkte in java/: Diese Auskuenfte gelten fuer
// JEDEN KI-Pfad (Queue, artikelgebundener Lauf, Changelog) und haengen an keiner Java-Klasse.

// Ein Verbindungstest soll schnell scheitern duerfen -- er sagt "erreichbar?", nicht "schafft das
// Modell eine Antwort?". Der grosszuegige Timeout der Generierung waere hier eine Zumutung.
const PROBE_TIMEOUT_MS = 5000;

// Wie beim Analyse-Fortschritt: der letzte Stand bleibt kurz abrufbar, falls der Client leicht
// verzoegert liest oder die Verbindung neu aufbaut.
const CLEANUP_MS = 30_000;

// Der serverseitig gehaltene Text eines Playground-Laufs (Reconnect-Puffer). Ein Diagnoselauf ist
// kurz -- was darueber hinausgeht, hat der Client bereits als Token erhalten.
const PLAYGROUND_CAP = 20_000;

export interface PlaygroundEvent {
  phase: 'snapshot' | 'start' | 'token' | 'done' | 'error' | 'heartbeat';
  delta?: string;
  text?: string;
  tokenCount?: number;
  elapsedMs?: number;
  stats?: unknown;
  error?: string;
  model?: string;
}

interface PlaygroundRun {
  controller: AbortController;
  text: string;
  tokenCount: number;
  startedAt: number;
  done: boolean;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  private streams = new Map<string, Subject<PlaygroundEvent>>();
  private runs = new Map<string, PlaygroundRun>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly settings: SettingsService,
    private readonly ollama: OllamaService,
  ) {}

  // --- Einstellungen --------------------------------------------------------

  /**
   * Alles, was die Oberflaeche zum Zeichnen des Formulars braucht -- in EINER Antwort: der
   * aufgeloeste Stand, die Defaults (fuer "zuruecksetzen"), welche Felder ueberschrieben sind,
   * und die Feldbeschreibung selbst (Typ, Grenzen, Erklaerung). Letztere mitzuliefern statt sie
   * im Client zu wiederholen ist der Grund, warum Formular und Server nie verschiedene Grenzen
   * kennen koennen.
   */
  async getSettings(): Promise<any> {
    const [config, overrides] = await Promise.all([this.settings.bot(), this.settings.overrides()]);
    return {
      config,
      defaults: this.settings.defaults(),
      overrides,
      fields: BOT_FIELDS,
      placeholders: PROMPT_PLACEHOLDERS,
      placeholderHelp: PLACEHOLDER_HELP,
      defaultPrompts: DEFAULT_PROMPTS,
      // Woher der Default kommt -- damit die Oberflaeche "from OLLAMA_MODEL" schreiben kann statt
      // eines nackten Werts, den niemand einordnet.
      env: {
        host: !!process.env.OLLAMA_URL,
        model: !!process.env.OLLAMA_MODEL,
        timeoutMs: !!process.env.OLLAMA_TIMEOUT_MS,
        embedModel: !!process.env.OLLAMA_EMBED_MODEL,
        embedTimeoutMs: !!process.env.OLLAMA_EMBED_TIMEOUT_MS,
        'wiki.historyKeep': !!process.env.WIKI_HISTORY_KEEP,
      },
    };
  }

  async updateSettings(body: any): Promise<any> {
    await this.settings.patch(body);
    return this.getSettings();
  }

  async resetSettings(paths?: string[]): Promise<any> {
    await this.settings.reset(paths);
    return this.getSettings();
  }

  // --- Verbindung + Modelle -------------------------------------------------

  private async probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Liegt `name` im Katalog? Ollama fuehrt Modelle als name:tag -- wer "qwen2.5-coder" eintraegt,
   * meint ":latest", sonst meldete der Test ein fehlendes Modell, das der Server anstandslos laedt.
   *
   * Eine Funktion, weil sie fuer ZWEI Modelle gilt (Generierung und Embedding). Zweimal
   * hingeschrieben waere die Tag-Regel zweimal zu pflegen.
   */
  private installed(models: any[], name: string): boolean {
    return models.some((m: any) => {
      const n = String(m?.name || m?.model || '');
      return n === name || n === `${name}:latest` || n.split(':')[0] === name;
    });
  }

  /**
   * Verbindungstest: erreichbar?, welche Ollama-Version, wie schnell antwortet der Server, und --
   * die eigentlich wichtige Frage -- sind die eingestellten Modelle dort ueberhaupt installiert.
   * Ein gruener Punkt bei fehlendem Modell waere eine Falschauskunft: die Generierung schluege
   * spaeter mit "model not found" fehl, und zwar erst mitten im Massenlauf.
   *
   * ⚠️ Geprueft werden BEIDE Modelle, und der Katalog dafuer wird ohnehin schon geholt -- das
   * Embedding-Modell kostet also keine zweite Anfrage. Was es nicht tut: den Statuspunkt faerben
   * (s. `useBot().status`). Die Bedeutungssuche ist optional, ein gelber Punkt ueber ein bewusst
   * leer gelassenes Feld waere ein Daueralarm. Die Auskunft gehoert an die Karte, die den
   * Indexlauf ausloest.
   */
  async health(hostParam?: string, modelParam?: string, embedModelParam?: string): Promise<any> {
    const cfg = await this.settings.bot();
    const host = normalizeHost(hostParam || cfg.host);
    const model = (modelParam || cfg.model || '').trim();
    // Leeres Feld heisst „Bedeutungssuche aus" -- dann gibt es nichts zu pruefen und `null` ist die
    // richtige Antwort, nicht `false`.
    const embedModel = (embedModelParam ?? cfg.embedModel ?? '').trim();
    const startedAt = Date.now();
    try {
      const version = await this.probe(`${host}/api/version`);
      const latencyMs = Date.now() - startedAt;
      let models: any[] = [];
      let modelInstalled: boolean | null = null;
      let embedModelInstalled: boolean | null = null;
      try {
        const tags = await this.probe(`${host}/api/tags`);
        models = Array.isArray(tags?.models) ? tags.models : [];
        modelInstalled = this.installed(models, model);
        if (embedModel) embedModelInstalled = this.installed(models, embedModel);
      } catch {
        /* Version steht, Katalog nicht abrufbar -> "unbekannt" statt einer erfundenen Aussage */
      }
      return {
        online: true,
        host,
        model,
        embedModel,
        latencyMs,
        version: version?.version || null,
        modelInstalled,
        embedModelInstalled,
        modelCount: models.length,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      return {
        online: false,
        host,
        model,
        embedModel,
        latencyMs: Date.now() - startedAt,
        version: null,
        modelInstalled: null,
        embedModelInstalled: null,
        modelCount: 0,
        error: aborted
          ? `No answer from ${host} within ${PROBE_TIMEOUT_MS} ms`
          : `Cannot reach ${host}: ${err?.message || err}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** Was per `ollama pull` auf dem Server liegt. Fehler wird als Text geliefert, nicht als Status. */
  async models(hostParam?: string): Promise<any> {
    const cfg = await this.settings.bot();
    const host = normalizeHost(hostParam || cfg.host);
    try {
      const tags = await this.probe(`${host}/api/tags`);
      const models = (Array.isArray(tags?.models) ? tags.models : []).map((m: any) => ({
        name: m?.name || m?.model || '',
        size: Number(m?.size || 0),
        modifiedAt: m?.modified_at || null,
        family: m?.details?.family || null,
        parameterSize: m?.details?.parameter_size || null,
        quantization: m?.details?.quantization_level || null,
      }));
      models.sort((a: any, b: any) => a.name.localeCompare(b.name));
      return { host, models, active: cfg.model, error: null };
    } catch (err: any) {
      return { host, models: [], active: cfg.model, error: `Cannot read the model catalog from ${host}: ${err?.message || err}` };
    }
  }

  // --- Playground -----------------------------------------------------------

  private subject(jobId: string): Subject<PlaygroundEvent> {
    let s = this.streams.get(jobId);
    if (!s) {
      s = new Subject<PlaygroundEvent>();
      this.streams.set(jobId, s);
    }
    return s;
  }

  /**
   * SSE-Strom eines Probelaufs. Beim Verbinden geht zuerst der bisher erzeugte Text raus
   * (`snapshot`) -- der Client oeffnet den Strom zwar vor dem Start, aber ein Reconnect mitten im
   * Lauf soll nicht in einem leeren Feld enden.
   */
  stream(jobId: string): Observable<{ data: PlaygroundEvent }> {
    const subject = this.subject(jobId);
    const run = this.runs.get(jobId);
    const initial: Observable<PlaygroundEvent> = run
      ? of({ phase: 'snapshot' as const, text: run.text, tokenCount: run.tokenCount })
      : EMPTY;
    const heartbeat = interval(15000).pipe(map(() => ({ phase: 'heartbeat' as const })));
    return merge(concat(initial, subject.asObservable()), heartbeat).pipe(map((data) => ({ data })));
  }

  private emit(jobId: string, event: PlaygroundEvent): void {
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

  /**
   * Probelauf starten. Die Antwort kommt sofort (202) -- der Text laeuft ueber den SSE-Strom.
   *
   * Modell, Host, Timeout und die Generierungsparameter duerfen mitgeschickt werden: Sinn der
   * Sache ist, Werte zu pruefen, BEVOR man sie speichert. Ohne diese Uebergabe muesste man erst
   * speichern und damit den naechsten Massenlauf auf ungetestete Werte stellen.
   */
  async startPlayground(body: any): Promise<any> {
    const jobId = String(body?.jobId || '').trim();
    if (!jobId) throw new BadRequestException('jobId is required');
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) throw new BadRequestException('Enter a prompt to run');
    if (this.runs.get(jobId) && !this.runs.get(jobId)!.done) {
      throw new BadRequestException('This run is already in flight');
    }

    const cfg = await this.settings.bot();
    const overrides = this.overridesFrom(body, cfg);
    const controller = new AbortController();
    const run: PlaygroundRun = { controller, text: '', tokenCount: 0, startedAt: Date.now(), done: false };
    this.runs.set(jobId, run);
    clearTimeout(this.timers.get(jobId));

    const model = overrides.model || cfg.model;
    this.emit(jobId, { phase: 'start', model });

    // Bewusst NICHT awaited: der Aufruf antwortet sofort, der Lauf schreibt in den Strom weiter.
    void this.ollama
      .generate({
        prompt,
        signal: controller.signal,
        overrides,
        // Der Playground schickt den Prompt so, wie er im Feld steht -- eine stillschweigend
        // angehaengte Sprachanweisung waere genau der Unterschied, den man hier sucht.
        withLanguage: false,
        onToken: (delta) => {
          run.tokenCount++;
          run.text = (run.text + delta).slice(-PLAYGROUND_CAP);
          this.emit(jobId, { phase: 'token', delta, tokenCount: run.tokenCount });
        },
      })
      .then((res) => {
        run.done = true;
        const elapsedMs = Date.now() - run.startedAt;
        if (res.error && !res.text) {
          this.emit(jobId, { phase: 'error', error: res.error, elapsedMs });
        } else {
          this.emit(jobId, { phase: 'done', text: res.text, stats: res.stats, elapsedMs, tokenCount: run.tokenCount });
        }
      })
      .catch((err) => {
        run.done = true;
        this.logger.warn(`Playground-Lauf fehlgeschlagen: ${err?.message || err}`);
        this.emit(jobId, { phase: 'error', error: String(err?.message || err), elapsedMs: Date.now() - run.startedAt });
      });

    return { jobId, model, host: overrides.host || cfg.host };
  }

  cancelPlayground(jobId: string): void {
    const run = this.runs.get(jobId);
    if (!run || run.done) return;
    run.done = true;
    run.controller.abort();
    this.emit(jobId, {
      phase: 'done',
      text: run.text,
      tokenCount: run.tokenCount,
      elapsedMs: Date.now() - run.startedAt,
    });
  }

  /**
   * Overrides eines Probelaufs aus dem Request-Body. `options` wird nur uebernommen, wenn das
   * Formular tatsaechlich Parameter mitschickt -- sonst gilt die gespeicherte Einstellung, und
   * ein leeres Objekt haette Ollama sonst alle Defaults ueberschreiben lassen.
   */
  private overridesFrom(body: any, cfg: BotConfig): GenerateOverrides {
    const overrides: GenerateOverrides = {};
    if (body?.host) overrides.host = normalizeHost(String(body.host));
    if (body?.model) overrides.model = String(body.model).trim();
    if (Number.isFinite(Number(body?.timeoutMs))) overrides.timeoutMs = Number(body.timeoutMs);
    if (body?.options && typeof body.options === 'object') {
      const o: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.options)) {
        if (v != null && Number.isFinite(Number(v))) o[k] = Number(v);
      }
      overrides.options = Object.keys(o).length ? o : undefined;
    } else {
      overrides.options = ollamaOptions(cfg);
    }
    return overrides;
  }
}
