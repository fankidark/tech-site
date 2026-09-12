<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// AstcBlockAnatomy —— ASTC 真实块的 128bit 逐字段解剖（astc-encode-100x100.md 专用）
// ----------------------------------------------------------------------------
// 三块数据全部是 astcenc 5.7.0 `-cl -fast` 压 100×100 测试图的**真实输出**，
// 不是编的。字段值由下面的 decodeMode() / iseBits() 现场算出来，与官方
// decode_block_mode_2d（astcenc_block_sizes.cpp:36）和
// get_ise_sequence_bitcount（astcenc_integer_sequence.cpp:419）的算法一致，
// 免得文章里的数字和代码推理对不上。
//
// 位序约定：hex 串**从右往左**读，最右边的字符是 bit 0（LSB）。
//   例：block_mode = read_bits(11, 0)，对应 astcenc_symbolic_physical.cpp:301。
// ============================================================================

const hex2bytes = (h) => h.match(/../g).map((s) => parseInt(s, 16))

// 按 ASTC 位序读字段。
// 关键：bytes 数组是按 hex 串从左到右排的（大端展示序），而 ASTC 的 bit 0 是
// **最后一个字节的最低位**。所以 bit b 落在 bytes[len-1-floor(b/8)] 的第 (b%8) 位。
function readBits(bytes, bitcount, bitoffset) {
  let v = 0
  for (let i = 0; i < bitcount; i++) {
    const b = bitoffset + i
    const byte = bytes[bytes.length - 1 - Math.floor(b / 8)] ?? 0
    v |= ((byte >> (b % 8)) & 1) << i
  }
  return v
}

// astcenc_integer_sequence.cpp:394 的 ise_sizes 表（scale, divisor）
const ISE_SIZES = [
  [1, 0], [8, 2], [2, 0], [7, 1], [13, 2], [3, 0], [10, 1], [18, 2],
  [4, 0], [13, 1], [23, 2], [5, 0], [16, 1], [28, 2], [6, 0], [23, 1],
  [8, 2], [13, 0], [5, 1], [23, 1], [8, 0],
]
// astcenc_integer_sequence.cpp:419
function iseBits(count, quant) {
  const [scale, divisor] = ISE_SIZES[quant] ?? [0, 0]
  const d = (divisor << 1) + 1
  return Math.floor((scale * count + d - 1) / d)
}
// 12 档 weight 量化对应的 QUANT_* 名（integer_sequence.cpp:353-364）
const QUANT_NAME = ['QUANT_2', 'QUANT_3', 'QUANT_4', 'QUANT_5', 'QUANT_6', 'QUANT_8',
                    'QUANT_10', 'QUANT_12', 'QUANT_16', 'QUANT_20', 'QUANT_24', 'QUANT_32']
const QUANT_LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32]

// 复刻 decode_block_mode_2d（astcenc_block_sizes.cpp:36-137）
function decodeMode(blockMode) {
  let baseQuant = (blockMode >> 4) & 1
  const H = (blockMode >> 9) & 1
  let D = (blockMode >> 10) & 1
  const A = (blockMode >> 5) & 0x3
  let wx = 0, wy = 0
  if ((blockMode & 3) !== 0) {
    baseQuant |= (blockMode & 3) << 1
    let B = (blockMode >> 7) & 3
    switch ((blockMode >> 2) & 3) {
      case 0: wx = B + 4; wy = A + 2; break
      case 1: wx = B + 8; wy = A + 2; break
      case 2: wx = A + 2; wy = B + 8; break
      case 3:
        B &= 1
        if (blockMode & 0x100) { wx = B + 2; wy = A + 2 } else { wx = A + 2; wy = B + 6 }
        break
    }
  } else {
    baseQuant |= ((blockMode >> 2) & 3) << 1
    let B = (blockMode >> 9) & 3
    switch ((blockMode >> 7) & 3) {
      case 0: wx = 12; wy = A + 2; break
      case 1: wx = A + 2; wy = 12; break
      case 2: wx = A + 6; wy = B + 6; D = 0; break
      case 3:
        switch ((blockMode >> 5) & 3) {
          case 0: wx = 6; wy = 10; break
          case 1: wx = 10; wy = 6; break
          default: return null
        }
        break
    }
  }
  const weightCount = wx * wy * (D + 1)
  const quantMode = (baseQuant - 2) + 6 * H
  return { wx, wy, weightCount, quantMode, quantLevel: QUANT_LEVELS[quantMode], isDual: D !== 0, H, D }
}

const CEM_NAMES = {
  0: 'LDR RGB direct（4bit/通道）', 4: 'LDR RGB direct（8bit/通道）',
  8: 'LDR RGB direct（8bit/通道）',
  9: 'LDR RGB base+offset', 7: 'HDR RGB base+scale', 11: 'HDR RGB direct',
}

const BLOCKS = [
  {
    key: '4x4', label: 'ASTC 4×4', fp: '4×4 → 16 像素', hex: '8de7797e59964000fb18000102e50241',
    where: 'block(6,6) · Q1 红→蓝渐变中段', px: 16,
  },
  {
    key: '5x5', label: 'ASTC 5×5', fp: '5×5 → 25 像素', hex: 'ee9ce9ca9ca1ca0ca00b920014eb20f3',
    where: 'block(0,0) · Q1 左上角', px: 25,
  },
  {
    key: '6x6', label: 'ASTC 6×6', fp: '6×6 → 36 像素', hex: '9f8ff8778bb89a541281c9000ab7206f',
    where: 'block(0,0) · Q1 左上角', px: 36,
  },
]

const picked = ref('4x4')

const view = computed(() => {
  const src = BLOCKS.find((b) => b.key === picked.value)
  const bytes = hex2bytes(src.hex)
  const blockMode = readBits(bytes, 11, 0)
  const partitionCount = readBits(bytes, 2, 11) + 1
  const cem = readBits(bytes, 4, 13)
  const mode = decodeMode(blockMode)
  const wbits = iseBits(mode.weightCount * (mode.isDual ? 2 : 1), mode.quantMode)
  // 端点数据从 bit 17 起、往高位排；weight 数据从 bit 127 往下占。
  // 两者的分界线由 weight 区的 ISE 长度决定：端点区 = 总 128 − 块头 17 − weight 区。
  const endpointBits = 128 - 17 - wbits    // 端点区 bit 数
  const endpointHi = 17 + endpointBits - 1 // 端点区最高位
  const weightLo = 128 - wbits             // weight 区最低位
  const isVoid = (blockMode & 0x1FF) === 0x1FC
  const fields = [
    { name: 'block_mode', from: 0, to: 10, desc: `= ${blockMode}，定 weight grid 与量化档`, value: blockMode },
    { name: 'part', from: 11, to: 12, desc: `分区数−1 → ${partitionCount} 个分区`, value: partitionCount - 1 },
    { name: 'CEM', from: 13, to: 16, desc: `= ${cem} → ${CEM_NAMES[cem] ?? '（见规范表）'}`, value: cem },
    { name: '端点数据', from: 17, to: endpointHi, desc: `${endpointBits} bit 预算，从低位往高位填`, value: undefined },
    { name: 'weight 数据', from: weightLo, to: 127, desc: `${wbits} bit，从 bit 127 往下占`, value: undefined },
  ]
  return { src, bytes, blockMode, partitionCount, cem, mode, wbits, endpointBits, isVoid, fields }
})

const toggle = (k) => { picked.value = k }
</script>

<template>
  <div class="ab-root">
    <div class="ab-tabs">
      <button v-for="b in BLOCKS" :key="b.key" class="ab-tab" :class="{ on: picked === b.key }" @click="toggle(b.key)">
        {{ b.label }}<span class="ab-tabfp">{{ b.fp }}</span>
      </button>
    </div>

    <p class="ab-where">解剖对象：<code>{{ view.src.where }}</code>，astcenc 5.7.0 <code>-cl -fast</code> 的真实 128bit 输出：</p>
    <pre class="ab-hex">{{ view.src.hex }}</pre>

    <BitField :bytes="view.bytes" :fields="view.fields" :width="128"
              :title="`${view.src.label} 位域（低 bit 在左，与 read_bits(bitcount, bitoffset) 的读法一致）`" />

    <table class="ab-tbl">
      <thead><tr><th>从 block_mode 反推出的配置</th><th>值</th><th>依据</th></tr></thead>
      <tbody>
        <tr><td>weight grid 尺寸</td><td><b>{{ view.mode.wx }} × {{ view.mode.wy }}</b></td><td>decode_block_mode_2d 的 switch</td></tr>
        <tr><td>weight 个数</td><td>{{ view.mode.weightCount }}<span v-if="view.mode.isDual"> ×2（dual-plane）</span></td><td>weights_x × weights_y × (D+1)</td></tr>
        <tr><td>weight 量化档</td><td><b>{{ view.mode.quantLevel }} 档</b>（{{ QUANT_NAME[view.mode.quantMode] }}）</td><td>quant_mode = (base − 2) + 6H</td></tr>
        <tr><td>weight 区实际 bit 数</td><td><b>{{ view.wbits }} bit</b></td><td>get_ise_sequence_bitcount（ISE 打包）</td></tr>
        <tr><td>端点数据预算</td><td><b>{{ view.endpointBits }} bit</b>（bit 17–{{ 17 + view.endpointBits - 1 }}）</td><td>128 − weight 区 − 17 位块头</td></tr>
        <tr><td>分区数 / CEM</td><td>{{ view.partitionCount }} / {{ view.cem }}（{{ CEM_NAMES[view.cem] ?? '—' }}）</td><td>read_bits(2, 11) / read_bits(4, 13)</td></tr>
        <tr class="ab-sum">
          <td>位预算自洽</td>
          <td colspan="2">17（块头：11 + 2 + 4）+ {{ view.wbits }}（weight）+ {{ view.endpointBits }}（端点）= <b>128</b> ✔</td>
        </tr>
      </tbody>
    </table>

    <p class="ab-note">
      当前这块：footprint 是 <b>{{ view.src.fp.split(' → ')[0] }}</b>（{{ view.src.px }} 像素），
      weight grid 是 <b>{{ view.mode.wx }} × {{ view.mode.wy }}</b>（{{ view.mode.weightCount }} 个 weight）。
      <template v-if="view.mode.weightCount < view.src.px">
        注意 weight 个数 <b>少于</b>像素数 —— 多出来的像素靠双线性上采样补。这就是 ASTC 比 ETC 灵活的地方：
        <b>权重密度和像素密度是两件事</b>。
      </template>
      <template v-else>
        weight 个数与像素数相等，解码时每个像素直接取自己的 weight，不做上采样。
      </template>
    </p>
  </div>
</template>

<style scoped>
.ab-root { margin: 18px 0; padding: 12px 14px; border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-soft); }
.ab-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ab-tab {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); color: var(--vp-c-text-1);
  border-radius: 8px; padding: 5px 12px; font-size: 13px; font-weight: 600; cursor: pointer; line-height: 1.3;
}
.ab-tab:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.ab-tab.on { background: var(--vp-c-brand-1); border-color: var(--vp-c-brand-1); color: #fff; }
.ab-tabfp { font-size: 10.5px; font-weight: 400; opacity: 0.8; }
.ab-where { margin: 0 0 6px; font-size: 12.5px; color: var(--vp-c-text-2); }
.ab-hex {
  margin: 0 0 4px; padding: 8px 10px; background: var(--vp-code-block-bg); border-radius: 6px;
  font-family: var(--vp-font-family-mono); font-size: 13px; letter-spacing: 1px;
  color: var(--vp-c-text-1); word-break: break-all; white-space: pre-wrap;
}
.ab-tbl { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12.5px; display: table; }
.ab-tbl th, .ab-tbl td { border: 1px solid var(--vp-c-divider); padding: 4px 8px; text-align: left; vertical-align: top; }
.ab-tbl th { background: var(--vp-c-bg); font-weight: 600; white-space: nowrap; }
.ab-tbl code { font-size: 11.5px; }
.ab-sum td { background: rgba(18, 184, 134, 0.10); }
.ab-note { margin: 10px 0 0; font-size: 12.5px; color: var(--vp-c-text-2); line-height: 1.75; }
</style>
