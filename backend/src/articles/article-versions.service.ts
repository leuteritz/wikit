import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { SettingsService } from '../common/settings.service';
import { Article } from '../entities/article.entity';
import { ArticleVersion } from '../entities/article-version.entity';
import { compareTexts, lineStats, unifiedDiff } from './text-diff';

/**
 * Fassungsverlauf der Artikel -- das Gedaechtnis, das der Code-Bestand ueber
 * `java_file_versions` laengst hatte und das Wiki nicht.
 *
 * ⚠️ Der Grundsatz: die HOECHSTE Fassung ist immer der aktuelle Stand des Artikels. Nur alte
 * Staende zu sichern waere billiger gewesen, haette aber jeden Vergleich "Fassung 3 gegen heute"
 * zu einem Sonderfall gemacht -- und genau dieser Vergleich ist der haeufigste.
 *
 * Ausnahme: ein Artikel, der seit Einfuehrung dieser Tabelle nie gespeichert wurde, hat gar keine
 * Fassung. Das ist kein Fehler, sondern die ehrliche Auskunft "die Historie beginnt bei der
 * naechsten Bearbeitung" -- eine erfundene Fassung 1 traege ein Datum, das nichts bedeutet.
 */
@Injectable()
export class ArticleVersionsService {
  private readonly log = new Logger(ArticleVersionsService.name);

  /**
   * ⚠️ Innerhalb dieses Fensters schreibt ein erneutes Speichern die JUENGSTE Fassung fort,
   * statt eine neue anzulegen.
   *
   * Ohne die Regel besteht die Liste nach einer Schreibsitzung aus zwanzig fast gleichen
   * Eintraegen, und der Stand, den man spaeter sucht, ist zwischen ihnen nicht auffindbar. Was
   * jemand wiederherstellen will, ist "wie es vor der Ueberarbeitung aussah" -- also die Sitzung,
   * nicht der einzelne Tastendruck. Das ist zugleich der Grund, warum die Zeit hier ueber SQL
   * entschieden wird (`datetime('now', ...)`) und nicht in JS: SQLite-Zeitstempel sind UTC ohne
   * Suffix, und `new Date(...)` liest sie lokal -- die Regel wuerde in jeder Zeitzone ausser UTC
   * um Stunden danebenliegen.
   */
  private static readonly MERGE_WINDOW = '-15 minutes';

  /**
   * Wie viele Fassungen je Artikel aufbewahrt werden. 0 = unbegrenzt.
   *
   * ⚠️ Einstellbar zur Laufzeit (`/bot`, Reiter „Wiki"), Env `WIKI_HISTORY_KEEP` ist nur der
   * Default -- gleiche Regel wie bei den Ollama-Werten. Deshalb wird der Wert bei JEDEM Lauf
   * frisch gelesen und nicht in ein Feld gelegt: eine gesenkte Grenze soll beim naechsten
   * Speichern greifen und nicht erst nach einem Neustart (dieselbe Ueberlegung wie bei
   * `bot.queue.concurrency`, das der Runner nach jeder Klasse neu liest). Der Cache im
   * SettingsService macht das billig.
   */
  private async keep(): Promise<number> {
    return (await this.settings.bot()).wiki.historyKeep;
  }

  /**
   * Laufende KI-Zusammenfassungen je Fassung.
   *
   * ⚠️ Wird eine Fassung fortgeschrieben, beschreibt eine noch laufende Zusammenfassung bereits
   * einen Stand, den es nicht mehr gibt -- sie wird deshalb abgebrochen. Ohne das gewaenne bei
   * schnellem Speichern das Rennen, wer zuletzt zurueckkommt, und das ist nicht zwingend der
   * letzte Stand.
   */
  private readonly running = new Map<number, AbortController>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
    private readonly ollama: OllamaService,
    private readonly settings: SettingsService,
  ) {}

  // --- Schreibpfad ---------------------------------------------------------

  /**
   * Fassung 1 eines frisch angelegten Artikels. Laeuft INNERHALB der Transaktion des Aufrufers.
   *
   * ⚠️ Warum ueberhaupt: ohne sie beginnt die Historie mit der ersten Aenderung, und der Stand,
   * mit dem der Artikel entstanden ist, waere der einzige, den man nie zurueckholen kann. Fuer
   * Altbestand leistet das die Nachsicherung in `record` -- fuer alles Neue ist sie damit
   * ueberfluessig.
   */
  async initial(
    manager: EntityManager,
    articleId: number,
    stand: { title: string; summary: string; content: string },
  ): Promise<void> {
    await manager.getRepository(ArticleVersion).insert({
      article_id: articleId,
      version_number: 1,
      title: stand.title,
      summary: stand.summary ?? '',
      content: stand.content,
    });
  }

  /**
   * Den neuen Stand als Fassung festhalten. Laeuft INNERHALB der Transaktion des Aufrufers.
   *
   * Liefert, was fuer die KI-Zusammenfassung gebraucht wird -- oder `null`, wenn sich am Text
   * nichts geaendert hat (dann entsteht auch keine Fassung: eine Bearbeitung, die nur ein Tag
   * hinzufuegt, ist keine Fassung des Textes).
   */
  async record(
    manager: EntityManager,
    articleId: number,
    before: { title: string; summary: string; content: string; updated_at: string | null },
    after: { title: string; summary: string; content: string },
    opts: { note?: string | null; forceNew?: boolean } = {},
  ): Promise<{ versionId: number; title: string; before: string; after: string } | null> {
    if (before.title === after.title && before.summary === after.summary && before.content === after.content) {
      return null;
    }
    const repo = manager.getRepository(ArticleVersion);

    let latest = await repo.findOne({ where: { article_id: articleId }, order: { version_number: 'DESC' } });

    // Nachsichern: der BISHERIGE Stand wird zur Fassung 1 -- mit seinem eigenen Datum, nicht mit
    // dem von jetzt (s. schema.ts). Danach gilt die Invariante "hoechste Fassung = aktueller
    // Stand" auch fuer Altbestand.
    let baselined = false;
    if (!latest) {
      const res = await repo.insert({
        article_id: articleId,
        version_number: 1,
        title: before.title,
        summary: before.summary ?? '',
        content: before.content,
      });
      const baseId = res.identifiers[0].id as number;
      // Das Datum in einem zweiten Schritt (s. Entity: `insert: false`). Fehlt `updated_at`,
      // bleibt der DB-Default von jetzt stehen -- ein erfundenes Datum waere schlechter als ein
      // ungenaues.
      if (before.updated_at) {
        await manager
          .createQueryBuilder()
          .update(ArticleVersion)
          .set({ created_at: before.updated_at })
          .where('id = :id', { id: baseId })
          .execute();
      }
      latest = await repo.findOne({ where: { id: baseId } });
      baselined = true;
    }

    // ⚠️ Eine gerade nachgesicherte Fassung wird NIE fortgeschrieben, egal wie alt ihr Datum ist.
    // Sonst verschluckt ein Artikel, der zufaellig vor Minuten importiert wurde, seinen eigenen
    // Ausgangsstand -- und das ist genau der, gegen den man spaeter vergleichen will.
    const fresh = baselined || opts.forceNew
      ? false
      : await this.withinWindow(manager, latest!.id);

    const previous = fresh
      ? ((
          await repo.find({
            where: { article_id: articleId },
            order: { version_number: 'DESC' },
            skip: 1,
            take: 1,
          })
        )[0] ?? null)
      : latest;

    let versionId: number;
    if (fresh) {
      // Fortschreiben. Die KI-Zusammenfassung faellt mit weg: sie beschriebe den Stand von vorhin.
      // Ueber den QueryBuilder, weil `created_at` ein FUNKTIONSwert ist (datetime('now')) --
      // derselbe Weg wie in ArticlesService.update, und aus demselben Grund: ein JS-Date brächte
      // Millisekunden und eine andere Schreibweise in eine Spalte, die sonst der DB-Default fuellt.
      await manager
        .createQueryBuilder()
        .update(ArticleVersion)
        .set({
          title: after.title,
          summary: after.summary ?? '',
          content: after.content,
          note: opts.note ?? latest!.note ?? null,
          ai_summary: null,
          ai_summary_html: null,
          created_at: () => "datetime('now')",
        })
        .where('id = :id', { id: latest!.id })
        .execute();
      versionId = latest!.id;
    } else {
      // created_at bleibt weg -> DB-Default datetime('now'), gleiche Form wie ueberall sonst.
      const res = await repo.insert({
        article_id: articleId,
        version_number: latest!.version_number + 1,
        title: after.title,
        summary: after.summary ?? '',
        content: after.content,
        note: opts.note ?? null,
      });
      versionId = res.identifiers[0].id as number;
    }

    await this.trim(manager, articleId);

    // Ohne Vorfassung gibt es nichts zu beschreiben -- und das ist kein Fehlschlag, sondern der
    // erste Eintrag einer Historie.
    if (!previous) return null;
    return { versionId, title: after.title, before: previous.content, after: after.content };
  }

  /** Liegt die Fassung noch im Zusammenfass-Fenster? Entschieden von SQLite, s. MERGE_WINDOW. */
  private async withinWindow(manager: EntityManager, versionId: number): Promise<boolean> {
    const row = await manager
      .getRepository(ArticleVersion)
      .createQueryBuilder('v')
      .where('v.id = :id', { id: versionId })
      .andWhere(`v.created_at > datetime('now', :window)`, { window: ArticleVersionsService.MERGE_WINDOW })
      .getOne();
    return !!row;
  }

  /**
   * Aelteste Fassungen wegwerfen, sobald der Deckel ueberschritten ist.
   *
   * Zwei Schritte statt eines DELETE mit Subquery: Raw-SQL ist im Projekt der Ausnahmefall
   * (FTS5 und Schema-DDL), und die Ids sind ohnehin in einer Abfrage zu haben.
   */
  private async trim(manager: EntityManager, articleId: number): Promise<void> {
    const keep = await this.keep();
    if (!keep) return;
    const repo = manager.getRepository(ArticleVersion);
    const all = await repo.find({
      where: { article_id: articleId },
      order: { version_number: 'DESC' },
      select: { id: true },
    });
    const doomed = all.slice(keep);
    if (doomed.length) await repo.delete({ id: In(doomed.map((d) => d.id)) });
  }

  /**
   * KI-Zusammenfassung der Aenderung nachtragen (Hintergrund, ausserhalb jeder Transaktion).
   *
   * Gleiche Bauart wie `JavaService.generateVersionSummary`: liefert Ollama nichts, bleibt die
   * Spalte NULL und die Ansicht zeigt den Diff -- der ist ohnehin die Hauptsache, die
   * Zusammenfassung nur die Abkuerzung davor.
   */
  async summarize(job: { versionId: number; title: string; before: string; after: string }): Promise<void> {
    this.running.get(job.versionId)?.abort();
    const ctl = new AbortController();
    this.running.set(job.versionId, ctl);
    try {
      const diff = unifiedDiff(`${job.title}.md`, job.before, job.after);
      const summary = await this.ollama.generateArticleDiffSummary(
        { title: job.title, diff },
        ctl.signal,
      );
      if (!summary || ctl.signal.aborted) return;
      const { html } = await this.markdown.renderMarkdown(summary);
      // Die Zeile kann inzwischen weggetrimmt oder fortgeschrieben worden sein -- ein UPDATE auf
      // nichts ist hier der Normalfall, kein Fehler.
      await this.ds
        .getRepository(ArticleVersion)
        .update({ id: job.versionId }, { ai_summary: summary, ai_summary_html: html });
    } catch (e: any) {
      if (e?.name !== 'AbortError') this.log.warn(`Change summary failed: ${e?.message || e}`);
    } finally {
      if (this.running.get(job.versionId) === ctl) this.running.delete(job.versionId);
    }
  }

  // --- Lesepfad ------------------------------------------------------------

  /**
   * Die Fassungsliste eines Artikels, neueste zuerst -- ohne Text, aber MIT der Bilanz gegen die
   * jeweilige Vorfassung.
   *
   * ⚠️ Neben den Zeilen steht ein Zeichen-Delta. Bei Prosa ist eine Zeile ein Absatz, und
   * "+1 −1" sieht beim korrigierten Tippfehler genauso aus wie beim komplett neu geschriebenen
   * Absatz -- die Zahl allein waere also keine Auskunft darueber, ob sich das Aufmachen lohnt.
   */
  async list(articleId: number): Promise<any> {
    const article = await this.ds.getRepository(Article).findOne({ where: { id: articleId } });
    if (!article) throw new NotFoundException('Article not found');

    const rows = await this.ds.getRepository(ArticleVersion).find({
      where: { article_id: articleId },
      order: { version_number: 'ASC' },
    });

    const versions = rows.map((v, idx) => {
      const prev = idx > 0 ? rows[idx - 1] : null;
      const stats = prev ? lineStats(prev.content, v.content) : { added: 0, removed: 0 };
      return {
        version_number: v.version_number,
        title: v.title,
        summary: v.summary,
        note: v.note,
        ai_summary: v.ai_summary,
        ai_summary_html: v.ai_summary_html,
        created_at: v.created_at,
        chars: v.content.length,
        // Die aelteste vorhandene Fassung hat keine Vorfassung -- entweder weil sie die erste ist
        // oder weil der Deckel ihre Vorgaenger geraeumt hat. Beides heisst: hier ist kein
        // Vergleich moeglich, und `null` sagt das, wo eine 0 "nichts geaendert" behaupten wuerde.
        stats: prev ? stats : null,
        title_changed: !!prev && prev.title !== v.title,
        summary_changed: !!prev && prev.summary !== v.summary,
      };
    });
    versions.reverse();

    return {
      article: { id: article.id, slug: article.slug, title: article.title, updated_at: article.updated_at },
      versions,
      // Was der Bericht NICHT zeigen kann, steht in der Antwort statt nur in der Ansicht:
      // getrimmte Fassungen sind weg, und ein Verlauf, der bei Fassung 12 beginnt, sieht sonst
      // aus wie einer, der dort begonnen hat.
      keep: await this.keep(),
      trimmed: versions.length > 0 && versions[versions.length - 1].version_number > 1,
    };
  }

  /** Eine Fassung im Volltext (fuer die Vorschau vor dem Wiederherstellen). */
  async getOne(articleId: number, version: number): Promise<ArticleVersion> {
    const row = await this.ds
      .getRepository(ArticleVersion)
      .findOne({ where: { article_id: articleId, version_number: version } });
    if (!row) throw new NotFoundException('Version not found');
    return row;
  }

  /**
   * Zwei Fassungen gegeneinander.
   *
   * `from = 0` ist zulaessig und bedeutet "gegen nichts" -- nur so laesst sich die aelteste
   * vorhandene Fassung ueberhaupt ansehen, ohne dass die Ansicht dafuer einen zweiten Modus
   * braucht.
   */
  async compare(articleId: number, from: number, to: number): Promise<any> {
    const target = await this.getOne(articleId, to);
    const source = from > 0 ? await this.getOne(articleId, from) : null;
    const diff = compareTexts(source?.content ?? '', target.content);
    return {
      from: source
        ? { version_number: source.version_number, title: source.title, summary: source.summary, created_at: source.created_at }
        : null,
      to: {
        version_number: target.version_number,
        title: target.title,
        summary: target.summary,
        created_at: target.created_at,
        note: target.note,
        ai_summary_html: target.ai_summary_html,
      },
      // Titel und Zusammenfassung stehen nicht IM Text und faenden im Zeilendiff deshalb nicht
      // statt. Eine Fassung, die nur den Titel aendert, saehe sonst aus wie eine ohne jede
      // Aenderung -- also wie ein Fehler der Ansicht.
      meta: {
        title_changed: !!source && source.title !== target.title,
        summary_changed: !!source && source.summary !== target.summary,
      },
      rows: diff.rows,
      stats: diff.stats,
    };
  }
}
