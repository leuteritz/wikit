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
  RELATIVE_CUTOFF,
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
 *
 * Seit `suggest()` hat der Index einen **zweiten Leser**, und der beantwortet die Frage, die das
 * Beziehungsnetz stellt, aber nicht beantworten konnte: es findet den verwaisten Artikel – und
 * lässt einen dann damit allein, denn „womit verknüpfe ich ihn?" steht nirgends. Genau das weiß
 * dieser Index bereits, ohne einen einzigen zusätzlichen Ollama-Aufruf: die Vektoren liegen da, es
 * fehlte nur der Vergleich untereinander statt gegen eine Frage.
 */

// Obergrenze des eingebetteten Textes je Artikel – dieselbe Größenordnung wie bei den Klassen.
// Was darüber steht, schneidet das Modell ohnehin ab; hier wird an der Stelle gekürzt, die am
// wenigsten aussagt (das Ende des Fließtextes, nicht Titel und Zusammenfassung).
const MAX_TEXT = 2000;

// Wie viele Vorschläge ein Artikel höchstens bekommt. Vier, weil die Liste eine Handlung anbietet
// und keine Rangliste ist: wer zehn Vorschläge sieht, hakt keinen ab.
const SUGGEST_LIMIT = 4;

// ⚠️ Die Schwelle ist der Bestand selbst, nicht eine Zahl über ein Modell (gleiche Begründung wie
// `RELATIVE_CUTOFF`, nur eine Ebene höher). Ein Vorschlag muss deutlich ähnlicher sein als zwei
// beliebige Artikel dieses Wikis – und wie ähnlich das ist, weiß nur dieses Wiki in diesem Modell:
// bei nomic-embed-text liegen zwei völlig fremde deutsche Notizen schon bei 0,5. Eine feste Latte
// hätte dort entweder alles durchgelassen oder bei einem Modellwechsel alles verworfen.
const SUGGEST_PERCENTILE = 0.9;

// Unterhalb dieser Paarzahl ist ein Perzentil keine Aussage, sondern der zweitgrößte Wert (dasselbe
// Argument wie gegen hohe Perzentile beim Hotspot-Score). Dann gilt nur der Schnitt gegen den
// eigenen besten Nachbarn – bei fünf Artikeln sieht man die Liste ohnehin ganz.
const MIN_PAIRS = 12;

/** Ein Artikel, wie er als Vorschlag danebensteht. */
export type SuggestedLink = {
  id: number;
  slug: string;
  title: string;
  category: string | null;
  category_id: number | null;
  /** Kommt aus „Save to wiki" einer Java-Klasse – der Chip daneben sagt es. */
  is_class: boolean;
  score: number;
};

type Meta = Omit<SuggestedLink, 'score'>;

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
      let reason: string | null = null;
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const slice = todo.slice(i, i + EMBED_BATCH);
        const { vectors, error } = await this.ollama.embed(slice.map((it) => documentText(model, it.text)));
        if (error || vectors.length !== slice.length) {
          // Abbrechen statt weiter ins Leere zu fragen; der Grund faehrt mit (gleiche Begruendung
          // wie bei den Klassen). Was bereits geschrieben ist, bleibt gueltig.
          reason = error || `Ollama returned ${vectors.length} vector(s) for ${slice.length} text(s)`;
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
      return { started: true, indexed: done, skipped: items.length - todo.length, failed, reason, model };
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

  // --- Vorschläge ------------------------------------------------------------------------------

  /**
   * Was ein Vorschlag über sich selbst wissen muss – plus die Kennzeichnung als Klassenartikel.
   *
   * `EXISTS` statt `LEFT JOIN java_files`: zeigen zwei Klassen auf denselben Artikel, lieferte der
   * Join ihn doppelt – und ein Artikel, der zweimal in derselben Vorschlagsliste steht, sieht aus
   * wie ein Fehler der Rechnung.
   */
  private async metadata(): Promise<Map<number, Meta>> {
    const rows = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.category_id, c.name AS category,
              EXISTS (SELECT 1 FROM java_files jf WHERE jf.article_id = a.id) AS is_class
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id`,
    );
    return new Map(
      rows.map((r: any) => [
        Number(r.id),
        {
          id: Number(r.id),
          slug: r.slug,
          title: r.title,
          category: r.category ?? null,
          category_id: r.category_id ?? null,
          is_class: !!Number(r.is_class),
        } as Meta,
      ]),
    );
  }

  /**
   * Paare, zwischen denen bereits eine Beziehung steht – als **ungeordneter** Schlüssel.
   *
   * ⚠️ Richtungslos, obwohl `relations` gerichtet ist: „A verweist auf B" beantwortet die Frage
   * „gehören die zusammen?" für beide Seiten. B weiter A vorzuschlagen hieße, zu einer bestehenden
   * Verknüpfung die Gegenrichtung anzubieten – eine zweite Kante zwischen denselben zwei Artikeln,
   * die im Netz nichts hinzufügt.
   */
  private async linkedPairs(): Promise<Set<string>> {
    const set = new Set<string>();
    for (const r of await this.ds.query(`SELECT source_id, target_id FROM relations`)) {
      set.add(pairKey(Number(r.source_id), Number(r.target_id)));
    }
    return set;
  }

  /**
   * Jeden Artikel gegen jeden anderen – und daraus je Artikel seine stärksten, noch unverknüpften
   * Nachbarn.
   *
   * Die Rechnung ist O(n²) über Dutzende Vektoren und läuft vollständig im Speicher; ein
   * persönliches Wiki hat keine Größenordnung, in der das eine Frage wäre (bei 200 Artikeln sind es
   * 20 000 Skalarprodukte à 768 Werte – Millisekunden). Deshalb auch kein Cache: er wäre eine
   * zweite Wahrheit mit eigener Invalidierung an jedem Schreibpfad, gleiche Begründung wie bei
   * `/insights`.
   *
   * Drei Schnitte, in dieser Reihenfolge:
   * 1. **Bestehende Beziehungen** fliegen raus – ein Vorschlag für etwas, das schon verknüpft ist,
   *    ist keine Auskunft, sondern Rauschen vor den echten Lücken.
   * 2. **Die Latte des Bestands** (`SUGGEST_PERCENTILE`): deutlich ähnlicher als zwei beliebige
   *    Artikel dieses Wikis. Ohne sie bekommt jeder Artikel seine vier Nachbarn, auch wenn keiner
   *    davon etwas mit ihm zu tun hat – und ein Vorschlag, der immer kommt, sagt nichts.
   * 3. **Der Schnitt gegen den eigenen besten** (`RELATIVE_CUTOFF`, dieselbe Konstante wie bei
   *    `/ask`): steht ein sehr guter Treffer oben, gehören drei mittelmäßige nicht darunter.
   */
  private async compute(): Promise<{
    enabled: boolean;
    indexed: number;
    reason: string | null;
    threshold: number | null;
    byArticle: Map<number, SuggestedLink[]>;
  }> {
    const cfg = await this.settings.bot();
    const empty = { byArticle: new Map<number, SuggestedLink[]>(), threshold: null };
    if (!cfg.embedModel) {
      return { enabled: false, indexed: 0, reason: 'No embedding model configured', ...empty };
    }

    const vectors = await this.vectors();
    // Zwei Artikel sind das Minimum für ein Paar – darunter ist „nichts gefunden" eine Aussage über
    // den Bestand und keine über die Ähnlichkeit.
    if (vectors.size < 2) {
      return {
        enabled: true,
        indexed: vectors.size,
        reason: vectors.size ? 'Only one article is indexed' : 'No article is indexed yet',
        ...empty,
      };
    }

    const ids = [...vectors.keys()];
    const linked = await this.linkedPairs();
    const meta = await this.metadata();

    // Alle Paare EINMAL – die Latte braucht die ganze Verteilung, auch die der bereits verknüpften
    // Paare: sie sagen mit, wie ähnlich sich zwei zusammengehörende Artikel in diesem Wiki sind.
    const scores: number[] = [];
    const neighbours = new Map<number, SuggestedLink[]>(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i++) {
      for (let k = i + 1; k < ids.length; k++) {
        const score = similarity(vectors.get(ids[i])!, vectors.get(ids[k])!);
        if (score === null || score < FLOOR_SCORE) continue;
        scores.push(score);
        if (linked.has(pairKey(ids[i], ids[k]))) continue;
        const a = meta.get(ids[i]);
        const b = meta.get(ids[k]);
        // Ein Vektor ohne Artikel ist Altbestand zwischen zwei Läufen – kein Vorschlag ohne Ziel.
        if (a && b) {
          neighbours.get(ids[i])!.push({ ...b, score });
          neighbours.get(ids[k])!.push({ ...a, score });
        }
      }
    }

    const threshold = scores.length >= MIN_PAIRS ? percentile(scores, SUGGEST_PERCENTILE) : null;

    const byArticle = new Map<number, SuggestedLink[]>();
    for (const [id, list] of neighbours) {
      const sorted = list.sort((x, y) => y.score - x.score);
      const best = sorted[0]?.score ?? 0;
      const keep = sorted
        .filter((s) => (threshold === null || s.score >= threshold) && s.score >= best * RELATIVE_CUTOFF)
        .slice(0, SUGGEST_LIMIT);
      if (keep.length) byArticle.set(id, keep);
    }

    return { enabled: true, indexed: vectors.size, reason: null, threshold, byArticle };
  }

  /** Die Vorschläge zu EINEM Artikel – für den Abschnitt unter dem Text. */
  async suggestFor(articleId: number): Promise<any> {
    const { enabled, indexed, reason, threshold, byArticle } = await this.compute();
    return { enabled, indexed, reason, threshold, items: byArticle.get(articleId) || [] };
  }

  /**
   * Die Vorschläge zu ALLEN Artikeln – für das Beziehungsnetz.
   *
   * Der Graph zeichnet nur die der verwaisten Artikel, entscheidet das aber selbst: wer verwaist
   * ist, weiß er aus `GET /api/relations`, und hier danach zu filtern hieße, dieselbe Zählung an
   * zwei Stellen zu führen. Bei `SUGGEST_LIMIT` je Artikel bleibt die Antwort klein genug, dass
   * das nichts kostet.
   */
  async suggestAll(): Promise<any> {
    const { enabled, indexed, reason, threshold, byArticle } = await this.compute();
    return {
      enabled,
      indexed,
      reason,
      threshold,
      articles: [...byArticle].map(([id, items]) => ({ id, items })),
    };
  }
}

/** Ungeordneter Schlüssel eines Artikelpaars – `A|B` und `B|A` sind dasselbe Paar. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Perzentil einer unsortierten Zahlenreihe (nächster Rang, ohne Interpolation). */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
