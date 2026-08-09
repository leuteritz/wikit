import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { stripNonCode } from './code-metrics';
import { parseJavaForEdges, JavaClassGraphInfo } from './java-parser';

/**
 * Die Kantenrechnung des Codegraphen – **ohne Datenbank**.
 *
 * Warum hier und nicht in `JavaService`: dieselbe Rechnung muss über zwei verschiedene Bestände
 * laufen. `recomputeAutoEdges` gibt ihr den heutigen Quelltext aus `java_files`, der Drift-Bericht
 * den von damals aus `java_file_versions`. Eine zweite Fassung für den zweiten Aufrufer wäre ein
 * zweiter Graph mit eigenen Auflösungsregeln – und ein Vergleich zwischen zwei verschieden
 * gerechneten Ständen misst am Ende die Unterschiede der beiden Rechnungen mit.
 *
 * Was hier NICHT steht: Tombstones, manuelle Kanten, Persistenz. Das sind Aussagen über den
 * *Bestand*, nicht über den *Code* – sie bleiben beim Aufrufer.
 */

// parseJavaForEdges() ist synchron (chevrotain). Ein Lauf über tausende Klassen blockiert den
// Event-Loop komplett – währenddessen antwortet der Server auf NICHTS, auch nicht auf das
// Queue-Polling. Alle YIELD_EVERY Klassen wird die Kontrolle deshalb kurz abgegeben.
const YIELD_EVERY = 25;
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

// --- Kanten-Identitaet: der einfache Name reicht nicht --------------------------------------
//
// `efw.util.http.Header` und `wt.doc.Header` sind zwei Klassen. Solange die Kantenberechnung nur
// mit einfachen Namen rechnete, verschmolzen sie zu einer: `definesMethod['Header']` enthielt die
// Methoden BEIDER, und wer die eine benutzte, bekam eine Kante zur anderen. Alles unten ist
// deshalb ueber den FQCN geschluesselt; der einfache Name bleibt nur die Beschriftung.
export const fqcnOf = (pkg: string, name: string): string => (pkg ? `${pkg}.${name}` : name);
export const simpleOf = (fqcn: string): string => fqcn.split('.').pop() || fqcn;

// Eine Klasse, wie die Rechnung sie braucht: Package, Quelltext, Importe. Woher das kommt –
// aktuelle Zeile oder alter Versions-Schnappschuss – ist ihr gleichgueltig.
export interface EdgeInput {
  pkg: string; // '' = default package
  source: string;
  imports: string[]; // FQCNs, inkl. `p.q.*`
}

// Eine berechnete Kante in genau der Form, in der sie auch in `java_edges` steht – damit der
// Aufrufer sie ohne Uebersetzungsschicht speichern oder mit gespeicherten vergleichen kann.
export interface ComputedEdge {
  source_class: string;
  source_pkg: string | null;
  target_class: string;
  target_pkg: string | null;
  method_name: string | null;
  confidence: number;
  kind: string;
}

export interface EdgeComputeResult {
  edges: ComputedEdge[];
  /** FQCNs aller erkannten Typen – die Bezugsgroesse jeder Aussage ueber diesen Stand. */
  fqcns: string[];
  /**
   * Typnamen, die weder Package noch Import noch Eindeutigkeit klaeren konnten. Dort entsteht
   * bewusst KEINE Kante; steht die Zahl hoch, fehlen Importe.
   */
  ambiguous: number;
}

// Ein analysierter Typ mit allem, was zum Aufloesen fremder Typnamen aus SEINER Sicht noetig ist.
type EdgeClass = {
  fqcn: string;
  name: string;
  pkg: string;
  info: JavaClassGraphInfo;
  imports: string[];
};

/**
 * Die Importzeilen eines Quelltexts – in **genau** der Form, in der `parseJava` sie liefert und
 * `java_dependencies` sie speichert: voller Name, `p.q.*` beim Sternchen, statische Importe mit
 * ihrem Mitglied (`p.q.Money.ZERO`).
 *
 * Warum nicht der Parser: eine Importzeile ist syntaktisch trivial, und wer den Stand von *damals*
 * auflösen will, müsste sonst den schweren Parser ein zweites Mal über jede geänderte Klasse
 * laufen lassen – für eine Liste, die zwischen `import` und `;` steht. Beide Stände lesen sie
 * deshalb hier; verschiedene Quellen für die zwei Seiten eines Vergleichs wären der sicherste Weg
 * zu einem Unterschied, den nicht der Code gemacht hat.
 *
 * ⚠️ `stripNonCode` zuerst: `// import p.q.Legacy;` ist kein Import, und ausgerechnet in einer
 * Codebasis mit auskommentierten Zeilen fiele das nie auf.
 */
const IMPORT_RE = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w$.]+(?:\.\*)?)[ \t]*;/gm;

export function importsFrom(source: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const code = stripNonCode(source || '');
  while ((m = IMPORT_RE.exec(code))) out.push(m[1]);
  return out;
}

/**
 * Geparste Kanten-Infos, geschlüsselt über den **Inhalt** (sha1 des Quelltexts).
 *
 * Der Hash statt einer Datei-Id oder Versionsspalte, weil damit kein Schreibpfad ein „invalidate"
 * braucht: genau diese Zeile vergisst man beim nächsten Endpunkt. Zwei Aufrufer teilen sich den
 * Cache deshalb gefahrlos – und der Drift-Bericht zahlt für eine *unveränderte* Klasse gar nichts,
 * weil ihr alter Stand byte-gleich mit dem heutigen ist und denselben Eintrag trifft.
 *
 * Der Deckel macht ihn zur Beschleunigung statt zu einem Zustand, der mitwächst: er fasst **zwei
 * volle Stände** einer Codebasis von 1500 Klassen – mehr vergleicht niemand auf einmal. Verdrängt
 * wird der am längsten nicht benutzte Eintrag (ein Treffer wandert ans Ende), sonst räumte ein
 * einziger Lauf über alte Versionen genau die aktuellen Klassen heraus.
 *
 * Als Provider im `@Global` CommonModule, damit Kantenberechnung und Drift-Bericht **denselben**
 * Cache benutzen: zwei Instanzen wären zweimal derselbe Parse-Lauf.
 */
const PARSE_CACHE_MAX = 3000;

@Injectable()
export class EdgeParseCache {
  private readonly entries = new Map<string, JavaClassGraphInfo[]>();
  private readonly max = PARSE_CACHE_MAX;

  infosFor(source: string): JavaClassGraphInfo[] {
    const key = createHash('sha1').update(source || '').digest('hex');
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    let infos: JavaClassGraphInfo[];
    try {
      infos = parseJavaForEdges(source);
    } catch {
      infos = []; // Parse-Fehler tolerieren (z. B. unvollstaendiger Code)
    }
    this.entries.set(key, infos);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return infos;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Aus Quelltexten die Kanten des Klassengraphen rechnen: **call** (getypter Methodenaufruf),
 * **field** (Zugriff auf ein deklariertes Feld), **uses** (struktureller Typbezug).
 *
 * `onProgress` meldet den Parse-Lauf – dort vergeht die Zeit; Rechnen und Zusammenstellen danach
 * sind Millisekunden.
 */
export async function computeEdges(
  inputs: EdgeInput[],
  opts: { cache: EdgeParseCache; onProgress?: (done: number, total: number) => void } = {
    cache: new EdgeParseCache(),
  },
): Promise<EdgeComputeResult> {
  const { cache, onProgress } = opts;

  const classes: EdgeClass[] = [];
  const byFqcn = new Map<string, EdgeClass>();
  const byName = new Map<string, EdgeClass[]>();
  const definesMethod = new Map<string, Set<string>>(); // FQCN -> definierte Methoden
  const methodToClasses = new Map<string, Set<string>>(); // Methode -> definierende FQCNs

  let scanned = 0;
  onProgress?.(0, inputs.length);
  for (const f of inputs) {
    const infos = cache.infosFor(f.source || '');
    // Melden und Luft holen gehoeren ZUSAMMEN und stehen ausserhalb des Cache-Zweigs:
    //  * Ein Lauf ueber tausende Dateien blockiert den Event-Loop komplett (s. YIELD_EVERY).
    //  * Und ein `emit` ohne freien Event-Loop erreicht niemanden: die SSE-Antwort wird erst
    //    geschrieben, wenn der Stapel leer ist. Stand die Atempause nur im Cache-Miss-Zweig,
    //    kamen bei warmem Cache ALLE Ereignisse erst nach getaner Arbeit an – also nie.
    // Gezaehlt werden ALLE Dateien (auch die aus dem Cache), sonst stuende der Balken still,
    // waehrend die Neuberechnung laengst durchlaeuft.
    if (++scanned % YIELD_EVERY === 0) {
      onProgress?.(scanned, inputs.length);
      await breathe();
    }
    for (const info of infos) {
      const entry: EdgeClass = {
        fqcn: fqcnOf(f.pkg || '', info.class_name),
        name: info.class_name,
        pkg: f.pkg || '',
        info,
        imports: f.imports || [],
      };
      // Zwei Klassen mit demselben FQCN kann es nicht geben (der Import verwirft Dubletten und
      // meldet sie). Kommt es doch vor, gewinnt die erste – stabil statt zufaellig.
      if (byFqcn.has(entry.fqcn)) continue;
      byFqcn.set(entry.fqcn, entry);
      const sameName = byName.get(entry.name);
      if (sameName) sameName.push(entry);
      else byName.set(entry.name, [entry]);
      classes.push(entry);

      const dm = new Set<string>();
      definesMethod.set(entry.fqcn, dm);
      for (const m of info.definedMethods) {
        dm.add(m);
        let mc = methodToClasses.get(m);
        if (!mc) {
          mc = new Set();
          methodToClasses.set(m, mc);
        }
        mc.add(entry.fqcn);
      }
    }
  }

  // Parse durch – ab hier ist es Rechnen (Millisekunden). Der Balken steht damit auf voll,
  // waehrend der Rest laeuft, statt kurz vor Schluss haengenzubleiben.
  onProgress?.(inputs.length, inputs.length);

  // Einen einfachen Typnamen AUS SICHT VON `from` aufloesen – in Javas Reihenfolge. Das ist der
  // Kern der Eindeutigkeit: `Header` allein ist keine Klasse, `Header` in `efw.n8n` mit
  // `import efw.util.http.Header` schon.
  let ambiguous = 0;
  const resolveType = (from: EdgeClass, name: string): EdgeClass | null => {
    if (!name) return null;
    // 1. Eigenes Package – dafuer braucht Java keinen Import, und es schlaegt jeden Import.
    const own = byFqcn.get(fqcnOf(from.pkg, name));
    if (own) return own;
    // 2. Expliziter Import. Er ENTSCHEIDET: nennt er eine Klasse, die nicht analysiert ist, gibt
    //    es hier keine Kante – auf eine gleichnamige aus einem anderen Package auszuweichen
    //    waere nachweislich falsch, denn der Import sagt ausdruecklich etwas anderes.
    for (const imp of from.imports) {
      if (imp.endsWith('.*') || simpleOf(imp) !== name) continue;
      return byFqcn.get(imp) || null;
    }
    // 3. Wildcard-Import (`import p.q.*`) – benennt immerhin das Package.
    for (const imp of from.imports) {
      if (!imp.endsWith('.*')) continue;
      const hit = byFqcn.get(fqcnOf(imp.slice(0, -2), name));
      if (hit) return hit;
    }
    // 4. Der Name ist im Bestand eindeutig -> dann ist nichts offen. Das traegt Codebasen ohne
    //    gepflegte Importliste (Altbestand: java_dependencies leer) und Klassen aus derselben
    //    Datei. Ist er es NICHT und hat nichts oben entschieden, entsteht keine Kante: eine
    //    geratene waere hier genau der Fehler, den diese Umstellung beseitigt.
    const list = byName.get(name);
    if (list?.length === 1) return list[0];
    if (list?.length) ambiguous++;
    return null;
  };

  // Vererbung: Klasse -> AUFGELOESTE Ober-Typen (extends + implements). Ein unqualifizierter
  // Aufruf, den die Klasse selbst nicht definiert, landet zuerst bei einem Vorfahren – nicht bei
  // einer beliebigen anderen Klasse, die zufaellig denselben Methodennamen traegt.
  const superOf = new Map<string, EdgeClass[]>();
  for (const c of classes) {
    const list: EdgeClass[] = [];
    for (const t of c.info.superTypes || []) {
      const hit = resolveType(c, t);
      if (hit) list.push(hit);
    }
    superOf.set(c.fqcn, list);
  }
  // Kette hochlaufen, mit Besuchsmarkierung: zyklische Vererbung gibt es in gueltigem Java nicht,
  // in halb analysiertem Bestand aber sehr wohl.
  const resolveInherited = (A: EdgeClass, m: string): EdgeClass | null => {
    const seen = new Set<string>([A.fqcn]);
    const stack = [...(superOf.get(A.fqcn) || [])];
    while (stack.length) {
      const s = stack.pop() as EdgeClass;
      if (!s || seen.has(s.fqcn)) continue;
      seen.add(s.fqcn);
      if (definesMethod.get(s.fqcn)?.has(m)) return s;
      for (const up of superOf.get(s.fqcn) || []) stack.push(up);
    }
    return null;
  };

  const edges = new Map<
    string,
    { source: EdgeClass; target: EdgeClass; method: string | null; confidence: number; kind: string }
  >();
  const put = (A: EdgeClass | null, B: EdgeClass | null, m: string | null, c: number, kind: string) => {
    if (!A || !B || A.fqcn === B.fqcn) return;
    const key = `${A.fqcn}\u0000${B.fqcn}\u0000${m ?? ''}\u0000${kind}`;
    const prev = edges.get(key);
    if (!prev || c > prev.confidence) edges.set(key, { source: A, target: B, method: m, confidence: c, kind });
  };

  // Klassenpaare mit einer BENANNTEN Kante (Aufruf oder Feldzugriff) -> kein zusaetzliches
  // `uses` dafuer. `uses` ist der Rueckfall fuer „Typbezug, aber kein Mitglied benannt";
  // steht der Name schon am Pfeil, waere eine zweite, stummere Kante daneben nur Rauschen.
  const pairHasCall = new Set<string>();
  // Strukturell referenzierte Zielklassen je Quellklasse (Kandidaten fuer `uses`-Kanten).
  const usesTargets = new Map<string, { from: EdgeClass; targets: Map<string, EdgeClass> }>();
  const addUses = (A: EdgeClass, B: EdgeClass | null) => {
    if (!B || A.fqcn === B.fqcn) return;
    let e = usesTargets.get(A.fqcn);
    if (!e) {
      e = { from: A, targets: new Map() };
      usesTargets.set(A.fqcn, e);
    }
    e.targets.set(B.fqcn, B);
  };

  for (const A of classes) {
    const info = A.info;
    // Typ-Bezuege (Feld-/Variablen-/Parameter-/Rueckgabetyp, new X(), statischer Zugriff, Cast,
    // instanceof, catch, throws, extends/implements) als `uses`-Kandidaten.
    for (const t of info.referencedTypes) addUses(A, resolveType(A, t));

    // Feldzugriffe (`Http.GET`, `conn.timeout`) – eine eigene Kantenart, weil sie ein MITGLIED
    // benennt und damit nachpruefbar ist, anders als ein blosser Typbezug. Bedingung: die
    // Zielklasse deklariert das Feld auch. Ohne diese Pruefung stuende ein erfundener Name am
    // Pfeil, sobald der Empfaenger falsch aufgeloest wurde.
    for (const ref of info.fieldRefs || []) {
      const B = resolveType(A, ref.type);
      if (!B || B.fqcn === A.fqcn) continue;
      addUses(A, B); // ein aufgeloester Empfaenger ist immer auch ein Typbezug
      if (!Object.prototype.hasOwnProperty.call(B.info.fields, ref.field)) continue;
      put(A, B, ref.field, 1.0, 'field');
      pairHasCall.add(`${A.fqcn}\u0000${B.fqcn}`);
    }

    for (const caller of info.callers) {
      for (const inv of caller.invocations) {
        const m = inv.method;
        // Empfaengertyp B aufloesen: erst als Typname (`new B().m()`, statisch `B.m()`), sonst
        // ueber den Scope (Variable/Feld/Parameter -> Typ). Reihenfolge wie zuvor.
        let B: EdgeClass | null = null;
        if (inv.receiver) {
          B = resolveType(A, inv.receiver);
          if (!B) {
            const t = caller.scope[inv.receiver];
            if (t) B = resolveType(A, t);
          }
        }
        // Aufgeloester Empfaenger ist immer ein Typ-Bezug (auch ohne Methoden-Treffer).
        if (B) addUses(A, B);
        if (B && B.fqcn !== A.fqcn && definesMethod.get(B.fqcn)?.has(m)) {
          put(A, B, m, 1.0, 'call');
          pairHasCall.add(`${A.fqcn}\u0000${B.fqcn}`);
          continue;
        }
        // Empfaenger vorhanden, aber nicht aufloesbar (`foo().m()`, `a.b.m()`, `"x".m()`): hier
        // ist NICHTS offen, was Java fuer uns entscheiden wuerde – das Ziel haengt an einem Typ,
        // den wir nicht kennen. Alles Weitere unten gilt ausdruecklich nur fuer unqualifizierte
        // Aufrufe; ohne diese Zeile lief `reg.getWorkflows().entrySet()` in die Heuristik und
        // erzeugte eine Kante zu jeder eigenen Klasse, die zufaellig `entrySet()` definiert
        // (gemeldet an einem Interface `RequestParams` – getroffen wurde aber `Map.entrySet`).
        if (inv.receiverUnresolved) continue;
        // Unqualifizierter Aufruf (`m(…)`, `this.m(…)`, `super.m(…)`) – in Javas Reihenfolge
        // aufloesen, statt sofort zu raten. Vorher sprang die Berechnung direkt zur Heuristik
        // und erzeugte damit Kanten fuer Aufrufe, die die Klasse selbst beantwortet.
        if (inv.receiver === null) {
          // 1. Eigene Methode: ein unqualifizierter Aufruf bindet in Java IMMER zuerst an die
          //    eigene Klasse – dann gibt es hier gar keine Beziehung nach draussen.
          //    `super.m()` meint ausdruecklich die Oberklasse und ist ausgenommen.
          if (!inv.viaSuper && definesMethod.get(A.fqcn)?.has(m)) continue;
          // 2. Geerbt: der Vorfahre, der `m` definiert. Kein Raten – das steht im Code.
          const inherited = resolveInherited(A, m);
          if (inherited) {
            put(A, inherited, m, 1.0, 'call');
            pairHasCall.add(`${A.fqcn}\u0000${inherited.fqcn}`);
            continue;
          }
          // `super.m()` ohne analysierten Vorfahren: das Ziel ist bekannt (die Oberklasse), nur
          // nicht vorhanden. Eine geratene Kante waere hier nachweislich falsch.
          if (inv.viaSuper) continue;
          // 3. Statischer Import – der einzige legale Weg zu einer FREMDEN Klasse ohne Empfaenger.
          //    Der Parser liefert den EINFACHEN Namen der Traegerklasse; aufgeloest wird er wie
          //    jeder andere Typname, also ueber die Importe dieser Datei.
          const importedName = info.staticImports?.[m];
          let target: EdgeClass | null = importedName ? resolveType(A, importedName) : null;
          if (!target) {
            for (const c of info.staticWildcardTypes || []) {
              const hit = resolveType(A, c);
              if (hit && definesMethod.get(hit.fqcn)?.has(m)) {
                target = hit;
                break;
              }
            }
          }
          if (target) {
            put(A, target, m, 1.0, 'call');
            pairHasCall.add(`${A.fqcn}\u0000${target.fqcn}`);
            continue;
          }
          // 4. Rest: Methode in genau EINER anderen Klasse -> geraten, LOW ("Please review").
          //    Bleibt drin, weil Vererbung auch ueber NICHT analysierte Klassen laeuft
          //    (Framework-Basisklassen) und der Treffer dann oft stimmt – aber eben nur oft.
          //    Gezaehlt wird ueber FQCNs: zwei gleichnamige Klassen sind hier ZWEI Kandidaten,
          //    der Treffer also nicht mehr eindeutig – und genau das ist richtig so.
          const defs = methodToClasses.get(m);
          if (defs) {
            const others = [...defs].filter((c) => c !== A.fqcn);
            if (others.length === 1) {
              const only = byFqcn.get(others[0]);
              if (only) {
                put(A, only, m, 0.5, 'call');
                pairHasCall.add(`${A.fqcn}\u0000${only.fqcn}`);
              }
            }
          }
        }
      }
    }
  }

  // Struktur-Kanten (`uses`) nur, wo das Paar noch keine Methoden-Kante hat.
  for (const { from, targets } of usesTargets.values()) {
    for (const B of targets.values()) {
      if (pairHasCall.has(`${from.fqcn}\u0000${B.fqcn}`)) continue;
      put(from, B, null, 1.0, 'uses');
    }
  }

  return {
    edges: [...edges.values()].map((e) => ({
      source_class: e.source.name,
      source_pkg: e.source.pkg || null,
      target_class: e.target.name,
      target_pkg: e.target.pkg || null,
      method_name: e.method,
      confidence: e.confidence,
      kind: e.kind,
    })),
    fqcns: [...byFqcn.keys()],
    ambiguous,
  };
}
