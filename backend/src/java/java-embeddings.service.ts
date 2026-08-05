import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';
import { safeJson } from '../common/json.util';
import { JavaBatchProgressService } from './java-batch-progress.service';

// Wie viele Klassen in EINER Ollama-Anfrage eingebettet werden. Ein Stapel spart den Roundtrip,
// aber ein zu grosser laesst den Server bei einem Fehler von vorn anfangen – und auf einem Pi
// kostet er spuerbar Speicher.
const EMBED_BATCH = 16;

// Obergrenze des eingebetteten Textes je Klasse. Embedding-Modelle haben ein festes Fenster
// (nomic-embed-text: 8192 Token, empfohlen deutlich darunter); was darueber steht, wird
// abgeschnitten – also wird lieber HIER gekuerzt, und zwar an den Stellen, die am wenigsten
// aussagen (Methodenliste zuletzt).
const MAX_TEXT = 2000;

// Wie viele Treffer die Suche hoechstens zurueckgibt. Eine Bedeutungssuche hat kein „passt nicht":
// jeder Vektor hat einen Abstand, also ist JEDE Klasse ein Treffer. Ohne Deckel und Schwelle waere
// die Antwort die sortierte Codebasis.
const SEARCH_LIMIT = 8;
// ⚠️ Der Schnitt ist RELATIV zum besten Treffer, nicht absolut. Eine feste Schwelle wäre eine Zahl
// über ein Modell, das der Betreiber jederzeit wechseln kann: derselbe Abstand bedeutet bei
// nomic-embed-text etwas anderes als bei mxbai oder bge, und eine zu hohe Schwelle liefert dann
// stillschweigend nichts, während eine zu niedrige die halbe Codebasis nach Rang sortiert.
// „Deutlich schlechter als der beste" ist dagegen in jedem Vektorraum dieselbe Aussage.
const RELATIVE_CUTOFF = 0.75;
// Absolute Untergrenze nur als Notbremse: darunter hat das Modell nichts verstanden, und der beste
// Treffer wäre eine geratene Auskunft mit Rangfolge.
const FLOOR_SCORE = 0.15;

// ⚠️ nomic-embed-text ist auf PRAEFIXE trainiert: derselbe Text ergibt als `search_document:` und
// als `search_query:` verschiedene Vektoren, und ohne die Praefixe verliert das Modell messbar an
// Trennschaerfe. Das ist modellspezifisch und deshalb an den Modellnamen gebunden – ein anderes
// Modell bekommt seinen Text unveraendert.
const usesNomicPrefix = (model: string) => /^nomic-embed/i.test(model || '');

type Row = {
  id: number;
  package: string | null;
  class_name: string;
  class_type: string | null;
  stereotype: string | null;
  extends_name: string | null;
  description: string | null;
};

/**
 * Bedeutungssuche über die analysierten Klassen.
 *
 * Der Volltext-Index beantwortet „wo steht dieses Wort?". Diese Suche beantwortet „welche Klasse
 * kümmert sich um X?" – und findet damit die Klasse, in der das gesuchte Wort gerade NICHT steht.
 * Beides nebeneinander, nicht ineinander: ein semantischer Treffer ohne das gesuchte Wort im Text
 * sieht in einer Volltextliste wie ein Fehler aus (s. `SearchPalette`).
 *
 * Drei Festlegungen:
 *
 * 1. **Ein Vektor je Klasse.** Die Klasse ist überall sonst die Einheit (Karte, Artikel, Kante),
 *    und „welche Methode kümmert sich um X" ist keine Frage, die jemand stellt.
 * 2. **Vektoren werden beim Speichern normalisiert.** Danach ist die Kosinus-Ähnlichkeit das
 *    Skalarprodukt – eine Multiplikation je Dimension statt drei plus zwei Wurzeln, und bei 1500
 *    Klassen × 768 Dimensionen je Tastendruck ist genau das der Unterschied.
 * 3. **Der Vergleich läuft im Speicher, nicht in SQLite.** 1500 Vektoren sind 4,6 MB; sie je
 *    Anfrage aus der Datenbank zu lesen wäre teurer als der Vergleich selbst. Eine
 *    Vektor-Erweiterung (sqlite-vec) bräuchte es erst um eine Größenordnung später.
 */
@Injectable()
export class JavaEmbeddingsService {
  private readonly logger = new Logger(JavaEmbeddingsService.name);
  // fileId -> normalisierter Vektor. Geladen beim ersten Bedarf, verworfen nach jedem Lauf.
  private cache: Map<number, Float32Array> | null = null;
  private building = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly ollama: OllamaService,
    private readonly settings: SettingsService,
    private readonly progress: JavaBatchProgressService,
  ) {}

  // --- Was eingebettet wird --------------------------------------------------------------------
  //
  // Der Quelltext selbst steht bewusst NICHT drin: er besteht zur Hälfte aus Syntax, die in jeder
  // Klasse gleich ist, und genau diese Gleichheit zieht alle Vektoren zusammen. Was eine Klasse
  // AUSMACHT, steht in ihrem Namen, ihrem Package, ihrer Beschreibung und ihren Methodennamen.
  private textFor(row: Row, members: string[], javadoc: string): string {
    const kind = row.stereotype || row.class_type || 'class';
    const parts = [
      `${row.class_name} — ${kind}${row.package ? ` in ${row.package}` : ''}`,
      row.extends_name ? `extends ${row.extends_name}` : '',
      (row.description || '').trim(),
      javadoc.trim(),
      members.length ? `Members: ${members.join(', ')}` : '',
    ].filter(Boolean);
    return parts.join('\n').slice(0, MAX_TEXT);
  }

  private async collect(): Promise<Array<{ row: Row; text: string; hash: string }>> {
    const rows: Row[] = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, extends_name, description
         FROM java_files ORDER BY id`,
    );
    if (!rows.length) return [];

    const members = new Map<number, string[]>();
    const docs = new Map<number, string[]>();
    for (const m of await this.ds.query(
      `SELECT file_id, method_name, parameters, javadoc, ai_summary FROM java_methods ORDER BY id`,
    )) {
      const id = Number(m.file_id);
      const params = safeJson<Array<{ name?: string; type?: string }>>(m.parameters, []) || [];
      const list = members.get(id) || [];
      list.push(`${m.method_name}(${params.map((p) => p.type || '').filter(Boolean).join(', ')})`);
      members.set(id, list);
      // Die KI-Zusammenfassung sagt mehr als der Javadoc, wenn es beide gibt – und wenn nicht,
      // steht in `ai_summary` ohnehin der Javadoc (s. analyze).
      const text = (m.ai_summary || m.javadoc || '').trim();
      if (text) {
        const d = docs.get(id) || [];
        d.push(text);
        docs.set(id, d);
      }
    }

    return rows.map((row) => {
      const text = this.textFor(row, members.get(row.id) || [], (docs.get(row.id) || []).join(' ').slice(0, 600));
      return { row, text, hash: createHash('sha1').update(text).digest('hex') };
    });
  }

  // --- Stand des Index -------------------------------------------------------------------------

  async status(): Promise<any> {
    const cfg = await this.settings.bot();
    const model = cfg.embedModel || '';
    const items = await this.collect();
    const stored = new Map<number, { model: string; source_hash: string }>();
    for (const r of await this.ds.query(`SELECT file_id, model, source_hash FROM java_embeddings`)) {
      stored.set(Number(r.file_id), { model: r.model, source_hash: r.source_hash });
    }

    let indexed = 0;
    let stale = 0;
    for (const it of items) {
      const s = stored.get(it.row.id);
      if (!s) continue;
      // Ein Modellwechsel macht JEDEN Vektor ungueltig – Vektoren verschiedener Modelle liegen in
      // verschiedenen Raeumen, ihr Abstand bedeutet nichts.
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
      // „Bereit" heisst: es gibt etwas zu durchsuchen. Ein halb gefuellter Index ist nutzbar – er
      // findet eben nur, was schon drin ist, und die Oberflaeche schreibt es an.
      ready: !!model && indexed > 0,
    };
  }

  // --- Aufbauen --------------------------------------------------------------------------------

  /**
   * Fehlende und veraltete Vektoren nachziehen.
   *
   * Inkrementell, weil der Lauf teuer ist: eine Klasse, deren Text sich nicht geändert hat, hat
   * denselben Vektor. `force` ist der Weg für einen Modellwechsel, bei dem die Hashes zwar passen,
   * die Vektoren aber trotzdem nicht mehr vergleichbar sind.
   */
  async rebuild(jobId: string | null, force = false): Promise<any> {
    if (this.building) return { started: false, reason: 'A build is already running' };
    const cfg = await this.settings.bot();
    const model = cfg.embedModel || '';
    if (!model) return { started: false, reason: 'No embedding model configured' };

    this.building = true;
    try {
      const items = await this.collect();
      const stored = new Map<number, { model: string; source_hash: string }>();
      for (const r of await this.ds.query(`SELECT file_id, model, source_hash FROM java_embeddings`)) {
        stored.set(Number(r.file_id), { model: r.model, source_hash: r.source_hash });
      }
      const todo = items.filter((it) => {
        if (force) return true;
        const s = stored.get(it.row.id);
        return !s || s.model !== model || s.source_hash !== it.hash;
      });

      this.progress.emit(jobId, { phase: 'embed', done: 0, total: todo.length });
      let done = 0;
      let failed = 0;
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const slice = todo.slice(i, i + EMBED_BATCH);
        const texts = slice.map((it) => (usesNomicPrefix(model) ? `search_document: ${it.text}` : it.text));
        const vectors = await this.ollama.embed(texts);
        if (vectors.length !== slice.length) {
          // Ollama weg oder Modell nicht gepullt: abbrechen statt weiter ins Leere zu fragen. Was
          // bereits geschrieben ist, bleibt gueltig – der naechste Lauf macht dort weiter.
          failed = todo.length - done;
          break;
        }
        for (let k = 0; k < slice.length; k++) {
          const vec = normalize(vectors[k]);
          await this.ds.query(
            `INSERT INTO java_embeddings (file_id, model, dim, source_hash, vector, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(file_id) DO UPDATE SET
               model = excluded.model, dim = excluded.dim,
               source_hash = excluded.source_hash, vector = excluded.vector,
               created_at = excluded.created_at`,
            [slice[k].row.id, model, vec.length, slice[k].hash, Buffer.from(vec.buffer)],
          );
        }
        done += slice.length;
        this.progress.emit(jobId, { phase: 'embed', done, total: todo.length });
      }

      // Alles, was zu einem anderen Modell gehoert, ist toter Ballast – und ein Treffer daraus
      // waere eine Falschauskunft.
      await this.ds.query(`DELETE FROM java_embeddings WHERE model <> ?`, [model]);
      this.cache = null;
      this.progress.emit(jobId, { phase: 'done', done, total: todo.length });
      return { started: true, indexed: done, skipped: items.length - todo.length, failed, model };
    } finally {
      this.building = false;
    }
  }

  /** Alles verwerfen (Modellwechsel von Hand, Komplett-Reset). */
  async clear(): Promise<void> {
    await this.ds.query(`DELETE FROM java_embeddings`);
    this.cache = null;
  }

  // --- Suchen ----------------------------------------------------------------------------------

  private async vectors(): Promise<Map<number, Float32Array>> {
    if (this.cache) return this.cache;
    const map = new Map<number, Float32Array>();
    for (const r of await this.ds.query(`SELECT file_id, vector FROM java_embeddings`)) {
      const buf: Buffer = r.vector;
      map.set(Number(r.file_id), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
    this.cache = map;
    return map;
  }

  async search(q: string, limit = SEARCH_LIMIT): Promise<any> {
    const query = (q || '').trim();
    if (!query) return { results: [], ready: false, reason: 'empty' };
    const cfg = await this.settings.bot();
    const model = cfg.embedModel || '';
    if (!model) return { results: [], ready: false, reason: 'disabled' };

    const map = await this.vectors();
    if (!map.size) return { results: [], ready: false, reason: 'not-indexed' };

    const [queryVec] = await this.ollama.embed([usesNomicPrefix(model) ? `search_query: ${query}` : query]);
    // Ollama nicht erreichbar ist kein Fehler, sondern eine leere Antwort mit Grund – die Palette
    // zeigt dann ihre beiden anderen Quellen und schreibt an, dass diese fehlt.
    if (!queryVec) return { results: [], ready: false, reason: 'unavailable' };
    const qv = normalize(queryVec);

    const scored: Array<{ id: number; score: number }> = [];
    for (const [id, vec] of map) {
      if (vec.length !== qv.length) continue; // Modellwechsel mitten im Bestand
      let dot = 0;
      for (let i = 0; i < qv.length; i++) dot += qv[i] * vec[i];
      if (dot >= FLOOR_SCORE) scored.push({ id, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    const top = scored
      .filter((s) => s.score >= best * RELATIVE_CUTOFF)
      .slice(0, Math.max(1, Math.min(limit, SEARCH_LIMIT)));
    if (!top.length) return { results: [], ready: true, reason: 'no-match' };

    // Namen erst jetzt nachschlagen – und ueber den JOIN fallen geloeschte Klassen heraus, ohne
    // dass der Vektor-Cache davon wissen muss.
    const rows = await this.ds.query(
      `SELECT id, package, class_name, class_type, stereotype, description IS NOT NULL AS analyzed
         FROM java_files WHERE id IN (${top.map((t) => t.id).join(',')})`,
    );
    const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
    return {
      ready: true,
      results: top
        .filter((t) => byId.has(t.id))
        .map((t) => {
          const r = byId.get(t.id);
          return {
            fileId: t.id,
            className: r.class_name,
            package: r.package || '',
            type: r.stereotype || r.class_type || 'class',
            analyzed: !!r.analyzed,
            score: Math.round(t.score * 100) / 100,
          };
        }),
    };
  }
}

/**
 * Vektor auf Länge 1 bringen – danach ist das Skalarprodukt bereits die Kosinus-Ähnlichkeit.
 *
 * Ein Nullvektor (Modell hat nichts geliefert) bleibt einer: durch 0 zu teilen ergäbe NaN, und ein
 * NaN im Index vergiftet jeden späteren Vergleich lautlos.
 */
function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let sum = 0;
  for (const v of vec) sum += v * v;
  const len = Math.sqrt(sum);
  if (!len) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / len;
  return out;
}
