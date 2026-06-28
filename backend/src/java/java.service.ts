import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FtsService } from '../database/fts.service';
import { MarkdownService } from '../common/markdown.service';
import { OllamaService } from '../common/ollama.service';
import { SerializerService } from '../common/serializer.service';
import { parseJava } from '../common/java-parser';
import { JavaDependency } from '../entities/java-dependency.entity';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';

// Java-Code-Analyse: parsen (rein JS), speichern, Graph liefern, KI-Summaries on-demand.
// Muster wie ArticlesService: erst async arbeiten, DANN in einer ds.transaction() schreiben.
@Injectable()
export class JavaService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly serializer: SerializerService,
    private readonly ollama: OllamaService,
    private readonly markdown: MarkdownService,
    private readonly fts: FtsService,
  ) {}

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  // Datei analysieren: parsen + speichern (ohne KI -> Graph erscheint sofort).
  async analyze(body: any): Promise<any> {
    const b = body || {};
    const { source = '', filename = '' } = b;
    if (!source.trim()) throw new BadRequestException('Quellcode ist erforderlich');

    let parsed;
    try {
      parsed = parseJava(source);
    } catch (e: any) {
      throw new BadRequestException(`Parsen fehlgeschlagen: ${e.message}`);
    }

    const cls = parsed.primary;
    const name = (filename && filename.trim()) || `${cls.class_name}.java`;

    let fileId!: number;
    await this.ds.transaction(async (manager) => {
      const res = await manager.getRepository(JavaFile).insert({
        filename: name,
        pkg: parsed.package || null,
        class_name: cls.class_name,
        class_type: cls.class_type,
        raw_source: source,
        class_line: cls.class_line ?? null,
      });
      fileId = res.identifiers[0].id as number;

      for (const m of cls.methods) {
        // ai_summary initial = Javadoc-Fallback (KI spaeter on-demand pro Methode).
        await manager.getRepository(JavaMethod).insert({
          file_id: fileId,
          method_name: m.method_name,
          return_type: m.return_type,
          parameters: JSON.stringify(m.parameters),
          javadoc: m.javadoc || '',
          ai_summary: m.javadoc || '',
          body: m.body || '',
          start_line: m.start_line ?? null,
          body_start_line: m.body_start_line ?? null,
        });
      }

      for (const fqn of parsed.imports) {
        await manager.getRepository(JavaDependency).insert({ from_file_id: fileId, to_class_name: fqn });
      }

      // Klasse sofort in den Java-FTS aufnehmen (Wissensquelle fuer kuenftige Prompt-Anreicherung).
      await this.fts.indexJavaFile(manager, fileId);
    });

    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    return {
      file: await this.serializer.serializeJavaFile(row, { withSource: true }),
      graph: await this.serializer.graphForJavaFiles(),
    };
  }

  // Liste aller analysierten Dateien (ohne raw_source). COLLATE NOCASE -> Raw-SQL.
  async listFiles(): Promise<any[]> {
    const rows = await this.ds.query('SELECT * FROM java_files ORDER BY class_name COLLATE NOCASE');
    return Promise.all(rows.map((r: any) => this.serializer.serializeJavaFile(r)));
  }

  // Globaler Abhaengigkeitsgraph (Knoten = Klassen, Kanten = interne Imports).
  async graph(): Promise<any> {
    return this.serializer.graphForJavaFiles();
  }

  // Detail einer Datei inkl. Methoden, Dependencies und Quelltext.
  async getFile(idParam: string): Promise<any> {
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id: Number(idParam) } });
    if (!row) throw new NotFoundException('Datei nicht gefunden');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Quellcode EINER Methode als Shiki-gehighlightetes HTML (fuers Graph-Edge-Panel).
  // Rein lesend + Render -> KEINE Transaktion noetig. Das HTML kommt aus dem vorhandenen
  // Markdown-Primitiv (Dual-Theme, defaultColor:false) inkl. sanitize-html -> kein Extra-Sanitizing.
  async getMethodSnippet(fileIdParam: string, methodNameParam: string): Promise<any> {
    const fileId = Number(fileIdParam);
    const methodName = (methodNameParam || '').toString().trim();
    if (!fileId || !methodName) {
      throw new BadRequestException('fileId und methodName sind erforderlich');
    }

    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    // Overloads teilen sich den Namen -> erste Methode (ORDER BY id, wie ueberall im Serializer).
    const method = await this.ds.getRepository(JavaMethod).findOne({
      where: { file_id: fileId, method_name: methodName },
      order: { id: 'ASC' },
    });
    if (!method) {
      throw new NotFoundException(`Methode "${methodName}" in ${file.class_name} nicht gefunden`);
    }

    const parameters = this.safeJson(method.parameters, []);
    const signature = this.serializer.buildSignature({ ...method, parameters });
    // Interface-/abstract-Methoden haben keinen Body -> dann die Signatur als Snippet zeigen.
    const code = method.body && method.body.trim() ? method.body : `${signature};`;
    // Zeile: gespeicherter Wert (neu analysiert) oder Fallback aus dem Rohquelltext (Bestandsdaten).
    const startLine = method.start_line ?? this.findMethodLine(file.raw_source, methodName);

    const { html } = await this.markdown.renderMarkdown('```java\n' + code + '\n```');
    return { code, startLine, html, signature, className: file.class_name, methodName };
  }

  // Fallback-Zeilenermittlung fuer Bestandsdaten ohne gespeicherte start_line:
  // erste Quellzeile, in der "<methodName>(" auftaucht. 1-basiert, Default 1.
  private findMethodLine(source: string, methodName: string): number {
    const lines = (source || '').split('\n');
    const safe = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${safe}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
    return 1;
  }

  // On-demand KI-Beschreibung fuer EINE Methode (async, ausserhalb der Transaktion).
  // Body optional `{ userContext }` -> Projekt-Kontext fliesst in den Prompt ein.
  // Nutzt den geparsten Methodenrumpf (generateMethodDescription) und pflegt den Java-FTS.
  async summarize(idParam: string, body?: any): Promise<any> {
    const id = Number(idParam);
    const method = await this.ds.getRepository(JavaMethod).findOne({ where: { id } });
    if (!method) throw new NotFoundException('Methode nicht gefunden');
    const file = await this.ds
      .getRepository(JavaFile)
      .findOne({ where: { id: method.file_id }, select: { class_name: true } });

    const summary = await this.ollama.generateMethodDescription({
      className: file?.class_name || '',
      method: { ...method, parameters: this.safeJson(method.parameters, []) },
      context: body?.userContext,
    });

    // Fallback: ist Ollama nicht erreichbar, bleibt der Javadoc/bisherige Text erhalten.
    const ollamaUnavailable = !summary;
    const finalSummary = summary || method.ai_summary || method.javadoc || '';

    // Markdown -> HTML vor der Transaktion rendern (async/teuer ausserhalb der Tx).
    const { html: summaryHtml } = await this.markdown.renderMarkdown(finalSummary);

    await this.ds.transaction(async (manager) => {
      await manager.getRepository(JavaMethod).update({ id }, { ai_summary: finalSummary });
      await this.fts.indexJavaFile(manager, method.file_id);
    });

    const updated = await this.ds.getRepository(JavaMethod).findOne({ where: { id } });
    return {
      method: { ...updated, parameters: this.safeJson(updated!.parameters, []) },
      summary_html: summaryHtml,
      ollama_unavailable: ollamaUnavailable,
    };
  }

  // On-demand KI-Beschreibung fuer die GANZE Klasse (async, ausserhalb der Transaktion).
  // Reuse der vorhandenen Spalten description/description_html/generated_at -> kein Schema-Aenderung.
  // Das Setzen von description flippt den Graph-Knoten auf analyzed: true (Serializer).
  async summarizeClass(idParam: string, body?: any): Promise<any> {
    const id = Number(idParam);
    const file = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    if (!file) throw new NotFoundException('Datei nicht gefunden');

    const methods = await this.ds
      .getRepository(JavaMethod)
      .find({ where: { file_id: id }, select: { method_name: true } });

    const summary = await this.ollama.generateClassSummary({
      classInfo: {
        class_name: file.class_name,
        class_type: file.class_type,
        package: file.pkg,
        methods: methods.map((m) => ({ method_name: m.method_name })),
      },
      context: body?.userContext,
    });

    // Fallback: ist Ollama nicht erreichbar, bleibt die bisherige Beschreibung erhalten.
    const ollamaUnavailable = !summary;
    const finalDescription = summary || file.description || '';

    // Markdown -> HTML vor der Transaktion rendern (async/teuer ausserhalb der Tx).
    const { html: descriptionHtml } = await this.markdown.renderMarkdown(finalDescription);
    const generatedAt = new Date().toISOString();

    await this.ds.transaction(async (manager) => {
      await manager
        .getRepository(JavaFile)
        .update({ id }, { description: finalDescription, description_html: descriptionHtml, generated_at: generatedAt });
      await this.fts.indexJavaFile(manager, id);
    });

    const updated = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    return {
      file: await this.serializer.serializeJavaFile(updated, { withSource: true }),
      description_html: descriptionHtml,
      ollama_unavailable: ollamaUnavailable,
    };
  }

  // Java-Datei zu einem Artikel (article_id) holen -> Live-Panel auf dem Wiki-Artikel.
  // Liefert null (Controller -> 404), wenn der Artikel keine verknuepfte Klasse hat.
  async getFileByArticle(articleIdParam: string): Promise<any> {
    const articleId = Number(articleIdParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { article_id: articleId } });
    if (!row) throw new NotFoundException('Keine Java-Klasse mit diesem Artikel verknuepft');
    return this.serializer.serializeJavaFile(row, { withSource: true });
  }

  // Datei + Methoden + Dependencies loeschen (CASCADE ueber FK). Verknuepfter Artikel bleibt
  // bestehen (FK ist andersherum: article -> SET NULL). Der java_fts-Eintrag (rowid = id) wird
  // nicht per Trigger gepflegt -> hier explizit entfernen, sonst bleibt er verwaist.
  async deleteFile(idParam: string): Promise<void> {
    const id = Number(idParam);
    await this.ds.transaction(async (manager) => {
      await manager.query('DELETE FROM java_fts WHERE rowid = ?', [id]);
      await manager.getRepository(JavaFile).delete({ id });
    });
  }

  // Optional: erstellten Wiki-Artikel mit der Java-Datei verknuepfen (macht sie via FTS auffindbar).
  async linkArticle(idParam: string, body: any): Promise<any> {
    const id = Number(idParam);
    const row = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    if (!row) throw new NotFoundException('Datei nicht gefunden');
    const articleId = body?.article_id ?? null;

    await this.ds.transaction(async (manager) => {
      await manager.getRepository(JavaFile).update({ id }, { article_id: articleId });
      if (articleId) await this.fts.indexArticle(manager, articleId);
    });

    const updated = await this.ds.getRepository(JavaFile).findOne({ where: { id } });
    return this.serializer.serializeJavaFile(updated);
  }
}
