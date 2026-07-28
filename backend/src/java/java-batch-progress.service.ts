import { Injectable } from '@nestjs/common';
import { EMPTY, Observable, Subject, interval, map, merge, of } from 'rxjs';

// Fortschritt eines LAUFENDEN analyze-batch-Aufrufs (SSE).
//
// Warum ueberhaupt: Ein Paste mit 150.000 Zeilen wird in EINEM Request geparst, geprueft,
// geschrieben und danach werden die Auto-Kanten neu berechnet. Das dauert je nach Maschine
// zehn Sekunden bis Minuten – ohne Rueckmeldung sieht der Nutzer nur einen Spinner und weiss
// weder, wie weit es ist, noch ob ueberhaupt etwas passiert.
//
// Der Client erzeugt eine jobId, oeffnet damit den Stream und schickt SIE im analyze-batch-Body
// mit. Der Service haelt pro jobId ein Subject; `last` puffert den zuletzt gemeldeten Stand,
// damit ein Client, der sich einen Tick zu spaet verbindet, sofort etwas sieht statt ins Leere.

export interface BatchProgressEvent {
  // Analyse: split -> parse -> check -> save -> edges -> done
  // Reset:   delete -> edges -> done
  phase: 'split' | 'parse' | 'check' | 'save' | 'edges' | 'delete' | 'done' | 'error' | 'heartbeat';
  done?: number;
  total?: number;
  message?: string;
}

// Nach dem Abschluss aufraeumen – aber nicht sofort: der letzte Stand soll noch abrufbar sein,
// falls der Client leicht verzoegert liest.
const CLEANUP_MS = 30_000;

@Injectable()
export class JavaBatchProgressService {
  private streams = new Map<string, Subject<BatchProgressEvent>>();
  private last = new Map<string, BatchProgressEvent>();
  private timers = new Map<string, NodeJS.Timeout>();

  private subject(jobId: string): Subject<BatchProgressEvent> {
    let s = this.streams.get(jobId);
    if (!s) {
      s = new Subject<BatchProgressEvent>();
      this.streams.set(jobId, s);
    }
    return s;
  }

  // SSE-Observable fuer den Controller. Heartbeat haelt die Verbindung durch nginx offen
  // (proxy_buffering off ist dort bereits gesetzt).
  stream(jobId: string): Observable<{ data: BatchProgressEvent }> {
    const subject = this.subject(jobId);
    const known = this.last.get(jobId);
    const initial = known ? of(known) : EMPTY;
    const heartbeat = interval(15000).pipe(map(() => ({ phase: 'heartbeat' as const })));
    return merge(initial, subject.asObservable(), heartbeat).pipe(map((data) => ({ data })));
  }

  emit(jobId: string | undefined | null, event: BatchProgressEvent): void {
    if (!jobId) return;
    this.last.set(jobId, event);
    this.subject(jobId).next(event);
    if (event.phase === 'done' || event.phase === 'error') this.scheduleCleanup(jobId);
  }

  private scheduleCleanup(jobId: string): void {
    clearTimeout(this.timers.get(jobId));
    this.timers.set(
      jobId,
      setTimeout(() => {
        this.streams.get(jobId)?.complete();
        this.streams.delete(jobId);
        this.last.delete(jobId);
        this.timers.delete(jobId);
      }, CLEANUP_MS),
    );
  }
}
