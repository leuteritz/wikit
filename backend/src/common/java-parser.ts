// Rein JS-basiertes Java-Parsing (kein JDK/javac noetig) ueber java-parser (Chevrotain-CST).
// Extrahiert Package, Imports und den primaeren Top-Level-Typ inkl. Methoden.
// Bewusst kein Backend-/DB-/HTTP-Bezug -> gut testbar und wiederverwendbar.
// 1:1 portiert aus backend/javaParser.js (Typen bewusst locker gehalten).
import { parse } from 'java-parser';

export interface JavaMethodInfo {
  method_name: string;
  return_type: string;
  parameters: Array<{ type: string; name: string }>;
  javadoc: string;
  body: string;
  start_line: number; // 1-basierte Quellzeile der Methodendeklaration (fuer Sprung/Highlight)
  body_start_line: number; // 1-basierte Quellzeile des Body-`{` (Basis fuer exakte Aufrufzeilen)
}

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
