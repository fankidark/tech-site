<script setup>
import { ref, computed } from 'vue'

// ============ 后缀数组 + 二分匹配查找 · 独立可视化 ============
// 忠实翻译 HDiffPatch v4.12.1 的匹配查找核心（suffix_string.cpp + diff.cpp:149 getBestMatch）：
//   ① 构建后缀数组：old 所有后缀排序（SA[i] = 第 i 小后缀的起点）
//   ② lower_bound 二分：在 SA 中找 ≥ 查询串的第一个后缀（带 left_eq/right_eq 缓存优化, :155-198）
//   ③ getBestMatch：从 sai 向左右各探测 1 个候选（matchDeep=2, diff.cpp:174-206）取最长
// 常量：kMinMatchLen=5（diff_types.h:71）、kMaxCmpLength_forLimitRangeDiff=8K（:188）

const K_MIN_MATCH_LEN = 5
const MATCH_DEEP = 2   // diff.cpp:153 matchDeep=2（无 diffLimit 时）

const oldText = ref('BANANA_MISSISSIPPI_BANANA_SPLIT')
const newText = ref('MISSISSIPPI_SPLIT_BANANA_BREAD')

// ---------- 数据 ----------
const buildSA = (s) => {
  const n = s.length
  const sa = Array.from({ length: n }, (_, i) => i)
  sa.sort((a, b) => { const x = s.slice(a), y = s.slice(b); return x < y ? -1 : x > y ? 1 : 0 })  // 字节序（C memcmp 语义），localeCompare 对 _ 等符号排序不同
  return sa
}
const sa = computed(() => buildSA(oldText.value))
// 二分过程时间线
function binarySearchTimeline(str, s, SA) {
  const timeline = []
  let lo = 0, hi = SA.length - 1
  let step = 0
  // lower_bound: 找第一个 ≥ str 的后缀
  while (lo <= hi) {
    if (++step > 20) break
    const mid = (lo + hi) >> 1
    const sufStart = SA[mid]
    const suffix = s.slice(sufStart)
    // 比较后缀与查询串：等长公共前缀 + 首个差异字符
    let eq = 0
    const maxL = Math.min(suffix.length, str.length)
    while (eq < maxL && suffix[eq] === str[eq]) eq++
    let cmp
    if (eq === str.length) cmp = 0            // 查询串是后缀的前缀
    else if (eq === suffix.length) cmp = -1   // 后缀是查询串的前缀（后缀短 → 小）
    else cmp = suffix[eq] < str[eq] ? -1 : 1
    timeline.push({
      step,
      lo, hi, mid, sufStart,
      suffix: suffix.slice(0, Math.min(suffix.length, 24)),
      eq, cmp,                   // -1 后缀<查询 → 往右， +1 后缀>查询 → 往左
      loNext: cmp < 0 ? mid + 1 : lo,
      hiNext: cmp < 0 ? hi : mid - 1,
      isHit: cmp === 0,
    })
    if (cmp === 0) { hi = mid - 1; timeline[timeline.length-1].foundPrefix = true; continue } // 查询串是后缀前缀 → 命中，继续向左找最小起点（lower_bound 语义）
    if (cmp < 0) lo = mid + 1
    else hi = mid - 1
    if (lo > hi) break
  }
  return timeline
}
// getBestMatch 左右探测时间线
function probeTimeline(sai, str, s, SA) {
  const timeline = []
  let bestLen = K_MIN_MATCH_LEN - 1
  let bestOldPos = -1
  // diff.cpp:174: i = sai + (1-(mdi&1)*2) * ((mdi+1)/2) → mdi=0: sai, mdi=1: sai-1
  const order = [sai, sai - 1]   // 教学顺序：先 sai，再 sai-1（真实是 sai, sai+(-1)…即左右各一）
  const labels = ['sai（lower_bound 命中位）', 'sai−1（左邻后缀）']
  for (let mdi = 0; mdi < MATCH_DEEP; mdi++) {
    const i = order[mdi]
    if (i < 0 || i >= SA.length) {
      timeline.push({ label: labels[mdi] || `候选#${mdi}`, i, skip: '越界' })
      continue
    }
    const op = SA[i]
    const maxL = Math.min(str.length, s.length - op)
    let l = 0
    while (l < maxL && str[l] === s[op + l]) l++
    const better = l > bestLen
    if (better) { bestLen = l; bestOldPos = op }
    timeline.push({
      label: labels[mdi] || `候选#${mdi}`,
      i, op, matchLen: l,
      matched: str.slice(0, Math.min(l, 30)),
      nextChar: s[op + l],
      better, bestLen, bestOldPos,
      stop: mdi > 0 && (i === sai ? false : true),   // 简化：每个候选比完
    })
  }
  return { timeline, bestLen, bestOldPos, isMatch: bestLen >= K_MIN_MATCH_LEN }
}

// ---------- 查询状态 ----------
const queryPos = ref(17)  // 默认查 new[17..] = "_BANANA_BREAD"（8B 命中 old[20..]="_BANANA_SPLIT"）
const queryStr = computed(() => newText.value.slice(queryPos.value))
const timeline = computed(() => binarySearchTimeline(queryStr.value, oldText.value, sa.value))
const saiIdx = computed(() => {
  // 重放二分取最终 sai（lower_bound 语义：第一个 ≥ 查询的后缀）
  const s = oldText.value, SA = sa.value, q = queryStr.value
  let lo = 0, hi = SA.length - 1, sai = -1
  let guard = 0
  while (lo <= hi && guard++ < 40) {
    const mid = (lo + hi) >> 1
    const suf = s.slice(SA[mid])
    let eq = 0
    const m = Math.min(suf.length, q.length)
    while (eq < m && suf[eq] === q[eq]) eq++
    let cmp
    if (eq === q.length) cmp = 0
    else if (eq === suf.length) cmp = -1
    else cmp = suf[eq] < q[eq] ? -1 : 1
    if (cmp < 0) lo = mid + 1
    else { sai = mid; hi = mid - 1 }
  }
  return sai
})
const probe = computed(() => {
  if (saiIdx.value < 0) return null
  return probeTimeline(saiIdx.value, queryStr.value, oldText.value, sa.value)
})
const verdict = computed(() => {
  if (!probe.value) return null
  const { bestLen, bestOldPos, isMatch } = probe.value
  if (!isMatch) return { cls: '#e8590c', text: `❌ 最长 ${bestLen}B < kMinMatchLen(${K_MIN_MATCH_LEN}) → newPos++ 跳过（短匹配"隐形"）` }
  return { cls: '#2b8a3e', text: `✅ 最长匹配 ${bestLen}B @oldPos=${bestOldPos} → 进入收益裁决（matchEqLength−ctrlCost ≥ 2?）` }
})

// 前进/回退
const viewIdx = ref(-1)   // -1=未开始, 0..n-1=二分步, n=左探测, n+1=右探测, n+2=结论
const totalViews = computed(() => timeline.value.length + (probe.value?.timeline.length || 0) + 1)
const curView = computed(() => {
  const t = timeline.value
  const p = probe.value
  if (!t.length || viewIdx.value < 0) return null
  if (viewIdx.value < t.length) return { kind: 'bisect', data: t[viewIdx.value] }
  const pi = viewIdx.value - t.length
  if (p && pi < p.timeline.length) return { kind: 'probe', data: p.timeline[pi] }
  return { kind: 'verdict', data: verdict.value }
})
function nextV() { if (viewIdx.value < totalViews.value - 1) viewIdx.value++ }
function prevV() { if (viewIdx.value >= 0) viewIdx.value-- }
function resetV() { viewIdx.value = -1 }

// 高亮辅助
function bisectColor(i, cur) {
  if (!cur) return '#e9ecef'
  if (i === cur.mid) return cur.data.cmp < 0 ? '#ffd8a8' : (cur.data.foundPrefix ? '#d0bfff' : '#a5d8ff')
  if (i >= cur.data.lo && i <= cur.data.hi) return '#fff3bf'
  return '#e9ecef'
}
</script>

<template>
  <div style="font-family: system-ui, sans-serif; line-height: 1.6">
    <h3>🔍 匹配查找算法 · 后缀数组 + 二分动态演示</h3>
    <div style="font-size:12px; color:#868e96; margin-bottom:10px">
      忠实翻译 <code>suffix_string.cpp:155 _lower_bound</code>（二分）+ <code>diff.cpp:149 getBestMatch</code>（左右探测 matchDeep=2）
    </div>

    <!-- 输入 -->
    <div style="background:#f6f8fa; padding:12px; border-radius:8px; margin-bottom:12px">
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">old 文本（建后缀数组）</label>
        <textarea v-model="oldText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">new 文本（查询来源）</label>
        <textarea v-model="newText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">
        <label style="font-size:13px">查询 new[{{ queryPos }}..]：
          <input v-model.number="queryPos" type="number" min="0" :max="newText.length-1" style="width:60px; padding:4px; margin:0 6px" />
          <code style="background:#fff3bf; padding:2px 8px; border-radius:3px; font-size:12px">"{{ queryStr.slice(0, 20) }}{{ queryStr.length > 20 ? '…' : '' }}"</code>
        </label>
        <button @click="resetV; viewIdx=-1" style="padding:6px 14px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">↺ 从头演示</button>
        <button @click="prevV" :disabled="viewIdx < 0" style="padding:6px 14px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">◀ 上一步</button>
        <button @click="nextV" :disabled="viewIdx >= totalViews-1" style="padding:6px 16px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
          下一步 ▶ {{ viewIdx >= 0 ? `${viewIdx+1}/${totalViews}` : '' }}
        </button>
      </div>
    </div>

    <!-- ① 后缀数组全景 -->
    <div style="border:2px solid #343a40; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">① 后缀数组 SA（old 的 {{ sa.length }} 个后缀按字典序排列）</div>
      <div style="font-size:11px; color:#868e96; margin-bottom:6px">SA[i] = 第 i 小后缀的起点。二分范围：🟡 当前区间 ｜ 🟠 中点（后缀&lt;查询→右半）｜ 🔵 中点（后缀&gt;查询→左半）｜ 🟣 命中前缀</div>
      <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:2px; font-family:monospace; font-size:10px">
        <div v-for="(s0, i) in sa" :key="i" :style="{
          padding:'2px 6px', borderRadius:3,
          background: bisectColor(i, curView && curView.kind==='bisect' ? curView : null),
          border: curView && curView.kind==='bisect' && i === curView.data.mid ? '2px solid #e8590c' : '1px solid transparent'
        }">
          <strong>SA[{{ i }}]=<span style="color:#e8590c">{{ s0 }}</span></strong>
          <span style="color:#495057">"{{ oldText.slice(s0, s0+22) }}{{ oldText.length - s0 > 22 ? '…' : '' }}"</span>
        </div>
      </div>
    </div>

    <!-- ② 当前步骤 -->
    <div v-if="curView" style="background:#fff9db; border:1px solid #ffd43b; padding:10px 14px; border-radius:8px; margin-bottom:12px">
      <!-- 二分步 -->
      <template v-if="curView.kind === 'bisect'">
        <div style="font-weight:700; color:#e8590c; margin-bottom:4px">
          ② 二分第 {{ curView.data.step }} 步：区间 [{{ curView.data.lo }}, {{ curView.data.hi }}]，取中点 mid={{ curView.data.mid }} → 后缀 "SA[{{ curView.data.sufStart }}]" = "{{ curView.data.suffix }}…"
        </div>
        <div style="font-family:monospace; font-size:11px; background:#fff; padding:6px 8px; border-radius:4px; border:1px dashed #dee2e6; margin-bottom:6px">
          suffix_string.cpp:169-191：逐字符比较 → 公共前缀 {{ curView.data.eq }} 字符 → 首个差异 "{{ curView.data.suffix[curView.data.eq] }}" vs "{{ queryStr[curView.data.eq] }}" → 后缀{{ curView.data.cmp < 0 ? '小' : '大' }}于查询 → {{ curView.data.cmp < 0 ? `lo=${curView.data.loNext}（丢左半）` : `hi=${curView.data.hiNext}（丢右半）` }}
        </div>
        <div style="font-size:12px; color:#495057">
          公共前缀 eq 缓存（left_eq/right_eq）是源码的提速细节：下一轮比较直接从 eq 位开始，不用重比。
        </div>
      </template>
      <!-- 探测步 -->
      <template v-else-if="curView.kind === 'probe'">
        <div style="font-weight:700; color:#e8590c; margin-bottom:4px">
          ③ getBestMatch 探测 {{ curView.data.label }}：SA[{{ curView.data.i }}] → oldPos={{ curView.data.op }}，匹配 {{ curView.data.matchLen }}B "{{ curView.data.matched }}{{ curView.data.nextChar ? '' : '' }}"{{ curView.data.matchLen ? `（下一个字符 '${curView.data.nextChar}' 不匹配）` : '' }}
        </div>
        <div style="font-family:monospace; font-size:11px; background:#fff; padding:6px 8px; border-radius:4px; border:1px dashed #dee2e6; margin-bottom:6px">
          diff.cpp:179 curLength=getEqualLength(newData…, src_begin+curOldPos…) ｜ diff.cpp:187 if(curLength&gt;bestLength) 更新 ｜ diff.cpp:203-206 左右各比完一个候选就 break（matchDeep=2）
        </div>
        <div style="font-size:12px; color:#495057">
          {{ curView.data.better ? `✅ 优于当前 best（${curView.data.bestLen}B）→ 更新 bestOldPos=${curView.data.bestOldPos}` : '✗ 不优于当前 best' }}
        </div>
      </template>
      <!-- 结论 -->
      <template v-else>
        <div style="font-weight:700" :style="{color: curView.data.cls}">{{ curView.data.text }}</div>
        <div style="font-size:12px; color:#495057; margin-top:4px">
          复杂度：后缀数组二分 O(log n × L)（L=匹配长度，eq 缓存实际远小于 L），对比朴素 O(n × L) —— 32B 小文件差别不大，GB 级 old 是数量级差距。
        </div>
      </template>
    </div>

    <!-- ③ 查询串 vs 命中串对齐显示（探测步） -->
    <div v-if="curView && curView.kind === 'probe'" style="border:2px solid #e8590c; border-radius:8px; padding:10px; background:#fff; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">查询串 vs old 命中串（逐字符对齐）</div>
      <div style="font-family:monospace; font-size:12px; margin-bottom:4px">
        <span style="color:#868e96">new[{{ queryPos }}..]: </span>
        <span v-for="(ch, i) in queryStr.slice(0, 30)" :key="'q'+i" :style="{
          padding:'1px', background: i < curView.data.matchLen ? '#b2f2bb' : '#ffe3e3'
        }">{{ ch }}</span>
      </div>
      <div style="font-family:monospace; font-size:12px">
        <span style="color:#868e96">old[{{ curView.data.op }}..]: </span>
        <span v-for="(ch, i) in oldText.slice(curView.data.op, curView.data.op + 30)" :key="'o'+i" :style="{
          padding:'1px', background: i < curView.data.matchLen ? '#b2f2bb' : '#ffe3e3'
        }">{{ ch }}</span>
      </div>
      <div style="font-size:11px; color:#868e96; margin-top:6px">🟢 绿 = 匹配区（getEqualLength 结果）　🔴 红 = 首个不匹配及之后</div>
    </div>

    <!-- 结论 -->
    <div v-if="curView && curView.kind === 'verdict'" style="border:2px solid #37b24d; border-radius:8px; padding:10px; background:#ebfbee; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600">匹配结果进入主流程</div>
      <div style="font-size:12px; color:#495057; margin-top:4px">
        getBestMatch 返回 → _search_cover（diff.cpp:313）拿 {matchOldPos, matchEqLength} → 收益裁决（diff.cpp:323）→
        这个结果在你的主模拟器里对应 ②/③/⑤ 步。切回「diff 生成」模式看后续。
      </div>
    </div>

    <!-- 学习提示 -->
    <div v-if="!curView" style="background:#e7f5ff; border:1px solid #74c0fc; padding:12px; border-radius:8px; font-size:13px">
      💡 <strong>怎么玩</strong>：改查询位置（或直接改文本），点「下一步」——
      先看<strong>后缀数组二分</strong>怎么一步步收窄区间（每步丢一半），再看 <strong>getBestMatch 左右探测</strong>怎么从命中位附近取最长匹配。
      <br><br>❓ <strong>为什么用后缀数组</strong>：朴素搜索每个 newPos 都要扫全 old（O(n×L)）；后缀数组把"所有后缀"排序后，
      最长匹配 = 字典序二分 + 邻位探测（O(log n)），GB 级 old 上这是数量级差距。
    </div>
  </div>
</template>
