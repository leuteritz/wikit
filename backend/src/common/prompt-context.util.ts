// Baut den Prompt-Kontext fuer die KI-Generierung: Nutzer-/Projektkontext (z. B. Windchill) plus
// das aus dem java_fts-Index gezogene Wissen frueherer Analysen (RAG).
//
// Wird von BEIDEN Analyse-Pfaden verwendet (analysis/analysis.service.ts fuer den artikelgebundenen
// SSE-Lauf und java/java-queue.service.ts fuer die Hintergrund-Queue) - vorher lag der identische
// Block zweimal im Code. Die FTS-Abfrage selbst bleibt beim jeweiligen Aufrufer, weil sich nur dort
// entscheidet, welche Query-Terme (Abhaengigkeiten, Methodennamen) sinnvoll sind.
export function buildPromptContext(userContext: string | undefined, known: string[]): string {
  const parts: string[] = [];
  const uc = (userContext || '').trim();
  if (uc) parts.push(uc);
  if (known.length) {
    parts.push('Bekanntes Wissen aus frueheren Analysen:\n' + known.map((k) => `- ${k}`).join('\n'));
  }
  return parts.join('\n\n');
}
