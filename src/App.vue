<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import * as api from './api/tauri'
import RectPanel from './components/RectPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ToolBar from './components/ToolBar.vue'
import {
  clampRect,
  coordDecimals,
  HANDLE_CURSORS,
  imageToViewportRect,
  oneToOneZoom,
  resizeRect,
  roundCoord,
  screenToImage,
  type HandleId,
  zoomRatio as calcZoomRatio,
} from './osd/coords'
import { useAnnotationSvg } from './osd/useAnnotationSvg'
import { modeCursor, useViewer } from './osd/useViewer'
import { sliceParams } from './state/slicePrefs'
import { useAnnotations } from './state/useAnnotations'
import type {
  ExportRect,
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
const { regions, guides, selectedIds, selectedId, canUndo, canRedo, revision } = annotations

/** 标注实际写到哪个文件了,以及需要告诉用户的异常 */
const annotationFile = ref<string | null>(null)
const annotationWarning = ref<string | null>(null)

/**
 * 一次性操作的结果(导出完成之类)。
 * 和 annotationWarning 分开:那条是标注文件的状态,得一直挂着直到用户处理,
 * 不能被一次成功的导出顺手清掉。
 */
const notice = ref<string | null>(null)
/** 裁剪导出的进度。null 表示没有在导出。 */
const cropping = ref<{ done: number; total: number } | null>(null)

/** 设置面板(缓存维护 + 切片参数)开着没有 */
const settingsOpen = ref(false)

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
watch(selectedIds, (value) => overlay.setSelection(value))
// 拖动模式下不画手柄:那时候拖拽是平移画面,画着几个拖不动的方块是在骗人
watch(mode, (value) => overlay.setHandlesVisible(value === 'draw'))

const hasImage = computed(() => image.value !== null)

const cropPercent = computed(() => {
  const task = cropping.value
  if (!task || task.total === 0) return '0%'
  return `${Math.round((task.done / task.total) * 100)}%`
})

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

  cleanups.push(
    await api.onCropProgress((progress) => {
      cropping.value = { done: progress.done, total: progress.total }
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

/** 拖拽开始前某个框的坐标。位移一律相对它算,不做累加 —— 累加会攒出漂移。 */
interface DragOrigin {
  id: string
  rect: Rect
}

/**
 * 正在拖拽的状态。null 表示没有拖拽。
 *
 * move 和 resize 都带 `origins`:移动可能是拖动一整批选中的框,
 * 缩放恒为一项(手柄只有单选时才出现)。共用一个字段是为了让松手时的
 * 「到底动没动」判断只有一处。
 */
type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; grabX: number; grabY: number; origins: DragOrigin[] }
  | { kind: 'resize'; handle: HandleId; grabX: number; grabY: number; origins: DragOrigin[] }

let drag: DragState | null = null

/** 记下这些框当前的坐标。 */
function originsOf(ids: string[]): DragOrigin[] {
  return ids.flatMap((id) => {
    const region = regions.value.find((r) => r.id === id)
    return region ? [{ id, rect: { x: region.x, y: region.y, w: region.w, h: region.h } }] : []
  })
}

/** 事件 → 相对 viewer.element 左上角的屏幕像素。 */
function pointerToScreen(event: PointerEvent): { x: number; y: number } | null {
  const viewer = viewerApi.viewer.value
  if (!viewer) return null
  const bounds = viewer.element.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function pointerToImage(event: PointerEvent): { x: number; y: number } | null {
  const viewer = viewerApi.viewer.value
  const screen = pointerToScreen(event)
  if (!viewer || !screen) return null
  return screenToImage(viewer, screen.x, screen.y)
}

/**
 * 手柄的指针形状。悬停时给个提示,否则用户不知道框边上那几个方块能拖。
 *
 * 离开手柄时还回**模式的基础光标**,不是清空 —— 顺手清成空串会把画框模式的
 * crosshair 一起抹掉,表现为「悬停过一次手柄,光标就永远变回箭头」。
 */
function syncHandleCursor(handle: HandleId | null) {
  const element = viewerApi.viewer.value?.element
  if (!element) return
  const next = handle ? HANDLE_CURSORS[handle] : modeCursor(mode.value)
  if (element.style.cursor !== next) element.style.cursor = next
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

  const screen = pointerToScreen(event)
  const point = pointerToImage(event)
  if (!screen || !point) return

  // 手柄必须先判:它就压在选中框的边框上,和「点中这个框」是重叠的。
  // 反过来先判框的话,选中的框永远拖不到自己的手柄。
  const sole = selectedId.value
  if (sole) {
    const handle = overlay.handleAt(screen.x, screen.y)
    const region = regions.value.find((r) => r.id === sole)
    if (handle && region) {
      drag = {
        kind: 'resize',
        handle,
        grabX: point.x,
        grabY: point.y,
        origins: originsOf([sole]),
      }
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
      event.preventDefault()
      return
    }
  }

  const hit = findRegionAt(point.x, point.y)
  if (hit) {
    if (event.ctrlKey || event.metaKey) {
      annotations.toggleSelected(hit.id)
    } else if (!selectedIds.value.has(hit.id)) {
      // 已经在选区里的框不重置选区 —— 那样就拖不动一整批了
      annotations.select(hit.id)
    }

    // 刚被 Ctrl 点掉的框不该跟着一起拖
    if (selectedIds.value.has(hit.id)) {
      drag = {
        kind: 'move',
        grabX: point.x,
        grabY: point.y,
        origins: originsOf([...selectedIds.value]),
      }
    }
  } else {
    annotations.select(null)
    drag = { kind: 'draw', startX: point.x, startY: point.y }
    overlay.setDraft({ x: point.x, y: point.y, w: 0, h: 0 })
  }

  // 捕获指针,手指/鼠标移出窗口也能收到 move 和 up
  ;(event.target as Element).setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent) {
  const screen = pointerToScreen(event)
  const point = pointerToImage(event)
  cursor.value = point

  // 悬停手柄时给个能拖的提示。拖拽中不改 —— 那时形状该定在手柄上
  if (!drag && mode.value === 'draw' && screen && selectedId.value) {
    syncHandleCursor(overlay.handleAt(screen.x, screen.y))
  }

  if (!point || !drag || !image.value) return

  if (drag.kind === 'draw') {
    overlay.setDraft(
      clampRect(
        { x: drag.startX, y: drag.startY, w: point.x - drag.startX, h: point.y - drag.startY },
        image.value.width,
        image.value.height,
      ),
    )
    return
  }

  const dx = point.x - drag.grabX
  const dy = point.y - drag.grabY
  // 拖拽过程中不记还原点 —— 一次拖拽在撤销栈里应该是「一步」,不是几十步
  if (drag.kind === 'move') {
    annotations.setRegionsRects(
      drag.origins.map(({ id, rect }) => ({ id, rect: { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h } })),
    )
  } else {
    const base = drag.origins[0]
    annotations.setRegionsRects([
      { id: base.id, rect: resizeRect(base.rect, drag.handle, dx, dy) },
    ])
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
    const moved = drag.origins.some(({ id, rect }) => {
      const current = regions.value.find((r) => r.id === id)
      if (!current) return false
      return (
        current.x !== rect.x ||
        current.y !== rect.y ||
        current.w !== rect.w ||
        current.h !== rect.h
      )
    })
    if (moved) annotations.commit()
  }

  drag = null
}

function onPointerCancel() {
  overlay.setDraft(null)
  drag = null
}

function onPointerLeave() {
  cursor.value = null
  syncHandleCursor(null)
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
  // 和框一样按当前位数收敛:辅助线的标签显示的就是这个值,
  // 存一个 1234.57 却显示成 1235,读数就没法当准了
  const raw = axis === 'x' ? point.x : point.y
  annotations.addGuide({ axis, pos: roundCoord(raw), color: '#ffd666' })
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
    if (selectedIds.value.size > 0) {
      annotations.removeRegions([...selectedIds.value])
      event.preventDefault()
    }
    return
  }

  if (event.key === 'Escape') {
    // 设置面板在最上层,先关它 —— 否则会「关了面板又顺手把框的选中也取消了」
    if (settingsOpen.value) {
      settingsOpen.value = false
      return
    }
    // 先收掉可能正在进行的拖拽,再取消选中
    overlay.setDraft(null)
    drag = null
    annotations.clearSelection()
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

// ---------------------------------------------------------------- 导出

/** 问题列表可能很长(几十个框越界),横幅里只列前几条 */
function summarize(problems: string[], limit = 3): string {
  const head = problems.slice(0, limit).join(";")
  return problems.length > limit ? `${head} 等 ${problems.length} 个` : head
}

async function exportCsv(rects: ExportRect[]) {
  const current = image.value
  if (!current) return
  try {
    const target = await api.exportRegionsCsv(current.sourcePath, rects, coordDecimals.value)
    // 用户取消对话框时是 null —— 那不是失败,什么都不用说
    if (target) notice.value = `已导出 ${rects.length} 个框到 ${target}`
  } catch (error) {
    errorMessage.value = String(error)
  }
}

async function exportCrops(rects: ExportRect[]) {
  const current = image.value
  if (!current) return

  cropping.value = { done: 0, total: rects.length }
  try {
    const outcome = await api.exportCrops(current.sourcePath, rects)
    if (!outcome) return

    // 部分成功是常态(总有框压在图像边界上),所以不写「导出完成」了事 ——
    // 那会让人以为每个框都出来了
    notice.value = outcome.problems.length
      ? `已导出 ${outcome.written} 张裁剪图到 ${outcome.dir};` +
        `${outcome.problems.length} 个框有问题:${summarize(outcome.problems)}`
      : `已导出 ${outcome.written} 张裁剪图到 ${outcome.dir}`
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    cropping.value = null
  }
}

// ---------------------------------------------------------------- 设置

/**
 * 缓存被清空了。
 *
 * 当前图必须一起关掉:它的瓦片文件已经没了,留着只会是一片空白。关掉之后回到
 * 「还没有打开图片」,用户重新打开会正常走一遍切片。
 *
 * 标注不受影响 —— 它们存在图片旁边,和瓦片缓存是两个地方。
 */
function onCacheCleared() {
  settingsOpen.value = false
  if (!image.value) return

  viewerApi.close()
  image.value = null
  annotations.reset([], [])
  annotationFile.value = null
  annotationWarning.value = null
  // 图都没了,再自动保存就会往一个没有对应图像的路径写
  saveEnabled = false
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
    const prepared = await api.prepareImage(path, sliceParams())
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
    syncHandleCursor(null)
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
      @settings="settingsOpen = true"
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

        <div v-if="slicing" class="busy">
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

        <!-- 裁剪没法取消:每个框是一次独立的 vips 调用,杀进程解决不了「已经写了一半」的问题 -->
        <div v-else-if="cropping" class="busy">
          <h3>正在导出框内图像</h3>
          <div class="bar"><div class="fill" :style="{ width: cropPercent }" /></div>
          <p class="dim mono">{{ cropping.done }} / {{ cropping.total }}</p>
          <p class="dim">每个框单独读一次源图,大图可能要等一会儿。</p>
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

          <div v-if="notice" class="notice">
            <span>{{ notice }}</span>
            <button @click="notice = null">知道了</button>
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
        :selected-ids="selectedIds"
        :image-width="image?.width ?? 0"
        :image-height="image?.height ?? 0"
        :has-image="hasImage"
        @add="annotations.addRegion"
        @remove="annotations.removeRegions"
        @select="annotations.select"
        @toggle="annotations.toggleSelected"
        @rename="annotations.renameRegion"
        @clear-regions="annotations.clearRegions"
        @remove-guide="annotations.removeGuide"
        @clear-guides="annotations.clearGuides"
        @focus="focusRegion"
        @export-csv="exportCsv"
        @export-crops="exportCrops"
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
      @settings="settingsOpen = true"
    />

    <!-- 缓存维护和切片参数放在一起:改了切片参数会让已切过的图重切一份, -->
    <!-- 而清缓存是抹掉所有旧瓦片 —— 用户得在同一个地方看到这个因果 -->
    <SettingsPanel
      v-if="settingsOpen"
      :image="image"
      :slicing="slicing !== null"
      @close="settingsOpen = false"
      @cleared="onCacheCleared"
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

/* 切片和裁剪导出共用:两者都是「一个跑一会儿的后台任务」,长得一样才能一眼认出 */
.busy {
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

.busy h3 {
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

.busy p {
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
