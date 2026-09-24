<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import * as api from './api/tauri'
import RectPanel from './components/RectPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ToolBar from './components/ToolBar.vue'
import {
  clampRect,
  imageToViewportRect,
  oneToOneZoom,
  screenToImage,
  zoomRatio as calcZoomRatio,
} from './osd/coords'
import { useAnnotationSvg } from './osd/useAnnotationSvg'
import { useViewer } from './osd/useViewer'
import { useAnnotations } from './state/useAnnotations'
import type {
  LoadedAnnotations,
  PreparedImage,
  Rect,
  Region,
  ToolMode,
  VipsStatus,
} from './types'

const stageEl = ref<HTMLElement | null>(null)
const viewerEl = ref<HTMLElement | null>(null)

const image = ref<PreparedImage | null>(null)
const mode = ref<ToolMode>('pan')
const cursor = ref<{ x: number; y: number } | null>(null)
const zoom = ref<number | null>(null)
const gridEnabled = ref(true)
const gridStep = ref(1000)

// 框、辅助线、选中项和撤销栈都归它管。App 只负责把用户操作翻译成它的调用。
const annotations = useAnnotations()
const { regions, guides, selectedId, canUndo, canRedo, revision } = annotations

/** 标注实际写到哪个文件了,以及需要告诉用户的异常 */
const annotationFile = ref<string | null>(null)
const annotationWarning = ref<string | null>(null)

const vipsStatus = ref<VipsStatus | null>(null)
const errorMessage = ref<string | null>(null)
const slicing = ref<{ percent: number; tilesDone: number; tilesTotal: number } | null>(null)

const viewerApi = useViewer(() => viewerEl.value)
const overlay = useAnnotationSvg(() => viewerApi.viewer.value, () => stageEl.value)

// 状态是唯一真相,叠加层跟着它走。
// 之前是每个改动点各自记得调一次 setRegions —— 漏掉一处就是「框加进列表了但屏幕上看不见」,
// 而拖拽路径上的漏调只在特定操作顺序下才暴露,很难查。
watch(regions, (value) => overlay.setRegions(value))
watch(guides, (value) => overlay.setGuides(value))

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

  // 快捷键挂在 window 上:焦点可能停在任何按钮上,
  // 而 OSD 的画布元素本身不接收键盘事件
  window.addEventListener('keydown', onKeyDown)
  cleanups.push(() => window.removeEventListener('keydown', onKeyDown))

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
    // 拖拽过程中不记还原点 —— 一次拖拽在撤销栈里应该是「一步」,不是几十步
    annotations.setRegionRect(drag.id, {
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
      if (rect.w >= 1 || rect.h >= 1) annotations.addRegion(rect)
    }
  } else {
    // 只是点了一下、没有真的挪动,就不留还原点。
    // 否则连着点几下框,撤销栈里会堆一串「什么都没变」的空步。
    const { id, origin } = drag
    const current = regions.value.find((r) => r.id === id)
    if (current && (current.x !== origin.x || current.y !== origin.y)) {
      annotations.commit()
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
  annotations.addGuide({ axis, pos: axis === 'x' ? point.x : point.y, color: '#ffd666' })
  event.preventDefault()
}

// ---------------------------------------------------------------- 快捷键

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * 全局快捷键。
 *
 * 第一件事是判断焦点在不在输入框里 —— 侧栏那几个坐标输入框里按 Delete 和方向键
 * 是在编辑数字,不能顺手把画布上的框也删了。
 */
function onKeyDown(event: KeyboardEvent) {
  if (isTextInput(event.target)) return

  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()

  if (mod && key === 'z') {
    // Ctrl+Shift+Z 和 Ctrl+Y 都当重做:两种习惯都有人用,没必要二选一
    if (event.shiftKey) annotations.redo()
    else annotations.undo()
    event.preventDefault()
    return
  }
  if (mod && key === 'y') {
    annotations.redo()
    event.preventDefault()
    return
  }

  if (!image.value) return

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedId.value) {
      annotations.removeRegion(selectedId.value)
      event.preventDefault()
    }
    return
  }

  if (event.key === 'Escape') {
    // 先收掉可能正在进行的拖拽,再取消选中
    overlay.setDraft(null)
    drag = null
    selectedId.value = null
    return
  }

  const id = selectedId.value
  if (!id || !event.key.startsWith('Arrow')) return

  // Shift 加速到 10px:1px 适合对齐角点,但要把框挪出很远时按 1px 走会疯掉
  const step = event.shiftKey ? 10 : 1
  if (event.key === 'ArrowLeft') annotations.nudge(id, -step, 0)
  else if (event.key === 'ArrowRight') annotations.nudge(id, step, 0)
  else if (event.key === 'ArrowUp') annotations.nudge(id, 0, -step)
  else annotations.nudge(id, 0, step)
  event.preventDefault()
}

// ---------------------------------------------------------------- 标注落盘

/** 读不回原文件、或写不进去时置 false,避免把用户唯一的那份标注覆盖掉 */
let saveEnabled = false
let saving = false
let savePending = false

/**
 * 把标注读回来。读不到不是错误 —— 第一次打开一张图本来就没有标注文件。
 *
 * 这个函数**不碰任何状态**。取是异步的,用必须是同步的,所以拆成两步 ——
 * 见 `applyAnnotations` 的注释。
 */
function fetchAnnotations(path: string): Promise<LoadedAnnotations> {
  return api.loadAnnotations(path).catch((error) => ({
    doc: null,
    filePath: null,
    mismatch: null,
    // IPC 本身失败时也当成「读不出来」处理。宁可少存一次,
    // 也不能在「不知道原文件有什么」的情况下把它覆盖掉。
    failure: `读取失败:${error}`,
  }))
}

/**
 * 把读回来的标注写进状态。
 *
 * **必须和 `image.value = prepared` 在同一个同步块里调用。**
 * 中间只要隔一个 await,自动保存就可能读到「新图 + 旧框」这个半新半旧的组合,
 * 然后把 A 图的框写进 B 图的标注文件。
 */
function applyAnnotations(loaded: LoadedAnnotations, current: PreparedImage) {
  annotationFile.value = loaded.filePath
  annotationWarning.value = null
  saveEnabled = false

  if (loaded.failure) {
    // 文件在,但读不出来(JSON 坏了,或是更新版本写的)。
    // **必须停掉自动保存**:否则用户随手拖一下框,我们就用一份空标注
    // 把他唯一的那份产出物盖掉了 —— 那比「读不出来」严重得多。
    annotationWarning.value =
      `这份标注没能读出来(${loaded.failure}),自动保存已停用,以免覆盖它:` +
      `${loaded.filePath ?? '未知路径'}`
    annotations.reset([], [])
    return
  }

  saveEnabled = true
  annotations.reset(loaded.doc?.regions ?? [], loaded.doc?.guides ?? [])

  // 尺寸对不上说明同路径的图被换过了。仍然加载 —— 用户可能就是想把旧标注贴上来对照
  const source = loaded.doc?.source
  if (source && (source.width !== current.width || source.height !== current.height)) {
    annotationWarning.value =
      `标注是按 ${source.width} × ${source.height} 存的,当前图是 ${current.width} × ${current.height}`
  } else if (loaded.mismatch) {
    annotationWarning.value = loaded.mismatch
  }
}

/**
 * 转存标注。
 *
 * 写盘串行化:上一次还没写完就只记个标记,写完再补一次 ——
 * 两次写盘交错的话,后写的那次会覆盖先写的,而它们的内容可能已经不是同一份状态了。
 *
 * 不做防抖:一次拖拽只在松手时提交一次,写盘频率本来就低;
 * 而防抖会在「改完立刻关窗」时把最后一次改动丢掉。
 */
async function flushAnnotations() {
  if (!saveEnabled) return
  if (saving) {
    savePending = true
    return
  }

  saving = true
  try {
    do {
      savePending = false
      const current = image.value
      if (!current || !saveEnabled) return

      const outcome = await api.saveAnnotations(
        current.sourcePath,
        current.width,
        current.height,
        annotations.regions.value,
        annotations.guides.value,
      )
      annotationFile.value = outcome.filePath
      if (outcome.fallback && annotationWarning.value === null) {
        annotationWarning.value = `源图目录写不进去,标注存在了 ${outcome.filePath}(拷图给别人时记得一起带上)`
      }
    } while (savePending)
  } catch (error) {
    // 存不下去就停掉自动保存并说清楚,而不是每次改动都弹一遍同样的错
    saveEnabled = false
    annotationWarning.value = `标注自动保存失败,已停用:${error}`
  } finally {
    saving = false
  }
}

// 盯的是 revision 而不是 regions:拖拽过程中每个 pointermove 都会换掉数组,
// 直接盯数组的话,一次拖拽会触发几十次写盘。
watch(revision, () => {
  // 打开图看了看、什么都没画,就别在图片目录里凭空多出一个文件
  const empty = annotations.regions.value.length === 0 && annotations.guides.value.length === 0
  if (empty && annotationFile.value === null) return
  void flushAnnotations()
})

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
    // 标注先取回来(异步),再和图像一起换上去(同步,中间不插 await)。
    // 读不到就是空的,旧图的框不会被带过来 —— 它们对新图的坐标没有意义。
    const loaded = await fetchAnnotations(prepared.sourcePath)
    image.value = prepared
    applyAnnotations(loaded, prepared)
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
      :can-undo="canUndo"
      :can-redo="canRedo"
      @open="openImage"
      @update:mode="setMode"
      @update:grid-enabled="onGridToggle"
      @zoom-to-fit="zoomToFit"
      @zoom-to-one="zoomToOne"
      @undo="annotations.undo"
      @redo="annotations.redo"
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

        <!--
          两条横幅共用一个底部容器,不然会叠在同一个位置上。
          容器本身 pointer-events:none —— 否则画布底部会多出一条按不动的死区。
        -->
        <div class="banners">
          <!--
            标注的异常用中性色而不是红色:它们是「要知道」,不是「出事了」——
            图能正常看,标注也还在,只是存在别处、或者没读回来。
            真出错(打开图片失败)走的还是下面那条红横幅。
          -->
          <div v-if="annotationWarning" class="notice">
            <span>{{ annotationWarning }}</span>
            <button @click="annotationWarning = null">知道了</button>
          </div>

          <div v-if="errorMessage" class="error">
            <span>{{ errorMessage }}</span>
            <button @click="errorMessage = null">关闭</button>
          </div>
        </div>
      </div>

      <RectPanel
        :regions="regions"
        :guides="guides"
        :selected-id="selectedId"
        :image-width="image?.width ?? 0"
        :image-height="image?.height ?? 0"
        :has-image="hasImage"
        @add="annotations.addRegion"
        @remove="annotations.removeRegion"
        @select="selectedId = $event"
        @clear-regions="annotations.clearRegions"
        @remove-guide="annotations.removeGuide"
        @clear-guides="annotations.clearGuides"
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
      :annotation-file="annotationFile"
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

.banners {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 容器只是用来排布的:它盖住的那条画布底部仍然得能拖动 */
  pointer-events: none;
}

.banners > * {
  pointer-events: auto;
}

.error,
.notice {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border-radius: var(--r-lg);
  padding: 10px 14px;
  font-size: 12px;
}

.error {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
}

/* 中性底 + 琥珀色文字。两条「要知道」级别的提示用红色会喊狼来了 */
.notice {
  background: var(--panel);
  border: 1px solid var(--border-strong);
  color: var(--warn-text);
}

.error span,
.notice span {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}

.error button,
.notice button {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 11px;
  background: transparent;
}

.error button {
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.error button:hover:not(:disabled) {
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.notice button {
  border-color: var(--border-strong);
  color: var(--warn-text);
}
</style>
