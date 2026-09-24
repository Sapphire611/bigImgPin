/**
 * 切片参数:瓦片尺寸与瓦片格式。
 *
 * **改这两个值会改变缓存键**(见 `commands.rs` 的 `cache_key`),同一张图会按新参数
 * 重新切一份,旧的那份还留在磁盘上不会自动删。界面必须把这句话说出来,否则用户
 * 看到的只是「改了个设置,下次打开图又等了几分钟」。
 *
 * 默认值刻意和 Rust 侧的 `DEFAULT_TILE_SIZE` 对齐:前端总是显式把参数发过去,
 * 两边默认值不一致的话,「没设置过」和「显式设成默认」会命中两份不同的缓存。
 *
 * 存 localStorage 和主题、坐标小数位一个路子 —— 纯界面偏好,不影响任何已有数据。
 */
import { ref, watch } from 'vue'

const KEY = 'bigimgpin.slice'

/** 512 适合小图/内存紧张;2048 压缩率更高但单张解码后 16MB。1024 是实测折中。 */
export const TILE_SIZE_CHOICES = [512, 1024, 2048]

export type TileFormat = 'webp' | 'png'

export const TILE_FORMAT_CHOICES: Array<{ value: TileFormat; label: string }> = [
  { value: 'webp', label: 'WebP 无损(推荐)' },
  { value: 'png', label: 'PNG' },
]

interface SlicePrefs {
  tileSize: number
  tileFormat: TileFormat
}

const DEFAULTS: SlicePrefs = { tileSize: 1024, tileFormat: 'webp' }

function read(): SlicePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SlicePrefs>
    return {
      tileSize: TILE_SIZE_CHOICES.includes(saved.tileSize as number)
        ? (saved.tileSize as number)
        : DEFAULTS.tileSize,
      tileFormat: TILE_FORMAT_CHOICES.some((c) => c.value === saved.tileFormat)
        ? (saved.tileFormat as TileFormat)
        : DEFAULTS.tileFormat,
    }
  } catch {
    // 存坏了就当没存过:这个设置不值得为它拦住整个应用启动
    return DEFAULTS
  }
}

const initial = read()

export const tileSize = ref(initial.tileSize)
export const tileFormat = ref<TileFormat>(initial.tileFormat)

watch([tileSize, tileFormat], ([size, format]) => {
  localStorage.setItem(KEY, JSON.stringify({ tileSize: size, tileFormat: format }))
})

/** 传给 `prepare_image` 的参数。 */
export function sliceParams() {
  return { tileSize: tileSize.value, tileFormat: tileFormat.value }
}
