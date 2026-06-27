// Sammelexport aller Entities fuer TypeOrmModule.forRoot/forFeature.
export { Category } from './category.entity';
export { Article } from './article.entity';
export { Tag } from './tag.entity';
export { ArticleTag } from './article-tag.entity';
export { Relation } from './relation.entity';
export { JavaFile } from './java-file.entity';
export { JavaMethod } from './java-method.entity';
export { JavaDependency } from './java-dependency.entity';

import { Category } from './category.entity';
import { Article } from './article.entity';
import { Tag } from './tag.entity';
import { ArticleTag } from './article-tag.entity';
import { Relation } from './relation.entity';
import { JavaFile } from './java-file.entity';
import { JavaMethod } from './java-method.entity';
import { JavaDependency } from './java-dependency.entity';

export const ALL_ENTITIES = [
  Category,
  Article,
  Tag,
  ArticleTag,
  Relation,
  JavaFile,
  JavaMethod,
  JavaDependency,
];
