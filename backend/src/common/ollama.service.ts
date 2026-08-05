import { Injectable, Logger } from '@nestjs/common';
import { BotConfig, languageInstruction, ollamaOptions, renderPrompt } from './bot-config';
import { SettingsService } from './settings.service';

// Lokaler KI-Client gegen Ollama (kostenlos, kein API-Key, Raspberry-Pi-tauglich).
// Bewusst async + mit hartem Timeout: ist Ollama nicht erreichbar, faellt der Aufrufer
// sauber auf Javadoc/leeren String zurueck statt zu blockieren.
//
// Host, Modell, Timeout, Generierungsparameter und die vier Prompt-Vorlagen kommen zur LAUFZEIT
// aus dem SettingsService (Bot-Bereich unter /bot) -- frueher waren es Modul-Konstanten aus der
// Env, also nur mit einem Server-Neustart zu aendern. Env bleibt der Default: wer nichts
// einstellt, laeuft weiter mit OLLAMA_URL/OLLAMA_MODEL/OLLAMA_TIMEOUT_MS.

interface MethodInput {
  method_name: string;
  return_type?: string | null;
  parameters?: Array<{ type: string; name: string }>;
  javadoc?: string | null;
  body?: string | null;
}

interface ClassInput {
  class_name: string;
  class_type?: string | null;
  package?: string | null;
  methods?: Array<{ method_name: string }>;
}

/** Was Ollama im abschliessenden NDJSON-Chunk ueber den Lauf berichtet (fuer den Playground). */
export interface GenerateStats {
  totalDurationMs: number;
  loadDurationMs: number;
  promptEvalCount: number;
  evalCount: number;
  evalDurationMs: number;
  tokensPerSecond: number;
}

export interface GenerateResult {
  text: string;
  stats: GenerateStats | null;
  /** Klartext-Grund bei Timeout/Nichterreichbarkeit. Die Doku-Pfade ignorieren ihn (Fallback-Kette). */
  error: string | null;
}

/** Overrides fuer einen einzelnen Aufruf -- der Playground testet Werte, BEVOR sie gespeichert sind. */
export interface GenerateOverrides {
  host?: string;
  model?: string;
  timeoutMs?: number;
  options?: Record<string, number>;
}

const ns = (v: any): number => (Number.isFinite(Number(v)) ? Number(v) / 1e6 : 0);

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);

  constructor(private readonly settings: SettingsService) {}

  private generateUrl(host: string): string {
    return `${(host || '').replace(/\/+$/, '')}/api/generate`;
  }

  // Baut eine knappe Methoden-Signatur fuer den Prompt-Kontext.
  private signature(className: string, method: MethodInput): string {
    const params = (method.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ');
    return `${method.return_type || 'void'} ${className}.${method.method_name}(${params})`;
  }

  // Projekt-/Wissens-Kontext fuer den {context}-Platzhalter. Zwei Quellen: der dauerhaft
  // gespeicherte Projekt-Kontext (Bot-Bereich) und der Kontext dieses Laufs (RAG-Wissen +
  // das Feld im Add-Code-Modal). Der gespeicherte steht vorn -- es sei denn, er steckt bereits
  // im uebergebenen Text, sonst stuende er bei einem vorbelegten Feld zweimal im Prompt.
  private contextBlock(cfg: BotConfig, context?: string): string {
    const runtime = (context || '').trim();
    const stored = (cfg.projectContext || '').trim();
    const parts: string[] = [];
    if (stored && !runtime.includes(stored)) parts.push(stored);
    if (runtime) parts.push(runtime);
    const c = parts.join('\n\n');
    return c ? `Projekt-Kontext (beachten, aber nicht woertlich wiederholen):\n${c}\n\n` : '';
  }

  // Die Sprachanweisung haengt IMMER hinten an, unabhaengig von der Vorlage: wer sein Template
  // umschreibt, soll die Sprache trotzdem ueber den Schalter steuern koennen.
  private withLanguage(cfg: BotConfig, prompt: string): string {
    return `${prompt}\n\n${languageInstruction(cfg.language)}`;
  }

  private stats(chunk: any): GenerateStats | null {
    if (!chunk) return null;
    const evalCount = Number(chunk.eval_count || 0);
    const evalDurationMs = ns(chunk.eval_duration);
    return {
      totalDurationMs: Math.round(ns(chunk.total_duration)),
      loadDurationMs: Math.round(ns(chunk.load_duration)),
      promptEvalCount: Number(chunk.prompt_eval_count || 0),
      evalCount,
      evalDurationMs: Math.round(evalDurationMs),
      tokensPerSecond: evalDurationMs > 0 ? Number((evalCount / (evalDurationMs / 1000)).toFixed(2)) : 0,
    };
  }

  // Token-Streaming-Variante: ruft Ollama mit `stream: true` auf und liefert pro Chunk den
  // Delta-Text an `onToken` (fuer die Live-Anzeige in der KI-Queue).
  //
  // Wichtig: KEIN harter Gesamt-Timeout (eine lange Generierung wuerde sonst abgeschnitten),
  // sondern ein IDLE-Timeout, das pro empfangenem Chunk zurueckgesetzt wird. Externes `signal`
  // (z. B. Cancel aus der Queue) bricht den Stream ebenfalls ab.
  private async runStream(
    cfg: BotConfig,
    prompt: string,
    onToken: (delta: string) => void,
    signal?: AbortSignal,
    overrides?: GenerateOverrides,
  ): Promise<GenerateResult> {
    const url = this.generateUrl(overrides?.host || cfg.host);
    const model = overrides?.model || cfg.model;
    const timeoutMs = overrides?.timeoutMs || cfg.timeoutMs;
    const options = overrides?.options ?? ollamaOptions(cfg);

    const controller = new AbortController();
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    };
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    resetIdle();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: true, ...(options ? { options } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        const reason = `HTTP ${res.status} ${res.statusText}${detail ? ` – ${detail.slice(0, 200)}` : ''}`;
        this.logger.warn(`Ollama ${reason} (${url})`);
        return { text: '', stats: null, error: reason };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let buffer = '';
      let final: any = null;
      // Ollama streamt NDJSON: eine JSON-Zeile pro Token-Chunk ({ response, done }).
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let chunk: any;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue; // unvollstaendige/kaputte Zeile ueberspringen
          }
          const delta: string = chunk.response || '';
          if (delta) {
            full += delta;
            try {
              onToken(delta);
            } catch {
              /* Anzeige-Callback darf den Stream nie kippen */
            }
          }
          if (chunk.done) {
            final = chunk;
            break;
          }
        }
      }
      return { text: full.trim(), stats: this.stats(final), error: null };
    } catch (err: any) {
      const reason = timedOut
        ? `No output for ${timeoutMs} ms – the model may still be loading, or the timeout is too tight`
        : signal?.aborted
          ? 'Cancelled'
          : `Cannot reach Ollama at ${url}: ${err?.message || err}`;
      if (timedOut) this.logger.warn(`Ollama Idle-Timeout nach ${timeoutMs}ms (${url})`);
      else if (signal?.aborted) this.logger.debug('Ollama-Stream abgebrochen (Cancel)');
      else this.logger.warn(`Ollama nicht erreichbar: ${err?.message || err} (${url})`);
      return { text: '', stats: null, error: reason };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  // Generischer, abgesicherter Aufruf an Ollama (nicht gestreamt). Liefert '' bei Timeout/Fehler.
  private async run(
    cfg: BotConfig,
    prompt: string,
    signal?: AbortSignal,
    overrides?: GenerateOverrides,
  ): Promise<GenerateResult> {
    const url = this.generateUrl(overrides?.host || cfg.host);
    const model = overrides?.model || cfg.model;
    const timeoutMs = overrides?.timeoutMs || cfg.timeoutMs;
    const options = overrides?.options ?? ollamaOptions(cfg);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, ...(options ? { options } : {}) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const reason = `HTTP ${res.status} ${res.statusText}${detail ? ` – ${detail.slice(0, 200)}` : ''}`;
        this.logger.warn(`Ollama ${reason} (${url})`);
        return { text: '', stats: null, error: reason };
      }
      const data: any = await res.json();
      return { text: (data.response || '').trim(), stats: this.stats(data), error: null };
    } catch (err: any) {
      const reason = timedOut
        ? `No answer within ${timeoutMs} ms`
        : signal?.aborted
          ? 'Cancelled'
          : `Cannot reach Ollama at ${url}: ${err?.message || err}`;
      if (timedOut) this.logger.warn(`Ollama Timeout nach ${timeoutMs}ms (${url})`);
      else if (signal?.aborted) this.logger.debug('Ollama-Aufruf abgebrochen (Cancel)');
      else this.logger.warn(`Ollama nicht erreichbar: ${err?.message || err} (${url})`);
      // Fallback beim Aufrufer.
      return { text: '', stats: null, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Roher Aufruf mit vollem Ergebnis (Text + Metriken + Fehlergrund). Fuer den Playground im
   * Bot-Bereich: dort ist der Grund einer leeren Antwort die eigentliche Auskunft, waehrend die
   * Doku-Pfade unten nur den Text brauchen und bei '' auf Javadoc zurueckfallen.
   */
  async generate(params: {
    prompt: string;
    onToken?: (delta: string) => void;
    signal?: AbortSignal;
    overrides?: GenerateOverrides;
    /** false = die Sprachanweisung NICHT anhaengen (der Playground schickt den Prompt so, wie er dasteht). */
    withLanguage?: boolean;
  }): Promise<GenerateResult> {
    const cfg = await this.settings.bot();
    const prompt = params.withLanguage === false ? params.prompt : this.withLanguage(cfg, params.prompt);
    return params.onToken
      ? this.runStream(cfg, prompt, params.onToken, params.signal, params.overrides)
      : this.run(cfg, prompt, params.signal, params.overrides);
  }

  /**
   * Vektoren fuer eine Liste von Texten (Bedeutungssuche).
   *
   * Ollama kennt zwei Endpunkte: das aeltere `/api/embeddings` (ein Text, Feld `embedding`) und
   * das neuere `/api/embed` (eine Liste, Feld `embeddings`). Gefragt wird das neuere zuerst –
   * eine Anfrage fuer einen ganzen Stapel statt einer je Klasse ist bei tausend Klassen der
   * Unterschied zwischen Minuten und Sekunden –, und nur bei 404 faellt es auf das alte zurueck.
   *
   * Wie ueberall in diesem Service ist „Ollama antwortet nicht" KEIN Fehler, sondern ein leeres
   * Ergebnis: der Aufrufer laesst den Index dann eben unvollstaendig und schreibt es an.
   *
   * @returns Vektoren in der Reihenfolge der Eingabe, oder `[]`.
   */
  async embed(texts: string[], overrides?: GenerateOverrides): Promise<number[][]> {
    const cfg = await this.settings.bot();
    const model = overrides?.model || cfg.embedModel;
    if (!model || !texts.length) return [];
    const base = (overrides?.host || cfg.host || '').replace(/\/+$/, '');
    const timeoutMs = overrides?.timeoutMs || cfg.timeoutMs;

    const post = async (path: string, body: any): Promise<Response | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const res = await post('/api/embed', { model, input: texts });
    if (res?.ok) {
      const data: any = await res.json().catch(() => null);
      const rows = data?.embeddings;
      if (Array.isArray(rows) && rows.length === texts.length) return rows;
    }
    // Nur bei „Endpunkt gibt es nicht" den alten Weg gehen. Ein 500 bedeutet ein echtes Problem
    // (Modell nicht gepullt) – dieselbe Anfrage einzeln zu wiederholen kostet nur Zeit.
    if (res && res.status !== 404) {
      this.logger.warn(`Ollama embed failed: HTTP ${res.status}`);
      return [];
    }

    const out: number[][] = [];
    for (const text of texts) {
      const old = await post('/api/embeddings', { model, prompt: text });
      if (!old?.ok) return [];
      const data: any = await old.json().catch(() => null);
      if (!Array.isArray(data?.embedding)) return [];
      out.push(data.embedding);
    }
    return out;
  }

  // Erzeugt eine kurze Wiki-Zusammenfassung (max. 3 Saetze) fuer eine Methode (nur Signatur+Javadoc).
  // Liefert '' wenn Ollama nicht erreichbar ist oder ein Fehler/Timeout auftritt.
  async generateSummary({
    className,
    method,
    context,
  }: {
    className: string;
    method: MethodInput;
    context?: string;
  }): Promise<string> {
    const cfg = await this.settings.bot();
    const prompt = renderPrompt(cfg.prompts.methodShort, {
      context: this.contextBlock(cfg, context),
      signature: this.signature(className, method),
      javadoc: method.javadoc ? `\nVorhandener Javadoc:\n${method.javadoc}` : '',
      className,
      methodName: method.method_name,
      returnType: method.return_type || 'void',
    });
    const { text } = await this.run(cfg, this.withLanguage(cfg, prompt));
    return text;
  }

  // Detailliertere Methodenbeschreibung: nutzt zusaetzlich den geparsten Rumpf (body) und darf
  // Markdown verwenden. Fuer die gestreamte Queue-Analyse. '' bei Nichterreichbarkeit.
  async generateMethodDescription(
    {
      className,
      method,
      context,
    }: {
      className: string;
      method: MethodInput;
      context?: string;
    },
    signal?: AbortSignal,
    onToken?: (delta: string) => void,
  ): Promise<string> {
    const cfg = await this.settings.bot();
    const body = (method.body || '').trim();
    const prompt = renderPrompt(cfg.prompts.method, {
      context: this.contextBlock(cfg, context),
      signature: this.signature(className, method),
      javadoc: method.javadoc ? `\nVorhandener Javadoc:\n${method.javadoc}` : '',
      body: body ? `\n\nImplementierung:\n\`\`\`java\n${body}\n\`\`\`` : '',
      className,
      methodName: method.method_name,
      returnType: method.return_type || 'void',
    });
    const full = this.withLanguage(cfg, prompt);
    const res = onToken ? await this.runStream(cfg, full, onToken, signal) : await this.run(cfg, full, signal);
    return res.text;
  }

  // Kurze Klassenbeschreibung (Markdown): Zweck/Verantwortlichkeit der Klasse aus Name, Typ
  // und Methodennamen + optionalem Projekt-Kontext. '' bei Nichterreichbarkeit.
  async generateClassSummary(
    {
      classInfo,
      context,
    }: {
      classInfo: ClassInput;
      context?: string;
    },
    signal?: AbortSignal,
    onToken?: (delta: string) => void,
  ): Promise<string> {
    const cfg = await this.settings.bot();
    const fqn = classInfo.package ? `${classInfo.package}.${classInfo.class_name}` : classInfo.class_name;
    const methodList = (classInfo.methods || []).map((m) => m.method_name).join(', ');
    const prompt = renderPrompt(cfg.prompts.class, {
      context: this.contextBlock(cfg, context),
      fqn,
      className: classInfo.class_name,
      classType: classInfo.class_type || 'class',
      package: classInfo.package || '',
      methods: methodList ? `Methoden: ${methodList}` : '',
    });
    const full = this.withLanguage(cfg, prompt);
    const res = onToken ? await this.runStream(cfg, full, onToken, signal) : await this.run(cfg, full, signal);
    return res.text;
  }

  // Zusammenfassung einer Klassen-Aenderung aus einem Unified-Diff (Changelog-Eintrag).
  // '' bei Nichterreichbarkeit -> Aufrufer laesst ai_summary dann leer (Frontend-Fallback).
  async generateDiffSummary(
    {
      className,
      diff,
      context,
    }: {
      className: string;
      diff: string;
      context?: string;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const cfg = await this.settings.bot();
    const prompt = renderPrompt(cfg.prompts.diff, {
      context: this.contextBlock(cfg, context),
      className,
      diff,
    });
    const { text } = await this.run(cfg, this.withLanguage(cfg, prompt), signal);
    return text;
  }
}
