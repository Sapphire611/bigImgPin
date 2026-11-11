/**
 * 打一个免安装的 Windows 便携包:`npm run portable`
 *
 * 做三件事:
 *   1. `tauri build --no-bundle` 出 release exe。这个 exe 和 `tauri build`
 *      生成安装包时用的**是同一个**,只是不打包、不签更新,所以不需要私钥。
 *   2. 按 `bundle.resources` 把 exe 和它依赖的外部资源摆进一个文件夹。
 *      资源清单直接读 tauri.conf.json,以后加资源不用回来改这里。
 *   3. 压成 zip。
 *
 * 便携包没有安装过程,也不会替用户装 WebView2;README 里写清楚了。
 * 自动更新还留着:以后发新版,同事点更新会走 NSIS 装成正式版,而不是
 * 替换这个文件夹 —— 这是免安装包的固有代价,不是这里漏了什么。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const { version, productName } = conf

const folderName = `${productName}-${version}-portable-win64`
const portableRoot = join(root, 'src-tauri', 'target', 'portable')
const folder = join(portableRoot, folderName)
const zipPath = join(portableRoot, `${folderName}.zip`)

function run(cmd, args, options = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...options })
}

if (process.platform !== 'win32') {
  console.error('便携包只针对 Windows(包里带的是 win64 版 vips)。')
  process.exit(1)
}

// 只出二进制,不生成 NSIS/MSI,也就不会碰 updater 签名。
// shell:true 是必需的:npx 是 .cmd,Node 20 起拒绝 execFileSync 直接起 .cmd。
// 参数全是写死的,没有注入面;那行 DEP0190 弃用警告不用理(和 release.mjs 同一个坑)。
run('npx', ['tauri', 'build', '--no-bundle'], { shell: true })

// Cargo 的 bin 名不一定等于 productName(这里是 bigimgpin vs bigImgPin)
const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const packageName = /\[package\][\s\S]*?\nname\s*=\s*"([^"]+)"/.exec(cargo)?.[1]
if (!packageName) {
  console.error('读不出 Cargo.toml 的 [package] name。')
  process.exit(1)
}
const exeSource = join(root, 'src-tauri', 'target', 'release', `${packageName}.exe`)
if (!existsSync(exeSource)) {
  console.error(`构建完成但找不到 ${exeSource}`)
  process.exit(1)
}

// 每次都从空目录开始,避免上一次的残留文件混进包里
rmSync(folder, { recursive: true, force: true })
mkdirSync(folder, { recursive: true })
copyFileSync(exeSource, join(folder, `${productName}.exe`))

// 目前是映射形式 { "resources/vips-win64": "vips-win64" }。
// 数组/glob 形式的落点规则不同,与其猜,不如明确拒绝。
const resources = conf.bundle?.resources
if (!resources || Array.isArray(resources)) {
  console.error('bundle.resources 不是 { 源: 目标 } 映射,便携脚本还不支持这种写法。')
  process.exit(1)
}
for (const [source, target] of Object.entries(resources)) {
  const from = join(root, 'src-tauri', source)
  if (!existsSync(from)) {
    console.error(`bundle.resources 里的源不存在:${from}`)
    process.exit(1)
  }
  cpSync(from, join(folder, target), { recursive: true })
}

writeFileSync(
  join(folder, 'README.txt'),
  `bigImgPin ${version} 免安装版
========================

运行
----
1. 把整个文件夹解压出来,双击 ${productName}.exe 即可,不需要安装。
2. 不要把 exe 单独拷走 —— vips-win64 文件夹必须和 exe 放在同一层,
   切片用的 libvips 在里面,少了它打不开图。
3. 系统要求:Windows 10/11 64 位,并且装有 Microsoft Edge WebView2 Runtime。
   Windows 11 和更新过的 Windows 10 一般自带;没有的话去微软官网下载
   「WebView2 Runtime」安装即可。

使用
----
- 打开超大图后首次要切片,可能等几分钟;同一张图再开是秒开。
- 标注自动保存在原图旁边(<图名>.bigimgpin.json);原目录不可写时
  退回应用数据目录。
- 缺陷结果 JSON 直接拖进窗口加载。加载完会自动定位第一条,
  按 PageUp / PageDown 逐条切换,也可以点右侧的「上一条 / 下一条」。
- 缺陷图走 MinIO,地址在 设置 → 缺陷图片 里填。

缓存位置
--------
%LOCALAPPDATA%\\com.liuliyi.bigimgpin\\tiles
可在 设置 里查看占用和清理。

说明
----
这是免安装测试包,自动更新仍然保留。以后作者发新版时如果点了更新,
会安装成正常的安装版,而不是替换当前文件夹。
`,
)

// Windows 自带的 bsdtar 会按扩展名生成 zip,不需要额外装 7z。
// 必须写 System32 的绝对路径:Git 自带的 GNU tar 也在 PATH 里,它会把
// `C:\...` 里的盘符当成远程主机(`Cannot connect to C:`),而且不支持 zip。
const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
if (!existsSync(systemTar)) {
  console.error(`找不到 Windows 自带的 tar:${systemTar}`)
  process.exit(1)
}
rmSync(zipPath, { force: true })
run(systemTar, ['-a', '-c', '-f', zipPath, folderName], { cwd: portableRoot })

const size = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
console.log(`\n便携包:${zipPath}`)
console.log(`大小:${size} MB`)
console.log(`SHA-256:${sha256}`)
