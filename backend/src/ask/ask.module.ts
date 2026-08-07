import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { AskService } from './ask.service';
import { JavaModule } from '../java/java.module';

// Eigenes Modul, obwohl die Quellen aus java/ kommen: `/ask` ist ein KI-Pfad wie die Queue oder der
// artikelgebundene Lauf -- er haengt an keiner einzelnen Klasse, sondern an der Frage. Die
// Bedeutungssuche kommt als Baustein aus JavaModule (dort entsteht der Index), statt hier ein
// zweites Mal implementiert zu werden.
@Module({
  imports: [JavaModule],
  controllers: [AskController],
  providers: [AskService],
})
export class AskModule {}
