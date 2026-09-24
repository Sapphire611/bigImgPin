/**
 * 图像坐标 ↔ 屏幕坐标换算的**唯一出口**。
 *
 * 三条硬规则,违反了就会出微妙的偏移:
 *
 * 1. 一律用 `TiledImage` 上的方法,不要用 `viewer.viewport` 上的同名方法。
 *    Viewport 版本在多图场景下不准确(OpenSeadragon 源码里会 console.error
 *    提示改用 TiledImage 版本),而且不会告诉你算错了,只是位置偏一点。
 *
 * 2. 屏幕坐标是**相对 viewer.element 左上角**的像素,不是 clientX/clientY。
 *    调用方负责减去 bounding rect。
 *
 * 3. OpenSeadragon 的 "zoom" 不是百分比,而是「整图宽度对应多少个 viewport 单位」。
 *    zoom = 1 表示整图铺满容器宽度,跟 100% 完全不是一回事。要用
 *    `imageToViewportZoom(1)` 才是真正的 1:1。
 */
import OpenSeadragon from 'openseadragon'
import { ref, watch } from 'vue'

import type { Rect } from '../types'

/** 取第一张(也是唯一一张)切片图层。没有图像时返回 null。 */
export function firstTile(viewer: OpenSeadragon.Viewer): OpenSeadragon.TiledImage | null {
  return viewer.world.getItemCount() > 0 ? viewer.world.getItemAt(0) : null
}

/** 屏幕像素(相对 viewer.element)→ 图像像素。 */
export function screenToImage(
  viewer: OpenSeadragon.Viewer,
  screenX: number,
  screenY: number,
): { x: number; y: number } | null {
  const tile = firstTile(viewer)
  if (!tile) return null

  const point = tile.viewerElementToImageCoordinates(
    new OpenSeadragon.Point(screenX, screenY),
  )
  return { x: point.x, y: point.y }
}

/** 图像像素 → 屏幕像素(相对 viewer.element)。 */
export function imageToScreen(
  viewer: OpenSeadragon.Viewer,
  imageX: number,
  imageY: number,
): { x: number; y: number } | null {
  const tile = firstTile(viewer)
  if (!tile) return null

  const point = tile.imageToViewerElementCoordinates(
    new OpenSeadragon.Point(imageX, imageY),
  )
  return { x: point.x, y: point.y }
}

/** 当前可见区域对应的图像像素矩形。用于裁剪网格、剔除不可见的框。 */
export function visibleImageRect(viewer: OpenSeadragon.Viewer): Rect | null {
  const tile = firstTile(viewer)
  if (!tile) return null

  const bounds = tile.viewportToImageRectangle(viewer.viewport.getBounds())
  return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
}

/**
 * 图像 → 屏幕的线性映射参数。
 *
 * 无旋转时这个映射是等比加平移,所以只要两个点就能确定整个变换。
 * 叠加层每帧要转换几十个坐标,取一次参数比逐个调 API 快得多。
 */
export interface ImageToScreenTransform {
  originX: number
  originY: number
  scaleX: number
  scaleY: number
  /** 图像 x → 屏幕 x */
  x: (imageX: number) => number
  /** 图像 y → 屏幕 y */
  y: (imageY: number) => number
}

export function imageToScreenTransform(
  viewer: OpenSeadragon.Viewer,
): ImageToScreenTransform | null {
  const tile = firstTile(viewer)
  if (!tile) return null

  const origin = tile.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0))
  const unitX = tile.imageToViewerElementCoordinates(new OpenSeadragon.Point(1, 0))
  const unitY = tile.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 1))

  const scaleX = unitX.x - origin.x
  const scaleY = unitY.y - origin.y

  return {
    originX: origin.x,
    originY: origin.y,
    scaleX,
    scaleY,
    x: (imageX: number) => origin.x + imageX * scaleX,
    y: (imageY: number) => origin.y + imageY * scaleY,
  }
}

/** 图像 1 像素 = 屏幕 1 像素 所对应的 zoom 值。 */
export function oneToOneZoom(viewer: OpenSeadragon.Viewer): number | null {
  const tile = firstTile(viewer)
  if (!tile) return null
  return tile.imageToViewportZoom(1)
}

/** 当前缩放百分比。1.0 表示 1:1。 */
export function zoomRatio(viewer: OpenSeadragon.Viewer): number | null {
  const tile = firstTile(viewer)
  if (!tile) return null
  return tile.viewportToImageZoom(viewer.viewport.getZoom(true))
}

/** 图像矩形 → viewport 归一化矩形。 */
export function imageToViewportRect(
  viewer: OpenSeadragon.Viewer,
  rect: Rect,
): OpenSeadragon.Rect | null {
  const tile = firstTile(viewer)
  if (!tile) return null

  return tile.imageToViewportRectangle(
    new OpenSeadragon.Rect(rect.x, rect.y, rect.w, rect.h),
  )
}

/** 把图像坐标下的矩形夹到图像边界内,并归一化负的宽高。 */
export function clampRect(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  // 拖拽可能从右下往左上拉,导致 w/h 为负
  const x0 = Math.min(rect.x, rect.x + rect.w)
  const y0 = Math.min(rect.y, rect.y + rect.h)
  const x1 = Math.max(rect.x, rect.x + rect.w)
  const y1 = Math.max(rect.y, rect.y + rect.h)

  const cx0 = Math.max(0, Math.min(x0, imageWidth))
  const cy0 = Math.max(0, Math.min(y0, imageHeight))
  const cx1 = Math.max(0, Math.min(x1, imageWidth))
  const cy1 = Math.max(0, Math.min(y1, imageHeight))

  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 }
}

/**
 * 坐标的小数位数。**默认 0,也就是整数**。
 *
 * 目标图是版图、显微这类整数坐标系里的东西:拖动时反算出来的 1234.57 只是
 * 屏幕坐标的副产品,既读不出来也没有意义,却会一路带进列表、输入框和导出表格。
 *
 * 这个值**同时管三件事**:显示、新框的坐标收敛、导出 CSV 的位数。
 * 拆开管就会出现「屏幕上写 1235、文件里存 1234.57、导出来又是 1234.57」——
 * 三处对不上,人就没法信任何一处。
 *
 * 存 localStorage 而不是走 Rust:标注文件里存的是**已经收敛过的**值,
 * 这个设置本身不影响任何落盘数据,纯粹是界面偏好,和主题一个性质。
 * 改小位数不会回头改动已有的框(谁被拖过谁就吸附过来)。
 */
const DECIMALS_KEY = 'bigimgpin.coordDecimals'

/** 上限。再多对像素坐标没有意义 —— 屏幕上根本读不出来。 */
export const COORD_DECIMALS_MAX = 3

function readDecimals(): number {
  const saved = Number.parseInt(localStorage.getItem(DECIMALS_KEY) ?? '', 10)
  const valid = Number.isInteger(saved) && saved >= 0 && saved <= COORD_DECIMALS_MAX
  return valid ? saved : 0
}

export const coordDecimals = ref(readDecimals())

// 谁改都自动落盘,不必让每个写入点自己记得存一次
watch(coordDecimals, (value) => localStorage.setItem(DECIMALS_KEY, String(value)))

/**
 * 按当前精度收敛一个坐标值。
 *
 * 用 `toFixed` 而不是 `Math.round(v * 10^n) / 10^n`:后者会引入二进制浮点误差,
 * 比如 1.005 会变成 1.00。
 */
export function roundCoord(value: number): number {
  return Number(value.toFixed(coordDecimals.value))
}

/** 把一个矩形按当前精度收敛。所有框在进入列表前都要过这一关。 */
export function roundRect(rect: Rect): Rect {
  return {
    x: roundCoord(rect.x),
    y: roundCoord(rect.y),
    w: roundCoord(rect.w),
    h: roundCoord(rect.h),
  }
}

/**
 * 显示用格式化:去掉尾随的 0。
 * 位数 2 时 100 → "100"、100.25 → "100.25";位数 0 时 1234.57 → "1235"。
 */
export function formatCoord(value: number): string {
  return String(roundCoord(value))
}

// ---------------------------------------------------------------- 缩放手柄

/** 八个缩放手柄。n/s/e/w 是四条边,组合起来是四个角。 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** 手柄 → 鼠标指针形状。 */
export const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

/**
 * 拖某个手柄改变矩形。`dx/dy` 是相对**按下那一刻**的位移(图像像素)。
 *
 * 全程在**四条边**上做,最后才由边求宽高 —— 不能对 x 和 w 各自取整:
 * 那样原始右边界被舍入了两次,拖左边的时候右边会跟着跳一格。
 * 用户拖的是左边,右边一动就说明这个工具连「哪条边被拖了」都没搞清。
 *
 * 宽高不会变成负数:拖过头就停在最小尺寸上,而不是让框翻过来。翻过来的话,
 * 屏幕上看还是那么一个框,数值却换成了一组相反的边界 —— 在按坐标办事的场景里,
 * 「看着没变、数值变了」是最难查的一类问题。
 *
 * 最小尺寸取当前精度的一格(位数 0 时就是 1px):再小 `roundRect` 就会把它
 * 收敛成一个零宽或零高的框,那已经不是一个框了。
 */
export function resizeRect(origin: Rect, handle: HandleId, dx: number, dy: number): Rect {
  const min = 10 ** -coordDecimals.value

  let left = roundCoord(origin.x)
  let right = roundCoord(origin.x + origin.w)
  let top = roundCoord(origin.y)
  let bottom = roundCoord(origin.y + origin.h)

  if (handle.includes('w')) left = roundCoord(origin.x + dx)
  if (handle.includes('e')) right = roundCoord(origin.x + origin.w + dx)
  if (handle.includes('n')) top = roundCoord(origin.y + dy)
  if (handle.includes('s')) bottom = roundCoord(origin.y + origin.h + dy)

  // 撞到下限时把**被拖的那条边**钉在距对边一格的位置:用户拖的是这条边,
  // 让它停下来就行,对面那条不该动。
  if (right - left < min) {
    if (handle.includes('w')) left = right - min
    else right = left + min
  }
  if (bottom - top < min) {
    if (handle.includes('n')) top = bottom - min
    else bottom = top + min
  }

  // 两条边都收敛过,差值还要再收敛一次:1.1 - 0.1 在浮点里是 1.0000000000000002
  return {
    x: left,
    y: top,
    w: roundCoord(right - left),
    h: roundCoord(bottom - top),
  }
}
