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
  /** 标注写到哪个文件了。null 表示还没写过 —— 空标注不会落盘。 */
  annotationFile: string | null
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

/**
 * 只显示文件名,完整路径挂到 title 上。
 * 路径动辄七八十个字符,整条塞进来会把左边的读数全挤出屏幕。
 */
const annotationText = computed(() => {
  if (!props.image) return '—'
  if (!props.annotationFile) return '未保存'
  return props.annotationFile.split(/[\\/]/).pop() || props.annotationFile
})
</script>

<template>
  <!--
    这一条本质上是仪器的读数表:每一格都是「标签 + 等宽数字」,格与格之间用竖线断开。
    竖线不是为了好看 —— 读数连成一片时,扫一眼分不清哪个数字属于哪个标签。
    坐标放在最左也是最亮的一格:整个工具就是为读它存在的。
  -->
  <div class="status">
    <span class="readout hero">
      <label>坐标</label>
      <b>{{ cursorText }}</b>
    </span>

    <span class="readout">
      <label>图像</label>
      <b>{{ size }}</b>
    </span>

    <span class="readout">
      <label>缩放</label>
      <b>{{ zoomText }}</b>
    </span>

    <span class="readout">
      <label>网格</label>
      <b>{{ gridEnabled ? `${gridStep} px` : '关' }}</b>
    </span>

    <span class="readout">
      <label>框</label>
      <b>{{ regionCount }}</b>
    </span>

    <span class="spacer" />

    <!-- 自动保存是看不见的,得有一处告诉用户「刚才那下确实存下去了」 -->
    <span class="readout" :title="annotationFile ?? '改动后会自动存到图片旁边'">
      <label>标注</label>
      <b>{{ annotationText }}</b>
    </span>

    <span class="readout">
      <label>瓦片缓存</label>
      <b>{{ cacheText }}</b>
    </span>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  padding: 4px 14px;
  background: var(--stage);
  border-top: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
  overflow-x: auto;
  white-space: nowrap;
}

.readout {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 0 14px;
  border-left: 1px solid var(--border);
}

.readout:first-child {
  padding-left: 0;
  border-left: none;
}

/* 被 spacer 推开的这一格紧贴着窗口右边,再画一根分隔线会像悬在半空 */
.spacer + .readout {
  padding-left: 0;
  border-left: none;
}

label {
  font-size: 11px;
  color: var(--text-faint);
}

b {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--text);
}

.hero b {
  font-size: 13px;
}

.spacer {
  flex: 1;
}
</style>
