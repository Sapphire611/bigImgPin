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

// ---------------------------------------------------------------- PCS 分布

/**
 * 源图同级 JSON 里的一个 PCS。坐标已经乘过 `panelScale`,是图像像素。
 *
 * 与 `Region` 的区别不只是少个颜色:它来自上游文件、只读,不参与标注的
 * 撤销和落盘,所以单独一个类型,不和 Region 混用。
 */
export interface PcsBox extends Rect {
  /** `single_pcs_list[].id`,画在框中间的数字 */
  id: number
  /** 所属的料/拼板编号,用来配色 */
  tid: number
}

export interface PcsLayout {
  panelScale: number
  pcs: PcsBox[]
}

// ---------------------------------------------------------------- 缺陷

/**
 * 从拖入的缺陷结果 JSON 里取出的一条缺陷。ROI 已乘过当前 PCS 布局的
 * `panelScale`,是图像像素。
 *
 * 只读:可以点选,但不能拖动/缩放,也不进标注文件。
 */
export interface Defect extends Rect {
  id: string
  defectIndex: number
  code: string
  label: string
  location: string
  /** `pcs_info` 的 key;0 表示 `panel_info` 里的全局点 */
  pcsKey: number
  /**
   * 第一张缺陷图的 key,相对面板目录(绝对 URL 已去掉主机和 bucket)。
   * 没有图片时为 null —— 缺陷照常显示,只是点开看不到图。
   */
  image: string | null
}

export interface DefectSet {
  productSerial: string
  sideIndex: string
  panelId: number
  defects: Defect[]
  /** 图片所在的 MinIO bucket,通常 deepiresults */
  bucket: string
  /**
   * 拼图片 key 时依次尝试的目录前缀。面板在 MinIO 上的真实前缀常被导入工具
   * 改过,和 JSON 里的 local_describe_path 对不上,所以给一组候选。
   */
  keyPrefixes: string[]
}

/** 一次缺陷图片加载的结果,直接给 `<img>` 用。 */
export interface DefectImageResult {
  /** `data:image/jpeg;base64,...` */
  dataUrl: string
  /** 实际命中的完整 URL,排查时看它 */
  url: string
  /** 命中的 MinIO 地址,后续点击直接复用 */
  base: string
  /** 命中的 key 前缀;图片路径原样命中时是空串 */
  prefix: string
}

/** 右侧面板里缺陷图的显示状态。 */
export interface DefectImageState {
  defectId: string
  status: 'loading' | 'ready' | 'error'
  dataUrl?: string
  url?: string
  error?: string
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

// ---------------------------------------------------------------- 导出

/**
 * 导出用的一项坐标。
 *
 * 名字只有表格用得上,裁剪命令收到也会忽略它 —— 但两个命令共用一个形状,
 * 省得在调用处来回转换。
 */
export interface ExportRect extends Rect {
  name?: string
}

export interface CropOutcome {
  dir: string
  /** 实际写出的文件数 */
  written: number
  /** 每个跳过或失败的框一条,直接展示给用户 */
  problems: string[]
  /** 实际用的扩展名。源图是浮点/整数格式时不是 png —— 见 Rust 侧 crop_extension */
  extension: string
}

export interface CropProgress {
  done: number
  total: number
}

export type ToolMode = 'pan' | 'draw'
