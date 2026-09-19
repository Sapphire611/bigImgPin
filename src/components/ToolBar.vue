<script setup lang="ts">
import type { ToolMode } from '../types'

defineProps<{
  mode: ToolMode
  gridEnabled: boolean
  hasImage: boolean
  /** 图像就绪前,缩放类按钮都要禁用 */
  ready: boolean
}>()

const emit = defineEmits<{
  open: []
  'update:mode': [ToolMode]
  'update:gridEnabled': [boolean]
  zoomToFit: []
  zoomToOne: []
}>()
</script>

<template>
  <div class="toolbar">
    <button class="primary" :disabled="!ready" @click="emit('open')">打开图片</button>

    <span class="divider" />

    <div class="group" role="group" aria-label="工具模式">
      <button
        :class="{ active: mode === 'pan' }"
        :disabled="!hasImage"
        title="拖动模式:按住拖动平移画面,滚轮缩放"
        @click="emit('update:mode', 'pan')"
      >
        ✋ 拖动
      </button>
      <button
        :class="{ active: mode === 'draw' }"
        :disabled="!hasImage"
        title="鼠标模式:拖拽画框,点击可选中已有框"
        @click="emit('update:mode', 'draw')"
      >
        ✛ 画框
      </button>
    </div>

    <span class="divider" />

    <button
      :class="{ active: gridEnabled }"
      :disabled="!hasImage"
      title="显示/隐藏网格"
      @click="emit('update:gridEnabled', !gridEnabled)"
    >
      网格
    </button>

    <span class="divider" />

    <button :disabled="!hasImage" title="缩放到适应窗口" @click="emit('zoomToFit')">
      适应窗口
    </button>
    <button :disabled="!hasImage" title="缩放到 100%(图像 1 像素 = 屏幕 1 像素)" @click="emit('zoomToOne')">
      1:1
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #23262b;
  border-bottom: 1px solid #33383f;
  flex-shrink: 0;
}

.group {
  display: flex;
}

.group button:first-child {
  border-radius: 6px 0 0 6px;
}

.group button:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}

button {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #3d434b;
  background: #2b2f36;
  color: #d6dae0;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

button:hover:not(:disabled) {
  background: #353a43;
}

button.active {
  background: #2f5d9e;
  border-color: #3f78c4;
  color: #fff;
}

button.primary {
  background: #2f5d9e;
  border-color: #3f78c4;
  color: #fff;
}

button.primary:hover:not(:disabled) {
  background: #376bb4;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.divider {
  width: 1px;
  height: 20px;
  background: #3a3f47;
  margin: 0 4px;
}
</style>
