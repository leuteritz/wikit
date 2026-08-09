import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';
import {
  documentText,
  EMBED_BATCH,
  FLOOR_SCORE,
  normalize,
  similarity,
  toVector,
} from '../common/embedding.util';

/**
 * Bedeutungssuche über die Wiki-Artikel – der zweite Wissensspeicher dieses Projekts.
 *
 * Warum es ihn gibt: der Code sagt, WAS passiert; der Artikel sagt, WARUM. „Warum läuft der Import
 * zweistufig?" hat im Quelltext keine Antwort und in einer Notiz schon – und `/ask`, die einzige
 * Ansicht, die eine Frage in Prosa beantwortet, sah bis dahin nur die Klassen. Eine leere Antwort
 * darauf las sich wie eine Aussage über das Projekt, war aber eine über die Auswahl der Quellen.
 *
 * Baugleich zu `JavaEmbeddingsService`, und das ist die Bedingung, nicht der Zufall: `/ask` mischt
 * beide Trefferlisten zu EINER Rangliste, also müssen Modell, Präfixe, Normalisierung und Schnitt
 * dieselben sein (`common/embedding.util.ts`). Drei eigene Festlegungen:
 *
 * 1. **Ein Vektor je Artikel**, nicht je Abschnitt – dieselbe Regel wie „ein Vektor je Klasse".
 *    Der Beleg-Chip öffnet damit den Artikel, nicht eine Überschrift darin.
 * 2. **Code-Blöcke gehen NICHT mit ein** (s. `plainText`) – aus genau dem Grund, aus dem der
 *    Rohquelltext einer Klasse nicht eingebettet wird. Ein exportierter Klassenartikel besteht
 *    zur Hälfte aus Java, und diese Hälfte ist in jedem solchen Artikel ähnlich: sie zieht die
 *    Vektoren zusammen, statt sie zu unterscheiden.
 * 3. **Kein Fortschrittsstrom.** Ein persönliches Wiki hat Dutzende Artikel, nicht Tausende – der
 *    Lauf ist ein Request von Sekunden. Der SSE-Apparat der Klassen wäre hier mehr Maschinerie
 *    als Rechnung, und `JavaBatchProgressService` in `articles/` zu ziehen wäre eine Kopplung für
 *    einen Balken, der zweimal zuckt.
 */

// Obergrenze des eingebetteten Textes je Artikel – dieselbe Größenordnung wie bei den Klassen.
// Was darüber steht, schneidet das Modell ohnehin ab; hier wird an der Stelle gekürzt, die am
// wenigsten aussagt (das Ende des Fließtextes, nicht Titel und Zusammenfassung).
const MAX_TEXT = 2000;

type Row = {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  content: string;
  category: string | null;
};

@Injectable()
export class ArticleEmbeddingsService {
  private readonly logger = new Logger(ArticleEmbeddingsService.name);
  // articleId -> normalisierter Vektor. Geladen beim ersten Bedarf, verworfen nach jedem Lauf.
  private cache: Map<number, Float32Array> | null = null;
  private building = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly settings: SettingsService,
  ) {}

  // --- Was eingebettet wird --------------------------------------------------------------------

  /**
   * Markdown auf das reduzieren, was eine Bedeutung trägt.
   *
   * ⚠️ Fenced Code fliegt als ERSTES raus – vor allem anderen. In einem Wiki, das Klassenartikel
   * exportiert, ist er der größte und zugleich uninformativste Teil vieler Artikel. Der Rest ist
   * Auszeichnung: `#`, `*`, Tabellenstriche und die Klammern von Links sagen nichts über das Thema,
   * aber sie kosten Platz im Fenster und Ähnlichkeit im Raum.
   *
   * Public, weil `/ask` denselben Text in den Prompt setzt, der hier eingebettet wurde: eine
   * zweite Aufbereitung hieße, dass die Auswahl auf einem anderen Text beruht als die Antwort.
   */
  plainText(md: string): string {
    return (md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      // Bildunterschriften sagen etwas, die URL dahinter nicht.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/[*_~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private textFor(row: Row, tags: string[]): string {
    // Titel und Zusammenfassung stehen vorn: sie überleben das Kürzen, der Fließtext nicht.
    const head = [
      row.title,
      row.category ? `Category: ${row.category}` : '',
      tags.length ? `Tags: ${tags.join(', ')}` : '',
      (row.summary || '').trim(),
    ]
      .filter(Boolean)
      .join('\n');
    const body = this.plainText(row.content);
    return `${head}\n${body}`.slice(0, MAX_TEXT);
  }

  private async collect(): Promise<Array<{ row: Row; text: string; hash: string }>> {
    const rows: Row[] = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.summary, a.content, c.name AS category
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        ORDER BY a.id`,
    );
    if (!rows.length) return [];

    const tags = new Map<number, string[]>();
    for (const t of await this.ds.query(
      `SELECT at.article_id, t.name
         FROM article_tags at JOIN tags t ON t.id = at.tag_id
        ORDER BY t.name`,
    )) {
      const id = Number(t.article_id);
      const list = tags.get(id) || [];
      list.push(t.name);
      tags.set(id, list);
    }

    return rows.map((row) => {
      const text = this.textFor(row, tags.get(row.id) || []);
      return { row, text, hash: createHash('sha1').update(text).digest('hex') };
    });
  }

  // --- Stand des Index -------------------------------------------------------------------------

  async status(): Promise<any> {
    const cfg = await this.settings.bot();
    const model = cfg.embedModel || '';
    const items = await this.collect();
    const stored = new Map<number, { model: string; source_hash: string }>();
    for (const r of await this.ds.query(`SELECT article_id, model, source_hash FROM article_embeddings`)) {
      stored.set(Number(r.article_id), { model: r.model, source_hash: r.source_hash });
    }

    let indexed = 0;
    let stale = 0;
    for (const it of items) {
      const s = stored.get(it.row.id);
      if (!s) continue;
      if (s.model !== model || s.source_hash !== it.hash) stale++;
      else indexed++;
    }
    return {
      model,
      enabled: !!model,
      total: items.length,
      indexed,
      stale,
      missing: items.length - indexed - stale,
      building: this.building,
      ready: !!model && indexed > 0,
    };
  }

  // --- Aufbauen --------------------------------------------------------------------------------

  /**
   * Fehlende und veraltete Vektoren nachziehen.
   *
   * `force` ist der Weg nach einem Modellwechsel: die Hashes passen dann zwar, die Vektoren liegen
   * aber in einem anderen Raum und sind mit den Klassen-Vektoren nicht mehr vergleichbar.
   */
  async rebuild(force = false): Promise<any> {
    if (this.building) return { started: false, reason: 'A build is already running' };
    const cfg = await this.settings.bot();
    const model = cfg.embedModel || '';
    if (!model) return { started: false, reason: 'No embedding model configured' };

    this.building = true;
    try {
      const items = await this.collect();
      const stored = new Map<number, { model: string; source_hash: string }>();
      for (const r of await this.ds.query(`SELECT article_id, model, source_hash FROM article_embeddings`)) {
        stored.set(Number(r.article_id), { model: r.model, source_hash: r.source_hash });
      }
      const todo = items.filter((it) => {
        if (force) return true;
        const s = stored.get(it.row.id);
        return !s || s.model !== model || s.source_hash !== it.hash;
      });

      let done = 0;
      let failed = 0;
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const slice = todo.slice(i, i + EMBED_BATCH);
        const vectors = await this.ollama.embed(slice.map((it) => documentText(model, it.text)));
        if (vectors.length !== slice.length) {
          // Ollama weg oder Modell nicht gepullt: abbrechen statt weiter ins Leere zu fragen. Was
          // bereits geschrieben ist, bleibt gueltig – der naechste Lauf macht dort weiter.
          failed = todo.length - done;
          break;
        }
        for (let k = 0; k < slice.length; k++) {
          const vec = normalize(vectors[k]);
          await this.ds.query(
            `INSERT INTO article_embeddings (article_id, model, dim, source_hash, vector, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(article_id) DO UPDATE SET
               model = excluded.model, dim = excluded.dim,
               source_hash = excluded.source_hash, vector = excluded.vector,
               created_at = excluded.created_at`,
            [slice[k].row.id, model, vec.length, slice[k].hash, Buffer.from(vec.buffer)],
          );
        }
        done += slice.length;
      }

      // Alles, was zu einem anderen Modell gehoert, ist toter Ballast – und ein Treffer daraus
      // waere eine Falschauskunft.
      await this.ds.query(`DELETE FROM article_embeddings WHERE model <> ?`, [model]);
      this.cache = null;
      return { started: true, indexed: done, skipped: items.length - todo.length, failed, model };
    } catch (err: any) {
      this.logger.warn(`Artikel-Index fehlgeschlagen: ${err?.message || err}`);
      throw err;
    } finally {
      this.building = false;
    }
  }

  /** Alles verwerfen (Modellwechsel von Hand, Komplett-Reset). */
  async clear(): Promise<void> {
    await this.ds.query(`DELETE FROM article_embeddings`);
    this.cache = null;
  }

  // --- Suchen ----------------------------------------------------------------------------------

  private async vectors(): Promise<Map<number, Float32Array>> {
    if (this.cache) return this.cache;
    const map = new Map<number, Float32Array>();
    for (const r of await this.ds.query(`SELECT article_id, vector FROM article_embeddings`)) {
      map.set(Number(r.article_id), toVector(r.vector as Buffer));
    }
    this.cache = map;
    return map;
  }

  /**
   * Jeden Artikel gegen eine bereits eingebettete Frage bewerten – UNGESCHNITTEN.
   *
   * Gegenstück zu `JavaEmbeddingsService.scoreAll`; der relative Schnitt fällt bei `/ask` über die
   * Vereinigung beider Listen (s. dort).
   */
  async scoreAll(qv: Float32Array): Promise<{ indexed: number; scored: Array<{ id: number; score: number }> }> {
    const map = await this.vectors();
    const scored: Array<{ id: number; score: number }> = [];
    for (const [id, vec] of map) {
      const score = similarity(qv, vec);
      if (score !== null && score >= FLOOR_SCORE) scored.push({ id, score });
    }
    return { indexed: map.size, scored };
  }

  /** Wie viele Artikel der Index gerade beantworten kann – ohne einen Ollama-Aufruf. */
  async indexedCount(): Promise<number> {
    return (await this.vectors()).size;
  }
}
