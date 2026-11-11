/**
 * 缺陷图片的 MinIO 地址。
 *
 * 旧数据导进旧 MinIO(默认 9102),新数据导进新 MinIO(默认 9104),两套都配。
 * 用哪套由缺陷文件自己声明:`local_describe_*` 是 `minio://` 的是新数据,
 * 是本地盘路径的是旧数据。只请求声明的那一套 —— 别人的机器上未必两套都部署了,
 * 去连不存在的那套只会白等超时。只有文件里两个字段都没有时,才退回「先新后旧」
 * 地试一次(见 `minioBases`)。
 *
 * 地址只存 IP/端口,不存 bucket —— bucket 由面板 JSON 的 `minio://` 路径给出,
 * 见 `src-tauri/src/defects.rs`。
 */
import { ref, watch } from 'vue'

const KEY = 'bigimgpin.minio'

export const DEFAULT_NEW_PORT = '9104'
export const DEFAULT_OLD_PORT = '9102'

interface MinioPrefs {
  newIp: string
  newPort: string
  oldIp: string
  oldPort: string
}

const DEFAULTS: MinioPrefs = {
  newIp: '127.0.0.1',
  newPort: DEFAULT_NEW_PORT,
  oldIp: '127.0.0.1',
  oldPort: DEFAULT_OLD_PORT,
}

function read(): MinioPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<MinioPrefs>
    // 端口存成字符串:用户正在输入时可能是空串或半截数字,别在这里强行纠正
    return {
      newIp: typeof saved.newIp === 'string' ? saved.newIp : DEFAULTS.newIp,
      newPort: typeof saved.newPort === 'string' ? saved.newPort : DEFAULTS.newPort,
      oldIp: typeof saved.oldIp === 'string' ? saved.oldIp : DEFAULTS.oldIp,
      oldPort: typeof saved.oldPort === 'string' ? saved.oldPort : DEFAULTS.oldPort,
    }
  } catch {
    // 存坏了就当没存过,不值得为它拦住启动
    return DEFAULTS
  }
}

const initial = read()

export const minioNewIp = ref(initial.newIp)
export const minioNewPort = ref(initial.newPort)
export const minioOldIp = ref(initial.oldIp)
export const minioOldPort = ref(initial.oldPort)

/**
 * 地址改过之后 +1。App 用它丢掉「上次命中的地址+前缀」缓存 ——
 * 否则用户改了 IP,点缺陷还在往旧地址上撞。
 */
export const minioRevision = ref(0)

watch([minioNewIp, minioNewPort, minioOldIp, minioOldPort], ([newIp, newPort, oldIp, oldPort]) => {
  const prefs: MinioPrefs = { newIp, newPort, oldIp, oldPort }
  localStorage.setItem(KEY, JSON.stringify(prefs))
  minioRevision.value += 1
})

/** `http://host:port`。IP 里顺手写了端口或协议头也能容忍。 */
function endpoint(ip: string, port: string): string | null {
  const host = ip
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    // 避免「IP 里带了端口」再拼一次变成 host:9104:9104
    .replace(/:\d+$/, '')
  if (!host) return null

  const number = Number(port)
  if (!Number.isInteger(number) || number < 1 || number > 65535) return null

  return `http://${host}:${number}`
}

/** 文件声明了属于哪套时,只走这一套;对应地址没填好时返回 null。 */
export function minioBaseFor(kind: 'new' | 'old'): string | null {
  return kind === 'new'
    ? endpoint(minioNewIp.value, minioNewPort.value)
    : endpoint(minioOldIp.value, minioOldPort.value)
}

/**
 * 文件没写来源时的兜底地址,新 MinIO 在前。两套填成一样时会去重,
 * 避免同样的请求打两遍。正常路径不应该走到这里 —— 只认文件声明的地址。
 */
export function minioBases(): string[] {
  const bases = [minioBaseFor('new'), minioBaseFor('old')].filter(
    (base): base is string => base !== null,
  )
  return [...new Set(bases)]
}
