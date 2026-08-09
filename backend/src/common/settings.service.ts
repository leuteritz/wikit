import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Setting } from '../entities/setting.entity';
import {
  BOT_FIELDS,
  BotConfig,
  BotFieldSpec,
  envDefaults,
  getPath,
  normalizeHost,
  setPath,
  settingKey,
} from './bot-config';

// Persistenz der Bot-Einstellungen: Env/Code liefert den Default, die Tabelle `settings` den
// Override. Der Dienst ist die EINZIGE Stelle, die Werte prueft -- Controller und Oberflaeche
// lesen ihre Grenzen aus BOT_FIELDS, damit das Formular nichts anbietet, was hier abgelehnt wird.
//
// Cache: Die aufgeloeste Konfiguration wird im Speicher gehalten und nur beim Schreiben verworfen.
// Ohne ihn liefe vor JEDEM Ollama-Aufruf eine Abfrage ueber die Tabelle -- bei einer Queue mit
// tausenden Methoden also tausende Abfragen fuer Werte, die sich zwischendurch nie aendern. Es
// gibt genau einen schreibenden Prozess, deshalb reicht das Verwerfen beim Schreiben.

// ⚠️ Der Schluesselraum heisst NICHT mehr durchgehend `bot.` -- ein Feld, das keine
// Bot-Einstellung ist, traegt seinen eigenen (s. `key` in BotFieldSpec). Gelesen wird deshalb
// ueber `settingKey(spec)` statt ueber einen Praefix-Schnitt: sonst kaeme ein `wiki.*`-Wert nie
// an, und das Formular zeigte still den Default an, waehrend die Zeile daneben in der Tabelle
// steht. Fremde Schluessel (`arch.rules`) bleiben unberuehrt, weil nur bekannte Felder gesucht
// werden -- das war vorher der Zweck des Praefix-Filters.

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: BotConfig | null = null;
  private overrideCache: string[] = [];

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private spec(path: string): BotFieldSpec | undefined {
    return BOT_FIELDS.find((f) => f.path === path);
  }

  /** Die Default-Konfiguration ohne jeden Override (Env + Code). */
  defaults(): BotConfig {
    return envDefaults();
  }

  /** Aufgeloeste Konfiguration: Defaults, ueberschrieben von dem, was in der Tabelle steht. */
  async bot(): Promise<BotConfig> {
    if (this.cache) return this.cache;
    const cfg = envDefaults();
    const overrides: string[] = [];
    const rows = await this.ds.getRepository(Setting).find();
    for (const row of rows) {
      // Unbekannter Schluessel: stehen lassen, nicht anwenden. Er stammt aus einer aelteren oder
      // neueren Fassung -- ein Downgrade soll die Einstellung nicht loeschen.
      const spec = BOT_FIELDS.find((f) => settingKey(f) === row.key);
      if (!spec) continue;
      try {
        setPath(cfg, spec.path, this.parse(spec, row.value));
        overrides.push(spec.path);
      } catch (e: any) {
        this.logger.warn(`Ignoring stored setting ${row.key}: ${e?.message || e}`);
      }
    }
    this.cache = cfg;
    this.overrideCache = overrides;
    return cfg;
  }

  /** Welche Pfade aus der Tabelle stammen (die Oberflaeche zeigt "custom" statt "default" an). */
  async overrides(): Promise<string[]> {
    await this.bot();
    return [...this.overrideCache];
  }

  // --- Schreiben ------------------------------------------------------------

  /**
   * Teil-Update aus einem verschachtelten Objekt ({ prompts: { class: '…' } }). Nur bekannte
   * Pfade werden beachtet; jeder Wert geht durch coerce() und damit durch die Grenzen aus
   * BOT_FIELDS. Ein nullable-Feld auf null zu setzen LOESCHT die Zeile -- der Default dieser
   * Felder ist selbst null ("Ollama entscheidet"), also waere eine Zeile mit dem Wert null
   * dasselbe in teuer und der Reset-Knopf haette zwei Bedeutungen.
   */
  async patch(partial: any): Promise<BotConfig> {
    if (!partial || typeof partial !== 'object') throw new BadRequestException('Expected a settings object');

    const writes: Array<{ key: string; value: string }> = [];
    const removals: string[] = [];
    for (const spec of BOT_FIELDS) {
      const raw = getPath(partial, spec.path);
      if (raw === undefined) continue; // nicht mitgeschickt = unveraendert
      const value = this.coerce(spec, raw);
      if (value === null) removals.push(settingKey(spec));
      else writes.push({ key: settingKey(spec), value: String(value) });
    }
    if (!writes.length && !removals.length) return this.bot();

    const now = new Date().toISOString();
    await this.ds.transaction(async (manager) => {
      const repo = manager.getRepository(Setting);
      for (const w of writes) await repo.save({ key: w.key, value: w.value, updated_at: now });
      if (removals.length) await repo.delete(removals);
    });
    this.cache = null;
    return this.bot();
  }

  /**
   * Auf den Default zuruecksetzen: die Zeilen verschwinden, damit wieder Env/Code gilt.
   * Ohne `paths` betrifft es alle Bot-Einstellungen.
   */
  async reset(paths?: string[]): Promise<BotConfig> {
    const keys = (paths && paths.length ? paths : BOT_FIELDS.map((f) => f.path))
      .map((p) => this.spec(p))
      .filter((s): s is BotFieldSpec => !!s)
      .map((s) => settingKey(s));
    if (paths && paths.length && !keys.length) throw new BadRequestException('No known setting to reset');
    await this.ds.getRepository(Setting).delete(keys);
    this.cache = null;
    return this.bot();
  }

  // --- Typisierung ----------------------------------------------------------

  /** Gespeicherten TEXT zurueck in den Feldtyp bringen. */
  private parse(spec: BotFieldSpec, raw: string): any {
    if (spec.type === 'int' || spec.type === 'float') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
      return n;
    }
    return raw;
  }

  /**
   * Eingabe pruefen und in den Feldtyp bringen. Die Meldungen sind sichtbare UI-Texte
   * (all-exceptions.filter -> Toast), also nennen sie das Feld und die Grenze.
   */
  private coerce(spec: BotFieldSpec, raw: any): any {
    const label = spec.label;

    if (spec.nullable && (raw === null || raw === '' || raw === undefined)) return null;

    if (spec.type === 'int' || spec.type === 'float') {
      const n = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw);
      if (!Number.isFinite(n)) throw new BadRequestException(`${label} must be a number`);
      if (spec.type === 'int' && !Number.isInteger(n)) {
        throw new BadRequestException(`${label} must be a whole number`);
      }
      if (spec.min != null && n < spec.min) throw new BadRequestException(`${label} must be at least ${spec.min}`);
      if (spec.max != null && n > spec.max) throw new BadRequestException(`${label} must be at most ${spec.max}`);
      return n;
    }

    if (spec.type === 'enum') {
      const s = String(raw ?? '').trim();
      if (!spec.values?.includes(s)) {
        throw new BadRequestException(`${label} must be one of: ${(spec.values || []).join(', ')}`);
      }
      return s;
    }

    // 'text' behaelt Leerzeichen und Zeilenumbrueche (Prompt-Vorlagen), 'string' wird getrimmt.
    const s = spec.type === 'text' ? String(raw ?? '') : String(raw ?? '').trim();
    if (!s.trim() && !spec.allowEmpty) throw new BadRequestException(`${label} must not be empty`);

    if (spec.path === 'host') {
      const host = normalizeHost(s);
      if (!/^https?:\/\/[^\s/]+/i.test(host)) {
        throw new BadRequestException(`${label} must start with http:// or https://`);
      }
      return host;
    }
    return s;
  }
}
