import { Injectable } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';

// Fortschrittsereignis, das per SSE an das Frontend gestreamt wird.
export interface AnalysisEvent {
  type: 'class_start' | 'class_done' | 'method_start' | 'method_done' | 'all_done' | 'error';
  index?: number; // 0 = Klasse, 1..N = Methode (1-basiert)
  total?: number; // Anzahl Methoden
  content?: any; // gerendertes HTML / Teil-Payload
  message?: string; // Fehlertext
}

// NestJS @Sse() erwartet ein Objekt mit `data`; alles weitere wird JSON-serialisiert.
interface SseMessage {
  data: AnalysisEvent;
}

type Job = () => Promise<void>;

// Einfache In-Memory-Queue mit EINEM sequentiellen Worker: Ollama wird nie parallel
// angefragt (Pi-Schutz). Fortschritt wird pro articleId ueber ein ReplaySubject gestreamt,
// damit ein (leicht) spaeter verbundener SSE-Client alle Events des Laufs nacherhaelt.
@Injectable()
export class AnalysisQueue {
  private streams = new Map<number, ReplaySubject<SseMessage>>();
  private jobs: Job[] = [];
  private processing = false;

  // Liefert das (ggf. neu erstellte) Subject fuer eine articleId.
  private subjectFor(articleId: number): ReplaySubject<SseMessage> {
    let s = this.streams.get(articleId);
    if (!s) {
      s = new ReplaySubject<SseMessage>(); // unbounded -> ein Lauf, vollstaendiger Replay
      this.streams.set(articleId, s);
    }
    return s;
  }

  // Vor einem neuen Lauf: altes Subject abschliessen und frisch ersetzen, damit keine
  // Events eines vorherigen Laufs nachgespielt werden. MUSS vor enqueue() laufen.
  resetStream(articleId: number): void {
    const old = this.streams.get(articleId);
    if (old) old.complete();
    this.streams.set(articleId, new ReplaySubject<SseMessage>());
  }

  // Observable fuer den SSE-Controller.
  getStream(articleId: number): Observable<SseMessage> {
    return this.subjectFor(articleId).asObservable();
  }

  // Ein Fortschrittsereignis an die Abonnenten der articleId senden.
  emit(articleId: number, event: AnalysisEvent): void {
    this.subjectFor(articleId).next({ data: event });
  }

  // Den Stream einer articleId abschliessen (nach all_done).
  complete(articleId: number): void {
    this.streams.get(articleId)?.complete();
  }

  // Jobs anhaengen und den Worker starten (falls nicht bereits laufend).
  enqueue(jobs: Job[]): void {
    this.jobs.push(...jobs);
    void this.process();
  }

  // Sequentielle Abarbeitung. Ein Fehler in einem Job bricht die Queue NICHT ab
  // (der Job emittiert sein eigenes 'error'-Event), der naechste Job laeuft weiter.
  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        try {
          await job();
        } catch {
          // Job-interne Fehler werden dort als 'error'-Event gemeldet; Queue laeuft weiter.
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
