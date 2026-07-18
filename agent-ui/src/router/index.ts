/// <reference types="vite/client" />

import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Agent UI — full-screen, no layout chrome
    {
      path: '/',
      name: 'agent',
      component: () => import('@/views/agent/index.vue')
    },
    {
      path: '/agent',
      name: 'agent-path',
      component: () => import('@/views/agent/index.vue')
    },
    {
      path: '/agent/experience',
      name: 'agent-experience-graph',
      component: () => import('@/views/agent/ExperienceGraphExplorer.vue')
    },
    {
      path: '/dag/run/:runId',
      name: 'DAGRun',
      redirect: route => {
        const runId = route.params.runId as string
        if (route.query.capture === '1') {
          return {
            path: '/agent',
            query: { captureRun: runId },
          }
        }
        return {
          path: '/agent',
          query: {
            runId,
            tab: 'topology',
          },
        }
      },
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/agent',
    },
  ]
})

export default router
  ;
