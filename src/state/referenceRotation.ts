/**
 * PCS / 缺陷参考层的手动旋转。
 *
 * 参考层坐标来自 gerber,而扫描图的摆放方向不一定和它一致(实测 productSerial
 * 下就有 productRotation=90/270 的产品,也有元数据写 0 但图片实际转了 90° 的)。
 * 旋转只作用于**参考层**,图片和用户自己的标注都不动 —— 目的就是让框能手动
 * 对到图上的实际位置。旋转中心取 gerber 画布中心,不是图片中心,原因见
 * `rotateReferenceRect` 的注释。
 *
 * 角度按源图路径分别记:同一张图重开还在,换一张图不会把上一个产品的角度
 * 带过来(那种「什么都没改框却全歪了」很难查)。
 */
import { ref } from 'vue'

import type { Rect } from '../types'

const KEY = 'bigimgpin.referenceRotation'

/** 只支持 90° 的整数倍:轴对齐矩形转完还是轴对齐矩形,绘制和命中都简单。 */
export type QuarterTurn = 0 | 90 | 180 | 270

function normalize(value: number): QuarterTurn {
  const wrapped = ((value % 360) + 360) % 360
  return (Math.round(wrapped / 90) * 90) % 360 as QuarterTurn
}

function read(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [path, value] of Object.entries(saved)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[path] = normalize(value)
    }
    return out
  } catch {
    // 存坏了就当没存过,不值得为它拦住启动
    return {}
  }
}

let savedAngles = read()

/** 当前参考层的旋转角(度),正角在 y 向下的图像坐标里是顺时针。 */
export const referenceRotation = ref<QuarterTurn>(0)

/** 打开图片时调用。没有记录就是 0。 */
export function setReferenceRotationFor(path: string | null) {
  referenceRotation.value = path ? normalize(savedAngles[path] ?? 0) : 0
}

/** 转一下并记到当前图路径上。`delta` 是 -90 / +90,或传当前角度的相反数复位。 */
export function rotateReferenceBy(path: string | null, delta: number) {
  referenceRotation.value = normalize(referenceRotation.value + delta)
  if (!path) return
  savedAngles = { ...savedAngles, [path]: referenceRotation.value }
  localStorage.setItem(KEY, JSON.stringify(savedAngles))
}

/**
 * 把参考层矩形从 gerber 坐标画布旋转到图像坐标。
 *
 * **旋转中心是参考画布的中心**(`gerber_size × panel_scale`),不是图片中心:
 * 有的产品图片本身就是 gerber 转了 90°,此时图片宽高和画布宽高互换,
 * 两个中心根本不是同一个点(2866216B01 就是 3164×9664 的画布配 9664×3164 的图)。
 * 90/270 转完坐标落在 H×W 的画布里,正好对应那张旋转过的图片。
 *
 * 只支持 90° 的整数倍,直接写死公式:一帧要转上千个框(缺陷),不走三角函数
 * 也不建临时数组。
 */
export function rotateReferenceRect(
  rect: Rect,
  degrees: number,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  const angle = normalize(degrees)
  if (angle === 0) return rect

  switch (angle) {
    case 90:
      // (x, y) → (H - y, x)
      return { x: canvasHeight - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w }
    case 180:
      return {
        x: canvasWidth - rect.x - rect.w,
        y: canvasHeight - rect.y - rect.h,
        w: rect.w,
        h: rect.h,
      }
    default:
      // (x, y) → (y, W - x)
      return { x: rect.y, y: canvasWidth - rect.x - rect.w, w: rect.h, h: rect.w }
  }
}

/**
 * 画布上点中的坐标 → 参考层的原始坐标(rotateReferenceRect 的逆变换)。
 * 缺陷命中判定要用:框是转着画的,点击也得先转回去才能和原始 ROI 比。
 */
export function pointToReference(
  x: number,
  y: number,
  degrees: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const angle = normalize(degrees)
  if (angle === 0) return { x, y }

  switch (angle) {
    case 90:
      return { x: y, y: canvasHeight - x }
    case 180:
      return { x: canvasWidth - x, y: canvasHeight - y }
    default:
      return { x: canvasWidth - y, y: x }
  }
}
