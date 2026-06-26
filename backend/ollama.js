// Lokaler KI-Client gegen Ollama (kostenlos, kein API-Key, Raspberry-Pi-tauglich).
// Bewusst async + mit hartem Timeout: ist Ollama nicht erreichbar, faellt der Aufrufer
// sauber auf Javadoc/leeren String zurueck statt zu blockieren.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi3:mini'
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000)

// Baut eine knappe Methoden-Signatur fuer den Prompt-Kontext.
function signature(className, method) {
  const params = (method.parameters || []).map(p => `${p.type} ${p.name}`.trim()).join(', ')
  return `${method.return_type || 'void'} ${className}.${method.method_name}(${params})`
}

// Erzeugt eine kurze Wiki-Zusammenfassung (max. 3 Saetze) fuer eine Methode.
// Liefert '' wenn Ollama nicht erreichbar ist oder ein Fehler/Timeout auftritt.
export async function generateSummary({ className, method }) {
  const sig = signature(className, method)
  const javadoc = method.javadoc ? `\nVorhandener Javadoc:\n${method.javadoc}` : ''
  const prompt =
    `Du dokumentierst Java-Code fuer ein Wiki. Beschreibe die folgende Methode in maximal ` +
    `drei kurzen Saetzen: was sie tut, die Bedeutung der Parameter und moegliche Ausnahmen. ` +
    `Antworte nur mit der Beschreibung, ohne Code.\n\nSignatur:\n${sig}${javadoc}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    })
    if (!res.ok) return ''
    const data = await res.json()
    return (data.response || '').trim()
  } catch {
    // Ollama nicht erreichbar / Timeout / abgebrochen -> Fallback beim Aufrufer.
    return ''
  } finally {
    clearTimeout(timer)
  }
}
