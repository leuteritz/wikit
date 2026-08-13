/**
 * Artikel als Markdown – mit YAML-Frontmatter, in EINER Fassung fuer Export und Import.
 *
 * Warum ueberhaupt ein Kopf: der Java-Export kommt ohne aus, weil Java-Quelltext sich selbst
 * beschreibt (`package` + `class` stehen drin, alles davor darf weggeworfen werden). Ein Artikel
 * ist mehr als sein Text – Titel, Slug, Zusammenfassung, Kategorie und Schlagwoerter gehoeren dazu
 * und stehen nirgends im Fliesstext. Frontmatter ist das etablierte Format fuer genau diese Frage;
 * ein eigenes waere eines mehr, das niemand sonst liest.
 *
 * ⚠️ Bewusst KEIN YAML-Parser als Abhaengigkeit. Geschrieben werden hier genau sechs Felder mit
 * bekannten Typen, und gelesen wird genau das, was hier geschrieben wurde – ein vollstaendiger
 * YAML-Dialekt (Anker, Blockskalare, verschachtelte Maps) waere Maschinerie fuer einen Fall, den
 * dieses Format nicht kennt. Was der Leser nicht versteht, ueberspringt er, statt zu raten.
 */

export interface ArticleDoc {
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  tags: string[];
  content: string;
}

// Trennt zwei Artikel in der Sammelform. Eine Zeile, die als Markdown nichts bedeutet und in
// keinem Codeblock vorkommen kann (drei Bindestriche waeren eine horizontale Linie).
export const DOC_SEPARATOR = '<!-- wikit:article -->';

/** Ein Wert, der ohne Anfuehrungszeichen nicht sicher waere. */
function yamlValue(v: string): string {
  const s = String(v ?? '');
  if (!s) return "''";
  // Alles, was YAML anders lesen koennte, kommt in einfache Anfuehrungszeichen (dort gilt nur das
  // verdoppelte Apostroph als Escape – kein Backslash-Dickicht).
  if (/^[\w][\w .\-/]*$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** Ein Artikel als Markdown-Dokument. */
export function toMarkdown(doc: ArticleDoc): string {
  const head = [
    '---',
    `slug: ${yamlValue(doc.slug)}`,
    `title: ${yamlValue(doc.title)}`,
    `summary: ${yamlValue(doc.summary || '')}`,
    `category: ${doc.category ? yamlValue(doc.category) : ''}`,
    `tags: [${(doc.tags || []).map(yamlValue).join(', ')}]`,
    '---',
    '',
  ];
  // Genau ein Zeilenumbruch am Ende – so ist die Sammelform stabil, egal wie der Artikel aufhoert.
  return head.join('\n') + (doc.content || '').replace(/\s*$/, '') + '\n';
}

/**
 * Ein Markdown-Dokument zurueck in seine Felder.
 *
 * ⚠️ Ohne Frontmatter ist es kein Fehler, sondern ein Artikel ohne Metadaten: Titel aus der ersten
 * Ueberschrift, sonst aus dem Dateinamen des Aufrufers. Wer eine fremde `.md` einliest, soll sie
 * bekommen und nicht eine Fehlermeldung ueber ein Format, das er nicht kannte.
 */
export function fromMarkdown(text: string): ArticleDoc {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const meta: Record<string, string> = {};
  let content = src;
  if (m) {
    content = src.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-zA-Z_][\w]*)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2];
    }
  }
  const tags = (meta.tags || '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => unquote(t))
    .filter(Boolean);
  const heading = /^#\s+(.+)$/m.exec(content);
  return {
    slug: unquote(meta.slug || ''),
    title: unquote(meta.title || '') || (heading ? heading[1].trim() : ''),
    summary: unquote(meta.summary || ''),
    category: unquote(meta.category || '') || null,
    tags,
    content: content.replace(/^\s*\n/, ''),
  };
}

/** Mehrere Artikel als EIN Text – dieselbe Bauart wie der Java-Export. */
export function joinDocs(docs: ArticleDoc[]): string {
  return docs.map(toMarkdown).join(`\n${DOC_SEPARATOR}\n\n`);
}

/** …und zurueck. Ein Text ohne Trenner ist ein einzelner Artikel. */
export function splitDocs(text: string): ArticleDoc[] {
  return String(text || '')
    .split(new RegExp(`^${DOC_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'))
    .map((part) => part.trim())
    .filter(Boolean)
    .map(fromMarkdown)
    .filter((d) => d.title || d.content.trim());
}
