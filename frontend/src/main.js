import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import { WIKI_TITLE } from './config.js'
import './assets/style.css'
import './composables/useTheme.js' // initialisiert das Theme beim Laden
import './lib/icons.js' // registriert alle Iconify-Icons OFFLINE (kein Laufzeit-Fetch)

document.title = WIKI_TITLE

createApp(App).use(router).mount('#app')
