import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorRequestHandler, json } from 'express';
import { AppModule } from './app.module';

// NestJS-Einstiegspunkt. Ersetzt das alte Express-server.js: ein Prozess, ein Port, API unter /api
// + Auslieferung der gebauten SPA (via ServeStaticModule in app.module.ts).
async function bootstrap(): Promise<void> {
  // bodyParser:false -> eigenen JSON-Parser setzen (wie express.json({limit:…})).
  //
  // Das Limit betrifft praktisch nur EINEN Aufruf: POST /api/java/analyze-batch, in den ein
  // kompletter Massen-Paste geht (eine Codebasis mit einigen tausend Klassen sind schnell
  // zweistellige MB). Default deshalb grosszuegig; wer auf einem sehr kleinen Geraet laeuft,
  // dreht ihn per Env herunter.
  // ACHTUNG: der Wert steht auch in deploy/nginx.conf (client_max_body_size) – nginx lehnt
  // sonst frueher ab als das Backend, und zwar mit seiner eigenen 413-Seite.
  const bodyLimit = process.env.WIKI_BODY_LIMIT || '64mb';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: bodyLimit }));

  // Ein zu grosser Body meldet sich bei express.json() ueber next(err). Ohne eigenen Handler
  // laeuft die Anfrage danach ungeparst weiter und endet in Nests 404 ("Cannot POST
  // /api/java/analyze-batch") – eine Meldung, die den Fehler an genau der falschen Stelle
  // suchen laesst. Hier wird daraus die Aussage, um die es geht, im selben { error }-Format
  // wie all-exceptions.filter.ts (das Frontend liest nur dieses Feld).
  const tooLarge: ErrorRequestHandler = (err, _req, res, next) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({
        error: `Request too large (server limit ${bodyLimit}). Paste fewer classes at once, or raise WIKI_BODY_LIMIT.`,
      });
      return;
    }
    next(err);
  };
  app.use(tooLarge);
  app.setGlobalPrefix('api');

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  await app.listen(PORT as number, HOST as string);
  console.log(
    `Wikit laeuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
  );
}

bootstrap();
