import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { AppModule } from './app.module';

// NestJS-Einstiegspunkt. Ersetzt das alte Express-server.js: ein Prozess, ein Port, API unter /api
// + Auslieferung der gebauten SPA (via ServeStaticModule in app.module.ts).
async function bootstrap(): Promise<void> {
  // bodyParser:false -> eigenen JSON-Parser mit 8mb-Limit setzen (wie express.json({limit:'8mb'})).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: '8mb' }));
  app.setGlobalPrefix('api');

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  await app.listen(PORT as number, HOST as string);
  console.log(
    `Wikit laeuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
  );
}

bootstrap();
