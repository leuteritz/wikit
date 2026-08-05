// Größe und Verzweigungsdichte einer Klasse – die zwei Zahlen, die der Insights-Bereich braucht
// und die man einer Klasse ohne Werkzeug nicht ansieht.
//
// Warum hier und nicht im Parser: beides ist reine TEXT-Arbeit und braucht kein CST. Genau das
// macht den Nachtrag für den Altbestand überhaupt möglich – die Methodenrümpfe stehen bereits in
// `java_methods.body`, also entsteht die Komplexität einer nie wieder angefassten Klasse ohne einen
// einzigen Reparse (s. `backfillMetrics` in insights.service.ts). Ein Parser-Lauf über eine
// gewachsene Codebasis dauert Minuten; eine Regex-Zählung über dieselbe Menge Sekunden.
//
// Beide Zahlen sind NÄHERUNGEN und dürfen es sein: sie ranken Klassen gegeneinander, sie messen
// nichts absolut. Wichtig ist nur, dass die Näherung überall dieselbe ist.

// Java-Schlüsselwörter, die eine Verzweigung eröffnen. `else` zählt NICHT – es gehört zum `if`,
// das schon gezählt ist, und würde jede vollständige Fallunterscheidung doppelt bestrafen.
// `case` deckt auch die Pfeil-Form (`case A ->`) ab. `default:` ist keine Entscheidung.
const BRANCH_WORDS = ['if', 'for', 'while', 'case', 'catch'];

// `(?<![\w$])` statt `\b`: `$` ist in Java ein gültiges Identifier-Zeichen, und `\b` sieht es als
// Wortgrenze – `a$if` träfe sonst. Dieselbe Begründung wie in code-search.util.ts.
const BRANCH_RE = new RegExp(`(?<![\\w$])(?:${BRANCH_WORDS.join('|')})(?![\\w$])`, 'g');
// Kurzschluss-Operatoren und der ternäre Operator sind Verzweigungen ohne Schlüsselwort.
// `?` nur, wenn kein `?.`/`??` (die es in Java ohnehin nicht gibt) und kein Generic-Wildcard
// (`List<?>`) – deshalb die Prüfung auf ein folgendes `>`.
const OPERATOR_RE = /&&|\|\||\?(?!>)/g;

/**
 * Kommentare und Literale durch Leerzeichen ersetzen, Zeilenumbrüche erhalten.
 *
 * Ohne diesen Schritt zählt `// if this fails` als Verzweigung und `"a || b"` als zwei. Die
 * Umbrüche müssen stehen bleiben, weil dieselbe Funktion die Grundlage der Zeilenzählung ist.
 */
export function stripNonCode(source: string): string {
  const src = String(source || '');
  let out = '';
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out += src[k] === '\n' ? '\n' : ' ';
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Text-Block (Java 15+): läuft über mehrere Zeilen und endet erst am nächsten `"""`.
    if (c === '"' && next === '"' && src[i + 2] === '"') {
      const end = src.indexOf('"""', i + 3);
      const stop = end === -1 ? src.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === '\\') {
          k += 2;
          continue;
        }
        if (src[k] === c || src[k] === '\n') break;
        k++;
      }
      const stop = Math.min(k + 1, src.length);
      blank(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Codezeilen einer Quelle: alles ohne Leerzeilen und ohne reine Kommentarzeilen.
 *
 * Bewusst nicht die Zeilenzahl der Datei. Die Frage lautet „wie viel Klasse ist das?", und eine
 * Klasse mit 200 Zeilen Javadoc über 40 Zeilen Code ist keine große Klasse. Die Zahl heißt in der
 * Oberfläche deshalb „code lines" und nicht „lines" – sie stimmt absichtlich nicht mit der letzten
 * Zeilennummer im Editor überein.
 */
export function countCodeLines(source: string): number {
  if (!source) return 0;
  let n = 0;
  for (const line of stripNonCode(source).split('\n')) {
    if (line.trim()) n++;
  }
  return n;
}

/**
 * Zyklomatische Komplexität (McCabe) eines Methodenrumpfs: 1 + Zahl der Verzweigungen.
 *
 * Ein leerer Rumpf (Interface-Methode, abstrakte Methode) hat 0 statt 1 – sie entscheidet nichts,
 * und eine Interface-Datei mit zwanzig Signaturen sähe sonst so aus wie eine Klasse mit zwanzig
 * echten Methoden.
 */
export function cyclomatic(body: string): number {
  const code = stripNonCode(body || '');
  if (!code.trim()) return 0;
  const branches = (code.match(BRANCH_RE) || []).length + (code.match(OPERATOR_RE) || []).length;
  return 1 + branches;
}

/**
 * Die beiden Klassenspalten aus Quelltext + Rümpfen.
 *
 * `bodies` sind alle Mitglieder MIT Rumpf (Methoden, Konstruktoren, Initialisierer) – die
 * Klassenkomplexität ist ihre Summe. Ohne einen einzigen Rumpf (reines Interface, Record ohne
 * Methoden) bleibt sie 0, und das ist die richtige Aussage.
 */
export function classMetrics(source: string, bodies: Array<string | null | undefined>): {
  loc: number;
  complexity: number;
} {
  let complexity = 0;
  for (const b of bodies) complexity += cyclomatic(b || '');
  return { loc: countCodeLines(source), complexity };
}
