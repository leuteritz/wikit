// Anzeigename des Wikis. Pro Instanz via .env (VITE_WIKI_TITLE) anpassbar.
// Siehe .env.example im Projekt-Root.
export const WIKI_TITLE = import.meta.env.VITE_WIKI_TITLE || 'Wikit'

// Brand-Icon (Iconify, offline gebuendelt via lib/icons.js). Gewaehlt: ph:books-duotone –
// ein Buecherstapel als Sinnbild fuer eine persoenliche Wissenssammlung; der Duotone-Stil
// passt zur warmen Zwei-Ton-Palette (Akzent + weiche Flaeche). Aenderung des Icons hier
// genuegt – muss dann in lib/icons.js registriert sein.
export const WIKI_ICON = 'ph:books-duotone'
