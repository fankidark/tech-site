<script setup>
import { computed, ref } from 'vue'

// ============================================================================
// MemoryMap —— 内存/地址空间布局图（unity-memory / hot-update 系列共用）
// ----------------------------------------------------------------------------
// 用途：把一段连续空间（堆、页、文件、allocation header 前后区）画成一条
//       "地址从左到右递增"的横条，每个块标明名字、大小、状态。
//       分配器文章里"元数据在块前后各占多少字节""释放后块怎么合并"这类问题，
//       用文字讲要三屏，用这张图一眼就清楚。
//
// 用法：
//   <MemoryMap
//     :blocks="[
//       { label: 'prev_size', size: 8,  kind: 'meta',  note: '前块大小' },
//       { label: 'size',      size: 8,  kind: 'meta' },
//       { label: 'payload',   size: 64, kind: 'used',  note: '给用户的 64B' },
//       { label: 'free',      size: 120, kind: 'free' },
//     ]"
//     :highlight="[2]"          <!-- 高亮下标 -->
//     base-label="0x7F2A1000"   <!-- 起始地址标注（可选） -->
//     title="一个已分配块的户口本" />
//
// kind 取值：'>meta'（元数据/头部）· 'used'（已分配）· 'free'（空闲）·
//            'gap'（碎片/间隙）· 'pad'（填充/对齐）· 'waste'（内部碎片）
// 未识别的一律按 used 渲染。
// ============================================================================

const props = defineProps({
  blocks: { type: Array, required: true },
  title: { type: String, default: '' },
  // 高亮块下标（点题用）
  highlight: { type: Array, default: () => [] },
  // 起始地址标注，纯展示
  baseLabel: { type: String, default: '' },
  // 每字节像素；块很多/很大时用 --px 参数调小
  pxPerByte: { type: Number, default: 6 },
  // 最小块宽（px），保证小块的标签还能看见
  minBlockPx: { type: Number, default: 44 },
  // 是否画地址刻度
  showTicks: { type: Boolean, default: true },
})

const hover = ref(-1)

const totalBytes = computed(() =>
  props.blocks.reduce((s, b) => s + (b.size || 0), 0)
)

const KIND = {
  meta: { bg: '#868E96', fg: '#fff', name: '元数据' },
  used: { bg: '#4C6EF5', fg: '#fff', name: '已分配' },
  free: { bg: '#DEE2E6', fg: '#212529', name: '空闲' },
  gap: { bg: '#FFE066', fg: '#212529', name: '间隙' },
  pad: { bg: '#CED4DA', fg: '#212529', name: '填充' },
  waste: { bg: '#FFA8A8', fg: '#212529', name: '内部碎片' },
}

function kindStyle(b) {
  return KIND[b.kind] || KIND.used
}

// 宽度：真实字节数 × 每字节像素，但保证不小于 minBlockPx
const layout = computed(() => {
  let offset = 0
  return props.blocks.map((b, i) => {
    const size = b.size || 0
    const w = Math.max(props.minBlockPx, size * props.pxPerByte)
    const item = { ...b, i, offset, width: w, size }
    offset += size
    return item
  })
})

const canvasWidth = computed(() =>
  layout.value.reduce((s, b) => s + b.width, 0)
)

// 地址刻度：均匀取 6 个点
const ticks = computed(() => {
  if (!props.showTicks || !totalBytes.value) return []
  const n = 6
  const out = []
  for (let i = 0; i <= n; i++) {
    const bytes = Math.round((totalBytes.value * i) / n)
    const px = (canvasWidth.value * i) / n
    out.push({ px, bytes })
  }
  return out
})

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(n >= 10240 ? 0 : 1) + ' KB'
  return n + ' B'
}

const isHi = (i) => props.highlight.includes(i)
</script>

<template>
  <figure class="mm-root">
    <figcaption v-if="title" class="mm-title">{{ title }}</figcaption>

    <div class="mm-scroll">
      <div class="mm-canvas" :style="{ width: canvasWidth + 'px' }">
        <div class="mm-bar">
          <div
            v-for="b in layout"
            :key="b.i"
            class="mm-block"
            :class="{ hi: isHi(b.i), dim: hover >= 0 && hover !== b.i }"
            :style="{
              width: b.width + 'px',
              background: kindStyle(b).bg,
              color: kindStyle(b).fg,
            }"
            :title="`${b.label} · ${fmtBytes(b.size)}${b.note ? ' · ' + b.note : ''}`"
            @mouseenter="hover = b.i"
            @mouseleave="hover = -1"
          >
            <span class="mm-label">{{ b.label }}</span>
            <span class="mm-size">{{ fmtBytes(b.size) }}</span>
          </div>
        </div>

        <div v-if="showTicks" class="mm-ticks">
          <span
            v-for="(t, i) in ticks"
            :key="i"
            class="mm-tick"
            :style="{ left: t.px + 'px' }"
          >{{ fmtBytes(t.bytes) }}</span>
        </div>
      </div>
    </div>

    <div class="mm-foot">
      <span v-if="baseLabel" class="mm-base">起始地址 {{ baseLabel }}</span>
      <span class="mm-total">合计 {{ fmtBytes(totalBytes) }}</span>
      <span class="mm-legend">
        <span v-for="(v, k) in KIND" :key="k" class="mm-legend-item">
          <i class="mm-swatch" :style="{ background: v.bg }" />{{ v.name }}
        </span>
      </span>
    </div>

    <!-- 悬停/高亮块的详细说明 -->
    <ul v-if="layout.some((b) => b.note)" class="mm-notes">
      <li
        v-for="b in layout"
        v-show="b.note"
        :key="b.i"
        :class="{ hi: isHi(b.i) }"
      >
        <b>{{ b.label }}</b>（{{ fmtBytes(b.size) }}）：{{ b.note }}
      </li>
    </ul>
  </figure>
</template>

<style scoped>
.mm-root {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.mm-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}

.mm-scroll { overflow-x: auto; padding-bottom: 4px; }
.mm-canvas { min-width: 100%; }

.mm-bar {
  display: flex;
  height: 52px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}
.mm-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  border-right: 1px solid rgba(255, 255, 255, 0.55);
  transition: filter 0.15s, opacity 0.15s;
  cursor: default;
}
.mm-block:last-child { border-right: 0; }
.mm-block.dim { opacity: 0.45; }
.mm-block.hi {
  filter: brightness(1.12);
  box-shadow: inset 0 0 0 3px #F59F00;
  z-index: 1;
}
.mm-label {
  font-weight: 600;
  padding: 0 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.mm-size { opacity: 0.85; font-size: 10px; white-space: nowrap; }

.mm-ticks { position: relative; height: 16px; }
.mm-tick {
  position: absolute;
  font-size: 9.5px;
  color: var(--vp-c-text-3);
  transform: translateX(-50%);
  white-space: nowrap;
}

.mm-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.mm-legend { display: flex; gap: 10px; flex-wrap: wrap; margin-left: auto; }
.mm-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.mm-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
  border: 1px solid var(--vp-c-divider);
}

.mm-notes {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}
.mm-notes li.hi { color: var(--vp-c-text-1); }
.mm-notes b { color: var(--vp-c-text-1); }
</style>
