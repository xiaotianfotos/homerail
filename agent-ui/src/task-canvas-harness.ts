import { createApp } from 'vue'
import { i18n } from '@/plugins/i18n'
import DagTaskCanvas from '@/components/generative-ui/DagTaskCanvas.vue'
import './styles/hr-theme.css'
import './styles/tailwind.css'
import './style.css'
import './styles/main.css'
import './styles/scrollbar.css'

const runId = new URLSearchParams(window.location.search).get('run_id')?.trim() || 'run:visual'

const app = createApp(DagTaskCanvas, {
  runId,
  pollIntervalMs: 300,
  embedded: true,
})
app.use(i18n)
app.mount('#app')
