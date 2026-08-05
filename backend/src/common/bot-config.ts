// Die eine Beschreibung dessen, was am Bot einstellbar ist: Typ, Grenzen, Default und Bedeutung.
//
// Warum an EINER Stelle: Aus dieser Liste zieht der SettingsService seine Validierung, der
// Bot-Controller liefert sie als Teil von GET /api/bot/settings aus, und die Oberflaeche baut ihre
// Eingabefelder (min/max/step/Auswahl) daraus. Lagen die Grenzen doppelt vor, wuerde das Formular
// irgendwann etwas anbieten, das der Server ablehnt.
//
// Env bleibt der Default, die DB ist der Override: OLLAMA_URL/OLLAMA_MODEL/OLLAMA_TIMEOUT_MS wirken
// unveraendert weiter, solange niemand das Feld in der Oberflaeche anfasst. Wer es zuruecksetzt,
// loescht die Zeile -- und damit gilt wieder, was in der Env steht (s. DDL-Kommentar zu `settings`).

export interface BotPrompts {
  /** Methodenbeschreibung mit Rumpf (Queue + artikelgebundener Lauf). */
  method: string;
  /** Kurzfassung ohne Rumpf (POST /api/java/methods/:id/summarize). */
  methodShort: string;
  /** Klassenbeschreibung. */
  class: string;
  /** Changelog-Eintrag aus einem Unified-Diff. */
  diff: string;
}

export interface BotQueueConfig {
  /** Gleichzeitig laufende Klassen-Einheiten. 1 = das bisherige, strikt sequentielle Verhalten. */
  concurrency: number;
  /** Wiederholungen, wenn Ollama nichts liefert (Timeout/nicht erreichbar). 0 = keine. */
  retries: number;
  /** Wartezeit vor einem Wiederholungsversuch. */
  retryDelayMs: number;
}

export interface BotConfig {
  /** Basis-URL des Ollama-Servers OHNE Pfad, z. B. http://localhost:11434 */
  host: string;
  model: string;
  /**
   * Modell fuer die BEDEUTUNGS-Suche (Embeddings). Getrennt vom Textmodell, weil es ein anderes
   * Werkzeug ist: ein Generierungsmodell erzeugt keine brauchbaren Vektoren, und ein
   * Embedding-Modell erzeugt keinen Text. Leerer String = Bedeutungssuche aus.
   */
  embedModel: string;
  timeoutMs: number;
  temperature: number | null;
  topP: number | null;
  numCtx: number | null;
  numPredict: number | null;
  seed: number | null;
  language: 'de' | 'en';
  /** Projekt-/Domaenenwissen, das in JEDEN Prompt einfliesst (frueher nur im Browser-Speicher). */
  projectContext: string;
  prompts: BotPrompts;
  queue: BotQueueConfig;
}

export type BotFieldType = 'string' | 'text' | 'int' | 'float' | 'enum';

export interface BotFieldSpec {
  /** Pfad im BotConfig-Objekt, z. B. 'prompts.method'. Zugleich der DB-Key ('bot.prompts.method'). */
  path: string;
  type: BotFieldType;
  min?: number;
  max?: number;
  step?: number;
  values?: string[];
  /** null zulaessig = "Ollama entscheidet" (die Option wird dann gar nicht mitgeschickt). */
  nullable?: boolean;
  /** Darf der Wert leer sein? Nur fuer Freitext (Projekt-Kontext). */
  allowEmpty?: boolean;
  label: string;
  hint: string;
  /** Gruppe fuer die Oberflaeche. */
  group: 'connection' | 'generation' | 'prompts' | 'queue' | 'context';
}

// Die vier Vorlagen. Sie sind WORTGLEICH die bisher hart im OllamaService stehenden Prompts --
// wer nichts anfasst, bekommt exakt dieselben Beschreibungen wie vorher. Platzhalter in
// geschweiften Klammern werden vor dem Absenden ersetzt (renderPrompt); ein unbekannter Name
// bleibt stehen, damit ein Vertipper sichtbar ist statt still zu verschwinden.
export const DEFAULT_PROMPTS: BotPrompts = {
  method: `{context}Du dokumentierst Java-Code fuer ein technisches Wiki. Beschreibe die folgende Methode praegnant (2-4 Saetze): Zweck, wichtige Parameter, Rueckgabe und nennenswerte Seiteneffekte oder Ausnahmen. Nutze bei Bedarf kurze Markdown-Formatierung (z. B. \`code\`), aber keinen kompletten Code-Block. Antworte nur mit der Beschreibung.

Signatur:
{signature}{javadoc}{body}`,

  methodShort: `{context}Du dokumentierst Java-Code fuer ein Wiki. Beschreibe die folgende Methode in maximal drei kurzen Saetzen: was sie tut, die Bedeutung der Parameter und moegliche Ausnahmen. Antworte nur mit der Beschreibung, ohne Code.

Signatur:
{signature}{javadoc}`,

  class: `{context}Du dokumentierst eine Java-{classType} fuer ein technisches Wiki. Beschreibe in 2-4 Saetzen die Verantwortlichkeit und den Zweck dieser Klasse. Antworte nur mit der Beschreibung (Markdown erlaubt), ohne Methoden einzeln aufzuzaehlen.

Klasse: {fqn} ({classType})
{methods}`,

  diff: `{context}Du dokumentierst Aenderungen an Java-Code fuer ein technisches Wiki. Unten steht ein Unified-Diff der Klasse {className}. Fasse in wenigen kurzen Stichpunkten (Markdown-Liste mit "-") zusammen, WAS sich gegenueber der Vorversion geaendert hat (z. B. neue/entfernte Methoden, geaenderte Signaturen, angepasste Logik). Sei praegnant, keine Zeilennummern, kein kompletter Code-Block. Antworte nur mit der Aufzaehlung.

\`\`\`diff
{diff}
\`\`\``,
};

// Welche Platzhalter eine Vorlage kennt -- die Oberflaeche zeigt sie als einsetzbare Chips an.
export const PROMPT_PLACEHOLDERS: Record<keyof BotPrompts, string[]> = {
  method: ['context', 'signature', 'javadoc', 'body', 'className', 'methodName', 'returnType'],
  methodShort: ['context', 'signature', 'javadoc', 'className', 'methodName', 'returnType'],
  class: ['context', 'fqn', 'className', 'classType', 'package', 'methods'],
  diff: ['context', 'className', 'diff'],
};

// Was ein Platzhalter liefert -- Text fuer die Hilfe in der Oberflaeche (UI-Sprache: Englisch).
export const PLACEHOLDER_HELP: Record<string, string> = {
  context: 'Project context + knowledge from earlier analyses. Remove it and neither reaches the model.',
  signature: 'Return type, class, method name and parameters on one line.',
  javadoc: 'Existing Javadoc, already prefixed and on its own lines. Empty when there is none.',
  body: 'Parsed method body inside a fenced java block. Empty when there is none.',
  className: 'Simple class name, e.g. N8nClient.',
  methodName: 'Method name without parameters.',
  returnType: 'Declared return type, "void" when absent.',
  fqn: 'Fully qualified class name, package included.',
  classType: 'class, interface, enum, record or annotation.',
  package: 'Package of the class, empty for the default package.',
  methods: 'Comma-separated method names, already prefixed. Empty for a class without methods.',
  diff: 'Unified diff against the previous version.',
};

const HOST_HINT = 'Base URL of the Ollama server, no path. /api/generate, /api/tags and /api/version are derived from it.';

export const BOT_FIELDS: BotFieldSpec[] = [
  { path: 'host', type: 'string', group: 'connection', label: 'Ollama host', hint: HOST_HINT },
  {
    path: 'model',
    type: 'string',
    group: 'connection',
    label: 'Model',
    hint: 'Must be pulled on the server (ollama pull). The catalog below lists what is installed.',
  },
  {
    path: 'embedModel',
    type: 'string',
    group: 'connection',
    label: 'Embedding model',
    hint: 'Used only for meaning-based search (ollama pull nomic-embed-text). Leave empty to switch that search off.',
  },
  {
    path: 'timeoutMs',
    type: 'int',
    min: 1000,
    max: 600000,
    step: 1000,
    group: 'connection',
    label: 'Timeout',
    hint: 'Idle timeout while streaming (reset per chunk), hard timeout for single calls. A slow model on a Pi needs a generous value.',
  },
  {
    path: 'temperature',
    type: 'float',
    min: 0,
    max: 2,
    step: 0.05,
    nullable: true,
    group: 'generation',
    label: 'Temperature',
    hint: 'Higher means more variation. Documentation wants little of it — 0.1 to 0.4 is a good range. Unset leaves it to the model.',
  },
  {
    path: 'topP',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    nullable: true,
    group: 'generation',
    label: 'Top P',
    hint: 'Nucleus sampling. Usually adjusted instead of temperature, not on top of it.',
  },
  {
    path: 'numCtx',
    type: 'int',
    min: 256,
    max: 131072,
    step: 256,
    nullable: true,
    group: 'generation',
    label: 'Context window',
    hint: 'Tokens the model may read. Long method bodies plus project context need room — but every token costs memory on the server.',
  },
  {
    path: 'numPredict',
    type: 'int',
    min: -1,
    max: 32768,
    step: 64,
    nullable: true,
    group: 'generation',
    label: 'Max output tokens',
    hint: 'Upper bound for the answer. -1 means unlimited. Descriptions are short, so a cap protects against a runaway model.',
  },
  {
    path: 'seed',
    type: 'int',
    min: 0,
    max: 2147483647,
    nullable: true,
    group: 'generation',
    label: 'Seed',
    hint: 'Fixed seed makes runs repeatable — useful when comparing prompt changes.',
  },
  {
    path: 'language',
    type: 'enum',
    values: ['de', 'en'],
    group: 'generation',
    label: 'Answer language',
    hint: 'Appended as an explicit instruction to every prompt. Small models otherwise drift back to English.',
  },
  {
    path: 'projectContext',
    type: 'text',
    allowEmpty: true,
    group: 'context',
    label: 'Project context',
    hint: 'Domain knowledge fed into every prompt via {context}. Stored on the server — it used to live only in the browser tab and was gone after a reload.',
  },
  { path: 'prompts.method', type: 'text', group: 'prompts', label: 'Method description', hint: 'Used by the AI queue and the article-bound run.' },
  { path: 'prompts.methodShort', type: 'text', group: 'prompts', label: 'Short method summary', hint: 'Used by the single "summarize" call — signature and Javadoc only, no body.' },
  { path: 'prompts.class', type: 'text', group: 'prompts', label: 'Class description', hint: 'Runs after all methods of a class are done.' },
  { path: 'prompts.diff', type: 'text', group: 'prompts', label: 'Change summary', hint: 'Changelog entry generated when a class is re-imported.' },
  {
    path: 'queue.concurrency',
    type: 'int',
    min: 1,
    max: 8,
    group: 'queue',
    label: 'Parallel classes',
    hint: 'How many classes the queue analyses at once. 1 protects a Raspberry Pi; a workstation with a small model handles more. Above 1 the topological order weakens — a dependency may still be running when the class using it is analysed, so its knowledge is missing from the context.',
  },
  {
    path: 'queue.retries',
    type: 'int',
    min: 0,
    max: 5,
    group: 'queue',
    label: 'Retries',
    hint: 'Repeat attempts when the model returns nothing (timeout or server down). Without them a single hiccup leaves an empty description behind.',
  },
  {
    path: 'queue.retryDelayMs',
    type: 'int',
    min: 0,
    max: 60000,
    step: 250,
    group: 'queue',
    label: 'Retry delay',
    hint: 'Wait before retrying. Gives a busy or restarting Ollama time to answer again.',
  },
];

// OLLAMA_URL zeigte bisher auf den vollen Generate-Endpunkt. Die Oberflaeche konfiguriert den HOST,
// weil daran auch /api/tags (Modellkatalog) und /api/version (Verbindungstest) haengen -- also den
// bekannten Pfad abschneiden statt eine zweite Env-Variable zu verlangen.
export function normalizeHost(raw: string): string {
  const s = (raw || '').trim().replace(/\/+$/, '');
  if (!s) return 'http://localhost:11434';
  return s.replace(/\/api(\/(generate|chat|tags|version|show))?$/i, '') || s;
}

export function envDefaults(): BotConfig {
  return {
    host: normalizeHost(process.env.OLLAMA_URL || 'http://localhost:11434'),
    model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:3b',
    // 137 M Parameter, 768 Dimensionen -- klein genug fuer einen Pi und ohne Konkurrenz zum
    // Textmodell, das daneben im Speicher liegt.
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 20000),
    temperature: null,
    topP: null,
    numCtx: null,
    numPredict: null,
    seed: null,
    language: 'de',
    projectContext: '',
    prompts: { ...DEFAULT_PROMPTS },
    // 1 = das bisherige Verhalten. Ein hoeherer Default wuerde auf dem Pi still mehr Last erzeugen,
    // als der Bestand vertraegt -- wer mehr will, stellt es ein und sieht die Warnung daneben.
    queue: { concurrency: 1, retries: 1, retryDelayMs: 2000 },
  };
}

/** Wert an einem Pfad lesen/schreiben ('prompts.method'). */
export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

export function setPath(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  const last = parts.pop() as string;
  let cur = obj;
  for (const p of parts) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

/**
 * Platzhalter ersetzen. Unbekannte Namen bleiben unveraendert stehen -- ein `{signatur}` im
 * Prompt soll auffallen und nicht spurlos verschwinden.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return (template || '').replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

// Die Sprachanweisung haengt IMMER hinten an, unabhaengig von der Vorlage: wer sein Template
// umschreibt, soll die Sprache trotzdem ueber den Schalter steuern koennen.
export function languageInstruction(language: string): string {
  return language === 'en' ? 'Answer in English.' : 'Antworte auf Deutsch.';
}

/** Ollama-`options` aus der Konfiguration. Nicht gesetzte Felder werden weggelassen. */
export function ollamaOptions(cfg: BotConfig): Record<string, number> | undefined {
  const o: Record<string, number> = {};
  if (cfg.temperature != null) o.temperature = cfg.temperature;
  if (cfg.topP != null) o.top_p = cfg.topP;
  if (cfg.numCtx != null) o.num_ctx = cfg.numCtx;
  if (cfg.numPredict != null) o.num_predict = cfg.numPredict;
  if (cfg.seed != null) o.seed = cfg.seed;
  return Object.keys(o).length ? o : undefined;
}
