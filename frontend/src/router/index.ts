import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import LoginView from '../views/LoginView.vue'
import MailView from '../views/MailView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/', name: 'mail', component: MailView }
  ]
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.checked) await auth.checkStatus()
  if (to.path === '/login') {
    if (auth.loggedIn) return '/'
    return true
  }
  if (!auth.loggedIn) return '/login'
  return true
})

export default router
