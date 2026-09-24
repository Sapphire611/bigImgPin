import { createApp } from 'vue'

import App from './App.vue'
import './styles.css'
import { initTheme } from './theme'

// 必须早于 mount:主题属性和首帧一起落地,否则会先用默认色画一遍再跳成另一套
initTheme()

createApp(App).mount('#app')
