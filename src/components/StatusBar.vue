<script setup lang="ts">
import { computed } from 'vue'

import { formatBytes } from '../api/tauri'
import { formatCoord } from '../osd/coords'
import type { PreparedImage } from '../types'

const props = defineProps<{
  image: PreparedImage | null
  /** 鼠标处的图像像素坐标 */
  cursor: { x: number; y: number } | null
  /** 1.0 表示 1:1 */
  zoomRatio: number | null
  gridStep: number
  gridEnabled: boolean
  regionCount: number
}>()

const size = computed(() => {
  if (!props.image) return '—'
  const { width, height } = props.image
  const megapixels = (width * height) / 1e6
  return `${width} × ${height}  (${megapixels.toFixed(0)} MP)`
})

// 和框用同样的 2 位小数精度 —— 精度不一致就没法用鼠标读数去核对框的角点
const cursorText = computed(() => {
  if (!props.cursor) return '—'
  return `${formatCoord(props.cursor.x)}, ${formatCoord(props.cursor.y)}`
})

const zoomText = computed(() => {
  if (props.zoomRatio == null) return '—'
  const percent = props.zoomRatio * 100
  // 放大超过 10 倍后小数没意义,缩小到 1% 以下则需要小数
  if (percent >= 1000) return `${percent.toFixed(0)}%`
  if (percent < 10) return `${percent.toFixed(2)}%`
  return `${percent.toFixed(1)}%`
})

const cacheText = computed(() => {
  if (!props.image) return '—'
  return props.image.fromCache
    ? `${formatBytes(props.image.cacheBytes)} (已缓存)`
    : `${formatBytes(props.image.cacheBytes)} (本次生成)`
})
</script>

<template>
  <div class="status">
    <span class="item">
      <label>坐标</label>
      <b class="mono">{{ cursorText }}</b>
    </span>

    <span class="item">
      <label>图像</label>
      <b class="mono">{{ size }}</b>
    </span>

    <span class="item">
      <label>缩放</label>
      <b class="mono">{{ zoomText }}</b>
    </span>

    <span class="item">
      <label>网格</label>
      <b class="mono">{{ gridEnabled ? `${gridStep} px` : '关' }}</b>
    </span>

    <span class="item">
      <label>框</label>
      <b class="mono">{{ regionCount }}</b>
    </span>

    <span class="spacer" />

    <span class="item">
      <label>瓦片缓存</label>
      <b class="mono">{{ cacheText }}</b>
    </span>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 5px 12px;
  background: #1c1f23;
  border-top: 1px solid #33383f;
  font-size: 12px;
  color: #9aa3ae;
  flex-shrink: 0;
  overflow-x: auto;
  white-space: nowrap;
}

.item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

label {
  color: #6c757f;
}

b {
  color: #d6dae0;
  font-weight: 500;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.spacer {
  flex: 1;
}
</style>
