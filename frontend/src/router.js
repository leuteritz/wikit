import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
  { path: '/wiki', name: 'wiki', component: () => import('./views/WikiView.vue') },
  { path: '/code', name: 'code', component: () => import('./views/CodeView.vue') },
  // Die Queue lebt jetzt im Code-View (Header-Anzeige + Modal). Alte Pfade leiten dorthin um.
  { path: '/code/queues', redirect: '/code' },
  { path: '/java', redirect: '/code' },
  { path: '/java/queues', redirect: '/code' },
  { path: '/new', name: 'new', component: () => import('./views/ArticleEdit.vue') },
  { path: '/edit/:slug', name: 'edit', component: () => import('./views/ArticleEdit.vue'), props: true },
  { path: '/article/:slug', name: 'article', component: () => import('./views/ArticleDetail.vue'), props: true },
]

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  },
})
