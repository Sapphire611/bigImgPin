<script setup lang="ts">
import { theme, toggleTheme } from '../theme'
import type { ToolMode } from '../types'
import UpdatePrompt from './UpdatePrompt.vue'

defineProps<{
  mode: ToolMode
  gridEnabled: boolean
  hasImage: boolean
  /** 图像就绪前,缩放类按钮都要禁用 */
  ready: boolean
  canUndo: boolean
  canRedo: boolean
}>()

const emit = defineEmits<{
  open: []
  'update:mode': [ToolMode]
  'update:gridEnabled': [boolean]
  zoomToFit: []
  zoomToOne: []
  undo: []
  redo: []
  settings: []
}>()
</script>

<template>
  <div class="toolbar">
    <button class="solid" :disabled="!ready" @click="emit('open')">打开图片</button>

    <span class="divider" />

    <!--
      模式组的样式语言:凹槽里放一个实心药丸 = 「这几个里当前是哪个」。
      和旁边的普通按钮长得不一样,是为了让「状态」和「动作」一眼分得开。
      实心取 var(--solid),深浅主题下明度相反 —— 见 styles.css 文件头。
    -->
    <div class="track" role="group" aria-label="工具模式">
      <button
        :class="{ solid: mode === 'pan' }"
        :disabled="!hasImage"
        title="拖动模式:按住拖动平移画面,滚轮缩放"
        @click="emit('update:mode', 'pan')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.8v12.4M1.8 8h12.4M8 1.8 5.9 3.9M8 1.8l2.1 2.1M8 14.2l-2.1-2.1M8 14.2l2.1-2.1M1.8 8l2.1-2.1M1.8 8l2.1 2.1M14.2 8l-2.1-2.1M14.2 8l-2.1 2.1"
          />
        </svg>
        拖动
      </button>
      <button
        :class="{ solid: mode === 'draw' }"
        :disabled="!hasImage"
        title="鼠标模式:拖拽画框,点击可选中已有框"
        @click="emit('update:mode', 'draw')"
      >
        <!-- 图标和画布上的实际画法一致:框 + 两个角点 -->
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.6" y="3.6" width="10.8" height="8.8" rx="0.5" />
          <rect x="1.1" y="2.1" width="3" height="3" fill="currentColor" stroke="none" />
          <rect x="11.9" y="12.9" width="3" height="3" fill="currentColor" stroke="none" />
        </svg>
        画框
      </button>
    </div>

    <span class="divider" />

    <!-- 网格也是二值状态,所以用同一个凹槽语言,而不是普通按钮 -->
    <div class="track" role="group" aria-label="网格">
      <button
        :class="{ solid: gridEnabled }"
        :disabled="!hasImage"
        title="显示/隐藏网格"
        @click="emit('update:gridEnabled', !gridEnabled)"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="0.5" />
          <path d="M8 2v12M2 8h12" />
        </svg>
        网格
      </button>
    </div>

    <span class="divider" />

    <!--
      撤销/重做用普通按钮而不是凹槽:凹槽那套语言的含义是「这几个里当前是哪个」,
      而这两个是动作,没有「当前」可言。
    -->
    <button :disabled="!canUndo" title="撤销(Ctrl+Z)" @click="emit('undo')">撤销</button>
    <button :disabled="!canRedo" title="重做(Ctrl+Shift+Z)" @click="emit('redo')">重做</button>

    <button :disabled="!hasImage" title="缩放到适应窗口" @click="emit('zoomToFit')">适应窗口</button>
    <button
      :disabled="!hasImage"
      title="缩放到 100%(图像 1 像素 = 屏幕 1 像素)"
      @click="emit('zoomToOne')"
    >
      1:1
    </button>

    <!-- 图标画的是**点下去会得到什么**,不是当前状态:深色下显示太阳。
         配合 title 文案一起读,不会歧义。 -->
    <button
      class="theme"
      :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
      :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
      @click="toggleTheme()"
    >
      <svg v-if="theme === 'dark'" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.2" />
        <path
          d="M8 1v1.9M8 13.1V15M1 8h1.9M13.1 8H15M3.05 3.05l1.34 1.34M11.61 11.61l1.34 1.34M12.95 3.05l-1.34 1.34M4.39 11.61l-1.34 1.34"
        />
      </svg>
      <svg v-else viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.6 9.7A5.9 5.9 0 0 1 6.3 2.4a5.9 5.9 0 1 0 7.3 7.3Z" />
      </svg>
    </button>

    <UpdatePrompt />

    <!--
      齿轮放在最右边:它是一个入口,不是常用动作,不该跟工具抢位置。
      **不能复用 .theme 那个类** —— 它带 margin-left:auto,两个 auto 会把空隙平分,
      把 UpdatePrompt 甩到中间去(主题按钮那条注释里记的就是这个坑)。
    -->
    <button
      class="icon"
      title="设置:缓存与切片参数"
      aria-label="设置"
      @click="emit('settings')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" />
        <path
          d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.48 3.48l1.2 1.2M11.32 11.32l1.2 1.2M12.52 3.48l-1.2 1.2M4.68 11.32l-1.2 1.2"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

/* 凹槽。比 --panel 更暗/更浅一层,读起来是「嵌进去的」,和浮在上面的按钮区分开 */
.track {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--stage);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
}

.track button {
  padding: 3px 11px;
  background: transparent;
  border-color: transparent;
  border-radius: var(--r-sm);
  color: var(--text-dim);
}

.track button:hover:not(:disabled) {
  background: var(--raise);
  border-color: transparent;
  color: var(--text);
}

/* 这两条必须写在 .track button:hover 之后。
   全局的 button.solid 权重比 `.track button[data-v-x]` 低,压不住 —— 不重写的话,
   鼠标划过当前工具时它会突然变回普通按钮的底色。 */
.track button.solid,
.track button.solid:hover:not(:disabled) {
  background: var(--solid);
  border-color: var(--solid);
  color: var(--solid-text);
}

/* 推到最右边。UpdatePrompt 内部也想要这个位置,两处 margin-left:auto 会平分空隙,
   把主题开关甩到中间,所以那边已经去掉了 */
.theme {
  margin-left: auto;
  padding: 5px 8px;
}

/* 主题右边那些图标按钮。**不带 margin-left:auto** —— 位置已经由 .theme 推好了 */
.icon {
  padding: 5px 8px;
}

svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
  flex-shrink: 0;
}
</style>
