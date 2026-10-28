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
 *
 * 选中缺陷时还会从框边拉一条引线,线头挂一张缺陷图。图也画在这层 SVG 上:
 * 位置必须跟着框走,而框的屏幕坐标只有这一层每帧算得出来;用 DOM 浮层又要
 * 另写一份坐标换算,迟早和框对不上。
 */
import { onBeforeUnmount } from 'vue'
import OpenSeadragon from 'openseadragon'

import type { Defect, DefectImageState, Guide, PcsBox, Rect, Region } from '../types'
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

/**
 * PCS 按 tid 配色。选的都是亮色 —— 它们画在版图照片上,不是画在界面底色上,
 * 判断依据只有「在深绿/深蓝的板子上能不能一眼看见」。
 * 和标注的 PALETTE 刻意错开,避免参考框和用户自己画的框看起来是同一类东西。
 */
const PCS_COLORS = ['#ffd666', '#36cfc9', '#ff85c0', '#91d5ff']

/**
 * 缺陷框:板内缺陷红色,面板级「全局点」琥珀色。
 * 两者都是只读参考,颜色只用来区分来源,不抢标注框的注意力。
 */
const DEFECT_COLOR = '#ff4d4f'
const DEFECT_GLOBAL_COLOR = '#ffa940'

/**
 * 缺陷图浮标的边长(屏幕像素),随缩放按比例缩小。
 * 缩到看整版时还挂一张大图会盖住大半张版图,所以下限压到 48;
 * 放大到 1:1 以上就封顶在 200,不跟着无限变大。
 */
const CALLOUT_MAX_SIZE = 200
const CALLOUT_MIN_SIZE = 48
/** 框和浮标之间的引线长度,同样随缩放收缩。 */
const CALLOUT_GAP = 20
const CALLOUT_MIN_GAP = 8
/** 浮标离画布边缘的最小距离。 */
const CALLOUT_MARGIN = 8
/** 浮标底色固定用深色:它压在图上面,和界面是深色还是浅色没关系。 */
const CALLOUT_BG = 'rgba(16, 18, 22, 0.94)'
const CALLOUT_TEXT = '#e8e8ea'

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
  let pcsLayer: SVGGElement
  let defectLayer: SVGGElement
  let guideLayer: SVGGElement
  let regionLayer: SVGGElement
  let draftLayer: SVGGElement
  let calloutLayer: SVGGElement

  let regions: Region[] = []
  let pcs: PcsBox[] = []
  let defects: Defect[] = []
  let selectedDefectId: string | null = null
  /** 选中缺陷的图片状态。由 App 在 Fetch 前后传进来,和 selectedDefectId 配对使用。 */
  let defectImage: DefectImageState | null = null
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
      // 必须裁到画布内。框是屏幕空间的,图被拖到只剩一角时框的屏幕坐标会跑到画布外;
      // 不裁的话它会浮在右侧列表上(z-index 比列表高),看着像画串了地方。
      // 反过来,超出画布的那部分框本来就看不见,被边缘切掉才是对的。
      'overflow:hidden',
    ].join(';'))

    gridLayer = document.createElementNS(SVG_NS, 'g')
    pcsLayer = document.createElementNS(SVG_NS, 'g')
    defectLayer = document.createElementNS(SVG_NS, 'g')
    guideLayer = document.createElementNS(SVG_NS, 'g')
    regionLayer = document.createElementNS(SVG_NS, 'g')
    draftLayer = document.createElementNS(SVG_NS, 'g')
    // 缺陷图浮标压在最上面:它是个提示,被框或辅助线盖住就没意义了
    calloutLayer = document.createElementNS(SVG_NS, 'g')
    // PCS / 缺陷都在标注下面:它们只是参考底图,用户画的框和辅助线要压在上面
    svg.append(
      gridLayer,
      pcsLayer,
      defectLayer,
      guideLayer,
      regionLayer,
      draftLayer,
      calloutLayer,
    )

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
    drawPcs(transform)
    drawDefects(transform, visible)
    drawGuides(transform)
    drawRegions(transform)
    drawDraft(transform)
    drawCallout(transform, visible)
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

  /**
   * PCS 分布:只读参考框 + 框中央的 PCS id。
   *
   * 线宽用 1.5 而不是和标注一样的 2:这两层会叠在一起,粗细一样就分不清
   * 哪个是文件里的、哪个是自己画的。文字用深色描边打底,是为了在亮色板面
   * (白色丝印、金属焊盘)上也能读出来 —— 只靠彩色 fill 会被背景吞掉。
   */
  function drawPcs(transform: ReturnType<typeof imageToScreenTransform> & object) {
    pcsLayer.replaceChildren()
    if (pcs.length === 0) return

    const fragment = document.createDocumentFragment()
    for (const box of pcs) {
      const x = transform.x(box.x)
      const y = transform.y(box.y)
      const width = transform.x(box.x + box.w) - x
      const height = transform.y(box.y + box.h) - y
      const color = PCS_COLORS[Math.abs(box.tid) % PCS_COLORS.length]

      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(Math.max(width, 1)))
      rect.setAttribute('height', String(Math.max(height, 1)))
      rect.setAttribute('fill', 'none')
      rect.setAttribute('stroke', color)
      rect.setAttribute('stroke-width', '1.5')
      rect.setAttribute('stroke-opacity', '0.9')
      fragment.appendChild(rect)

      const label = document.createElementNS(SVG_NS, 'text')
      label.setAttribute('x', String(x + width / 2))
      label.setAttribute('y', String(y + height / 2))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('dominant-baseline', 'central')
      label.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      label.setAttribute('font-size', '12')
      label.setAttribute('fill', color)
      label.setAttribute('stroke', 'rgba(0, 0, 0, 0.6)')
      label.setAttribute('stroke-width', '3')
      label.setAttribute('paint-order', 'stroke')
      label.textContent = String(box.id)
      fragment.appendChild(label)
    }
    pcsLayer.appendChild(fragment)
  }

  /**
   * 缺陷 ROI:未选中的全部并进**两个 `<path>`**(红/琥珀各一条),选中的单独画。
   *
   * 缺陷动辄几百上千个,如果每个都建一个 `<rect>`,平移时每帧要重建上千个
   * DOM 节点;一条 path 里放几百个矩形子路径,重绘成本基本只和顶点数有关。
   * 视野外的框直接跳过 —— 缩放到局部之后,每帧真正要画的往往只有个位数。
   *
   * 缺陷只读:这里只画框和「选中」高亮,没有手柄。
   */
  function drawDefects(
    transform: ReturnType<typeof imageToScreenTransform> & object,
    visible: Rect,
  ) {
    defectLayer.replaceChildren()
    if (defects.length === 0) return

    const normal: string[] = []
    const global: string[] = []
    let selected: Defect | null = null

    for (const defect of defects) {
      if (defect.id === selectedDefectId) {
        selected = defect
        continue
      }
      if (
        defect.x + defect.w < visible.x ||
        defect.x > visible.x + visible.w ||
        defect.y + defect.h < visible.y ||
        defect.y > visible.y + visible.h
      ) {
        continue
      }

      const x = transform.x(defect.x)
      const y = transform.y(defect.y)
      const right = transform.x(defect.x + defect.w)
      const bottom = transform.y(defect.y + defect.h)
      ;(defect.pcsKey === 0 ? global : normal).push(`M${x} ${y}H${right}V${bottom}H${x}Z`)
    }

    const fragment = document.createDocumentFragment()
    if (normal.length > 0) fragment.appendChild(defectPath(normal.join(''), DEFECT_COLOR))
    if (global.length > 0) {
      fragment.appendChild(defectPath(global.join(''), DEFECT_GLOBAL_COLOR))
    }

    if (selected) {
      const color = selected.pcsKey === 0 ? DEFECT_GLOBAL_COLOR : DEFECT_COLOR
      const x = transform.x(selected.x)
      const y = transform.y(selected.y)
      const width = transform.x(selected.x + selected.w) - x
      const height = transform.y(selected.y + selected.h) - y

      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(Math.max(width, 1)))
      rect.setAttribute('height', String(Math.max(height, 1)))
      rect.setAttribute('fill', color)
      rect.setAttribute('fill-opacity', '0.1')
      rect.setAttribute('stroke', color)
      rect.setAttribute('stroke-width', '3')
      fragment.appendChild(rect)

      // 只在选中时显示文字:几百个缺陷都挂标签会把 PCS 编号和版图一起盖住
      const label = document.createElementNS(SVG_NS, 'text')
      label.setAttribute('x', String(x))
      // 顶部空间不够就画进框里,免得标签被画布边缘切掉
      label.setAttribute('y', String(y > 16 ? y - 6 : y + 14))
      label.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      label.setAttribute('font-size', '12')
      label.setAttribute('fill', color)
      label.setAttribute('stroke', 'rgba(0, 0, 0, 0.65)')
      label.setAttribute('stroke-width', '3')
      label.setAttribute('paint-order', 'stroke')
      const pcsText = selected.pcsKey === 0 ? '全局点' : `PCS ${selected.pcsKey}`
      const labelText = selected.label ? `${selected.code} ${selected.label}` : selected.code
      label.textContent = `${pcsText} · ${labelText} · #${selected.defectIndex}`
      fragment.appendChild(label)
    }

    defectLayer.appendChild(fragment)
  }

  function defectPath(d: string, color: string): SVGPathElement {
    const element = document.createElementNS(SVG_NS, 'path')
    element.setAttribute('d', d)
    element.setAttribute('fill', 'none')
    element.setAttribute('stroke', color)
    element.setAttribute('stroke-width', '1')
    element.setAttribute('stroke-opacity', '0.85')
    return element
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

  /**
   * 选中缺陷的图片浮标:从框边拉一条引线,线头挂一张缺陷图。
   *
   * 卡片默认放在框的右上;右边放不下换左边,上面放不下换下面。最后再夹回画布,
   * 免得贴着边缘的缺陷把图挂到画布外面(SVG 是 overflow:hidden,那样就看不见了)。
   *
   * 引线两端分别取「框上离卡片最近的点」和「卡片上离框最近的点」,斜着连过去;
   * 这样无论卡片落在哪个方向,线都不会穿过卡片或从框中间冒出来。
   */
  function drawCallout(
    transform: ReturnType<typeof imageToScreenTransform> & object,
    visible: Rect,
  ) {
    calloutLayer.replaceChildren()
    if (!selectedDefectId) return

    const selected = defects.find((defect) => defect.id === selectedDefectId)
    if (!selected) return

    // 框完全在视野外时不画:引线没有起点,浮标钉在画布边缘只会让人以为框在那儿
    if (
      selected.x + selected.w < visible.x ||
      selected.x > visible.x + visible.w ||
      selected.y + selected.h < visible.y ||
      selected.y > visible.y + visible.h
    ) {
      return
    }

    const host = getContainer()
    const width = host?.clientWidth ?? 0
    const height = host?.clientHeight ?? 0
    if (width <= 0 || height <= 0) return

    const color = selected.pcsKey === 0 ? DEFECT_GLOBAL_COLOR : DEFECT_COLOR
    const boxX = transform.x(selected.x)
    const boxY = transform.y(selected.y)
    // 缩到很小时框会变成亚像素,给一个最小尺寸,不然引线的起点会抖
    const boxW = Math.max(transform.x(selected.x + selected.w) - boxX, 2)
    const boxH = Math.max(transform.y(selected.y + selected.h) - boxY, 2)
    const boxRight = boxX + boxW
    const boxBottom = boxY + boxH
    const boxCenterX = boxX + boxW / 2
    const boxCenterY = boxY + boxH / 2

    // 浮标跟着画面缩放一起变小。缩到看整版时还挂一张固定大图,会盖住半张版图;
    // 放大到 1:1 以上则封顶,不跟着无限长。
    const scale = Math.abs(transform.scaleX)
    const size = clampNumber(CALLOUT_MAX_SIZE * scale, CALLOUT_MIN_SIZE, CALLOUT_MAX_SIZE)
    const gap = clampNumber(CALLOUT_GAP * scale, CALLOUT_MIN_GAP, CALLOUT_GAP)

    const roomRight = boxRight + gap + size <= width - CALLOUT_MARGIN
    const cardOnRight = roomRight || boxCenterX < width / 2
    let cardLeft = cardOnRight ? boxRight + gap : boxX - gap - size

    const roomAbove = boxY - gap - size >= CALLOUT_MARGIN
    const roomBelow = boxBottom + gap + size <= height - CALLOUT_MARGIN
    let cardTop = roomAbove ? boxY - gap - size : boxBottom + gap
    if (!roomAbove && !roomBelow) {
      // 上下都放不下(框很大或画布很矮):优先放下面,再夹回画布
      cardTop = boxBottom + gap
    }

    cardLeft = clampNumber(
      cardLeft,
      CALLOUT_MARGIN,
      Math.max(CALLOUT_MARGIN, width - size - CALLOUT_MARGIN),
    )
    cardTop = clampNumber(
      cardTop,
      CALLOUT_MARGIN,
      Math.max(CALLOUT_MARGIN, height - size - CALLOUT_MARGIN),
    )
    const cardRight = cardLeft + size
    const cardBottom = cardTop + size

    // 框上离卡片中心最近的点 / 卡片上离框中心最近的点
    const anchorX = clampNumber(cardLeft + size / 2, boxX, boxRight)
    const anchorY = clampNumber(cardTop + size / 2, boxY, boxBottom)
    const tipX = clampNumber(boxCenterX, cardLeft, cardRight)
    const tipY = clampNumber(boxCenterY, cardTop, cardBottom)

    const fragment = document.createDocumentFragment()

    // 深色描边垫底:版图背景有深有浅,单靠彩色细线在浅色区域会糊掉
    const halo = document.createElementNS(SVG_NS, 'line')
    halo.setAttribute('x1', String(anchorX))
    halo.setAttribute('y1', String(anchorY))
    halo.setAttribute('x2', String(tipX))
    halo.setAttribute('y2', String(tipY))
    halo.setAttribute('stroke', 'rgba(0, 0, 0, 0.55)')
    halo.setAttribute('stroke-width', '4')
    fragment.appendChild(halo)

    const leader = document.createElementNS(SVG_NS, 'line')
    leader.setAttribute('x1', String(anchorX))
    leader.setAttribute('y1', String(anchorY))
    leader.setAttribute('x2', String(tipX))
    leader.setAttribute('y2', String(tipY))
    leader.setAttribute('stroke', color)
    leader.setAttribute('stroke-width', '1.5')
    fragment.appendChild(leader)

    const dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('cx', String(anchorX))
    dot.setAttribute('cy', String(anchorY))
    dot.setAttribute('r', '3')
    dot.setAttribute('fill', color)
    fragment.appendChild(dot)

    const card = document.createElementNS(SVG_NS, 'rect')
    card.setAttribute('x', String(cardLeft))
    card.setAttribute('y', String(cardTop))
    card.setAttribute('width', String(size))
    card.setAttribute('height', String(size))
    card.setAttribute('rx', '4')
    card.setAttribute('fill', CALLOUT_BG)
    card.setAttribute('stroke', color)
    card.setAttribute('stroke-width', '1.5')
    fragment.appendChild(card)

    const current = defectImage?.defectId === selected.id ? defectImage : null
    if (current?.status === 'ready' && current.dataUrl) {
      const image = document.createElementNS(SVG_NS, 'image')
      image.setAttribute('x', String(cardLeft + 2))
      image.setAttribute('y', String(cardTop + 2))
      image.setAttribute('width', String(size - 4))
      image.setAttribute('height', String(size - 4))
      image.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      image.setAttribute('href', current.dataUrl)
      fragment.appendChild(image)
    } else {
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', String(cardLeft + size / 2))
      text.setAttribute('y', String(cardTop + size / 2))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'central')
      text.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      text.setAttribute('font-size', '10')
      text.setAttribute('fill', current?.status === 'error' ? '#ff7875' : CALLOUT_TEXT)
      // 卡片会缩到 48px,太长的文案放不下
      text.textContent = current?.status === 'error' ? '加载失败' : '读取中…'
      fragment.appendChild(text)
    }

    calloutLayer.appendChild(fragment)
  }

  function clampNumber(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
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
    pcsLayer?.replaceChildren()
    defectLayer?.replaceChildren()
    guideLayer?.replaceChildren()
    regionLayer?.replaceChildren()
    draftLayer?.replaceChildren()
    calloutLayer?.replaceChildren()
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
    setPcs(next: PcsBox[]) {
      pcs = next
      draw()
    },
    /** 缺陷和选中项一起传:选中变化只触发一次重绘 */
    setDefects(next: Defect[], selectedId: string | null) {
      defects = next
      selectedDefectId = selectedId
      draw()
    },
    /**
     * 缺陷图片状态。必须和 setDefects 的 selectedId 配对使用 ——
     * 浮标只在两边都指向同一条缺陷时才画出来。
     */
    setDefectImage(next: DefectImageState | null) {
      defectImage = next
      draw()
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
