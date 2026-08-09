import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
  { path: '/wiki', name: 'wiki', component: () => import('./views/WikiView.vue') },
  { path: '/code', name: 'code', component: () => import('./views/CodeView.vue') },
  // Die Queue lebt jetzt im Code-View (Header-Anzeige + Modal). Alte Pfade leiten dorthin um.
  { path: '/code/queues', redirect: '/code' },
  { path: '/java', redirect: '/code' },
  { path: '/java/queues', redirect: '/code' },
  { path: '/insights', name: 'insights', component: () => import('./views/InsightsView.vue') },
  // Der Begriff steht in der URL, nicht nur im Feld: aus der Suchpalette kommt man mit einem
  // Thema hierher, und ein Link auf ein Buendel ohne sein Thema waere ein leeres Blatt.
  { path: '/topic', name: 'topic', component: () => import('./views/TopicView.vue') },
  // Wie bei /topic steht die Frage in der URL: eine Frage samt ihrer Antwort ist etwas, das man
  // verlinkt – und ohne sie waere der Link ein leeres Feld.
  { path: '/ask', name: 'ask', component: () => import('./views/AskView.vue') },
  { path: '/bot', name: 'bot', component: () => import('./views/BotView.vue') },
  { path: '/new', name: 'new', component: () => import('./views/ArticleEdit.vue') },
  { path: '/edit/:slug', name: 'edit', component: () => import('./views/ArticleEdit.vue'), props: true },
  { path: '/article/:slug', name: 'article', component: () => import('./views/ArticleDetail.vue'), props: true },
  // Eigene Route statt eines Modus in der Artikelansicht: ein Stand von damals ist etwas, das man
  // verlinkt („so stand es vor dem Umbau"), und die zwei Spalten des Vergleichs brauchen die
  // Breite, die der Artikeltext bewusst nicht nutzt. Die verglichenen Fassungen stehen deshalb in
  // der URL – gleiche Überlegung wie bei /topic und /ask.
  { path: '/article/:slug/history', name: 'article-history', component: () => import('./views/ArticleHistory.vue'), props: true },
]

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  },
})
