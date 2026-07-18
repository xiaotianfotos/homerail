// 在文件顶部添加日志
// console.log('前端应用启动...');
// console.log('环境变量 VITE_LITE_MODE:', import.meta.env.VITE_LITE_MODE);
// console.log('window.LITE_MODE:', (window as any).LITE_MODE);

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import mitt from 'mitt'
import App from '@/App.vue'
import router from '@/router'
import { i18n } from '@/plugins/i18n'
import { applyInitialAppearance } from '@/appearance/appearance-registry'

import './styles/hr-theme.css'
import './styles/tailwind.css'
import './style.css'
import './styles/main.css'
import './styles/scrollbar.css'
import Toast from './components/controls/Toast.vue'
import '@vue-flow/core/dist/style.css';

// Apply the persisted appearance before Vue mounts so every component starts
// from the same semantic token set. index.html performs an even earlier
// pre-paint pass for the built-in appearances.
applyInitialAppearance()

const app = createApp(App)
const pinia = createPinia()

// 创建 mitt eventBus
const eventBus = mitt()

// 使用 provide 提供 eventBus
app.provide('eventBus', eventBus)

app.use(router)

app.use(pinia)
app.use(i18n)
app.component('Toast', Toast)

// 在应用挂载前添加

app.mount('#app')
