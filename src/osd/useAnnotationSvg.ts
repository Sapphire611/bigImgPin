/**
 * 叠加层:网格、辅助线、标注框、绘制中的预览框。
 *
 * 全部画在**一个屏幕空间的 `<svg>`** 上,监听 OSD 的 `update-viewport` 事件整体重绘。
 *
 * 为什么不用 `viewer.addOverlay()`:
 *
 * 1. `addOverlay` 的 `location` 是 **viewport 坐标**,不是图像坐标。传图像像素进去
 *    会得到整体偏移,而且偏移量随缩放变化 —— 很难排查。
 * 2. 每个 overlay 会被包一层 div,默认 `checkResize: true` 时每帧调
 *    `getElementSize()` **强制布局重排**。几十个框就是每帧几十次 reflow。
 * 3. `update-viewport` 由 requestAnimationFrame 驱动,正好一帧一次,
 *    比 overlay 的逐元素样式更新便宜得多。
 *
 * SVG 而非 canvas:几十个框在 SVG 的舒适区内,而且以后加「点选某个框」时
 * 命中测试是白送的。
 */
import { onBeforeUnmount } from 'vue'
import OpenSeadragon from 'openseadragon'

import type { Guide, Rect, Region } from '../types'
import { imageToScreenTransform, visibleImageRect, type HandleId } from './coords'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 网格间距,图像像素。会用 1-2-5 序列自动升降。 */
const GRID_BASE_STEP = 1000
/** 网格线在屏幕上的目标间距范围。低于下限就升档,高于上限就降档。 */
const GRID_MIN_SCREEN_PX = 40
const GRID_MAX_SCREEN_PX = 200
/** 单方向最多画多少条网格线。极端缩放下的保险丝。 */
const GRID_MAX_LINES = 300

/** 缩放手柄的边长(屏幕像素)。屏幕空间绘制的一个红利:它不随缩放变大变小。 */
const HANDLE_SIZE = 9
/** 命中判定往外放宽多少。9px 的方块正好卡着边缘点很难受,而手柄之间也不挤。 */
const HANDLE_SLOP = 3

const HANDLE_IDS: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export interface GridState {
  enabled: boolean
  /** 主网格间距(图像像素) */
  step: number
  color: string
}

export function useAnnotationSvg(
  getViewer: () => OpenSeadragon.Viewer | null,
  getContainer: () => HTMLElement | null,
) {
  let svg: SVGSVGElement | null = null
  let gridLayer: SVGGElement
  let guideLayer: SVGGElement
  let regionLayer: SVGGElement
  let draftLayer: SVGGElement

  let regions: Region[] = []
  let guides: Guide[] = []
  let selection: Set<string> = new Set()
  /** 画不画缩放手柄。拖动模式下不画 —— 那时拖拽是平移画面,画着几个拖不动的方块是在骗人。 */
  let handlesVisible = false
  let draft: Rect | null = null

  /**
   * 选中框那八个手柄在**屏幕坐标**里的位置,draw 的时候顺手算好。
   *
   * 命中检测必须和绘制用同一份坐标 —— 分开各算一次,迟早会出现
   * 「看着在手柄上、点下去却没反应」,而且只在某些缩放比例下出现。
   */
  let handlePoints: Array<{ id: HandleId; x: number; y: number }> = []
  let grid: GridState = { enabled: true, step: GRID_BASE_STEP, color: '#5b8dd9' }
  /** 当前实际生效的网格间距,随缩放变化,显示给用户看 */
  let effectiveStep = GRID_BASE_STEP

  const teardown: Array<() => void> = []

  function mount() {
    const container = getContainer()
    if (!container) return

    svg = document.createElementNS(SVG_NS, 'svg')
    // 用 setAttribute 而不是 Object.assign(style, ...):后者在部分引擎上
    // 对 SVG 元素的 CSSStyleDeclaration 支持不一致
    svg.setAttribute('style', [
      'position:absolute',
      'left:0',
      'top:0',
      'width:100%',
      'height:100%',
      // 绝不抢 OSD 的鼠标事件 —— 交互全部由下方的 viewer 元素处理
      'pointer-events:none',
      'z-index:10',
      'overflow:visible',
    ].join(';'))

    gridLayer = document.createElementNS(SVG_NS, 'g')
    guideLayer = document.createElementNS(SVG_NS, 'g')
    regionLayer = document.createElementNS(SVG_NS, 'g')
    draftLayer = document.createElementNS(SVG_NS, 'g')
    svg.append(gridLayer, guideLayer, regionLayer, draftLayer)

    // 后插入 => 天然叠在 OSD 的 canvas 之上
    container.appendChild(svg)

    const viewer = getViewer()
    if (viewer) {
      const redraw = () => draw()
      // update-viewport 每动画帧触发一次,涵盖平移、缩放、窗口尺寸变化
      viewer.addHandler('update-viewport', redraw)
      viewer.addHandler('animation-finish', redraw)
      viewer.addHandler('open', redraw)
      teardown.push(() => {
        viewer.removeHandler('update-viewport', redraw)
        viewer.removeHandler('animation-finish', redraw)
        viewer.removeHandler('open', redraw)
      })
    }
  }

  function draw() {
    const viewer = getViewer()
    if (!viewer || !svg) return

    const transform = imageToScreenTransform(viewer)
    const visible = visibleImageRect(viewer)
    if (!transform || !visible) {
      clearLayers()
      return
    }

    drawGrid(transform, visible)
    drawGuides(transform)
    drawRegions(transform)
    drawDraft(transform)
  }

  /** 1-2-5 序列:网格间距永远是 10/20/50/100/200/500 这种好读的数。 */
  function niceStep(raw: number): number {
    const exponent = Math.floor(Math.log10(raw))
    const magnitude = 10 ** exponent
    const normalized = raw / magnitude
    const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
    return multiplier * magnitude
  }

  function drawGrid(
    transform: ReturnType<typeof imageToScreenTransform> & object,
    visible: Rect,
  ) {
    gridLayer.replaceChildren()
    if (!grid.enabled) return

    const scale = Math.abs(transform.scaleX)
    if (!Number.isFinite(scale) || scale <= 0) return

    // 先按基准间距算出屏幕间距,再升/降到目标区间
    let step = niceStep(grid.step)
    if (step * scale < GRID_MIN_SCREEN_PX) {
      step = niceStep(GRID_MIN_SCREEN_PX / scale)
    }
    if (step * scale > GRID_MAX_SCREEN_PX) {
      step = niceStep(GRID_MAX_SCREEN_PX / scale)
    }
    effectiveStep = step

    const fragment = document.createDocumentFragment()
    const startX = Math.floor(visible.x / step) * step
    const endX = visible.x + visible.w
    const startY = Math.floor(visible.y / step) * step
    const endY = visible.y + visible.h

    const imageHeight = Number.MAX_SAFE_INTEGER
    void imageHeight

    let count = 0
    for (let gx = startX; gx <= endX && count < GRID_MAX_LINES; gx += step, count += 1) {
      const screenX = transform.x(gx)
      fragment.appendChild(line(screenX, 0, screenX, '100%', grid.color, 0.35))
    }

    count = 0
    for (let gy = startY; gy <= endY && count < GRID_MAX_LINES; gy += step, count += 1) {
      const screenY = transform.y(gy)
      fragment.appendChild(line(0, screenY, '100%', screenY, grid.color, 0.35))
    }

    // 网格线本身不带刻度,不标注的话用户无法判断一格是 1000px 还是 500px
    fragment.appendChild(gridScaleLabel(step))

    gridLayer.appendChild(fragment)
  }

  function drawGuides(transform: ReturnType<typeof imageToScreenTransform> & object) {
    guideLayer.replaceChildren()

    const fragment = document.createDocumentFragment()
    for (const guide of guides) {
      const element =
        guide.axis === 'x'
          ? line(transform.x(guide.pos), 0, transform.x(guide.pos), '100%', guide.color, 1)
          : line(0, transform.y(guide.pos), '100%', transform.y(guide.pos), guide.color, 1)
      element.setAttribute('stroke-dasharray', '6 4')
      fragment.appendChild(element)
    }
    guideLayer.appendChild(fragment)
  }

  function drawRegions(transform: ReturnType<typeof imageToScreenTransform> & object) {
    regionLayer.replaceChildren()
    handlePoints = []

    // 只有恰好选中一个时才画手柄。多选时给每个框都画八个手柄,既看不清也不好点
    const soleSelected = handlesVisible && selection.size === 1 ? [...selection][0] : null

    const fragment = document.createDocumentFragment()
    for (const region of regions) {
      const x = transform.x(region.x)
      const y = transform.y(region.y)
      const width = transform.x(region.x + region.w) - x
      const height = transform.y(region.y + region.h) - y
      const selected = selection.has(region.id)

      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(Math.max(width, 1)))
      rect.setAttribute('height', String(Math.max(height, 1)))
      rect.setAttribute('fill', 'none')
      rect.setAttribute('stroke', region.color)
      // 屏幕空间绘制 => 线宽恒定,不会随缩放变成一片色块。
      // 选中就加粗一倍:框本身已经占掉了颜色这个维度,线宽是唯一不用新配色
      // 又能一眼看出来的信号
      rect.setAttribute('stroke-width', selected ? '4' : '2')
      fragment.appendChild(rect)

      if (region.id === soleSelected) {
        const right = x + width
        const bottom = y + height
        for (const id of HANDLE_IDS) {
          const hx = id.includes('w') ? x : id.includes('e') ? right : (x + right) / 2
          const hy = id.includes('n') ? y : id.includes('s') ? bottom : (y + bottom) / 2
          fragment.appendChild(handle(hx, hy, region.color, HANDLE_SIZE))
          handlePoints.push({ id, x: hx, y: hy })
        }
      } else {
        // 角上画小方块,便于在框很小时也能看见
        fragment.appendChild(handle(x, y, region.color, 5))
        fragment.appendChild(handle(x + width, y + height, region.color, 5))
      }
    }
    regionLayer.appendChild(fragment)
  }

  function drawDraft(transform: ReturnType<typeof imageToScreenTransform> & object) {
    draftLayer.replaceChildren()
    if (!draft) return

    const x = transform.x(draft.x)
    const y = transform.y(draft.y)
    const width = transform.x(draft.x + draft.w) - x
    const height = transform.y(draft.y + draft.h) - y

    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', String(Math.min(x, x + width)))
    rect.setAttribute('y', String(Math.min(y, y + height)))
    rect.setAttribute('width', String(Math.abs(width)))
    rect.setAttribute('height', String(Math.abs(height)))
    rect.setAttribute('fill', 'rgba(255, 77, 79, 0.12)')
    rect.setAttribute('stroke', '#ff4d4f')
    rect.setAttribute('stroke-width', '2')
    rect.setAttribute('stroke-dasharray', '5 3')
    draftLayer.appendChild(rect)
  }

  function line(
    x1: number,
    y1: number | string,
    x2: number | string,
    y2: number | string,
    color: string,
    opacity: number,
  ): SVGLineElement {
    const element = document.createElementNS(SVG_NS, 'line')
    element.setAttribute('x1', String(x1))
    element.setAttribute('y1', String(y1))
    element.setAttribute('x2', String(x2))
    element.setAttribute('y2', String(y2))
    element.setAttribute('stroke', color)
    element.setAttribute('stroke-width', '1')
    element.setAttribute('stroke-opacity', String(opacity))
    // 让 1px 细线不被抗锯齿糊成 2px 灰线
    element.setAttribute('shape-rendering', 'crispEdges')
    return element
  }

  function handle(cx: number, cy: number, color: string, size: number): SVGRectElement {
    const element = document.createElementNS(SVG_NS, 'rect')
    element.setAttribute('x', String(cx - size / 2))
    element.setAttribute('y', String(cy - size / 2))
    element.setAttribute('width', String(size))
    element.setAttribute('height', String(size))
    element.setAttribute('fill', color)
    return element
  }

  function gridScaleLabel(step: number): SVGTextElement {
    const element = document.createElementNS(SVG_NS, 'text')
    element.setAttribute('x', '8')
    element.setAttribute('y', '16')
    element.setAttribute('fill', grid.color)
    element.setAttribute('font-size', '11')
    element.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    element.setAttribute('opacity', '0.85')
    element.textContent = `网格 ${step} px`
    return element
  }

  function clearLayers() {
    gridLayer?.replaceChildren()
    guideLayer?.replaceChildren()
    regionLayer?.replaceChildren()
    draftLayer?.replaceChildren()
    // 图层空了,手柄也跟着没了 —— 不清的话命中检测还在按旧位置响应
    handlePoints = []
  }

  function destroy() {
    teardown.forEach((fn) => fn())
    teardown.length = 0
    svg?.remove()
    svg = null
  }

  onBeforeUnmount(destroy)

  return {
    mount,
    destroy,
    draw,
    /** 当前生效的网格间距,供状态栏显示 */
    currentGridStep: () => effectiveStep,
    setRegions(next: Region[]) {
      regions = next
      draw()
    },
    setSelection(next: Set<string>) {
      selection = next
      draw()
    },
    setHandlesVisible(next: boolean) {
      handlesVisible = next
      draw()
    },
    /** 屏幕坐标(相对 viewer.element 左上角)下是哪个手柄。不在手柄上返回 null。 */
    handleAt(x: number, y: number): HandleId | null {
      const reach = HANDLE_SIZE / 2 + HANDLE_SLOP
      for (const point of handlePoints) {
        if (Math.abs(x - point.x) <= reach && Math.abs(y - point.y) <= reach) {
          return point.id
        }
      }
      return null
    },
    setGuides(next: Guide[]) {
      guides = next
      draw()
    },
    setDraft(next: Rect | null) {
      draft = next
      draw()
    },
    setGrid(next: Partial<GridState>) {
      grid = { ...grid, ...next }
      draw()
    },
  }
}
