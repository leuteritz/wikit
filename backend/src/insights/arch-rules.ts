/**
 * Architektur-Regeln: **wie dieser Code sein SOLL** – und wo er es gerade nicht ist.
 *
 * Jeder andere Reiter des Berichts beobachtet. Er misst, zählt, rangiert – und muss dabei raten,
 * was davon gewollt ist. Am deutlichsten an `LAYER_RANK` (weiter unten): dass `web` über `service`
 * über `repo` liegt, ist eine **Konvention**, und die Oberfläche musste sie deshalb als Vermutung
 * formulieren („looks like"). Hier schreibt der Betreiber sie stattdessen auf, und aus der
 * Vermutung wird eine Vereinbarung, gegen die man messen kann.
 *
 * Der Text ist die Quelle – eine Regel je Zeile, `#` für alles, was keine ist:
 *
 * ```text
 * # Die Weboberfläche geht nie direkt an die Datenbank.
 * web -/-> repo
 * only service -> repo
 * domain -/-> *
 * layers: web > service > domain > repo
 * ```
 *
 * ⚠️ **Diese Datei kennt keine Datenbank** – gleiche Bauart wie `test-shadow.ts` und
 * `split-plan.ts`: hinein gehen Klassen und aufgelöste Paare, heraus kommt der Befund. Der
 * Speicherort (eine Zeile in `settings`) und das Laden liegen im Service.
 *
 * ⚠️ **Und die wichtigste Festlegung ist der dritte Zustand.** Eine Regel ist nicht nur „verletzt"
 * oder „erfüllt", sondern kann auch **wirkungslos** sein: `shop.legacy -/-> *` sieht aus wie eine
 * Regel, trifft aber keine einzige Klasse – fast immer ein Tippfehler im Packagenamen. Ohne diesen
 * Zustand liest sich genau der Tippfehler als grüner Haken, und das ist die schlechteste Auskunft,
 * die eine Regelprüfung geben kann: sie behauptet, geprüft zu haben.
 */

// --- Die Schicht-Konvention ---------------------------------------------------------------------
//
// ⚠️ Übliche Schichtnamen, von aussen nach innen. Eine KONVENTION, keine Wahrheit – aber eine, die
// trägt: läuft eine Kante von einer tieferen Schicht zurück nach oben (repo -> web), ist sie fast
// immer das Versehen und nicht die Absicht.
//
// Sie steht hier und nicht mehr im Service, weil sie jetzt ZWEI Verwender hat: den Rückfall der
// Zyklen-Bruchstelle (wenn niemand Schichten aufgeschrieben hat) und den Vorschlag in diesem Reiter
// („diese vier Schichten liegen bei dir – als Regel festhalten?"). Zwei Fassungen davon wären zwei
// Konventionen, und die Bruchstelle erklärte sich dann mit einer anderen als der, die vorgeschlagen
// wird.
export const LAYER_RANK: Record<string, number> = {
  ui: 0, web: 0, controller: 0, controllers: 0, rest: 0, view: 0, views: 0,
  service: 1, services: 1, application: 1, usecase: 1, business: 1,
  domain: 2, model: 2, entity: 2, entities: 2,
  repo: 3, repository: 3, repositories: 3, dao: 3, persistence: 3, store: 3, db: 3,
};

export const layerOf = (path: any): number | undefined =>
  LAYER_RANK[String(path ?? '').split('.').pop()!.toLowerCase()];

/**
 * Läuft diese Kante gegen die übliche Richtung? Nur entscheidbar, wenn BEIDE Enden erkannt werden –
 * sonst ist die Antwort „weiss nicht" und nicht „nein".
 */
export const againstLayers = (from: any, to: any): boolean => {
  const a = layerOf(from);
  const b = layerOf(to);
  return a != null && b != null && a > b;
};

// --- Typen --------------------------------------------------------------------------------------

export type RuleKind = 'forbid' | 'only' | 'layers';

/**
 * Ein Muster benennt eine Menge von Klassen. Vier Formen, und keine davon ist geraten – jede folgt
 * einer Java-Konvention, die im Code sichtbar dasteht:
 *
 *   * `*`                     – alles (`all`)
 *   * `com.acme.web`          – dieses Package und seine Unterpackages (`prefix`)
 *   * `com.acme.web.OrderApi` – genau diese eine Klasse (`fqcn`; letztes Segment gross)
 *   * `web`                   – jedes Package, das dieses Segment führt (`segment`)
 *   * `OrderService`          – jede Klasse dieses Namens (`class`; beginnt gross)
 *
 * ⚠️ Warum `segment` und nicht nur Präfixe: die Schicht steht in echten Projekten selten ganz vorn.
 * `com.acme.shop.web` und `com.acme.billing.web` sind beide „web", und wer das als Präfix schreiben
 * müsste, schriebe zwei Regeln für eine Aussage. Deshalb greift ein punktloses Muster auf jedes
 * Segment des Pfades – `web` trifft `com.acme.shop.web` ebenso wie `com.acme.web.api`.
 */
export type PatternKind = 'all' | 'prefix' | 'fqcn' | 'segment' | 'class';
export type Pattern = { raw: string; kind: PatternKind };

export type Rule = {
  /** 1-basierte Zeile im Regeltext – die Oberfläche stellt den Befund neben seine Zeile. */
  line: number;
  /** Die Zeile, wie sie dasteht (ohne den Inline-Kommentar). */
  source: string;
  kind: RuleKind;
  /** `forbid` / `only`: die beiden Seiten. */
  from?: Pattern;
  to?: Pattern;
  /** `layers`: von aussen nach innen. */
  layers?: Pattern[];
  /** Der `#`-Kommentar direkt darüber oder dahinter – das WARUM der Regel. */
  note: string;
};

export type RuleError = { line: number; source: string; message: string };

export type RuleClass = { id: number; className: string; package: string };
export type RulePair = { from: number; to: number; kind: string; count: number; members: string[] };

// Wie viele verletzende Beziehungen eine Regel namentlich nennt. Der Rest wird gezählt: eine Regel,
// gegen die 300 Kanten verstossen, ist ein Befund und keine Liste, die man abarbeitet.
const VIOLATION_SAMPLE = 12;
// Wie viele Vorschläge angeboten werden. Vier bei den Link-Vorschlägen, fünf hier – dieselbe
// Überlegung: die Liste bietet eine HANDLUNG an, und wer zehn Vorschläge sieht, hakt keinen ab.
const SUGGEST_LIMIT = 5;
// Ab wie vielen Beziehungen eine Einbahnstrasse als Vorschlag taugt. Eine einzelne Kante zwischen
// zwei Packages ist noch keine Richtung, die jemand festhalten will – sie kann morgen die
// Gegenrichtung haben, ohne dass jemand etwas entschieden hätte.
const SUGGEST_MIN_EDGES = 3;

// --- Der Parser ---------------------------------------------------------------------------------

const ARROW_FORBID = /^(.+?)\s*-\/->\s*(.+)$/;
const ARROW_ONLY = /^only\s+(.+?)\s*-{1,2}>\s*(.+)$/i;
const LAYERS = /^layers?\s*:\s*(.+)$/i;

/**
 * Ein einzelnes Muster lesen. Entschieden wird über die Java-Konvention (Packages klein, Typen
 * gross) – dieselbe Regel, mit der `splitImport` im Service eine Importzeile zerlegt.
 */
export function parsePattern(raw: string): Pattern {
  let s = raw.trim();
  if (!s || s === '*') return { raw: '*', kind: 'all' };
  // `com.acme.web.*` ist die Schreibweise, die jeder erwartet – sie bedeutet dasselbe wie das
  // Präfix ohne Stern, denn ein Präfix schliesst seine Unterpackages ohnehin ein.
  if (s.endsWith('.*')) s = s.slice(0, -2);
  const segs = s.split('.');
  const last = segs[segs.length - 1] || '';
  const startsUpper = /^[A-Z]/.test(last);
  if (segs.length === 1) return { raw: s, kind: startsUpper ? 'class' : 'segment' };
  return { raw: s, kind: startsUpper ? 'fqcn' : 'prefix' };
}

/** Passt diese Klasse auf das Muster? */
export function matches(p: Pattern, c: RuleClass): boolean {
  const pkg = c.package || '';
  switch (p.kind) {
    case 'all':
      return true;
    case 'class':
      return c.className === p.raw;
    case 'fqcn':
      return (pkg ? `${pkg}.${c.className}` : c.className) === p.raw;
    case 'prefix':
      return pkg === p.raw || pkg.startsWith(`${p.raw}.`);
    case 'segment':
      return pkg.split('.').includes(p.raw);
  }
}

/**
 * Den Regeltext lesen.
 *
 * ⚠️ Fehler brechen den Lauf NICHT ab. Eine unverständliche Zeile darf die zwölf darunter nicht
 * mitreissen – sonst verschwindet beim ersten Tippfehler der ganze Befund, und die Ansicht sieht
 * aus, als sei alles in Ordnung. Sie wird gemeldet und übersprungen, und die Oberfläche stellt die
 * Meldung neben ihre Zeile.
 */
export function parseRules(text: string): { rules: Rule[]; errors: RuleError[] } {
  const rules: Rule[] = [];
  const errors: RuleError[] = [];
  // Der Kommentar DIREKT über einer Regel ist ihre Begründung. Eine Leerzeile dazwischen löst die
  // Bindung – sonst erbt eine Regel die Überschrift eines ganzen Abschnitts als ihr „warum".
  let pending: string[] = [];

  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = i + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) {
      pending = [];
      return;
    }
    if (trimmed.startsWith('#')) {
      pending.push(trimmed.replace(/^#+\s*/, ''));
      return;
    }

    // Inline-Kommentar hinter der Regel. ` # ` mit Leerzeichen davor, damit ein `#` in einem
    // Muster (das es nicht gibt, aber morgen geben könnte) die Zeile nicht zerschneidet.
    const hash = trimmed.indexOf(' #');
    const body = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
    const inline = hash >= 0 ? trimmed.slice(hash + 2).trim() : '';
    const note = [...pending, inline].filter(Boolean).join(' ');
    pending = [];

    const fail = (message: string) => errors.push({ line, source: body, message });

    const layers = body.match(LAYERS);
    if (layers) {
      const parts = layers[1].split('>').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) {
        fail('A layer rule needs at least two layers, outermost first — for example: layers: web > service > repo');
        return;
      }
      const seen = new Set<string>();
      const dup = parts.find((p) => (seen.has(p) ? true : (seen.add(p), false)));
      if (dup) {
        fail(`“${dup}” appears twice in the same layer rule — a layer can only sit at one depth`);
        return;
      }
      rules.push({ line, source: body, kind: 'layers', layers: parts.map(parsePattern), note });
      return;
    }

    const only = body.match(ARROW_ONLY);
    if (only) {
      const from = parsePattern(only[1]);
      const to = parsePattern(only[2]);
      if (to.kind === 'all') {
        fail('“only … -> *” would forbid every relation in the codebase — name the package that should be protected');
        return;
      }
      rules.push({ line, source: body, kind: 'only', from, to, note });
      return;
    }

    const forbid = body.match(ARROW_FORBID);
    if (forbid) {
      const from = parsePattern(forbid[1]);
      const to = parsePattern(forbid[2]);
      if (from.kind === 'all') {
        fail('“* -/-> …” would forbid the package from being used at all, including by itself — name the side that must not reach in');
        return;
      }
      rules.push({ line, source: body, kind: 'forbid', from, to, note });
      return;
    }

    if (/->/.test(body)) {
      fail('A plain arrow does not say anything yet — write “a -/-> b” to forbid it, or “only a -> b” to restrict it');
      return;
    }
    fail('Not a rule — expected “a -/-> b”, “only a -> b” or “layers: a > b > c”');
  });

  return { rules, errors };
}

/** Die Regel wieder als Text – EINE Fassung, aus der Struktur erzeugt (Vorschläge nutzen sie). */
export function formatRule(r: Pick<Rule, 'kind' | 'from' | 'to' | 'layers'>): string {
  if (r.kind === 'layers') return `layers: ${(r.layers || []).map((p) => p.raw).join(' > ')}`;
  if (r.kind === 'only') return `only ${r.from?.raw} -> ${r.to?.raw}`;
  return `${r.from?.raw} -/-> ${r.to?.raw}`;
}

// --- Die Prüfung --------------------------------------------------------------------------------

/**
 * Alle Regeln gegen den aufgelösten Graphen prüfen.
 *
 * `pairs` sind dieselben Klassenpaare, aus denen auch Zyklen und Kennzahlen entstehen – also
 * `java_edges` und ausdrücklich NICHT die Importzeilen. Eine Importzeile nennt eine Klasse, benutzt
 * sie aber nicht; eine Regel gegen einen „leftover import" durchzusetzen hiesse, jemanden auf eine
 * Abhängigkeit hinzuweisen, die es zur Laufzeit nicht gibt (dieselbe Begründung wie im ganzen
 * übrigen Bericht).
 */
export function checkRules(rules: Rule[], classes: RuleClass[], pairs: RulePair[]): any[] {
  const byId = new Map<number, RuleClass>(classes.map((c) => [c.id, c]));
  // Ein Muster wird EINMAL gegen den Bestand aufgelöst, auch wenn es in drei Regeln steht: bei
  // 1500 Klassen und zwanzig Regeln ist das der Unterschied zwischen einem Durchlauf und dreissig.
  const cache = new Map<string, Set<number>>();
  const setOf = (p: Pattern): Set<number> => {
    const key = `${p.kind}\u0000${p.raw}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = new Set<number>();
      for (const c of classes) if (matches(p, c)) hit.add(c.id);
      cache.set(key, hit);
    }
    return hit;
  };

  const label = (id: number) => byId.get(id)?.className || String(id);
  const pkgOf = (id: number) => byId.get(id)?.package || '';
  const cite = (p: RulePair) => ({
    fromId: p.from,
    from: label(p.from),
    fromPkg: pkgOf(p.from),
    toId: p.to,
    to: label(p.to),
    toPkg: pkgOf(p.to),
    kind: p.kind,
    count: p.count,
    members: p.members,
  });

  return rules.map((rule) => {
    const patterns: Pattern[] = rule.kind === 'layers' ? rule.layers! : [rule.from!, rule.to!];
    // Ein Muster, auf das keine einzige Klasse passt. Das ist der Tippfehler-Befund – und er wird
    // getrennt geführt statt in „verletzt/erfüllt" gemischt, weil er eine ANDERE Handlung verlangt:
    // nicht Code ändern, sondern die Regel.
    const unmatched = patterns.filter((p) => p.kind !== 'all' && setOf(p).size === 0).map((p) => p.raw);

    let violations: RulePair[] = [];
    // Wie viele Beziehungen die Regel überhaupt angesehen hat. „Erfüllt" allein ist schwach – „gilt
    // für 42 Beziehungen, keine verletzt sie" ist die Aussage, die man haben will.
    let checked = 0;

    if (rule.kind === 'forbid') {
      const from = setOf(rule.from!);
      const to = setOf(rule.to!);
      for (const p of pairs) {
        if (!from.has(p.from)) continue;
        // ⚠️ `web -/-> *` heisst „web greift nach draussen nicht", nicht „web darf sich selbst
        // nicht benutzen". Ohne diese Zeile meldete die Regel jede Beziehung INNERHALB des
        // Packages als Verstoss – also ausgerechnet den Normalfall.
        if (rule.to!.kind === 'all' && from.has(p.to)) continue;
        checked++;
        if (to.has(p.to)) violations.push(p);
      }
    } else if (rule.kind === 'only') {
      const from = setOf(rule.from!);
      const to = setOf(rule.to!);
      for (const p of pairs) {
        if (!to.has(p.to)) continue;
        // Eine Klasse des geschützten Bereichs darf ihn selbst benutzen: `only service -> repo`
        // sagt etwas über die Zugriffe von aussen, nicht darüber, ob zwei Repositories einander
        // kennen dürfen.
        if (to.has(p.from)) continue;
        checked++;
        if (!from.has(p.from)) violations.push(p);
      }
    } else {
      // `layers`: der Rang einer Klasse ist der Index des ERSTEN Musters, das sie trifft – die
      // Reihenfolge der Zeile ist damit auch die Entscheidungsregel bei Überschneidungen.
      const sets = rule.layers!.map((p) => setOf(p));
      const rankOf = (id: number): number => sets.findIndex((s) => s.has(id));
      for (const p of pairs) {
        const a = rankOf(p.from);
        const b = rankOf(p.to);
        // Eine Klasse ausserhalb jeder genannten Schicht ist keine Aussage – dieselbe Regel wie bei
        // `againstLayers`: entschieden wird nur, wenn BEIDE Enden erkannt werden.
        if (a < 0 || b < 0 || a === b) continue;
        checked++;
        if (a > b) violations.push(p);
      }
    }

    // Nach Gewicht: die Beziehung mit den meisten Fundstellen ist die, die am meisten hält – und
    // damit die, an der man den Verstoss am ehesten sieht.
    violations = violations.sort((a, b) => b.count - a.count || label(a.from).localeCompare(label(b.from)));

    return {
      line: rule.line,
      source: rule.source,
      kind: rule.kind,
      note: rule.note,
      text: formatRule(rule),
      // ⚠️ Der dritte Zustand ist ABGELEITET und nicht gemerkt: „wirkungslos" heisst „nichts
      // verletzt sie, und mindestens eine ihrer Seiten gibt es hier gar nicht".
      status: violations.length ? 'violated' : unmatched.length ? 'inert' : 'holds',
      unmatched,
      checked,
      count: violations.length,
      violations: violations.slice(0, VIOLATION_SAMPLE).map(cite),
      more: Math.max(0, violations.length - VIOLATION_SAMPLE),
    };
  });
}

/**
 * Aus dem Vergleich einer Regel mit dem Bestand wird ein Schichtvergleich für die
 * Zyklen-Bruchstelle: dieselbe Frage wie `againstLayers`, nur mit der aufgeschriebenen statt der
 * geratenen Ordnung.
 *
 * Zurück kommt eine Funktion über PACKAGE-Pfade, weil die Bruchstelle auf der Package-Ebene
 * entschieden wird (ein Klassenname trägt keine Schicht). Gibt es keine `layers`-Regel, ist das
 * Ergebnis `null` – und der Aufrufer fällt auf die Konvention zurück.
 */
export function layerCheckFrom(rules: Rule[]): ((from: any, to: any) => boolean) | null {
  const rule = rules.find((r) => r.kind === 'layers');
  if (!rule) return null;
  const patterns = rule.layers!;
  // Ein Package statt einer Klasse: `matches` fragt nach beidem, also bekommt es einen Datensatz
  // ohne Klassennamen. Der leere Name kann nur auf ein `class`-/`fqcn`-Muster passen, und das soll
  // er hier auch nicht.
  const rankOf = (path: any): number =>
    patterns.findIndex((p) => matches(p, { id: -1, className: '\u0000', package: String(path ?? '') }));
  return (from: any, to: any) => {
    const a = rankOf(from);
    const b = rankOf(to);
    return a >= 0 && b >= 0 && a > b;
  };
}

// --- Vorschläge ---------------------------------------------------------------------------------

/**
 * Was dieser Code heute schon einhält – als Regel formuliert.
 *
 * ⚠️ Der Grund für diesen Teil ist das leere Textfeld. „Schreib deine Architektur auf" ist eine
 * Aufforderung, der niemand nachkommt, solange er dafür die Sprache lernen und seine Packages
 * durchzählen muss. Der Bestand kennt beides bereits: eine Beziehung, die es in einer Richtung
 * zwanzigmal gibt und in der Gegenrichtung kein einziges Mal, IST eine Entscheidung – sie steht nur
 * nirgends. Angeboten wird sie deshalb fertig formuliert, und der Klick schreibt sie in den Text.
 *
 * Was NICHT vorgeschlagen wird: alles, was heute verletzt wäre – mit einer Ausnahme, und die wird
 * angeschrieben (s. `wouldFlag` beim Schichtvorschlag). Eine Regel, die im Moment ihrer Übernahme
 * rot wird, sieht aus wie ein Fehler des Werkzeugs.
 */
export function suggestRules(classes: RuleClass[], pairs: RulePair[], existing: Rule[]): any[] {
  const have = new Set(existing.map((r) => formatRule(r)));
  const out: any[] = [];

  const pkgOf = new Map<number, string>(classes.map((c) => [c.id, c.package || '']));

  // Ein Package heisst im Vorschlag so kurz wie möglich: `com.acme.shop.web` wird zu `web`, sofern
  // kein zweites Package dieses Segment führt. Der lange Pfad wäre nicht falsch, aber eine Regel,
  // die man nicht vorlesen kann, schreibt niemand fort.
  const segCount = new Map<string, Set<string>>();
  for (const path of new Set(pkgOf.values())) {
    if (!path) continue;
    const last = path.split('.').pop()!;
    const set = segCount.get(last) || new Set<string>();
    set.add(path);
    segCount.set(last, set);
  }
  const shortOf = (path: string): string => {
    const last = path.split('.').pop()!;
    return segCount.get(last)?.size === 1 ? last : path;
  };

  // --- 1. Einbahnstrassen zwischen Packages -----------------------------------------------------
  const between = new Map<string, number>();
  for (const p of pairs) {
    const a = pkgOf.get(p.from) || '';
    const b = pkgOf.get(p.to) || '';
    if (!a || !b || a === b) continue;
    const key = `${a}\u0000${b}`;
    between.set(key, (between.get(key) || 0) + 1);
  }

  const oneWay: Array<{ from: string; to: string; weight: number }> = [];
  for (const [key, weight] of between) {
    const [a, b] = key.split('\u0000');
    if (between.has(`${b}\u0000${a}`)) continue; // beide Richtungen -> keine Entscheidung
    if (weight < SUGGEST_MIN_EDGES) continue;
    oneWay.push({ from: b, to: a, weight }); // vorgeschlagen wird das VERBOT der Gegenrichtung
  }
  oneWay.sort((x, y) => y.weight - x.weight);

  for (const w of oneWay) {
    const rule = { kind: 'forbid' as const, from: parsePattern(shortOf(w.from)), to: parsePattern(shortOf(w.to)) };
    const text = formatRule(rule);
    if (have.has(text)) continue;
    out.push({
      text,
      kind: 'forbid',
      // Der Satz sagt, WORAUF der Vorschlag beruht – nicht „so sollte es sein", sondern „so ist es
      // bei dir bereits". Ein Vorschlag, dessen Herkunft man nicht sieht, ist ein Ratschlag.
      why: `${shortOf(w.to)} uses ${shortOf(w.from)} in ${w.weight} relations. Nothing goes back the other way — today.`,
      wouldFlag: 0,
    });
    if (out.length >= SUGGEST_LIMIT - 1) break; // ein Platz bleibt für die Schichten
  }

  // --- 2. Die Schichten, die hier liegen --------------------------------------------------------
  // ⚠️ Genau hier wird `LAYER_RANK` ehrlich: statt die Konvention heimlich anzuwenden, wird sie
  // vorgeschlagen und muss bestätigt werden. Was heute dagegen läuft, steht daneben – ein
  // Vorschlag, der seine eigenen Kosten verschweigt, ist eine Werbung.
  const present = new Map<number, string[]>();
  for (const path of new Set(pkgOf.values())) {
    if (!path) continue;
    const rank = layerOf(path);
    if (rank == null) continue;
    const seg = path.split('.').pop()!.toLowerCase();
    const list = present.get(rank) || [];
    if (!list.includes(seg)) list.push(seg);
    present.set(rank, list);
  }
  if (present.size >= 2) {
    // Je Tiefe EIN Name – zwei Schreibweisen derselben Schicht (`repo` und `repository`) wären in
    // einer Zeile zwei Schichten und damit ein Widerspruch in sich.
    const layers = [...present.entries()].sort((a, b) => a[0] - b[0]).map(([, names]) => names.sort()[0]);
    const rule = { kind: 'layers' as const, layers: layers.map(parsePattern) };
    const text = formatRule(rule);
    if (!have.has(text)) {
      const check = layerCheckFrom([{ line: 0, source: text, kind: 'layers', layers: rule.layers, note: '' }]);
      let flagged = 0;
      if (check) {
        for (const p of pairs) {
          if (check(pkgOf.get(p.from) || '', pkgOf.get(p.to) || '')) flagged++;
        }
      }
      out.push({
        text,
        kind: 'layers',
        why: `These ${layers.length} layers all exist here, in this order.`,
        wouldFlag: flagged,
      });
    }
  }

  return out.slice(0, SUGGEST_LIMIT);
}
