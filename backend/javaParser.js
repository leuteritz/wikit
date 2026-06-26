// Rein JS-basiertes Java-Parsing (kein JDK/javac noetig) ueber java-parser (Chevrotain-CST).
// Extrahiert Package, Imports und den primaeren Top-Level-Typ inkl. Methoden.
// Bewusst kein Backend-/DB-/HTTP-Bezug -> gut testbar und wiederverwendbar.
import { parse } from 'java-parser'

// --- generische CST-Helfer ---------------------------------------------------

// Ein CST-Knoten hat .children, ein Token hat .image + .startOffset.
function isNode(x) { return x && typeof x === 'object' && x.children }
function isToken(x) { return x && typeof x === 'object' && x.image !== undefined }

// Alle Leaf-Tokens eines Teilbaums (zur Offset-Sortierung mit startOffset).
function collectTokens(node, acc = []) {
  if (!isNode(node)) return acc
  for (const key of Object.keys(node.children)) {
    for (const child of node.children[key]) {
      if (isToken(child)) acc.push(child)
      else if (isNode(child)) collectTokens(child, acc)
    }
  }
  return acc
}

// Tiefensuche: alle Knoten mit gegebenem Namen.
function findAll(node, name, acc = []) {
  if (!isNode(node)) return acc
  if (node.name === name) acc.push(node)
  for (const key of Object.keys(node.children)) {
    for (const child of node.children[key]) {
      if (isNode(child)) findAll(child, name, acc)
    }
  }
  return acc
}

function findFirst(node, name) {
  return findAll(node, name)[0] || null
}

function minOffset(node) {
  const toks = collectTokens(node)
  return toks.length ? Math.min(...toks.map(t => t.startOffset)) : Infinity
}

// Typ-Text aus den Tokens rekonstruieren (z. B. "List<String>", "int", "String[]").
function typeText(node) {
  if (!node) return ''
  return collectTokens(node)
    .sort((a, b) => a.startOffset - b.startOffset)
    .map(t => t.image)
    .join('')
}

// Identifier-Tokens eines Teilbaums (in Quellreihenfolge) als Punkt-Pfad.
function dottedName(node) {
  if (!node) return ''
  return collectTokens(node)
    .filter(t => t.tokenType?.name === 'Identifier')
    .sort((a, b) => a.startOffset - b.startOffset)
    .map(t => t.image)
    .join('.')
}

// --- Javadoc (best-effort aus dem Rohtext) -----------------------------------

function extractJavadocBlocks(source) {
  const blocks = []
  const re = /\/\*\*[\s\S]*?\*\//g
  let m
  while ((m = re.exec(source)) !== null) {
    blocks.push({ start: m.index, end: m.index + m[0].length, text: cleanJavadoc(m[0]) })
  }
  return blocks
}

function cleanJavadoc(raw) {
  return raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim()
}

// Javadoc-Block einem Methodenstart zuordnen: der Block muss direkt davor liegen,
// dazwischen nur Whitespace/Annotationen/Modifier (keine {, }, ; -> sonst gehoert
// er zu etwas anderem). Lieber nichts zuordnen als falsch raten.
function javadocFor(methodStart, blocks, source) {
  let best = null
  for (const b of blocks) {
    if (b.end <= methodStart && (!best || b.end > best.end)) best = b
  }
  if (!best) return ''
  const gap = source.slice(best.end, methodStart)
  if (/[{};]/.test(gap)) return ''
  return best.text
}

// --- Methoden eines Typs ------------------------------------------------------

function extractMethods(typeNode, blocks, source) {
  const methodNodes = [
    ...findAll(typeNode, 'methodDeclaration'),
    ...findAll(typeNode, 'interfaceMethodDeclaration'),
  ]
  const methods = []
  for (const mNode of methodNodes) {
    const declarator = findFirst(mNode, 'methodDeclarator')
    if (!declarator) continue
    const nameTok = collectTokens(declarator)
      .find(t => t.tokenType?.name === 'Identifier')
    if (!nameTok) continue

    const result = findFirst(mNode, 'result')
    let returnType = typeText(result)
    if (!returnType || /^void$/i.test(returnType)) returnType = 'void'

    const params = []
    for (const p of findAll(declarator, 'variableParaRegularParameter')) {
      params.push({
        type: typeText(findFirst(p, 'unannType')),
        name: collectTokens(findFirst(p, 'variableDeclaratorId') || p)
          .find(t => t.tokenType?.name === 'Identifier')?.image || '',
      })
    }
    // Varargs (z. B. String... args)
    for (const p of findAll(declarator, 'variableArityParameter')) {
      const idTok = collectTokens(p).filter(t => t.tokenType?.name === 'Identifier')
      params.push({
        type: typeText(findFirst(p, 'unannType')) + '...',
        name: idTok.length ? idTok[idTok.length - 1].image : '',
      })
    }

    methods.push({
      method_name: nameTok.image,
      return_type: returnType,
      parameters: params,
      javadoc: javadocFor(minOffset(mNode), blocks, source),
    })
  }
  return methods
}

// --- Haupteinstieg ------------------------------------------------------------

// Liefert { package, imports:[fqn], classes:[{class_name,class_type,methods}], primary }.
// Wirft bei Syntaxfehlern -> die Route wandelt das in 400 um.
export function parseJava(source) {
  const cst = parse(source)
  const blocks = extractJavadocBlocks(source)

  const pkgNode = findFirst(cst, 'packageDeclaration')
  const pkg = pkgNode ? dottedName(pkgNode) : ''

  const imports = []
  for (const imp of findAll(cst, 'importDeclaration')) {
    const name = dottedName(imp)
    if (!name) continue
    const hasStar = collectTokens(imp).some(t => t.tokenType?.name === 'Star')
    imports.push(hasStar ? `${name}.*` : name)
  }

  const candidates = [
    ...findAll(cst, 'normalClassDeclaration').map(node => ({ node, type: 'class' })),
    ...findAll(cst, 'normalInterfaceDeclaration').map(node => ({ node, type: 'interface' })),
    ...findAll(cst, 'enumDeclaration').map(node => ({ node, type: 'enum' })),
    ...findAll(cst, 'annotationTypeDeclaration').map(node => ({ node, type: 'annotation' })),
  ].sort((a, b) => minOffset(a.node) - minOffset(b.node))

  const classes = candidates.map(({ node, type }) => {
    const typeId = findAll(node, 'typeIdentifier')
      .sort((a, b) => minOffset(a) - minOffset(b))[0]
    const className = typeId
      ? collectTokens(typeId).find(t => t.tokenType?.name === 'Identifier')?.image
      : null
    return {
      class_name: className,
      class_type: type,
      methods: extractMethods(node, blocks, source),
    }
  }).filter(c => c.class_name)

  if (!classes.length) {
    throw new Error('Keine Klasse/Interface/Enum im Quelltext gefunden')
  }

  return { package: pkg, imports, classes, primary: classes[0] }
}
