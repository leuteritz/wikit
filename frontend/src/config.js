// Anzeigename des Wikis. Pro Instanz via .env (VITE_WIKI_TITLE) anpassbar.
// Siehe .env.example im Projekt-Root.
export const WIKI_TITLE = import.meta.env.VITE_WIKI_TITLE || 'Wikit'

// Brand-Icon (Iconify, offline gebuendelt via lib/icons.js). Gewaehlt: ph:books-duotone –
// ein Buecherstapel als Sinnbild fuer eine persoenliche Wissenssammlung; der Duotone-Stil
// passt zur warmen Zwei-Ton-Palette (Akzent + weiche Flaeche). Aenderung des Icons hier
// genuegt – muss dann in lib/icons.js registriert sein.
export const WIKI_ICON = 'ph:books-duotone'

// App-Version, zur Build-Zeit aus der Root-package.json injiziert (vite `define` ->
// globales __APP_VERSION__, s. vite.config.js). Anzeige als MAJOR.MINOR (z. B. "2.0").
// Schema/Bump-Regeln siehe README ("Versionierung"). Nie hardcoden - immer hierueber.
const _versionParts = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0').split('.')
export const WIKI_VERSION =
  _versionParts.length >= 2 ? `${_versionParts[0]}.${_versionParts[1]}` : _versionParts.join('.')
