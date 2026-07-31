// Rein JS-basiertes Java-Parsing (kein JDK/javac noetig) ueber java-parser (Chevrotain-CST).
// Extrahiert Package, Imports und den primaeren Top-Level-Typ inkl. Methoden.
// Bewusst kein Backend-/DB-/HTTP-Bezug -> gut testbar und wiederverwendbar.
// 1:1 portiert aus backend/javaParser.js (Typen bewusst locker gehalten).
import { parse } from 'java-parser';

export interface JavaMethodInfo {
  method_name: string;
  return_type: string;
  parameters: Array<{ type: string; name: string }>;
  modifiers: string[]; // Access-/Sonstige-Modifier in Quell-Reihenfolge (z. B. ['public','static'])
  javadoc: string;
  body: string;
  start_line: number; // 1-basierte Quellzeile der Methodendeklaration (fuer Sprung/Highlight)
  body_start_line: number; // 1-basierte Quellzeile des Body-`{` (Basis fuer exakte Aufrufzeilen)
}

// Java-Methoden-Modifier (kein Annotations-Set): dient als Filter, damit aus den
// methodModifier-/interfaceMethodModifier-CST-Knoten nur echte Keywords (keine @Annotationen)
// in die Signatur wandern.
const METHOD_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'abstract',
  'static',
  'final',
  'synchronized',
  'native',
  'strictfp',
  'default',
  'transient',
  'volatile',
]);

// Was der Knoten IST – eine Verfeinerung von `class_type`. Die vier Java-Elementtypen bleiben, was
// sie sind; `class` wird nach seinem Charakter aufgeschluesselt, weil „class" allein nichts sagt:
// eine Datenklasse (nur Felder + Konstruktor/Accessoren) liest man anders als einen Service.
export type JavaStereotype =
  | 'class'
  | 'data' // Datenklasse/DTO: Felder + Konstruktor, hoechstens Accessoren
  | 'util' // Utility: ausschliesslich statische Methoden
  | 'exception' // erbt von …Exception/…Error/Throwable
  | 'abstract' // abstrakte Klasse
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'record';

export interface JavaClassInfo {
  class_name: string;
  class_type: 'class' | 'interface' | 'enum' | 'annotation' | 'record';
  stereotype: JavaStereotype;
  class_modifiers: string[]; // ['public','abstract'] – Quell-Reihenfolge
  extends_name: string; // einfacher Name der Oberklasse ('' = keine)
  field_count: number; // deklarierte Felder (Record: Komponenten)
  ctor_count: number; // deklarierte Konstruktoren
  methods: JavaMethodInfo[];
  class_line: number; // 1-basierte Quellzeile des Klassennamens (fuer Sprung/Highlight)
}

export interface JavaParseResult {
  package: string;
  imports: string[];
  classes: JavaClassInfo[];
  primary: JavaClassInfo;
}

// --- Call-Edge-Analyse (getypte Methoden-Aufrufe) ----------------------------
// Ein erkannter Methoden-Aufruf in einem Methodenrumpf. `receiver` = einfacher
// Empfaenger-Bezeichner (Variable/Feld/Klassenname) oder null (unqualifiziert/this).
export interface JavaInvocation {
  method: string;
  receiver: string | null;
  receiverIsNew: boolean; // true bei `new Type().m()` -> receiver ist der Typ
  // true bei `super.m()`. Steht wie `this.m()` ohne aufloesbaren Empfaenger da, meint aber das
  // GEGENTEIL: nicht die eigene Klasse, sondern ausdruecklich die Oberklasse. Ohne diese
  // Unterscheidung waere ein `super.m()` in einer ueberschreibenden Methode ein Selbstaufruf.
  viaSuper: boolean;
  // true, wenn der Aufruf SEHR WOHL einen Empfaenger hat, dieser aber kein aufloesbarer Bezeichner
  // ist: `foo().m()`, `a.b.m()`, `"x".m()`, `arr[i].m()`. Das ist etwas grundlegend anderes als
  // `receiver === null` (= gar kein Empfaenger, also `m()`/`this.m()`), auch wenn beide Felder
  // gleich aussehen: bei einem unqualifizierten Aufruf legt Java das Ziel fest, hier dagegen
  // haengt es an einem Typ, den wir nicht kennen. Wer beides gleich behandelt, raet ueber eine
  // Frage, die gar nicht offen ist – s. `recomputeAutoEdges`.
  receiverUnresolved: boolean;
  line: number;
}

export interface JavaCallerMethod {
  name: string;
  scope: Record<string, string>; // Bezeichner -> einfacher Typname (Felder + Parameter + lokale Vars)
  invocations: JavaInvocation[];
}

export interface JavaClassGraphInfo {
  class_name: string;
  definedMethods: Set<string>;
  fields: Record<string, string>;
  callers: JavaCallerMethod[];
  // Einfache Typnamen, die diese Klasse strukturell referenziert: Feld-/Parameter-/
  // lokale Variablen-/Rueckgabetypen + `new X()`. Basis fuer `uses`-Kanten (Typ-Bezug
  // ohne Methoden-Treffer), gegen die geladenen Klassennamen gefiltert in der Neuberechnung.
  referencedTypes: Set<string>;
  // Ober-Typen (extends + implements, einfache Namen). Ein unqualifizierter Aufruf, den die
  // Klasse selbst nicht definiert, kann GEERBT sein – dann ist der Vorfahre das Ziel und nichts
  // zu raten.
  superTypes: string[];
  // Statische Imports der Kompilationseinheit: Methodenname -> Klasse (`import static X.m`) bzw.
  // Klassen aus `import static X.*`. Sie sind der EINZIGE Weg, auf dem ein unqualifizierter Aufruf
  // legal in einer fremden Klasse landet – ohne sie ist jede solche Kante geraten.
  staticImports: Record<string, string>;
  staticWildcardTypes: string[];
}

// Object-Methoden sind nie ein Kanten-Trigger: gemeinsames Ueberschreiben von
// toString()/equals()/... bedeutet KEINE Abhaengigkeit zwischen zwei Klassen.
const OBJECT_METHODS = new Set([
  'toString',
  'equals',
  'hashCode',
  'getClass',
  'clone',
  'finalize',
  'notify',
  'notifyAll',
  'wait',
]);

// Einfacher Typname: Generics + Array-Dimensionen + Paketpfad entfernen
// ("java.util.List<Foo>" / "Bar[]" -> "List" / "Bar").
function simpleName(type: string): string {
  if (!type) return '';
  return type
    .replace(/<[\s\S]*>/g, '')
    .replace(/\[\s*\]/g, '')
    .trim()
    .split('.')
    .pop() || '';
}

// --- generische CST-Helfer ---------------------------------------------------

// Ein CST-Knoten hat .children, ein Token hat .image + .startOffset.
function isNode(x: any): boolean {
  return x && typeof x === 'object' && x.children;
}
function isToken(x: any): boolean {
  return x && typeof x === 'object' && x.image !== undefined;
}

// Traegt das Token die Rolle eines Bezeichners? NICHT `tokenType.name === 'Identifier'` pruefen:
// Javas *contextual keywords* (`record`, `yield`, `sealed`, `permits`, `open`, `module`, `to`,
// `with`, …) sind an ihrer Stelle voellig normale Namen, java-parser lext sie aber als eigenen
// Token-Typ (`Record`, `Yield`, …) und haengt ihn nur in die KATEGORIE `Identifier`. Wer den
// Typnamen vergleicht, verliert sie – und zwar lautlos: `public int record(int days)` wurde als
// Methode „days" gefuehrt (erster echter Identifier im Declarator = der Parametername), Felder
// namens `record` fielen ganz weg und Aufrufe von `x.record(…)` erzeugten keine Graph-Kante.
function isIdent(tok: any): boolean {
  const tt = tok?.tokenType;
  if (!tt) return false;
  return tt.name === 'Identifier' || (tt.CATEGORIES || []).some((c: any) => c?.name === 'Identifier');
}

// Alle Leaf-Tokens eines Teilbaums (zur Offset-Sortierung mit startOffset).
function collectTokens(node: any, acc: any[] = []): any[] {
  if (!isNode(node)) return acc;
  for (const key of Object.keys(node.children)) {
    for (const child of node.children[key]) {
      if (isToken(child)) acc.push(child);
      else if (isNode(child)) collectTokens(child, acc);
    }
  }
  return acc;
}

// Tiefensuche: alle Knoten mit gegebenem Namen.
function findAll(node: any, name: string, acc: any[] = []): any[] {
  if (!isNode(node)) return acc;
  if (node.name === name) acc.push(node);
  for (const key of Object.keys(node.children)) {
    for (const child of node.children[key]) {
      if (isNode(child)) findAll(child, name, acc);
    }
  }
  return acc;
}

function findFirst(node: any, name: string): any {
  return findAll(node, name)[0] || null;
}

function minOffset(node: any): number {
  const toks = collectTokens(node);
  return toks.length ? Math.min(...toks.map((t) => t.startOffset)) : Infinity;
}

// Kleinste 1-basierte Quellzeile eines Teilbaums. chevrotain-Tokens tragen `startLine`
// (Default positionTracking: "full"). Fallback 1, falls keine Zeileninfo vorliegt.
function minLine(node: any): number {
  const lines = collectTokens(node)
    .map((t) => t.startLine)
    .filter((n) => typeof n === 'number');
  return lines.length ? Math.min(...lines) : 1;
}

// Methodenrumpf rekonstruieren: Spannweite der methodBody-Tokens aus dem Quelltext schneiden.
// chevrotain-Tokens haben startOffset/endOffset (endOffset = Index des letzten Zeichens).
// Leerer String bei abstract-/Interface-Methoden ohne Body.
function bodyText(methodNode: any, source: string): string {
  const bodyNode = findFirst(methodNode, 'methodBody');
  if (!bodyNode) return '';
  const toks = collectTokens(bodyNode);
  if (!toks.length) return '';
  const start = Math.min(...toks.map((t) => t.startOffset));
  const end = Math.max(...toks.map((t) => (t.endOffset ?? t.startOffset)));
  const slice = source.slice(start, end + 1).trim();
  // Reines ';' (= kein Body) nicht als Rumpf zaehlen.
  return slice === ';' ? '' : slice;
}

// `default …` eines Annotationselements als Quelltext (leer, wenn es keinen Default gibt).
// Gleiche Technik wie bodyText: Spannweite der Tokens aus dem Original schneiden, damit
// Formatierung und Schreibweise erhalten bleiben.
function defaultValueText(elementNode: any, source: string): string {
  const def = findFirst(elementNode, 'defaultValue');
  if (!def) return '';
  const toks = collectTokens(def);
  if (!toks.length) return '';
  const start = Math.min(...toks.map((t) => t.startOffset));
  const end = Math.max(...toks.map((t) => t.endOffset ?? t.startOffset));
  return source.slice(start, end + 1).trim();
}

// Typ-Text aus den Tokens rekonstruieren (z. B. "List<String>", "int", "String[]").
function typeText(node: any): string {
  if (!node) return '';
  return collectTokens(node)
    .sort((a, b) => a.startOffset - b.startOffset)
    .map((t) => t.image)
    .join('');
}

// Identifier-Tokens eines Teilbaums (in Quellreihenfolge) als Punkt-Pfad.
function dottedName(node: any): string {
  if (!node) return '';
  return collectTokens(node)
    .filter((t) => isIdent(t))
    .sort((a, b) => a.startOffset - b.startOffset)
    .map((t) => t.image)
    .join('.');
}

// --- Javadoc (best-effort aus dem Rohtext) -----------------------------------

function extractJavadocBlocks(source: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const re = /\/\*\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(source)) !== null) {
    blocks.push({ start: m.index, end: m.index + m[0].length, text: cleanJavadoc(m[0]) });
  }
  return blocks;
}

function cleanJavadoc(raw: string): string {
  return raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

// Javadoc-Block einem Methodenstart zuordnen: der Block muss direkt davor liegen,
// dazwischen nur Whitespace/Annotationen/Modifier (keine {, }, ; -> sonst gehoert
// er zu etwas anderem). Lieber nichts zuordnen als falsch raten.
function javadocFor(methodStart: number, blocks: Array<{ start: number; end: number; text: string }>, source: string): string {
  let best: { start: number; end: number; text: string } | null = null;
  for (const b of blocks) {
    if (b.end <= methodStart && (!best || b.end > best.end)) best = b;
  }
  if (!best) return '';
  const gap = source.slice(best.end, methodStart);
  if (/[{};]/.test(gap)) return '';
  return best.text;
}

// --- Methoden eines Typs ------------------------------------------------------

function extractMethods(typeNode: any, blocks: any[], source: string): JavaMethodInfo[] {
  const methodNodes = [
    ...findAll(typeNode, 'methodDeclaration'),
    ...findAll(typeNode, 'interfaceMethodDeclaration'),
  ];
  const methods: JavaMethodInfo[] = [];
  for (const mNode of methodNodes) {
    const declarator = findFirst(mNode, 'methodDeclarator');
    if (!declarator) continue;
    const nameTok = collectTokens(declarator).find((t) => isIdent(t));
    if (!nameTok) continue;

    const result = findFirst(mNode, 'result');
    let returnType = typeText(result);
    if (!returnType || /^void$/i.test(returnType)) returnType = 'void';

    // Modifier aus methodModifier-/interfaceMethodModifier-Knoten: alle Leaf-Tokens nach
    // Quell-Offset sortieren und auf das Keyword-Set filtern -> Annotationen fallen raus,
    // Reihenfolge bleibt quelltreu (z. B. `public static`). Doppelte vermeiden.
    const modifiers: string[] = [];
    const modifierNodes = [
      ...findAll(mNode, 'methodModifier'),
      ...findAll(mNode, 'interfaceMethodModifier'),
    ];
    const modifierTokens = modifierNodes
      .flatMap((node) => collectTokens(node))
      .sort((a, b) => a.startOffset - b.startOffset);
    for (const tok of modifierTokens) {
      const kw = (tok.image || '').toLowerCase();
      if (METHOD_MODIFIERS.has(kw) && !modifiers.includes(kw)) modifiers.push(kw);
    }

    const params: Array<{ type: string; name: string }> = [];
    for (const p of findAll(declarator, 'variableParaRegularParameter')) {
      params.push({
        type: typeText(findFirst(p, 'unannType')),
        name:
          collectTokens(findFirst(p, 'variableDeclaratorId') || p).find((t) => isIdent(t))?.image || '',
      });
    }
    // Varargs (z. B. String... args)
    for (const p of findAll(declarator, 'variableArityParameter')) {
      const idTok = collectTokens(p).filter((t) => isIdent(t));
      params.push({
        type: typeText(findFirst(p, 'unannType')) + '...',
        name: idTok.length ? idTok[idTok.length - 1].image : '',
      });
    }

    methods.push({
      method_name: nameTok.image,
      return_type: returnType,
      parameters: params,
      modifiers,
      javadoc: javadocFor(minOffset(mNode), blocks, source),
      body: bodyText(mNode, source),
      // Zeile des Methoden-Identifiers (praeziser als der Knotenanfang mit Annotationen/Modifiern).
      start_line: minLine(declarator),
      // Zeile des Body-`{` (= Beginn von bodyText, da der Slice am `{`-Token startet) -> Basis,
      // um aus dem Body-Text die exakte Quellzeile einer Aufrufstelle zu berechnen.
      body_start_line: minLine(findFirst(mNode, 'methodBody')),
    });
  }

  // Elemente eines Annotationstyps (`String value() default "";`). In Java SIND das Methoden,
  // sie stehen im CST aber unter einem eigenen Knoten ohne `methodDeclarator` – ohne diesen
  // Zweig kaeme jede importierte Annotation als voellig leerer Typ an (0 Methoden, 0 Felder),
  // und genau ihre Elemente sind das, was eine Annotation ausmacht.
  for (const el of findAll(typeNode, 'annotationInterfaceElementDeclaration')) {
    // Der Elementname ist der Identifier NACH dem Typ (`String value()` -> "value"); der Typ
    // selbst besteht ebenfalls aus Identifiern, deshalb der Offset-Vergleich.
    const typeNodeEl = findFirst(el, 'unannType');
    const afterType = typeNodeEl ? Math.max(...collectTokens(typeNodeEl).map((t) => t.startOffset)) : -1;
    const nameTok = collectTokens(el).find((t) => isIdent(t) && t.startOffset > afterType);
    if (!nameTok) continue;
    methods.push({
      method_name: nameTok.image,
      return_type: typeText(typeNodeEl) || 'void',
      parameters: [],
      // Elemente sind implizit public abstract – der Quelltext schreibt es nicht hin, und
      // etwas hinzuschreiben, das dort nicht steht, waere geraten.
      modifiers: [],
      javadoc: javadocFor(minOffset(el), blocks, source),
      // Kein Rumpf; der Default-Wert ist das einzige, was ueberhaupt dranhaengt.
      body: defaultValueText(el, source),
      start_line: minLine(el),
      body_start_line: null,
    });
  }
  return methods;
}

// Der CST-Knoten eines Annotationstyps (`public @interface X {}`) heisst je nach java-parser-
// Version anders: die aktuelle Grammatik folgt der JLS-17-Benennung ("AnnotationInterface"),
// aeltere hiessen "AnnotationType". Es wird immer nur EINER davon existieren – beide zu suchen
// kostet nichts und macht ein Parser-Update in beide Richtungen ungefaehrlich.
//
// Der falsche Name allein hat jede Annotation lautlos verschluckt: `parseJava` fand keinen Typ
// und meldete "No class, interface, enum or record found in the source" – bei einem Massen-Paste
// als eine von vielen uebersprungenen Sektionen, deren Ursache man dem Text nicht ansieht.
const ANNOTATION_DECL_NODES = ['annotationInterfaceDeclaration', 'annotationTypeDeclaration'];

// --- Klassen-Charakter (Stereotyp) -------------------------------------------
// Nur Java-Modifier, keine Annotationen (analog METHOD_MODIFIERS).
const CLASS_MODIFIERS = new Set(['public', 'protected', 'private', 'abstract', 'static', 'final', 'sealed', 'non-sealed', 'strictfp']);

// Methoden, die eine Datenklasse haben DARF, ohne aufzuhoeren eine zu sein: Accessoren nach
// JavaBeans (`getX`/`setX`/`isX`/`hasX`), Builder-Idiome (`withX`, `builder`) und die
// Object-/Comparable-Vertraege. Alles andere ist Logik -> keine reine Datenklasse mehr.
const ACCESSOR_RE = /^(get|set|is|has|with)([A-Z_$]|$)/;
const DATA_CONTRACT = new Set(['equals', 'hashCode', 'toString', 'compareTo', 'clone', 'builder', 'toBuilder', 'of', 'copy']);

function isAccessorLike(m: JavaMethodInfo): boolean {
  return ACCESSOR_RE.test(m.method_name) || DATA_CONTRACT.has(m.method_name);
}

// Erster Typname unterhalb eines Knotens (fuer `extends`), Typargumente ausgenommen: bei
// `extends AbstractList<Foo>` wuerde ein simples dottedName „AbstractList.Foo" liefern und der
// einfache Name waere `Foo`. Deshalb am ersten '<' abbrechen.
function firstTypeName(node: any): string {
  if (!node) return '';
  const parts: string[] = [];
  for (const t of collectTokens(node).sort((a: any, b: any) => a.startOffset - b.startOffset)) {
    if (t.image === '<') break;
    if (isIdent(t) || t.image === '.') parts.push(t.image);
  }
  return simpleName(parts.join(''));
}

// Charakter einer Klasse aus dem, was der Parser sicher weiss. Reihenfolge = Rangfolge: der
// erste Treffer gewinnt, weil eine abstrakte Exception zuerst eine Exception ist und eine
// abstrakte Klasse zuerst abstrakt (dort ist die Vererbung die Aussage, nicht der Inhalt).
export function deriveStereotype(info: {
  class_name: string;
  class_type: string;
  class_modifiers: string[];
  extends_name: string;
  field_count: number;
  ctor_count: number;
  methods: JavaMethodInfo[];
}): JavaStereotype {
  // Interface/Enum/Annotation/Record sind bereits eine eigene Aussage – nicht weiter aufteilen.
  if (info.class_type !== 'class') return info.class_type as JavaStereotype;

  const isThrowable = (n: string) => /(?:Exception|Error|Throwable)$/.test(n || '');
  if (isThrowable(info.extends_name) || isThrowable(info.class_name)) return 'exception';
  if (info.class_modifiers.includes('abstract')) return 'abstract';

  const methods = info.methods || [];
  // Utility: mindestens eine Methode und ALLE statisch (Konstruktoren stoeren nicht – der
  // private Ctor ist genau das Idiom, das eine Utility-Klasse uninstanziierbar macht).
  if (methods.length > 0 && methods.every((m) => (m.modifiers || []).includes('static'))) return 'util';

  // Datenklasse: traegt Zustand (Felder oder Konstruktorparameter) und KEINE Logik.
  const hasState = info.field_count > 0 || info.ctor_count > 0;
  if (hasState && methods.every((m) => isAccessorLike(m))) return 'data';

  return 'class';
}

// --- Haupteinstieg ------------------------------------------------------------

// Liefert { package, imports:[fqn], classes:[{class_name,class_type,methods}], primary }.
// Wirft bei Syntaxfehlern -> die Route wandelt das in 400 um.
export function parseJava(source: string): JavaParseResult {
  const cst: any = parse(source);
  const blocks = extractJavadocBlocks(source);

  const pkgNode = findFirst(cst, 'packageDeclaration');
  const pkg = pkgNode ? dottedName(pkgNode) : '';

  const imports: string[] = [];
  for (const imp of findAll(cst, 'importDeclaration')) {
    const name = dottedName(imp);
    if (!name) continue;
    const hasStar = collectTokens(imp).some((t) => t.tokenType?.name === 'Star');
    imports.push(hasStar ? `${name}.*` : name);
  }

  const candidates = [
    ...findAll(cst, 'normalClassDeclaration').map((node) => ({ node, type: 'class' as const })),
    ...findAll(cst, 'normalInterfaceDeclaration').map((node) => ({ node, type: 'interface' as const })),
    ...findAll(cst, 'enumDeclaration').map((node) => ({ node, type: 'enum' as const })),
    ...ANNOTATION_DECL_NODES.flatMap((key) =>
      findAll(cst, key).map((node) => ({ node, type: 'annotation' as const })),
    ),
    // Records (Java 16) waren bisher gar nicht analysierbar: ohne diesen Eintrag fand `parseJava`
    // in `record Point(int x, int y) {}` keinen Typ und die Analyse brach mit
    // „No class, interface or enum found in the source" ab.
    ...findAll(cst, 'recordDeclaration').map((node) => ({ node, type: 'record' as const })),
  ].sort((a, b) => minOffset(a.node) - minOffset(b.node));

  // Klassen-Modifier haengen eine Ebene HOEHER (`classDeclaration`/`interfaceDeclaration`), nicht
  // am Deklarationsknoten selbst. CST-Knoten kennen ihr Elternteil nicht -> ueber die DIREKTEN
  // Kinder der Huellknoten zuordnen (nicht per findAll, das zoege innere Klassen mit hinein).
  const modsByNode = new Map<any, string[]>();
  for (const wrap of [...findAll(cst, 'classDeclaration'), ...findAll(cst, 'interfaceDeclaration')]) {
    const mods = [...(wrap.children.classModifier || []), ...(wrap.children.interfaceModifier || [])]
      .map((m: any) =>
        collectTokens(m)
          .sort((a: any, b: any) => a.startOffset - b.startOffset)
          .map((t: any) => t.image)
          .join(''),
      )
      .filter((m: string) => CLASS_MODIFIERS.has(m));
    for (const key of ['normalClassDeclaration', 'enumDeclaration', 'recordDeclaration', 'normalInterfaceDeclaration', ...ANNOTATION_DECL_NODES]) {
      for (const child of wrap.children[key] || []) modsByNode.set(child, mods);
    }
  }

  const classes = candidates
    .map(({ node, type }) => {
      const typeId = findAll(node, 'typeIdentifier').sort((a, b) => minOffset(a) - minOffset(b))[0];
      const className = typeId
        ? collectTokens(typeId).find((t) => isIdent(t))?.image
        : null;
      const methods = extractMethods(node, blocks, source);
      // Felder: Deklaratoren zaehlen (`int a, b;` = 2). Beim Record sind es die Komponenten des
      // Headers. Wie bei den Methoden greift `findAll` auch in innere Typen – dieselbe bewusste
      // Unschaerfe wie im Rest der Datei, fuer die Charakter-Einordnung reicht sie.
      const field_count =
        type === 'record'
          ? findAll(node, 'recordComponent').length
          : findAll(node, 'fieldDeclaration').reduce((n, fd) => n + findAll(fd, 'variableDeclaratorId').length, 0);
      const class_modifiers = modsByNode.get(node) || [];
      const extends_name = firstTypeName(findFirst(node, 'classExtends'));
      const base = {
        class_name: className as string,
        class_type: type,
        class_modifiers,
        extends_name,
        field_count,
        ctor_count: findAll(node, 'constructorDeclaration').length,
        methods,
        // Zeile des Klassennamens (typeIdentifier), sonst Knotenanfang.
        class_line: minLine(typeId || node),
      };
      return { ...base, stereotype: deriveStereotype(base) };
    })
    .filter((c) => c.class_name) as JavaClassInfo[];

  if (!classes.length) {
    throw new Error('No class, interface, enum or record found in the source');
  }

  return { package: pkg, imports, classes, primary: classes[0] };
}

// --- splitJavaSources ---------------------------------------------------------

// Zeichen ueberspringen, das innerhalb eines String-/Char-Literals liegt (ab oeffnendem
// Quote `i`), inkl. Backslash-Escapes. Liefert den Index NACH dem schliessenden Quote.
function skipLiteral(text: string, i: number, quote: string): number {
  i++; // oeffnendes Quote
  const n = text.length;
  while (i < n) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return n;
}

// Ende einer `package`/`import`-Anweisung ab `i` (Index NACH dem `;`). Kommentare zwischen
// Schluesselwort und Semikolon sind erlaubt und werden mitgenommen.
function statementEnd(text: string, i: number): number {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === ';') return i + 1;
    i++;
  }
  return n;
}

// Annotation ab `@` ueberspringen: (qualifizierter) Name + optionale, balancierte Argumente.
// Zwingend noetig, weil Array-Werte wie `@SuppressWarnings({ "a", "b" })` GESCHWEIFTE Klammern
// enthalten – ohne dieses Ueberspringen wuerde die Body-Zaehlung des Typs dort starten und
// sofort wieder enden, d. h. der Typ waere nach seiner Annotation "zu Ende".
// `@interface` ist unkritisch: dort folgt keine Klammer, der Scan laeuft normal weiter.
function skipAnnotation(text: string, i: number): number {
  const n = text.length;
  i++; // '@'
  while (i < n && /\s/.test(text[i])) i++;
  while (i < n && /[A-Za-z0-9_$.]/.test(text[i])) i++;
  let j = i;
  while (j < n && /\s/.test(text[j])) j++;
  if (j >= n || text[j] !== '(') return i;
  let depth = 0;
  while (j < n) {
    const c = text[j];
    const c2 = text[j + 1];
    if (c === '/' && c2 === '/') {
      const e = text.indexOf('\n', j);
      j = e === -1 ? n : e;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = text.indexOf('*/', j + 2);
      j = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipLiteral(text, j, c);
      continue;
    }
    if (c === '(') {
      depth++;
      j++;
      continue;
    }
    if (c === ')') {
      depth--;
      j++;
      if (depth <= 0) return j;
      continue;
    }
    j++;
  }
  return n;
}

// Ende eines Top-Level-Typs ab `i` (Index NACH der schliessenden Klammer). Brace-zaehlend;
// Strings/Chars/Kommentare/Annotationen werden uebersprungen. `opened` meldet, ob ueberhaupt
// ein Body gefunden wurde – sonst war der Rest ein Fragment.
function typeBodyEnd(text: string, i: number): { end: number; opened: boolean } {
  const n = text.length;
  let depth = 0;
  let opened = false;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipLiteral(text, i, c);
      continue;
    }
    if (c === '@') {
      i = skipAnnotation(text, i);
      continue;
    }
    if (c === '{') {
      depth++;
      opened = true;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      if (opened && depth <= 0) return { end: i, opened: true };
      continue;
    }
    i++;
  }
  return { end: n, opened };
}

// Roh-Paste (eine Datei ODER mehrere aneinandergehaengte .java-Quellen) in eigenstaendige,
// je einzeln parsebare Chunks zerlegen.
//
// Ein Paste entsteht in der Praxis per `cat *.java > all.txt`: mehrere Compilation-Units
// hintereinander, jede mit eigenem package/import-Header – manchmal ganz OHNE `package`
// (default package), manchmal mit Trenn-Kommentaren dazwischen. Deshalb EIN linearer
// Top-Level-Scan statt Regex-Schnitten:
//   - `package`/`import` pflegen den laufenden Header. Kommt eine solche Anweisung, NACHDEM
//     bereits ein Typ ausgegeben wurde, beginnt eine neue Unit -> Header wird zurueckgesetzt.
//   - Jede Typ-Deklaration wird brace-zaehlend gelesen und als Chunk `Header + Typ` ausgegeben.
// Dadurch enthaelt jeder Chunk genau ein `package`, genau die Imports seiner Datei und genau
// einen Top-Level-Typ. Genau daran ist die frueher rein regex-basierte Trennung gescheitert:
// sie nahm die LETZTE import-Zeile des gesamten Pastes als Header-Ende und schob dadurch
// fremden Code in den Header.
export function splitJavaSources(source: string): string[] {
  const text = String(source || '').replace(/\r\n/g, '\n');
  const n = text.length;
  const chunks: string[] = [];

  let pkg = ''; // aktuelle package-Anweisung (inkl. ';')
  let imports: string[] = []; // Imports der aktuellen Unit
  let emitted = false; // in dieser Unit schon ein Typ ausgegeben?
  let segStart = -1; // Beginn des aktuellen Typ-Segments (inkl. Javadoc/Annotationen)
  let i = 0;

  const header = () => {
    const parts: string[] = [];
    if (pkg) parts.push(pkg, '');
    if (imports.length) parts.push(...imports, '');
    return parts.join('\n');
  };

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    // Kommentare eroeffnen ein Segment (Javadoc/Lizenzkopf gehoert zum folgenden Typ),
    // beenden es aber nicht – eine nachfolgende package/import-Anweisung verwirft es wieder.
    if (c === '/' && c2 === '/') {
      if (segStart < 0) segStart = i;
      const e = text.indexOf('\n', i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === '/' && c2 === '*') {
      if (segStart < 0) segStart = i;
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === ';') {
      // Vereinzeltes Semikolon auf Top-Level (in Java erlaubt) -> ignorieren.
      i++;
      continue;
    }

    // Schluesselwort am Wortanfang pruefen: package/import pflegen den Header.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (word === 'package' || word === 'import') {
        if (emitted) {
          // Header-Anweisung nach einem Typ -> naechste Datei im Paste.
          pkg = '';
          imports = [];
          emitted = false;
        }
        const end = statementEnd(text, j);
        const stmt = text.slice(i, end).trim();
        if (word === 'package') pkg = stmt;
        else imports.push(stmt);
        i = end;
        segStart = -1;
        continue;
      }
    }

    // Alles andere leitet eine Typ-Deklaration ein (Modifier, Annotation, `class`, …).
    if (segStart < 0) segStart = i;
    const { end, opened } = typeBodyEnd(text, i);
    const body = text.slice(segStart, end).trim();
    if (body) chunks.push(`${header()}${body}\n`);
    if (!opened) break; // Fragment ohne Body -> Rest ist kein Typ mehr
    emitted = true;
    segStart = -1;
    i = end;
  }

  // Genau ein Typ im Paste -> Originaltext zurueckgeben (erhaelt Lizenzkopf/Kommentare vor
  // dem `package`, die im rekonstruierten Header keinen Platz haetten).
  if (chunks.length <= 1) return [text];
  return chunks;
}

// --- parseJavaForEdges --------------------------------------------------------

// Klassennamen eines Typ-Knotens (typeIdentifier) ermitteln.
function classNameOf(typeNode: any): string | null {
  const typeId = findAll(typeNode, 'typeIdentifier').sort((a, b) => minOffset(a) - minOffset(b))[0];
  if (!typeId) return null;
  return collectTokens(typeId).find((t) => isIdent(t))?.image || null;
}

// Alle in einem Typ-Knoten direkt deklarierten Methodennamen.
function definedMethodNames(typeNode: any): Set<string> {
  const names = new Set<string>();
  const methodNodes = [
    ...findAll(typeNode, 'methodDeclaration'),
    ...findAll(typeNode, 'interfaceMethodDeclaration'),
  ];
  for (const mNode of methodNodes) {
    const declarator = findFirst(mNode, 'methodDeclarator');
    if (!declarator) continue;
    const nameTok = collectTokens(declarator).find((t) => isIdent(t));
    if (nameTok) names.add(nameTok.image);
  }
  return names;
}

// Ober-Typen eines Typs als einfache Namen: `extends` (Klasse/Interface) + `implements`.
// `firstTypeName` je Listeneintrag, NICHT `findAll(node,'classType')` ueber den ganzen Knoten:
// `extends Base<String>` enthaelt `String` als verschachtelten classType und der waere sonst ein
// Vorfahre. Generics brechen in `firstTypeName` ohnehin am `<` ab.
function superTypeNames(typeNode: any): string[] {
  const names: string[] = [];
  const ext = findFirst(typeNode, 'classExtends') || findFirst(typeNode, 'interfaceExtends');
  const extList = ext ? findAll(ext, 'interfaceType') : [];
  if (extList.length) for (const t of extList) names.push(firstTypeName(t));
  else if (ext) names.push(firstTypeName(ext)); // `extends Base` (Klasse) hat keine Liste
  const impl = findFirst(typeNode, 'classImplements');
  if (impl) for (const t of findAll(impl, 'interfaceType')) names.push(firstTypeName(t));
  return names.filter(Boolean);
}

// (Bezeichner -> einfacher Typ) aus Feld-Deklarationen des Typs.
function collectFields(typeNode: any): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const fd of findAll(typeNode, 'fieldDeclaration')) {
    const type = simpleName(typeText(findFirst(fd, 'unannType')));
    if (!type) continue;
    for (const vdId of findAll(fd, 'variableDeclaratorId')) {
      const id = collectTokens(vdId).find((t) => isIdent(t))?.image;
      if (id) fields[id] = type;
    }
  }
  return fields;
}

// Scope einer Methode: Felder + Parameter + lokale Variablen (mit Typ).
// `var`-Locals werden uebersprungen (Typ ohne Inferenz nicht aufloesbar).
function methodScope(mNode: any, baseFields: Record<string, string>): Record<string, string> {
  const scope: Record<string, string> = { ...baseFields };

  const declarator = findFirst(mNode, 'methodDeclarator');
  if (declarator) {
    for (const p of findAll(declarator, 'variableParaRegularParameter')) {
      const type = simpleName(typeText(findFirst(p, 'unannType')));
      const id = collectTokens(findFirst(p, 'variableDeclaratorId') || p).find((t) => isIdent(t))?.image;
      if (type && id) scope[id] = type;
    }
  }

  const bodyNode = findFirst(mNode, 'methodBody');
  if (bodyNode) {
    for (const lvd of findAll(bodyNode, 'localVariableDeclaration')) {
      const type = simpleName(typeText(findFirst(lvd, 'localVariableType')));
      if (!type || type === 'var') continue;
      for (const vdId of findAll(lvd, 'variableDeclaratorId')) {
        const id = collectTokens(vdId).find((t) => isIdent(t))?.image;
        if (id) scope[id] = type;
      }
    }
  }
  return scope;
}

// `new Type(...).m()`: vom schliessenden ')' eines `new`-Ausdrucks zurueck zum
// passenden '(' zaehlen und den Typnamen davor liefern (sonst null).
function resolveNewType(toks: any[], closeIdx: number): string | null {
  let depth = 0;
  let i = closeIdx;
  for (; i >= 0; i--) {
    const img = toks[i].image;
    if (img === ')') depth++;
    else if (img === '(') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i < 1) return null;
  const typeTok = toks[i - 1]; // Token direkt vor dem '('
  if (!typeTok || !isIdent(typeTok)) return null;
  // Links ueber Identifier/Dot laufen und ein vorangehendes `new` verlangen.
  let j = i - 2;
  while (j >= 0 && (isIdent(toks[j]) || toks[j].image === '.')) j--;
  if (j >= 0 && toks[j].image === 'new') return typeTok.image;
  return null;
}

// Einfache Typnamen aller `new Type(...)`-Instanziierungen unterhalb eines Knotens.
// Der Typname sind die DIREKTEN Identifier-Kinder von `classOrInterfaceTypeToInstantiate`
// (Typargumente liegen separat unter `typeArgumentsOrDiamond` und bleiben aussen vor);
// der letzte Identifier ist der einfache Name (z. B. `pkg.Foo` -> `Foo`).
function collectNewTypes(node: any): string[] {
  const out: string[] = [];
  for (const nc of findAll(node, 'unqualifiedClassInstanceCreationExpression')) {
    const t = findFirst(nc, 'classOrInterfaceTypeToInstantiate');
    const ids: any[] = t?.children?.Identifier || [];
    if (ids.length) out.push(ids[ids.length - 1].image);
  }
  return out;
}

// Methoden-Aufrufe eines Methodenrumpfs extrahieren. Kein methodInvocation-Knoten in
// java-parser -> Token-Stream-Pass: der Methodenname ist immer der Identifier direkt
// links vom '(' eines methodInvocationSuffix.
function extractInvocations(mNode: any): JavaInvocation[] {
  const bodyNode = findFirst(mNode, 'methodBody');
  if (!bodyNode) return [];
  const toks = collectTokens(bodyNode).sort((a, b) => a.startOffset - b.startOffset);

  const callOpenOffsets = new Set<number>();
  for (const suf of findAll(bodyNode, 'methodInvocationSuffix')) {
    const st = collectTokens(suf);
    if (st.length) callOpenOffsets.add(Math.min(...st.map((t) => t.startOffset)));
  }

  const invocations: JavaInvocation[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.image !== '(' || !callOpenOffsets.has(t.startOffset)) continue;

    const nameTok = toks[k - 1];
    if (!nameTok || !isIdent(nameTok)) continue; // super(...)/this(...) ausschliessen
    const method = nameTok.image;
    if (OBJECT_METHODS.has(method)) continue;

    let receiver: string | null = null;
    let receiverIsNew = false;
    let viaSuper = false;
    let receiverUnresolved = false;

    const dot = toks[k - 2];
    if (dot && dot.image === '.') {
      const r = toks[k - 3];
      if (r && r.image === 'super') {
        // `super.m()`: kein aufloesbarer Bezeichner, aber ausdruecklich NICHT die eigene Klasse.
        viaSuper = true;
      } else if (r && r.image === 'this') {
        // `this.m()` -> Selbstaufruf. Muss VOR dem Auffangzweig stehen: `this` ist ein Keyword,
        // kein Identifier, und wuerde sonst als „Empfaenger unbekannt" gelten – womit die eigene
        // Klasse nicht mehr als Ziel in Frage kaeme.
      } else if (r && isIdent(r)) {
        // Nur EINFACHE Empfaenger (recv.m()), keine Ketten a.b.m() (mehrdeutig).
        const before = toks[k - 4];
        if (!before || before.image !== '.') {
          receiver = r.image; // recv.m()
        } else if (toks[k - 5] && toks[k - 5].image === 'this') {
          // Kette `this.<feld>.m()` ist eindeutig: `this` macht <feld> garantiert zum Feld der
          // Klasse -> als Empfaenger aufloesen (haeufiges Idiom bei injizierten Abhaengigkeiten).
          receiver = r.image;
        } else {
          // `a.b.m()`: der Empfaenger ist `a.b`, und dessen Typ steht hier nicht.
          receiverUnresolved = true;
        }
      } else if (r && r.image === ')') {
        const typeName = resolveNewType(toks, k - 3);
        if (typeName) {
          receiver = typeName;
          receiverIsNew = true;
        } else {
          // `foo().m()` – Aufruf auf dem ERGEBNIS eines Aufrufs. Der Empfaenger ist da, sein Typ
          // ist der Rueckgabetyp von `foo()`, den wir nicht aufloesen. Genau dieser Fall erzeugte
          // falsche Kanten: `reg.getWorkflows().entrySet()` landete als „unqualifiziert" in der
          // Heuristik und traf jede eigene Klasse, die zufaellig ein `entrySet()` definiert.
          receiverUnresolved = true;
        }
      } else {
        // Literal, Array-Zugriff, geklammerter Ausdruck: Empfaenger vorhanden, Typ unbekannt.
        receiverUnresolved = true;
      }
    }

    invocations.push({
      method,
      receiver,
      receiverIsNew,
      viaSuper,
      receiverUnresolved,
      line: nameTok.startLine ?? 1,
    });
  }
  return invocations;
}

// Pro Top-Level-Typ Aufruf-relevante Infos liefern (definierte Methoden, Felder,
// je Methode Scope + erkannte Aufrufe). Basis fuer die globale Kanten-Neuberechnung.
export function parseJavaForEdges(source: string): JavaClassGraphInfo[] {
  const cst: any = parse(source);

  // Statische Imports der Kompilationseinheit (gelten fuer JEDEN Typ darin).
  const staticImports: Record<string, string> = {};
  const staticWildcardTypes: string[] = [];
  for (const imp of findAll(cst, 'importDeclaration')) {
    const toks = collectTokens(imp);
    if (!toks.some((t) => t.tokenType?.name === 'Static')) continue;
    const parts = dottedName(imp).split('.').filter(Boolean);
    if (parts.length < 2) continue;
    if (toks.some((t) => t.tokenType?.name === 'Star')) {
      staticWildcardTypes.push(parts[parts.length - 1]); // import static X.*
    } else {
      staticImports[parts[parts.length - 1]] = parts[parts.length - 2]; // import static X.m
    }
  }

  const candidates = [
    ...findAll(cst, 'normalClassDeclaration'),
    ...findAll(cst, 'enumDeclaration'),
    // Interfaces/Annotations rufen i. d. R. nichts auf, aber ihre definierten Methoden
    // sind als Ziel relevant -> ebenfalls aufnehmen.
    ...findAll(cst, 'normalInterfaceDeclaration'),
    ...ANNOTATION_DECL_NODES.flatMap((key) => findAll(cst, key)),
    // Records sind ganz normale Kanten-Teilnehmer: sie werden instanziiert, herumgereicht und
    // ihre (auch generierten) Zugriffe erscheinen als Aufrufe.
    ...findAll(cst, 'recordDeclaration'),
  ].sort((a, b) => minOffset(a) - minOffset(b));

  const infos: JavaClassGraphInfo[] = [];
  for (const node of candidates) {
    const class_name = classNameOf(node);
    if (!class_name) continue;

    const fields = collectFields(node);
    const methodNodes = [
      ...findAll(node, 'methodDeclaration'),
      ...findAll(node, 'interfaceMethodDeclaration'),
    ];
    const callers: JavaCallerMethod[] = [];
    const referencedTypes = new Set<string>();
    for (const mNode of methodNodes) {
      const declarator = findFirst(mNode, 'methodDeclarator');
      const nameTok = declarator
        ? collectTokens(declarator).find((t) => isIdent(t))
        : null;
      const scope = methodScope(mNode, fields);
      callers.push({
        name: nameTok?.image || '',
        scope,
        invocations: extractInvocations(mNode),
      });
      // Scope deckt Felder (gespreizt) + Parameter + lokale Variablen ab.
      for (const t of Object.values(scope)) referencedTypes.add(t);
      // Rueckgabetyp der Methode.
      const ret = simpleName(typeText(findFirst(mNode, 'result')));
      if (ret && ret !== 'void') referencedTypes.add(ret);
      // Instanziierte Typen (`new X()`) im Methodenrumpf.
      for (const t of collectNewTypes(mNode)) referencedTypes.add(t);
    }
    // Felder auch dann erfassen, wenn die Klasse keine Methoden hat.
    for (const t of Object.values(fields)) referencedTypes.add(t);
    // Instanziierungen ausserhalb von Methodenruempfen (Feld-Initialisierer etc.).
    for (const t of collectNewTypes(node)) referencedTypes.add(t);

    infos.push({
      class_name,
      definedMethods: definedMethodNames(node),
      fields,
      callers,
      referencedTypes,
      superTypes: superTypeNames(node),
      staticImports,
      staticWildcardTypes,
    });
  }
  return infos;
}
