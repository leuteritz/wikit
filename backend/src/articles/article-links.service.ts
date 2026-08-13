import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { MarkdownService } from '../common/markdown.service';
import { WikiLink } from '../common/wikilink';

/**
 * Der Index hinter `[[Wikilinks]]` – und damit hinter „wer verlinkt hierher?".
 *
 * Er ist eine reine ABLEITUNG aus `articles.content` und wird deshalb genau dort geschrieben, wo
 * der Inhalt geschrieben wird: in derselben Transaktion, direkt neben `FtsService.indexArticle`.
 *
 * ⚠️ Was ein Link IST, entscheidet dieser Dienst nicht – das hat `renderMarkdown` beim Rendern
 * desselben Inhalts bereits getan und gibt es heraus. Hier wird nur noch geschrieben. Damit gilt
 * das Parsen (teuer, async) als vor der Transaktion erledigt, und Index und Anzeige koennen sich
 * nicht widersprechen.
 */
@Injectable()
export class ArticleLinksService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
  ) {}

  /**
   * Bestands-Datenbanken kennen die Tabelle, aber sie ist leer – erst ein Speichern wuerde sie
   * fuellen, und bis dahin behauptete jeder Artikel, niemand verlinke ihn.
   *
   * Die Arbeitsliste wird aus dem BESTAND abgeleitet (Artikel mit `[[` im Text, aber ohne Zeile),
   * nicht aus einem Merker – gleiche Bauart wie `InsightsService.backfillMetrics()`. Damit ist der
   * Lauf beliebig oft wiederholbar und kostet nach dem ersten Mal nichts.
   */
  async onModuleInit(): Promise<void> {
    // Nicht blockieren: der Server soll antworten, auch wenn hier noch etwas nachgezogen wird.
    setTimeout(() => void this.backfill().catch(() => undefined), 0);
  }

  private async backfill(): Promise<void> {
    const rows: Array<{ id: number; content: string }> = await this.ds.query(
      `SELECT a.id, a.content FROM articles a
        WHERE a.content LIKE '%[[%'
          AND NOT EXISTS (SELECT 1 FROM article_links l WHERE l.source_id = a.id)`,
    );
    if (!rows.length) return;
    const known = await this.knownSlugs();
    for (const r of rows) {
      // ⚠️ Hier wird wirklich GERENDERT, obwohl nur die Links gebraucht werden – und das ist der
      // Punkt: nur der Parser weiss, was in diesem Text ein Link ist und was in einem Codeblock
      // steht. Ein billigerer Textscan waere die zweite Fassung dieser Regel. Der Lauf trifft je
      // Artikel genau einmal und nur beim Nachziehen einer Bestands-Datenbank.
      const { links } = await this.markdown.renderMarkdown(r.content || '', { knownSlugs: known });
      await this.ds.transaction((m) => this.reindex(m, r.id, links));
    }
  }

  /** Alle bekannten Slugs – der Renderer braucht sie, um „fehlt" von „ist da" zu unterscheiden. */
  async knownSlugs(): Promise<Set<string>> {
    const rows: Array<{ slug: string }> = await this.ds.query('SELECT slug FROM articles');
    return new Set(rows.map((r) => r.slug));
  }

  /**
   * Den Index eines Artikels neu aufbauen.
   *
   * ⚠️ Die Links kommen als PARAMETER, nicht aus dem Text: `renderMarkdown` hat sie beim Rendern
   * desselben Inhalts bereits gesammelt (s. dort). Damit kann der Index nichts kennen, was nicht
   * auch als Link gerendert wurde – und nichts uebersehen, was gerendert wurde.
   *
   * Loeschen + Einfuegen statt Abgleichen: die Liste ist kurz, und ein Abgleich waere eine zweite
   * Stelle, an der „welche Links hat dieser Text?" entschieden wird.
   */
  async reindex(manager: EntityManager, articleId: number, links: WikiLink[]): Promise<void> {
    await manager.query('DELETE FROM article_links WHERE source_id = ?', [articleId]);
    if (!links.length) return;
    for (const l of links) {
      // Der Zwischenspeicher wird in DERSELBEN Anweisung gefuellt, damit er nie von der Wahrheit
      // abweichen kann: existiert der Slug nicht, bleibt er NULL – und genau das heisst „fehlt".
      await manager.query(
        `INSERT OR REPLACE INTO article_links (source_id, target_slug, target_id, label)
         VALUES (?, ?, (SELECT id FROM articles WHERE slug = ?), ?)`,
        [articleId, l.slug, l.slug, l.label],
      );
    }
  }

  /**
   * Nach einer Slug-Aenderung: der Zwischenspeicher folgt der Wahrheit, der TEXT der anderen
   * Artikel bleibt, wie er ist.
   *
   * ⚠️ Ausdruecklich KEIN Umschreiben von `target_slug`. Ein Link im Text ist eine Zeichenkette –
   * er ueberlebt kein Umbenennen, und der Index darf nichts behaupten, was im Markdown nicht steht
   * (dieselbe Regel, aus der `article-health` kaputte Markdown-Links meldet, statt sie zu heilen).
   * Was hier passiert, ist nur: der alte Slug zeigt jetzt ins Leere, der neue auf diesen Artikel.
   */
  async slugChanged(manager: EntityManager, articleId: number, oldSlug: string, newSlug: string): Promise<void> {
    if (oldSlug === newSlug) return;
    await manager.query('UPDATE article_links SET target_id = NULL WHERE target_slug = ?', [oldSlug]);
    await manager.query('UPDATE article_links SET target_id = ? WHERE target_slug = ?', [articleId, newSlug]);
  }

  /**
   * Ein neuer Artikel kann Links einloesen, die vorher ins Leere zeigten – der Backlink erscheint
   * dann sofort, ohne dass jemand die verweisenden Artikel anfasst.
   */
  async slugAppeared(manager: EntityManager, articleId: number, slug: string): Promise<void> {
    await manager.query('UPDATE article_links SET target_id = ? WHERE target_slug = ? AND target_id IS NULL', [
      articleId,
      slug,
    ]);
  }

  /** Wer verlinkt auf diesen Artikel? */
  async backlinks(articleId: number): Promise<{ items: any[]; total: number }> {
    const rows = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.summary, l.label
         FROM article_links l
         JOIN articles a ON a.id = l.source_id
        WHERE l.target_id = ?
        ORDER BY a.title COLLATE NOCASE`,
      [articleId],
    );
    return { items: rows, total: rows.length };
  }

  /** Wikilinks, die ins Leere zeigen – gelesen von `article-health`. */
  async brokenLinks(): Promise<Array<{ id: number; slug: string; title: string; target: string }>> {
    return this.ds.query(
      `SELECT a.id, a.slug, a.title, l.target_slug AS target
         FROM article_links l
         JOIN articles a ON a.id = l.source_id
        WHERE l.target_id IS NULL
        ORDER BY a.title COLLATE NOCASE`,
    );
  }
}
