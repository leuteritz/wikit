// Was sich zwei Bedeutungsindizes teilen muessen, damit ihre Treffer vergleichbar bleiben.
//
// Seit `/ask` neben den Klassen auch die Wiki-Artikel liest, gibt es zwei Indizes
// (`java_embeddings`, `article_embeddings`) und EINE gemischte Rangliste darueber. Genau deshalb
// steht das hier und nicht zweimal in den beiden Services: Praefix-Regel, Normalisierung und
// Schnitt sind keine Implementierungsdetails der jeweiligen Seite, sondern die Bedingung, unter
// der ein Score links dasselbe bedeutet wie ein Score rechts.
//
// ⚠️ Wer hier etwas aendert, aendert es fuer BEIDE Indizes -- und macht damit jeden gespeicherten
// Vektor ungueltig, dessen `source_hash` sich dadurch verschiebt. Das ist gewollt: ein Lauf, der
// den Text anders zusammensetzt, gehoert nicht in denselben Raum wie der vorige.
import type { OllamaService } from './ollama.service';

// Wie viele Texte in EINER Ollama-Anfrage eingebettet werden. Ein Stapel spart den Roundtrip, aber
// ein zu grosser laesst den Server bei einem Fehler von vorn anfangen -- und auf einem Pi kostet er
// spuerbar Speicher.
export const EMBED_BATCH = 16;

// ⚠️ Der Schnitt ist RELATIV zum besten Treffer, nicht absolut. Eine feste Schwelle waere eine Zahl
// ueber ein Modell, das der Betreiber jederzeit wechseln kann: derselbe Abstand bedeutet bei
// nomic-embed-text etwas anderes als bei mxbai oder bge. „Deutlich schlechter als der beste" ist
// dagegen in jedem Vektorraum dieselbe Aussage.
export const RELATIVE_CUTOFF = 0.75;

// Absolute Untergrenze nur als Notbremse: darunter hat das Modell nichts verstanden, und der beste
// Treffer waere eine geratene Auskunft mit Rangfolge.
export const FLOOR_SCORE = 0.15;

// ⚠️ nomic-embed-text ist auf PRAEFIXE trainiert: derselbe Text ergibt als `search_document:` und
// als `search_query:` verschiedene Vektoren, und ohne die Praefixe verliert das Modell messbar an
// Trennschaerfe. Das ist modellspezifisch und deshalb an den Modellnamen gebunden -- jedes andere
// Modell bekommt seinen Text unveraendert.
export const usesNomicPrefix = (model: string): boolean => /^nomic-embed/i.test(model || '');

/** Text, wie er in den INDEX geht. */
export const documentText = (model: string, text: string): string =>
  usesNomicPrefix(model) ? `search_document: ${text}` : text;

/** Text, wie er als FRAGE gestellt wird. */
export const queryText = (model: string, text: string): string =>
  usesNomicPrefix(model) ? `search_query: ${text}` : text;

/**
 * Vektor auf Laenge 1 bringen -- danach ist das Skalarprodukt bereits die Kosinus-Aehnlichkeit.
 *
 * Ein Nullvektor (Modell hat nichts geliefert) bleibt einer: durch 0 zu teilen ergaebe NaN, und ein
 * NaN im Index vergiftet jeden spaeteren Vergleich lautlos.
 */
export function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let sum = 0;
  for (const v of vec) sum += v * v;
  const len = Math.sqrt(sum);
  if (!len) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / len;
  return out;
}

/** Gespeichertes BLOB als Vektor lesen -- ohne Kopie, der Buffer bleibt der Speicher. */
export function toVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Kosinus-Aehnlichkeit zweier bereits normalisierter Vektoren.
 *
 * Verschiedene Laengen heissen „aus verschiedenen Modellen" (ein Wechsel mitten im Bestand) -- die
 * Zahl waere dann bedeutungslos, also gibt es keine.
 */
export function similarity(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Die Frage einbetten. `null` heisst „Ollama hat nicht geantwortet" -- kein Fehler, sondern eine
 * leere Antwort mit Grund (s. die Aufrufer).
 */
export async function embedQuery(
  ollama: OllamaService,
  model: string,
  question: string,
): Promise<Float32Array | null> {
  const { vectors } = await ollama.embed([queryText(model, question)]);
  const [vec] = vectors;
  return vec ? normalize(vec) : null;
}

/**
 * Der relative Schnitt ueber eine bereits sortierte Trefferliste.
 *
 * ⚠️ Er gehoert ueber die GEMISCHTE Liste, nicht je Quelle: zweimal „0,75 vom jeweils besten" waeren
 * zwei verschiedene Latten, und ein mittelmaessiger Artikel stuende dann neben einer sehr guten
 * Klasse, nur weil er der beste seiner Sorte war.
 */
export function applyCutoff<T extends { score: number }>(sorted: T[], limit: number): T[] {
  const best = sorted[0]?.score ?? 0;
  return sorted.filter((s) => s.score >= best * RELATIVE_CUTOFF).slice(0, Math.max(1, limit));
}
