import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import { WIKI_TITLE } from './config.js'
import './assets/style.css'
import './composables/useTheme.js' // initialisiert das Theme beim Laden

document.title = WIKI_TITLE

createApp(App).use(router).mount('#app')
