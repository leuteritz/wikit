import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import { WIKI_TITLE } from './config.js'
// IBM Plex offline (kein Google-Fonts-CDN – Wikit laeuft fully local, s. CLAUDE.md).
// Nur die tatsaechlich genutzten Schnitte bundlen (self-hosted woff2 via @fontsource).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './assets/style.css'
import './composables/useTheme.js' // initialisiert das Theme beim Laden
import './lib/icons.js' // registriert alle Iconify-Icons OFFLINE (kein Laufzeit-Fetch)
import { vTip } from './lib/tooltip.js'

document.title = WIKI_TITLE

// `v-tip` global: der erklaerende Hinweis gehoert zu Bedienelementen in jeder Ansicht, nicht zu
// einer Komponente (s. lib/tooltip.js – ein gemeinsames Element am body).
createApp(App).use(router).directive('tip', vTip).mount('#app')
