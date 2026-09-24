/**
 * 用 CDP 驱动**真客户端**的 WebView,验证界面改动。
 *
 * 用法:先按下面两步把客户端跑起来,再
 *
 *     node scripts/cdp.mjs 步骤.json
 *
 * 起客户端(debug 产物在 dev 模式下连的就是 vite):
 *
 *     npm run dev:web &
 *     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
 *       ./src-tauri/target/debug/bigimgpin.exe
 *
 * 为什么值得费这个劲:`Input.dispatchMouseEvent` / `dispatchKeyEvent` 走的是
 * Chromium 完整的输入管线,**pointerdown/move/up 会真触发** —— 拖手柄、Ctrl 点多选、
 * 按 Delete 都验得了,不是「手动调一下事件处理函数」。断言读 DOM、读 setupState、
 * 读磁盘上的文件,拿到的是坐标和结构而不是像素(本机 125% DPI,截图不可信)。
 *
 * 步骤文件是一个数组,按顺序执行,每步的结果按顺序打到 stdout:
 *
 *     [
 *       {"eval": "JS 表达式(可以是 async,会 await)"},
 *       {"mouse": {...Input.dispatchMouseEvent 的参数}},
 *       {"key":   {...Input.dispatchKeyEvent 的参数}},
 *       {"text":  "用 Input.insertText 打进当前焦点"},
 *       {"wait":  300}
 *     ]
 *
 * 拖拽要三个事件都带对参数,少一个就变成「点一下」:
 *     {"mouse":{"type":"mousePressed","x":100,"y":200,"button":"left","buttons":1,"clickCount":1}}
 *     {"mouse":{"type":"mouseMoved","x":110,"y":210,"button":"left","buttons":1}}
 *     {"mouse":{"type":"mouseReleased","x":110,"y":210,"button":"left","buttons":0,"clickCount":1}}
 * 双击是 clickCount:2;Ctrl+点是 modifiers:2(Alt=1 Ctrl=2 Meta=4 Shift=8)。
 *
 * 两个容易白忙一场的地方(详见 .claude/skills/verify/SKILL.md):
 *  - **设完输入框的值不能在同一次 eval 里就点按钮** —— Vue 的 :disabled 要等重渲染,
 *    那一刻按钮还是禁用的,.click() 会被静默吞掉。中间留一个 {"wait":200}。
 *  - 坐标是**视口坐标**,而 App 里的命中检测用的是「相对 viewer.element 左上角」,
 *    两者差一个工具栏的高度 —— 量位置时记得加 `getBoundingClientRect().left/top`。
 */
import { readFileSync } from 'node:fs'

const specPath = process.argv[2]
if (!specPath) {
  console.error('用法:node scripts/cdp.mjs 步骤.json')
  process.exit(1)
}

const port = process.env.BIGIMGPIN_CDP_PORT ?? '9222'
const steps = JSON.parse(readFileSync(specPath, 'utf8'))

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
if (!target) {
  console.error(`端口 ${port} 上没有 page 目标 —— 客户端起了吗?`)
  console.error('  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \\')
  console.error('    ./src-tauri/target/debug/bigimgpin.exe')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message)
  }
})
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

const results = []
for (const step of steps) {
  if (step.wait) {
    await new Promise((resolve) => setTimeout(resolve, step.wait))
    continue
  }
  if (step.mouse) {
    const response = await send('Input.dispatchMouseEvent', step.mouse)
    if (response.error) results.push({ mouse: step.mouse.type, error: response.error })
    continue
  }
  if (step.key) {
    const response = await send('Input.dispatchKeyEvent', step.key)
    if (response.error) results.push({ key: step.key.key, error: response.error })
    continue
  }
  if (step.text !== undefined) {
    const response = await send('Input.insertText', { text: step.text })
    if (response.error) results.push({ text: step.text, error: response.error })
    continue
  }
  if (step.eval) {
    const response = await send('Runtime.evaluate', {
      expression: step.eval,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.error) {
      results.push({ error: response.error })
      continue
    }
    const thrown = response.result?.exceptionDetails
    results.push(thrown ? { exception: thrown.exception?.description ?? thrown.text } : response.result?.result?.value)
  }
}

console.log(JSON.stringify(results, null, 2))
ws.close()
process.exit(0)
