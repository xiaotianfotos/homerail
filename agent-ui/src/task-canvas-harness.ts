import { createApp } from 'vue'
import { i18n } from '@/plugins/i18n'
import DagTaskCanvas from '@/components/generative-ui/DagTaskCanvas.vue'
import './styles/tailwind.css'
import './style.css'
import './styles/main.css'
import './styles/scrollbar.css'

const app = createApp(DagTaskCanvas, {
  runId: 'run:visual',
  pollIntervalMs: 300,
  embedded: true,
})
app.use(i18n)
app.mount('#app')
