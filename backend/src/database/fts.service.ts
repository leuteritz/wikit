import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

// ──────────────────────────────────────────────────────────────────────────────
// FTS5-AUSNAHME: TypeORM unterstuetzt FTS5 nicht nativ. Volltext-Indexpflege und
// -Suche laufen daher bewusst ueber Raw-SQL via EntityManager.query() / DataSource.query().
// Das ist die einzige Stelle (neben dem Schema-DDL), an der wir Plain-SQL verwenden.
// 1:1 portiert aus indexArticle()/buildMatch() des alten backend/db.js + routes/search.js.
// ──────────────────────────────────────────────────────────────────────────────
@Injectable()
export class FtsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // Aktualisiert den FTS-Eintrag eines Artikels (Tags werden mit eingebettet).
  // Erwartet den Transaktions-`manager`, damit es in derselben Transaktion laeuft.
  async indexArticle(manager: EntityManager, articleId: number): Promise<void> {
    const rows = await manager.query(
      'SELECT id, title, summary, content FROM articles WHERE id = ?',
      [articleId],
    );
    const a = rows[0];
    await manager.query('DELETE FROM articles_fts WHERE rowid = ?', [articleId]);
    if (!a) return;
    const tagRows = await manager.query(
      `SELECT t.name FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
       WHERE at.article_id = ? ORDER BY t.name`,
      [articleId],
    );
    const tags = tagRows.map((r: any) => r.name).join(' ');
    await manager.query(
      'INSERT INTO articles_fts (rowid, title, summary, content, tags) VALUES (?,?,?,?,?)',
      [a.id, a.title, a.summary, a.content, tags],
    );
  }

  // Serverseitige FTS5-Volltextsuche mit Snippet-Highlights und bm25-Ranking.
  // Liefert die rohen Artikelzeilen inkl. `snippet`; der Aufrufer serialisiert.
  async search(q: string): Promise<any[]> {
    const match = this.buildMatch(q);
    try {
      // snippet(..., 2, ...) -> Spalte 2 = content (Reihenfolge: title, summary, content, tags).
      return await this.dataSource.query(
        `SELECT a.*,
                snippet(articles_fts, 2, '<mark>', '</mark>', ' … ', 16) AS snippet,
                bm25(articles_fts) AS rank
         FROM articles_fts
         JOIN articles a ON a.id = articles_fts.rowid
         WHERE articles_fts MATCH ?
         ORDER BY rank
         LIMIT 30`,
        [match],
      );
    } catch {
      // Ungueltige FTS-Syntax -> leer (wie zuvor).
      return [];
    }
  }

  // Nutzereingabe in eine sichere FTS5-Query mit Prefix-Suche umwandeln.
  private buildMatch(q: string): string {
    return q
      .replace(/["()]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' ');
  }
}
