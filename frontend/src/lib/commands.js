// Was man TUN kann – als Registry, so wie `lib/shortcuts.js` die Registry der Tastenkürzel ist.
//
// Strg+K konnte bisher nur FINDEN. Das ist die halbe Palette: die andere Hälfte ist „mach das",
// und die gab es in dieser Anwendung nirgends gebündelt – „New article" stand in der Sidebar,
// „Add code" in der Kopfzeile von /code, der Theme-Schalter ganz unten links, die Kantenberechnung
// in einer Werkzeuggruppe. Wer den Namen kennt, soll ihn tippen können, statt den Ort zu suchen.
//
// EINE Quelle für Anzeige und Verhalten: der Eintrag trägt sein `run()` selbst. Bei den Kürzeln
// geht das nicht (dort entscheidet die Ansicht, was `Ctrl+F` gerade trifft), hier schon – ein
// Befehl bedeutet überall dasselbe.
//
// ⚠️ Was NICHT hierher gehört: alles Zerstörende (Klasse löschen, alles zurücksetzen, Index
// leeren). Diese Eingriffe brauchen den Bestand, auf den sie sich beziehen, sichtbar daneben –
// ein Listeneintrag, den man mit ↵ auslöst, liefert diesen Zusammenhang nicht.
//
// ⚠️ Die Composables werden erst IM Aufruf geholt, nicht beim Import: das Modul wird von der
// Palette geladen, und ein Import darf keinen Zustand aufbauen.
import router from '../router.js'
import { WIKI_ICON } from '../config.js'
import { useTheme } from '../composables/useTheme.js'
import { useJavaAnalyzer } from '../composables/useJavaAnalyzer.js'
import { useJavaQueue } from '../composables/useJavaQueue.js'
import { useJavaGraph } from '../composables/useJavaGraph.js'
import { useInsights } from '../composables/useInsights.js'
import { useNotifications } from '../composables/useNotifications.js'

const goto = (path) => () => router.push(path)
const hasClasses = () => useJavaAnalyzer().files.value.length > 0

export const COMMANDS = [
  // --- Tun ---
  {
    id: 'new-article',
    label: 'New article',
    hint: 'opens the editor',
    icon: 'lucide:file-plus',
    keywords: ['create', 'write', 'wiki'],
    run: goto('/new'),
  },
  {
    id: 'add-code',
    label: 'Add code',
    hint: 'paste or upload .java files',
    icon: 'lucide:plus',
    keywords: ['import', 'upload', 'paste', 'java', 'analyze'],
    run: () => {
      // Derselbe Weg, den die Startseite nimmt: die Absicht wird gesetzt, `/code` schlägt das
      // Modal beim Mounten auf. Ein zweiter Mechanismus wäre eine zweite Fassung davon.
      useJavaAnalyzer().openAddCode.value = true
      router.push('/code')
    },
  },
  {
    id: 'toggle-theme',
    // Die Beschriftung sagt, was PASSIERT, nicht wie es gerade steht – ein Befehl ist ein Verb.
    label: () => (useTheme().isDark() ? 'Switch to light mode' : 'Switch to dark mode'),
    icon: () => (useTheme().isDark() ? 'lucide:sun' : 'lucide:moon'),
    hint: 'and it is remembered',
    keywords: ['dark', 'light', 'theme', 'appearance'],
    run: () => useTheme().toggle(),
  },
  {
    id: 'run-ai',
    label: 'Run AI on everything unanalyzed',
    hint: 'queues one unit per class — methods, then summary',
    icon: 'lucide:sparkles',
    keywords: ['analyze', 'ollama', 'summaries', 'queue'],
    available: hasClasses,
    run: async () => {
      const { notify } = useNotifications()
      const { enqueueAllUnanalyzed } = useJavaQueue()
      const { userContext } = useJavaAnalyzer()
      try {
        const res = await enqueueAllUnanalyzed({ userContext: userContext.value })
        const c = res?.queuedClasses ?? 0
        notify(c ? `Queued: ${c} class(es) for full analysis.` : 'Everything already analyzed – nothing to queue.')
      } catch (e) {
        notify(e.message, 'error')
      }
    },
  },
  {
    id: 'recompute-edges',
    label: 'Recompute relations',
    hint: 'reparses every class and rebuilds the graph',
    icon: 'lucide:refresh-cw',
    keywords: ['edges', 'graph', 'dependencies', 'rebuild'],
    available: hasClasses,
    run: async () => {
      const { notify } = useNotifications()
      try {
        const res = await useJavaGraph().recomputeEdges()
        // Zyklen, Kopplung und Instabilität hängen an den Kanten – was hier neu entsteht, macht
        // jede vorher gerechnete Kennzahl ungültig. Gleiche Regel wie in `CodeView`.
        useInsights().refreshIfLoaded()
        notify(`${res?.count ?? 0} edge(s) recomputed.`)
      } catch (e) {
        notify(e.message, 'error')
      }
    },
  },

  // --- Hingehen ---
  { id: 'go-code', label: 'Go to Code', icon: 'lucide:braces', keywords: ['java', 'classes', 'graph'], run: goto('/code') },
  { id: 'go-insights', label: 'Go to Insights', icon: 'lucide:activity', keywords: ['cycles', 'hotspots', 'rules', 'metrics'], run: goto('/insights') },
  { id: 'go-wiki', label: 'Go to Wiki', icon: 'lucide:book-open', keywords: ['articles', 'notes'], run: goto('/wiki') },
  { id: 'go-topic', label: 'Go to Topic bundles', icon: 'lucide:boxes', keywords: ['collect', 'copy', 'export'], run: goto('/topic') },
  { id: 'go-ask', label: 'Go to Ask', icon: 'lucide:help-circle', keywords: ['question', 'answer', 'rag'], run: goto('/ask') },
  { id: 'go-bot', label: 'Go to Bot settings', icon: 'lucide:bot', keywords: ['ollama', 'model', 'prompts', 'embeddings', 'settings'], run: goto('/bot') },
  { id: 'go-home', label: 'Go to the start page', icon: WIKI_ICON, keywords: ['start', 'landing'], run: goto('/') },
]

/** Ein Eintrag, dessen Beschriftung/Icon vom Zustand abhängt, wird hier aufgelöst. */
export function resolveCommand(cmd) {
  return {
    ...cmd,
    label: typeof cmd.label === 'function' ? cmd.label() : cmd.label,
    icon: typeof cmd.icon === 'function' ? cmd.icon() : cmd.icon,
  }
}

/**
 * Passende Befehle zu einer Eingabe. Leerer Begriff = alle verfügbaren (so sieht man im leeren
 * Feld, was es überhaupt gibt – die Palette ist auch ein Verzeichnis).
 *
 * Gesucht wird über Beschriftung UND Schlagwörter: „dark" soll den Theme-Schalter finden, obwohl
 * das Wort in seiner Beschriftung gerade nicht vorkommt.
 */
export function matchCommands(term) {
  const t = (term || '').trim().toLowerCase()
  return COMMANDS.filter((c) => !c.available || c.available())
    .map(resolveCommand)
    .filter((c) => !t || c.label.toLowerCase().includes(t) || c.keywords?.some((k) => k.includes(t)))
}
