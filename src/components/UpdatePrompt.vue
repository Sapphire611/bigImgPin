<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import * as api from '../api/tauri'

/**
 * 静默更新。
 *
 * 启动后在后台检查并下载,全程不弹任何东西;包就绪了才弹窗。用户点「立即重启」后
 * 安装器以 /S 静默覆盖,装完自己把新版拉起来(见 Tauri NSIS 模板的 .onInstSuccess:
 * 静默/被动模式带 /R 才会重启应用),用户看不到也碰不到安装程序。
 *
 * 拆成「先下载、后安装」两步而不是用 downloadAndInstall:安装会直接杀掉当前进程,
 * 必须等用户点头,不能下完就装。
 *
 * dev 下只检查、不下载安装 —— 跑的是 target/debug 里的 exe,
 * 装下去会把正在调试的产物换掉。
 */
const canInstall = import.meta.env.PROD

type Phase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing'

const phase = ref<Phase>('idle')
const available = ref<api.AvailableUpdate | null>(null)
const percent = ref<number | null>(null)
const toast = ref('')
/** 安装失败的原因。要显示在弹窗里 —— toast 在工具栏上,会被遮罩盖住看不见 */
const installError = ref('')

let bootTimer: number | undefined
let toastTimer: number | undefined

const label = computed(() => {
  switch (phase.value) {
    case 'checking':
      return '检查中…'
    case 'downloading':
      return percent.value === null ? '下载中…' : `下载 ${percent.value}%`
    case 'installing':
      return '正在重启…'
    default:
      return '检查更新'
  }
})

onMounted(() => {
  // 错开启动时的几件重活(vips 自检、可能的首图切片),别抢 IO
  if (canInstall) bootTimer = window.setTimeout(() => void look(true), 3000)
})

onBeforeUnmount(() => {
  window.clearTimeout(bootTimer)
  window.clearTimeout(toastTimer)
})

function flash(text: string) {
  toast.value = text
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 5000)
}

/**
 * silent 表示启动时那次静默检查 —— 没更新、出错了都不出声。
 * 手动点的那次必须给回音,否则按钮看起来像坏的。
 */
async function look(silent: boolean) {
  if (phase.value !== 'idle') return
  phase.value = 'checking'
  try {
    const found = await api.checkForUpdate()
    if (!found) {
      phase.value = 'idle'
      if (!silent) flash('已是最新版')
      return
    }

    available.value = found
    if (!canInstall) {
      // 只把弹窗亮出来看样式,不下载也不安装
      phase.value = 'ready'
      return
    }

    phase.value = 'downloading'
    await found.download((value) => {
      percent.value = value
    })
    percent.value = 100
    phase.value = 'ready'
  } catch (error) {
    phase.value = 'idle'
    // 静默失败也得留痕,不然「为什么一直不更新」无从查起
    console.error('[updater] 检查更新失败:', error)
    if (!silent) flash(`检查更新失败:${String(error)}`)
  }
}

function onClick() {
  // 已经下好、只是被「稍后」收起来了 —— 再点应该是把它调出来,不是重下一遍
  if (available.value) {
    phase.value = 'ready'
    return
  }
  void look(false)
}

async function install() {
  if (!available.value) return
  phase.value = 'installing'
  installError.value = ''
  try {
    // Windows 上这个调用会结束当前进程,安装器随后自动拉起新版。
    // 正常情况下下面的代码不会执行到。
    await available.value.install()
  } catch (error) {
    phase.value = 'ready'
    console.error('[updater] 安装失败:', error)
    installError.value = String(error)
  }
}

function dismiss() {
  phase.value = 'idle'
  installError.value = ''
}
</script>

<template>
  <div class="updater">
    <span v-if="toast" class="toast" :title="toast">{{ toast }}</span>

    <button
      :disabled="phase !== 'idle'"
      title="检查新版本。有更新会在后台静默下载,下载完再提示重启"
      @click="onClick"
    >
      {{ label }}
    </button>

    <!-- 就绪了才出现。fixed 盖住整个窗口,不受工具栏高度限制 -->
    <div v-if="available && (phase === 'ready' || phase === 'installing')" class="mask">
      <div class="dialog">
        <h3>
          {{ canInstall ? `新版本 v${available.version} 已下载` : `发现新版本 v${available.version}` }}
        </h3>
        <p class="hint">
          <template v-if="canInstall">
            点「立即重启」即可生效:程序会自己关掉、装好、再打开,
            不需要手动运行安装包。
          </template>
          <template v-else>开发模式下只做检查,不下载也不安装。</template>
        </p>
        <pre v-if="available.notes" class="notes">{{ available.notes }}</pre>
        <p v-if="installError" class="failed">安装失败:{{ installError }}</p>
        <div class="actions">
          <button :disabled="phase === 'installing'" @click="dismiss">
            {{ canInstall ? '稍后' : '关闭' }}
          </button>
          <button
            v-if="canInstall"
            class="solid"
            :disabled="phase === 'installing'"
            @click="install"
          >
            {{ phase === 'installing' ? '正在重启…' : '立即重启' }}
          </button>
        </div>
        <p class="dim">当前版本 v{{ available.currentVersion }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.updater {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 位置交给工具栏 —— 它把自己推到最右边的那个按钮身上(见 ToolBar 的 .theme)。
     这里再加一个 margin-left:auto 会和那个平分空隙,把主题开关甩到中间去 */
}

.toast {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
}

.dialog {
  width: 460px;
  max-width: calc(100vw - 48px);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  padding: 22px 26px;
  box-shadow: var(--shadow);
}

.dialog h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
}

.notes {
  margin: 0 0 14px;
  padding: 10px 12px;
  max-height: 200px;
  overflow: auto;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.failed {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--danger-text);
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  border-radius: var(--r-md);
  padding: 8px 12px;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.dim {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
