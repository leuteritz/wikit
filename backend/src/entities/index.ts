// Sammelliste aller Entities fuer TypeOrmModule.forRoot/forFeature (app.module + common.module).
// BEWUSST nur `ALL_ENTITIES`: die Entity-Klassen selbst werden ueberall direkt aus ihrer Datei
// importiert (`../entities/java-file.entity`). Die frueheren Re-Exports hier waren ein zweiter,
// von niemandem genutzter Importpfad fuer dieselben Klassen.
import { Category } from './category.entity';
import { Article } from './article.entity';
import { ArticleVersion } from './article-version.entity';
import { Tag } from './tag.entity';
import { ArticleTag } from './article-tag.entity';
import { Relation } from './relation.entity';
import { JavaFile } from './java-file.entity';
import { JavaMethod } from './java-method.entity';
import { JavaDependency } from './java-dependency.entity';
import { JavaEdge } from './java-edge.entity';
import { JavaFileVersion } from './java-file-version.entity';
import { Setting } from './setting.entity';

export const ALL_ENTITIES = [
  Setting,
  Category,
  Article,
  ArticleVersion,
  Tag,
  ArticleTag,
  Relation,
  JavaFile,
  JavaMethod,
  JavaDependency,
  JavaEdge,
  JavaFileVersion,
];
