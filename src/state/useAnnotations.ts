/**
 * 标注状态:框、辅助线、选中项,以及撤销 / 重做。
 *
 * 为什么单独抽一层:**撤销的本质不是「加个栈」,而是「所有改动都走同一个入口」**。
 * 状态散在各个组件里直接改的话,每加一个功能(改尺寸、命名、批量删除、导入文件)
 * 都要再想一遍怎么接进撤销;而「导入整份文件」这种一次性替换全部状态的操作,
 * 用给每个操作配一个逆操作的写法根本接不进去。快照式就没有这个问题。
 *
 * 撤的是「画了什么」,不撤选中态:撤销一个删除之后连选中一起还原,
 * 会让「再按一次 Delete」变得不可预测。
 */
import { computed, ref, shallowRef } from 'vue'

import { roundRect } from '../osd/coords'
import type { Guide, Rect, Region } from '../types'

/** 一次可撤销的状态快照。存的是数组引用,框对象不在快照之间复制。 */
interface Snapshot {
  regions: Region[]
  guides: Guide[]
}

/** 撤销栈深度。一份快照只有两个指针的开销,100 步在这个量级下可以忽略。 */
const HISTORY_LIMIT = 100

/**
 * 方向键连按的合并窗口。
 * 长按方向键会连发几十次 keydown,一次一条记录的话撤销栈瞬间就被微调冲没了。
 */
const NUDGE_COALESCE_MS = 500

/** 新框的配色。深浅主题共用 —— 它们画在图像上,不画在界面上。 */
const PALETTE = ['#ff4d4f', '#40a9ff', '#73d13d', '#ffa940', '#b37feb', '#36cfc9']

export function useAnnotations() {
  // 全部浅层:这里的数组从不原地修改,每次改动都是整体替换。
  // 深层响应式会把每个框都包一层 Proxy,而这个规模下没有任何一处需要它。
  const regions = shallowRef<Region[]>([])
  const guides = shallowRef<Guide[]>([])
  const selectedId = ref<string | null>(null)

  const history = shallowRef<Snapshot[]>([{ regions: [], guides: [] }])
  const cursor = ref(0)

  /**
   * 每次「用户改了内容」自增,自动保存盯着它。
   *
   * 不能直接 watch regions:拖拽过程中每个 pointermove 都会换掉数组,
   * 一次拖拽(几十帧)会触发几十次写盘。
   */
  const revision = ref(0)

  let paletteIndex = 0
  let regionSeq = 0
  let lastNudgeAt = 0

  const canUndo = computed(() => cursor.value > 0)
  const canRedo = computed(() => cursor.value < history.value.length - 1)

  // -------------------------------------------------------------- 历史

  function apply(snap: Snapshot) {
    regions.value = snap.regions
    guides.value = snap.guides
    // 选中项可能已经不在还原后的状态里了(比如撤销掉一个新建的框)
    if (selectedId.value && !snap.regions.some((r) => r.id === selectedId.value)) {
      selectedId.value = null
    }
  }

  /** 只压栈。coalesce 为 true 时覆盖栈顶而不是压新的一层。 */
  function push(coalesce: boolean) {
    const snap: Snapshot = { regions: regions.value, guides: guides.value }
    history.value =
      coalesce && cursor.value > 0
        ? [...history.value.slice(0, cursor.value), snap]
        : [...history.value.slice(0, cursor.value + 1), snap]

    if (history.value.length > HISTORY_LIMIT) {
      history.value = history.value.slice(history.value.length - HISTORY_LIMIT)
    }
    // 无论走哪条分支,cursor 都落在栈顶
    cursor.value = history.value.length - 1
    revision.value += 1
  }

  /** 记一个还原点。改完状态就调用它。 */
  function commit() {
    // 打断微调的合并窗口,否则「微调 → 删除 → 微调」会把删除那一步的还原点冲掉
    lastNudgeAt = 0
    push(false)
  }

  function undo() {
    if (!canUndo.value) return
    cursor.value -= 1
    apply(history.value[cursor.value])
    revision.value += 1
  }

  function redo() {
    if (!canRedo.value) return
    cursor.value += 1
    apply(history.value[cursor.value])
    revision.value += 1
  }

  /**
   * 换图 / 读入一份标注:整份替换并清空历史。
   * 旧图的撤销记录对新图没有意义 —— 留着的话,在新图上按撤销会把旧图的框贴过来。
   */
  function reset(nextRegions: Region[], nextGuides: Guide[]) {
    regions.value = nextRegions
    guides.value = nextGuides
    selectedId.value = null
    history.value = [{ regions: nextRegions, guides: nextGuides }]
    cursor.value = 0
    lastNudgeAt = 0
    // 计数器要跳过文件里已经用过的编号,否则接着画的框会和读进来的框撞 id
    regionSeq = nextRegions.reduce((max, r) => Math.max(max, seqOf(r.id)), 0)
  }

  function seqOf(id: string): number {
    const parsed = Number.parseInt(id.replace(/^r/, ''), 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  // -------------------------------------------------------------- 改动

  function addRegion(rect: Rect): Region {
    const color = PALETTE[paletteIndex % PALETTE.length]
    paletteIndex += 1
    regionSeq += 1
    // 这里是所有框进入列表的**唯一**入口,统一收敛精度。
    // 拖拽画出来的框坐标来自屏幕反算,是带一长串小数的浮点数。
    const region: Region = { ...roundRect(rect), id: `r${regionSeq}`, color }
    regions.value = [...regions.value, region]
    selectedId.value = region.id
    commit()
    return region
  }

  /**
   * 只改坐标,不记还原点 —— 拖拽过程中会连发几十次,由调用方在松手时 commit()。
   * 单独一个方法而不是给 commit 加参数:调用点要能一眼看出「这次改动会不会进撤销」。
   */
  function setRegionRect(id: string, rect: Rect) {
    regions.value = regions.value.map((region) =>
      region.id === id ? { ...region, ...roundRect(rect) } : region,
    )
  }

  /** 方向键微调。连续按键合并成一条撤销记录。 */
  function nudge(id: string, dx: number, dy: number) {
    const region = regions.value.find((r) => r.id === id)
    if (!region) return

    const now = Date.now()
    const merging = now - lastNudgeAt < NUDGE_COALESCE_MS
    lastNudgeAt = now

    setRegionRect(id, { x: region.x + dx, y: region.y + dy, w: region.w, h: region.h })
    push(merging)
  }

  function removeRegion(id: string) {
    regions.value = regions.value.filter((r) => r.id !== id)
    if (selectedId.value === id) selectedId.value = null
    commit()
  }

  /**
   * 只清框。
   *
   * 之前这里连辅助线一起清 —— 但按钮在「框列表」里,名字叫「清空全部」,
   * 用户无从得知双击误放的一条辅助线要付出「连所有框一起没了」的代价。
   * 两者各有各的清除入口。
   */
  function clearRegions() {
    regions.value = []
    selectedId.value = null
    commit()
  }

  function addGuide(guide: Guide) {
    // 同一位置附近重复放只留一条:双击连发很容易在同一个 y 上叠出好几条
    const kept = guides.value.filter(
      (g) => !(g.axis === guide.axis && Math.abs(g.pos - guide.pos) < 2),
    )
    guides.value = [...kept, guide]
    commit()
  }

  function removeGuide(index: number) {
    guides.value = guides.value.filter((_, i) => i !== index)
    commit()
  }

  function clearGuides() {
    guides.value = []
    commit()
  }

  return {
    regions,
    guides,
    selectedId,
    revision,
    canUndo,
    canRedo,
    addRegion,
    setRegionRect,
    nudge,
    removeRegion,
    clearRegions,
    addGuide,
    removeGuide,
    clearGuides,
    commit,
    undo,
    redo,
    reset,
  }
}
