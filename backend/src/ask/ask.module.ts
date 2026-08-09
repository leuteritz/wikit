import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { AskService } from './ask.service';
import { JavaModule } from '../java/java.module';
import { ArticlesModule } from '../articles/articles.module';

// Eigenes Modul, obwohl die Quellen aus java/ und articles/ kommen: `/ask` ist ein KI-Pfad wie die
// Queue oder der artikelgebundene Lauf -- er haengt an keiner einzelnen Klasse und an keinem
// einzelnen Artikel, sondern an der Frage. Beide Bedeutungsindizes kommen als Baustein aus ihrem
// eigenen Modul (dort entstehen sie, dort liegt ihr Vektor-Cache), statt hier ein drittes Mal
// implementiert zu werden.
@Module({
  imports: [JavaModule, ArticlesModule],
  controllers: [AskController],
  providers: [AskService],
})
export class AskModule {}
