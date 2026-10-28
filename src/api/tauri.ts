/** Rust 命令与事件的类型化封装。前端不直接 import invoke。 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { check } from '@tauri-apps/plugin-updater'

import type {
  CropOutcome,
  CropProgress,
  DefectImageResult,
  DefectSet,
  ExportRect,
  Guide,
  LoadedAnnotations,
  PcsLayout,
  PreparedImage,
  Region,
  SaveOutcome,
  SliceParams,
  TileProgress,
  VipsInfo,
  VipsStatus,
} from '../types'

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

// ---------------------------------------------------------------- PCS 分布

/**
 * 读源图同级的 `<图名>.json`。没有同名文件时返回 null —— 多数图本来就没有,
 * 那不是错误。文件在但解析失败才会 reject。
 */
export function loadPcsLayout(path: string): Promise<PcsLayout | null> {
  return invoke<PcsLayout | null>('load_pcs_layout', { path })
}

// ---------------------------------------------------------------- 缺陷

/**
 * 读拖入的缺陷结果 JSON。
 *
 * `panelScale` 必须来自当前已加载的 PCS 布局 —— 缺陷 ROI 和 PCS 用的是
 * 同一套 gerber 坐标,只有乘同一个系数才能落在图上。
 */
export function loadDefects(path: string, panelScale: number): Promise<DefectSet> {
  return invoke<DefectSet>('load_defects', { path, panelScale })
}

/**
 * 从 MinIO 取一张缺陷图。
 *
 * 走 Rust 而不是前端 fetch:zip 内图片需要 `x-minio-extract` 请求头,`<img>` 设不了;
 * 顺带也绕开 WebView 的 CORS 差异。`prefixes` / `bases` 都是候选,命中为止,
 * 返回值里带着实际命中的那一组,前端可以缓存。
 */
export function fetchDefectImage(
  image: string,
  bucket: string,
  prefixes: string[],
  bases: string[],
): Promise<DefectImageResult> {
  return invoke<DefectImageResult>('fetch_defect_image', { image, bucket, prefixes, bases })
}

// ---------------------------------------------------------------- 标注

/** 读回源图旁边的标注文件。没有文件是正常情况(doc 为 null)。 */
export function loadAnnotations(path: string): Promise<LoadedAnnotations> {
  return invoke<LoadedAnnotations>('load_annotations', { path })
}

/**
 * 写标注。尺寸要一起送过去 —— 文件里要记住这份标注是贴着多大的图存的,
 * 换了图才能发现。
 */
export function saveAnnotations(
  path: string,
  width: number,
  height: number,
  regions: Region[],
  guides: Guide[],
): Promise<SaveOutcome> {
  return invoke<SaveOutcome>('save_annotations', { path, width, height, regions, guides })
}

// ---------------------------------------------------------------- 导出

/**
 * 导出框坐标 CSV。返回实际写入的路径;用户取消对话框则返回 null。
 *
 * `decimals` 只影响**打印几位** —— 数值是前端按同一精度收敛好才送过来的,
 * 所以两边的舍入规则不会打架。
 */
export function exportRegionsCsv(
  source: string,
  rects: ExportRect[],
  decimals: number,
): Promise<string | null> {
  return invoke<string | null>('export_regions_csv', { source, rects, decimals })
}

/** 裁剪每个框里的图像到一个目录。返回 null 表示用户取消了选目录。 */
export function exportCrops(source: string, rects: ExportRect[]): Promise<CropOutcome | null> {
  return invoke<CropOutcome | null>('export_crops', { source, rects })
}

export function onCropProgress(
  handler: (progress: CropProgress) => void,
): Promise<UnlistenFn> {
  return listen<CropProgress>('crop-progress', (event) => handler(event.payload))
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

// ---------------------------------------------------------------- 更新

/**
 * 一个已发现的新版本。
 *
 * 拆成 download / install 两步而不是用插件的 downloadAndInstall,
 * 是为了让下载在后台静默完成,等用户点了才安装 —— 安装会直接退出当前进程。
 */
export interface AvailableUpdate {
  version: string
  currentVersion: string
  /** 更新说明,可能为空 */
  notes: string
  /** 静默下载。onProgress 的百分比在服务器没报总大小时为 null。 */
  download(onProgress: (percent: number | null, downloadedBytes: number) => void): Promise<void>
  /** 安装并重启。Windows 上调用后当前进程直接退出,安装器装完会把新版拉起来。 */
  install(): Promise<void>
}

/** 已是最新版时返回 null。 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check()
  if (!update) return null

  let downloadedBytes = 0
  let totalBytes: number | null = null

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? '',
    async download(onProgress) {
      try {
        await update.download((event) => {
          if (event.event === 'Started') {
            totalBytes = event.data.contentLength ?? null
          } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength
            onProgress(
              totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null,
              downloadedBytes,
            )
          }
        })
      } catch (error) {
        // 失败时把 Rust 侧那份已下载的数据放掉,否则反复重试会一直堆着
        await update.close()
        throw error
      }
    },
    install: () => update.install(),
  }
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
