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

export interface JavaClassInfo {
  class_name: string;
  class_type: 'class' | 'interface' | 'enum' | 'annotation';
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
    .filter((t) => t.tokenType?.name === 'Identifier')
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
    const nameTok = collectTokens(declarator).find((t) => t.tokenType?.name === 'Identifier');
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
          collectTokens(findFirst(p, 'variableDeclaratorId') || p).find(
            (t) => t.tokenType?.name === 'Identifier',
          )?.image || '',
      });
    }
    // Varargs (z. B. String... args)
    for (const p of findAll(declarator, 'variableArityParameter')) {
      const idTok = collectTokens(p).filter((t) => t.tokenType?.name === 'Identifier');
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
  return methods;
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
    ...findAll(cst, 'annotationTypeDeclaration').map((node) => ({ node, type: 'annotation' as const })),
  ].sort((a, b) => minOffset(a.node) - minOffset(b.node));

  const classes = candidates
    .map(({ node, type }) => {
      const typeId = findAll(node, 'typeIdentifier').sort((a, b) => minOffset(a) - minOffset(b))[0];
      const className = typeId
        ? collectTokens(typeId).find((t) => t.tokenType?.name === 'Identifier')?.image
        : null;
      return {
        class_name: className,
        class_type: type,
        methods: extractMethods(node, blocks, source),
        // Zeile des Klassennamens (typeIdentifier), sonst Knotenanfang.
        class_line: minLine(typeId || node),
      };
    })
    .filter((c) => c.class_name) as JavaClassInfo[];

  if (!classes.length) {
    throw new Error('Keine Klasse/Interface/Enum im Quelltext gefunden');
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

// Index der letzten `package`/`import`-Anweisung (deren Ende) -> alles davor ist der
// gemeinsame Header (fuehrende Kommentare + package + imports) einer Compilation-Unit.
function headerEndIndex(unit: string): number {
  let end = 0;
  const re = /^[ \t]*(?:package|import)\b[^;]*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(unit)) !== null) end = m.index + m[0].length;
  return end;
}

// Eine Compilation-Unit (genau ein Header) in je einen Chunk pro Top-Level-Typ zerlegen.
// Brace-zaehlend, Strings/Chars/Kommentare werden uebersprungen. Jeder Chunk = Header +
// genau ein Top-Level-Typ (inkl. dessen geschachtelter Typen) -> einzeln parsebar.
function splitTopLevelTypes(unit: string): string[] {
  const header = unit.slice(0, headerEndIndex(unit));
  const bodies: string[] = [];
  let i = headerEndIndex(unit);
  const n = unit.length;

  while (i < n) {
    while (i < n && /\s/.test(unit[i])) i++; // fuehrende Leerzeichen vor dem Typ
    if (i >= n) break;
    const declStart = i;
    let depth = 0;
    let opened = false;
    let bodyEnd = n;
    while (i < n) {
      const c = unit[i];
      const c2 = unit[i + 1];
      if (c === '/' && c2 === '/') {
        const e = unit.indexOf('\n', i);
        i = e === -1 ? n : e;
        continue;
      }
      if (c === '/' && c2 === '*') {
        const e = unit.indexOf('*/', i + 2);
        i = e === -1 ? n : e + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i = skipLiteral(unit, i, c);
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
        if (opened && depth === 0) {
          bodyEnd = i;
          break;
        }
        continue;
      }
      i++;
    }
    bodies.push(unit.slice(declStart, bodyEnd));
    if (!opened) break; // kein `{` mehr gefunden -> Rest war Schlussfragment
    i = bodyEnd;
  }

  if (bodies.length <= 1) return [unit];
  return bodies.map((b) => `${header}\n${b}\n`);
}

// Roh-Paste (einzelne oder mehrere zusammengefuegte .java-Quellen) in eigenstaendige,
// je einzeln parsebare Klassen-Chunks zerlegen. Zwei Stufen:
//   1) An `package`-Deklarationen in Compilation-Units schneiden (mehrere Dateien in einem
//      Paste haben je ein eigenes `package`).
//   2) Innerhalb jeder Unit die Top-Level-Typen brace-zaehlend trennen.
// Bewusst regex-/scan-basiert (kein CST): der Splitter muss vor dem eigentlichen parseJava
// laufen, das pro Chunk separat aufgerufen wird.
export function splitJavaSources(source: string): string[] {
  const text = String(source || '').replace(/\r\n/g, '\n');

  // 1) Compilation-Units an `package`-Zeilen (Zeilenanfang, opt. Einrueckung).
  const pkgRe = /^[ \t]*package\b[^;]*;/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(text)) !== null) starts.push(m.index);

  let units: string[];
  if (starts.length <= 1) {
    units = [text];
  } else {
    units = [];
    for (let k = 0; k < starts.length; k++) {
      const start = k === 0 ? 0 : starts[k]; // Text vor dem 1. package bleibt bei Unit 0
      const end = k + 1 < starts.length ? starts[k + 1] : text.length;
      units.push(text.slice(start, end));
    }
  }

  const chunks: string[] = [];
  for (const unit of units) {
    if (!unit.trim()) continue;
    for (const chunk of splitTopLevelTypes(unit)) {
      if (chunk.trim()) chunks.push(chunk);
    }
  }
  return chunks;
}

// --- parseJavaForEdges --------------------------------------------------------

// Klassennamen eines Typ-Knotens (typeIdentifier) ermitteln.
function classNameOf(typeNode: any): string | null {
  const typeId = findAll(typeNode, 'typeIdentifier').sort((a, b) => minOffset(a) - minOffset(b))[0];
  if (!typeId) return null;
  return collectTokens(typeId).find((t) => t.tokenType?.name === 'Identifier')?.image || null;
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
    const nameTok = collectTokens(declarator).find((t) => t.tokenType?.name === 'Identifier');
    if (nameTok) names.add(nameTok.image);
  }
  return names;
}

// (Bezeichner -> einfacher Typ) aus Feld-Deklarationen des Typs.
function collectFields(typeNode: any): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const fd of findAll(typeNode, 'fieldDeclaration')) {
    const type = simpleName(typeText(findFirst(fd, 'unannType')));
    if (!type) continue;
    for (const vdId of findAll(fd, 'variableDeclaratorId')) {
      const id = collectTokens(vdId).find((t) => t.tokenType?.name === 'Identifier')?.image;
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
      const id = collectTokens(findFirst(p, 'variableDeclaratorId') || p).find(
        (t) => t.tokenType?.name === 'Identifier',
      )?.image;
      if (type && id) scope[id] = type;
    }
  }

  const bodyNode = findFirst(mNode, 'methodBody');
  if (bodyNode) {
    for (const lvd of findAll(bodyNode, 'localVariableDeclaration')) {
      const type = simpleName(typeText(findFirst(lvd, 'localVariableType')));
      if (!type || type === 'var') continue;
      for (const vdId of findAll(lvd, 'variableDeclaratorId')) {
        const id = collectTokens(vdId).find((t) => t.tokenType?.name === 'Identifier')?.image;
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
  if (!typeTok || typeTok.tokenType?.name !== 'Identifier') return null;
  // Links ueber Identifier/Dot laufen und ein vorangehendes `new` verlangen.
  let j = i - 2;
  while (j >= 0 && (toks[j].tokenType?.name === 'Identifier' || toks[j].image === '.')) j--;
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
    if (!nameTok || nameTok.tokenType?.name !== 'Identifier') continue; // super(...)/this(...) ausschliessen
    const method = nameTok.image;
    if (OBJECT_METHODS.has(method)) continue;

    let receiver: string | null = null;
    let receiverIsNew = false;

    const dot = toks[k - 2];
    if (dot && dot.image === '.') {
      const r = toks[k - 3];
      if (r && r.tokenType?.name === 'Identifier') {
        // Nur EINFACHE Empfaenger (recv.m()), keine Ketten a.b.m() (mehrdeutig).
        const before = toks[k - 4];
        if (!before || before.image !== '.') {
          receiver = r.image; // recv.m()
        } else if (toks[k - 5] && toks[k - 5].image === 'this') {
          // Kette `this.<feld>.m()` ist eindeutig: `this` macht <feld> garantiert zum Feld der
          // Klasse -> als Empfaenger aufloesen (haeufiges Idiom bei injizierten Abhaengigkeiten).
          receiver = r.image;
        }
      } else if (r && r.image === ')') {
        const typeName = resolveNewType(toks, k - 3);
        if (typeName) {
          receiver = typeName;
          receiverIsNew = true;
        }
      }
      // r.image === 'this'/'super' -> Selbstaufruf, receiver bleibt null
    }

    invocations.push({ method, receiver, receiverIsNew, line: nameTok.startLine ?? 1 });
  }
  return invocations;
}

// Pro Top-Level-Typ Aufruf-relevante Infos liefern (definierte Methoden, Felder,
// je Methode Scope + erkannte Aufrufe). Basis fuer die globale Kanten-Neuberechnung.
export function parseJavaForEdges(source: string): JavaClassGraphInfo[] {
  const cst: any = parse(source);

  const candidates = [
    ...findAll(cst, 'normalClassDeclaration'),
    ...findAll(cst, 'enumDeclaration'),
    // Interfaces/Annotations rufen i. d. R. nichts auf, aber ihre definierten Methoden
    // sind als Ziel relevant -> ebenfalls aufnehmen.
    ...findAll(cst, 'normalInterfaceDeclaration'),
    ...findAll(cst, 'annotationTypeDeclaration'),
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
        ? collectTokens(declarator).find((t) => t.tokenType?.name === 'Identifier')
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

    infos.push({ class_name, definedMethods: definedMethodNames(node), fields, callers, referencedTypes });
  }
  return infos;
}
