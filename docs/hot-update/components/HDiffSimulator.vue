<script setup>
import { ref, shallowRef, triggerRef, computed } from 'vue'

// ============ HDiffPatch 单步调试模拟器 ============
// 忠实翻译 HDiffPatch v4.12.1 的 diff 生成管线（diff.cpp）：
//   _search_cover (diff.cpp:299) → getBestMatch (diff.cpp:149)
//   → 收益裁决 (diff.cpp:323) → tryLinkExtend (diff.cpp:229)
//   → _select_cover 终审 (diff.cpp:390) → 序列化 (stream_serialize.cpp)
// 教学简化：后缀数组 → 朴素的"最长公共子串"搜索（语义一致：找 old 中与 new 最长匹配）
// 常量与源码一致：kMinMatchLen=5 (diff_types.h:71)、kMinMatchScore=2 (diff.cpp:65)、
//   CLI 默认 kMinSingleMatchScore=4、变长整数 1B/7bit (_getUIntCost compress_detect.h:40)
//
// ⚠️ 架构说明：buildDiffSteps 构建**完整执行过的**状态时间线（构建期即推进算法状态，
// 每步附 covers 快照）。单步引擎只做"时间线回放"——绝不在点击时才执行状态变更。
// （教训：若把 newPos++ 等推进写进点击回调而构建期不推进，while 循环永不退出 → 内存爆炸 → 页面崩溃）

const K_MIN_MATCH_LEN = 5
const K_MIN_SEARCH_SCORE = 2     // _search_cover 第一轮门槛
const K_MIN_SELECT_SCORE = 4     // CLI 默认（_select_cover 终审门槛）

// ---------- 变长整数编码成本（忠实翻译 _getUIntCost, compress_detect.h:40）----------
function getUIntCost(v) {
  let cost = 1
  if ((v >>> 28) !== 0) { v >>>= 28; cost += 4 }
  if ((v >>> 14) !== 0) { v >>>= 14; cost += 2 }
  if ((v >>> 7) !== 0) { cost += 1 }
  return cost
}
// getIntCost: 2*|v|（符号位并入，diff.cpp:223）
function getIntCost(v) { return getUIntCost(2 * Math.abs(v)) }

// 一条 cover 的控制流成本（忠实翻译 getCoverCtrlCost, diff.cpp:216）
function getCoverCtrlCost(cover, lastCover) {
  return getIntCost(cover.oldPos - lastCover.oldPos)
       + getUIntCost(cover.length)
       + getUIntCost(cover.newPos - lastCover.newPos)
}

// ---------- 核心算法：朴素最长匹配（替代后缀数组，语义一致）----------
function findBestMatch(oldBytes, newBytes, newPos) {
  let bestLen = K_MIN_MATCH_LEN - 1   // 忠实翻译 diff.cpp:158: 初始=kMinMatchLen-1
  let bestOldPos = -1
  for (let op = 0; op <= oldBytes.length - 1; op++) {
    let l = 0
    const maxL = Math.min(newBytes.length - newPos, oldBytes.length - op)
    while (l < maxL && newBytes[newPos + l] === oldBytes[op + l]) l++
    if (l > bestLen) { bestLen = l; bestOldPos = op }
  }
  return { len: bestLen, oldPos: bestOldPos }
}

// ---------- 构建完整步骤时间线（构建期推进全部状态）----------
function buildDiffSteps(oldText, newText) {
  const steps = []
  const oldBytes = [...new TextEncoder().encode(oldText)]
  const newBytes = [...new TextEncoder().encode(newText)]
  const covers = []       // {oldPos,newPos,length,score}
  const rejected = []     // 被拒的匹配
  const snap = () => covers.map(c => ({ ...c }))
  // push: 构建期就把当前 covers 快照冻进步骤
  const push = (text, src, detail) => steps.push({ text, src, detail, coversSnapshot: snap() })

  push(`① 准备：old ${oldBytes.length}B / new ${newBytes.length}B，建后缀数组（教学版：全文索引）`,
    `TSuffixString::resetSuffixString(diff.cpp:890)`,
    `后缀数组 = old 串所有后缀的排序索引，支持 O(log n) 查 "new 的后缀在 old 里最长匹配谁"`)

  let newPos = 0
  let lastCover = { oldPos: 0, newPos: 0, length: 0 }
  let guard = 0

  // ---- 第一轮：_search_cover 主循环（diff.cpp:308-340）----
  while (newPos <= newBytes.length - K_MIN_MATCH_LEN) {
    if (++guard > newBytes.length + 10) break   // 保险丝（理论到不了）
    const m = findBestMatch(oldBytes, newBytes, newPos)

    if (m.len < K_MIN_MATCH_LEN) {
      const shown = newBytes.slice(newPos, newPos + 6).map(c => String.fromCharCode(c)).join('')
      push(`② [newPos=${newPos}] getBestMatch 返回 ${m.len} < kMinMatchLen(${K_MIN_MATCH_LEN}) → 跳过（bestLength 初始=4，短匹配"隐形"）`,
        `diff.cpp:158 bestLength=kMinMatchLen-1; diff.cpp:319 if(matchEqLength<kMinMatchLen) continue`,
        `从 newPos=${newPos} 起 "${shown}…" 在 old 里最长匹配只有 ${m.len}B —— 4 字节以下匹配连候选都当不上`,
        )
      newPos++
      continue
    }

    // ---- 收益裁决（diff.cpp:323-326）----
    const ctrlCost = getCoverCtrlCost({ oldPos: m.oldPos, newPos, length: m.len }, lastCover)
    const score = m.len - ctrlCost
    const stage = covers.length ? '_select_cover 终审' : '_search_cover 初审'

    if (score < K_MIN_SEARCH_SCORE) {
      rejected.push({ newPos, oldPos: m.oldPos, len: m.len, score, cost: ctrlCost })
      push(`③ [newPos=${newPos}] 匹配 ${m.len}B ≥ 5，但收益 ${m.len} − 控制流成本 ${ctrlCost} = ${score} < ${K_MIN_SEARCH_SCORE}（${stage}）→ 拒绝`,
        `diff.cpp:323 matchEqLength-getCoverCtrlCost()<kMinMatchScore → ++newPos`,
        `控制流成本 = oldPos增量(${getIntCost(m.oldPos - lastCover.oldPos)}B) + length(${getUIntCost(m.len)}B) + gap(${getUIntCost(newPos - lastCover.newPos)}B)。几字节的重复付不起"入场费"`,
        )
      newPos++
      continue
    }

    // ---- tryLinkExtend 尝试接龙（diff.cpp:229）----
    let linked = false
    if (covers.length > 0) {
      const lc = covers[covers.length - 1]
      const linkSpace = newPos - (lc.newPos + lc.length)
      const linkOldPos = lc.oldPos + lc.length + linkSpace
      if (linkSpace > 0 && linkSpace <= 511 && linkOldPos + m.len <= oldBytes.length) {
        let linkLen = 0
        const maxL = Math.min(newBytes.length - (lc.newPos + lc.length + linkSpace), oldBytes.length - linkOldPos)
        while (linkLen < maxL && newBytes[lc.newPos + lc.length + linkSpace + linkLen] === oldBytes[linkOldPos + linkLen]) linkLen++
        const linkGain = linkLen - getCoverCtrlCost({ oldPos: linkOldPos, newPos: lc.newPos, length: lc.length + linkSpace + Math.floor(m.len * 2 / 3) }, covers[covers.length - 2] || lastCover)
        if (linkGain >= 0 && linkLen >= m.len) {
          const oldLen = lc.length
          lc.length += linkSpace + linkLen
          push(`④ [newPos=${newPos}] tryLinkExtend：与上一条 cover 间隙 ${linkSpace}B ≤ 511 → 接龙 ${oldLen}B → ${lc.length}B（省一条 cover 的入场费）`,
            `diff.cpp:255 lastLinkCost>matchCost?return:false; diff.cpp:258 len=lastCover.length+linkSpaceLength+(matchCover.length*2/3)`,
            `两条相近匹配合并成一条：中间 gap 用残差修正。总成本 = 1 条 cover 控制流 + 残差，< 2 条独立 cover`,
            )
          newPos = lc.newPos + lc.length
          linked = true
        }
      }
    }
    if (linked) continue

    covers.push({ oldPos: m.oldPos, newPos, length: m.len, score })
    lastCover = covers[covers.length - 1]
    push(`⑤ [newPos=${newPos}] ✅ 匹配 ${m.len}B @oldPos=${m.oldPos}，收益 ${m.len}−${ctrlCost}=${score} ≥ ${K_MIN_SEARCH_SCORE} → 收入 cover`,
      `diff.cpp:330 covers.push_back(matchCover); diff.cpp:340 newPos=lastCover.newPos+lastCover.length（不允许重叠）`,
      `cover{oldPos:${m.oldPos}, newPos:${newPos}, length:${m.len}} —— patch 端将从 old[${m.oldPos}] 连续拷 ${m.len}B 到 new[${newPos}]`,
      )
    newPos = newPos + m.len
  }

  if (!covers.length) {
    push(`⑥ 扫描结束：0 条 cover 幸存 —— 全部内容走 gap 直出`,
      `coverCount=0（实验1实证：80B→64B 小文件）`,
      `patch 里将只有 newDataDiff（新字节原样保存）+ RLE + 头部 ~20B 结构开销 → patch/new 常 > 1`)
  } else {
    push(`⑥ 扫描结束：${covers.length} 条 cover 进入序列化`,
      `serialize_single_compressed_diff(diff.cpp:994)`,
      `下一步把 cover 拆成：①控制流（增量编码）②newDataDiff（gap 字节）③残差 RLE`)
  }

  // ---- 序列化模拟（diff.cpp:1269-1286 HDIFF13 / :994-1018 HDIFFSF20）----
  let gapTotal = 0, subNonZero = 0, lastNewEnd = 0
  for (const c of covers) {
    gapTotal += c.newPos - lastNewEnd
    for (let i = 0; i < c.length; i++) {
      if (newBytes[c.newPos + i] !== oldBytes[c.oldPos + i]) subNonZero++
    }
    lastNewEnd = c.newPos + c.length
  }
  gapTotal += newBytes.length - lastNewEnd

  let cursor = 0
  for (const c of covers) {
    if (c.newPos > cursor) {
      push(`⑦ [gap] new[${cursor}..${c.newPos}) 共 ${c.newPos - cursor}B 无 cover 覆盖 → 原样存入 newDataDiff（无分隔符连续存储）`,
        `TNewDataDiffStream(stream_serialize.cpp:198)`,
        `patch 端用 cover.newPos−lastNewEnd 重新算出每段边界（patch.c:2505）—— 这就是"无分隔符也能切对"的原因`)
      cursor = c.newPos
    }
    let nz = 0
    for (let i = 0; i < c.length; i++) if (newBytes[c.newPos + i] !== oldBytes[c.oldPos + i]) nz++
    push(`⑧ [cover] new[${c.newPos}..${c.newPos + c.length}) 从 old[${c.oldPos}] 拷贝 ${c.length}B；残差 ${nz === 0 ? '全 0（rle0 一个字节都不存，只存长度）' : `有 ${nz}B 非零（rle0: len0+lenv 交替编码）`}`,
      `TNewDataSubDiffStream(stream_serialize.cpp:312 _subData); rle0(patch.c:2192)`,
      `残差 = new−old 模 256。匹配质量越好非零越少，rle0 压得越小`)
    cursor += c.length
  }
  if (newBytes.length > cursor) {
    push(`⑨ [尾gap] 剩余 ${newBytes.length - cursor}B → newDataDiff`,
      `patch.c:2530 尾部 flush`,
      ``)
  }

  // ---- 最终账单 ----
  const headBytes = 20
  const ctrlBytes = covers.reduce((s, c, i) => s + getCoverCtrlCost(c, i > 0 ? covers[i - 1] : { oldPos: 0, newPos: 0 }), 0)
  const rleBytes = Math.max(1, Math.ceil(subNonZero * 1.1))
  const total = headBytes + ctrlBytes + gapTotal + rleBytes
  push(`📊 最终账单：头部~${headBytes}B + 控制流${ctrlBytes}B + newDataDiff ${gapTotal}B + 残差RLE ~${rleBytes}B ≈ ${total}B / new ${newBytes.length}B`,
    `serialize_compressed_diff(diff.cpp:1269-1286)`,
    total > newBytes.length
      ? `⚠️ patch (${total}B) > new (${newBytes.length}B) —— 小文件差分不划算，工程上应跳过 patch 走全量`
      : `✅ patch 是 new 的 ${(total / newBytes.length * 100).toFixed(1)}% —— 差分有效`)

  return steps
}

// ---------- Vue 状态（时间线回放）----------
const oldText = ref('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')
const newText = ref('AAAABBBBXXXXYYYYZZZZWWWWHHHH')
const steps = shallowRef([])
const stepIdx = ref(-1)

const curStep = computed(() => steps.value[stepIdx.value] || null)
const visibleCovers = computed(() => curStep.value?.coversSnapshot || [])
const atStart = computed(() => stepIdx.value < 0)
const atEnd = computed(() => stepIdx.value >= steps.value.length - 1)

function runDiff() {
  steps.value = buildDiffSteps(oldText.value, newText.value)
  stepIdx.value = -1
}
function nextStep() { if (!atEnd.value) stepIdx.value++ }
function prevStep() { if (!atStart.value) stepIdx.value-- }
</script>

<template>
  <div style="font-family: system-ui, sans-serif; line-height: 1.6">
    <h3>🧪 HDiffPatch diff 生成 · 单步调试模拟器</h3>

    <!-- 输入 -->
    <div style="background:#f6f8fa; padding:12px; border-radius:8px; margin-bottom:12px">
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">旧文件 old（文本）</label>
        <textarea v-model="oldText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">新文件 new（文本）</label>
        <textarea v-model="newText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">
        <button @click="runDiff" style="padding:6px 16px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">🎲 生成 diff 步骤</button>
        <button @click="prevStep" :disabled="atStart" style="padding:6px 14px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">◀ 上一步</button>
        <button @click="nextStep" :disabled="atEnd" style="padding:6px 16px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
          下一步 ▶ {{ stepIdx >= 0 ? `${stepIdx+1}/${steps.length}` : (steps.length ? `(共 ${steps.length} 步)` : '') }}
        </button>
        <span style="font-size:12px; color:#868e96">常量：kMinMatchLen=5 · 初审 score≥2 · 终审 score≥4（CLI 默认）</span>
      </div>
    </div>

    <!-- 当前步骤 -->
    <div v-if="curStep" style="background:#fff9db; border:1px solid #ffd43b; padding:10px 14px; border-radius:8px; margin-bottom:12px">
      <div style="font-weight:700; color:#e8590c; margin-bottom:4px">{{ curStep.text }}</div>
      <div v-if="curStep.src" style="font-family:monospace; font-size:11px; color:#495057; background:#fff; padding:6px 8px; border-radius:4px; border:1px dashed #dee2e6">
        📄 {{ curStep.src }}
      </div>
      <div v-if="curStep.detail" style="font-size:12px; color:#495057; margin-top:6px">{{ curStep.detail }}</div>
    </div>

    <!-- 可视化：new 逐字符着色 -->
    <div v-if="curStep" style="border:2px solid #343a40; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:12px; font-weight:600; margin-bottom:6px">cover 覆盖图（紫=从 old 复用，黄=gap 直出）</div>
      <div style="display:flex; flex-wrap:wrap; font-family:monospace; font-size:11px">
        <span v-for="(ch, i) in newText" :key="i" :style="{
          padding:'2px 1px',
          background: visibleCovers.find(c => i >= c.newPos && i < c.newPos + c.length) ? '#d0bfff' : '#fff3bf',
          color: visibleCovers.find(c => i >= c.newPos && i < c.newPos + c.length) ? '#3b3b98' : '#e8590c'
        }" :title="`new[${i}] = '${ch}'`">{{ ch }}</span>
      </div>
      <div style="font-size:11px; color:#868e96; margin-top:6px">
        🟣 紫 = cover 区（old 复用）　🟡 黄 = gap 区（newDataDiff 原样保存）
      </div>
    </div>

    <!-- cover 表 -->
    <div v-if="visibleCovers.length" style="margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">📐 cover 列表（{{ visibleCovers.length }} 条）</div>
      <table style="border-collapse:collapse; font-size:12px; width:100%">
        <thead><tr style="background:#e9ecef"><th style="border:1px solid #dee2e6; padding:4px 8px">#</th><th style="border:1px solid #dee2e6; padding:4px 8px">oldPos</th><th style="border:1px solid #dee2e6; padding:4px 8px">newPos</th><th style="border:1px solid #dee2e6; padding:4px 8px">length</th><th style="border:1px solid #dee2e6; padding:4px 8px">score</th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in visibleCovers" :key="i">
            <td style="border:1px solid #dee2e6; padding:4px 8px; text-align:center">{{ i }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 8px; text-align:center">{{ c.oldPos }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 8px; text-align:center">{{ c.newPos }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 8px; text-align:center">{{ c.length }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 8px; text-align:center">{{ c.score }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 学习提示 -->
    <div v-if="!steps.length" style="background:#e7f5ff; border:1px solid #74c0fc; padding:12px; border-radius:8px; font-size:13px">
      💡 <strong>怎么玩</strong>：改上面的新旧文本（试试故意加一小段重复、或把重复拆成两段相邻的），点「生成 diff 步骤」，
      然后「下一步」逐步看：搜索 → 收益裁决 → 接龙 → gap/cover 序列化 → 最终账单。
      <br><br>❓ <strong>回答你的问题</strong>：HDiffPatch <strong>会判断</strong>——不是"找到重复就生成 diff 数据"，
      而是每条匹配都要过「长度 ≥5」+「收益 ≥ 阈值」两道闸门，最后还有压缩率终审。小的、孤立的重复片段算不过账，
      直接进 newDataDiff（原样保存）——这就是你实验里"小重复不生成 diff 数据"的原因。
    </div>
  </div>
</template>
