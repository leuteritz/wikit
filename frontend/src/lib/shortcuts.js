// Tastenkuerzel: EINE Quelle fuer Anzeige und Verhalten.
//
// Die Liste unten ist keine Doku neben dem Code, sondern das, was Sidebar und Uebersicht rendern –
// und die Bezeichner (`id`) sind zugleich die Faelle, die die Handler abarbeiten. Ein Kuerzel, das
// hier fehlt, taucht nirgends auf; eins, das hier steht, aber niemand behandelt, faellt beim
// Durchgehen der Liste auf. Vorher lagen die Kuerzel in fuenf Komponenten verstreut und standen
// nirgends zusammen.
//
// `scope` entscheidet, wo es gilt (und wo es angezeigt wird):
//   'global' – ueberall · 'code' – Code-Ansicht · 'graph' – Graph · 'search' – Suchpalette/Felder

// ⌘ statt Ctrl auf dem Mac: eine falsche Taste in der Anzeige ist schlimmer als keine.
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

const MOD = IS_MAC ? '⌘' : 'Ctrl'

// Tastenfolge als Chips: 'mod+shift+f' -> ['Ctrl', 'Shift', 'F'].
export function keyChips(combo) {
  return combo
    .split('+')
    .map((part) => {
      const p = part.trim()
      if (p === 'mod') return MOD
      if (p === 'shift') return 'Shift'
      if (p === 'alt') return IS_MAC ? '⌥' : 'Alt'
      if (p === 'esc') return 'Esc'
      if (p === 'enter') return '↵'
      if (p === 'left') return '←'
      if (p === 'up') return '↑'
      if (p === 'down') return '↓'
      return p.length === 1 ? p.toUpperCase() : p
    })
}

export const SHORTCUTS = [
  // --- ueberall ---
  { id: 'search', keys: ['mod+k'], scope: 'global', label: 'Global search', hint: 'articles, classes, source code' },
  { id: 'help', keys: ['?'], scope: 'global', label: 'Keyboard shortcuts', hint: 'this list' },
  { id: 'goto-code', keys: ['g', 'c'], seq: true, scope: 'global', label: 'Go to Code', hint: 'press g, then c' },
  { id: 'goto-insights', keys: ['g', 'i'], seq: true, scope: 'global', label: 'Go to Insights', hint: 'press g, then i' },
  { id: 'goto-wiki', keys: ['g', 'w'], seq: true, scope: 'global', label: 'Go to Wiki', hint: 'press g, then w' },
  { id: 'goto-bot', keys: ['g', 'b'], seq: true, scope: 'global', label: 'Go to Bot', hint: 'press g, then b' },
  { id: 'close', keys: ['esc'], scope: 'global', label: 'Close / clear', hint: 'modal, panel or search field' },

  // --- Code-Ansicht ---
  { id: 'filter', keys: ['/'], scope: 'code', label: 'Search classes', hint: 'jumps into the search on the left' },
  {
    id: 'find',
    keys: ['mod+f'],
    scope: 'code',
    label: 'Find',
    // Die kontextabhaengige Regel steht als Text daneben – ein Kuerzel, das zwei Dinge tut, muss
    // sagen, wovon es abhaengt, sonst ist es zweimal geraten.
    hint: 'in the open relation, else the open class, else the search on the left',
  },
  { id: 'find-graph', keys: ['mod+shift+f'], scope: 'code', label: 'Jump to search', hint: 'the search on the left, whatever is open' },
  { id: 'step', keys: ['enter'], scope: 'code', label: 'Next match', hint: 'in the search — the graph moves to it, Shift+↵ goes back' },
  { id: 'wide', keys: ['alt+w'], scope: 'code', label: 'Wide code panel', hint: 'the detail column takes the graph’s width — press again to go back' },
  { id: 'analyze', keys: ['mod+enter'], scope: 'code', label: 'Run analysis', hint: 'inside “Add code”' },

  // --- Wiki ---
  { id: 'edit', keys: ['e'], scope: 'wiki', label: 'Edit this article', hint: 'while reading it' },
  { id: 'save-article', keys: ['mod+s'], scope: 'wiki', label: 'Save the article', hint: 'in the editor' },

  // --- Bot-Bereich ---
  { id: 'save', keys: ['mod+s'], scope: 'bot', label: 'Save settings', hint: 'writes only the changed fields' },
  { id: 'run-prompt', keys: ['mod+enter'], scope: 'bot', label: 'Run the prompt', hint: 'in the playground' },

  // --- Graph ---
  { id: 'fit', keys: ['0'], scope: 'graph', label: 'Fit graph to view' },
  { id: 'up', keys: ['alt+left'], scope: 'graph', label: 'One package level up' },

  // --- Suche ---
  { id: 'nav', keys: ['up', 'down'], scope: 'search', label: 'Move through results' },
  { id: 'open', keys: ['enter'], scope: 'search', label: 'Open the selected hit', hint: 'the search comes along' },
]

// Was in der Sidebar steht: die haeufigsten der aktuellen Ansicht. Mehr waere dort eine Liste, die
// niemand mehr liest – der Rest steht in der Uebersicht (`?`).
const SIDEBAR_IDS = {
  code: ['search', 'find', 'filter', 'fit', 'help'],
  // Im Bot-Bereich ist „speichern" das Kuerzel, das man dort tatsaechlich braucht – die
  // Navigationsfolgen stehen weiter in der Uebersicht.
  bot: ['save', 'run-prompt', 'search', 'goto-code', 'help'],
  wiki: ['edit', 'save-article', 'search', 'help'],
  default: ['search', 'goto-code', 'goto-wiki', 'help'],
}

// Seit die Fortschrittskarte einen FESTEN Platz darueber hat, teilen sich beide den unteren Teil
// der Spalte – vorher trat die eine an die Stelle der anderen. Drei Zeilen sind das, was daneben
// auf jeder Fensterhoehe sicher passt; `help` faellt dabei bewusst weg, weil die Kopfzeile der
// Liste ohnehin ins `?`-Overlay fuehrt und dessen Taste selbst traegt.
export const SIDEBAR_LIMIT = 3

// Wo ein Artikel im Spiel ist (lesen, bearbeiten, anlegen), gelten die Wiki-Kuerzel – auch unter
// `/new` und `/edit/…`, die nicht mit `/wiki` beginnen.
const WIKI_PATHS = ['/wiki', '/article/', '/edit/', '/new', '/tag/']

export function sidebarShortcuts(routePath, limit = SIDEBAR_LIMIT) {
  const ids = routePath.startsWith('/code')
    ? SIDEBAR_IDS.code
    : routePath.startsWith('/bot')
      ? SIDEBAR_IDS.bot
      : WIKI_PATHS.some((p) => routePath.startsWith(p))
        ? SIDEBAR_IDS.wiki
        : SIDEBAR_IDS.default
  return ids
    .map((id) => SHORTCUTS.find((s) => s.id === id))
    .filter(Boolean)
    .slice(0, limit)
}

export const SHORTCUT_GROUPS = [
  { scope: 'global', title: 'Everywhere' },
  { scope: 'code', title: 'Code view' },
  { scope: 'wiki', title: 'Wiki' },
  { scope: 'bot', title: 'Bot settings' },
  { scope: 'graph', title: 'Graph' },
  { scope: 'search', title: 'Search & result lists' },
]

// Tippt der Nutzer gerade? Dann gehoert die Taste ihm, nicht uns. Deckt Eingabefelder,
// contenteditable UND CodeMirror ab (dessen Editorflaeche ist ein contenteditable-Div, das ohne
// diesen Zweig jede Zifferntaste als Kuerzel verlieren wuerde).
export function isTypingTarget(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  return /^(input|textarea|select)$/i.test(el.tagName || '')
}
