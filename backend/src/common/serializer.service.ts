import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarkdownService } from './markdown.service';
import { Article } from '../entities/article.entity';
import { ArticleTag } from '../entities/article-tag.entity';
import { Category } from '../entities/category.entity';
import { JavaDependency } from '../entities/java-dependency.entity';
import { JavaFile } from '../entities/java-file.entity';
import { JavaMethod } from '../entities/java-method.entity';
import { Relation } from '../entities/relation.entity';
import { Tag } from '../entities/tag.entity';

// Wandelt DB-Zeilen in das exakte API-Format. Reads laufen ueber Repository/QueryBuilder
// (TypeORM). Die JSON-Shapes muessen byte-genau dem alten backend/db.js entsprechen
// (Frontend-Contract): siehe Tests in der README/Plan-Datei.
@Injectable()
export class SerializerService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly markdown: MarkdownService,
  ) {}

  // Eine Methoden-Signatur als String (z. B. fuers Edge-Panel / signature_html).
  // Public, damit JavaService.getMethodSnippet dieselbe Logik wiederverwendet.
  buildSignature(m: { return_type?: string | null; method_name: string; parameters: any[] }): string {
    const params = (m.parameters || []).map((p: any) => `${p.type} ${p.name}`.trim()).join(', ');
    return `${m.return_type || 'void'} ${m.method_name}(${params})`;
  }

  private safeJson(str: any, fallback: any): any {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  async tagsForArticle(articleId: number): Promise<string[]> {
    const rows = await this.ds
      .getRepository(Tag)
      .createQueryBuilder('t')
      .innerJoin(ArticleTag, 'at', 'at.tag_id = t.id')
      .where('at.article_id = :id', { id: articleId })
      .orderBy('t.name', 'ASC')
      .select('t.name', 'name')
      .getRawMany();
    return rows.map((r) => r.name);
  }

  async relationsForArticle(articleId: number): Promise<{ outgoing: any[]; incoming: any[] }> {
    const outgoing = await this.ds
      .getRepository(Relation)
      .createQueryBuilder('r')
      .innerJoin(Article, 'a', 'a.id = r.target_id')
      .where('r.source_id = :id', { id: articleId })
      .select('r.id', 'id')
      .addSelect('r.relation_type', 'relation_type')
      .addSelect('r.label', 'label')
      .addSelect('a.id', 'article_id')
      .addSelect('a.slug', 'slug')
      .addSelect('a.title', 'title')
      .getRawMany();
    const incoming = await this.ds
      .getRepository(Relation)
      .createQueryBuilder('r')
      .innerJoin(Article, 'a', 'a.id = r.source_id')
      .where('r.target_id = :id', { id: articleId })
      .select('r.id', 'id')
      .addSelect('r.relation_type', 'relation_type')
      .addSelect('r.label', 'label')
      .addSelect('a.id', 'article_id')
      .addSelect('a.slug', 'slug')
      .addSelect('a.title', 'title')
      .getRawMany();
    return { outgoing, incoming };
  }

  // Basis-Shape: { id, slug, title, summary, category, tags, created_at, updated_at }
  // Mit content zusaetzlich: content, content_html, toc, relations{outgoing,incoming}.
  async serializeArticle(row: any, opts: { withContent?: boolean } = {}): Promise<any> {
    const withContent = opts.withContent ?? true;
    if (!row) return null;
    const category = row.category_id
      ? await this.ds.getRepository(Category).findOne({
          where: { id: row.category_id },
          select: { id: true, name: true, slug: true, icon: true },
        })
      : null;
    const out: any = {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      category: category ?? null,
      tags: await this.tagsForArticle(row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (withContent) {
      out.content = row.content;
      out.content_html = row.content_html;
      out.toc = this.safeJson(row.toc, []);
      out.relations = await this.relationsForArticle(row.id);
    }
    return out;
  }

  // Wandelt eine java_files-Zeile (Entity ODER Raw-Row) ins API-Format.
  // Die Spalte heisst 'package' (Raw-Row) bzw. Property 'pkg' (Entity) -> beides abfangen.
  async serializeJavaFile(row: any, opts: { withSource?: boolean } = {}): Promise<any> {
    const withSource = opts.withSource ?? false;
    if (!row) return null;
    const pkg = row.pkg !== undefined ? row.pkg : row.package;

    const methodRows = await this.ds.getRepository(JavaMethod).find({
      where: { file_id: row.id },
      order: { id: 'ASC' },
      select: {
        id: true,
        method_name: true,
        return_type: true,
        parameters: true,
        javadoc: true,
        ai_summary: true,
        body: true,
        start_line: true,
        body_start_line: true,
      },
    });
    // signature_html (Shiki java) + summary_html (KI-Text als Markdown) server-seitig rendern,
    // damit das Frontend kein Highlighter-Bundle laedt (Architekturprinzip).
    const methods = await Promise.all(
      methodRows.map(async (m) => {
        const parameters = this.safeJson(m.parameters, []);
        const { html: signatureHtml } = await this.markdown.renderMarkdown(
          '```java\n' + this.buildSignature({ ...m, parameters }) + '\n```',
        );
        const { html: summaryHtml } = m.ai_summary
          ? await this.markdown.renderMarkdown(m.ai_summary)
          : { html: '' };
        return { ...m, parameters, signature_html: signatureHtml, summary_html: summaryHtml };
      }),
    );

    const dependencies = (
      await this.ds.getRepository(JavaDependency).find({
        where: { from_file_id: row.id },
        order: { to_class_name: 'ASC' },
        select: { to_class_name: true },
      })
    ).map((d) => d.to_class_name);

    const articleSlug = row.article_id
      ? (
          await this.ds
            .getRepository(Article)
            .findOne({ where: { id: row.article_id }, select: { slug: true } })
        )?.slug ?? null
      : null;

    const out: any = {
      id: row.id,
      article_id: row.article_id,
      article_slug: articleSlug,
      filename: row.filename,
      package: pkg,
      class_name: row.class_name,
      class_type: row.class_type,
      description: row.description ?? null,
      description_html: row.description_html ?? null,
      generated_at: row.generated_at ?? null,
      created_at: row.created_at,
      methods,
      dependencies,
    };
    if (withSource) out.raw_source = row.raw_source;
    return out;
  }

  // Globaler Abhaengigkeitsgraph: Knoten = alle java_files, Kanten nur zwischen
  // analysierten Klassen (Import-FQN matcht package.class_name exakt, sonst class_name).
  async graphForJavaFiles(): Promise<{ nodes: any[]; edges: any[] }> {
    const files = await this.ds.getRepository(JavaFile).find({
      select: { id: true, pkg: true, class_name: true, class_type: true, description: true },
    });

    // Pro Datei: wie viele Methoden haben eine KI-Beschreibung (ai_summary != javadoc)?
    const methodStats: Array<{ file_id: number; analyzed: number }> = await this.ds.query(
      `SELECT file_id,
              SUM(CASE WHEN ai_summary IS NOT NULL AND TRIM(ai_summary) <> ''
                        AND ai_summary <> COALESCE(javadoc,'') THEN 1 ELSE 0 END) AS analyzed
       FROM java_methods GROUP BY file_id`,
    );
    const analyzedByFile = new Map<number, number>();
    for (const s of methodStats) analyzedByFile.set(s.file_id, Number(s.analyzed) || 0);

    const byFqn = new Map<string, number>();
    const byClass = new Map<string, number[]>();
    for (const f of files) {
      const fqn = f.pkg ? `${f.pkg}.${f.class_name}` : f.class_name;
      byFqn.set(fqn, f.id);
      if (!byClass.has(f.class_name)) byClass.set(f.class_name, []);
      byClass.get(f.class_name)!.push(f.id);
    }

    const deps = await this.ds.getRepository(JavaDependency).find({
      select: { from_file_id: true, to_class_name: true },
    });
    const edges: any[] = [];
    const seen = new Set<string>();
    for (const d of deps) {
      let targetId = byFqn.get(d.to_class_name);
      if (targetId == null) {
        const simple = d.to_class_name.split('.').pop()!;
        const matches = byClass.get(simple);
        if (matches && matches.length === 1) targetId = matches[0];
      }
      if (targetId == null || targetId === d.from_file_id) continue; // extern oder Self-Edge
      const key = `${d.from_file_id}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: edges.length + 1, source_id: d.from_file_id, target_id: targetId });
    }

    const nodes = files.map((f) => ({
      id: f.id,
      package: f.pkg,
      class_name: f.class_name,
      class_type: f.class_type,
      // KI-Indikatoren fuer den Graphen.
      analyzed: !!(f.description && f.description.trim()),
      methods_analyzed: analyzedByFile.get(f.id) || 0,
    }));
    return { nodes, edges };
  }
}
