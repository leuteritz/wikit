// Wie man EINE Klasse aufteilen würde – gerechnet, nicht geraten.
//
// Die Hotspot-Rangliste beantwortet „welche Klasse kostet mich Zeit?". Die Frage direkt dahinter
// lautet „und was mache ich mit ihr?", und dort hört ein Bericht sonst auf: „split this class" ist
// derselbe Satz für jede Klasse und damit keine Auskunft. Diese Datei nennt die Teile, die Mitglieder
// in jedem Teil, den Preis des Schnitts und den Grund – mit den echten Namen aus dem Code.
//
// ⚠️ **Drei Schnitte, weil es drei Gründe gibt, warum eine Klasse schwer ist** – und derselbe Schnitt
// wäre für die anderen beiden die falsche Antwort:
//
//   * **cohesion** – die Klasse hält mehrere Zustände, die nichts miteinander zu tun haben. Der
//     Schnitt läuft entlang der Felder: Methoden, die dieselben Felder anfassen, gehören zusammen.
//   * **roles** – die Klasse ist in Ordnung, aber jeder Aufrufer braucht nur ein Zehntel davon. Der
//     Schnitt läuft entlang der NUTZER, nicht des Zustands: je Nutzergruppe ein Interface.
//   * **branching** – nicht die Klasse ist groß, sondern eine Methode darin. Der Schnitt läuft
//     entlang der Methoden.
//
// Gerechnet werden immer alle drei; welche führt, entscheidet die Eignung (`fit`) und nicht der
// Wunsch. Eine Strategie, die hier nichts hergibt, sagt WARUM – „kein Vorschlag" ohne Grund liest
// sich wie „mit dieser Klasse ist alles in Ordnung".
//
// ⚠️ **Reine Textarbeit auf dem, was ohnehin gespeichert ist** – dieselbe Begründung wie bei
// `code-metrics.ts`: die Methodenrümpfe stehen in `java_methods.body`, die Felder stehen als
// Mitglieder derselben Tabelle. Kein Reparse, kein CST, kein Ollama. Die Zuordnung „diese Methode
// benutzt dieses Feld" ist damit eine NÄHERUNG (eine lokale Variable gleichen Namens zählt mit) –
// sie muss nur überall dieselbe sein, denn sie gruppiert Methoden gegeneinander und misst nichts
// absolut.

import { cyclomatic, stripNonCode, countCodeLines } from '../common/code-metrics';

// Wie stark ein gemeinsames Feld zwei Methoden zusammenhält, gemessen gegen einen direkten Aufruf.
// ⚠️ Das Feld wiegt schwerer, und das ist die ganze Idee: ein Aufruf ist eine Benutzung und trennt
// sich mit einer Zeile, ein gemeinsames Feld ist geteilter ZUSTAND – die beiden Methoden lassen sich
// nicht auseinanderlegen, ohne dass jemand das Feld hinterherreicht.
const FIELD_WEIGHT = 3;
const CALL_WEIGHT = 2;

// Ab wann eine Klasse überhaupt eine Aufteilungsfrage stellt. Darunter ist die Antwort „lass sie in
// Ruhe" – und die steht dann auch da.
const MIN_METHODS = 4;
const MIN_STATE_FIELDS = 2;

// ⚠️ Ab wie vielen Verzweigungen eine Methode überhaupt „die schwere" sein kann – ABSOLUT, und
// geprüft VOR ihrem Anteil. Ein Anteil ist keine Aussage, solange die Gesamtzahl klein ist:
// gemessen an einer Klasse mit sechs Verzweigungen hielt eine Zwei-Zeilen-Methode 33 % davon, und
// der Bericht schlug allen Ernstes vor, sie zu zerlegen. Genau diese Sorte Vorschlag kostet einen
// Bericht seine Glaubwürdigkeit – danach glaubt man auch dem richtigen nicht mehr.
const MIN_HOT_BRANCHES = 8;

// Wie ähnlich die Aufruflisten zweier Nutzer sein müssen, um dieselbe Rolle zu sein (Jaccard).
// 0,5 heißt „die Hälfte der genannten Mitglieder ist dieselbe" – darunter sind es zwei Sichten auf
// die Klasse und keine gemeinsame.
const ROLE_JACCARD = 0.5;

// Wie viele Mitglieder/Nutzer/Methoden eine Karte namentlich nennt. Der Rest wird gezählt – dieselbe
// Regel wie bei `LINK_SAMPLE` im Bericht.
const MEMBERS_SHOWN = 12;
const USERS_SHOWN = 6;
const METHODS_SHOWN = 5;

// Deckel für die Paar-Rechnung. Eine Klasse mit mehr Methoden ist kein Refactoring-Kandidat mehr,
// sondern ein eigenes Projekt – und der Greedy-Lauf ist quadratisch in der Zahl der Gruppen.
const MAX_UNITS = 150;

// Wortbestandteile, die einen Namen nicht benennen: Verben und Füllwörter. Ein Teil, der
// `getPrice`/`applyDiscount`/`roundPrice` hält, heißt nach „Price" und nicht nach „Get".
const NAME_STOPWORDS = new Set([
  'get', 'set', 'is', 'has', 'do', 'to', 'from', 'on', 'of', 'by', 'as', 'the', 'a', 'an', 'this',
  'new', 'add', 'remove', 'delete', 'update', 'create', 'build', 'make', 'find', 'load', 'save',
  'read', 'write', 'fetch', 'put', 'post', 'send', 'run', 'exec', 'execute', 'apply', 'handle',
  'process', 'check', 'validate', 'ensure', 'init', 'setup', 'start', 'stop', 'close', 'open',
  'calc', 'calculate', 'compute', 'convert', 'parse', 'format', 'print', 'log', 'with', 'for',
  'and', 'or', 'not', 'all', 'any', 'each', 'value', 'values', 'data', 'info', 'item', 'items',
  'list', 'map', 'set2', 'obj', 'object', 'result', 'tmp', 'temp', 'str', 'string', 'int', 'num',
]);

// Endungen, die eine Rolle benennen. Trägt die Ursprungsklasse eine, erbt der Teil sie: aus
// `OrderService` + „price" wird `PriceService` und nicht `Price` – der Name soll sich in dieselbe
// Codebasis einfügen, aus der er stammt.
const ROLE_SUFFIXES = [
  'Service', 'Repository', 'Controller', 'Manager', 'Handler', 'Factory', 'Validator', 'Client',
  'Mapper', 'Converter', 'Builder', 'Provider', 'Resolver', 'Store', 'Dao', 'Facade', 'Helper',
  'Util', 'Utils', 'Support', 'Adapter', 'Listener', 'Filter', 'Processor', 'Worker', 'Job',
];

export type SplitMember = {
  name: string;
  kind: string; // 'method' | 'constructor' | 'initializer' | 'field'
  returnType: string;
  parameters: Array<{ type: string; name: string }>;
  modifiers: string[];
  body: string;
  line: number | null;
};

export type SplitConsumer = {
  className: string;
  fileId: number | null;
  members: string[]; // die Mitglieder, die dieser Nutzer nennt – leer bei reinem Typbezug
};

/**
 * Eine vorgeschlagene Datei – als GANZER Java-Quelltext, nicht als Gerüst.
 *
 * ⚠️ Der Vorschlag zeigt die neue Klasse so, wie sie nach dem Umbau **aussieht**: echte Felder,
 * echter Konstruktor, echte Methodenrümpfe aus `java_methods.body`. Vorher stand dort ein Skelett
 * mit `{ … }` – das liest sich wie eine Architekturskizze, und wer Java kann, aber keine
 * Architekturbegriffe (die Zielgruppe des ganzen Berichts), kann daran nicht erkennen, ob der
 * Vorschlag stimmt. Ein Quelltext, den man kopieren und übersetzen kann, ist überprüfbar.
 *
 * `code` ist der Kopiertext, `lines` seine Länge. Das Shiki-HTML entsteht daraus im Service –
 * aus DEMSELBEN, bereits eingerückten Text, sonst zeigte das Fenster etwas anderes an, als der
 * Kopierknopf herausgibt.
 */
export type SplitFile = {
  name: string; // PriceService.java
  path: string; // com.acme.shop.PriceService
  // ⚠️ `new`/`rewritten` sind GANZE Dateien – man kann sie anlegen bzw. die alte damit ersetzen.
  // `excerpt` ist es NICHT: nur der Teil, der sich ändert oder um den es geht. Die Unterscheidung
  // ist keine Kosmetik, sie steht am Kopierknopf: wer einen Ausschnitt für eine ganze Datei hält
  // und ihn einsetzt, löscht den Rest seiner Klasse.
  kind: 'new' | 'rewritten' | 'excerpt';
  caption: string; // warum es diese Datei gibt
  code: string;
  lines: number;
  /**
   * ⚠️ `true` = dieser Text ist ORIGINALCODE und wird nicht neu eingerückt.
   *
   * Alles andere hier ist zusammengesetzt und braucht `reindentJava`, um wie eine Datei auszusehen.
   * Ein Ausschnitt, der zeigen soll „so steht die Methode heute da", darf dagegen genau nicht durch
   * den Formatter: gemessen an einer switch-Methode zog er die `case`-Zweige eine Ebene nach links,
   * und der Ausschnitt sah damit anders aus als dieselbe Methode im Source-Tab daneben – bei einer
   * Ansicht, deren ganzer Zweck „das ist dein Code" ist, ist das die eine unzulässige Abweichung.
   */
  verbatim?: boolean;
};

export type SplitClass = {
  id: number;
  className: string;
  package: string;
  type: string;
  loc: number;
  complexity: number;
  driver: string | null;
};

// --- Textarbeit auf einem Rumpf -----------------------------------------------------------------

/**
 * Benutzt dieser Rumpf dieses Mitglied?
 *
 * ⚠️ Zwei Schreibweisen, und die zweite ist nicht überflüssig: `this.price` und `price` sind
 * derselbe Zugriff. `other.price` dagegen ist ein FREMDES Feld und darf nicht zählen – deshalb
 * verbietet der eine Zweig einen Punkt davor, und der andere verlangt genau `this.`.
 *
 * ⚠️ Trägt die Methode einen Parameter desselben Namens, zählt NUR `this.name`. Das ist der
 * häufigste Fall überhaupt (`void setPrice(int price) { this.price = price; }`) – ohne die
 * Unterscheidung hinge jede Methode an jedem Feld, das sie zufällig als Parameter führt, und
 * genau daran wären die Gruppen wieder eine einzige.
 */
function usesName(code: string, name: string, shadowed: boolean): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?<![\\w$])this\\.${esc}(?![\\w$])`).test(code)) return true;
  if (shadowed) return false;
  return new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`).test(code);
}

/** Ruft dieser Rumpf diese Methode auf? Wie oben, nur mit der öffnenden Klammer dahinter. */
function callsName(code: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?<![\\w$])this\\.${esc}\\s*\\(`).test(code)) return true;
  return new RegExp(`(?<![\\w$.])${esc}\\s*\\(`).test(code);
}

const isStatic = (m: SplitMember) => m.modifiers.includes('static');
const isPublic = (m: SplitMember) => m.modifiers.includes('public') || m.modifiers.includes('protected');
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : '');
const low = (w: string) => (w ? w[0].toLowerCase() + w.slice(1) : '');

/** camelCase/SCREAMING_CASE in kleingeschriebene Wörter zerlegen: `orderPriceList` -> order, price, list. */
function words(name: string): string[] {
  return String(name || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Die Rollenendung einer Klasse (`OrderService` -> `Service`), oder `''`. */
function roleSuffix(className: string): string {
  return ROLE_SUFFIXES.find((s) => className.length > s.length && className.endsWith(s)) || '';
}

/**
 * Ein Name für einen Teil – aus dem, was er hält.
 *
 * ⚠️ Der Name ist der einzige GERATENE Teil des Vorschlags, und er wird als solcher angeschrieben
 * (`nameGuessed`). Gewählt wird das häufigste Substantiv in den Mitgliedernamen des Teils, das
 * nicht schon die Klasse benennt – bei Gleichstand alphabetisch, damit derselbe Bestand immer
 * denselben Namen ergibt. Ohne ein tragendes Wort bleibt es bei `<Klasse>Part2`: einen Namen zu
 * erfinden, den nichts im Code stützt, wäre schlechter als zuzugeben, dass es keinen gibt.
 */
function nameFor(members: SplitMember[], cls: SplitClass, index: number): { name: string; guessed: boolean } {
  const suffix = roleSuffix(cls.className);
  const base = (suffix ? cls.className.slice(0, -suffix.length) : cls.className).toLowerCase();

  const freq = new Map<string, number>();
  for (const m of members) {
    // Je Mitglied zählt ein Wort EINMAL – sonst gewönne eine Methode mit `priceOfPrice`.
    for (const w of new Set(words(m.name))) {
      if (NAME_STOPWORDS.has(w) || w.length < 3 || w === base) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const best = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  if (!best) return { name: `${cls.className}Part${index + 1}`, guessed: true };
  const noun = cap(best[0]);
  // Endet das Wort schon auf die Rolle (`priceValidator`), wird sie nicht doppelt angehängt.
  const name = suffix && !noun.endsWith(suffix) ? `${noun}${suffix}` : noun;
  return { name, guessed: false };
}

// --- Gruppieren nach Modularität ----------------------------------------------------------------

/**
 * Greedy-Modularität (Newman/CNM) auf einem gewichteten, ungerichteten Graphen.
 *
 * Jeder Knoten beginnt als eigene Gruppe; verschmolzen wird wiederholt das Paar mit dem größten
 * Zugewinn, solange er positiv ist. ⚠️ Die Zahl der Gruppen wird damit NICHT vorgegeben – „teile
 * in zwei" wäre eine Antwort auf eine Frage, die niemand gestellt hat, und bei einer Klasse aus
 * drei Themen die falsche. Der Abbruch bei ΔQ ≤ 0 ist die Aussage „ein weiterer Schnitt macht es
 * nicht besser".
 *
 * Bei Gleichstand gewinnt das Paar mit den kleineren Indizes: derselbe Bestand muss dieselbe
 * Aufteilung ergeben, sonst ändert sich der Vorschlag beim bloßen Neuladen.
 */
function greedyModularity(n: number, weight: number[][]): number[] {
  const comm = Array.from({ length: n }, (_, i) => i);
  const deg = weight.map((row) => row.reduce((s, w) => s + w, 0));
  const m = deg.reduce((s, d) => s + d, 0) / 2;
  if (m <= 0) return comm;

  // Gewichte zwischen GRUPPEN – anfangs die Kantengewichte selbst.
  const between = weight.map((row) => [...row]);
  const degOf = [...deg];
  const alive = new Set(Array.from({ length: n }, (_, i) => i));

  for (;;) {
    let bestGain = 0;
    let bestA = -1;
    let bestB = -1;
    for (const a of alive) {
      for (const b of alive) {
        if (b <= a) continue;
        const w = between[a][b];
        if (w <= 0) continue;
        const gain = w / m - (degOf[a] * degOf[b]) / (2 * m * m);
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0) break;

    // b in a auflösen.
    for (const c of alive) {
      if (c === bestA || c === bestB) continue;
      between[bestA][c] += between[bestB][c];
      between[c][bestA] = between[bestA][c];
    }
    degOf[bestA] += degOf[bestB];
    alive.delete(bestB);
    for (let i = 0; i < n; i++) if (comm[i] === bestB) comm[i] = bestA;
  }
  return comm;
}

// --- Die drei Strategien ------------------------------------------------------------------------

type Part = {
  name: string;
  nameGuessed: boolean;
  reason: string;
  members: Array<{ name: string; kind: string; line: number | null; complexity: number; signature: string }>;
  fields: Array<{ name: string; type: string }>;
  moreMembers: number;
  memberCount: number;
  loc: number;
  complexity: number;
};

type Strategy = {
  id: string;
  title: string;
  verdict: 'strong' | 'weak' | 'none';
  fit: number;
  headline: string;
  why: string;
  parts: Part[];
  files: SplitFile[];
  shared: Array<{ name: string; type: string; parts: string[] }>;
  cost: string | null;
  gain: string | null;
};

// --- Aus Mitgliedern wieder Java machen ---------------------------------------------------------
//
// ⚠️ Die Rümpfe kommen UNVERÄNDERT aus `java_methods.body` – nicht neu formatiert und nicht gekürzt.
// Der ganze Wert dieser Ansicht liegt darin, dass der gezeigte Code derselbe ist wie der im
// Projekt: an einem umgeschriebenen Rumpf könnte niemand prüfen, ob der Vorschlag stimmt. Die
// EINRÜCKUNG stellt danach `reindentJava` im Service her – einmal, für Kopiertext und Anzeige
// zugleich (zwei Läufe wären zwei Fassungen desselben Textes).

const INDENT = '    ';

/**
 * `private final Map<String, Long> priceList;` – die Modifier bleiben, wie sie im Code stehen.
 *
 * ⚠️ Der Initialisierer gehört DAZU (er steht bei einem Feld im `body`). Ohne ihn verliert
 * `private int count = 0;` seinen Wert – und eine `static final`-Konstante ohne Zuweisung
 * übersetzt nicht einmal. Genau daran scheiterte die erste Fassung: `private static final Logger
 * log = …` kam als Zeile ohne `=` in der erzeugten Datei an.
 */
function fieldLine(f: SplitMember): string {
  const mods = f.modifiers.length ? `${f.modifiers.join(' ')} ` : 'private ';
  const init = (f.body || '').trim();
  return `${INDENT}${mods}${f.returnType || 'Object'} ${f.name}${init ? ` = ${init}` : ''};`;
}

const paramList = (m: SplitMember) => m.parameters.map((p) => `${p.type} ${p.name}`).join(', ');

/** Eine Methode mit ihrem ECHTEN Rumpf. Ohne Rumpf (abstrakt/Interface) bleibt es beim Semikolon. */
function methodText(m: SplitMember): string {
  const mods = m.modifiers.length ? `${m.modifiers.join(' ')} ` : '';
  const ret = m.returnType ? `${m.returnType} ` : '';
  const head = `${INDENT}${mods}${ret}${m.name}(${paramList(m)})`;
  const body = (m.body || '').trim();
  // Ohne Rumpf (abstrakt, Interface-Methode) endet die Zeile am Semikolon – dort steht im Original
  // auch nichts anderes.
  return body ? `${head} ${body}` : `${head};`;
}

/** Der Konstruktor, der die Felder hereinreicht – der Preis des Schnitts, als Code. */
function constructorText(name: string, fields: SplitMember[]): string {
  if (!fields.length) return '';
  const params = fields.map((f) => `${f.returnType || 'Object'} ${f.name}`).join(', ');
  const body = fields.map((f) => `${INDENT}${INDENT}this.${f.name} = ${f.name};`).join('\n');
  return `${INDENT}public ${name}(${params}) {\n${body}\n${INDENT}}`;
}

/**
 * Die Import-Zeilen, die dieser Ausschnitt WIRKLICH braucht.
 *
 * ⚠️ Alle Importe der Ursprungsklasse zu übernehmen wäre bequem und falsch: die Hälfte davon
 * gehört zum anderen Teil, und eine generierte Datei, die mit acht ungenutzten Importen beginnt,
 * sieht aus wie Ausgabe einer Maschine statt wie Code, den man übernimmt. Entschieden wird über
 * den einfachen Typnamen im erzeugten Text – dieselbe Wortgrenzen-Regel wie überall
 * (`$` ist in Java ein Identifier-Zeichen).
 */
function importsFor(body: string, imports: string[]): string[] {
  const hit = imports.filter((fq) => {
    const simple = fq.replace(/\.\*$/, '').split('.').pop() || '';
    if (!simple || !/^[A-Z]/.test(simple)) return false;
    return new RegExp(`(?<![\\w$])${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(body);
  });
  return [...new Set(hit)].sort();
}

/** Package-Zeile, Importe, Typ – der Rahmen jeder erzeugten Datei. */
function javaFile(pkg: string, imports: string[], bodyText: string): string {
  const head = pkg ? `package ${pkg};\n\n` : '';
  const imp = importsFor(bodyText, imports);
  return `${head}${imp.length ? `${imp.map((i) => `import ${i};`).join('\n')}\n\n` : ''}${bodyText}\n`;
}

const asFile = (
  pkg: string,
  name: string,
  kind: SplitFile['kind'],
  caption: string,
  code: string,
): SplitFile => ({
  name: `${name}.java`,
  path: pkg ? `${pkg}.${name}` : name,
  kind,
  caption,
  code,
  lines: code.split('\n').length,
});

const signatureOf = (m: SplitMember): string => {
  if (m.kind === 'field') return `${m.returnType || 'var'} ${m.name}`;
  const params = m.parameters.map((p) => `${p.type} ${p.name}`).join(', ');
  return `${m.returnType ? `${m.returnType} ` : ''}${m.name}(${params})`;
};

/**
 * Schnitt entlang des ZUSTANDS: welche Methoden fassen dieselben Felder an?
 *
 * ⚠️ Konstruktoren und Initialisierer bleiben draußen. Ein Konstruktor setzt fast jedes Feld und
 * verbindet damit jede Gruppe mit jeder – gemessen an einer Klasse mit zwei sauber getrennten
 * Themen fiel mit ihm genau eine Gruppe heraus. Er ist auch nicht die Frage: beim Aufteilen wird er
 * ohnehin neu geschrieben.
 *
 * ⚠️ `static final`-Felder verbinden ebenfalls nichts. Sie sind Konstanten, kein Zustand – und der
 * `private static final Logger log` steht in jeder Methode. Über ihn hinge sonst die ganze Klasse
 * an einem Strang, und zwar ausgerechnet an dem, der beim Aufteilen einfach mitkopiert wird.
 */
function cohesionSplit(
  cls: SplitClass,
  members: SplitMember[],
  imports: string[],
  consumers: SplitConsumer[],
): Strategy {
  const fields = members.filter((m) => m.kind === 'field');
  const state = fields.filter((f) => !(isStatic(f) && f.modifiers.includes('final')));
  const units = members.filter((m) => m.kind === 'method').slice(0, MAX_UNITS);

  const none = (why: string): Strategy => ({
    id: 'cohesion',
    title: 'Split by what it holds',
    verdict: 'none',
    fit: 0,
    headline: 'No useful cut along the fields.',
    why,
    parts: [],
    files: [],
    shared: [],
    cost: null,
    gain: null,
  });

  if (units.length < MIN_METHODS) {
    return none(`Only ${units.length} ${units.length === 1 ? 'method' : 'methods'} — there is nothing here to separate.`);
  }
  if (state.length < MIN_STATE_FIELDS) {
    return none(
      state.length === 0
        ? 'This class holds no state of its own, so there are no field groups to cut along. Look at the roles or the branching instead.'
        : 'One single field, used everywhere — a split along the state would just move it.',
    );
  }

  // Zugriffsmatrix. Der Rumpf wird EINMAL von Kommentaren und Literalen befreit: `// price` ist
  // kein Zugriff, und `"price"` erst recht nicht.
  const code = units.map((u) => stripNonCode(u.body || ''));
  const touches: Array<Set<string>> = units.map((u, i) => {
    const set = new Set<string>();
    const params = new Set(u.parameters.map((p) => p.name));
    for (const f of state) {
      if (usesName(code[i], f.name, params.has(f.name))) set.add(f.name);
    }
    return set;
  });

  const weight = units.map(() => units.map(() => 0));
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      let w = 0;
      for (const f of touches[i]) if (touches[j].has(f)) w += FIELD_WEIGHT;
      if (callsName(code[i], units[j].name) || callsName(code[j], units[i].name)) w += CALL_WEIGHT;
      weight[i][j] = w;
      weight[j][i] = w;
    }
  }

  const comm = greedyModularity(units.length, weight);
  // Nach Gruppen bündeln. Isolierte Methoden (kein Feld, kein Aufruf) haben nie verschmolzen und
  // landen in einer eigenen Sammelgruppe – nicht als je eigener „Teil": zwölf Ein-Element-Karten
  // wären keine Aufteilung, sondern die Methodenliste noch einmal.
  const groups = new Map<number, number[]>();
  const loners: number[] = [];
  for (let i = 0; i < units.length; i++) {
    const linked = weight[i].some((w) => w > 0);
    if (!linked) {
      loners.push(i);
      continue;
    }
    const list = groups.get(comm[i]) || [];
    list.push(i);
    groups.set(comm[i], list);
  }

  const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  if (ordered.length + (loners.length ? 1 : 0) < 2) {
    return none(
      'Every method reaches for the same fields. The class is heavy, but it is one thing — splitting it along the state would only hand the same fields back and forth.',
    );
  }

  // Welche Felder gehören einer Gruppe allein, welche werden geteilt? Die geteilten sind der PREIS
  // des Schnitts: sie müssen nach dem Aufteilen von einer Seite zur anderen gereicht werden.
  const owners = new Map<string, Set<number>>();
  ordered.forEach((idxs, gi) => {
    for (const i of idxs) for (const f of touches[i]) {
      const set = owners.get(f) || new Set<number>();
      set.add(gi);
      owners.set(f, set);
    }
  });

  const typeOf = new Map(state.map((f) => [f.name, f.returnType || 'var']));
  const partOfIdx = (idxs: number[], gi: number): Part => {
    const list = idxs.map((i) => units[i]);
    const own = [...owners.entries()].filter(([, set]) => set.size === 1 && set.has(gi)).map(([f]) => f);
    const { name, guessed } = nameFor(list, cls, gi);
    const shownFields = own.length ? own : [];
    return {
      name,
      nameGuessed: guessed,
      reason: own.length
        ? `${list.length} ${list.length === 1 ? 'method' : 'methods'} that only ever touch ${own.slice(0, 3).join(', ')}${own.length > 3 ? ` and ${own.length - 3} more` : ''}.`
        : `${list.length} methods that work together, but on fields the other parts need as well.`,
      members: list.slice(0, MEMBERS_SHOWN).map((m) => ({
        name: m.name,
        kind: m.kind,
        line: m.line,
        complexity: cyclomatic(m.body || ''),
        signature: signatureOf(m),
      })),
      moreMembers: Math.max(0, list.length - MEMBERS_SHOWN),
      memberCount: list.length,
      fields: shownFields.map((f) => ({ name: f, type: typeOf.get(f) || 'var' })),
      loc: list.reduce((s, m) => s + countCodeLines(m.body || ''), 0),
      complexity: list.reduce((s, m) => s + cyclomatic(m.body || ''), 0),
    };
  };

  // Die Mitglieder je Teil in DERSELBEN Reihenfolge wie `parts` – daraus entstehen unten die
  // Dateien. Getrennt geführt, weil `parts[].members` für die Anzeige gedeckelt ist (`MEMBERS_SHOWN`)
  // und eine Datei mit zwölf von siebzehn Methoden keine Datei wäre.
  const groupMembers: SplitMember[][] = ordered.map((idxs) => idxs.map((i) => units[i]));
  const parts = ordered.map(partOfIdx);
  if (loners.length) {
    const list = loners.map((i) => units[i]);
    groupMembers.push(list);
    const suffix = roleSuffix(cls.className);
    parts.push({
      name: `${suffix ? cls.className.slice(0, -suffix.length) : cls.className}Support`,
      nameGuessed: true,
      reason: `${list.length} ${list.length === 1 ? 'method that touches' : 'methods that touch'} no field of this class at all — ${list.length === 1 ? 'it is' : 'they are'} a helper sitting in the wrong file.`,
      members: list.slice(0, MEMBERS_SHOWN).map((m) => ({
        name: m.name,
        kind: m.kind,
        line: m.line,
        complexity: cyclomatic(m.body || ''),
        signature: signatureOf(m),
      })),
      moreMembers: Math.max(0, list.length - MEMBERS_SHOWN),
      memberCount: list.length,
      fields: [],
      loc: list.reduce((s, m) => s + countCodeLines(m.body || ''), 0),
      complexity: list.reduce((s, m) => s + cyclomatic(m.body || ''), 0),
    });
  }

  const shared = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([f, set]) => ({
      name: f,
      type: typeOf.get(f) || 'var',
      parts: [...set].sort((a, b) => a - b).map((gi) => parts[gi]?.name).filter(Boolean) as string[],
    }))
    .sort((a, b) => b.parts.length - a.parts.length || a.name.localeCompare(b.name));

  // Eignung: wie sauber trennt der Schnitt? Zwei Anteile, beide 0…1 – wie viele Felder GANZ auf
  // einer Seite liegen, und wie ausgewogen die Teile sind. Ein Schnitt, der 9 von 10 Methoden in
  // einen Teil legt, ist formal einer und praktisch keiner.
  const clean = state.length ? 1 - shared.length / state.length : 0;
  const biggest = Math.max(...parts.map((p) => p.memberCount));
  const balance = 1 - (biggest - units.length / parts.length) / units.length;
  const fit = Math.max(0, Math.min(1, 0.65 * clean + 0.35 * balance));

  // --- Die Dateien ------------------------------------------------------------------------------
  const fieldByName = new Map(state.map((f) => [f.name, f]));
  const files: SplitFile[] = parts.map((p, gi) => {
    const list = groupMembers[gi] || [];
    // ⚠️ Welche Felder die DATEI braucht, ist eine andere Frage als welche die GRUPPEN gebildet
    // haben. Gruppiert wurde über `state` – Konstanten verbinden keine Methoden. Benutzt werden sie
    // trotzdem: gefiltert wird deshalb über ALLE Felder. Die erste Fassung nahm hier `state`, und
    // die erzeugte Klasse rief ein `log`, das sie nicht besaß – sie übersetzte nicht.
    const needed = fields.filter((f) =>
      list.some((m) => usesName(stripNonCode(m.body || ''), f.name, new Set(m.parameters.map((q) => q.name)).has(f.name))),
    );
    const statics = needed.filter(isStatic);
    const instance = needed.filter((f) => !isStatic(f));
    // In den Konstruktor gehört nur, was keinen eigenen Wert mitbringt. Ein Feld mit
    // Initialisierer setzt sich selbst – es zusätzlich hereinzureichen wäre eine doppelte Zuweisung.
    const injected = instance.filter((f) => !(f.body || '').trim());
    const head = [...statics.map(fieldLine), ...instance.map(fieldLine)];
    const body = [
      `public class ${p.name} {`,
      ...head,
      ...(injected.length ? ['', constructorText(p.name, injected)] : []),
      // Die Leerzeile trennt Mitglieder – vor dem ERSTEN gibt es nichts zu trennen, und eine
      // Leerzeile direkt hinter `{` sieht nach generiertem Text aus statt nach Code.
      ...list.flatMap((m, mi) => (mi === 0 && !head.length && !injected.length ? [methodText(m)] : ['', methodText(m)])),
      '}',
    ].join('\n');
    return asFile(
      cls.package,
      p.name,
      'new',
      p.reason,
      javaFile(cls.package, imports, body),
    );
  });

  // ⚠️ Die umgebaute Ursprungsklasse gibt es nur, wenn sie jemand RUFT. Ohne Aufrufer wäre eine
  // Fassade eine Datei, die niemand braucht – dann verschwindet die Klasse einfach, und das ist die
  // Antwort. Mit Aufrufern ist sie dagegen der Grund, warum der Umbau überhaupt gefahrlos ist: jede
  // Zeile, die heute `orderService.priceOf(...)` sagt, funktioniert danach unverändert weiter.
  const calledNames = new Set(consumers.flatMap((c) => c.members));
  const delegated = units.filter((m) => calledNames.has(m.name) && !isStatic(m));
  if (delegated.length) {
    const ownerOf = new Map<string, string>();
    groupMembers.forEach((list, gi) => list.forEach((m) => ownerOf.set(m.name, parts[gi]?.name || cls.className)));
    const held = [...new Set(delegated.map((m) => ownerOf.get(m.name) || ''))].filter(Boolean);
    const fieldOf = (type: string) => low(type);
    const body = [
      `public class ${cls.className} {`,
      ...held.map((t) => `${INDENT}private final ${t} ${fieldOf(t)};`),
      '',
      `${INDENT}public ${cls.className}(${held.map((t) => `${t} ${fieldOf(t)}`).join(', ')}) {`,
      ...held.map((t) => `${INDENT}${INDENT}this.${fieldOf(t)} = ${fieldOf(t)};`),
      `${INDENT}}`,
      '',
      `${INDENT}// every caller keeps working — each call goes straight through`,
      ...delegated.map((m) => {
        const target = fieldOf(ownerOf.get(m.name) || cls.className);
        const ret = m.returnType && m.returnType !== 'void' ? 'return ' : '';
        const args = m.parameters.map((p) => p.name).join(', ');
        const mods = m.modifiers.length ? `${m.modifiers.join(' ')} ` : '';
        return `${INDENT}${mods}${m.returnType ? `${m.returnType} ` : ''}${m.name}(${paramList(m)}) { ${ret}${target}.${m.name}(${args}); }`;
      }),
      '}',
    ].join('\n');
    files.push(
      asFile(
        cls.package,
        cls.className,
        'rewritten',
        `What is left of ${cls.className}: it holds the parts and passes calls through, so the ${consumers.length === 1 ? 'class that uses it keeps' : `${consumers.length} classes that use it keep`} working unchanged. Delete it once every caller talks to the part it actually needs.`,
        javaFile(cls.package, imports, body),
      ),
    );
  }

  return {
    files,
    id: 'cohesion',
    title: 'Split by what it holds',
    verdict: fit >= 0.55 ? 'strong' : 'weak',
    fit,
    headline: `${parts.length} groups of methods that barely touch each other's fields.`,
    why:
      shared.length === 0
        ? 'Not one field is used by more than one group — these parts are already separate classes, they just live in the same file.'
        : `${shared.length} of ${state.length} fields are used by more than one group. Those are the ones you have to hand over.`,
    parts,
    shared,
    cost: shared.length
      ? `${shared.length === 1 ? 'One field is' : `${shared.length} fields are`} needed on both sides — pass ${shared.length === 1 ? 'it' : 'them'} into the constructor of the part that keeps using ${shared.length === 1 ? 'it' : 'them'}.`
      : 'Nothing has to be handed over — every field belongs to exactly one part.',
    gain: `Each part can be read, tested and changed without the other ${parts.length === 2 ? 'one' : 'ones'}.`,
  };
}

/**
 * Schnitt entlang der NUTZER: wer ruft welchen Ausschnitt dieser Klasse?
 *
 * ⚠️ Das ist die Antwort auf `coupling`, und sie sieht der Kohäsions-Antwort absichtlich nicht
 * ähnlich: hier wird nichts aufgeteilt, was in der Klasse liegt. Die Klasse bleibt, wie sie ist –
 * geteilt wird, was von ihr SICHTBAR ist. Wer nur drei von vierundzwanzig Methoden ruft, soll auch
 * nur drei sehen, und dann bricht eine Änderung an den anderen einundzwanzig seinen Code nicht mehr.
 *
 * Grundlage sind die eingehenden Kanten mit ihrem `method_name`. Ein reiner Typbezug (`uses`) nennt
 * kein Mitglied und zählt deshalb nicht als Rolle – er wird gezählt und danebengeschrieben.
 */
function roleSplit(
  cls: SplitClass,
  members: SplitMember[],
  consumers: SplitConsumer[],
  imports: string[],
): Strategy {
  const api = members.filter((m) => m.kind === 'method' && isPublic(m));
  const naming = consumers.filter((c) => c.members.length);

  const none = (why: string): Strategy => ({
    id: 'roles',
    title: 'Split what the others see',
    verdict: 'none',
    fit: 0,
    headline: 'No useful cut along the callers.',
    why,
    parts: [],
    files: [],
    shared: [],
    cost: null,
    gain: null,
  });

  if (naming.length < 2) {
    return none(
      consumers.length
        ? `${consumers.length} ${consumers.length === 1 ? 'class names' : 'classes name'} this one, but only as a type — there are no calls to group.`
        : 'Nothing in this workspace calls this class, so there is no caller side to cut along.',
    );
  }
  if (api.length < MIN_METHODS) {
    return none(`Only ${api.length} public ${api.length === 1 ? 'method' : 'methods'} — an interface per caller would say the same thing twice.`);
  }

  // Nutzer nach Ähnlichkeit ihrer Aufruflisten bündeln. Greedy und in fester Reihenfolge (die
  // größte Liste zuerst): derselbe Bestand muss dieselben Rollen ergeben.
  const sorted = [...naming].sort(
    (a, b) => b.members.length - a.members.length || a.className.localeCompare(b.className),
  );
  const roles: Array<{ members: Set<string>; users: SplitConsumer[] }> = [];
  for (const c of sorted) {
    const own = new Set(c.members);
    let best: (typeof roles)[number] | null = null;
    let bestScore = 0;
    for (const r of roles) {
      const inter = [...own].filter((m) => r.members.has(m)).length;
      const union = new Set([...own, ...r.members]).size;
      const score = union ? inter / union : 0;
      if (score >= ROLE_JACCARD && score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (best) {
      for (const m of own) best.members.add(m);
      best.users.push(c);
    } else {
      roles.push({ members: own, users: [c] });
    }
  }

  if (roles.length < 2) {
    return none('Every caller uses the same part of this class — one interface would cover all of them, and that is what the class already is.');
  }

  const used = new Set<string>();
  for (const r of roles) for (const m of r.members) used.add(m);
  const suffix = roleSuffix(cls.className);
  const baseName = suffix ? cls.className.slice(0, -suffix.length) : cls.className;

  // Die vollen Signaturlisten je Rolle – `parts[].members` ist für die Anzeige gedeckelt, ein
  // Interface mit zwölf von siebzehn Methoden wäre kein Interface (gleiche Trennung wie bei
  // `groupMembers` im Kohäsions-Schnitt).
  const roleMembers: SplitMember[][] = [];
  const parts: Part[] = roles
    .sort((a, b) => b.users.length - a.users.length || b.members.size - a.members.size)
    .map((r, gi) => {
      const list = [...r.members].sort();
      const picked = list.map((n) => api.find((m) => m.name === n)).filter(Boolean) as SplitMember[];
      roleMembers.push(picked);
      const { name, guessed } = nameFor(picked.length ? picked : [], cls, gi);
      const users = r.users.map((u) => u.className).sort();
      return {
        // Ein Interface heißt nach dem, was es KANN, nicht nach dem, was es ist – aber wenn nichts
        // trägt, ist `<Klasse>Api2` ehrlicher als ein erfundenes Wort.
        name: guessed ? `${baseName}Api${gi + 1}` : name,
        nameGuessed: guessed,
        reason: `${users.slice(0, USERS_SHOWN).join(', ')}${users.length > USERS_SHOWN ? ` and ${users.length - USERS_SHOWN} more` : ''} only ever ${list.length === 1 ? 'calls' : 'call'} ${list.length} of the ${api.length} public methods.`,
        members: list.slice(0, MEMBERS_SHOWN).map((n) => {
          const m = picked.find((p) => p.name === n);
          return {
            name: n,
            kind: 'method',
            line: m?.line ?? null,
            complexity: m ? cyclomatic(m.body || '') : 0,
            // Ein Mitglied, das die Kante nennt, das die Klasse aber nicht (mehr) hat, bekommt
            // keine erfundene Signatur – der Name allein ist die ganze Auskunft.
            signature: m ? signatureOf(m) : n,
          };
        }),
        moreMembers: Math.max(0, list.length - MEMBERS_SHOWN),
        memberCount: list.length,
        fields: [],
        loc: 0,
        complexity: picked.reduce((s, m) => s + cyclomatic(m.body || ''), 0),
      };
    });

  const overlap = [...used].filter((n) => roles.filter((r) => r.members.has(n)).length > 1).sort();
  const widest = Math.max(...roles.map((r) => r.members.size));
  // Eignung: je kleiner der größte Ausschnitt gegen die ganze Klasse, desto mehr bringt der Schnitt.
  const fit = Math.max(0, Math.min(1, 1 - widest / Math.max(1, api.length)));

  // --- Die Dateien ------------------------------------------------------------------------------
  // ⚠️ Ein Interface trägt SIGNATUREN, keine Rümpfe – anders als beim Zustands-Schnitt, wo die
  // Methode wirklich umzieht. Hier bleibt jede Zeile der Klasse, wo sie ist; genau das ist die
  // Aussage dieses Schnitts, und ein Interface mit Rumpf würde sie unterlaufen.
  const files: SplitFile[] = parts.map((p, gi) => {
    const list = roleMembers[gi] || [];
    const body = [
      `public interface ${p.name} {`,
      ...list.map((m) => `${INDENT}${m.returnType ? `${m.returnType} ` : ''}${m.name}(${paramList(m)});`),
      '}',
    ].join('\n');
    return asFile(cls.package, p.name, 'new', p.reason, javaFile(cls.package, imports, body));
  });

  // Die Klasse selbst: EINE Zeile ändert sich. Sie steht trotzdem als Datei da, weil „nur
  // implements dazuschreiben" ohne den Anblick der Zeile eine Behauptung bleibt – und weil der
  // Kommentar darunter die eigentliche Nachricht ist: darunter ändert sich nichts.
  const sample = (roleMembers[0] || [])[0];
  files.push(
    asFile(
      cls.package,
      cls.className,
      'excerpt',
      `Only the first line changes. ${cls.className} keeps every field, every method and every body it has — it just says which of the lists it can serve, and it already can: these methods are its own.`,
      [
        `public class ${cls.className} implements ${parts.map((p) => p.name).join(', ')} {`,
        '',
        `${INDENT}// everything below stays exactly as it is —`,
        `${INDENT}// ${members.filter((m) => m.kind === 'method').length} methods, same code, only an @Override on top`,
        ...(sample ? ['', `${INDENT}@Override`, methodText(sample)] : []),
        '}',
      ].join('\n') + '\n',
    ),
  );

  return {
    files,
    id: 'roles',
    title: 'Split what the others see',
    verdict: fit >= 0.4 ? 'strong' : 'weak',
    fit,
    headline: `${roles.length} groups of callers, and none of them needs the whole class.`,
    why: `${naming.length} classes call into this one. The widest of them uses ${widest} of ${api.length} public methods — the rest of the API is noise it still has to compile against.`,
    parts,
    shared: overlap.map((n) => ({
      name: n,
      type: 'method',
      parts: parts.filter((p) => p.members.some((m) => m.name === n) || p.memberCount > MEMBERS_SHOWN).map((p) => p.name),
    })),
    cost:
      overlap.length
        ? `${overlap.length} ${overlap.length === 1 ? 'method appears' : 'methods appear'} in more than one interface — that is allowed, the class implements both.`
        : 'No method appears in two interfaces — the caller groups are cleanly separate.',
    gain: `${cls.className} keeps its code and only adds "implements". Each caller then depends on the part it actually uses.`,
  };
}

/**
 * Schnitt entlang der METHODEN: eine einzelne trägt die Entscheidungen.
 *
 * ⚠️ Der Fall, in dem „teile die Klasse" die falsche Antwort wäre. Eine Klasse mit acht kurzen
 * Methoden und einer, die 40 Verzweigungen hält, ist keine zu große Klasse – sie hat eine zu große
 * Methode, und jede Aufteilung nähme sie mit in ihren neuen Ort.
 */
function branchingSplit(cls: SplitClass, members: SplitMember[], imports: string[]): Strategy {
  const withBody = members.filter((m) => m.kind !== 'field' && (m.body || '').trim());
  const scored = withBody
    .map((m) => ({ m, cx: cyclomatic(m.body || ''), lines: countCodeLines(m.body || '') }))
    .sort((a, b) => b.cx - a.cx || b.lines - a.lines || a.m.name.localeCompare(b.m.name));
  const total = scored.reduce((s, x) => s + x.cx, 0);

  const none = (why: string): Strategy => ({
    id: 'branching',
    title: 'Split the method, not the class',
    verdict: 'none',
    fit: 0,
    headline: 'No single method dominates.',
    why,
    parts: [],
    files: [],
    shared: [],
    cost: null,
    gain: null,
  });

  // ⚠️ Der Treiber der Rangliste und dieser Schnitt können sich zu WIDERSPRECHEN scheinen, und das
  // muss dastehen: „branching" heißt dort, dass diese Klasse mehr Verzweigungen hält als die
  // anderen – ein Vergleich ZWISCHEN Klassen. Hier wird gefragt, ob sie in EINER Methode stecken.
  // Beides ist richtig und meint nicht dasselbe; ohne den Satz liest man die Rangliste oder den
  // Plan als Fehler, und der Verdacht bleibt danach an beiden hängen.
  const spread = (n: number) =>
    cls.driver === 'branching'
      ? ` The ranking calls this class a branching hotspot because it has more branches than the rest of this workspace — but they sit in ${n} different methods, not in one.`
      : '';

  if (!scored.length || !total) return none('No method bodies are stored for this class yet — re-run the analysis to measure them.');
  const top = scored[0];
  const share = top.cx / total;
  const busy = scored.filter((x) => x.cx > 1).length;
  // ⚠️ Die absolute Zahl zuerst, der Anteil erst danach. Andersherum wäre jede kleine Klasse ein
  // Fund: bei sechs Verzweigungen insgesamt hält die größte Methode zwangsläufig ein Drittel.
  if (top.cx < MIN_HOT_BRANCHES) {
    return none(
      `No method here is big enough to be the problem — the heaviest (${top.m.name}) holds ${top.cx} ${top.cx === 1 ? 'branch' : 'branches'}. This class may be long, but no single method in it is tangled.${spread(busy)}`,
    );
  }
  if (share < 0.3) {
    return none(
      `The decisions are spread evenly — the heaviest method (${top.m.name}, ${top.cx} branches) holds only ${Math.round(share * 100)} % of them. There is no single place to start.${spread(busy)}`,
    );
  }

  // Ein `switch` oder eine lange `else if`-Kette ist nicht dieselbe Aufgabe wie eine tiefe
  // Schleife: das eine ruft nach je einer Klasse pro Fall, das andere nach kürzeren Methoden.
  const code = stripNonCode(top.m.body || '');
  const cases = (code.match(/(?<![\w$])case(?![\w$])/g) || []).length;
  const elseIfs = (code.match(/(?<![\w$])else\s+if(?![\w$])/g) || []).length;
  const dispatch = cases >= 3 || elseIfs >= 3;

  const rest = scored.slice(1);
  const asMember = (x: (typeof scored)[number]) => ({
    name: x.m.name,
    kind: x.m.kind,
    line: x.m.line,
    complexity: x.cx,
    signature: signatureOf(x.m),
  });

  // ⚠️ ZWEI Teile, und der zweite ist die Klasse selbst. Eine einzige Karte, die alle Methoden
  // aufzählt, aber wie eine neue Klasse heißt, behauptet, sie alle würden dorthin wandern – und
  // genau das ist bei diesem Schnitt nicht der Fall: es bewegt sich EINE Methode. Der zweite Teil
  // sagt deshalb ausdrücklich, dass der Rest bleibt, wo er ist.
  const parts: Part[] = [
    {
      // Beim Extract entsteht kein neuer Typ, also trägt der Teil den Namen der METHODE – einen
      // Klassennamen hinzuschreiben, den niemand anlegt, wäre eine Falschauskunft.
      name: dispatch
        ? `${cap(words(top.m.name)[words(top.m.name).length - 1] || 'case')}Handler`
        : `${top.m.name}()`,
      nameGuessed: dispatch,
      reason: dispatch
        ? `One class per case, chosen once instead of decided every time. ${top.m.name} then only picks the right one.`
        : `Stays in ${cls.className}, but broken into named steps — one method per block, so the name says what the block does.`,
      members: [asMember(top)],
      moreMembers: 0,
      memberCount: 1,
      fields: [],
      loc: top.lines,
      complexity: top.cx,
    },
  ];
  if (rest.length) {
    parts.push({
      name: cls.className,
      nameGuessed: false,
      reason: dispatch
        ? `Keeps its name and every caller — from here on it only picks the right handler.`
        : `The other ${rest.length} ${rest.length === 1 ? 'method holds' : 'methods hold'} ${total - top.cx} ${total - top.cx === 1 ? 'branch' : 'branches'} between them. Nothing here has to move.`,
      members: rest.slice(0, METHODS_SHOWN).map(asMember),
      moreMembers: Math.max(0, rest.length - METHODS_SHOWN),
      memberCount: rest.length,
      fields: [],
      loc: 0,
      complexity: total - top.cx,
    });
  }

  // --- Die Dateien ------------------------------------------------------------------------------
  // ⚠️ Hier entsteht beim Extract-Fall KEINE neue Datei, und es wird auch keine erfunden: welche
  // Blöcke des Rumpfs zusammengehören, weiß die Rechnung nicht – das ist genau die Entscheidung,
  // die der Mensch trifft. Gezeigt wird deshalb die Methode, wie sie HEUTE dasteht: sie ist der
  // Gegenstand, und ein ausgedachtes „nachher" mit `validate()`/`calculate()` wäre ein Beispiel,
  // das mit diesem Code nichts zu tun hat.
  const files: SplitFile[] = [
    {
      ...asFile(
        cls.package,
        `${cls.className}.${top.m.name}`,
        'excerpt',
        `The method as it stands today — ${top.cx} branches in ${top.lines} lines. Every block you would put a comment above is a method waiting for a name.`,
        `${methodText(top.m).replace(new RegExp(`^${INDENT}`, 'gm'), '')}\n`,
      ),
      verbatim: true,
    },
  ];

  if (dispatch) {
    // ⚠️ Die Fallnamen werden aus dem ROHEN Rumpf gelesen, nicht aus `code`. `stripNonCode` blankt
    // String-Literale – und genau die SIND hier die Namen: aus `case "create":` wurde dort
    // `case        :`, alle Labels kamen leer an und es entstand keine einzige Fallklasse. Die
    // ZÄHLUNG oben bleibt auf `code` (`case` ist ein Schlüsselwort und in einem Kommentar nicht
    // gemeint), die BENENNUNG braucht den Originaltext.
    const labels = [...(top.m.body || '').matchAll(/(?<![\w$])case\s+([^:>]+?)\s*(?::|->)/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    const nameOfLabel = (raw: string) => {
      const clean = raw.replace(/['"]/g, '').split(',')[0].trim();
      const w = words(clean);
      return w.length ? `${w.map(cap).join('')}Case` : 'ACase';
    };
    const iface = `${cap(words(top.m.name)[words(top.m.name).length - 1] || 'case')}Handler`;
    // ⚠️ Worüber entschieden wird, steht im `switch` – nicht am ersten Parameter geraten. Bei
    // `route(String kind, String payload)` ist `kind` der Unterscheider und `payload` die Nutzlast;
    // beides zu verwechseln ergäbe eine `handles`-Methode, die die falsche Größe prüft.
    const switched = /(?<![\w$])switch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(code)?.[1];
    const disc = top.m.parameters.find((p) => p.name === switched) || top.m.parameters[0] || { type: 'String', name: 'kind' };
    // `handle` bekommt ALLE Parameter der Originalmethode: die Fallklasse braucht genau die Daten,
    // die der case-Block heute vor sich hat.
    const handleParams = paramList(top.m) || `${disc.type} ${disc.name}`;
    const handleArgs = top.m.parameters.map((p) => p.name).join(', ') || disc.name;

    files.push(
      asFile(
        cls.package,
        iface,
        'new',
        'One name for "handles a case". Every case in that switch does the same kind of job on different data — written down, each one can become its own small class.',
        javaFile(
          cls.package,
          imports,
          [
            `public interface ${iface} {`,
            `${INDENT}boolean handles(${disc.type} ${disc.name});`,
            `${INDENT}${top.m.returnType || 'void'} handle(${handleParams});`,
            '}',
          ].join('\n'),
        ),
      ),
    );

    for (const raw of labels.slice(0, 2)) {
      const cn = nameOfLabel(raw);
      files.push(
        asFile(
          cls.package,
          cn,
          'new',
          `One case, one file. Move the body that sits behind "case ${raw}" in ${top.m.name} into handle() — it is the same code, only with a door in front of it.`,
          javaFile(
            cls.package,
            imports,
            [
              `public class ${cn} implements ${iface} {`,
              `${INDENT}@Override`,
              `${INDENT}public boolean handles(${disc.type} ${disc.name}) {`,
              // Ein String-Label vergleicht man mit `equals`, eine Enum-/Zahl-Konstante mit `==`.
              // Die Anführungszeichen im Original sagen, welches von beidem es ist.
              `${INDENT}${INDENT}return ${/^["']/.test(raw) ? `${raw}.equals(${disc.name})` : `${disc.name} == ${raw}`};`,
              `${INDENT}}`,
              '',
              `${INDENT}@Override`,
              `${INDENT}public ${top.m.returnType || 'void'} handle(${handleParams}) {`,
              `${INDENT}${INDENT}// the body of case ${raw}, moved here unchanged`,
              `${INDENT}}`,
              '}',
            ].join('\n'),
          ),
        ),
      );
    }

    const ret = top.m.returnType && top.m.returnType !== 'void' ? 'return ' : '';
    files.push(
      asFile(
        cls.package,
        cls.className,
        'excerpt',
        `${top.m.name} stops deciding and starts picking. It keeps its name and its callers; what disappears is the chain of cases. Adding a case is a new file from here on — so it cannot break one that already works.`,
        javaFile(
          cls.package,
          imports,
          [
            `public class ${cls.className} { // … every other field and method stays as it is`,
            '',
            `${INDENT}// one new field — add it to the constructor you already have`,
            `${INDENT}private final java.util.List<${iface}> handlers;`,
            '',
            `${INDENT}${top.m.modifiers.join(' ')}${top.m.modifiers.length ? ' ' : ''}${top.m.returnType ? `${top.m.returnType} ` : ''}${top.m.name}(${paramList(top.m)}) {`,
            `${INDENT}${INDENT}${ret}handlers.stream()`,
            `${INDENT}${INDENT}${INDENT}.filter(h -> h.handles(${disc.name}))`,
            `${INDENT}${INDENT}${INDENT}.findFirst().orElseThrow()`,
            `${INDENT}${INDENT}${INDENT}.handle(${handleArgs});`,
            `${INDENT}}`,
            '}',
          ].join('\n'),
        ),
      ),
    );
  }

  return {
    files,
    id: 'branching',
    title: 'Split the method, not the class',
    verdict: share >= 0.45 || top.cx >= 15 ? 'strong' : 'weak',
    fit: Math.max(0, Math.min(1, share * 1.4)),
    headline: `${top.m.name} alone holds ${Math.round(share * 100)} % of the decisions in this class.`,
    why: dispatch
      ? `It is a dispatch: ${cases >= 3 ? `${cases} cases` : `${elseIfs} else-if branches`} in one method. Every new case makes it longer, and every case can break the others.`
      : `${top.cx} branches in ${top.lines} lines. Nothing else in this class comes close — the file is not the problem, this method is.`,
    parts,
    shared: [],
    cost: 'Nothing moves between files unless you want it to — this is the one change you can make without touching a single caller.',
    gain: dispatch
      ? 'Adding a case stops being an edit to existing code and becomes a new file.'
      : `${top.m.name} becomes readable in one screen, and each extracted step can be tested on its own.`,
  };
}

// --- Die eine Antwort ---------------------------------------------------------------------------

/**
 * Der Aufteilungsvorschlag zu einer Klasse.
 *
 * ⚠️ Welche Strategie FÜHRT, entscheidet die gerechnete Eignung – nicht der Treiber aus der
 * Rangliste. Der Treiber sagt, warum die Klasse oben steht; ob ein Schnitt entlang der Felder hier
 * tatsächlich etwas bringt, sagt nur die Rechnung. Er bleibt der Stichentscheid bei Gleichstand:
 * dann ist es der Schnitt, der zur Ursache passt.
 */
export function buildSplitPlan(
  cls: SplitClass,
  members: SplitMember[],
  consumers: SplitConsumer[],
  imports: string[] = [],
): any {
  const driverStrategy: Record<string, string> = {
    size: 'cohesion',
    branching: 'branching',
    coupling: 'roles',
    churn: 'cohesion',
  };
  const preferred = driverStrategy[cls.driver || ''] || 'cohesion';

  const strategies = [
    cohesionSplit(cls, members, imports, consumers),
    roleSplit(cls, members, consumers, imports),
    branchingSplit(cls, members, imports),
  ].sort((a, b) => {
    const d = b.fit - a.fit;
    if (Math.abs(d) > 0.05) return d;
    if (a.id === preferred) return -1;
    if (b.id === preferred) return 1;
    return 0;
  });

  const fields = members.filter((m) => m.kind === 'field');
  const methods = members.filter((m) => m.kind === 'method');
  const lead = strategies.find((s) => s.verdict !== 'none') || null;

  return {
    class: {
      id: cls.id,
      className: cls.className,
      package: cls.package,
      type: cls.type,
      loc: cls.loc,
      complexity: cls.complexity,
      methods: methods.length,
      publicMethods: methods.filter(isPublic).length,
      fields: fields.length,
      stateFields: fields.filter((f) => !(isStatic(f) && f.modifiers.includes('final'))).length,
      callers: consumers.length,
      driver: cls.driver,
    },
    // Der führende Vorschlag steht zuerst; `lead` nennt ihn beim Namen, damit die Oberfläche nicht
    // dieselbe Auswahl ein zweites Mal treffen muss.
    lead: lead?.id || null,
    // ⚠️ „Kein Vorschlag" ist ein ERGEBNIS und braucht seinen Satz. Eine leere Karte liest sich wie
    // ein Fehler der Rechnung, dabei ist das hier die gute Nachricht: eine Klasse kann groß sein
    // und trotzdem genau eine Sache tun – dann ist Aufteilen die falsche Handlung, und das zu sagen
    // ist mehr wert als ein Schnitt, den man hinterher bereut. Gleiche Regel wie beim Leerzustand
    // des Berichts und beim „self-contained" im Reiter Outside.
    summary: lead
      ? null
      : `Nothing here comes apart cleanly. ${cls.className} is heavy, but it is one thing — every method works on the same fields, no caller uses only a corner of it, and no single method carries the branches. Leaving it alone is a decision, not a lack of one.`,
    strategies,
    // ⚠️ Die Grenze der Auskunft gehört in die Antwort, nicht in einen Tooltip: die Zuordnung
    // „Methode benutzt Feld" ist eine Textsuche, und eine lokale Variable gleichen Namens zählt mit.
    limits: [
      'Field use is read from the method bodies as text — a local variable with the same name counts as a use.',
      'Constructors and static constants are left out on purpose: they touch everything and would tie every group to every other.',
      ...(consumers.length ? [] : ['Nothing in this workspace calls this class, so the caller-side split has nothing to work with.']),
    ],
  };
}
