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
 * 像素坐标的精度上限:**2 位小数**。
 *
 * 框的坐标是连续量 —— 从屏幕坐标反算回来时会带一长串浮点噪声
 * (比如 123.45678901234567)。这些位数既读不出来也没有意义,还会让
 * 「填入输入框」这种操作把一大堆垃圾数字倒进表单。统一收敛到 2 位。
 *
 * 用 `toFixed` 而不是 `Math.round(v * 100) / 100`:后者会引入二进制浮点误差,
 * 比如 1.005 会变成 1.00。
 */
export function round2(value: number): number {
  return Number(value.toFixed(2))
}

/** 把一个矩形收敛到 2 位小数。所有框在进入列表前都要过这一关。 */
export function roundRect(rect: Rect): Rect {
  return {
    x: round2(rect.x),
    y: round2(rect.y),
    w: round2(rect.w),
    h: round2(rect.h),
  }
}

/**
 * 显示用格式化:去掉尾随的 0。
 * 100.00 → "100",100.25 → "100.25"
 */
export function formatCoord(value: number): string {
  return String(round2(value))
}
