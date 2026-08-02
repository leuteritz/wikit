// Arbeitsstand der Code-Ansicht (/code) ueber den Reload hinweg.
//
// Warum EIN Modul und nicht zwei localStorage-Zugriffe: der Stand ist EINE Sache – „wo stehe ich
// gerade?" –, liegt aber notwendig in zwei Komponenten. Der Klassenfilter, die geoeffnete Klasse
// und die Baumfaltung gehoeren `CodeView`; die Ebene, die Kontextstufe und die Suche im Bild
// gehoeren dem Graphen, weil nur er sie ueberhaupt kennt. Zwei Schluessel waeren zwei Orte, an
// denen man beim Zuruecksetzen (Komplett-Reset) daran denken muesste – einer wird dann vergessen.
//
// Gelesen wird der LEBENDE Stand, nicht eine beim Seitenstart eingefrorene Kopie: `/code` wird bei
// jedem Ansichtswechsel neu gemountet und muss dann den Stand von vorhin vorfinden, nicht den vom
// Laden der Seite.
//
// Geschrieben wird verzoegert: Filter und Faltung aendern sich im Takt von Tastendruecken, und
// JSON.stringify + localStorage sind synchron – an genau dem Tastendruck haengt sonst wieder der
// halbe Bildschirm (s. SEARCH_DEBOUNCE_MS in CodeView).
const KEY = 'wikit:code-state:v1'
const WRITE_DELAY_MS = 300

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    // Kaputter/blockierter localStorage -> die Ansicht startet wie beim ersten Besuch.
    return {}
  }
}

let state = read()
let timer = null

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* Quota/Privatmodus: der Stand geht verloren, die Ansicht laeuft weiter */
  }
}

// Der gemerkte Stand. Nur lesen – geschrieben wird ausschliesslich ueber `patchCodeState`.
export function codeState() {
  return state
}

// Teil-Update: jeder Schreiber kennt nur seine eigenen Schluessel und darf die des anderen nicht
// mitloeschen.
export function patchCodeState(partial) {
  state = { ...state, ...partial }
  clearTimeout(timer)
  timer = setTimeout(write, WRITE_DELAY_MS)
}

// Komplett-Reset: es gibt keine Klassen mehr, also auch keinen Ort, an dem man stehen koennte.
export function clearCodeState() {
  state = {}
  clearTimeout(timer)
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
