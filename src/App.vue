<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import * as api from './api/tauri'
import RectPanel from './components/RectPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ToolBar from './components/ToolBar.vue'
import {
  clampRect,
  imageToViewportRect,
  oneToOneZoom,
  roundRect,
  screenToImage,
  zoomRatio as calcZoomRatio,
} from './osd/coords'
import { useAnnotationSvg } from './osd/useAnnotationSvg'
import { useViewer } from './osd/useViewer'
import type { Guide, PreparedImage, Rect, Region, ToolMode, VipsStatus } from './types'

const stageEl = ref<HTMLElement | null>(null)
const viewerEl = ref<HTMLElement | null>(null)

const image = ref<PreparedImage | null>(null)
const mode = ref<ToolMode>('pan')
const regions = ref<Region[]>([])
const selectedId = ref<string | null>(null)
const guides = ref<Guide[]>([])
const cursor = ref<{ x: number; y: number } | null>(null)
const zoom = ref<number | null>(null)
const gridEnabled = ref(true)
const gridStep = ref(1000)

const vipsStatus = ref<VipsStatus | null>(null)
const errorMessage = ref<string | null>(null)
const slicing = ref<{ percent: number; tilesDone: number; tilesTotal: number } | null>(null)

const viewerApi = useViewer(() => viewerEl.value)
const overlay = useAnnotationSvg(() => viewerApi.viewer.value, () => stageEl.value)

const palette = ['#ff4d4f', '#40a9ff', '#73d13d', '#ffa940', '#b37feb', '#36cfc9']
let paletteIndex = 0
let regionSeq = 0

const hasImage = computed(() => image.value !== null)

// ---------------------------------------------------------------- 生命周期

const cleanups: Array<() => void> = []

onMounted(async () => {
  viewerApi.init()
  overlay.mount()

  const viewer = viewerApi.viewer.value
  if (viewer) {
    const element = viewer.element

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onPointerCancel)
    element.addEventListener('pointerleave', onPointerLeave)
    element.addEventListener('dblclick', onDoubleClick)

    const syncZoom = () => {
      zoom.value = calcZoomRatio(viewer)
      gridStep.value = overlay.currentGridStep()
    }
    viewer.addHandler('animation-finish', syncZoom)
    viewer.addHandler('open', syncZoom)
    viewer.addHandler('resize', syncZoom)
    // 窗口缩放等情况下 animation-finish 不一定触发,兜一层
    viewer.addHandler('animation', syncZoom)

    cleanups.push(() => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerCancel)
      element.removeEventListener('pointerleave', onPointerLeave)
      element.removeEventListener('dblclick', onDoubleClick)
      viewer.removeHandler('animation-finish', syncZoom)
      viewer.removeHandler('open', syncZoom)
      viewer.removeHandler('resize', syncZoom)
      viewer.removeHandler('animation', syncZoom)
    })
  }

  cleanups.push(
    await api.onVipsStatus((status) => {
      // 事件载荷已经是 VipsStatus 形状,直接用。
      // 不写 errorMessage —— 画布中央的占位提示已经说明了问题,
      // 再弹一个红色横幅是重复打扰。
      vipsStatus.value = status
    }),
  )

  cleanups.push(
    await api.onTileProgress((progress) => {
      if (progress.phase === 'done') {
        slicing.value = null
        return
      }
      // vips 自带进度和文件计数兜底会同时发事件,取较大值避免数字回退
      const percent = Math.max(slicing.value?.percent ?? 0, progress.percent)
      slicing.value = {
        percent,
        tilesDone: Math.max(slicing.value?.tilesDone ?? 0, progress.tilesDone),
        tilesTotal: progress.tilesTotal,
      }
    }),
  )

  // 主动查一次,不依赖事件 —— 事件可能在监听器注册之前就已经发过了
  try {
    // 成功即代表可用:命令的 Err 分支才是「找不到 vips」
    vipsStatus.value = { available: true, ...(await api.vipsInfo()) }
  } catch (error) {
    vipsStatus.value = { available: false, message: String(error) }
  }
})

onBeforeUnmount(() => {
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
})

// ---------------------------------------------------------------- 交互

/** 正在拖拽的状态。null 表示没有拖拽。 */
type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; id: string; grabX: number; grabY: number; origin: Rect }

let drag: DragState | null = null

function pointerToImage(event: PointerEvent): { x: number; y: number } | null {
  const viewer = viewerApi.viewer.value
  if (!viewer) return null
  const bounds = viewer.element.getBoundingClientRect()
  return screenToImage(viewer, event.clientX - bounds.left, event.clientY - bounds.top)
}

/** 命中检测:从后往前找,让后画的框优先被选中。 */
function findRegionAt(x: number, y: number): Region | null {
  for (let i = regions.value.length - 1; i >= 0; i -= 1) {
    const region = regions.value[i]
    if (x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h) {
      return region
    }
  }
  return null
}

function onPointerDown(event: PointerEvent) {
  if (mode.value !== 'draw' || !image.value || event.button !== 0) return

  const point = pointerToImage(event)
  if (!point) return

  const hit = findRegionAt(point.x, point.y)
  if (hit) {
    selectedId.value = hit.id
    drag = {
      kind: 'move',
      id: hit.id,
      grabX: point.x,
      grabY: point.y,
      origin: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
    }
  } else {
    selectedId.value = null
    drag = { kind: 'draw', startX: point.x, startY: point.y }
    overlay.setDraft({ x: point.x, y: point.y, w: 0, h: 0 })
  }

  // 捕获指针,手指/鼠标移出窗口也能收到 move 和 up
  ;(event.target as Element).setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent) {
  const point = pointerToImage(event)
  cursor.value = point
  if (!point || !drag || !image.value) return

  if (drag.kind === 'draw') {
    overlay.setDraft(
      clampRect(
        { x: drag.startX, y: drag.startY, w: point.x - drag.startX, h: point.y - drag.startY },
        image.value.width,
        image.value.height,
      ),
    )
  } else {
    const dx = point.x - drag.grabX
    const dy = point.y - drag.grabY
    updateRegion(drag.id, {
      x: drag.origin.x + dx,
      y: drag.origin.y + dy,
      w: drag.origin.w,
      h: drag.origin.h,
    })
  }
}

function onPointerUp(event: PointerEvent) {
  if (!drag) return
  ;(event.target as Element).releasePointerCapture?.(event.pointerId)

  if (drag.kind === 'draw') {
    overlay.setDraft(null)
    const point = pointerToImage(event)
    if (point && image.value) {
      // 拖拽过程中框已经被夹到图像边界内,这里用 overlay 的 draft 值更准
      const rect = clampRect(
        { x: drag.startX, y: drag.startY, w: point.x - drag.startX, h: point.y - drag.startY },
        image.value.width,
        image.value.height,
      )
      // 太小的框多半是误点,不作为框提交
      if (rect.w >= 1 || rect.h >= 1) addRegion(rect)
    }
  }

  drag = null
}

function onPointerCancel() {
  overlay.setDraft(null)
  drag = null
}

function onPointerLeave() {
  cursor.value = null
}

/**
 * 双击:在当前位置放一条辅助线,便于对齐。Shift 加竖线,否则加横线。
 *
 * 辅助线颜色**不跟主题走**:它画在图上,不画在界面上,判断依据是「在任意图像内容
 * 上都能看见」,跟界面是深色还是浅色没关系。换主题时标注凭空变色反而是干扰。
 * 侧栏里那个同色的小图标见 --guide。
 */
function onDoubleClick(event: MouseEvent) {
  const viewer = viewerApi.viewer.value
  if (!viewer || !image.value) return
  const bounds = viewer.element.getBoundingClientRect()
  const point = screenToImage(viewer, event.clientX - bounds.left, event.clientY - bounds.top)
  if (!point) return

  const axis = event.shiftKey ? 'x' : 'y'
  const pos = axis === 'x' ? point.x : point.y
  guides.value = [
    ...guides.value.filter((g) => !(g.axis === axis && Math.abs(g.pos - pos) < 2)),
    { axis, pos, color: '#ffd666' },
  ]
  overlay.setGuides(guides.value)
  event.preventDefault()
}

// ---------------------------------------------------------------- 框操作

function addRegion(rect: Rect) {
  const color = palette[paletteIndex % palette.length]
  paletteIndex += 1
  regionSeq += 1
  // 这里是所有框进入列表的入口,统一收敛精度。
  // 拖拽画出来的框坐标来自屏幕反算,是带一长串小数的浮点数。
  const region: Region = { ...roundRect(rect), id: `r${regionSeq}`, color }
  regions.value = [...regions.value, region]
  selectedId.value = region.id
  overlay.setRegions(regions.value)
}

function updateRegion(id: string, rect: Rect) {
  regions.value = regions.value.map((region) =>
    region.id === id ? { ...region, ...roundRect(rect) } : region,
  )
  overlay.setRegions(regions.value)
}

function removeRegion(id: string) {
  regions.value = regions.value.filter((region) => region.id !== id)
  if (selectedId.value === id) selectedId.value = null
  overlay.setRegions(regions.value)
}

/**
 * 只清框。
 *
 * 之前这里连辅助线一起清 —— 但按钮在「框列表」里,名字叫「清空全部」,
 * 用户无从得知双击误放的一条辅助线要付出「连所有框一起没了」的代价。
 * 两者现在各有各的清除入口。
 */
function clearRegions() {
  regions.value = []
  selectedId.value = null
  overlay.setRegions([])
}

function removeGuide(index: number) {
  guides.value = guides.value.filter((_, i) => i !== index)
  overlay.setGuides(guides.value)
}

function clearGuides() {
  guides.value = []
  overlay.setGuides([])
}

/** 把视图移到指定框。框比视口大就缩放到装得下,否则只平移不改缩放。 */
function focusRegion(region: Region) {
  const viewer = viewerApi.viewer.value
  if (!viewer) return
  const bounds = imageToViewportRect(viewer, region)
  if (!bounds) return

  const viewportBounds = viewer.viewport.getBounds()
  const fits = bounds.width <= viewportBounds.width && bounds.height <= viewportBounds.height

  if (fits) {
    viewer.viewport.panTo(bounds.getCenter())
  } else {
    viewer.viewport.fitBounds(bounds, true)
  }
}

// ---------------------------------------------------------------- 工具栏

async function openImage() {
  errorMessage.value = null
  try {
    const path = await api.pickImage()
    if (!path) return
    await loadPath(path)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

async function loadPath(path: string) {
  slicing.value = { percent: 0, tilesDone: 0, tilesTotal: 0 }
  try {
    const prepared = await api.prepareImage(path)
    image.value = prepared
    // 换图时清空标注 —— 旧框的坐标对新图没有意义
    regions.value = []
    guides.value = []
    selectedId.value = null
    overlay.setRegions([])
    overlay.setGuides([])
    viewerApi.load(prepared)
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    slicing.value = null
  }
}

function setMode(next: ToolMode) {
  mode.value = next
  viewerApi.setMode(next)
  if (next === 'pan') {
    overlay.setDraft(null)
    drag = null
  }
}

function zoomToFit() {
  viewerApi.viewer.value?.viewport.goHome()
}

function zoomToOne() {
  const viewer = viewerApi.viewer.value
  if (!viewer) return
  const target = oneToOneZoom(viewer)
  if (target != null) viewer.viewport.zoomTo(target)
}

function onGridToggle(enabled: boolean) {
  gridEnabled.value = enabled
  overlay.setGrid({ enabled })
}
</script>

<template>
  <div class="app">
    <ToolBar
      :mode="mode"
      :grid-enabled="gridEnabled"
      :has-image="hasImage"
      :ready="vipsStatus?.available === true"
      @open="openImage"
      @update:mode="setMode"
      @update:grid-enabled="onGridToggle"
      @zoom-to-fit="zoomToFit"
      @zoom-to-one="zoomToOne"
    />

    <div class="body">
      <div ref="stageEl" class="stage">
        <div ref="viewerEl" class="viewer" />

        <div v-if="!hasImage && !slicing" class="placeholder">
          <template v-if="vipsStatus?.available">
            <h2>还没有打开图片</h2>
            <p>点击左上角「打开图片」选择一张图。</p>
            <p class="dim">
              首次打开超大图需要生成瓦片金字塔,可能要几分钟;
              之后同一张图会命中缓存,秒开。
            </p>
          </template>
          <template v-else-if="vipsStatus">
            <h2 class="bad">找不到 libvips</h2>
            <pre class="detail">{{ vipsStatus.message }}</pre>
          </template>
          <template v-else>
            <h2>正在检查运行环境…</h2>
          </template>
        </div>

        <div v-if="slicing" class="slicing">
          <h3>正在生成瓦片金字塔</h3>
          <div class="bar"><div class="fill" :style="{ width: `${slicing.percent}%` }" /></div>
          <p class="dim mono">
            {{ slicing.percent }}%
            <template v-if="slicing.tilesTotal > 0">
              · {{ slicing.tilesDone }} / {{ slicing.tilesTotal }} 张瓦片
            </template>
          </p>
          <p class="dim">超大图首次切片需要几分钟,期间界面可以正常操作。</p>
          <button class="danger" @click="api.cancelSlicing()">取消</button>
        </div>

        <div v-if="errorMessage" class="error">
          <span>{{ errorMessage }}</span>
          <button @click="errorMessage = null">关闭</button>
        </div>
      </div>

      <RectPanel
        :regions="regions"
        :guides="guides"
        :selected-id="selectedId"
        :image-width="image?.width ?? 0"
        :image-height="image?.height ?? 0"
        :has-image="hasImage"
        @add="addRegion"
        @remove="removeRegion"
        @select="selectedId = $event"
        @clear-regions="clearRegions"
        @remove-guide="removeGuide"
        @clear-guides="clearGuides"
        @focus="focusRegion"
      />
    </div>

    <StatusBar
      :image="image"
      :cursor="cursor"
      :zoom-ratio="zoom"
      :grid-step="gridStep"
      :grid-enabled="gridEnabled"
      :region-count="regions.length"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  /* OSD 的底色被设成了 transparent(见 useViewer),画布围边就是这一层 */
  background: var(--stage);
}

.viewer {
  position: absolute;
  inset: 0;
}

.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-faint);
  pointer-events: none;
  padding: 32px;
}

.placeholder h2 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-dim);
}

.placeholder h2.bad {
  color: var(--danger-text);
}

.placeholder p {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
}

.dim {
  color: var(--text-faint);
  font-size: 12px;
}

.detail {
  text-align: left;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  max-width: 520px;
  overflow-x: auto;
  white-space: pre-wrap;
}

.slicing {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  padding: 22px 26px;
  width: 380px;
  text-align: center;
  box-shadow: var(--shadow);
}

.slicing h3 {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

.bar {
  height: 6px;
  background: var(--stage);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 10px;
}

.fill {
  height: 100%;
  background: var(--solid);
  transition: width 0.25s ease-out;
}

.slicing p {
  margin: 4px 0;
}

/* 取消按钮用全局的 .danger:它坐在弹窗底部,不能被主按钮抢走注意力 */
.danger {
  margin-top: 12px;
  padding: 5px 18px;
}

.error {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  border-radius: var(--r-lg);
  padding: 10px 14px;
  color: var(--danger-text);
  font-size: 12px;
}

.error span {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}

.error button {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 11px;
  background: transparent;
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.error button:hover:not(:disabled) {
  background: var(--danger-bg);
  border-color: var(--danger-border);
}
</style>
