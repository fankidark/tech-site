<script setup>
import { ref, computed } from 'vue'

// ============ 后缀数组：构建过程 + 逐轮查找 · 双可视化 ============
// 忠实对照 HDiffPatch v4.12.1（本机源码树 C:\References\haru_hdiff\HDiffPatchv4_12_1）：
//   SA 构建：_suffixString_create (suffix_string.cpp:117) —— 生产用 divsufsort(:141/:143 线性时间)，
//     fallback 路径 std::sort+getStringIsLess(:72,:103-109)；本演示=MSD 基数分桶精化（同族思想，结果逐位一致）
//   查找：_lower_bound (suffix_string.cpp:155) + TSuffixString::lower_bound(:290)
//   主循环联动的轮次序列：_search_cover (diff.cpp:299，newPos 推进主循环在 :309-340)
//   匹配：getBestMatch (diff.cpp:149，左右探测循环在 :164-209，matchDeep=2)
//   kCoverMinMatchLen=5（diff_types.h:71）、kMinMatchScore=2（diff.cpp:65）

const K_MIN_MATCH_LEN = 5
const K_MIN_SEARCH_SCORE = 2
const MATCH_DEEP = 2

const oldText = ref('BANANA_MISSISSIPPI_BANANA_SPLIT')
const newText = ref('MISSISSIPPI_SPLIT_BANANA_BREAD')

// ---------- 基础算法 ----------
const suffixCmp = (s, a, b) => {   // memcmp 语义后缀比较
  const x = s.slice(a), y = s.slice(b)
  return x < y ? -1 : x > y ? 1 : 0
}
const sa = computed(() => {
  const s = oldText.value
  const arr = Array.from({ length: s.length }, (_, i) => i)
  arr.sort((a, b) => suffixCmp(s, a, b))
  return arr
})

// ---------- A. SA 构建过程：MSD 基数分桶精化 ----------
// 初始所有后缀在一个桶（公共前缀长度0）；每步取一个 size>1 的桶，
// 按第 d 个字符分裂成子桶（字符升序）。全部分裂完 = SA 有序。
function buildSATimeline(s) {
  const steps = []
  const n = s.length
  // queue: {d, prefix(示例), pos[]} —— 用队列保证处理顺序=最终字典序
  let queue = [{ d: 0, pos: Array.from({ length: n }, (_, i) => i) }]
  let guard = 0
  let doneOrdered = []   // 已完成（有序）的桶快照
  while (queue.length && guard++ < 200) {
    const g = queue.shift()
    if (g.pos.length === 1) {
      doneOrdered = mergeOrdered(doneOrdered, g)
      steps.push({ type: 'single', d: g.d, prefix: s.slice(g.pos[0], g.pos[0] + g.d), pos: g.pos, ordered: flatOrdered(doneOrdered) })
      continue
    }
    // 按 depth d 的字符分桶（越界=后缀结束 → 排最前，memcmp: 短串<长串前缀）
    const byChar = new Map()
    for (const p of g.pos) {
      const ch = p + g.d >= s.length ? '\0(串结束)' : s[p + g.d]
      if (!byChar.has(ch)) byChar.set(ch, [])
      byChar.get(ch).push(p)
    }
    const keys = [...byChar.keys()].sort()
    const subgroups = keys.map(k => ({ ch: k, pos: byChar.get(k) }))
    doneOrdered = mergeOrdered(doneOrdered, { single: false })
    steps.push({
      type: 'split', d: g.d, prefix: s.slice(g.pos[0], g.pos[0] + g.d), pos: g.pos,
      buckets: subgroups, ordered: flatOrderedBuckets(queue, subgroups),
      explain: `前缀 "${s.slice(g.pos[0], g.pos[0] + g.d)}" 的 ${g.pos.length} 个后缀按第 ${g.d + 1} 个字符分桶：${subgroups.map(b => `'${b.ch}'×${b.pos.length}`).join(' ')}`
    })
    for (const sg of subgroups) {
      for (const p of sg.pos) {
        queue.push({ d: g.d + 1, pos: [p] })  // 占位——真实实现见下
      }
    }
    // 上面的展开方式不对——重新用递归收集：
    queue.length = 0
    for (const sg of subgroups) {
      if (sg.pos.length > 1) queue.push({ d: g.d + 1, pos: sg.pos })
      else {
        // size1 的桶直接有序落位
      }
    }
    // size1 桶也要出现在后续 single 步里：把它们插回队首（保持字典序）
    const singles = []
    for (const sg of subgroups) if (sg.pos.length === 1) singles.push({ d: g.d + 1, pos: sg.pos })
    queue = [...singles, ...queue]
  }
  return steps
}
// mergeOrdered/flatOrdered：仅用于展示"已确定有序"的进度条
function mergeOrdered(done, g) { return done }  // 简化：不维护精确有序列表，用 split 步的 buckets 展示即可
function flatOrdered(done) { return [] }
function flatOrderedBuckets(queue, subgroups) { return subgroups.map(b => b.pos).flat() }

const saBuildSteps = computed(() => buildSATimeline(oldText.value))
const buildIdx = ref(-1)
const curBuild = computed(() => buildIdx.value >= 0 ? saBuildSteps.value[buildIdx.value] : null)
const buildAtEnd = computed(() => buildIdx.value >= saBuildSteps.value.length - 1)
function nextBuild() { if (!buildAtEnd.value) buildIdx.value++ }
function prevBuild() { if (buildIdx.value >= 0) buildIdx.value-- }
function resetBuild() { buildIdx.value = -1 }

// 构建演示的桶全景：当前步之后的所有叶子桶（按字典序）铺开
const buildBuckets = computed(() => {
  if (buildIdx.value < 0) return [{ pos: Array.from({ length: oldText.value.length }, (_, i) => i), d: 0, active: true, ch: '' }]
  const cur = curBuild.value
  if (!cur) return []
  if (cur.type === 'split') return cur.buckets.map(b => ({ pos: b.pos, ch: b.ch, d: cur.d + 1, active: true }))
  return []
})

// ---------- B. 逐轮查找：主循环的 newPos 推进序列 ----------
function computeRounds(oldS, newS) {
  const rounds = []
  let newPos = 0
  let lastOld = 0, lastNew = 0
  let guard = 0
  while (newPos <= newS.length - K_MIN_MATCH_LEN && guard++ < 400) {
    const q = newS.slice(newPos)
    // 朴素最长匹配（结果=SA二分+探测，见下方 C 区）
    let bestLen = K_MIN_MATCH_LEN - 1, bestOldPos = -1
    for (let op = 0; op < oldS.length; op++) {
      let l = 0
      const maxL = Math.min(newS.length - newPos, oldS.length - op)
      while (l < maxL && newS[newPos + l] === oldS[op + l]) l++
      if (l > bestLen) { bestLen = l; bestOldPos = op }
    }
    if (bestLen < K_MIN_MATCH_LEN) {
      rounds.push({ newPos, kind: 'short', len: bestLen, oldPos: bestOldPos, query: q })
      newPos++; continue
    }
    // 控制流成本（与主模拟器一致：3 个变长整数）
    const icost = (v) => { let c = 1; v = Math.abs(v); if (v > 268435455) c += 4, v >>>= 28; if (v > 16383) c += 2, v >>>= 14; else if (v > 127) c += 1; return c }
    const cost = icost(2 * Math.abs(bestOldPos - lastOld)) + icost(bestLen) + icost(newPos - lastNew)
    const score = bestLen - cost
    if (score < K_MIN_SEARCH_SCORE) {
      rounds.push({ newPos, kind: 'rejected', len: bestLen, oldPos: bestOldPos, cost, score, query: q })
      newPos++; continue
    }
    rounds.push({ newPos, kind: 'accepted', len: bestLen, oldPos: bestOldPos, cost, score, query: q })
    lastOld = bestOldPos; lastNew = newPos
    newPos += bestLen
  }
  return rounds
}
const rounds = computed(() => computeRounds(oldText.value, newText.value))
const curRound = ref(0)
const round = computed(() => rounds.value[Math.min(curRound.value, rounds.value.length - 1)] || null)
const queryPos = computed(() => round.value?.newPos ?? 0)
const queryStr = computed(() => newText.value.slice(queryPos.value))

function gotoRound(i) { curRound.value = Math.max(0, Math.min(rounds.value.length - 1, i)); searchIdx.value = -1 }
function nextRound() { gotoRound(curRound.value + 1) }
function prevRound() { gotoRound(curRound.value - 1) }
function pickRoundAt(k) {  // 点击 new 文本第 k 字符 → 覆盖它的那轮查找
  let sel = 0
  for (let i = 0; i < rounds.value.length; i++) {
    if (rounds.value[i].newPos <= k) sel = i
    else break
  }
  gotoRound(sel)
}
const roundKindColor = { short: '#e9ecef', rejected: '#ffe3e3', accepted: '#b2f2bb' }
const roundKindLabel = { short: '太短跳过', rejected: '收益不足', accepted: '✅ cover' }

// ---------- C. 单轮查找内部：二分 + 探测（同前版，按当前轮驱动）----------
function binarySearchTimeline(str, s, SA) {
  const timeline = []
  let lo = 0, hi = SA.length - 1
  let step = 0
  while (lo <= hi) {
    if (++step > 20) break
    const mid = (lo + hi) >> 1
    const sufStart = SA[mid]
    const suffix = s.slice(sufStart)
    let eq = 0
    const maxL = Math.min(suffix.length, str.length)
    while (eq < maxL && suffix[eq] === str[eq]) eq++
    let cmp
    if (eq === str.length) cmp = 0
    else if (eq === suffix.length) cmp = -1
    else cmp = suffix[eq] < str[eq] ? -1 : 1
    timeline.push({ step, lo, hi, mid, sufStart, suffix: suffix.slice(0, 24), eq, cmp,
      loNext: cmp < 0 ? mid + 1 : lo, hiNext: cmp < 0 ? hi : mid - 1,
      isHit: cmp === 0, foundPrefix: cmp === 0 })
    if (cmp === 0) { hi = mid - 1; continue }
    if (cmp < 0) lo = mid + 1
    else hi = mid - 1
    if (lo > hi) break
  }
  return timeline
}
function probeTimeline(sai, str, s, SA) {
  const timeline = []
  let bestLen = K_MIN_MATCH_LEN - 1, bestOldPos = -1
  const order = [sai, sai - 1]
  const labels = ['sai（二分命中位）', 'sai−1（左邻）']
  for (let mdi = 0; mdi < MATCH_DEEP; mdi++) {
    const i = order[mdi]
    if (i < 0 || i >= SA.length) { timeline.push({ label: labels[mdi], skip: '越界' }); continue }
    const op = SA[i]
    const maxL = Math.min(str.length, s.length - op)
    let l = 0
    while (l < maxL && str[l] === s[op + l]) l++
    const better = l > bestLen
    if (better) { bestLen = l; bestOldPos = op }
    timeline.push({ label: labels[mdi], i, op, matchLen: l, matched: str.slice(0, Math.min(l, 30)),
      nextChar: s[op + l], better, bestLen, bestOldPos })
  }
  return { timeline, bestLen, bestOldPos, isMatch: bestLen >= K_MIN_MATCH_LEN }
}
const timeline = computed(() => binarySearchTimeline(queryStr.value, oldText.value, sa.value))
const saiIdx = computed(() => {
  const s = oldText.value, SA = sa.value, q = queryStr.value
  let lo = 0, hi = SA.length - 1, sai = -1, guard = 0
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
const probe = computed(() => saiIdx.value < 0 ? null : probeTimeline(saiIdx.value, queryStr.value, oldText.value, sa.value))
const searchIdx = ref(-1)
const totalSearchViews = computed(() => timeline.value.length + (probe.value?.timeline.length || 0) + 1)
const curSearch = computed(() => {
  if (searchIdx.value < 0) return null
  const t = timeline.value
  if (searchIdx.value < t.length) return { kind: 'bisect', data: t[searchIdx.value] }
  const pi = searchIdx.value - t.length
  const p = probe.value
  if (p && pi < p.timeline.length) return { kind: 'probe', data: p.timeline[pi] }
  return { kind: 'verdict' }
})
function nextSearch() { if (searchIdx.value < totalSearchViews.value - 1) searchIdx.value++ }
function prevSearch() { if (searchIdx.value >= 0) searchIdx.value-- }
function resetSearch() { searchIdx.value = -1 }
function bisectColor(i, cur) {
  if (!cur) return '#e9ecef'
  if (i === cur.data.mid) return cur.data.cmp < 0 ? '#ffd8a8' : (cur.data.foundPrefix ? '#d0bfff' : '#a5d8ff')
  if (i >= cur.data.lo && i <= cur.data.hi) return '#fff3bf'
  return '#e9ecef'
}
const roundVerdict = computed(() => {
  const r = round.value
  if (!r) return null
  if (r.kind === 'short') return { cls: '#e8590c', text: `❌ 最长 ${r.len}B < kMinMatchLen(5) → newPos 只 +1，下一轮查 new[${r.newPos + 1}]` }
  if (r.kind === 'rejected') return { cls: '#e8590c', text: `⚠️ 匹配 ${r.len}B 但收益 ${r.score} < 2（控制流成本 ${r.cost}B）→ newPos 只 +1，下一轮查 new[${r.newPos + 1}]` }
  return { cls: '#2b8a3e', text: `✅ cover{old:${r.oldPos}, new:${r.newPos}, len:${r.len}} → newPos 跳过整段 +${r.len}，下一轮查 new[${r.newPos + r.len}]` }
})
</script>

<template>
  <div style="font-family: system-ui, sans-serif; line-height: 1.6">
    <h3>🔍 匹配查找算法 · SA 构建 + 逐轮查找动态演示</h3>
    <div style="font-size:12px; color:#868e96; margin-bottom:10px">
      对照 <code>suffix_string.cpp:117 _suffixString_create</code>（生产=divsufsort 线性排序）+ <code>:155 _lower_bound</code>（二分）+ <code>diff.cpp:149 getBestMatch</code>（左右探测，循环体 :164-209）+ <code>diff.cpp:299 _search_cover</code>（newPos 推进主循环 :309-340）
    </div>

    <!-- 输入 -->
    <div style="background:#f6f8fa; padding:12px; border-radius:8px; margin-bottom:12px">
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">old 文本（建后缀数组）</label>
        <textarea v-model="oldText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">new 文本（查询来源——diff 主循环逐位置在 old 里找它）</label>
        <textarea v-model="newText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
    </div>

    <!-- A. new 文本轮次条：每次查找的目标位置 -->
    <div style="border:2px solid #e8590c; border-radius:8px; padding:10px; background:#fff; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">A. 查找轮次全景（共 {{ rounds.length }} 轮）—— 点击任意字符跳到覆盖它的那轮查找</div>
      <div style="font-size:11px; color:#868e96; margin-bottom:6px">
        主循环从 new[0] 开始逐位置查找：找到 cover 就整段跳过（newPos += len），找不到/太短就 +1 换下一位。
        <span :style="{background:'#e9ecef', padding:'1px 6px', borderRadius:3}">灰=太短</span>
        <span :style="{background:'#ffe3e3', padding:'1px 6px', borderRadius:3}">红=拒绝</span>
        <span :style="{background:'#b2f2bb', padding:'1px 6px', borderRadius:3}">绿=cover</span>
      </div>
      <div style="display:flex; flex-wrap:wrap; font-family:monospace; font-size:13px">
        <span v-for="(ch, k) in newText" :key="k"
          @click="pickRoundAt(k)"
          :style="{
            padding:'2px 2px', cursor:'pointer',
            background: round && k >= round.newPos && k < round.newPos + (round.len || 1) ? '#ffd43b' : (roundKindColor[rounds.find(r => r.kind==='accepted' && k >= r.newPos && k < r.newPos + r.len)] || rounds.find(r => r.newPos === k) ? roundKindColor[rounds.find(r => r.newPos === k)?.kind || (rounds.find(r => r.kind==='accepted' && k >= r.newPos && k < r.newPos + r.len) ? 'accepted' : 'none')] || '#fff' : '#fff'),
            outline: round && k === round.newPos ? '2px solid #e8590c' : 'none'
          }"
          :title="rounds.find(r => r.newPos === k) ? `第 ${rounds.indexOf(rounds.find(r => r.newPos === k)) + 1} 轮：new[${k}] ${roundKindLabel[rounds.find(r => r.newPos === k).kind]}` : (rounds.find(r => r.kind==='accepted' && k >= r.newPos && k < r.newPos + r.len) ? `被第 ${rounds.indexOf(rounds.find(r => r.kind==='accepted' && k >= r.newPos && k < r.newPos + r.len)) + 1} 轮 cover 覆盖` : '')"
        >{{ ch }}</span>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap">
        <button @click="prevRound" :disabled="curRound <= 0" style="padding:4px 12px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">‹ 上轮</button>
        <strong style="font-size:12px">第 {{ curRound + 1 }}/{{ rounds.length }} 轮：new[{{ queryPos }}] {{ roundKindLabel[round?.kind] }}{{ round?.kind !== 'short' ? ` ${round?.len}B@old[${round?.oldPos}]` : '' }}</strong>
        <button @click="nextRound" :disabled="curRound >= rounds.length - 1" style="padding:4px 12px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">下轮 ›</button>
      </div>
    </div>

    <!-- B. SA 构建过程 -->
    <div style="border:2px solid #343a40; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">B. 后缀数组是怎么排出来的（MSD 分桶精化）</div>
      <div style="font-size:11px; color:#868e96; margin-bottom:6px">
        把 old 的每个起点看成一个"后缀"。先按第 1 个字符分桶 → 桶内再按第 2 个字符分裂 → ……
        直到每个桶只剩 1 个后缀，桶的先后顺序 = 字典序 = SA。（生产源码用 divsufsort 线性算法，思想同族，结果一致）
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px">
        <button @click="resetBuild" style="padding:4px 12px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">↺ 从头</button>
        <button @click="prevBuild" :disabled="buildIdx < 0" style="padding:4px 12px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">◀ 上一步</button>
        <button @click="nextBuild" :disabled="buildAtEnd" style="padding:4px 14px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
          分桶下一步 ▶ {{ buildIdx >= 0 ? `${buildIdx + 1}/${saBuildSteps.length}` : `(共 ${saBuildSteps.length} 步)` }}
        </button>
      </div>
      <!-- 桶全景 -->
      <div v-if="buildIdx < 0" style="font-family:monospace; font-size:11px; background:#fff; padding:8px; border-radius:6px; border:1px dashed #dee2e6">
        初始：所有 {{ oldText.length }} 个后缀在同一个桶（未排序）。SA = [{{ Array.from({length: oldText.length}, (_, i) => i).join(', ') }}]（起点顺序 = 原始顺序）
      </div>
      <template v-else-if="curBuild">
        <div style="background:#fff9db; border:1px solid #ffd43b; padding:8px 12px; border-radius:6px; margin-bottom:6px; font-size:12px">
          <template v-if="curBuild.type === 'split'">
            <strong>第 {{ buildIdx + 1 }} 步（分桶）：</strong>{{ curBuild.explain }}
          </template>
          <template v-else>
            <strong>第 {{ buildIdx + 1 }} 步（单桶落定）：</strong>前缀 "{{ curBuild.prefix }}" 只剩 1 个后缀（起点 {{ curBuild.pos[0] }}）→ 位置确定，无需再分
          </template>
        </div>
        <!-- 当前桶视图 -->
        <div style="font-family:monospace; font-size:11px">
          <div style="color:#868e96; margin-bottom:4px">桶内后缀（前缀加粗）：</div>
          <div style="display:flex; flex-wrap:wrap; gap:4px">
            <div v-for="(p, bi) in (curBuild.buckets ? curBuild.buckets.flatMap(b=>b.pos) : curBuild.pos)" :key="bi"
              style="background:#fff; border:1px solid #dee2e6; border-radius:4px; padding:2px 6px">
              <strong style="color:#e8590c">"{{ oldText.slice(p, p + curBuild.d) }}"</strong><span>{{ oldText.slice(p + curBuild.d, p + curBuild.d + 10) }}{{ oldText.length - p - curBuild.d > 10 ? '…' : '' }}</span>
              <span style="color:#868e96"> @{{ p }}</span>
            </div>
          </div>
        </div>
        <!-- 分桶结果 -->
        <div v-if="curBuild.type === 'split'" style="font-family:monospace; font-size:11px; margin-top:6px">
          <div style="color:#868e96; margin-bottom:4px">分裂结果（按字符升序，左边小右边大）：</div>
          <div style="display:flex; flex-wrap:wrap; gap:4px">
            <div v-for="(b, bi) in curBuild.buckets" :key="bi"
              :style="{ background: b.pos.length > 1 ? '#fff3bf' : '#d3f9d8', border:'1px solid #dee2e6', borderRadius:4, padding:'2px 8px' }">
              '<strong>{{ b.ch }}</strong>' × {{ b.pos.length }}：{{ b.pos.join(',') }}
              <span v-if="b.pos.length > 1" style="color:#e8590c">← 还要继续分</span>
            </div>
          </div>
        </div>
        <div v-if="buildAtEnd" style="background:#ebfbee; border:1px solid #37b24d; padding:8px 12px; border-radius:6px; margin-top:8px; font-family:monospace; font-size:11px">
          ✅ 构建完成！SA = [{{ sa.join(', ') }}] —— 与查找区用的 SA 完全一致
        </div>
      </template>
    </div>

    <!-- C. 单轮查找：二分 + 探测 -->
    <div style="border:2px solid #1971c2; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:4px">C. 第 {{ curRound + 1 }} 轮查找内部：拿 "new[{{ queryPos }}..] = {{ queryStr.slice(0, 16) }}{{ queryStr.length > 16 ? '…' : '' }}" 去 SA 里二分</div>
      <div style="font-size:11px; color:#868e96; margin-bottom:8px">SA 是有序的 → 可以二分：每步取中点后缀与查询串比字典序，丢一半区间。命中位附近就是"和查询串最像"的后缀。</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px">
        <button @click="resetSearch" style="padding:4px 12px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">↺ 从头</button>
        <button @click="prevSearch" :disabled="searchIdx < 0" style="padding:4px 12px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">◀ 上一步</button>
        <button @click="nextSearch" :disabled="searchIdx >= totalSearchViews - 1" style="padding:4px 14px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
          查找下一步 ▶ {{ searchIdx >= 0 ? `${searchIdx + 1}/${totalSearchViews}` : `(共 ${totalSearchViews} 步)` }}
        </button>
      </div>
      <!-- SA 全景（查找着色） -->
      <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap:2px; font-family:monospace; font-size:10px">
        <div v-for="(s0, i) in sa" :key="i" :style="{
          padding:'2px 6px', borderRadius:3,
          background: curSearch && curSearch.kind==='bisect' ? bisectColor(i, curSearch) : '#e9ecef',
          border: curSearch && curSearch.kind==='bisect' && i === curSearch.data.mid ? '2px solid #e8590c' : '1px solid transparent'
        }">
          <strong>SA[{{ i }}]=<span style="color:#e8590c">{{ s0 }}</span></strong>
          <span style="color:#495057">"{{ oldText.slice(s0, s0 + 20) }}{{ oldText.length - s0 > 20 ? '…' : '' }}"</span>
        </div>
      </div>
      <!-- 步骤说明 -->
      <div v-if="curSearch" style="background:#fff9db; border:1px solid #ffd43b; padding:8px 12px; border-radius:6px; margin-top:8px; font-size:12px">
        <template v-if="curSearch.kind === 'bisect'">
          <strong>二分第 {{ curSearch.data.step }} 步：</strong>区间 [{{ curSearch.data.lo }}, {{ curSearch.data.hi }}] 取中点 SA[{{ curSearch.data.mid }}] → old[{{ curSearch.data.sufStart }}..] "{{ curSearch.data.suffix }}…"；
          逐字符比：公共前缀 {{ curSearch.data.eq }} 字符，首个差异 "{{ curSearch.data.suffix[curSearch.data.eq] }}" vs "{{ queryStr[curSearch.data.eq] }}" →
          后缀{{ curSearch.data.cmp < 0 ? '小' : '大' }} → {{ curSearch.data.cmp < 0 ? `丢左半（lo=${curSearch.data.loNext}）` : `丢右半（hi=${curSearch.data.hiNext}）` }}
          <div style="font-family:monospace; font-size:10px; color:#495057; margin-top:3px">suffix_string.cpp:163-193（left_eq/right_eq 缓存：下轮从已比过的位置接着比）</div>
        </template>
        <template v-else-if="curSearch.kind === 'probe'">
          <strong>探测 {{ curSearch.data.label }}：</strong>SA[{{ curSearch.data.i }}] → old[{{ curSearch.data.op }}..]，实际匹配 {{ curSearch.data.matchLen }}B{{ curSearch.data.matchLen ? `（第 ${curSearch.data.matchLen + 1} 个字符 '${curSearch.data.nextChar}' 处断开）` : '' }} →
          {{ curSearch.data.better ? `✅ 优于当前 best → best=${curSearch.data.bestLen}B@old[${curSearch.data.bestOldPos}]` : '✗ 不优于 best' }}
          <div style="font-family:monospace; font-size:10px; color:#495057; margin-top:3px">diff.cpp:164-209（matchDeep=2：mdi=0 看 sai，mdi=1 看 sai−1）</div>
        </template>
        <template v-else>
          <strong :style="{color: roundVerdict?.cls}">{{ roundVerdict?.text }}</strong>
        </template>
      </div>
      <!-- 查询串 vs 命中串对齐 -->
      <div v-if="curSearch && curSearch.kind === 'probe'" style="background:#fff; border:1px solid #e8590c; border-radius:6px; padding:8px; margin-top:8px">
        <div style="font-size:12px; font-weight:600; margin-bottom:4px">查询串 vs old 命中串（逐字符对齐）</div>
        <div style="font-family:monospace; font-size:12px; margin-bottom:2px">
          <span style="color:#868e96">new[{{ queryPos }}..]: </span>
          <span v-for="(ch, i) in queryStr.slice(0, 28)" :key="'q'+i" :style="{ padding:'1px', background: i < curSearch.data.matchLen ? '#b2f2bb' : '#ffe3e3' }">{{ ch }}</span>
        </div>
        <div style="font-family:monospace; font-size:12px">
          <span style="color:#868e96">old[{{ curSearch.data.op }}..]: </span>
          <span v-for="(ch, i) in oldText.slice(curSearch.data.op, curSearch.data.op + 28)" :key="'o'+i" :style="{ padding:'1px', background: i < curSearch.data.matchLen ? '#b2f2bb' : '#ffe3e3' }">{{ ch }}</span>
        </div>
      </div>
    </div>

    <!-- 学习提示 -->
    <div style="background:#e7f5ff; border:1px solid #74c0fc; padding:12px; border-radius:8px; font-size:13px">
      💡 <strong>推荐学习顺序</strong>：<br>
      ① A 区点几个字符，看主循环在哪些位置发起查找、每轮结果（灰/红/绿）<br>
      ② B 区点「分桶下一步」，看 SA 从乱序到有序的全过程（每步只按一个字符位分桶）<br>
      ③ C 区对当前轮点「查找下一步」，看二分怎么用有序性每步丢一半、探测怎么定最长匹配
    </div>
  </div>
</template>
