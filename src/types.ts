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
  /** 名字。界面上还没地方填,但标注文件格式里已经占住了这个字段。 */
  name?: string
}

/** 辅助线:固定在某条图像坐标上的横线或竖线。 */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  color: string
}

// ---------------------------------------------------------------- 标注文件

/** 这份标注是贴着哪张图存的,用于判断换个图之后还能不能贴上去。 */
export interface AnnotationSource {
  path: string
  width: number
  height: number
  /** 源文件字节数 */
  size: number
  /** 源文件修改时间(Unix 秒)。只存不判 —— 拷贝文件会改 mtime。 */
  mtime: number
}

/** 标注文件的结构。与 Rust 侧 `annotations::AnnotationDoc` 一一对应。 */
export interface AnnotationDoc {
  version: number
  source: AnnotationSource
  regions: Region[]
  guides: Guide[]
}

export interface LoadedAnnotations {
  /** 没有标注文件时为 null —— 第一次打开本来就没有,不是错误。 */
  doc: AnnotationDoc | null
  filePath: string | null
  /** 标注和当前图对不上时的说明。对不上不阻止加载,但要说清楚。 */
  mismatch: string | null
  /**
   * 文件在、但读不了(JSON 坏了 / 版本更高)。
   * 此时**必须停用自动保存**,否则第一次改动就把用户的文件覆盖了。
   */
  failure: string | null
}

export interface SaveOutcome {
  filePath: string
  /** true 表示没能写到源图旁边,退到了应用数据目录。 */
  fallback: boolean
}

export type ToolMode = 'pan' | 'draw'
