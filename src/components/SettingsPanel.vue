<script setup lang="ts">
/**
 * 设置:缓存维护 + 切片参数。
 *
 * 两件事放一起是因为它们互相牵制 —— 改了切片参数会让已切过的图按新参数重切一份,
 * 而清缓存是把所有旧瓦片抹掉。放在同一个面板里,用户才能看到「改参数」和
 * 「旧瓦片会堆积」之间的因果。
 */
import { computed, onMounted, ref } from 'vue'

import { formatBytes } from '../api/tauri'
import * as api from '../api/tauri'
import { TILE_FORMAT_CHOICES, TILE_SIZE_CHOICES, tileFormat, tileSize } from '../state/slicePrefs'
import type { PreparedImage } from '../types'

const props = defineProps<{
  image: PreparedImage | null
  /** 切片进行中不许清缓存:正在写入的那个瓦片目录会被删到一半 */
  slicing: boolean
}>()

const emit = defineEmits<{
  close: []
  /** 缓存清完了。App 要据此把当前图关掉 —— 瓦片都没了,画面只会是一片空白 */
  cleared: []
}>()

const stats = ref<{ bytes: number; count: number } | null>(null)
const loading = ref(true)
const clearing = ref(false)
const failed = ref<string | null>(null)

const totalText = computed(() => {
  if (loading.value) return '统计中…'
  if (!stats.value) return '—'
  return `${formatBytes(stats.value.bytes)} · ${stats.value.count} 张图`
})

const currentText = computed(() => {
  if (!props.image) return '—'
  return `${formatBytes(props.image.cacheBytes)} ${props.image.fromCache ? '(已缓存)' : '(本次生成)'}`
})

const nothingToClear = computed(
  () => !loading.value && (stats.value?.count ?? 0) === 0,
)

async function refresh() {
  loading.value = true
  try {
    const [bytes, count] = await api.cacheStats()
    stats.value = { bytes, count }
  } catch (error) {
    failed.value = String(error)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

async function clearCache() {
  clearing.value = true
  failed.value = null
  try {
    await api.clearCache()
    await refresh()
    emit('cleared')
  } catch (error) {
    failed.value = String(error)
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="设置">
      <header>
        <h2>设置</h2>
        <button class="close" title="关闭" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <section>
        <h3>瓦片缓存</h3>

        <!--
          两个数必须并排给:上面那个是**全部**图片加起来,下面那个只是当前这张。
          只给一个数的话,用户会拿状态栏里那张图的数字去估计能清出多少空间。
        -->
        <dl class="stats">
          <div>
            <dt>全部图片</dt>
            <dd class="mono">{{ totalText }}</dd>
          </div>
          <div>
            <dt>当前图片</dt>
            <dd class="mono">{{ currentText }}</dd>
          </div>
        </dl>

        <button
          class="wide danger"
          :disabled="slicing || clearing || nothingToClear"
          :title="slicing ? '正在切片,等它结束再清' : undefined"
          @click="clearCache"
        >
          {{ clearing ? '正在清理…' : image ? '清理全部缓存并关闭当前图片' : '清理全部缓存' }}
        </button>

        <p class="hint">
          清理后,已经切过的图下次打开要重新切片(每张可能几分钟)。
          <b>标注不受影响</b> —— 它存在图片旁边,不在这里。
        </p>
      </section>

      <section>
        <h3>切片参数</h3>

        <label class="row">
          瓦片尺寸
          <select v-model.number="tileSize">
            <option v-for="size in TILE_SIZE_CHOICES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>

        <label class="row">
          瓦片格式
          <select v-model="tileFormat">
            <option v-for="choice in TILE_FORMAT_CHOICES" :key="choice.value" :value="choice.value">
              {{ choice.label }}
            </option>
          </select>
        </label>

        <p class="hint">
          只影响<b>之后打开</b>的图。改完再打开已经切过的图,会按新参数重切一份,旧的那份
          留在磁盘上(要清就上面的按钮)。
        </p>
        <p class="hint">
          尺寸越大压缩率越高,但单张瓦片解码后越占内存(1024 实测折中)。
          PNG 是无损的;没给 JPEG 选项 —— 边缘锐利的图上有振铃,可能被误读成真实结构。
        </p>
      </section>

      <p v-if="failed" class="failed">{{ failed }}</p>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.sheet {
  width: 420px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow);
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.close {
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1;
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
}

.close:hover:not(:disabled) {
  background: var(--raise);
  border-color: transparent;
  color: var(--text);
}

section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

/* 读数表:标签在左,等宽数字在右 —— 和状态栏同一套语言 */
.stats {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.stats > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.stats dt {
  color: var(--text-faint);
}

.stats dd {
  margin: 0;
  color: var(--text);
}

.row {
  justify-content: space-between;
  color: var(--text-faint);
  font-size: 12px;
}

.row select {
  padding: 3px 6px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-strong);
  background: var(--stage);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
}

.wide {
  width: 100%;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}

.failed {
  margin: 0;
  font-size: 12px;
  color: var(--danger-text);
}
</style>
