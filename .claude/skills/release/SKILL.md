---
name: release
description: Use when publishing a new bigImgPin version (发版/发布/出新版本/打个包给别人), or when the auto-update needs verifying (更新没生效/验证更新/更新坏了). Covers the pre-flight checks, the one-command release, and how to prove a real client actually updated itself.
---

# bigImgPin 发版与更新验证

设计决策和踩过的坑在 `CLAUDE.md` 的「自动更新与发版」一节,这里只讲**按什么步骤做、怎么确认做对了**。

## 一、发版前检查(缺一个都白构建一次)

1. **版本号改了没** —— `src-tauri/tauri.conf.json` 的 `version`。
   客户端就是拿它跟云端比大小的,**忘了改 = 所有客户端都认为没新版**,而且不会报任何错。
2. **签名私钥在不在** —— `~/.tauri/bigimgpin.key`(不在仓库里,丢了只能让用户重装)。
3. **gh 能用** —— `gh auth status`。没装:`winget install --id GitHub.cli`(装完要新开终端,
   或刷新 PATH)。

## 二、发版

```bash
npm run release -- --notes-file /tmp/说明.md
```

签名构建 → 生成 `latest.json` → 建 Release 上传。**约 5 分钟**:release 构建开了
LTO + `codegen-units=1`,慢是正常的,别以为卡住了。

**多行说明一定用 `--notes-file`,不要用 `--notes`。** 多行文本从命令行传会在
npm → shell 那一段被按换行拆开,脚本只拿到第一行,剩下的行变成没人要的 argv,
而且**不报错**。2026-09-24 发 v0.2.0 就是这样:Release 页面和更新弹窗里
只剩「标注改动现在会永久保存:」半句话。`--notes` 只适合单行短说明。

想先看会传哪些文件、`latest.json` 长什么样(不构建不上传):

```bash
npm run release -- --dry-run
```

## 三、确认更新源活着

这是客户端实际访问的 URL,发完必须验一次:

```bash
curl -sL https://github.com/Sapphire611/bigImgPin/releases/latest/download/latest.json
```

`version` 是刚发的版本号、`url` 指向刚传的安装包,才算成功。**404 或还是旧版本号**通常意味着:
Release 没被标成 Latest(比如误勾了 prerelease),或者上传时资产名不是 `latest.json`。

⚠️ **这个 URL 走 GitHub 的 CDN 缓存**,刚上传的资产不会立刻生效(`Cache-Control`
显示 `Age: N`,带缓存破坏参数也没用 —— 缓存在对象层不在查询串上)。
**刚重传过资产、要确认内容对不对时,绕开它读资产本身**:

```bash
ASSET=$(gh api repos/Sapphire611/bigImgPin/releases/tags/v0.2.0 \
  --jq '.assets[] | select(.name=="latest.json") | .id')
gh api "repos/Sapphire611/bigImgPin/releases/assets/$ASSET" -H "Accept: application/octet-stream"
```

只改了说明文字的话,等缓存过期(分钟级)客户端自然会拿到新的 ——
版本号 / url / 签名在旧的那份里也是对的,更新本身不受影响。

## 四、验证更新链路(改了更新相关代码才需要)

只有当**新版能被旧版发现并装上去**才算验证过。单看「发版成功」不算。

1. 留一份**旧版本**的安装包:`src-tauri/target/release/bundle/nsis/bigImgPin_<旧版本>_x64-setup.exe`
2. 静默装它:

   ```bash
   MSYS_NO_PATHCONV=1 ./bigImgPin_0.1.0_x64-setup.exe /S
   ```

   **`MSYS_NO_PATHCONV=1` 不能省** —— 否则 git bash 把 `/S` 当路径转换掉,会弹出安装向导。
   装到 `%LOCALAPPDATA%\bigImgPin`(每用户,不需要管理员)。
3. 启动 `%LOCALAPPDATA%\bigImgPin\bigimgpin.exe`
4. 3 秒后它静默检查 → 后台下载(工具栏按钮变成百分比) → 弹窗。点「立即重启」。
5. 它会自己关掉、静默装好、自己开回新版。

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

仓库是**公开**的,Release 里任何人都能下载安装包和 `latest.json`。
工业内部工具如果要控制分发范围,发之前先确认这事没问题。

## 常见故障对照

| 现象 | 多半是 |
|---|---|
| 构建报 `A public key has been found, but no private key` | 没给 `TAURI_SIGNING_PRIVATE_KEY`。退出码 1,但安装包其实出来了 |
| 构建立刻卡住不动,停在 `Decrypting updater signing key` | 没给 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(哪怕空串)。它在等 stdin,不会报错 |
| 客户端一直不提示更新 | 版本号没改;或 `latest.json` 没传上去;或 Release 不是 Latest |
| 客户端报签名不匹配 | 换了密钥但 `tauri.conf.json` 里的公钥没跟着换 |
