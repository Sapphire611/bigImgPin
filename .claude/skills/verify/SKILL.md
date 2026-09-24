---
name: verify
description: Use when verifying a change to bigImgPin (验证/跑一下/确认改动生效/验界面/测客户端), or before reporting "改好了". Covers the mechanical checks, driving the real client over CDP, and the traps that make a broken change look green.
---

# bigImgPin 的验证

前端没有测试框架,但**不代表界面只能靠人点**。这个 skill 讲按什么顺序验、拿什么当证据。

## 一、机械检查(先跑,顺序由便宜到贵)

```bash
npx vue-tsc --noEmit              # 类型
cd src-tauri && cargo test        # Rust 单测
cargo clippy --all-targets        # 别漏,它对 unused 之类的很敏感
npm run build                     # 类型 + 打包
```

⚠️ **要退出码就别接管道。** `cargo test 2>&1 | tail -30` 的退出码是 `tail` 的,恒为 0 ——
构建明明失败也会看着像成功。2026-09-24 就这样误报过一次「Rust 侧过了」,实际是
原始字符串里 `"#` 提前闭合导致的编译错误。要用尾巴输出就补一句:

```bash
cargo test > /tmp/t.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t.log
```

## 二、驱动真客户端(界面改动的证据来源)

WebView2 支持远程调试,连上去就能发真输入:

```bash
npm run dev:web &                    # debug 产物在 dev 模式下连的就是它
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./src-tauri/target/debug/bigimgpin.exe
node scripts/cdp.mjs 步骤.json       # 驱动脚本在仓库里,用法见文件头
```

**为什么用这个而不是浏览器里跑 `dev:web`**:纯浏览器里没有 Tauri API,`invoke` 全废,
图片根本加载不了,等于只验了个面板外壳。CDP 连的是真客户端:切片、缓存、协议、
文件落盘全都真的跑。

**为什么不是截图**:本机 125% DPI,窗口坐标和硬编码裁剪区域对不上,而且模型会漏看小字
(实测漏报过整个按钮)。CDP 拿到的是坐标、选区、DOM 结构、磁盘文件 —— 客观、可复算。

## 三、断言读什么

| 读什么 | 怎么读 | 适合验 |
|---|---|---|
| DOM | `document.querySelector(...)` | 界面结构、文本、`:disabled`、class |
| 内部状态 | `document.querySelector('#app')._vnode.component.setupState` | 坐标、选中集、撤销栈可用性 |
| **磁盘** | 直接读文件(`<图名>.bigimgpin.json` 等) | 「真的存下去了」这件事 |

`setupState` 只在 dev 构建里有(生产构建没有)✓ 正好,验证都是在 dev 下做的。
**里面的 ref 已经自动解包,别再写 `.value`** —— 写了会静默得到 `undefined`,
JSON 里那个字段直接消失,看着像「没这个数据」。

加载图片不需要点原生对话框,直接调内部函数:

```js
setupState.loadPath('C:/Users/.../测试图.tif')
```

## 四、踩过的坑

1. **设完输入框的值,不能在同一次 eval 里就点按钮。** Vue 的 `:disabled` 是渲染时算的,
   那一刻按钮还是禁用的,`.click()` 被**静默吞掉** —— 表现为「点了没反应」,很像 bug。
   中间留一个 `{"wait":200}`,或者拆成两次 eval。
2. **手柄/命中点的位置每拖一次就变。** 要连续测几次,每轮**先探一次位置**再拖。
   拿上一轮的坐标去拖,会按在框身上 —— 于是你以为在测 resize,其实测的是 move
   (2026-09-24 就这么白测了一轮)。
3. **坐标系差一个偏移。** CDP 的鼠标坐标是**视口坐标**,App 里的 `handleAt` 用的是
   「相对 `viewer.element` 左上角」。量位置时必须加 `getBoundingClientRect().left/top`,
   否则差一个工具栏的高度。
4. **拖拽三个事件都要给对参数**(见 `scripts/cdp.mjs` 文件头)。少一个就退化成「点一下」。
5. **git-bash 会把 `/tmp/x` 转成 Windows 路径给原生程序,但不转 JS/JSON 字符串里的。**
   `gh --notes-file /tmp/x.md` 能用,`node -e "...'/tmp/x.md'..."` 会 ENOENT 到 `C:\tmp\x.md`。
   传给 node 时用 `cygpath -w` 换成真路径。
6. **JSON 字符串里不能写 `\s`** —— 步骤文件里的正则要写 `\\s`。省事的话干脆别用正则。
7. **建测试图**:`vips xyz out 2000 1500` 出一张「每个像素的值 = 它自己的坐标」的图,
   裁完读回像素值就能证明**取到的是哪一块**(只比对尺寸抓不住参数顺序写反)。
   注意 `--csize N` 会把高度变成 H×N(libvips 把第三维摞在高度上),建完用
   `vipsheader -a` 核一下再往下走。

## 五、够不着的地方(这些才找人)

- **系统画的对话框**:保存文件、选目录。CDP 驱动不了,所以「导出 CSV / 裁剪图」的
  对话框那一段只能人点;内容本身靠 Rust 单测覆盖(见 `src-tauri/src/export.rs`)。
- **审美判断**:配色好不好看、间距舒不舒服。
- 真机上的手感(拖动跟不跟手)。
