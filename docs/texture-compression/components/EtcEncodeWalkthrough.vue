<script setup>
import { computed } from 'vue'
import { etc1EncodeBlock } from './textureEncoders.js'

// ============================================================================
// EtcEncodeWalkthrough —— ETC1 单块编码的七步单步拆解（etc-encode-100x100.md 专用）
// ----------------------------------------------------------------------------
// 数据全部来自下面写死的 block(0,0) 16 像素，用站点教学编码器 etc1EncodeBlock
// 一次性算出真实结果，再切成 7 张"状态快照"交给 StepPlayer 回放。
// 遵守全站约束：快照在 setup 里一次算完，播放只做回放，杜绝递归死循环。
//
// 用户点过"开始压缩"后，应展示与下面这张表完全一致的 hex（已实测）：
//   ff000822ffff0000 / mse 10.3542 / 16 个索引全为 2
// ============================================================================

// block(0,0) 的 16 个像素，行主序（与文章 38-43 行那张表逐字一致）
const PX_ROWS = [
  [[255, 0, 0], [252, 0, 2], [249, 0, 5], [247, 0, 7]],
  [[252, 0, 2], [249, 0, 5], [247, 0, 7], [244, 0, 10]],
  [[249, 0, 5], [247, 0, 7], [244, 0, 10], [241, 0, 13]],
  [[247, 0, 7], [244, 0, 10], [241, 0, 13], [239, 0, 15]],
]

const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0')
const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`
const rgbHex = (c) => '#' + c.map(hex2).join('')

// 编码器按列主序 (y*4+x) 取像素，这里按同一约定展平，保证结果与文章一致
const flat = []
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) flat.push(...PX_ROWS[y][x])

const result = etc1EncodeBlock(flat)
const info = result.info
const w = result.w
const hexStr = w.toString(16).padStart(16, '0')

// 从位流里按真实位布局取字段（与 etc1DecodeBlock 的取法一致）
const num = (shift, mask) => Number((w >> BigInt(shift)) & BigInt(mask))
const dR = num(56, 7), dG = num(48, 7), dB = num(40, 7)
const signed3 = (v) => (v >= 4 ? v - 8 : v)
const idxs = Array.from(result.idxs)

// ---- 子块：flip=0 左右 / flip=1 上下 ----
const subCells = (flip) => {
  const out = []
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const s = flip ? (y >= 2 ? 1 : 0) : (x >= 2 ? 1 : 0)
    out.push({ color: rgbHex(PX_ROWS[y][x]), label: `${PX_ROWS[y][x][0]},${PX_ROWS[y][x][1]},${PX_ROWS[y][x][2]}`, s })
  }
  return out
}
const cellsFlip0 = subCells(0)
const cellsFlip1 = subCells(1)

// 两种切法的子块均值（编码器 etc1EncodeBlock 里同一段逻辑：先求和再 pyround 取整）
function subAvg(flip) {
  const sum = [[0, 0, 0], [0, 0, 0]], cnt = [0, 0]
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const s = flip ? (y >= 2 ? 1 : 0) : (x >= 2 ? 1 : 0)
    for (let c = 0; c < 3; c++) sum[s][c] += PX_ROWS[y][x][c]
    cnt[s]++
  }
  return sum.map((s, i) => s.map((v) => Math.round(v / cnt[i])))
}
const avg0 = subAvg(0), avg1 = subAvg(1)

// ---- 4 档修正色：基色 + 表值 ----
const base1 = info.base1, base2 = info.base2
const mods = (tb) => {
  const T = [[2, 8, -2, -8], [5, 17, -5, -17], [9, 29, -9, -29], [13, 42, -13, -42],
             [18, 60, -18, -60], [24, 80, -24, -80], [33, 106, -33, -106], [47, 183, -47, -183]]
  return T[tb]
}
const m1 = mods(info.tb1), m2 = mods(info.tb2)
const cand = (base, m, k) => base.map((v) => Math.max(0, Math.min(255, v + m[k])))

// ---- 每像素在 4 档里选最近，逐步累计误差 ----
function pixelTrace() {
  const out = []
  let acc = 0
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const left = x < 2
    const base = left ? base1 : base2, m = left ? m1 : m2
    const p = PX_ROWS[y][x]
    let bk = 0, be = Infinity
    for (let k = 0; k < 4; k++) {
      const c = cand(base, m, k)
      const e = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2
      if (e < be) { be = e; bk = k }
    }
    acc += be
    out.push({ x, y, px: p, k: bk, idx: idxs[y * 4 + x], err: be, acc })
  }
  return out
}
const trace = pixelTrace()

// 左半/右半分别选了哪一档（本块 16 个像素全选同一档）
const leftK = trace[0].k, rightK = trace[0 + 2].k

// 解码后每格的 Δ（还原 − 原始）
const decColor = (x, y) => {
  const left = x < 2
  return cand(left ? base1 : base2, left ? m1 : m2, left ? leftK : rightK)
}
const gridCells = trace.map((t, i) => {
  const d = decColor(t.x, t.y)
  const dd = [d[0] - t.px[0], d[1] - t.px[1], d[2] - t.px[2]]
  return {
    color: rgbHex(d),
    label: `${dd[0] >= 0 ? '+' : ''}${dd[0]},${dd[1] >= 0 ? '+' : ''}${dd[1]},${dd[2] >= 0 ? '+' : ''}${dd[2]}`,
  }
})

// ---- 位域字段（顺序 = 从 bit 63 到 bit 0，展示时 reverse 让高位在左） ----
const fields = [
  { name: 'R', from: 59, to: 63, desc: '子块1 红（5bit）', value: num(59, 31) },
  { name: 'dR', from: 56, to: 58, desc: `子块2 红偏移（3bit 两补）= ${signed3(dR)}`, value: dR },
  { name: 'G', from: 51, to: 55, desc: '子块1 绿（5bit）', value: num(51, 31) },
  { name: 'dG', from: 48, to: 50, desc: `子块2 绿偏移 = ${signed3(dG)}`, value: dG },
  { name: 'B', from: 43, to: 47, desc: '子块1 蓝（5bit）', value: num(43, 31) },
  { name: 'dB', from: 40, to: 42, desc: `子块2 蓝偏移 = ${signed3(dB)}`, value: dB },
  { name: 'table1', from: 37, to: 39, desc: `子块1 修正表 = ${info.tb1}`, value: info.tb1 },
  { name: 'table2', from: 34, to: 36, desc: `子块2 修正表 = ${info.tb2}`, value: info.tb2 },
  { name: 'diff', from: 33, to: 33, desc: '1 = differential 模式', value: info.mode === 'diff' ? 1 : 0 },
  { name: 'flip', from: 32, to: 32, desc: '0 = 左右切分', value: info.flip },
  { name: '索引 MSB 平面', from: 16, to: 31, desc: '每像素 1bit，列主序 y+4x', value: num(16, 0xffff) },
  { name: '索引 LSB 平面', from: 0, to: 15, desc: '每像素 1bit，列主序 y+4x', value: num(0, 0xffff) },
]
const bytesBE = hexStr.match(/../g).map((s) => parseInt(s, 16))

// ---- 7 张状态快照 ----
const steps = computed(() => [
  {
    n: '①',
    title: '拿到 16 个像素',
    tag: '输入',
    text: `这就是 block(0,0) 的原始数据：红从 255 缓降到 239、蓝从 0 缓升到 15，是一条平滑的对角渐变。注意绿通道恒为 0 —— 这个细节后面会决定 ETC1 的成败。整块 16 个像素，每个 3 个分量，共 48 个数字要压进 64 bit。`,
    src: { file: 'textureEncoders.js', line: 18, excerpt: 'export function etc1EncodeBlock(px) {', note: '站点教学编码器入口：输入 48 个分量（列主序），输出 64bit 整数 + 决策 + MSE。' },
    viz: 'pixels',
  },
  {
    n: '②',
    title: '试两种切法：flip',
    tag: '穷举 1/4',
    text: `编码器不知道往哪边切更好，所以两种都算一遍。flip=0 按左右两半分（x≥2 归子块2），flip=1 按上下两半分（y≥2 归子块2）。方框颜色标出每个像素属于哪个子块。`,
    src: { file: 'textureEncoders.js', line: 20, excerpt: 'for (let flip = 0; flip < 2; flip++) {\n  const sub = (x, y) => (flip ? (y >= 2 ? 1 : 0) : (x >= 2 ? 1 : 0));', note: '两种 flip 各自完整跑一遍后面的所有步骤，最后比 MSE 择优。' },
    viz: 'flip',
  },
  {
    n: '③',
    title: '各子块求平均色',
    tag: '基色候选',
    text: `把每个子块的 8 个像素求平均，得到"这一半的中间色"。左右切分下是 ${rgbCss(avg0[0])} 与 ${rgbCss(avg0[1])}，上下切分下是 ${rgbCss(avg1[0])} 与 ${rgbCss(avg1[1])} —— 两个方向都很接近，因为渐变是沿对角走的。ETC1 的赌注就在这里：块内像素都离这个中间色不远。`,
    src: { file: 'textureEncoders.js', line: 28, excerpt: 'for (let s = 0; s < 2; s++) for (let c = 0; c < 3; c++) avg[s][c] = pyround(avg[s][c]/cnt[s]);', note: 'pyround 是银行家舍入（与配套 Python 的 round() 一致），不是四舍五入 —— 这一处差异会让两者决策系统性不同。' },
    viz: 'avg',
  },
  {
    n: '④',
    title: '选模式：diff 还是 ind',
    tag: '省 bit',
    text: `两个子块平均色只差 5（红）和 5（蓝），且都落在 0..31 的 5bit 范围内 → 选 differential：只存子块1 的 RGB555，子块2 用 3bit 有符号差分推出来（范围 −4..+3）。本块差分是 dR=${signed3(dR)}、dG=${signed3(dG)}、dB=${signed3(dB)}。两者都用 24 bit 存基色，但 diff 的主基色多 1 bit 精度，所以自然图里 diff 几乎总赢。`,
    src: { file: 'textureEncoders.js', line: 33, excerpt: 'for (let d = -4; d <= 3; d++) {\n  const v = base555[c]+d;\n  const e = (extend5(v)-avg[1][c])**2;', note: '对每个通道穷举 −4..+3 共 8 个候选差分，取"扩展回 8bit 后最接近子块2 均值"的那个。' },
    viz: 'mode',
  },
  {
    n: '⑤',
    title: '满世界找修正表',
    tag: '最耗时',
    text: `光有基色不够，会让整块糊成两色。每子块再挂一张 8 行的强度修正表，每行 4 档修正值。编码器把 8×8=64 种表组合全部试一遍。本块选中 table1=${info.tb1}、table2=${info.tb2}，也就是 ±5/±17 与 ±2/±8。`,
    src: { file: 'textureEncoders.js', line: 47, excerpt: 'for (let tb1 = 0; tb1 < 8; tb1++) for (let tb2 = 0; tb2 < 8; tb2++) {', note: '8×8 双层循环 = 每块 64 种表组合；每种组合内部还要对 16 个像素 × 4 档做评估。' },
    viz: 'table',
  },
  {
    n: '⑥',
    title: '逐像素挑一档',
    tag: '决策',
    text: `对每个像素，在"基色 + 表值"的 4 个候选色里挑欧氏距离最近的，记下档号 0..3（这就是最终存进 64bit 的 2bit 索引）。本块左半 8 个像素全选档 ${leftK}（表值 ${m1[leftK]}），右半全选档 ${rightK}（表值 ${m2[rightK]}）。整块累计 MSE = ${result.mse.toFixed(4)}（48 个分量平均）。`,
    src: { file: 'textureEncoders.js', line: 55, excerpt: 'for (let k = 0; k < 4; k++) {\n  const e = (clamp(cs[0]+ms[k],0,255)-px[o])**2 + ...;\n  if (e < be) { be = e; bi = k; }', note: '注意这里是严格小于（e < be），所以并列时留的是第一个 —— 档 2 的误差 17 小于档 3 的 25，最终 16 个索引全是 2。' },
    viz: 'pick',
  },
  {
    n: '⑦',
    title: '打包成 64 bit',
    tag: '输出',
    text: `按 KDF 规定的位布局拼起来，得到 ${hexStr}。低 32 bit 全是 0、高一半是 1 —— 那正是"16 个索引全为 2"的直接体现：拆成 MSB 平面与 LSB 平面后，一个全 1、一个全 0。解码时只需反向移位 + 查表 + 加法。`,
    src: { file: 'textureEncoders.js', line: 82, excerpt: 'for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {\n  const bit = y + x*4, v = BigInt(idxs[y*4+x]);\n  w |= ((v>>1n)&1n)<<b(16+bit) | (v&1n)<<b(bit);', note: '索引按列主序（bit = y + 4x）拆成两个 16bit 平面，这样硬件一次 16bit 读就能拿到一整列像素的同一个 bit。' },
    viz: 'pack',
  },
])
</script>

<template>
  <StepPlayer :steps="steps" title="ETC1 单块编码：block(0,0) 的七步" source-root="texture-compression/components/">
    <template #viz="{ index }">
      <!-- ① 原始像素 -->
      <div v-if="index === 0">
        <ByteGrid :cells="trace.map(t => ({ color: rgbHex(t.px), label: `${t.px[0]},${t.px[1]},${t.px[2]}` }))"
                  :cols="4" :rows="4" :cell-size="46" title="block(0,0) 原始 16 像素（行主序）" />
      </div>

      <!-- ② 两种 flip 切法 -->
      <div v-else-if="index === 1">
        <ByteGrid :cells="cellsFlip0" :cols="4" :rows="4" :cell-size="42" :show-label="false"
                  :sub-blocks="[{ from: 0, to: 15, name: 'flip=0 左右两半', note: '格子 2,3 / 6,7 / 10,11 / 14,15 属于子块2（右侧两列）' }]"
                  title="flip=0：按 x 切（左右）" />
        <ByteGrid :cells="cellsFlip1" :cols="4" :rows="4" :cell-size="42" :show-label="false"
                  :sub-blocks="[{ from: 0, to: 15, name: 'flip=1 上下两半', note: '格子 8..15 属于子块2（下侧两行）' }]"
                  title="flip=1：按 y 切（上下）" />
      </div>

      <!-- ③ 子块均值 -->
      <div v-else-if="index === 2" class="ew-avgrow">
        <div class="ew-avgbox">
          <div class="ew-avgtitle">flip=0 左右切分</div>
          <div class="ew-chips">
            <span class="ew-chip" :style="{ background: rgbCss(avg0[0]) }">子块1 均值 {{ avg0[0].join(',') }}</span>
            <span class="ew-chip" :style="{ background: rgbCss(avg0[1]) }">子块2 均值 {{ avg0[1].join(',') }}</span>
          </div>
        </div>
        <div class="ew-avgbox">
          <div class="ew-avgtitle">flip=1 上下切分</div>
          <div class="ew-chips">
            <span class="ew-chip" :style="{ background: rgbCss(avg1[0]) }">子块1 均值 {{ avg1[0].join(',') }}</span>
            <span class="ew-chip" :style="{ background: rgbCss(avg1[1]) }">子块2 均值 {{ avg1[1].join(',') }}</span>
          </div>
        </div>
        <p class="ew-note">编码器最终选了 <b>flip={{ info.flip }}（{{ info.flip ? '上下' : '左右' }}）</b> —— 它比另一种切法少一点点误差，但肉眼看不出差别。</p>
      </div>

      <!-- ④ 模式选择 -->
      <div v-else-if="index === 3" class="ew-avgrow">
        <div class="ew-avgbox">
          <div class="ew-avgtitle">differential（本块选中）</div>
          <p class="ew-mini">子块1 存 RGB555 = {{ info.base1q.join(',') }}，子块2 存 3bit 差分 = {{ signed3(dR) }},{{ signed3(dG) }},{{ signed3(dB) }}</p>
          <p class="ew-mini">扩展回 8bit：子块1 = {{ base1.join(',') }}，子块2 = {{ base2.join(',') }}</p>
          <p class="ew-mini ew-ok">基色 24 bit（15+9），主基色 5bit/通道</p>
        </div>
        <div class="ew-avgbox">
          <div class="ew-avgtitle">individual（未选中，仅作对照）</div>
          <p class="ew-mini">两子块各存 RGB444，共 24 bit</p>
          <p class="ew-mini ew-bad">位预算一样，但每通道只有 4bit —— 精度更低</p>
        </div>
      </div>

      <!-- ⑤ 修正表 -->
      <div v-else-if="index === 4">
        <table class="ew-tbl">
          <thead><tr><th>档</th><th>子块1 表 {{ info.tb1 }}</th><th>子块2 表 {{ info.tb2 }}</th></tr></thead>
          <tbody>
            <tr v-for="k in 4" :key="k">
              <td>{{ k - 1 }}</td>
              <td :class="{ 'ew-hit': k - 1 === leftK }">{{ m1[k - 1] }} → {{ cand(base1, m1, k - 1).join(',') }}</td>
              <td :class="{ 'ew-hit': k - 1 === rightK }">{{ m2[k - 1] }} → {{ cand(base2, m2, k - 1).join(',') }}</td>
            </tr>
          </tbody>
        </table>
        <p class="ew-note">整张表共 8 行（0..7），修正值从 ±2/±8 一路放大到 ±47/±183。高对比块会用后面的表，平坦块用前面的。</p>
      </div>

      <!-- ⑥ 逐像素决策 -->
      <div v-else-if="index === 5">
        <table class="ew-tbl">
          <thead><tr><th>像素</th><th>原始 RGB</th><th>选中档</th><th>误差</th><th>累计 MSE</th></tr></thead>
          <tbody>
            <tr v-for="(t, i) in trace.slice(0, 8)" :key="i">
              <td>({{ t.x }},{{ t.y }})</td>
              <td>{{ t.px.join(',') }}</td>
              <td>{{ t.k }}</td>
              <td>{{ t.err }}</td>
              <td>{{ (t.acc / ((i + 1) * 3)).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="ew-note">上表只列前 8 个像素；后 8 个同理，最终 16 个索引全为 {{ idxs[0] }}。</p>
      </div>

      <!-- ⑦ 打包 -->
      <div v-else>
        <BitField :bytes="bytesBE" :fields="fields" :width="64" reverse
                  title="ETC1 64bit 真实位域（高位在左，值取自本块实际输出）" />
        <p class="ew-note">整块解码后只剩两种颜色：左半 {{ base1.map((v, c) => Math.max(0, Math.min(255, v + m1[leftK]))).join(',') }}、右半 {{ base2.map((v, c) => Math.max(0, Math.min(255, v + m2[rightK]))).join(',') }}。</p>
        <ByteGrid :cells="gridCells" :cols="4" :rows="4" :cell-size="46"
                  title="解码还原（每格标注 Δ = 还原 − 原始）" />
      </div>
    </template>
  </StepPlayer>
</template>

<style scoped>
.ew-avgrow { display: flex; flex-direction: column; gap: 10px; }
.ew-avgbox { border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 8px 10px; }
.ew-avgtitle { font-size: 12px; font-weight: 600; color: var(--vp-c-brand-1); margin-bottom: 6px; }
.ew-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.ew-chip {
  padding: 6px 12px; border-radius: 6px; color: #fff; font-size: 12px;
  font-family: var(--vp-font-family-mono); text-shadow: 0 0 3px rgba(0, 0, 0, 0.85);
}
.ew-note { margin: 8px 0 0; font-size: 12.5px; color: var(--vp-c-text-2); line-height: 1.7; }
.ew-mini { margin: 4px 0; font-size: 12px; color: var(--vp-c-text-2); font-family: var(--vp-font-family-mono); }
.ew-ok { color: #12B886; }
.ew-bad { color: #E8590C; }
.ew-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.ew-tbl th, .ew-tbl td { border: 1px solid var(--vp-c-divider); padding: 3px 8px; text-align: left; font-family: var(--vp-font-family-mono); }
.ew-tbl th { background: var(--vp-c-bg); font-weight: 600; }
.ew-hit { background: rgba(76, 110, 245, 0.18); font-weight: 600; }
</style>
