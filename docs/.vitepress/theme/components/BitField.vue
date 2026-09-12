<script setup>
import { computed } from 'vue'

// ============================================================================
// BitField —— 位域解剖图（hot-update / texture / atomic-stack 系列共用）
// ----------------------------------------------------------------------------
// 用途：把一块 32/64/128 位的数据（或任意字节数组）按"字段"切开，
//       每个字段一个颜色、标注名字与含义，鼠标悬停高亮并显示十六进制值。
// 这是"0 基础读者看懂位流"的核心图元：文字说"bit 13..16 是 CEM"没人懂，
// 画成一根被切段的条，谁都能对上号。
//
// 用法：
//   <BitField
//     :bytes="[0x42, 0x8A, 0x00, 0x00]"     <!-- 原始字节 -->
//     :fields="[
//       { name: 'block_mode', from: 0,  to: 10, desc: '块模式' },
//       { name: 'part_cnt',   from: 11, to: 12, desc: '分区数−1', value: 1 },
//     ]"
//     :width="128"                          <!-- 总位宽；不给则按 bytes 长度 ×8 -->
//     title="ASTC 128bit 块头" />
//
// from/to 都是闭区间，from=0 表示最低位（LSB 在最左，符合"从低到高"的读法）；
// 若你想按"高位在前"显示（大端视觉），传 reverse。
// ============================================================================

const props = defineProps({
  bytes: { type: Array, default: () => [] },
  fields: { type: Array, required: true },
  // 总位宽；不给则由 bytes 推算
  width: { type: Number, default: 0 },
  title: { type: String, default: '' },
  // true = 高位画在左边（更像位流在纸上的样子）
  reverse: { type: Boolean, default: false },
  // 每个字段一层时的行高，单位 px
  rowHeight: { type: Number, default: 34 },
})

const totalBits = computed(() => props.width || props.bytes.length * 8 || 0)

// 把 [from,to] 映射成百分比区间；reverse 时左右翻过来
function rangeStyle(f) {
  const t = totalBits.value || 1
  const a = Math.max(0, Math.min(t, f.from))
  const b = Math.max(0, Math.min(t, (f.to ?? f.from) + 1))
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const leftPct = props.reverse ? ((t - hi) / t) * 100 : (lo / t) * 100
  const widthPct = ((hi - lo) / t) * 100
  return { left: leftPct + '%', width: widthPct + '%' }
}

// 从字节数组里取出某个位区间的整数值（用于悬停显示真实数值）
function bitsValue(f) {
  if (f.value !== undefined) return f.value
  if (!props.bytes.length) return null
  let v = 0n
  const hi = Math.max(f.from, f.to ?? f.from)
  for (let bit = hi; bit >= Math.min(f.from, f.to ?? f.from); bit--) {
    const byteIdx = Math.floor(bit / 8)
    const bitInByte = bit % 8 // 0 = LSB
    const byte = props.bytes[byteIdx]
    if (byte === undefined) continue
    v = (v << 1n) | BigInt((byte >> bitInByte) & 1)
  }
  return v
}

function hex(v) {
  if (v === null || v === undefined) return ''
  return '0x' + BigInt(v).toString(16).toUpperCase()
}

// 整体十六进制串（按字节序显示，便于和 hexdump 对照）
const hexDump = computed(() =>
  props.bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ')
)

// 位标尺刻度：每 8 位一个数字，避免太密
const ruler = computed(() => {
  const t = totalBits.value
  if (!t) return []
  const out = []
  const stepBits = t <= 32 ? 4 : 8
  for (let bit = 0; bit < t; bit += stepBits) {
    out.push({ bit, left: (bit / t) * 100 })
  }
  return out
})

const palette = [
  '#4C6EF5', '#12B886', '#F59F00', '#E8590C', '#AE3EC9',
  '#1098AD', '#D6336C', '#37B24D', '#F76707', '#7048E8',
]

function colorOf(i) {
  return palette[i % palette.length]
}
</script>

<template>
  <figure class="bf-root">
    <figcaption v-if="title" class="bf-title">{{ title }}</figcaption>

    <div class="bf-bar-wrap">
      <div class="bf-bar" :style="{ height: rowHeight + 'px' }">
        <div
          v-for="(f, i) in fields"
          :key="i"
          class="bf-field"
          :style="{ ...rangeStyle(f), background: colorOf(i) }"
          :data-tip="`${f.name}  bit${f.to != null && f.to !== f.from ? `[${f.from}..${f.to}]` : `[${f.from}]`}  = ${hex(bitsValue(f))}${f.desc ? '  ' + f.desc : ''}`"
        >
          <span class="bf-field-name">{{ f.name }}</span>
          <span class="bf-field-bits">{{ f.to != null && f.to !== f.from ? `${f.from}–${f.to}` : f.from }}</span>
        </div>
      </div>

      <!-- 位标尺 -->
      <div class="bf-ruler">
        <span
          v-for="r in ruler"
          :key="r.bit"
          class="bf-ruler-tick"
          :style="{ left: r.left + '%' }"
        >{{ r.bit }}</span>
      </div>
    </div>

    <!-- 字段清单：图的补充说明，也是"图上放不下的字"的出口 -->
    <table class="bf-table">
      <thead>
        <tr><th>字段</th><th>位区间</th><th>值</th><th>含义</th></tr>
      </thead>
      <tbody>
        <tr v-for="(f, i) in fields" :key="i">
          <td>
            <i class="bf-dot" :style="{ background: colorOf(i) }" />{{ f.name }}
          </td>
          <td class="bf-mono">
            {{ f.to != null && f.to !== f.from ? `bit ${f.from}–${f.to}（${f.to - f.from + 1} 位）` : `bit ${f.from}（1 位）` }}
          </td>
          <td class="bf-mono">{{ hex(bitsValue(f)) }}</td>
          <td>{{ f.desc || '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="hexDump" class="bf-dump">
      <span class="bf-dump-label">原始字节（低地址在左）</span>
      <code>{{ hexDump }}</code>
    </div>
  </figure>
</template>

<style scoped>
.bf-root {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.bf-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}

.bf-bar-wrap { position: relative; padding-bottom: 20px; }
.bf-bar {
  position: relative;
  width: 100%;
  border-radius: 6px;
  overflow: hidden;
  background: var(--vp-c-divider);
}
.bf-field {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #fff;
  font-size: 11px;
  line-height: 1.15;
  text-align: center;
  border-right: 1px solid rgba(255, 255, 255, 0.5);
  transition: filter 0.15s;
}
.bf-field:hover { filter: brightness(1.15); }
.bf-field-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  padding: 0 2px;
}
.bf-field-bits { opacity: 0.85; font-size: 10px; }

.bf-ruler {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 18px;
}
.bf-ruler-tick {
  position: absolute;
  font-size: 9.5px;
  color: var(--vp-c-text-3);
  transform: translateX(-50%);
  white-space: nowrap;
}

.bf-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 12.5px;
  display: table;
}
.bf-table th,
.bf-table td {
  border: 1px solid var(--vp-c-divider);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.bf-table th {
  background: var(--vp-c-bg);
  font-weight: 600;
  white-space: nowrap;
}
.bf-mono { font-family: var(--vp-font-family-mono); white-space: nowrap; }
.bf-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 5px;
}

.bf-dump {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bf-dump-label { color: var(--vp-c-text-3); }
.bf-dump code {
  font-family: var(--vp-font-family-mono);
  background: var(--vp-code-block-bg);
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 1px;
  color: var(--vp-c-text-1);
}
</style>
