# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

bigImage 是一个超大图查看与标注工具(Tauri 2 + Vue 3 + TypeScript)。Rust 侧调用外部
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
npx tauri build          # 打包

# Rust 单元测试(在 src-tauri/ 下,或在仓库根加 --manifest-path src-tauri/Cargo.toml)
cargo test
cargo test cache_key_changes_with_slice_params   # 单个测试
```

前端**没有**测试框架(无 vitest/jest),不要凭空新增。逻辑验证靠 `vue-tsc` 加手动跑
`tauri dev`。Rust 侧的 `#[cfg(test)]` 覆盖在 `src-tauri/src/*.rs` 文件末尾,改到这些
纯函数时同步改测试。

## 运行前置:libvips

vips 是**外部二进制,不是链接进来的库**,运行时才定位(见 `src-tauri/src/vips.rs`
的 `resolve_vips`)。查找顺序:随包捆绑 → `BIGIMAGE_VIPS` 环境变量 → macOS brew 的
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
瓦片通过自定义协议 bigimage://localhost/tiles/<id>/image_files/... 加载
```

前后端的类型契约:Rust `commands::PreparedImage` ↔ `src/types.ts` 的 `PreparedImage`,
serde 用 `rename_all = "camelCase"`。改一边必须改另一边。

### 前端不碰 invoke

所有 Rust 命令与事件都封在 `src/api/tauri.ts`,组件只 import 它。新增命令要三处同步:
`src-tauri/src/lib.rs` 的 `generate_handler!`、`src/api/tauri.ts`、`src/types.ts`。

### 自定义协议(易错)

`src-tauri/src/tiles_protocol.rs` 的 `protocol_origin()` 是 URL 前缀的**唯一收敛点**:
Windows/Android 上是 `http://bigimage.localhost`,其他平台是 `bigimage://localhost`。
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

框坐标统一 `roundRect` 收敛到 2 位小数(用 `toFixed` 而非 `Math.round(v*100)/100`,
后者有二进制浮点误差)。所有框进列表前都要过这一关。

### 叠加层是自己画的 SVG

`src/osd/useAnnotationSvg.ts` 把网格、辅助线、框、预览框全画在**一个屏幕空间的 `<svg>`**
上,监听 `update-viewport` 整层重绘。**不要改用 `viewer.addOverlay()`**:它的 location 是
viewport 坐标而非图像坐标(整体偏移且随缩放变化),而且每个 overlay 都会每帧强制
reflow。重绘路径可以照抄 `draw()`。

屏幕空间绘制的好处是线宽恒为 2px,不随缩放变成色块。

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

## 仓库卫生

根目录那张几十 MB 的 `.png` 是测试样图,被 `.gitignore` 排除,不要提交。
`src-tauri/resources/vips-win64/` 同理(解压后约 150MB)。
