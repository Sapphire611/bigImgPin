/**
 * 一条命令发版:`node scripts/release.mjs --notes-file 说明.md`
 *
 * 做五件事:签名构建 → 收集安装包 → 生成两份 latest.json(GitHub / Gitee)
 * → 发 Gitee 镜像 → 用 gh 建 GitHub Release 并上传。
 * 客户端就是靠 release 里这个 latest.json 知道有新版本的,别改名。
 *
 * 国内访问 GitHub 不稳定,所以 Gitee 那份是「主」源(见 tauri.conf.json 的
 * endpoints 顺序)。两份 manifest 的 version/notes/signature 完全相同,只有
 * platforms.*.url 指向各自的安装包 —— updater 只对「检查」做多源回退,
 * 下载不会换源,谁提供 manifest 谁就要提供能下到的地址。
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

/**
 * 只发 Gitee,不动 GitHub。两个用途:
 *  - 补发:GitHub 那边已经发过了,只想把国内源补上
 *  - 试跑:不重新构建,用现有产物验证 Gitee 令牌/仓库/上传是否通
 */
const giteeOnly = process.argv.includes('--gitee-only')

// 仓库地址:updater 的 endpoint 写死在这里,两边必须一致
const repo = 'Sapphire611/bigImgPin'

// Gitee 只放更新文件(latest.json + 安装包附件),不镜像源码。
// 这个路径同时写在 tauri.conf.json 的 endpoints 里,改名要两边一起改。
// 环境变量只给测试/临时换仓用,正常发版不用设。
const giteeRepo = (process.env.GITEE_REPO || 'Sapphire611/big-img-pin-update').trim()
const giteeTokenFile = join(homedir(), '.gitee', 'bigimgpin.token')
const giteeToken = (
  process.env.GITEE_TOKEN ||
  (existsSync(giteeTokenFile) ? readFileSync(giteeTokenFile, 'utf8') : '')
).trim()

/**
 * Gitee API v5。
 *
 * 令牌走 query(官方文档的写法),所以**任何报错都不能带完整 URL** ——
 * 它会被原样打到终端里,令牌也就跟着进日志了。
 */
function giteeApi(path, init = {}, { allow404 = false } = {}) {
  const url = new URL(`https://gitee.com/api/v5/repos/${giteeRepo}${path}`)
  if (giteeToken) url.searchParams.set('access_token', giteeToken)
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  }).then(async (response) => {
    const text = await response.text()
    if (response.status === 404 && allow404) return null
    if (!response.ok) {
      throw new Error(
        `Gitee API ${init.method ?? 'GET'} ${path} 返回 ${response.status}:${text.slice(0, 300)}`,
      )
    }
    return text ? JSON.parse(text) : null
  })
}

/**
 * 发版前确认 Gitee 侧真的能写。跑在构建之前 —— 构建几分钟之后才发现
 * 令牌过期,等于白构建一次。
 */
async function preflightGitee() {
  if (!giteeToken) {
    console.error('找不到 Gitee 私人令牌。')
    console.error('在 Gitee → 设置 → 私人令牌 生成一个(勾选 projects),然后二选一:')
    console.error('  - 设置环境变量 GITEE_TOKEN')
    console.error(`  - 存到 ${giteeTokenFile}`)
    process.exit(1)
  }

  // 单独验一次令牌。仓库本身是公开的,不带令牌也读得到,所以不能靠它判断令牌好坏。
  try {
    const userUrl = new URL('https://gitee.com/api/v5/user')
    userUrl.searchParams.set('access_token', giteeToken)
    const response = await fetch(userUrl, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`返回 ${response.status}`)
    const user = await response.json()
    if (!user?.login) throw new Error('返回里没有 login')
  } catch (error) {
    console.error(`Gitee 令牌无效或已过期:${error.message}`)
    process.exit(1)
  }

  let info
  try {
    info = await giteeApi('')
  } catch (error) {
    console.error(`读不到 Gitee 更新仓库 ${giteeRepo}:${error.message}`)
    console.error('先在 Gitee 建一个公开仓库,初始化 README 即可(只放 latest.json,不要放源码)。')
    process.exit(1)
  }

  // 客户端请求 raw 时不带任何凭据,私有仓库会 404
  if (info.private) {
    console.error(`Gitee 仓库 ${giteeRepo} 是私有的。更新源必须是公开仓库。`)
    process.exit(1)
  }
  if (!info.default_branch) {
    console.error(`Gitee 仓库 ${giteeRepo} 还是空的。`)
    console.error('在仓库页面点「初始化仓库」建一个 README,然后再发版。')
    process.exit(1)
  }
  if (info.permission && info.permission.push === false) {
    console.error(`当前 Gitee 令牌对 ${giteeRepo} 没有写权限。`)
    process.exit(1)
  }

  console.log(`Gitee 镜像:${giteeRepo}(分支 ${info.default_branch})`)
  return info.default_branch
}

/**
 * 把安装包和 Gitee 版 manifest 发上去。
 *
 * 顺序是「附件先到位、manifest 后写」:客户端拿到 manifest 就会立刻去下
 * platforms.*.url,附件还没上传完的话,它这一轮就白等了。
 */
async function publishGitee(manifest, exePath, exeName, branch) {
  // 同一个 tag 重跑时复用已有发行版,不重复创建
  let release = await giteeApi(`/releases/tags/${encodeURIComponent(tag)}`, {}, { allow404: true })
  if (!release) {
    console.log(`\n在 Gitee 建发行版 ${tag}`)
    release = await giteeApi('/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: notes,
        target_commitish: branch,
        prerelease: false,
      }),
    })
  }

  // 附件已存在就跳过:重跑时不重复占 1GB 的仓库配额
  let files = await giteeApi(`/releases/${release.id}/attach_files`)
  if (!files.some((file) => file.name === exeName)) {
    console.log(`上传安装包到 Gitee:${exeName}`)
    const form = new FormData()
    form.append('file', new Blob([readFileSync(exePath)]), exeName)
    await giteeApi(`/releases/${release.id}/attach_files`, {
      method: 'POST',
      body: form,
      // 15MB 在慢网络上可能要几分钟,别套默认的 60 秒
      signal: AbortSignal.timeout(10 * 60_000),
    })
    files = await giteeApi(`/releases/${release.id}/attach_files`)
    if (!files.some((file) => file.name === exeName)) {
      throw new Error(`上传后附件列表里找不到 ${exeName}`)
    }
  }

  // 新文件用 POST,已有文件用 PUT 且必须带 sha(contents API 的规定)。
  // 坑:文件不存在时 Gitee 返回的是 **200 + []**,不是 404 —— 按 404 判断的话
  // 会把空数组当成「已有文件」,然后 PUT 不带 sha,报 "sha is missing"。
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  const currentRaw = await giteeApi(`/contents/latest.json?ref=${encodeURIComponent(branch)}`, {}, {
    allow404: true,
  })
  const current =
    currentRaw && !Array.isArray(currentRaw) && currentRaw.sha ? currentRaw : null
  const body = {
    content: Buffer.from(text, 'utf8').toString('base64'),
    message: `更新 latest.json 到 ${tag}`,
    branch,
  }
  if (current) body.sha = current.sha
  await giteeApi('/contents/latest.json', {
    method: current ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  // 读回校验走 API,不走 raw —— raw 有分钟级 CDN 缓存,刚提交完可能还是旧的
  const savedRaw = await giteeApi(`/contents/latest.json?ref=${encodeURIComponent(branch)}`)
  const saved = Array.isArray(savedRaw) ? null : savedRaw
  if (!saved?.content) throw new Error('Gitee latest.json 读回不是文件')
  const savedVersion = JSON.parse(Buffer.from(saved.content, 'base64').toString('utf8')).version
  if (savedVersion !== version) {
    throw new Error(`Gitee latest.json 读回是 ${savedVersion},期望 ${version}`)
  }

  console.log(`Gitee 更新源:https://gitee.com/${giteeRepo}/raw/HEAD/latest.json`)
  console.log(`Gitee 安装包:${manifest.platforms['windows-x86_64'].url}`)
}

function run(cmd, args, options = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...options })
}

// 前置检查都放在构建之前:真跑到最后一步才发现缺东西,等于白构建一次。
// --gitee-only 不构建也不发 GitHub,所以 gh 和私钥都可以不查。
let giteeBranch = ''
if (!dryRun) {
  if (!giteeOnly) {
    try {
      execFileSync('gh', ['--version'], { stdio: 'ignore' })
    } catch {
      console.error('找不到 gh(GitHub CLI)。装一个再发版:')
      console.error('  winget install --id GitHub.cli')
      console.error('  gh auth login')
      process.exit(1)
    }
  }

  // 私钥不在仓库里,放在 ~/.tauri 下。两个环境变量缺一不可:
  //  - 传内容而不是 TAURI_SIGNING_PRIVATE_KEY_PATH —— 后者实测不生效,
  //    只会得到「no private key」,构建以退出码 1 结束
  //  - 密码变量哪怕密钥没密码也得给。CLI 只要看不到它就会弹密码提示,
  //    在非交互环境里那不是报错,是**永久挂住等输入**
  const keyPath = join(homedir(), '.tauri', 'bigimgpin.key')
  if (!giteeOnly && !existsSync(keyPath)) {
    console.error(`找不到签名私钥:${keyPath}`)
    console.error('换机器了的话,把原来那份拷过来 —— 丢了就再也签不出能用的更新包了。')
    process.exit(1)
  }

  giteeBranch = await preflightGitee()

  if (giteeOnly) {
    console.log(`${tag} 只发 Gitee:跳过构建和 GitHub`)
  } else {
    console.log(`发版 ${tag}`)
    run('npx', ['tauri', 'build'], {
      // shell:true 在 Windows 上是**必需**的:npx 是 .cmd,而 Node 20 起拒绝用
      // execFileSync 直接起 .cmd(安全加固)。代价是 Node 会打一行 DEP0190 弃用警告 ——
      // 这里的参数全是写死的,没有注入面。别为了消警告把它去掉,去掉就发不了版。
      shell: true,
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      },
    })
  }
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

// ---- 生成两份 latest.json --------------------------------------------
//
// 签名只覆盖安装包本身,不覆盖 manifest 里的 version/url,所以同一份签名
// 可以原样放进两份;真正的防篡改靠客户端用内置公钥验签。

const signature = readFileSync(sigPath, 'utf8').trim()
const pubDate = new Date().toISOString()

const githubLatest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    // 目前只发 Windows。以后加 macOS 就在这里加 darwin-x86_64 / darwin-aarch64
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${setupExe}`,
    },
  },
}

const giteeLatest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    'windows-x86_64': {
      signature,
      // 用 releases/download/<tag>/<文件名> 这个稳定地址,不要用
      // attach_files/<数字 id>/download —— 那个 id 每次上传都会变。
      // 请求会 302 两次到 CDN,客户端跟着跳转即可。
      url: `https://gitee.com/${giteeRepo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(setupExe)}`,
    },
  },
}

const latestPath = join(bundleDir, 'latest.json')
writeFileSync(latestPath, `${JSON.stringify(githubLatest, null, 2)}\n`)
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
  console.log('\n会随 GitHub Release 上传:')
  for (const asset of assets) console.log(`  ${asset}`)
  console.log('\nGitHub latest.json:')
  console.log(JSON.stringify(githubLatest, null, 2))
  console.log('\nGitee latest.json(提交到仓库根目录):')
  console.log(JSON.stringify(giteeLatest, null, 2))
  process.exit(0)
}

// 先发 Gitee 再发 GitHub:Gitee 这步失败就整次中止,不能出现「Gitee 源停在
// 旧版本」—— 客户端先查 Gitee,顺利解析到旧版本就直接结束,不会再问 GitHub。
await publishGitee(giteeLatest, join(nsisDir, setupExe), setupExe, giteeBranch)

if (giteeOnly) {
  console.log(`\nGitee 已更新:https://gitee.com/${giteeRepo}/releases/tag/${tag}`)
  console.log(`国内更新源:https://gitee.com/${giteeRepo}/raw/HEAD/latest.json`)
  console.log('GitHub 没动(--gitee-only)。')
} else {
  // release 名里带空格会把 gh 的参数拆开,统一用 tag 当标题
  run('gh', ['release', 'create', tag, '--title', tag, '--notes', notes, ...assets])

  console.log(`\n完成:https://github.com/${repo}/releases/tag/${tag}`)
  console.log(`Gitee 发行版:https://gitee.com/${giteeRepo}/releases/tag/${tag}`)
  console.log(`国内更新源:https://gitee.com/${giteeRepo}/raw/HEAD/latest.json`)
  console.log('已经在用的客户端下次启动就会静默下载,并提示重启。')
}
