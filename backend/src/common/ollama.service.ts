import { Injectable, Logger } from '@nestjs/common';

// Lokaler KI-Client gegen Ollama (kostenlos, kein API-Key, Raspberry-Pi-tauglich).
// Bewusst async + mit hartem Timeout: ist Ollama nicht erreichbar, faellt der Aufrufer
// sauber auf Javadoc/leeren String zurueck statt zu blockieren. 1:1 aus backend/ollama.js.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:3b';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000);

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

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);

  // Baut eine knappe Methoden-Signatur fuer den Prompt-Kontext.
  private signature(className: string, method: MethodInput): string {
    const params = (method.parameters || []).map((p) => `${p.type} ${p.name}`.trim()).join(', ');
    return `${method.return_type || 'void'} ${className}.${method.method_name}(${params})`;
  }

  // Optionaler Projekt-/Wissens-Kontext (z. B. Windchill) wird VOR den Code gestellt.
  private contextBlock(context?: string): string {
    const c = (context || '').trim();
    return c ? `Projekt-Kontext (beachten, aber nicht woertlich wiederholen):\n${c}\n\n` : '';
  }

  // Generischer, abgesicherter Aufruf an Ollama. Liefert '' bei Timeout/Fehler/Down.
  // Ein optionales externes `signal` (z. B. Cancel aus der Analyse-Queue) bricht den
  // laufenden fetch ab. Fehlerursachen werden geloggt (vorher still verschluckt), die
  // Rueckgabe bleibt aber '' -> die Fallback-Kette beim Aufrufer aendert sich nicht.
  private async run(prompt: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Ollama HTTP ${res.status} ${res.statusText} (${OLLAMA_URL})`);
        return '';
      }
      const data: any = await res.json();
      return (data.response || '').trim();
    } catch (err: any) {
      if (timedOut) this.logger.warn(`Ollama Timeout nach ${TIMEOUT_MS}ms (${OLLAMA_URL})`);
      else if (signal?.aborted) this.logger.debug('Ollama-Aufruf abgebrochen (Cancel)');
      else this.logger.warn(`Ollama nicht erreichbar: ${err?.message || err} (${OLLAMA_URL})`);
      // Fallback beim Aufrufer.
      return '';
    } finally {
      clearTimeout(timer);
    }
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
    const sig = this.signature(className, method);
    const javadoc = method.javadoc ? `\nVorhandener Javadoc:\n${method.javadoc}` : '';
    const prompt =
      this.contextBlock(context) +
      `Du dokumentierst Java-Code fuer ein Wiki. Beschreibe die folgende Methode in maximal ` +
      `drei kurzen Saetzen: was sie tut, die Bedeutung der Parameter und moegliche Ausnahmen. ` +
      `Antworte nur mit der Beschreibung, ohne Code.\n\nSignatur:\n${sig}${javadoc}`;
    return this.run(prompt);
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
  ): Promise<string> {
    const sig = this.signature(className, method);
    const javadoc = method.javadoc ? `\nVorhandener Javadoc:\n${method.javadoc}` : '';
    const body = (method.body || '').trim();
    const bodyBlock = body ? `\n\nImplementierung:\n\`\`\`java\n${body}\n\`\`\`` : '';
    const prompt =
      this.contextBlock(context) +
      `Du dokumentierst Java-Code fuer ein technisches Wiki. Beschreibe die folgende Methode ` +
      `praegnant (2-4 Saetze): Zweck, wichtige Parameter, Rueckgabe und nennenswerte Seiteneffekte ` +
      `oder Ausnahmen. Nutze bei Bedarf kurze Markdown-Formatierung (z. B. \`code\`), aber keinen ` +
      `kompletten Code-Block. Antworte nur mit der Beschreibung.\n\nSignatur:\n${sig}${javadoc}${bodyBlock}`;
    return this.run(prompt, signal);
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
  ): Promise<string> {
    const fqn = classInfo.package ? `${classInfo.package}.${classInfo.class_name}` : classInfo.class_name;
    const methodList = (classInfo.methods || []).map((m) => m.method_name).join(', ');
    const prompt =
      this.contextBlock(context) +
      `Du dokumentierst eine Java-${classInfo.class_type || 'class'} fuer ein technisches Wiki. ` +
      `Beschreibe in 2-4 Saetzen die Verantwortlichkeit und den Zweck dieser Klasse. Antworte nur ` +
      `mit der Beschreibung (Markdown erlaubt), ohne Methoden einzeln aufzuzaehlen.\n\n` +
      `Klasse: ${fqn} (${classInfo.class_type || 'class'})\n` +
      (methodList ? `Methoden: ${methodList}` : '');
    return this.run(prompt, signal);
  }
}
