import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Relation } from '../entities/relation.entity';

@Injectable()
export class RelationsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  // Kompletter Graph fuer die GraphView: Knoten = Artikel, Kanten = relations.
  async getGraph(): Promise<{ nodes: any[]; edges: any[] }> {
    // `category_id` faehrt mit: die Farbe im Graphen haengt an der Kategorie selbst, nicht an
    // ihrem Namen – zwei Kategorien duerfen gleich heissen, und ueber den Namen zu schluesseln
    // waere genau die Art Zuordnung, die beim ersten Duplikat still danebengreift.
    const nodes = await this.ds.query(
      `SELECT a.id, a.slug, a.title, a.category_id, c.name AS category, c.slug AS category_slug
       FROM articles a LEFT JOIN categories c ON c.id = a.category_id`,
    );
    // Relation-Entity hat exakt die Spalten id, source_id, target_id, relation_type, label.
    const edges = await this.ds.getRepository(Relation).find();
    return { nodes, edges };
  }

  async create(body: any): Promise<any> {
    const b = body || {};
    const { source_id, target_id, relation_type = 'related', label = '' } = b;
    if (!source_id || !target_id) throw new BadRequestException('source_id and target_id are required');
    if (source_id === target_id) throw new BadRequestException('An article cannot relate to itself');
    try {
      const res = await this.ds.getRepository(Relation).insert({ source_id, target_id, relation_type, label });
      const id = res.identifiers[0].id as number;
      return this.ds.getRepository(Relation).findOne({ where: { id } });
    } catch {
      throw new ConflictException('This relation already exists');
    }
  }

  async remove(idParam: string): Promise<void> {
    await this.ds.getRepository(Relation).delete({ id: Number(idParam) });
  }
}
