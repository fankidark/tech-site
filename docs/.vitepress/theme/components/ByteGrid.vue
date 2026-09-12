<script setup>
import { computed } from 'vue'

// ============================================================================
// ByteGrid —— 字节/小块矩阵图（texture 与 hot-update 系列共用）
// ----------------------------------------------------------------------------
// 用途：把"一个块内部的 16 个像素""被切成 4 个 4 字节小块的页"这类二维结构
//       画成方格阵，每格带颜色/数值/标签。纹理压缩讲"块内像素怎么被分成两个
//       子块"、内存讲"页表按 4B 分桶"都靠它。
//
// 用法：
//   <ByteGrid
//     :cols="4" :rows="4"
//     :cells="[ { color: '#ff0000', label: 'FF0000' }, … ]"   <!-- 行优先 -->
//     :sub-blocks="[ { from: 0, to: 7, name: '子块 A' }, { from: 8, to: 15, name: '子块 B' } ]"
//     cell-size="34" title="4×4 块被拆成两个子块" />
//
// sub-blocks 用「格子下标」划分（行优先序号），用来画 flip 方向 / 分区形状。
// ============================================================================

const props = defineProps({
  cells: { type: Array, required: true },
  cols: { type: Number, default: 4 },
  rows: { type: Number, default: 4 },
  title: { type: String, default: '' },
  cellSize: { type: Number, default: 34 },
  // 子块划分：{ from, to（含）, name, color }，按格子序号
  subBlocks: { type: Array, default: () => [] },
  // 是否显示每格文字（颜色值/字节值）
  showLabel: { type: Boolean, default: true },
  // 网格间距
  gap: { type: Number, default: 2 },
})

const subOf = computed(() => {
  const map = new Array(props.cells.length).fill(-1)
  props.subBlocks.forEach((sb, i) => {
    for (let k = sb.from; k <= sb.to; k++) if (k < map.length) map[k] = i
  })
  return map
})

const SUB_COLORS = ['#4C6EF5', '#E8590C', '#12B886', '#AE3EC9']

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${props.cols}, ${props.cellSize}px)`,
  gap: props.gap + 'px',
}))

function cellTitle(c, i) {
  const sb = subOf.value[i]
  const sbName = sb >= 0 ? ` · ${props.subBlocks[sb].name}` : ''
  return `#${i}${sbName}${c.label ? ' · ' + c.label : ''}`
}

function outline(i) {
  const sb = subOf.value[i]
  if (sb < 0) return {}
  return { boxShadow: `inset 0 0 0 2px ${SUB_COLORS[sb % SUB_COLORS.length]}` }
}
</script>

<template>
  <figure class="bg-root">
    <figcaption v-if="title" class="bg-title">{{ title }}</figcaption>

    <div class="bg-wrap">
      <div class="bg-grid" :style="gridStyle">
        <div
          v-for="(c, i) in cells"
          :key="i"
          class="bg-cell"
          :style="{ background: c.color || 'var(--vp-c-bg)', ...outline(i) }"
          :title="cellTitle(c, i)"
        >
          <span v-if="showLabel && c.label" class="bg-cell-label">{{ c.label }}</span>
          <span class="bg-cell-idx">{{ i }}</span>
        </div>
      </div>

      <div v-if="subBlocks.length" class="bg-subs">
        <div v-for="(sb, i) in subBlocks" :key="i" class="bg-sub">
          <i class="bg-sub-dot" :style="{ background: SUB_COLORS[i % SUB_COLORS.length] }" />
          <b>{{ sb.name }}</b>
          <span class="bg-sub-range">格子 {{ sb.from }}–{{ sb.to }}</span>
          <span v-if="sb.note" class="bg-sub-note">{{ sb.note }}</span>
        </div>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.bg-root {
  margin: 16px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.bg-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}

.bg-wrap {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.bg-grid { display: grid; }
.bg-cell {
  position: relative;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.bg-cell-label {
  font-size: 9.5px;
  font-family: var(--vp-font-family-mono);
  color: #fff;
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.8);
  padding: 0 1px;
  text-align: center;
  line-height: 1.1;
  word-break: break-all;
}
.bg-cell-idx {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 8px;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.9);
}

.bg-subs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  min-width: 180px;
}
.bg-sub { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.bg-sub-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
  flex: 0 0 auto;
}
.bg-sub-range { color: var(--vp-c-text-3); font-family: var(--vp-font-family-mono); font-size: 11px; }
.bg-sub-note { color: var(--vp-c-text-2); flex-basis: 100%; }
</style>
