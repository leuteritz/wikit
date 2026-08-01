import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TRIGRAM_MIN_CHARS } from './schema';

// Wie viele Quelltexte der Nachbau am Stueck indiziert, bevor er den Event-Loop freigibt.
// Dieselbe Regel wie in analyzeBatch/recomputeAutoEdges: eine lange synchrone Schleife blockiert
// den ganzen Server, und dieser Lauf startet ausgerechnet dann, wenn jemand die Seite oeffnet.
const BACKFILL_CHUNK = 200;

// ──────────────────────────────────────────────────────────────────────────────
// FTS5-AUSNAHME: TypeORM unterstuetzt FTS5 nicht nativ. Volltext-Indexpflege und
// -Suche laufen daher bewusst ueber Raw-SQL via EntityManager.query() / DataSource.query().
// Das ist die einzige Stelle (neben dem Schema-DDL), an der wir Plain-SQL verwenden.
// 1:1 portiert aus indexArticle()/buildMatch() des alten backend/db.js + routes/search.js.
// ──────────────────────────────────────────────────────────────────────────────
@Injectable()
export class FtsService {
  private readonly logger = new Logger(FtsService.name);

  // Zustand des Trigram-Quelltextindex (s. JAVA_SRC_FTS_DDL). `available` = die Tabelle existiert
  // (aeltere SQLite kann sie nicht anlegen), `ready` = sie deckt JEDE gespeicherte Klasse ab.
  // Nur wenn beides gilt, darf `codeSearch` dem Index glauben, dass „keine Kandidaten" auch
  // „keine Treffer" heisst – waehrend des Nachbaus waere das eine Falschauskunft.
  private srcIndexAvailable = false;
  private srcIndexReady = false;
  private backfillRunning = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // --- Trigram-Quelltextindex --------------------------------------------------------------

  sourceIndexUsable(): boolean {
    return this.srcIndexAvailable && this.srcIndexReady;
  }

  sourceIndexState(): { available: boolean; ready: boolean; building: boolean } {
    return { available: this.srcIndexAvailable, ready: this.srcIndexReady, building: this.backfillRunning };
  }

  setSourceIndexAvailable(available: boolean): void {
    this.srcIndexAvailable = available;
  }

  // Fehlt dem Index eine gespeicherte Klasse, wird sie nachgetragen – in Haeppchen, damit der
  // Server waehrenddessen antwortet. Laeuft im Hintergrund beim Start (DatabaseService) und ist
  // idempotent: der Abgleich fragt, welche java_files.id im Index FEHLEN, nicht wie viele es sind.
  // Kein persistiertes „fertig"-Flag: eine Zahl in `settings` waere eine zweite Wahrheit, die nach
  // einem Absturz mitten im Lauf luegen wuerde.
  async backfillSourceIndex(): Promise<void> {
    if (!this.srcIndexAvailable || this.backfillRunning) return;
    this.backfillRunning = true;
    const started = Date.now();
    let done = 0;
    try {
      for (;;) {
        const rows: Array<{ id: number }> = await this.dataSource.query(
          `SELECT id FROM java_files
           WHERE id NOT IN (SELECT rowid FROM java_src_fts)
           ORDER BY id LIMIT ?`,
          [BACKFILL_CHUNK],
        );
        if (!rows.length) break;
        await this.dataSource.transaction(async (manager) => {
          for (const { id } of rows) await this.indexJavaSource(manager, id);
        });
        done += rows.length;
        // Event-Loop freigeben (s. BACKFILL_CHUNK).
        await new Promise((r) => setImmediate(r));
      }
      this.srcIndexReady = true;
      if (done) this.logger.log(`Code-Suchindex ergaenzt: ${done} Klassen in ${Date.now() - started} ms`);
    } catch (e: any) {
      // Ein gescheiterter Nachbau darf den Server nicht mitnehmen: die Suche laeuft dann weiter
      // ueber den alten Weg (Praefix-Index + Vollscan), nur eben langsam.
      this.srcIndexReady = false;
      this.logger.error(`Code-Suchindex konnte nicht ergaenzt werden: ${e?.message || e}`);
    } finally {
      this.backfillRunning = false;
    }
  }

  // Eintrag einer Klasse im Trigram-Index erneuern. DELETE + INSERT wie bei java_fts – moeglich,
  // weil die Tabelle mit `contentless_delete=1` angelegt ist.
  async indexJavaSource(manager: EntityManager, fileId: number, source?: string): Promise<void> {
    if (!this.srcIndexAvailable) return;
    let text = source;
    if (text == null) {
      const rows = await manager.query('SELECT raw_source FROM java_files WHERE id = ?', [fileId]);
      text = rows[0]?.raw_source ?? null;
    }
    await manager.query('DELETE FROM java_src_fts WHERE rowid = ?', [fileId]);
    if (text == null) return;
    await manager.query('INSERT INTO java_src_fts (rowid, source) VALUES (?,?)', [fileId, text]);
  }

  // Beim Loeschen von Klassen: der Index haelt keine Fremdschluessel, also muss die Zeile hier weg.
  // Bleibt sie stehen, nennt der Index eine Datei, die es nicht mehr gibt – der Scan findet sie
  // nicht und die Suche verliert stillschweigend ihren Deckel an eine Leiche.
  async removeJavaSources(manager: EntityManager, fileIds: number[]): Promise<void> {
    if (!this.srcIndexAvailable || !fileIds.length) return;
    const marks = fileIds.map(() => '?').join(',');
    await manager.query(`DELETE FROM java_src_fts WHERE rowid IN (${marks})`, fileIds);
  }

  // Kandidaten fuer die zeilengenaue Code-Suche aus dem Trigram-Index: BELIEBIGE Teilstrings,
  // Interpunktion inbegriffen, Gross-/Kleinschreibung egal (der exakte Scan sortiert danach aus,
  // was die Optionen des Nutzers ausschliessen). Anders als beim Praefix-Index ist ein leeres
  // Ergebnis hier eine ECHTE Aussage: was der Trigram-Index nicht kennt, steht in keiner Klasse.
  async candidateJavaFileIdsBySource(q: string, limit = 300): Promise<number[]> {
    const term = (q || '').trim();
    if (!this.srcIndexAvailable || term.length < TRIGRAM_MIN_CHARS) return [];
    // FTS5-Phrase: die gesamte Eingabe ist EIN Suchstring, `"` darin wird verdoppelt.
    const phrase = `"${term.replace(/"/g, '""')}"`;
    try {
      const rows = await this.dataSource.query(
        `SELECT rowid AS id FROM java_src_fts WHERE java_src_fts MATCH ? ORDER BY rowid LIMIT ?`,
        [phrase, limit],
      );
      return rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

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

  // Aktualisiert den FTS-Eintrag einer analysierten Java-Datei. Buendelt Klassenname, Package,
  // Methodensignaturen und gespeicherte KI-/Javadoc-/Body-Texte -> die Klasse wird als
  // Wissensquelle fuer kuenftige Prompt-Anreicherung (searchJava) durchsuchbar.
  async indexJavaFile(manager: EntityManager, fileId: number): Promise<void> {
    const fileRows = await manager.query(
      'SELECT id, class_name, package, description, raw_source FROM java_files WHERE id = ?',
      [fileId],
    );
    const f = fileRows[0];
    await manager.query('DELETE FROM java_fts WHERE rowid = ?', [fileId]);
    if (!f) return;
    const methodRows = await manager.query(
      `SELECT method_name, return_type, parameters, javadoc, ai_summary, member_kind
       FROM java_methods WHERE file_id = ? ORDER BY id`,
      [fileId],
    );
    const methods = methodRows
      // Konstruktoren und Initialisierer haben keinen Rueckgabetyp – ein 'void' davor waere ein
      // Term, der im Quelltext nicht steht (NULL im Altbestand = Methode).
      .map((m: any) =>
        (m.member_kind || 'method') === 'method' ? `${m.return_type || 'void'} ${m.method_name}` : m.method_name,
      )
      .join(' ');
    const descriptions = [f.description || '']
      .concat(methodRows.map((m: any) => `${m.method_name}: ${m.ai_summary || m.javadoc || ''}`))
      .filter(Boolean)
      .join('\n');
    // `source` = Rohquelltext -> globale Code-Suche nach Variablen-/Methodennamen u. beliebigen Termen.
    await manager.query(
      'INSERT INTO java_fts (rowid, class_name, package, methods, descriptions, source) VALUES (?,?,?,?,?,?)',
      [f.id, f.class_name, f.package || '', methods, descriptions, f.raw_source || ''],
    );
    // Der Trigram-Index haengt an DIESEM Aufruf, nicht an einem eigenen an jeder Schreibstelle:
    // analyze, analyze-batch, Overwrite und die KI-Summary rufen `indexJavaFile` bereits alle auf.
    // Ein zweiter Aufruf je Endpunkt waere genau die Zeile, die man beim naechsten vergisst.
    await this.indexJavaSource(manager, f.id, f.raw_source || '');
  }

  // Sucht in den gespeicherten Java-Analysen nach passendem Kontext (Prompt-Enrichment).
  // Liefert kurze Klartext-Snippets der bisher beschriebenen Klassen/Methoden.
  // `excludeRowid` (= eine java_files.id) blendet die eigene Klasse aus, damit sie sich beim
  // RAG-Kontext nicht selbst als "Wissen" zitiert.
  async searchJava(q: string, limit = 5, excludeRowid?: number): Promise<string[]> {
    const match = this.buildMatch(q);
    if (!match) return [];
    try {
      const where =
        excludeRowid != null ? 'WHERE java_fts MATCH ? AND rowid != ?' : 'WHERE java_fts MATCH ?';
      const params = excludeRowid != null ? [match, excludeRowid, limit] : [match, limit];
      const rows = await this.dataSource.query(
        `SELECT class_name,
                snippet(java_fts, 3, '', '', ' … ', 24) AS snippet
         FROM java_fts
         ${where}
         ORDER BY bm25(java_fts)
         LIMIT ?`,
        params,
      );
      return rows
        .map((r: any) => `${r.class_name}: ${(r.snippet || '').trim()}`.trim())
        .filter((s: string) => s && !s.endsWith(':'));
    } catch {
      return [];
    }
  }

  // Globale Code-Suche: durchsucht den java_fts-Index (inkl. Rohquelltext) und liefert die
  // Treffer-Java-Dateien mit Snippet-Highlight aus dem Quelltext (Spaltenindex 4 = `source`).
  async searchJavaFiles(q: string, limit = 30): Promise<any[]> {
    const match = this.buildMatch(q);
    if (!match) return [];
    try {
      return await this.dataSource.query(
        `SELECT f.id, f.filename, f.class_name, f.package, f.class_line,
                snippet(java_fts, 4, '<mark>', '</mark>', ' … ', 12) AS snippet,
                bm25(java_fts) AS rank
         FROM java_fts
         JOIN java_files f ON f.id = java_fts.rowid
         WHERE java_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [match, limit],
      );
    } catch {
      // Ungueltige FTS-Syntax -> leer.
      return [];
    }
  }

  // Kandidaten fuer die zeilengenaue Code-Suche: liefert NUR die java_files.id, nach bm25
  // sortiert. Der eigentliche Treffer entsteht danach beim exakten Zeilen-Scan (Case/ganzes
  // Wort/Regex kann FTS5 nicht) – dieser Aufruf beantwortet nur „welche Klassen ueberhaupt
  // anfassen?" und haelt den Scan damit von tausenden Quelltexten fern.
  // Bewusst ein Ueberschuss (FTS5 matcht Token-Praefixe, die Suche danach beliebige Teilstrings):
  // findet der Scan darin nichts, faellt der Aufrufer auf den Vollscan zurueck.
  async candidateJavaFileIds(q: string, limit = 300): Promise<number[]> {
    const match = this.buildMatch(q);
    if (!match) return [];
    try {
      const rows = await this.dataSource.query(
        `SELECT rowid AS id
         FROM java_fts
         WHERE java_fts MATCH ?
         ORDER BY bm25(java_fts)
         LIMIT ?`,
        [match, limit],
      );
      return rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

  // Methoden-genaue Code-Suche: matcht Methodennamen (LIKE, COLLATE NOCASE) und liefert die
  // Zeilennummer mit -> das Frontend springt direkt zur Methode (Such-Sprung + Highlight).
  // Kein FTS noetig (gezielter Namens-Treffer), bewusst SQLite-Raw analog searchJavaFiles.
  //
  // NUR echte Methoden, obwohl java_methods seit der Kanten-Korrektur jedes Mitglied mit Rumpf
  // haelt: ein Konstruktor heisst wie seine Klasse und stuende sonst als zweiter Treffer unter
  // der Klasse, die die Palette eine Zeile darueber ohnehin schon nennt – und ein Initialisierer
  // heisst nach seiner Schreibweise im Code, traefe also jede Suche nach "static". NULL im
  // Altbestand = Methode.
  async searchJavaMethods(q: string, limit = 10): Promise<any[]> {
    const term = (q || '').trim();
    if (!term) return [];
    try {
      return await this.dataSource.query(
        `SELECT m.file_id, m.method_name, m.return_type, m.parameters, m.start_line,
                f.class_name, f.package
         FROM java_methods m
         JOIN java_files f ON f.id = m.file_id
         WHERE m.method_name LIKE ? COLLATE NOCASE
           -- Nur echte Methoden (Begruendung s. Kommentar ueber der Funktion).
           AND (m.member_kind IS NULL OR m.member_kind = 'method')
         ORDER BY (m.method_name = ? COLLATE NOCASE) DESC, m.method_name COLLATE NOCASE
         LIMIT ?`,
        [`%${term}%`, term, limit],
      );
    } catch {
      return [];
    }
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
