<script setup lang="ts">
import { computed, ref } from 'vue'

import { formatCoord } from '../osd/coords'
import type { Guide, Rect, Region } from '../types'

const props = defineProps<{
  regions: Region[]
  guides: Guide[]
  selectedId: string | null
  imageWidth: number
  imageHeight: number
  hasImage: boolean
}>()

const emit = defineEmits<{
  add: [Rect]
  remove: [string]
  select: [string | null]
  clearRegions: []
  removeGuide: [number]
  clearGuides: []
  focus: [Region]
}>()

/** `axis: 'x'` 是竖线(约束 x),`axis: 'y'` 是横线(约束 y)。 */
function guideLabel(guide: Guide): string {
  return guide.axis === 'x'
    ? `x = ${formatCoord(guide.pos)}`
    : `y = ${formatCoord(guide.pos)}`
}

// 用字符串存输入值,这样才能保留用户正在输入的中间态(比如空字符串、末尾的小数点)
const x = ref('')
const y = ref('')
const w = ref('')
const h = ref('')
// 偏移/系数默认留空 —— 空着就是不参与变换,和填 0 / 1 等价
const offsetX = ref('')
const offsetY = ref('')
const factor = ref('')

const xN = computed(() => Number.parseFloat(x.value))
const yN = computed(() => Number.parseFloat(y.value))
const wN = computed(() => Number.parseFloat(w.value))
const hN = computed(() => Number.parseFloat(h.value))
const offsetXN = computed(() => Number.parseFloat(offsetX.value))
const offsetYN = computed(() => Number.parseFloat(offsetY.value))
const kN = computed(() => Number.parseFloat(factor.value))

/** 偏移/系数留空时按「没填」算 —— 偏移视为 0、系数视为 1,也就是不改变数值。 */
const k = computed(() => (Number.isFinite(kN.value) ? kN.value : 1))
const dx = computed(() => (Number.isFinite(offsetXN.value) ? offsetXN.value : 0))
const dy = computed(() => (Number.isFinite(offsetYN.value) ? offsetYN.value : 0))

const baseValid = computed(
  () =>
    Number.isFinite(xN.value) &&
    Number.isFinite(yN.value) &&
    Number.isFinite(wN.value) &&
    Number.isFinite(hN.value) &&
    wN.value > 0 &&
    hN.value > 0,
)

/**
 * 坐标变换的结果,也是「生成框」唯一的取值来源。
 *
 *     x' = (x + offsetX) · k
 *     y' = (y + offsetY) · k
 *     w' = w · k
 *     h' = h · k
 *
 * 顺序是**先平移、后缩放**:偏移量用来对齐原点,系数用来对齐尺度。
 * 宽高只受 k 影响 —— 平移改不了大小,给宽高加偏移在几何上没有意义。
 *
 * 偏移/系数没填时不参与变换(见上面的 k/dx/dy),所以什么都不填就等于按原值生成。
 */
const transformed = computed<Rect | null>(() => {
  if (!baseValid.value) return null

  return {
    x: (xN.value + dx.value) * k.value,
    y: (yN.value + dy.value) * k.value,
    w: wN.value * k.value,
    h: hN.value * k.value,
  }
})

/** 结果超出图像范围时给出提示,但不阻止 —— 有时就是要生成越界的框来对照 */
const scaledOutOfBounds = computed(() => {
  const result = transformed.value
  if (!result || !props.hasImage) return false
  return (
    result.x < 0 ||
    result.y < 0 ||
    result.x + result.w > props.imageWidth ||
    result.y + result.h > props.imageHeight
  )
})

/** 恒等变换 —— 用于提示用户「当前变换不会改变数值」 */
const isIdentityTransform = computed(() => dx.value === 0 && dy.value === 0 && k.value === 1)

function addTransformed() {
  const rect = transformed.value
  if (rect) emit('add', rect)
}

/** 把选中框的数值填回输入框,方便在此基础上改或缩放 */
function loadFrom(region: Region) {
  // 用 formatCoord 而不是直接 String() —— 后者会把完整的浮点尾数倒进输入框
  x.value = formatCoord(region.x)
  y.value = formatCoord(region.y)
  w.value = formatCoord(region.w)
  h.value = formatCoord(region.h)
  emit('select', region.id)
}
</script>

<template>
  <div class="panel">
    <section>
      <h3>坐标输入</h3>
      <div class="grid">
        <label>x<input v-model="x" type="number" placeholder="0" /></label>
        <label>y<input v-model="y" type="number" placeholder="0" /></label>
        <label>w<input v-model="w" type="number" placeholder="宽" /></label>
        <label>h<input v-model="h" type="number" placeholder="高" /></label>
      </div>
    </section>

    <section>
      <h3>偏移与系数</h3>

      <div class="grid">
        <label>偏移 x<input v-model="offsetX" type="number" placeholder="0" /></label>
        <label>偏移 y<input v-model="offsetY" type="number" placeholder="0" /></label>
      </div>

      <label class="factor">
        系数 k
        <input v-model="factor" type="number" step="0.1" placeholder="1" />
      </label>

      <p class="formula">
        x' = (x + 偏移x) · k<br />
        y' = (y + 偏移y) · k<br />
        w' = w · k
      </p>

      <div v-if="transformed" class="preview mono" :class="{ warn: scaledOutOfBounds }">
        → {{ formatCoord(transformed.x) }}, {{ formatCoord(transformed.y) }},
        {{ formatCoord(transformed.w) }}, {{ formatCoord(transformed.h) }}
      </div>
      <div v-else class="preview empty">填入完整的 x, y, w, h 后显示结果</div>

      <button class="wide solid" :disabled="!transformed" @click="addTransformed">生成框</button>

      <p v-if="isIdentityTransform && transformed" class="hint">
        偏移/系数未填,按原值生成
      </p>
      <p v-if="scaledOutOfBounds" class="hint warn-text">
        结果超出图像范围({{ imageWidth }} × {{ imageHeight }})
      </p>
    </section>

    <section>
      <h3>
        框列表
        <span class="count">{{ regions.length }}</span>
      </h3>

      <p v-if="regions.length === 0" class="empty">还没有框。拖拽画面或在上面输入坐标。</p>

      <ul v-else class="list">
        <li
          v-for="(region, index) in regions"
          :key="region.id"
          :class="{ selected: region.id === selectedId }"
          @click="emit('select', region.id === selectedId ? null : region.id)"
        >
          <span class="dot" :style="{ background: region.color }" />
          <span class="idx">{{ index + 1 }}</span>
          <span class="text mono">
            <span class="pos">
              x {{ formatCoord(region.x) }} · y {{ formatCoord(region.y) }}
            </span>
            <span class="size">
              w {{ formatCoord(region.w) }} × h {{ formatCoord(region.h) }}
            </span>
          </span>
          <span class="actions">
            <button class="mini" title="跳转到该框" @click.stop="emit('focus', region)">定位</button>
            <button class="mini" title="填入输入框" @click.stop="loadFrom(region)">填入</button>
            <button class="mini danger" title="删除" @click.stop="emit('remove', region.id)">×</button>
          </span>
        </li>
      </ul>

      <button v-if="regions.length > 0" class="wide danger" @click="emit('clearRegions')">
        清空全部框
      </button>
    </section>

    <section>
      <h3>
        辅助线
        <span class="count">{{ guides.length }}</span>
      </h3>

      <p v-if="guides.length === 0" class="empty">
        双击画面放一条横线,Shift + 双击放竖线。
      </p>

      <template v-else>
        <ul class="list guides">
          <li v-for="(guide, index) in guides" :key="`${guide.axis}-${guide.pos}-${index}`">
            <span class="axis mono">{{ guide.axis === 'x' ? '│' : '─' }}</span>
            <span class="text mono">
              <span class="pos">{{ guideLabel(guide) }}</span>
              <span class="size">{{ guide.axis === 'x' ? '竖线' : '横线' }}</span>
            </span>
            <span class="actions">
              <button class="mini danger" title="删除这条辅助线" @click="emit('removeGuide', index)">
                ×
              </button>
            </span>
          </li>
        </ul>

        <button class="wide danger" @click="emit('clearGuides')">清空辅助线</button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.panel {
  width: 268px;
  flex-shrink: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 12px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 徽章用 --stage 而不是 --raise:浅色主题下 --raise 是纯白,贴在 --panel 上看不出来 */
.count {
  background: var(--stage);
  border-radius: var(--r-md);
  padding: 1px 7px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
}

.grid label {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}

/* 输入框做成凹进去的井:底色比 panel 深/浅一层,再加一圈比 --border 更实的边。
   它整个边界都靠这两样说明,不像按钮还有标签兜底。 */
input {
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-strong);
  background: var(--stage);
  color: var(--text);
  font-size: 12px;
}

.factor {
  justify-content: space-between;
}

.factor input {
  width: 92px;
}

.wide {
  width: 100%;
}

/* 列表行里的三个小按钮做成无边框的:一行里并排三个描边按钮太吵,
   而它们在 268px 的面板里只是次要操作 */
button.mini {
  padding: 2px 7px;
  font-size: 11px;
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
}

/* 底色用 --stage 而不是 --raise:行本身 hover/选中时就是 --raise,
   再叠一层同色的 hover 会完全看不出按到了 */
button.mini:hover:not(:disabled) {
  background: var(--stage);
  border-color: transparent;
  color: var(--text);
}

/* 删除按钮的红色要撑过 hover —— 上面那条 hover 会把颜色拉回 --text,
   而具体色值相同,权重更高的这条正好盖住它 */
button.mini.danger,
button.mini.danger:hover:not(:disabled) {
  color: var(--danger-text);
}

button.mini.danger:hover:not(:disabled) {
  background: var(--danger-bg);
}

.formula,
.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--font-mono);
}

/* 变换公式有三行,行高太挤会看不清哪行是哪行 */
.formula {
  line-height: 1.7;
}

.preview {
  padding: 6px 8px;
  border-radius: var(--r-sm);
  background: var(--stage);
  border: 1px solid var(--border);
  color: var(--ok-text);
  font-size: 12px;
}

.preview.empty {
  color: var(--text-faint);
  font-family: inherit;
}

.preview.warn {
  color: var(--warn-text);
}

.warn-text {
  color: var(--warn-text);
}

.empty {
  margin: 0;
  color: var(--text-faint);
  line-height: 1.5;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 240px;
  overflow-y: auto;
}

.list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--r-sm);
  cursor: pointer;
}

.list li:hover {
  background: var(--raise);
}

/* 选中不靠颜色 —— chrome 里没有颜色可用。用左边一道实心标记,
   不占布局(inset shadow),也不随 hover 变化,扫一眼就能定位到是哪一行。 */
.list li.selected {
  background: var(--raise);
  box-shadow: inset 2px 0 0 var(--text);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.idx {
  color: var(--text-faint);
  width: 14px;
  flex-shrink: 0;
}

/* 坐标带 2 位小数后一行放不下(268px 面板),所以拆成两行 */
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

.pos {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.12s;
}

.list li:hover .actions,
.list li.selected .actions {
  opacity: 1;
}

/* 辅助线的删除按钮**常驻显示**。
   框是会上百个的,藏起来能省视觉噪声;辅助线通常只有几条,
   而「加进去删不掉」是用户明确抱怨过的问题,不该再藏在 hover 后面。 */
.list.guides .actions {
  opacity: 1;
}

/* 用画布上那条辅助线自己的颜色,一眼对上号 —— 这是全文件里唯一一处
   「颜色当信息用」的地方 */
.axis {
  color: var(--guide);
  width: 14px;
  flex-shrink: 0;
  text-align: center;
}
</style>
