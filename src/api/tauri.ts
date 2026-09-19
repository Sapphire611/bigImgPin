/** Rust 命令与事件的类型化封装。前端不直接 import invoke。 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { PreparedImage, SliceParams, TileProgress, VipsInfo, VipsStatus } from '../types'

/** vips 不可用时 reject,错误信息里带安装指引。 */
export function vipsInfo(): Promise<VipsInfo> {
  return invoke<VipsInfo>('vips_info')
}

/** 打开文件对话框。返回绝对路径,取消则返回 null。 */
export function pickImage(): Promise<string | null> {
  return invoke<string | null>('pick_image')
}

/** 命中缓存则秒回,否则切片(可能几分钟)。 */
export function prepareImage(
  path: string,
  params?: SliceParams,
): Promise<PreparedImage> {
  return invoke<PreparedImage>('prepare_image', { path, params })
}

export function cancelSlicing(): Promise<void> {
  return invoke<void>('cancel_slicing')
}

/** 返回 [总字节数, 图片数量]。 */
export function cacheStats(): Promise<[number, number]> {
  return invoke<[number, number]>('cache_stats')
}

export function clearCache(): Promise<void> {
  return invoke<void>('clear_cache')
}

export function onTileProgress(
  handler: (progress: TileProgress) => void,
): Promise<UnlistenFn> {
  return listen<TileProgress>('tile-progress', (event) => handler(event.payload))
}

export function onVipsStatus(
  handler: (status: VipsStatus) => void,
): Promise<UnlistenFn> {
  return listen<VipsStatus>('vips-status', (event) => handler(event.payload))
}

/** 人类可读的字节数。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
