import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('tags')
export class TagsController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  // Alle Tags mit Nutzungszahl (fuer Filter/Autocomplete). Aggregat + COLLATE NOCASE -> Raw-SQL.
  @Get()
  list() {
    return this.ds.query(
      `SELECT t.id, t.name, COUNT(at.article_id) AS count
       FROM tags t LEFT JOIN article_tags at ON at.tag_id = t.id
       GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE`,
    );
  }
}
