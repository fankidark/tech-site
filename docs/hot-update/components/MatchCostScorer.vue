<script setup>
import { computed, ref } from 'vue'

// ============================================================================
// MatchCostScorer —— 「这条匹配到底值不值得存成 cover」的收益模型计算器
// ----------------------------------------------------------------------------
// hdiff-minmatch 那一篇的核心结论（"几字节的重复付不起入场费"）如果只写公式，
// 0 基础读者没法自己验算。这里把三个变长整数的编码字节数实时算出来，
// 让读者拖滑块就能把结论"亲手复现"一遍。
//
// 全部数值来自 HDiffPatch v4.12.1 的真实常量与编码规则：
//   kCoverMinMatchLen = 5      （diff_types.h:71）
//   kMinMatchScore    = 2      （diff.cpp:65，初审闸门）
//   kMinSingleMatchScore 库默认 6（diff.h:34）、CLI 提示行写 DEFAULT -m-6（hdiffz.cpp:169）
//   getCoverCtrlCost  = cost(oldPos增量) + cost(length) + cost(newPos增量)（diff.cpp:216-221）
//   变长整数 = 7bit 数据 + MSB 续位（pack_uint.h:38-48 → hpatch_packUIntWithTag）
// ============================================================================

// ---------- 真实变长整数成本 ----------
function uintBytes(v) {                       // hpatch_packUInt 的字节数
  if (v < 0) v = 0
  let n = 1
  while (v >= 128) { v = Math.floor(v / 128); n++ }
  return n
}
function intBytes(v) {                        // 带符号：源码先 ×2 再当无符号写（tag 占 1 bit）
  return uintBytes(2 * Math.abs(v))
}

// ---------- 可调参数 ----------
const matchLen = ref(6)        // 匹配长度
const oldDelta = ref(8)        // 本条 cover 的 oldPos 相对上一条 cover oldEnd 的增量
const newGap = ref(6)          // 本条 cover 的 newPos 相对上一条 cover newEnd 的增量
const threshold = ref(2)       // kMinMatchScore / kMinSingleMatchScore
const showSecond = ref(false)  // 是否用第二轮 _select_cover 的阈值

const effThreshold = computed(() => (showSecond.value ? Math.max(threshold.value, 4) : threshold.value))

// ---------- 三笔成本 ----------
const costRows = computed(() => {
  const a = intBytes(oldDelta.value)
  const b = uintBytes(matchLen.value)
  const c = uintBytes(newGap.value)
  return [
    {
      name: 'inc_oldPos 增量',
      value: oldDelta.value,
      written: 2 * Math.abs(oldDelta.value),
      bytes: a,
      why: `oldPos 相对上一条 cover 的 oldEnd。要用 1 个 bit 记方向（前进/回退），`
        + `所以源码把它 ×2 之后当无符号数写：2×${oldDelta.value}=${2 * Math.abs(oldDelta.value)}`,
    },
    {
      name: 'length',
      value: matchLen.value,
      written: matchLen.value,
      bytes: b,
      why: '复用长度，恒为正，直接当无符号变长整数写',
    },
    {
      name: 'inc_newPos 增量',
      value: newGap.value,
      written: newGap.value,
      bytes: c,
      why: 'newPos 相对上一条 cover 的 newEnd。newPos 只能前进，所以不需要符号位',
    },
  ]
})
const ctrlCost = computed(() => costRows.value.reduce((s, r) => s + r.bytes, 0))
const score = computed(() => matchLen.value - ctrlCost.value)

// ---------- 三道闸门 ----------
const gates = computed(() => [
  {
    n: '① 长度门槛',
    src: 'diff.cpp:160 / :314',
    pass: matchLen.value >= 5,
    detail: matchLen.value >= 5
      ? `匹配 ${matchLen.value}B ≥ kMinMatchLen(5)，够格进入裁决`
      : `匹配 ${matchLen.value}B < kMinMatchLen(5)：getBestMatch 里 bestLength 的初始值就是 4，`
        + `短于 5 的匹配根本不会更新它 → 这条匹配对算法"不存在"，连候选都不是`,
  },
  {
    n: '② 收益裁决',
    src: 'diff.cpp:319',
    pass: matchLen.value >= 5 && score.value >= effThreshold.value,
    detail: `匹配长度 ${matchLen.value} − 控制流成本 ${ctrlCost.value} = ${score.value}，`
      + `门槛 kMinMatchScore = ${effThreshold.value} → ${score.value >= effThreshold.value ? '通过' : '丢弃，newPos 只前进 1 字节'}`,
  },
  {
    n: '③ 压缩率终审',
    src: 'diff.cpp:394-398',
    pass: matchLen.value >= 5 && score.value >= effThreshold.value,
    detail: '第二轮用相邻字符转移概率表估计"这段当 gap 直出"与"当 cover（残差 RLE）"哪个更省。'
      + '即使①②都过，若残差不比直出便宜，终审照样删。这一关的输入是数据本身的统计特征，'
      + '本计算器只用①②的结论近似 —— 真实判定要看 nocover_detect / cover_detect 两张概率表。',
  },
])

// ---------- 预设：复刻 hdiff-minmatch 的实测实验 ----------
const PRESETS = [
  { key: 'e9', label: '实验 9：5B 重复', len: 5, old: 10, gap: 4, note: '实测 coverCount=0 —— 卡在门槛上' },
  { key: 'e4', label: '实验 4：6B 重复', len: 6, old: 12, gap: 8, note: '实测 coverCount=0 —— 初审也许能过，终审被删' },
  { key: 'e10', label: '实验 10：12B 重复', len: 12, old: 40, gap: 30, note: '实测 coverCount=1 —— 稳定入选' },
  { key: 'e1a', label: '实验 1：8B（相邻两条的前一条）', len: 8, old: 60, gap: 50, note: '实测 coverCount=0 —— 两条都被终审删除' },
]
function applyPreset(p) {
  matchLen.value = p.len
  oldDelta.value = p.old
  newGap.value = p.gap
}

// ---------- 一维"扫描"视图：固定 oldPos 增量与 gap，扫匹配长度 ----------
const sweep = computed(() => {
  const rows = []
  for (let L = 4; L <= 16; L++) {
    const cost = intBytes(oldDelta.value) + uintBytes(L) + uintBytes(newGap.value)
    rows.push({ L, cost, score: L - cost, pass: L >= 5 && L - cost >= effThreshold.value })
  }
  return rows
})
const firstPass = computed(() => sweep.value.find((r) => r.pass))
</script>

<template>
  <div class="mcs">
    <div class="mcs-head">
      <strong>🧮 cover 收益模型计算器</strong>
      <span class="mcs-sub">
        拖滑块改匹配长度 / oldPos 增量 / 间隙，实时看这条匹配能不能"付得起入场费"
      </span>
    </div>

    <!-- 预设 -->
    <div class="mcs-presets">
      <span class="mcs-presets-label">一键复刻实测实验：</span>
      <button v-for="p in PRESETS" :key="p.key" class="mcs-chip" @click="applyPreset(p)" :title="p.note">
        {{ p.label }}
      </button>
    </div>

    <!-- 输入 -->
    <div class="mcs-inputs">
      <label class="mcs-field">
        <span>匹配长度 <b>{{ matchLen }}</b> B</span>
        <input type="range" min="2" max="64" v-model.number="matchLen" />
      </label>
      <label class="mcs-field">
        <span>inc_oldPos <b>{{ oldDelta }}</b>（相对上一条 cover 的 oldEnd）</span>
        <input type="range" min="0" max="4096" step="1" v-model.number="oldDelta" />
      </label>
      <label class="mcs-field">
        <span>inc_newPos <b>{{ newGap }}</b>（相对上一条 cover 的 newEnd）</span>
        <input type="range" min="0" max="2048" step="1" v-model.number="newGap" />
      </label>
      <label class="mcs-field mcs-field-inline">
        <input type="checkbox" v-model="showSecond" />
        <span>用第二轮 <code>_select_cover</code> 的口径（阈值抬到 ≥4）</span>
      </label>
      <label v-if="showSecond" class="mcs-field">
        <span>kMinSingleMatchScore <b>{{ effThreshold }}</b></span>
        <input type="range" min="0" max="9" v-model.number="threshold" />
      </label>
    </div>

    <!-- 成本明细 -->
    <table class="mcs-tbl">
      <thead>
        <tr><th>写入 patch 的字段</th><th>原值</th><th>实际写进去的数</th><th>编码字节数</th><th>为什么要这么写</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in costRows" :key="r.name">
          <td class="mcs-mono">{{ r.name }}</td>
          <td class="mcs-mono">{{ r.value }}</td>
          <td class="mcs-mono">{{ r.written }}</td>
          <td class="mcs-mono mcs-num">{{ r.bytes }}</td>
          <td class="mcs-why">{{ r.why }}</td>
        </tr>
        <tr class="mcs-total">
          <td colspan="3"><b>getCoverCtrlCost 合计</b></td>
          <td class="mcs-mono mcs-num"><b>{{ ctrlCost }}</b> B</td>
          <td class="mcs-why">
            源码 <code>diff.cpp:216-221</code>：三项相加（<code>_getIntCost</code> + <code>_getUIntCost</code> ×2）
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 结论 -->
    <div class="mcs-verdict" :class="{ ok: gates[1].pass }">
      <div class="mcs-formula">
        {{ matchLen }}（匹配长度） − {{ ctrlCost }}（控制流成本） = <b>{{ score }}</b>
        <span class="mcs-vs">{{ score >= effThreshold ? '≥' : '<' }} {{ effThreshold }}（门槛）</span>
      </div>
      <div class="mcs-vtext">
        {{ gates[1].pass
          ? '✅ 这条 cover 值得存 —— 复用省下的字节数大于描述它的控制流开销'
          : '❌ 这条 cover 不值得存 —— 它省下的字节还不够付描述自己的钱，内容只能进 gap 直出（newDataDiff）' }}
      </div>
    </div>

    <!-- 三道闸门 -->
    <table class="mcs-tbl">
      <thead><tr><th>闸门</th><th>结论</th><th>判定过程</th><th>源码</th></tr></thead>
      <tbody>
        <tr v-for="g in gates" :key="g.n">
          <td class="mcs-mono">{{ g.n }}</td>
          <td :class="g.pass ? 'mcs-pass' : 'mcs-fail'">{{ g.pass ? '通过' : '拒绝' }}</td>
          <td class="mcs-why">{{ g.detail }}</td>
          <td class="mcs-mono mcs-src">{{ g.src }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 扫描：匹配长度 → 是否及格 -->
    <div class="mcs-sweep">
      <div class="mcs-sub-title">
        固定 oldPos 增量 = {{ oldDelta }}、间隙 = {{ newGap }}，把匹配长度从 4B 扫到 16B：
      </div>
      <div class="mcs-sweep-row">
        <div v-for="r in sweep" :key="r.L" class="mcs-sweep-cell" :class="{ pass: r.pass }" :title="`length=${r.L} 成本=${r.cost} 收益=${r.score}`">
          <div class="mcs-sweep-len">{{ r.L }}B</div>
          <div class="mcs-sweep-score">{{ r.score >= 0 ? '+' : '' }}{{ r.score }}</div>
          <div class="mcs-sweep-flag">{{ r.pass ? '✔' : '✘' }}</div>
        </div>
      </div>
      <p class="mcs-foot">
        在当前参数下，<b>{{ firstPass ? `${firstPass.L}B 是第一条能达到门槛的匹配长度` : '扫到 16B 都没有匹配能达到门槛' }}</b>。
        把 inc_oldPos 或 inc_newPos 拖大，你会看到这条及格线整体往右移 ——
        这就是"孤立的短匹配永远入选不了、而 old 里挨得近的匹配几乎免费"的同一套机制。
      </p>
    </div>
  </div>
</template>

<style scoped>
.mcs {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
}
.mcs-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.mcs-sub { font-size: 12px; color: var(--vp-c-text-2); }

.mcs-presets { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.mcs-presets-label { font-size: 12px; color: var(--vp-c-text-3); }
.mcs-chip {
  border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); color: var(--vp-c-text-1);
  border-radius: 14px; padding: 3px 10px; font-size: 11.5px; cursor: pointer;
}
.mcs-chip:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.mcs-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 16px; margin-bottom: 12px; }
.mcs-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--vp-c-text-2); }
.mcs-field b { color: var(--vp-c-brand-1); font-family: var(--vp-font-family-mono); }
.mcs-field input[type='range'] { width: 100%; }
.mcs-field-inline { flex-direction: row; align-items: center; gap: 6px; }

.mcs-tbl { width: 100%; border-collapse: collapse; font-size: 12px; display: table; margin-bottom: 10px; }
.mcs-tbl th, .mcs-tbl td { border: 1px solid var(--vp-c-divider); padding: 3px 7px; text-align: left; vertical-align: top; line-height: 1.65; }
.mcs-tbl th { background: var(--vp-c-bg-soft); font-weight: 600; white-space: nowrap; }
.mcs-tbl code { font-size: 11px; }
.mcs-mono { font-family: var(--vp-font-family-mono); white-space: nowrap; }
.mcs-num { text-align: center; }
.mcs-why { color: var(--vp-c-text-2); }
.mcs-src { color: var(--vp-c-text-3); }
.mcs-total td { background: var(--vp-c-bg-soft); }
.mcs-pass { color: #2b8a3e; font-weight: 600; white-space: nowrap; }
.mcs-fail { color: #e03131; font-weight: 600; white-space: nowrap; }

.mcs-verdict {
  border: 1px solid #e03131;
  background: rgba(224, 49, 49, 0.08);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.mcs-verdict.ok { border-color: #2f9e44; background: rgba(47, 158, 68, 0.10); }
.mcs-formula { font-family: var(--vp-font-family-mono); font-size: 14px; margin-bottom: 4px; }
.mcs-vs { margin-left: 10px; color: var(--vp-c-text-2); }
.mcs-vtext { font-size: 12.5px; line-height: 1.7; }

.mcs-sweep { margin-top: 4px; }
.mcs-sub-title { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.mcs-sweep-row { display: flex; gap: 3px; flex-wrap: wrap; }
.mcs-sweep-cell {
  min-width: 44px; padding: 4px 6px; border-radius: 6px; text-align: center;
  background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider); font-family: var(--vp-font-family-mono);
}
.mcs-sweep-cell.pass { border-color: #2f9e44; background: rgba(47, 158, 68, 0.12); }
.mcs-sweep-len { font-size: 12px; font-weight: 600; }
.mcs-sweep-score { font-size: 11px; color: var(--vp-c-text-2); }
.mcs-sweep-flag { font-size: 11px; }
.mcs-foot { font-size: 12px; line-height: 1.75; color: var(--vp-c-text-2); margin: 8px 0 0; }
</style>
