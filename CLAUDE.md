# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

bigImgPin 是一个超大图查看与标注工具(Tauri 2 + Vue 3 + TypeScript)。Rust 侧调用外部
libvips 把任意大图切成 DZI 瓦片金字塔并缓存,前端用 OpenSeadragon 浏览瓦片,在
SVG 叠加层上画标注框和辅助线。目标图是数十亿像素级的版图/显微类图像。

**代码注释与 UI 文案一律用中文**,注释解释「为什么这么做」而不是「做了什么」。
改动时保持这个风格 —— 现有注释里记录了大量踩坑结论,不要在重构时删掉。

## 常用命令

```bash
npm run dev              # tauri dev(会自动起 vite,端口 1420 固定)
npm run dev:web          # 只起 vite。纯浏览器里没有 Tauri API,invoke 全都会失败
npm run build            # vue-tsc --noEmit && vite build
npx vue-tsc --noEmit     # 只做类型检查(前端没有 test runner,这是最轻的验证手段)
npx tauri build          # 打包。没给签名私钥会以退出码 1 结束(安装包其实已经出来了)
npm run release          # 发版:签名构建 + 生成 latest.json + 建 GitHub Release

# Rust 单元测试(在 src-tauri/ 下,或在仓库根加 --manifest-path src-tauri/Cargo.toml)
cargo test
cargo test cache_key_changes_with_slice_params   # 单个测试
```

前端**没有**测试框架(无 vitest/jest),不要凭空新增。逻辑验证靠 `vue-tsc` 加手动跑
`tauri dev`。Rust 侧的 `#[cfg(test)]` 覆盖在 `src-tauri/src/*.rs` 文件末尾,改到这些
纯函数时同步改测试。

## 验证改动

机械检查(`vue-tsc` / `cargo test` / `clippy` / `build`)和界面验证的**具体步骤**在
`.claude/skills/verify/SKILL.md`,那里也记着几个「让坏改动看着像好的」的坑
(管道吃掉退出码、Vue 重渲染时序、命中检测的坐标系偏移)。

要记住的只有一条:**界面改动不等于只能靠人点**。WebView2 支持 `--remote-debugging-port`,
CDP 的鼠标键盘事件走的是 Chromium 完整输入管线,pointerdown/move/up 真触发 ——
拖手柄、Ctrl 多选、按 Delete 都验得了。断言读 DOM / `setupState` / 磁盘文件,
比截图可靠(本机 125% DPI,截图本来就不可信)。够不着的只有系统画的对话框和审美判断。

## 运行前置:libvips

vips 是**外部二进制,不是链接进来的库**,运行时才定位(见 `src-tauri/src/vips.rs`
的 `resolve_vips`)。查找顺序:随包捆绑 → `BIGIMGPIN_VIPS` 环境变量 → macOS brew 的
硬编码路径 → PATH。

第 3 步不是冗余的:macOS 上从 Finder 双击启动的 .app 不继承 shell 的 PATH,brew 装的
vips 在 PATH 里查不到。

开发机需要 `brew install vips`。启动时会自检并 emit `vips-status` 事件;前端同时还会
主动调一次 `vips_info` 兜底 —— 事件可能在监听器注册之前就发完了。

## 架构要点

### 数据流

```
pick_image → 绝对路径
prepare_image(path) → 命中缓存秒回 / 否则跑 vips dzsave(可能几分钟)
   ├─ 期间 emit tile-progress
   └─ 返回 PreparedImage{ id, width, height, tileSize, tilesUrl, ... }
前端 useViewer.load() 用这份元数据直接构造 DziTileSource
瓦片通过自定义协议 bigimgpin://localhost/tiles/<id>/image_files/... 加载
```

前后端的类型契约:Rust `commands::PreparedImage` ↔ `src/types.ts` 的 `PreparedImage`,
serde 用 `rename_all = "camelCase"`。改一边必须改另一边。

### 前端不碰 invoke

所有 Rust 命令与事件都封在 `src/api/tauri.ts`,组件只 import 它。新增命令要三处同步:
`src-tauri/src/lib.rs` 的 `generate_handler!`、`src/api/tauri.ts`、`src/types.ts`。

### 自定义协议(易错)

`src-tauri/src/tiles_protocol.rs` 的 `protocol_origin()` 是 URL 前缀的**唯一收敛点**:
Windows/Android 上是 `http://bigimgpin.localhost`,其他平台是 `bigimgpin://localhost`。
两处不一致会导致其中一个平台静默白屏。任何地方都不要再写第二次这个判断。

不用 Tauri 内置 asset 协议的原因(见文件头注释):glob scope 在各平台缓存目录形态不一,
Linux 的 `~/.local/share/...` 会踩 `requireLiteralLeadingDot` 的坑。自实现协议还顺带把
MIME、缓存头、404 语义拿到自己手里。

必须用**异步版** `register_asynchronous_uri_scheme_protocol`:同步版在 macOS 上跑在
主线程,一次慢磁盘 IO 就掉帧。

### 缓存

位置 `app_local_data_dir()/tiles/<cache_key>/`,cache_key = hash(路径, 文件大小, mtime,
切片参数)。用 `DefaultHasher` 而非 sha256 —— 只要碰撞概率可忽略,不值得引依赖。

切片参数**必须**进 hash:否则改了瓦片尺寸或格式会命中旧缓存,拿到尺寸不符的瓦片,
表现为图像错位。见 `commands.rs` 的 `cache_key_changes_with_slice_params` 测试。

落盘走 `.tmp-<id>-<pid>/` → 原子 rename。中途崩溃不会留下被误判为「命中」的半成品。
命中判定要同时确认 `image.dzi` 和 `image_files/` 都在。

### Tauri 命令必须是 async

同步命令跑在主线程,一个几分钟的切片会把界面冻死。阻塞的 `child.wait()` 内部再用
`spawn_blocking` 包住,避免占死异步运行时的工作线程。新增耗时命令照此处理。

### 坐标换算只有一条路

`src/osd/coords.ts` 是图像坐标 ↔ 屏幕坐标的唯一出口,文件头写了三条硬规则:

1. 一律用 `TiledImage` 上的方法,**不要**用 `viewer.viewport` 上的同名方法(多图场景下
   不准确,而且只会位置偏一点,不报错)。
2. 屏幕坐标是**相对 `viewer.element` 左上角**的像素,调用方负责减去 bounding rect。
3. OSD 的 `zoom` 不是百分比,是「整图宽度对应多少个 viewport 单位」。1:1 要用
   `imageToViewportZoom(1)`。

框坐标统一 `roundRect` 收敛,位数由 `coordDecimals` 决定(**默认 0,即整数**,
存在 localStorage)。用 `toFixed` 而非 `Math.round(v*100)/100` —— 后者有二进制浮点误差。
所有框进列表前都要过这一关。

缩放走 `resizeRect`,它**全程在四条边上算**,最后才由边求宽高:对 `x` 和 `w` 各自取整
的话,原始右边界会被舍入两次,拖左边的时候右边会跟着跳一格 —— 用户拖的是左边。

`coordDecimals` **同时管三件事**:显示、新框的坐标收敛、导出 CSV 的位数。
不要拆开 —— 拆开就会出现「屏幕上写 1235、文件里存 1234.57、导出又是 1234.57」,
三处对不上,人就没法信任何一处。改小位数**不会回头改动已有的框**(谁被拖过谁吸附过来)。

### 叠加层是自己画的 SVG

`src/osd/useAnnotationSvg.ts` 把网格、辅助线、框、预览框全画在**一个屏幕空间的 `<svg>`**
上,监听 `update-viewport` 整层重绘。**不要改用 `viewer.addOverlay()`**:它的 location 是
viewport 坐标而非图像坐标(整体偏移且随缩放变化),而且每个 overlay 都会每帧强制
reflow。重绘路径可以照抄 `draw()`。

屏幕空间绘制的好处是线宽恒为 2px,不随缩放变成色块。

**缩放手柄也画在这一层,命中检测也归它做**(`handleAt`)。手柄画在哪只有这一层知道:
`drawRegions` 顺手把八个点的屏幕坐标记进 `handlePoints`,`handleAt` 直接查那份。
分开各算一次迟早会出现「看着在手柄上、点下去却没反应」,而且只在某些缩放比例下出现。

App 里的判断顺序是**先手柄、后框**:手柄压在选中框的边框上,反过来先判框就永远拖不到手柄。
手柄只在画框模式下画 —— 拖动模式下拖拽是平移画面,画着几个拖不动的方块是骗人。

### 标注状态只有一条路(撤销的地基)

`src/state/useAnnotations.ts` 持有框、辅助线、选中项和撤销栈,**所有**标注改动都走它。
撤销是快照式(整体替换 + 一个 cursor),不是给每种操作写逆操作 ——「导入整份标注文件」
这种一次性替换全部状态的操作,命令式根本接不进去。

由此有三条不能破的规则:

- **待定的改动进不了撤销。** 拖拽期间每帧都在改坐标,但只在松手时 `commit()` 一次;
  一次拖拽在撤销栈里是「一步」不是几十步。方向键微调同理(500ms 窗口内合并)。
- **自动保存盯的是 `revision`,不是 `regions`。** 直接盯数组的话,一次拖拽会触发几十次写盘。
- **叠加层通过 `watch(regions)` 跟着状态走**,不要在改动点手写 `overlay.setRegions()` ——
  漏掉一处就是「框进了列表但屏幕上看不见」,而且只在特定操作顺序下才暴露。
- **选中是 `Set<string>`,不是单个 id。** 画布每帧要对每个框问一次「你选中了吗」,
  用数组的 `includes` 在框多起来之后是每帧几万次比较。`selectedId` 是派生出来的
  「恰好选中一个」,手柄和填入输入框这类只对单个框有意义的操作才用它。
- **批量改坐标走 `setRegionsRects`。** 拖动一整批时逐框调用会把框数组重排 N 遍,一帧一遍。

### 标注落盘

`src-tauri/src/annotations.rs`。文件放源图旁边 `<图名>.bigimgpin.json`(追加而不是替换
扩展名:`a.tif` 和 `a.png` 不能共用一份标注),同目录不可写时退回应用数据目录。

`loadPath` 里 **`image.value = prepared` 和 `applyAnnotations()` 必须在同一个同步块里**,
中间不能插 `await`:否则正在跑的自动保存会读到「新图 + 旧框」这个半新半旧的组合,
把 A 图的框写进 B 图的标注文件。读标注因此拆成 `fetchAnnotations`(异步、不碰状态)
和 `applyAnnotations`(同步)两步。

读不出已有的标注文件时(JSON 坏了、或版本更高)**停用自动保存**,而不是报个错接着存。
空标注覆盖掉的是用户唯一的产出物。mtime 存了但不参与「对不上」的判断 ——
拷贝文件就会改 mtime,拿它报警只会制造假警报,而被喊几次之后真警报也会被无视。

### 导出(坐标语义在前端)

`src-tauri/src/export.rs`。**坐标变换不在这一层**:要不要套「偏移 / 系数 k」的逆变换
由 `RectPanel.vue` 决定,它才是持有那套参数的地方;Rust 只管格式化、夹取和写盘。
坐标系语义有两个地方知道,迟早会分叉。

三条实测结论支撑的设计,改动前先看一眼:

- **CSV 必须带 UTF-8 BOM**,否则 Excel 按本地代码页解,中文列名直接乱码。
  列里全是数字所以不做转义 —— 以后要加「名称」这种可带逗号的列时必须补上。
- **CSV 的位数只负责打印,数值由前端收敛。** 两边各舍入一次会用到两套舍入规则
  (JS 的 `toFixed` 与 Rust 的格式化在恰好 .5 上不一致),同一个框在屏幕和表格里
  就可能不一样。
- **`normalize` 必须把框夹到图内。** 实测 vips 遇到越界直接 `bad extract area` 并且
  **不产出文件**;而界面上是故意允许画越界框的。夹取比较留在 f64 里做:
  坐标可能是 1e20,先转 u32 会饱和,相减反而变成「看着合法」的区域。
- **裁剪容器跟位深走**(`vips::crop_extension`)。实测 uchar/ushort → PNG 位深保留,
  而 **float → PNG 会被静默压成 8 位**。浮点/整数格式改用 TIFF。

`vips.rs` 里有两条会真的启动 vips 的测试(`crop_image_extracts_the_requested_region`
用它造一张「像素值 = 自己坐标」的 xyz 图来验证取到的是哪一块)。它们找不到 vips
二进制时**跳过**而不是失败,别改成 panic。参数顺序写错时裁剪尺寸照样是对的,
只有读像素值才抓得住。

### OpenSeadragon 配置里的两个坑

都在 `src/osd/useViewer.ts`,注释里有详细原因:

- `drawer: 'canvas'` **别换成 webgl** —— webgl drawer 走 XHR,会撞 range 请求相关的坑。
- 切换工具模式**不能用 `setMouseNavEnabled(false)`** —— 它会把滚轮缩放一起禁掉。要改
  `gestureSettingsByDeviceType('mouse').dragToPan`,OSD 每个指针事件实时读取它。

`maxImageCacheCount: 80` 是算过的:OSD 默认 200 且不按内存预算,1024 瓦片解码后 4MB/张,
默认值会吃掉 800MB。

## 切片默认值(改之前先读注释)

在 `src-tauri/src/commands.rs` 顶部:

- `tile_size = 1024`(不是 DZI 惯用的 256)。瓦片越大压缩率越高,但解码后内存也越大,
  1024 是实测折中。
- 格式默认 **WebP 无损**。同等内容比 PNG 小约 35%,且实测与 PNG 逐像素相减最大差值为 0。
- **不要默认 JPEG**。目标图是边缘锐利的版图类图像,JPEG 会在每条边产生振铃伪影,
  可能被误读成真实结构。
- PNG 压缩档用默认值。实测 compression=9 只省 8% 却慢数倍。

`vips::TileFormat::extension()` 会进 DZI 描述符再被前端拼成瓦片 URL,**不能带方括号**
(vips 只把格式名写进描述符,不写 `[lossless]` 这类选项)。有测试守着这条。

## 进度上报

`tile-progress` 有两条来源并行:vips 自己报的百分比(`VIPS_PROGRESS=1`,从 stdout 按
`\r` 切分解析),以及数已落盘瓦片文件的兜底估算(多线程下 vips 进度可能不平滑)。
前端取两者较大值以避免数字回退。

`parse_percent` **刻意不匹配任何前缀** —— 实际输出前缀是临时图像名(如 `vips temp-3:`),
不是操作名,而且名字会变。有测试用 `temp-3` 守着,防止有人「修正」成匹配 `dzsave`。

## 自动更新与发版

用官方 `tauri-plugin-updater`,**全量包**(NSIS 约 15MB,里面 10MB 是压过的 vips 树)。
更新源是 GitHub Releases 上的 `latest.json`,配在 `tauri.conf.json` 的
`plugins.updater.endpoints`。没做按文件增量:省下的那 12MB 不值当自己写一套
下载/替换/回滚,还得处理 Windows 上自替换的坑。

流程:**启动 3 秒后静默检查 → 后台下载 → 弹窗 → 用户点「立即重启」→ 安装 → 自动开回新版**。
前端逻辑全在 `src/components/UpdatePrompt.vue`,Rust 侧只注册插件(下载、验签、调起
安装器都是插件干的,见 `lib.rs`)。

几个不能动的点:

- `installMode: "quiet"` 让安装器收到 `/S /UPDATE /R`。**`/R` 是「装完自己开回来」的关键**:
  NSIS 模板的 `.onInstSuccess` 只在静默/被动模式且带 `/R` 时才 `RunAsUser` 拉起应用。
  去掉它,用户就得自己去开始菜单点一遍,正是要避免的事。
- 必须**先 download 再 install**,不能用 `downloadAndInstall` —— 安装会直接结束当前进程,
  得等用户点头。包下好了但用户点了「稍后」,再点按钮是把弹窗调出来,不重新下。
- dev 下只检查不安装:跑的是 `target/debug` 里的 exe,装下去会把正在调试的产物换掉。
- 签名私钥在 `~/.tauri/bigimgpin.key`,**不在仓库里也不该进仓库**。它丢了就再也签不出
  客户端认的更新包,只能让所有用户重装。

**具体操作步骤**(发版前查什么、怎么验证更新真的生效、常见故障对照)在
`.claude/skills/release/SKILL.md`,本节只留设计决策和坑。

发版就是两步:

```bash
# 先改 src-tauri/tauri.conf.json 里的 version
npm run release -- --notes-file /tmp/说明.md
```

说明文本走**文件**而不是 `--notes`:多行参数会在 npm → shell 那段被按换行拆开,
脚本只拿到第一行且不报错(v0.2.0 踩过,更新弹窗里只剩半句话)。

验证时注意 `releases/latest/download/latest.json` **走 CDN 缓存**,刚重传的资产
不会立刻生效;要确认内容得用 `gh api .../releases/assets/<id>` 绕开它。

`scripts/release.mjs` 会带着私钥路径构建、生成 `latest.json`、用 `gh` 建 Release 上传。
前置:装 GitHub CLI(`winget install --id GitHub.cli`)并 `gh auth login`。
加 `--dry-run` 可以从现有产物生成 `latest.json` 并列出要传的文件,不构建也不上传。

**`createUpdaterArtifacts` 开着但没给私钥时,`tauri build` 会以退出码 1 结束** ——
安装包(msi/nsis)照样产出,只是没有 `.nsis.zip` 和 `.sig`。报错只有一行
`A public key has been found, but no private key`。不知道这条的话很容易以为构建坏了。

签名要同时给两个环境变量,缺一不可(`release.mjs` 已经处理好):

- `TAURI_SIGNING_PRIVATE_KEY` 传**密钥内容**,不是路径。传
  `TAURI_SIGNING_PRIVATE_KEY_PATH` 实测不生效,表现就是「no private key」。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **密钥没设密码也要给个空串**。CLI 只要看不到
  这个变量就一律弹密码提示,而它在非交互环境里不报错,是**永久挂住等 stdin** ——
  表现为构建卡在 `Decrypting updater signing key, expect a prompt for password` 不动。

`latest.json` 这个文件名写死在 endpoint URL 里(`releases/latest/download/latest.json`),
不能改。客户端只认里面的 minisign 签名,公钥在 `tauri.conf.json`。

打包另有一个坑:图标是**编译期**嵌进 exe 的(`build.rs` 里那行 `rerun-if-changed=icons`
就是为它加的)。换图标后不重新构建,exe 里还是旧图标。

## 仓库卫生

根目录那张几十 MB 的 `.png` 是测试样图,被 `.gitignore` 排除,不要提交。
`src-tauri/resources/vips-win64/` 同理(解压后约 150MB)。
