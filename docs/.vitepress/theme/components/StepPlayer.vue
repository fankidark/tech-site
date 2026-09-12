<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

// ============================================================================
// StepPlayer —— 全站通用的「单步 + 源码行号 + 动态图解」播放底座
// ----------------------------------------------------------------------------
// 设计动机：文章要讲"某段 C 代码一次分配/一次编码到底做了什么"，
// 静态大段文字读者跟不下去。统一做法是——把过程切成 N 张"状态快照"，
// 一张一张放给读者看，每一步同时给出：源码位置 + 白话解释 + 领域图解。
//
// 架构约束（踩过的坑，别改）：
//   ① 快照必须由父组件**一次性算好**（纯函数、确定性），播放器只做时间线回放。
//      在 watch/回调里推进状态机 = 递归死循环 → 页面 OOM 崩溃。
//   ② 本组件不持有领域逻辑，只负责"第几步"与播放节奏；领域图由父组件用
//      #viz 作用域插槽渲染（slot props: { step, index }）。
//   ③ 所有副作用（键盘、定时器）都必须在 onMounted 内注册，
//      SSR/静态构建阶段没有 window，否则 build 直接挂。
//
// 用法：
//   <StepPlayer :steps="steps" title="…" source-root="Runtime/Allocator/">
//     <template #viz="{ step }"> … 你的领域图 … </template>
//   </StepPlayer>
//   steps[i] = {
//     title:  '本步在做什么（8 字内）',
//     text:   '白话解释，2~4 句',
//     src:    { file: 'TLSAllocator.cpp', line: 120, excerpt: '一行源码' },
//     tag:    '可选：标签，如 "快速路径"',
//     viz:    可选：父组件自己的领域数据
//   }
// ============================================================================

const props = defineProps({
  steps: { type: Array, required: true },
  title: { type: String, default: '' },
  // 源码根路径前缀，展示用（如 'Runtime/Allocator/'）
  sourceRoot: { type: String, default: '' },
  // 起始速度（毫秒/步）
  interval: { type: Number, default: 1400 },
  // 是否默认展开源码摘录
  showCode: { type: Boolean, default: true },
})

const idx = ref(0)
const playing = ref(false)
const speed = ref(props.interval)
let timer = null

// 把"第几步"同步给父组件（父组件据此渲染领域图；也可直接用 #viz 插槽的 index）
const emit = defineEmits(['update:index'])
watch(idx, (v) => emit('update:index', v))

const total = computed(() => props.steps.length)
const step = computed(() => props.steps[idx.value] || {})
const progress = computed(() =>
  total.value <= 1 ? 0 : (idx.value / (total.value - 1)) * 100
)

function clearTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function tick() {
  if (idx.value >= total.value - 1) {
    pause()
    return
  }
  idx.value++
}

function play() {
  if (playing.value) return
  if (idx.value >= total.value - 1) idx.value = 0
  playing.value = true
  clearTimer()
  timer = setInterval(tick, speed.value)
}

function pause() {
  playing.value = false
  clearTimer()
}

function toggle() {
  playing.value ? pause() : play()
}

function go(i) {
  pause()
  idx.value = Math.max(0, Math.min(total.value - 1, i))
}

const next = () => go(idx.value + 1)
const prev = () => go(idx.value - 1)
const first = () => go(0)
const last = () => go(total.value - 1)

// 变速：先停表再换节奏，否则 interval 不会生效
watch(speed, () => {
  if (playing.value) {
    clearTimer()
    timer = setInterval(tick, speed.value)
  }
})

// 父组件换了一批 steps（例如切换示例数据）就回到第一步
watch(
  () => props.steps,
  () => {
    pause()
    idx.value = 0
  }
)

function onKey(e) {
  // 只有鼠标在播放器内、或焦点在播放器上时才响应，避免影响页面其它快捷键
  if (!rootEl.value || !rootEl.value.contains(document.activeElement)) {
    if (!rootEl.value || !rootEl.value.matches(':hover')) return
  }
  if (e.key === 'ArrowRight') { e.preventDefault(); next() }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
  else if (e.key === ' ') { e.preventDefault(); toggle() }
}

const rootEl = ref(null)

onMounted(() => {
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  clearTimer()
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="sp-root" tabindex="0">
    <div v-if="title" class="sp-title">
      <span class="sp-title-icon">🎬</span>{{ title }}
      <span class="sp-hint">空格播放/暂停 · ← → 单步</span>
    </div>

    <div class="sp-stage">
      <!-- 左：领域图解（父组件提供） -->
      <div class="sp-viz">
        <slot name="viz" :step="step" :index="idx" />
      </div>

      <!-- 右：本步解释 + 源码 -->
      <aside class="sp-side">
        <div class="sp-stepno">
          第 {{ idx + 1 }} / {{ total }} 步
          <span v-if="step.tag" class="sp-tag">{{ step.tag }}</span>
        </div>
        <h4 class="sp-steptitle">{{ step.title }}</h4>
        <p class="sp-steptext">{{ step.text }}</p>

        <div v-if="step.src && showCode" class="sp-src">
          <div class="sp-src-head">
            <span class="sp-src-file">{{ sourceRoot }}{{ step.src.file }}</span>
            <span v-if="step.src.line" class="sp-src-line">:{{ step.src.line }}</span>
          </div>
          <pre v-if="step.src.excerpt" class="sp-src-code"><code>{{ step.src.excerpt }}</code></pre>
          <p v-if="step.src.note" class="sp-src-note">{{ step.src.note }}</p>
        </div>
      </aside>
    </div>

    <!-- 控制条 -->
    <div class="sp-ctrl">
      <button class="sp-btn" title="回到第一步" @click="first">⏮</button>
      <button class="sp-btn" title="上一步（←）" @click="prev">◀</button>
      <button class="sp-btn sp-btn-main" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="toggle">
        {{ playing ? '⏸ 暂停' : '▶ 播放' }}
      </button>
      <button class="sp-btn" title="下一步（→）" @click="next">▶</button>
      <button class="sp-btn" title="跳到最后一步" @click="last">⏭</button>

      <label class="sp-speed">
        速度
        <select v-model.number="speed">
          <option :value="2600">0.5×</option>
          <option :value="1400">1×</option>
          <option :value="800">2×</option>
          <option :value="400">4×</option>
        </select>
      </label>
    </div>

    <!-- 进度条：点击直接跳步 -->
    <div class="sp-track" @click="go(Math.round((($event.offsetX / $event.currentTarget.clientWidth) * (total - 1))))">
      <div class="sp-track-fill" :style="{ width: progress + '%' }" />
      <div
        v-for="(s, i) in steps"
        :key="i"
        class="sp-tick"
        :class="{ active: i === idx, done: i < idx }"
        :style="{ left: (total <= 1 ? 0 : (i / (total - 1)) * 100) + '%' }"
        :title="`第 ${i + 1} 步：${s.title || ''}`"
      />
    </div>
  </div>
</template>

<style scoped>
.sp-root {
  margin: 20px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  padding: 14px 16px 16px;
  outline: none;
}
.sp-root:focus-visible {
  border-color: var(--vp-c-brand-1);
}

.sp-title {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sp-title-icon { font-size: 16px; }
.sp-hint {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--vp-c-text-3);
}

.sp-stage {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 860px) {
  .sp-stage { grid-template-columns: 1fr; }
}

.sp-viz {
  min-width: 0;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
}

.sp-side { min-width: 0; }
.sp-stepno {
  font-size: 12px;
  color: var(--vp-c-text-3);
  display: flex;
  align-items: center;
  gap: 8px;
}
.sp-tag {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
}
.sp-steptitle {
  margin: 4px 0 6px;
  font-size: 15px;
  border: 0;
  padding: 0;
}
.sp-steptext {
  margin: 0 0 10px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}

.sp-src {
  border-left: 3px solid var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  border-radius: 0 6px 6px 0;
  padding: 6px 8px 8px;
}
.sp-src-head {
  font-size: 11.5px;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
  word-break: break-all;
}
.sp-src-line { color: var(--vp-c-brand-1); font-weight: 600; }
.sp-src-code {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: var(--vp-code-block-bg);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
}
.sp-src-code code {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  background: none;
  padding: 0;
}
.sp-src-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.sp-ctrl {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.sp-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  line-height: 1.5;
}
.sp-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.sp-btn-main {
  min-width: 88px;
  font-weight: 600;
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
}
.sp-btn-main:hover { color: #fff; opacity: 0.9; }

.sp-speed {
  margin-left: auto;
  font-size: 12px;
  color: var(--vp-c-text-3);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sp-speed select {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  padding: 2px 4px;
  font-size: 12px;
}

.sp-track {
  position: relative;
  height: 20px;
  margin-top: 8px;
  cursor: pointer;
}
.sp-track::before {
  content: '';
  position: absolute;
  top: 9px;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--vp-c-divider);
  border-radius: 2px;
}
.sp-track-fill {
  position: absolute;
  top: 9px;
  left: 0;
  height: 3px;
  background: var(--vp-c-brand-1);
  border-radius: 2px;
  transition: width 0.15s linear;
}
.sp-tick {
  position: absolute;
  top: 5px;
  width: 2px;
  height: 11px;
  margin-left: -1px;
  background: var(--vp-c-divider);
  border-radius: 1px;
}
.sp-tick.done { background: var(--vp-c-brand-1); }
.sp-tick.active {
  top: 2px;
  height: 17px;
  width: 3px;
  background: var(--vp-c-brand-1);
  box-shadow: 0 0 0 2px var(--vp-c-brand-soft);
}
</style>
