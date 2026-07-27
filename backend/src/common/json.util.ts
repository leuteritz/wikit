// Toleranter JSON-Parser fuer DB-Spalten, die JSON als TEXT halten (java_methods.parameters,
// java_methods.modifiers, articles.toc). Bewusst eine freie Funktion statt einer Service-Methode:
// es gibt keinen Zustand und keine Abhaengigkeit -> kein DI-Overhead, aus jedem Service/Controller
// direkt importierbar. Ersetzt die frueher in fuenf Klassen kopierte private `safeJson`.
export function safeJson<T>(str: unknown, fallback: T): T {
  try {
    return JSON.parse(str as string) as T;
  } catch {
    return fallback;
  }
}
