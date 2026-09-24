/**
 * 主题:深色 / 浅色。
 *
 * 主题落成 `<html data-theme>` 属性,CSS 里的两套令牌见 styles.css。
 * 组件只读这里的 `theme`,不要自己去动那个属性 —— 换个地方写就等于多了一个决定者。
 *
 * 不做成 App 的 props 往下传:主题作用在 `<html>` 上而不是组件树上,
 * 走一遍 props 只是把同一份全局状态摆个形式。UpdatePrompt 直接调 api 也是这个路子。
 *
 * 没手动选过时**跟随系统**,而且是持续跟随(系统到点自动切深色,界面跟着变)。
 * 用户点过一次开关之后固定下来,不再被系统覆盖 —— 手动选择永远优先于系统偏好。
 */
import { ref, type Ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'bigimgpin.theme'

/** 当前主题。除 initTheme/toggleTheme 外只读。 */
export const theme: Ref<Theme> = ref('dark')

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 用户手动选过的主题。没选过返回 null —— 和「选了深色」是两回事。 */
function chosenTheme(): Theme | null {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : null
}

/**
 * 把窗口标题栏也切成对应主题。
 *
 * 标题栏是系统画的,和网页内容没有关系,不通知它一声的话:浅色系统上开深色界面,
 * 顶上会顶着一根白条。
 *
 * dev:web 里没有 Tauri 运行时,取窗口会抛 —— 浏览器里标题栏本来就归浏览器管,
 * 静默跳过即可。
 */
function syncWindowChrome(next: Theme) {
  if (!('__TAURI_INTERNALS__' in window)) return
  void getCurrentWindow()
    .setTheme(next)
    .catch((error) => console.error('[theme] 切换窗口主题失败:', error))
}

function apply(next: Theme) {
  theme.value = next
  document.documentElement.dataset.theme = next
  syncWindowChrome(next)
}

/** 在挂载前调用一次。挂载后再设属性会让第一帧拿默认色画一遍再跳成另一套。 */
export function initTheme() {
  apply(chosenTheme() ?? systemTheme())

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    if (chosenTheme()) return
    apply(event.matches ? 'light' : 'dark')
  })
}

export function toggleTheme() {
  const next: Theme = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem(STORAGE_KEY, next)
  apply(next)
}
