---
name: release
description: Use when publishing a new bigImgPin version (发版/发布/出新版本/打个包给别人), or when the auto-update needs verifying (更新没生效/验证更新/更新坏了). Covers the pre-flight checks, the one-command release, and how to prove a real client actually updated itself.
---

# bigImgPin 发版与更新验证

设计决策和踩过的坑在 `CLAUDE.md` 的「自动更新与发版」一节,这里只讲**按什么步骤做、怎么确认做对了**。

## 一、发版前检查(缺一个都白构建一次)

1. **版本号改了没** —— `src-tauri/tauri.conf.json` 的 `version`。
   客户端就是拿它跟云端比大小的,**忘了改 = 所有客户端都认为没新版**,而且不会报任何错。
   别凭记忆确认,直接比这两个数:

   ```bash
   node -p "require('./src-tauri/tauri.conf.json').version"         # 将要发的
   gh release list --limit 1 --json tagName --jq '.[0].tagName'     # 已经发的
   ```

   一样就说明忘了改。
2. **签名私钥在不在** —— `~/.tauri/bigimgpin.key`(不在仓库里,丢了只能让用户重装)。
3. **gh 能用** —— `gh auth status`。没装:`winget install --id GitHub.cli`(装完要新开终端,
   或刷新 PATH)。
4. **Gitee 令牌和仓库** —— 脚本现在会同时发 Gitee。令牌存 `~/.gitee/bigimgpin.token`
   或环境变量 `GITEE_TOKEN`(Gitee → 设置 → 私人令牌,勾 `projects`);仓库是公开的
   `Sapphire611/big-img-pin-update`,根目录要初始化过 README(空仓库没有分支,提交不了)。
   这两项脚本在构建前就会查,缺了直接退出,不会白构建。

## 二、发版

```bash
npm run release -- --notes-file /tmp/说明.md
```

签名构建 → 生成 GitHub / Gitee 两份 `latest.json` → 发 Gitee(发行版 + 附件 +
manifest)→ 建 GitHub Release 上传。**约 5 分钟**:release 构建开了
LTO + `codegen-units=1`,慢是正常的,别以为卡住了。

Gitee 那步在 GitHub 之前,失败会中止整次发版 —— 不能留下「Gitee 源停在旧版本」
的状态,否则国内客户端会把它当成「已是最新版」,不再去问 GitHub。

**多行说明一定用 `--notes-file`,不要用 `--notes`。** 多行文本从命令行传会在
npm → shell 那一段被按换行拆开,脚本只拿到第一行,剩下的行变成没人要的 argv,
而且**不报错**。2026-09-24 发 v0.2.0 就是这样:Release 页面和更新弹窗里
只剩「标注改动现在会永久保存:」半句话。`--notes` 只适合单行短说明。

想先看会传哪些文件、两份 `latest.json` 长什么样(不构建不上传):

```bash
npm run release -- --dry-run
```

GitHub 已经发过、只想补国内源(或只验证 Gitee 这条链)时加 `--gitee-only`:
它不构建、不查 `gh` 和私钥,只用现有产物发 Gitee。

## 三、确认两个更新源都活着

客户端**先读 Gitee,再读 GitHub**。两个都要验:只验 GitHub 的话,国内客户端
可能拿到一份停在旧版本的 Gitee manifest —— 那比更新失败还糟,它会被当成
「已是最新版」,根本不会再问 GitHub。

```bash
curl -sL https://github.com/Sapphire611/bigImgPin/releases/latest/download/latest.json
curl -sL https://gitee.com/Sapphire611/big-img-pin-update/raw/HEAD/latest.json
```

两份的 `version` 都应该是刚发的版本号;`url` 分别指向 GitHub / Gitee 的安装包。
**Gitee 那份的 `url` 不能是 GitHub 地址** —— updater 拿哪份 manifest 就只下那里的
地址,下载不会换源。

⚠️ **两个 URL 都走 CDN 缓存**,刚传的资产不会立刻生效(GitHub 的 `Cache-Control`
会显示 `Age: N`,带缓存破坏参数也没用 —— 缓存在对象层不在查询串上)。要确认
**内容**而不是「客户端现在能看到什么」,绕开 raw:

```bash
# GitHub:直接读资产
# tag 从 tauri.conf.json 推导 —— 手写 v0.2.x 的话,发完下一版这条命令就悄悄查错 tag 了
TAG="v$(node -p "require('./src-tauri/tauri.conf.json').version")"
ASSET=$(gh api "repos/Sapphire611/bigImgPin/releases/tags/$TAG" \
  --jq '.assets[] | select(.name=="latest.json") | .id')
gh api "repos/Sapphire611/bigImgPin/releases/assets/$ASSET" -H "Accept: application/octet-stream"

# Gitee:contents API(不走 CDN)
curl -s "https://gitee.com/api/v5/repos/Sapphire611/big-img-pin-update/contents/latest.json?ref=HEAD" \
  | python -c "import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)['content']).decode())"
```

再确认 Gitee 附件能匿名下载(会 302 两次到 CDN,`-L` 跟到底,最后应该是 200):

```bash
curl -sIL "https://gitee.com/Sapphire611/big-img-pin-update/releases/download/$TAG/bigImgPin_${TAG#v}_x64-setup.exe" | tail -1
```

只改了说明文字的话,等缓存过期(分钟级)客户端自然会拿到新的 ——
版本号 / url / 签名在旧的那份里也是对的,更新本身不受影响。

## 四、验证更新链路(改了更新相关代码才需要)

只有当**新版能被旧版发现并装上去**才算验证过。单看「发版成功」不算。

1. 留一份**旧版本**的安装包:`src-tauri/target/release/bundle/nsis/bigImgPin_<旧版本>_x64-setup.exe`
2. 静默装它:

   ```bash
   MSYS_NO_PATHCONV=1 ./bigImgPin_<旧版本>_x64-setup.exe /S   # 版本号换成你留的那一份,别照抄
   ```

   **`MSYS_NO_PATHCONV=1` 不能省** —— 否则 git bash 把 `/S` 当路径转换掉,会弹出安装向导。
   装到 `%LOCALAPPDATA%\bigImgPin`(每用户,不需要管理员)。
3. 启动 `%LOCALAPPDATA%\bigImgPin\bigimgpin.exe`
4. 3 秒后它静默检查 → 后台下载(工具栏按钮变成百分比) → 弹窗。点「立即重启」。
5. 它会自己关掉、静默装好、自己开回新版。

> 客户端现在先查 Gitee,正常路径验的就是 Gitee。想单独验「Gitee 挂了会不会落到
> GitHub」,把 `tauri.conf.json` 里 Gitee 的 endpoint 临时改成一个 404 地址再跑这一节。

**怎么确认真的成功**(这是客观证据,不依赖肉眼):

```bash
powershell -NoProfile -Command "(Get-Item \"\$env:LOCALAPPDATA\bigImgPin\bigimgpin.exe\").VersionInfo.FileVersion"
```

版本号变成新版 = 安装真的发生了。配合进程 PID / 启动时间变化,说明自动重启也生效了。

> ⚠️ **别用截图 + 视觉模型验证界面**:本机是 125% DPI 缩放,窗口坐标和硬编码的裁剪区域对不上,
> 模型还会漏看小字(实测漏报过整个按钮,浪费了很多时间)。界面本身怎么验见
> `.claude/skills/verify/SKILL.md`(CDP 连真客户端);更新链路就靠上面这种客观证据 ——
> 文件版本号、进程列表、网络连接(`netstat -ano | grep <PID>`)。

## 五、发布前想清楚

GitHub 仓库和 Gitee 的 `big-img-pin-update` 都是**公开**的,任何人都能下载安装包和
`latest.json`。工业内部工具如果要控制分发范围,发之前先确认这事没问题。

## 常见故障对照

| 现象 | 多半是 |
|---|---|
| 构建报 `A public key has been found, but no private key` | 没给 `TAURI_SIGNING_PRIVATE_KEY`。退出码 1,但安装包其实出来了 |
| 构建立刻卡住不动,停在 `Decrypting updater signing key` | 没给 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(哪怕空串)。它在等 stdin,不会报错 |
| 发版前就报「找不到 Gitee 私人令牌」 | 没设 `GITEE_TOKEN`,也没有 `~/.gitee/bigimgpin.token` |
| 发版前报「读不到 Gitee 更新仓库」/ 没有写权限 | 仓库名错了、是私有的、还没初始化 README,或令牌没勾 `projects` |
| Gitee 提交成功但 `raw/HEAD/latest.json` 还是旧内容 | raw 的 CDN 缓存(分钟级)。用 contents API 确认;客户端下次启动会拿到新的 |
| 客户端一直不提示更新 | 版本号没改;或**Gitee manifest 停在旧版本**(客户端先读它);或 Release 不是 Latest |
| 客户端报签名不匹配 | 换了密钥但 `tauri.conf.json` 里的公钥没跟着换 |
| Gitee 附件上传超时 | 网络问题。重跑 `npm run release`,已存在的附件会跳过,不会重复占配额 |
| Gitee 报附件容量超限 | 仓库 1GB 配额满了。删旧发行版的附件腾地方,最新那份 manifest 不受影响 |
| 发版报 Gitee `sha is missing` | 文件不存在时 Gitee 返回 **200 + []** 而不是 404。代码已按空数组处理,别改回按 404 判断 |
