import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ArticlesService } from '../articles/articles.service';
import { SettingsService } from '../common/settings.service';
import { BOT_FIELDS, settingKey } from '../common/bot-config';
import { Category } from '../entities/category.entity';
import { Setting } from '../entities/setting.entity';

/**
 * Der ganze Arbeitsstand als EINE Datei – und zurueck.
 *
 * Bisher lautete die Antwort auf „wie sichere ich das?" `cp wiki.db`, und die setzt Zugriff auf den
 * Pi voraus. Hier kommt heraus, was man aus dem Browser herunterladen, irgendwohin legen und
 * genauso wieder einspielen kann.
 *
 * ⚠️ **JSON, kein ZIP.** Ein Archiv braeuchte eine Abhaengigkeit fuer ein Problem, das ein
 * persoenliches Wiki nicht hat: Artikel sind Text, und Text komprimiert der Dateisystem-/
 * Uebertragungsweg ohnehin. Eine lesbare Datei ist ausserdem selbst schon eine Sicherung – man
 * kann sie oeffnen.
 *
 * ⚠️ **Was NICHT drin ist, und warum:**
 *   - Java-Bestand: hat seinen eigenen Rueckweg (`GET /api/java/export`), und Quelltext gehoert
 *     ohnehin in seine Versionsverwaltung.
 *   - Vektoren: aus dem Bestand jederzeit neu rechenbar (`rebuild`), aber um Groessenordnungen
 *     groesser als das, was sie beschreiben.
 *   - Artikel-Fassungen: nur auf ausdrueckliche Wahl. `article_versions` haelt je Zeile den VOLLEN
 *     Text – bei 20 Fassungen je Artikel waere das Backup ein Vielfaches der Nutzdaten.
 */
@Injectable()
export class BackupService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly articles: ArticlesService,
    private readonly settings: SettingsService,
  ) {}

  async create(opts: { versions?: boolean } = {}): Promise<any> {
    const categories = await this.ds.query(
      'SELECT name, slug, icon, sort_order FROM categories ORDER BY sort_order, name COLLATE NOCASE',
    );
    const articles = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.summary, a.content, a.created_at, a.updated_at, c.slug AS category
         FROM articles a LEFT JOIN categories c ON c.id = a.category_id
        ORDER BY a.title COLLATE NOCASE`,
    );
    const tagRows = await this.ds.query(
      `SELECT at.article_id, t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id`,
    );
    const tagsByArticle = new Map<number, string[]>();
    for (const r of tagRows) {
      const list = tagsByArticle.get(Number(r.article_id)) || [];
      list.push(r.name);
      tagsByArticle.set(Number(r.article_id), list);
    }

    // ⚠️ Beziehungen als SLUG-Paare, nicht als Ids: nach dem Einspielen sind die Ids andere.
    // Dieselbe Ueberlegung wie bei `article_links.target_slug` – der Name ueberlebt, die Id nicht.
    const relations = await this.ds.query(
      `SELECT s.slug AS source, t.slug AS target, r.relation_type, r.label
         FROM relations r JOIN articles s ON s.id = r.source_id JOIN articles t ON t.id = r.target_id`,
    );

    const settingRows: Array<{ key: string; value: string }> = await this.ds.query(
      'SELECT key, value FROM settings ORDER BY key',
    );

    const out: any = {
      format: 'wikit-backup',
      version: 1,
      generatedAt: new Date().toISOString(),
      categories,
      articles: articles.map((a: any) => ({
        slug: a.slug,
        title: a.title,
        summary: a.summary || '',
        category: a.category || null,
        tags: tagsByArticle.get(a.id) || [],
        content: a.content || '',
        created_at: a.created_at,
        updated_at: a.updated_at,
      })),
      relations,
      // Nur die tatsaechlich GESETZTEN Zeilen – eine fehlende Zeile heisst „nicht gesetzt", und das
      // ist eine Aussage, die das Backup mitnehmen muss (sonst waere der Zuruecksetzen-Knopf nach
      // dem Einspielen wirkungslos).
      settings: settingRows,
    };

    if (opts.versions) {
      out.versions = await this.ds.query(
        `SELECT a.slug, v.version_number, v.title, v.summary, v.content, v.note, v.created_at
           FROM article_versions v JOIN articles a ON a.id = v.article_id
          ORDER BY a.slug, v.version_number`,
      );
    }
    return out;
  }

  /**
   * Zurueckspielen.
   *
   * ⚠️ **Ueber die bestehenden Schreibpfade** (`ArticlesService.create/update`) und ausdruecklich
   * NICHT per rohem INSERT. Nur so laufen Rendering, Schlagwoerter, FTS-Index, Wikilink-Index und
   * die Fassungsaufzeichnung genauso wie beim gewoehnlichen Speichern. Ein zweiter Schreibpfad
   * muesste all das ein zweites Mal kennen – und wuerde es beim naechsten neuen Index vergessen.
   *
   * `merge` (Default) laesst vorhandene Slugs in Ruhe. `replace` schreibt sie ueber `update()` –
   * womit die vorherige Fassung im Verlauf steht und zurueckholbar bleibt. Es gibt bewusst keinen
   * Modus, der vorher alles loescht.
   */
  async restore(body: any): Promise<any> {
    const data = body?.data ?? body;
    if (!data || data.format !== 'wikit-backup') {
      return { error: 'This is not a Wikit backup file.', ok: false };
    }
    const mode: 'merge' | 'replace' = body?.mode === 'replace' ? 'replace' : 'merge';
    const report = { mode, categories: 0, articles: 0, updated: 0, skipped: 0, relations: 0, settings: 0 };

    // 1. Kategorien zuerst – ein Artikel verweist auf sie.
    const catRepo = this.ds.getRepository(Category);
    for (const c of data.categories || []) {
      if (!c?.slug) continue;
      const existing = await catRepo.findOne({ where: { slug: c.slug } });
      if (existing) await catRepo.update({ id: existing.id }, { name: c.name, icon: c.icon || '', sort_order: c.sort_order || 0 });
      else await catRepo.insert({ name: c.name, slug: c.slug, icon: c.icon || '', sort_order: c.sort_order || 0 });
      report.categories++;
    }
    const catBySlug = new Map<string, number>();
    for (const c of await catRepo.find()) catBySlug.set(c.slug, c.id);

    // 2. Artikel.
    for (const a of data.articles || []) {
      if (!a?.title) continue;
      const existing = a.slug ? await this.ds.query('SELECT id FROM articles WHERE slug = ?', [a.slug]) : [];
      const payload = {
        title: a.title,
        slug: a.slug,
        summary: a.summary || '',
        content: a.content || '',
        category_id: a.category ? catBySlug.get(a.category) ?? null : null,
        tags: a.tags || [],
      };
      if (existing.length) {
        if (mode === 'merge') {
          report.skipped++;
          continue;
        }
        await this.articles.update(String(existing[0].id), payload, { note: 'Restored from a backup', forceNew: true });
        report.updated++;
      } else {
        await this.articles.create(payload);
        report.articles++;
      }
    }

    // 3. Beziehungen zuletzt – beide Enden muessen dafuer existieren.
    for (const r of data.relations || []) {
      const s = await this.ds.query('SELECT id FROM articles WHERE slug = ?', [r.source]);
      const t = await this.ds.query('SELECT id FROM articles WHERE slug = ?', [r.target]);
      if (!s.length || !t.length) continue;
      // `OR IGNORE` gegen die UNIQUE-Regel: dieselbe Beziehung zweimal ist keine zweite.
      await this.ds.query(
        'INSERT OR IGNORE INTO relations (source_id, target_id, relation_type, label) VALUES (?, ?, ?, ?)',
        [s[0].id, t[0].id, r.relation_type || 'related', r.label || ''],
      );
      report.relations++;
    }

    // 4. Einstellungen. ⚠️ ZWEI Wege, weil es zwei Schluesselraeume gibt: was in `BOT_FIELDS` steht
    // (bot.* und wiki.*), geht durch `SettingsService.patch` und wird dort VALIDIERT; alles andere
    // – heute `arch.rules`, ein Regeltext und keine getypte Einstellung – direkt ins Repository.
    // Nicht gesicherte Schluessel werden nicht angefasst: eine fehlende Zeile heisst „Default".
    const known = new Map(BOT_FIELDS.map((f) => [settingKey(f), f]));
    const typed: any = {};
    const raw: Array<{ key: string; value: string }> = [];
    for (const s of data.settings || []) {
      if (!s?.key) continue;
      const spec = known.get(s.key);
      if (spec) setPath(typed, spec.path, s.value);
      else raw.push(s);
      report.settings++;
    }
    if (Object.keys(typed).length) await this.settings.patch(typed);
    if (raw.length) {
      const now = new Date().toISOString();
      const repo = this.ds.getRepository(Setting);
      for (const s of raw) await repo.save({ key: s.key, value: s.value, updated_at: now });
    }

    return { ok: true, ...report };
  }
}

/** `bot.prompts.class` -> verschachteltes Objekt, wie `patch` es erwartet. */
function setPath(target: any, path: string, value: any): void {
  const parts = path.split('.');
  let node = target;
  for (const p of parts.slice(0, -1)) node = node[p] ??= {};
  node[parts[parts.length - 1]] = value;
}
