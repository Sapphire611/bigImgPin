/**
 * 一条命令发版:`node scripts/release.mjs --notes-file 说明.md`
 *
 * 做四件事:签名构建 → 收集安装包 → 生成 latest.json → 用 gh 建 Release 并上传。
 * 客户端就是靠 release 里这个 latest.json 知道有新版本的,别改名。
 *
 * 版本号取自 src-tauri/tauri.conf.json,发版前先改那里。
 *
 * 说明文本用 `--notes-file`(多行)或 `--notes`(单行)。两者都能用时以文件为准 ——
 * 原因见下面 notes 那段注释。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle')

const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const { version, productName } = conf
const tag = `v${version}`

// 多行说明**必须**走 --notes-file。
//
// 从命令行传多行文本会在 npm → shell 那一段被按换行拆开:脚本只拿得到第一行,
// 剩下的行变成没人要的 argv,而且不报错 —— 发出去才发现更新弹窗里只有半句话。
// 2026-09-24 发 v0.2.0 时踩到过,只能事后 gh release edit 补。
const notesFileIndex = process.argv.indexOf('--notes-file')
const fileNotes =
  notesFileIndex === -1 ? '' : readFileSync(process.argv[notesFileIndex + 1], 'utf8').trim()

const notesIndex = process.argv.indexOf('--notes')
const givenNotes = notesIndex === -1 ? '' : process.argv[notesIndex + 1]

const notes = fileNotes || givenNotes || `${productName} ${tag}`

/** 不构建、不上传,只用现有产物生成 latest.json 并列出会传哪些文件 */
const dryRun = process.argv.includes('--dry-run')

// 仓库地址:updater 的 endpoint 写死在这里,两边必须一致
const repo = 'Sapphire611/bigImgPin'

function run(cmd, args, options = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...options })
}

// 两个前置检查都放在构建之前:真跑到最后一步才发现缺东西,等于白构建一次
if (!dryRun) {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
  } catch {
    console.error('找不到 gh(GitHub CLI)。装一个再发版:')
    console.error('  winget install --id GitHub.cli')
    console.error('  gh auth login')
    process.exit(1)
  }

  // 私钥不在仓库里,放在 ~/.tauri 下。两个环境变量缺一不可:
  //  - 传内容而不是 TAURI_SIGNING_PRIVATE_KEY_PATH —— 后者实测不生效,
  //    只会得到「no private key」,构建以退出码 1 结束
  //  - 密码变量哪怕密钥没密码也得给。CLI 只要看不到它就会弹密码提示,
  //    在非交互环境里那不是报错,是**永久挂住等输入**
  const keyPath = join(homedir(), '.tauri', 'bigimgpin.key')
  if (!existsSync(keyPath)) {
    console.error(`找不到签名私钥:${keyPath}`)
    console.error('换机器了的话,把原来那份拷过来 —— 丢了就再也签不出能用的更新包了。')
    process.exit(1)
  }

  console.log(`发版 ${tag}`)
  run('npx', ['tauri', 'build'], {
    shell: true,
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
  })
} else {
  console.log(`${tag} 干跑:跳过构建和上传,只看产物`)
}

// ---- 收集产物 --------------------------------------------------------

// 更新包就是 NSIS 安装器本身(Tauri 2;`.nsis.zip` 是 v1 的老格式),
// 签名落在同目录的 <安装器>.sig 上
// 必须按版本号精确匹配:tauri build 不会清理 bundle 目录,
// 旧版本的安装包会一直躺在那里,不筛就会把上个版本当成新版本发出去
const nsisDir = join(bundleDir, 'nsis')
const setupExes = readdirSync(nsisDir).filter(
  (f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`),
)
if (setupExes.length !== 1) {
  console.error(
    `nsis 目录里匹配 v${version} 的安装包应有 1 个,实际 ${setupExes.length} 个。` +
      `目录内容:${readdirSync(nsisDir).join(', ') || '(空)'}`,
  )
  process.exit(1)
}
const setupExe = setupExes[0]

const sigPath = join(nsisDir, `${setupExe}.sig`)
if (!existsSync(sigPath)) {
  console.error(`缺少签名文件 ${sigPath} —— 构建时没给签名密钥,安装包是出来了,但没有更新包。`)
  process.exit(1)
}

// ---- 生成 latest.json ------------------------------------------------

const latestJson = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    // 目前只发 Windows。以后加 macOS 就在这里加 darwin-x86_64 / darwin-aarch64
    'windows-x86_64': {
      signature: readFileSync(sigPath, 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${setupExe}`,
    },
  },
}

const latestPath = join(bundleDir, 'latest.json')
writeFileSync(latestPath, `${JSON.stringify(latestJson, null, 2)}\n`)
console.log(`\n已生成 ${latestPath}`)

// ---- 建 Release ------------------------------------------------------

const msiDir = join(bundleDir, 'msi')
const msi = existsSync(msiDir)
  ? readdirSync(msiDir).find((f) => f.endsWith('.msi') && f.includes(`_${version}_`))
  : null

const assets = [
  join(nsisDir, setupExe),
  sigPath,
  ...(msi ? [join(msiDir, msi)] : []),
  latestPath,
]

if (dryRun) {
  console.log('\n会随 Release 上传:')
  for (const asset of assets) console.log(`  ${asset}`)
  console.log('\nlatest.json:')
  console.log(JSON.stringify(latestJson, null, 2))
  process.exit(0)
}

// release 名里带空格会把 gh 的参数拆开,统一用 tag 当标题
run('gh', ['release', 'create', tag, '--title', tag, '--notes', notes, ...assets])

console.log(`\n完成:https://github.com/${repo}/releases/tag/${tag}`)
console.log('已经在用的客户端下次启动就会静默下载,并提示重启。')
