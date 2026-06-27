import { Injectable } from '@nestjs/common';
import { merge, Observable, ReplaySubject, Subject } from 'rxjs';

// Fortschrittsereignis, das per SSE an das Frontend gestreamt wird.
export interface AnalysisEvent {
  type:
    | 'class_start'
    | 'class_done'
    | 'method_start'
    | 'method_done'
    | 'all_done'
    | 'error'
    | 'heartbeat'
    | 'cancelled';
  index?: number; // 0 = Klasse, 1..N = Methode (1-basiert)
  total?: number; // Anzahl Methoden
  content?: any; // gerendertes HTML / Teil-Payload
  message?: string; // Fehlertext
  elapsedMs?: number; // heartbeat: server-gemessene Laufzeit des aktuellen Schritts
  aiGenerated?: boolean; // class_done/method_done: true = echter KI-Text, false = Fallback
}

// NestJS @Sse() erwartet ein Objekt mit `data`; alles weitere wird JSON-serialisiert.
interface SseMessage {
  data: AnalysisEvent;
}

// Ein Job traegt seine articleId, damit Cancel/Skip pro Artikel funktioniert, obwohl die
// Queue global (Singleton) ist. `run` bekommt ein AbortSignal, um den in-flight Ollama-Call
// abbrechen zu koennen.
type Job = { articleId: number; run: (signal: AbortSignal) => Promise<void> };

// Einfache In-Memory-Queue mit EINEM sequentiellen Worker: Ollama wird nie parallel
// angefragt (Pi-Schutz). Fortschritt wird pro articleId gestreamt: Meilensteine ueber ein
// ReplaySubject (vollstaendiger Replay fuer spaet verbundene Clients), Heartbeats ueber ein
// separates, NICHT gepuffertes Subject (sonst Replay-Flut bei Reconnect).
@Injectable()
export class AnalysisQueue {
  private streams = new Map<number, ReplaySubject<SseMessage>>();
  private heartbeats = new Map<number, Subject<SseMessage>>();
  private jobs: Job[] = [];
  private processing = false;
  private cancelled = new Set<number>();
  private inflight = new Map<number, AbortController>();

  // Liefert das (ggf. neu erstellte) Meilenstein-Subject fuer eine articleId.
  private subjectFor(articleId: number): ReplaySubject<SseMessage> {
    let s = this.streams.get(articleId);
    if (!s) {
      s = new ReplaySubject<SseMessage>(); // unbounded -> ein Lauf, vollstaendiger Replay
      this.streams.set(articleId, s);
    }
    return s;
  }

  // Liefert das (ggf. neu erstellte) ephemere Heartbeat-Subject fuer eine articleId.
  private heartbeatSubjectFor(articleId: number): Subject<SseMessage> {
    let s = this.heartbeats.get(articleId);
    if (!s) {
      s = new Subject<SseMessage>(); // nicht gepuffert -> kein Replay alter Heartbeats
      this.heartbeats.set(articleId, s);
    }
    return s;
  }

  // Vor einem neuen Lauf: alte Subjects abschliessen und frisch ersetzen, damit keine
  // Events eines vorherigen Laufs nachgespielt werden. MUSS vor enqueue() laufen.
  // Loescht zudem Cancel-Flag/in-flight-Controller, damit eine wiederverwendete articleId
  // keinen vererbten Cancel erbt.
  resetStream(articleId: number): void {
    const old = this.streams.get(articleId);
    if (old) old.complete();
    this.streams.set(articleId, new ReplaySubject<SseMessage>());
    const oldHb = this.heartbeats.get(articleId);
    if (oldHb) oldHb.complete();
    this.heartbeats.set(articleId, new Subject<SseMessage>());
    this.cancelled.delete(articleId);
    this.inflight.delete(articleId);
  }

  // Observable fuer den SSE-Controller: Meilensteine + Heartbeats gemerged.
  getStream(articleId: number): Observable<SseMessage> {
    return merge(this.subjectFor(articleId).asObservable(), this.heartbeatSubjectFor(articleId).asObservable());
  }

  // Ein Meilenstein-Ereignis an die Abonnenten der articleId senden (gepuffert/replayed).
  emit(articleId: number, event: AnalysisEvent): void {
    this.subjectFor(articleId).next({ data: event });
  }

  // Ein Lebenszeichen senden (ephemer, nicht gepuffert).
  emitHeartbeat(articleId: number, event: AnalysisEvent): void {
    this.heartbeatSubjectFor(articleId).next({ data: event });
  }

  // Den Stream einer articleId abschliessen (nach all_done / cancelled).
  complete(articleId: number): void {
    this.streams.get(articleId)?.complete();
    this.heartbeats.get(articleId)?.complete();
  }

  // Bricht einen laufenden/eingereihten Lauf einer articleId ab: in-flight Ollama-Call
  // abbrechen, noch ausstehende Jobs (inkl. all_done-Finalizer) verwerfen, Client informieren.
  cancel(articleId: number): void {
    this.cancelled.add(articleId);
    this.inflight.get(articleId)?.abort();
    this.jobs = this.jobs.filter((j) => j.articleId !== articleId);
    this.emit(articleId, { type: 'cancelled' });
    this.complete(articleId);
  }

  // Jobs anhaengen und den Worker starten (falls nicht bereits laufend).
  enqueue(articleId: number, runs: Array<(signal: AbortSignal) => Promise<void>>): void {
    this.jobs.push(...runs.map((run) => ({ articleId, run })));
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
        if (this.cancelled.has(job.articleId)) continue; // zwischenzeitlich abgebrochen
        const ac = new AbortController();
        this.inflight.set(job.articleId, ac);
        try {
          await job.run(ac.signal);
        } catch {
          // Job-interne Fehler werden dort als 'error'-Event gemeldet; Queue laeuft weiter.
        } finally {
          this.inflight.delete(job.articleId);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
