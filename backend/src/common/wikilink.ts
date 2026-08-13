/**
 * Die Syntaxregel fuer `[[Wikilinks]]` – EINMAL, ohne Datenbank.
 *
 * Zwei Seiten brauchen sie und muessen sich einig sein: der markdown-it-Ruler, der den Link
 * RENDERT, und der Indexdienst, der ihn fuer die Rueckwaertssuche AUFSCHREIBT. Eine zweite Fassung
 * hiesse, dass ein Artikel einen Link anzeigt, den die Backlink-Liste nicht kennt (oder umgekehrt).
 * Gleiche Bauart wie `common/edge-compute.ts`: die Rechnung kennt keine DB, nur ihre Aufrufer.
 *
 * Zwei Formen:
 *   [[Java Streams]]              -> Ziel ueber den slugifizierten Titel, Anzeigetext = Titel
 *   [[java-streams|the stream API]] -> Ziel explizit, Anzeigetext frei
 *
 * ⚠️ Aufgeloest wird ueber `slugify` – DIESELBE Funktion, mit der `uniqueSlug` den Slug beim
 * Anlegen bildet. Ein zweiter Normalisierer waere ein zweites Ergebnis fuer denselben Titel.
 */

/** Muss `MarkdownService.slugify` entsprechen – wird von dort hereingereicht. */
export type Slugify = (text: string) => string;

export interface WikiLink {
  /** Slug des Ziels (bereits normalisiert). */
  slug: string;
  /** Was im Text steht. Null = der Titel selbst. */
  label: string | null;
  /** Der rohe Inhalt zwischen den Klammern – nur fuer Meldungen. */
  raw: string;
}

/** Ein einzelnes Klammerpaar zerlegen. Liefert `null`, wenn nichts Brauchbares drinsteht. */
export function parseWikiLink(inner: string, slugify: Slugify): WikiLink | null {
  const raw = (inner || '').trim();
  if (!raw) return null;
  const bar = raw.indexOf('|');
  const target = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
  const label = bar >= 0 ? raw.slice(bar + 1).trim() : null;
  if (!target) return null;
  const slug = slugify(target);
  if (!slug) return null;
  return { slug, label: label || null, raw: target };
}

/**
 * ⚠️ **Es gibt bewusst KEINE zweite Funktion, die einen Rohtext nach Wikilinks absucht.**
 *
 * Der erste Entwurf hatte eine (Code-Faelle per Regex entfernen, dann suchen) – und sie lag
 * gemessen daneben: in einem um vier Leerzeichen EINGERUECKTEN Codeblock fand sie
 * `new int[[3]][3]` als Link auf einen Artikel namens „3", waehrend der Renderer denselben Block
 * korrekt als Code behandelte. Ein Befund „toter Link [[3]]" ueber Text, der gar kein Link ist.
 *
 * Markdowns Blockregeln (Fences, eingerueckter Code, Inline-Code, HTML-Bloecke) noch einmal
 * nachzubauen hiesse, markdown-it ein zweites Mal zu schreiben. Stattdessen sammelt der Ruler die
 * Links waehrend des Renderns ein (`env.wikiLinks`) und `renderMarkdown` gibt sie heraus – wer den
 * Index schreibt, benutzt GENAU das, was auch gerendert wurde.
 */

/** Der Ruler braucht die rohe Regel ohne `g`-Flag (er prueft eine Position). */
export const WIKILINK_AT_POS = /^\[\[([^[\]\n]+)\]\]/;
