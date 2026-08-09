import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ArticleEmbeddingsService } from './article-embeddings.service';

/**
 * Was man dem Wiki nicht ansieht – das Gegenstück zu `/insights`, nur über den anderen Bestand.
 *
 * Warum es das gibt: die Code-Seite bekommt seit langem den analytischen Blick (Zyklen, Brandherde,
 * Schichten, Außenrand), das Wiki hatte genau EINEN Befund, und der stand im Beziehungsnetz („auf
 * diesen Artikel zeigt nichts"). Alles andere, was an einem gewachsenen Wiki schiefgeht, ist von
 * innen unsichtbar: ein Link zeigt ins Leere, weil ein Slug sich geändert hat; ein exportierter
 * Klassenartikel beschreibt eine Klasse, die es so nicht mehr gibt; zwei Notizen sagen dasselbe.
 * Nichts davon findet man beim Durchblättern – man findet es, wenn man sich auf den Artikel verlässt.
 *
 * Vier Befunde, und die Auswahl ist keine Sammlung, sondern eine Regel: **jeder muss aus dem
 * bestehen, was ohnehin gespeichert ist, und jeder muss eine Handlung nennen.** Deshalb kostet der
 * ganze Bericht keinen einzigen Ollama-Aufruf – auch die Duplikate nicht, die aus demselben
 * Artikel-Bedeutungsindex kommen, der die Link-Vorschläge trägt.
 *
 * Fünf Festlegungen:
 *
 * 1. ⚠️ **Verwaiste Artikel stehen NICHT hier.** Es ist der bekannteste Wiki-Befund und der einzige,
 *    der bewusst fehlt: das Beziehungsnetz zählt ihn bereits, samt Handlung (Link-Vorschläge als
 *    Kanten). Ihn hier ein zweites Mal zu zählen hieße, zwei Wege zu derselben Zahl zu haben – und
 *    zwei Wege zu einer Zahl sind über kurz oder lang zwei Zahlen. Die Ansicht sagt stattdessen in
 *    einer Zeile, wo er steht.
 * 2. **Kein Cache**, gleiche Begründung wie bei `/insights`: der Lauf liest vier kleine Tabellen und
 *    rechnet in Millisekunden. Ein Cache wäre eine zweite Wahrheit mit eigener Invalidierung an
 *    jedem Schreibpfad – und Schreibpfade hat ein Wiki an jeder Ecke.
 * 3. ⚠️ **Der Bestand entscheidet, was eine Lücke ist** (`usedFields`). „Kein Tag" ist nur dort ein
 *    Befund, wo Tags überhaupt vergeben werden; in einem Wiki ohne Tags wäre es ein Daueralarm über
 *    eine bewusste Entscheidung – dasselbe Argument, mit dem die Änderungshäufigkeit aus dem
 *    Hotspot-Score fällt, wenn es nirgends einen zweiten Stand gibt.
 * 4. **Deckel werden angeschrieben.** Jede Gruppe liefert `total` neben ihren Einträgen: ein stiller
 *    Deckel liest sich wie „mehr gibt es nicht".
 * 5. ⚠️ **Die Grenze jeder Auskunft steht in der Antwort, nicht nur im Kopf des Autors** – siehe die
 *    Kommentare an `outdated` und `brokenLinks`. Beide Befunde beruhen auf einer Vermutung, die
 *    meistens stimmt, und ein Bericht, der das verschweigt, wird beim ersten Fehlalarm ganz verworfen.
 */

// Deckel je Gruppe. Verschieden groß, weil die Handlung verschieden teuer ist: einen toten Link
// repariert man in zehn Sekunden, zwei Artikel zusammenzulegen ist Textarbeit.
const OUTDATED_SAMPLE = 20;
const BROKEN_SAMPLE = 20;
const INCOMPLETE_SAMPLE = 24;

// Wie viele Änderungsnotizen je veraltetem Artikel danebenstehen. Drei, weil sie die Frage „muss ich
// da ran?" beantworten sollen und nicht „was ist alles passiert?" – der Rest wird gezählt.
const CHANGE_NOTES = 3;

// Ab wann ein Artikel als angefangen und nicht als geschrieben gilt. Gezählt wird der FLIESSTEXT
// (ohne Code, s. `plainText`), und die Zahl ist bewusst niedrig: eine Notiz aus drei Sätzen ist eine
// vollständige Notiz. Erst darunter ist der Titel länger als der Inhalt.
const STUB_WORDS = 25;

// ⚠️ Ab welchem Anteil ein Feld als „wird in diesem Wiki geführt" gilt. Die Mehrheit, nicht ein
// gegriffener Prozentsatz: darunter ist das Feld die Ausnahme und sein Fehlen der Normalfall.
const FIELD_MAJORITY = 0.5;

type ArticleRow = {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  content: string;
  category_id: number | null;
  updated_at: string;
};

@Injectable()
export class ArticleHealthService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly embeddings: ArticleEmbeddingsService,
  ) {}

  async report(): Promise<any> {
    const articles: ArticleRow[] = await this.ds.query(
      `SELECT id, slug, title, summary, content, category_id, updated_at
         FROM articles ORDER BY title COLLATE NOCASE`,
    );

    const tagged = new Set<number>();
    for (const r of await this.ds.query(`SELECT DISTINCT article_id FROM article_tags`)) {
      tagged.add(Number(r.article_id));
    }
    // Klassenartikel sind an zwei Stellen eine Ausnahme (Stub-Prüfung, Chip in der Liste), also
    // einmal einsammeln. `DISTINCT`, weil zwei Klassen auf denselben Artikel zeigen können.
    const classArticles = new Set<number>();
    for (const r of await this.ds.query(
      `SELECT DISTINCT article_id FROM java_files WHERE article_id IS NOT NULL`,
    )) {
      classArticles.add(Number(r.article_id));
    }

    const fields = this.usedFields(articles, tagged);
    const outdated = await this.outdated();
    const broken = this.brokenLinks(articles);
    const incomplete = this.incomplete(articles, tagged, classArticles, fields);
    const duplicates = await this.embeddings.duplicatePairs();

    return {
      totals: {
        articles: articles.length,
        // ⚠️ Gezählt werden die BEFUNDE, nicht die gezeigten Zeilen – sonst sänke die Zahl, sobald
        // ein Deckel greift, und ein Bericht, der bei mehr Problemen weniger meldet, ist kaputt.
        findings: outdated.total + broken.total + duplicates.total + incomplete.total,
        outdated: outdated.total,
        broken: broken.total,
        duplicates: duplicates.total,
        incomplete: incomplete.total,
      },
      fields,
      outdated,
      broken,
      duplicates,
      incomplete,
    };
  }

  // --- Welche Felder dieses Wiki überhaupt führt -------------------------------------------------

  /**
   * Was die Mehrheit der Artikel hat, gilt als Standard dieses Wikis – und nur dessen Fehlen ist
   * eine Lücke.
   *
   * Die Regel löst zwei gegenläufige Fälle mit einem Satz: In einem Wiki ohne Kategorien meldet der
   * Bericht keine einzige fehlende Kategorie (es ist keine Lücke, sondern die Arbeitsweise). In
   * einem Wiki, das durchgehend kategorisiert, sind die unkategorisiert eingetroffenen
   * Klassenartikel genau der Befund, den man sehen will.
   */
  private usedFields(articles: ArticleRow[], tagged: Set<number>) {
    const n = articles.length;
    if (!n) return { summary: false, tags: false, category: false };
    const share = (count: number) => count / n > FIELD_MAJORITY;
    return {
      summary: share(articles.filter((a) => (a.summary || '').trim()).length),
      tags: share(articles.filter((a) => tagged.has(a.id)).length),
      category: share(articles.filter((a) => a.category_id != null).length),
    };
  }

  // --- Veraltete Klassenartikel -----------------------------------------------------------------

  /**
   * Ein exportierter Klassenartikel, dessen Klasse seither neu hochgeladen wurde.
   *
   * Der einzige Befund des Berichts, den niemand sonst finden kann: der Artikel sieht aus wie immer,
   * seine Aussage ist nur nicht mehr wahr. Alles dafür liegt bereits in der Datenbank – die
   * Verknüpfung (`java_files.article_id`), der Zeitpunkt (`java_file_versions.created_at`) und sogar
   * die Antwort auf „was hat sich geändert?" (`ai_summary`, beim Re-Import ohnehin erzeugt).
   *
   * ⚠️ **„Veraltet" ist ABGELEITET, nicht gemerkt** – dieselbe Bauart wie `source_hash` beim
   * Bedeutungsindex: es gibt keine Spalte `is_stale`, die ein Schreibpfad zu setzen vergessen könnte.
   *
   * ⚠️ **Die Grenze der Auskunft** und der Grund, warum sie in der Ansicht steht: gemessen wird der
   * Artikel-Zeitstempel gegen den Versions-Zeitstempel. Wer nach dem Re-Import einen Tippfehler im
   * Artikel korrigiert, gilt damit als aktuell, ohne eine Zeile über die Änderung geschrieben zu
   * haben. Der Bericht kann nicht wissen, was in einem Text steht – nur, dass er älter ist als das,
   * was er beschreibt. Falsch-negativ ist dabei die richtige Richtung: ein übersehener Befund kostet
   * weniger als ein Alarm, der sich nicht abstellen lässt.
   */
  private async outdated(): Promise<{ items: any[]; total: number }> {
    // EINE Abfrage statt einer je Artikel: der Join über den Zeitstempel ist genau die Bedingung.
    // Beide Spalten kommen aus `datetime('now')`, stehen also im selben Format (UTC ohne Suffix) –
    // ihr Textvergleich IST der Zeitvergleich.
    const rows = await this.ds.query(
      `SELECT jf.id AS file_id, jf.class_name, jf.package,
              a.id AS article_id, a.slug, a.title, a.updated_at,
              v.version_number, v.created_at AS version_at, v.ai_summary_html
         FROM java_files jf
         JOIN articles a ON a.id = jf.article_id
         JOIN java_file_versions v
           ON v.java_file_id = jf.id AND v.created_at > a.updated_at
        ORDER BY v.version_number DESC`,
    );

    const byArticle = new Map<number, any>();
    for (const r of rows) {
      const key = Number(r.article_id);
      let entry = byArticle.get(key);
      if (!entry) {
        entry = {
          id: key,
          slug: r.slug,
          title: r.title,
          updated_at: r.updated_at,
          class: {
            fileId: Number(r.file_id),
            name: r.class_name,
            package: r.package || null,
          },
          behind: 0,
          latestAt: r.version_at,
          notes: [] as any[],
          notesTotal: 0,
        };
        byArticle.set(key, entry);
      }
      entry.behind++;
      entry.notesTotal++;
      if (entry.notes.length < CHANGE_NOTES) {
        entry.notes.push({
          version: Number(r.version_number),
          at: r.version_at,
          // Das server-gerenderte HTML, nicht das Markdown darunter – gleiche Regel wie überall im
          // Projekt, und dieselbe Spalte, die der History-Tab der Klasse anzeigt.
          //
          // NULL heißt „kein Ollama zur Zeit des Imports", nicht „nichts geändert": die Ansicht
          // sagt das ausdrücklich, statt eine leere Zeile zu zeigen, die sich wie „keine Änderung"
          // liest – der Befund selbst steht ja gerade dafür, dass es eine gab.
          summaryHtml: r.ai_summary_html || null,
        });
      }
    }

    // Am weitesten zurückliegend zuerst: wie viele Stände der Artikel verpasst hat, ist das Maß
    // dafür, wie weit er danebenliegt. Bei Gleichstand die frischeste Änderung.
    const items = [...byArticle.values()].sort(
      (a, b) => b.behind - a.behind || String(b.latestAt).localeCompare(String(a.latestAt)),
    );
    return { items: items.slice(0, OUTDATED_SAMPLE), total: items.length };
  }

  // --- Tote interne Links -----------------------------------------------------------------------

  /**
   * Markdown-Links auf `/article/<slug>`, hinter denen kein Artikel mehr steht.
   *
   * Der Befund entsteht aus einer Lücke im Datenmodell, und die ist Absicht: `relations` hängen an
   * einer Fremdschlüssel-CASCADE und bleiben beim Löschen sauber, ein Link IM TEXT ist dagegen nur
   * eine Zeichenkette. Er überlebt jedes Umbenennen eines Slugs und jedes Löschen – lautlos, denn
   * das Ziel prüft niemand, bis jemand darauf klickt.
   *
   * ⚠️ **Code-Blöcke fliegen zuerst raus.** Ein Artikel, der Markdown-Syntax erklärt, enthält
   * Linkbeispiele, und ein Beispiel ist kein Link – ohne diesen Schritt meldet ausgerechnet die
   * Doku über das Wiki die meisten toten Links. Gleiche Reihenfolge und gleiche Begründung wie in
   * `plainText` beim Einbetten.
   *
   * ⚠️ **Die Grenze der Auskunft:** geprüft wird genau die Form, die diese Anwendung erzeugt und
   * versteht. Ein externer Link kann ebenso tot sein – aber ihn zu prüfen hieße, ins Netz zu gehen,
   * und das tut Wikit nirgends.
   */
  private brokenLinks(articles: ArticleRow[]): { items: any[]; total: number } {
    const slugs = new Set(articles.map((a) => a.slug));
    const items: any[] = [];

    for (const a of articles) {
      const text = (a.content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/`[^`]*`/g, ' ');

      const seen = new Set<string>();
      const links: any[] = [];
      for (const m of text.matchAll(/\[([^\]]*)\]\(\s*(\/article\/[^)\s]+)\s*\)/g)) {
        const target = this.slugOf(m[2]);
        // Ein Link ohne Slug (`/article/`) zeigt nirgendwohin und ist ebenso kaputt; er bekommt
        // seine Zeile über den rohen Pfad, sonst stünde dort ein leerer Eintrag.
        if (target && slugs.has(target)) continue;
        const key = `${target}|${m[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ label: (m[1] || '').trim(), slug: target, href: m[2] });
      }
      if (links.length) items.push({ id: a.id, slug: a.slug, title: a.title, links });
    }

    return { items: items.slice(0, BROKEN_SAMPLE), total: items.length };
  }

  /** Slug aus `/article/<slug>` – ohne Anker und Query, prozentdekodiert wenn möglich. */
  private slugOf(href: string): string {
    const raw = href.slice('/article/'.length).split(/[#?]/)[0];
    try {
      return decodeURIComponent(raw);
    } catch {
      // Ein kaputtes Prozentzeichen ist selbst schon der Grund, warum der Link nicht ankommt.
      return raw;
    }
  }

  // --- Angefangen statt geschrieben --------------------------------------------------------------

  /**
   * Artikel, denen etwas fehlt, das dieses Wiki sonst führt – oder die kaum Text haben.
   *
   * ⚠️ **Klassenartikel sind von der Stub-Prüfung ausgenommen.** Ihr Inhalt IST der Code, und der
   * zählt beim Fließtext nicht mit (gleiche Regel wie beim Einbetten, gleicher Grund). Ohne die
   * Ausnahme stünde nach dem ersten Export die halbe Codebasis als „angefangen" im Bericht – und
   * ein Befund, der für hundert Zeilen gleichzeitig gilt, ist keiner. Die Felder prüft er bei ihnen
   * weiter mit: eine Zusammenfassung ist bei einem Klassenartikel so nützlich wie bei jedem anderen.
   */
  private incomplete(
    articles: ArticleRow[],
    tagged: Set<number>,
    classArticles: Set<number>,
    fields: { summary: boolean; tags: boolean; category: boolean },
  ): { items: any[]; total: number } {
    const items: any[] = [];

    for (const a of articles) {
      const isClass = classArticles.has(a.id);
      const words = isClass ? null : this.wordCount(a.content);
      const missing: string[] = [];
      if (fields.summary && !(a.summary || '').trim()) missing.push('summary');
      if (fields.tags && !tagged.has(a.id)) missing.push('tags');
      if (fields.category && a.category_id == null) missing.push('category');
      const stub = words !== null && words < STUB_WORDS;
      if (!missing.length && !stub) continue;
      items.push({ id: a.id, slug: a.slug, title: a.title, is_class: isClass, words, stub, missing });
    }

    // Wer am meisten vermissen lässt, steht oben; ein Stub wiegt dabei wie ein fehlendes Feld.
    items.sort((x, y) => y.missing.length + (y.stub ? 1 : 0) - (x.missing.length + (x.stub ? 1 : 0)));
    return { items: items.slice(0, INCOMPLETE_SAMPLE), total: items.length };
  }

  /** Wörter im Fließtext – dieselbe Aufbereitung, die auch eingebettet wird. */
  private wordCount(content: string): number {
    const text = this.embeddings.plainText(content || '');
    return text ? text.split(/\s+/).length : 0;
  }
}
