import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';

// Zentraler Fehler-Handler -> saubere JSON-Antwort `{ error: <message> }` statt HTML-Stacktrace.
// Entspricht dem Express-Error-Handler aus backend/server.js. Bekannte HttpExceptions (mit
// deutscher Meldung) werden mit ihrem Status durchgereicht; alles andere -> 500.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message: string;
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object' && 'message' in body) {
        const m = (body as any).message;
        message = Array.isArray(m) ? m.join(', ') : String(m);
      } else {
        message = exception.message;
      }
      res.status(status).json({ error: message });
      return;
    }

    console.error('[API-Fehler]', exception);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
}
