/** 与 Rust 侧 `commands::PreparedImage` 一一对应。 */
export interface PreparedImage {
  id: string
  sourcePath: string
  width: number
  height: number
  tileSize: number
  tileOverlap: number
  /** 瓦片扩展名,不含点。OpenSeadragon 的 fileFormat 用的就是它。 */
  fileFormat: string
  /** 已含平台前缀、结尾带 `/` */
  tilesUrl: string
  fromCache: boolean
  tileCountEstimate: number
  cacheBytes: number
}

export interface TileProgress {
  id: string
  percent: number
  tilesDone: number
  tilesTotal: number
  phase: 'slicing' | 'done'
}

/**
 * `vips_info` 命令**成功**时的返回。
 *
 * 找不到 vips 是通过 Promise reject 表达的(对应 Rust 的 `Result::Err`),
 * 所以这里没有 `available` 字段 —— 拿到这个对象就意味着可用。
 */
export interface VipsInfo {
  version: string
  path: string
  hasDzsave: boolean
  headerPath: string | null
}

/**
 * 统一的可用性状态。
 *
 * 有两条来源(启动时的 `vips-status` 事件、以及主动调用的 `vips_info`),
 * 两者形状不同,所以在 App 层归一成这一个结构再用。
 */
export interface VipsStatus {
  available: boolean
  version?: string
  path?: string
  hasDzsave?: boolean
  message?: string
}

/** 切片参数。留空用 Rust 侧默认值(1024 / WebP 无损)。 */
export interface SliceParams {
  tileSize?: number
  /** 仅 JPEG 用得上 */
  quality?: number
  tileFormat?: 'jpg' | 'png' | 'webp'
}

/** 图像像素坐标下的矩形。 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Region extends Rect {
  id: string
  color: string
}

/** 辅助线:固定在某条图像坐标上的横线或竖线。 */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  color: string
}

export type ToolMode = 'pan' | 'draw'
