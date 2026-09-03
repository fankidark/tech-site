<script setup>
import { ref, shallowRef, triggerRef, computed } from 'vue'

// ============ HDiffPatch 单步调试模拟器（diff 生成 + patch 应用 双模式）============
// 忠实翻译 HDiffPatch v4.12.1：
//   diff 侧（diff.cpp）：_search_cover(:299) → getBestMatch(:149) → 收益裁决(:323)
//     → tryLinkExtend(:229) → _select_cover 终审(:390) → serialize(:1269-1286)
//   patch 侧（patch.c）：getSingleCompressedDiffInfo(:2111) → step loop(:2471)
//     → copyFromClip(:2505) → _patch_add_old_with_rle0(:2244) → flush+finish(:2534-2542)
//   二进制格式（HDIFF13，diff.cpp:1269-1286 序列化 / patch.c:2136-2146 反序列化）
//
// ⚠️ 架构（教训：构建期推进全部状态，点击只做时间线回放。act/回调里推进=死循环 OOM）

const K_MIN_MATCH_LEN = 5
const K_MIN_SEARCH_SCORE = 2
const K_MIN_SELECT_SCORE = 4

// ---------- 变长整数（7bit continue 编码，与源码 packUInt 一致）----------
function packUInt(v) {          // 返回字节数组（教学版：小端 7bit，低位在前）
  const out = []
  do {
    let b = v & 0x7F
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return out
}
function getUIntCost(v) { return packUInt(v).length }
function getIntCost(v) { return getUIntCost(2 * Math.abs(v)) }
function getCoverCtrlCost(cover, lastCover) {
  return getIntCost(cover.oldPos - lastCover.oldPos)
       + getUIntCost(cover.length)
       + getUIntCost(cover.newPos - lastCover.newPos)
}
function findBestMatch(oldBytes, newBytes, newPos) {
  let bestLen = K_MIN_MATCH_LEN - 1
  let bestOldPos = -1
  for (let op = 0; op <= oldBytes.length - 1; op++) {
    let l = 0
    const maxL = Math.min(newBytes.length - newPos, oldBytes.length - op)
    while (l < maxL && newBytes[newPos + l] === oldBytes[op + l]) l++
    if (l > bestLen) { bestLen = l; bestOldPos = op }
  }
  return { len: bestLen, oldPos: bestOldPos }
}
const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0')
const byteHex = (bytes) => bytes.map(hex).join(' ')

// ---------- patch 二进制构建（HDIFF13 无压缩版，忠实 diff.cpp:1269-1286）----------
function buildPatchBinary(oldBytes, newBytes, covers) {
  // 类型串 "HDIFF13&" + compressType("") + '\0'
  const typeStr = [...new TextEncoder().encode('HDIFF13&' + '\0')]
  // covers 控制流（增量编码：oldPos 增量 / length / newPos 增量，diff.cpp:1287 TCoversStream）
  const coverBuf = []
  let lastOld = 0, lastNew = 0
  for (const c of covers) {
    coverBuf.push(...packUInt(2 * (c.oldPos - lastOld)))   // signed→zigzag 思路（源码 _packUIntWithTag diff.cpp:1292+）
    coverBuf.push(...packUInt(c.length))
    coverBuf.push(...packUInt(c.newPos - lastNew))
    lastOld = c.oldPos; lastNew = c.newPos
  }
  // newDataDiff：gap 字节原样（无分隔符）
  const newDataDiff = []
  let lastNewEnd = 0
  for (const c of covers) {
    for (let i = lastNewEnd; i < c.newPos; i++) newDataDiff.push(newBytes[i])
    lastNewEnd = c.newPos + c.length
  }
  for (let i = lastNewEnd; i < newBytes.length; i++) newDataDiff.push(newBytes[i])
  // 残差 RLE（教学简化：真实 rle0 只存非零段；这里按"len0:coverLen + 非零字节"编码）
  const rleCtrl = [], rleCode = []
  lastNewEnd = 0
  for (const c of covers) {
    const zeros = []   // cover 区残差非零
    for (let i = 0; i < c.length; i++) {
      const sub = (newBytes[c.newPos + i] - oldBytes[c.oldPos + i]) & 0xFF
      if (sub !== 0) zeros.push(sub)
    }
    // rle0 编码：先 0+长度（表示后面 length 个字节都是 0 = 复用 old），非零则 1+数据
    rleCtrl.push(...packUInt(c.length))       // len0：连续 0 的个数（新增数据长度）
    for (const s of zeros) { rleCtrl.push(...packUInt(0)); rleCode.push(s) }  // lenv 非零段
    lastNewEnd = c.newPos + c.length
  }
  // 尾 gap 区残差 = new 本身（gap 已在 newDataDiff，这里残差流只需覆盖 cover 区+0 长度结尾）
  rleCtrl.push(...packUInt(newBytes.length - (covers.length ? covers[covers.length - 1].newPos + covers[covers.length - 1].length : 0)))

  const head = [...typeStr]
  for (const v of [newBytes.length, oldBytes.length, covers.length, coverBuf.length, 0, rleCtrl.length, 0, rleCode.length, 0, newDataDiff.length]) {
    head.push(...packUInt(v))
  }
  // 布局: [type][head packUInts][coverBuf][rleCtrl][rleCode][newDataDiff]
  //  (真实 HDIFF13 顺序: covers, rle_ctrl, rle_code, newDataDiff；compress 字段在无压缩时=0)
  return {
    bytes: [...head, ...coverBuf, ...rleCtrl, ...rleCode, ...newDataDiff],
    layout: {
      typeStr, head: head.slice(typeStr.length), coverBuf, rleCtrl, rleCode, newDataDiff,
      headFields: [
        { name: 'newSize', value: newBytes.length },
        { name: 'oldSize', value: oldBytes.length },
        { name: 'coverCount', value: covers.length },
        { name: 'coverBufSize', value: coverBuf.length },
        { name: 'compressCoverSize', value: 0 },
        { name: 'rleCtrlSize', value: rleCtrl.length },
        { name: 'compressRleCtrlSize', value: 0 },
        { name: 'rleCodeSize', value: rleCode.length },
        { name: 'compressRleCodeSize', value: 0 },
        { name: 'newDataDiffSize', value: newDataDiff.length },
      ],
    },
  }
}

// ---------- diff 生成时间线（同 v1，新增 patchBytes 结果）----------
function buildDiffSteps(oldText, newText) {
  const steps = []
  const oldBytes = [...new TextEncoder().encode(oldText)]
  const newBytes = [...new TextEncoder().encode(newText)]
  const covers = []
  const snap = () => covers.map(c => ({ ...c }))
  const push = (text, src, detail) => steps.push({ text, src, detail, coversSnapshot: snap() })

  push(`① 准备：old ${oldBytes.length}B / new ${newBytes.length}B，建后缀数组（教学版：全文索引）`,
    `TSuffixString::resetSuffixString(diff.cpp:890)`,
    `后缀数组 = old 所有后缀的排序索引，O(log n) 查最长匹配`)

  let newPos = 0
  let lastCover = { oldPos: 0, newPos: 0, length: 0 }
  let guard = 0
  while (newPos <= newBytes.length - K_MIN_MATCH_LEN) {
    if (++guard > newBytes.length + 10) break
    const m = findBestMatch(oldBytes, newBytes, newPos)
    if (m.len < K_MIN_MATCH_LEN) {
      const shown = newBytes.slice(newPos, newPos + 6).map(c => String.fromCharCode(c)).join('')
      push(`② [newPos=${newPos}] getBestMatch 返回 ${m.len} < kMinMatchLen(${K_MIN_MATCH_LEN}) → 跳过（短匹配"隐形"）`,
        `diff.cpp:158 bestLength=kMinMatchLen-1; diff.cpp:319 if(matchEqLength<kMinMatchLen) continue`,
        `从 newPos=${newPos} 起 "${shown}…" 最长匹配 ${m.len}B < 5`)
      newPos++; continue
    }
    const ctrlCost = getCoverCtrlCost({ oldPos: m.oldPos, newPos, length: m.len }, lastCover)
    const score = m.len - ctrlCost
    const stage = covers.length ? '_select_cover 终审' : '_search_cover 初审'
    if (score < K_MIN_SEARCH_SCORE) {
      push(`③ [newPos=${newPos}] 匹配 ${m.len}B ≥ 5，但收益 ${m.len} − 控制流成本 ${ctrlCost} = ${score} < ${K_MIN_SEARCH_SCORE}（${stage}）→ 拒绝`,
        `diff.cpp:323 matchEqLength-getCoverCtrlCost()<kMinMatchScore → ++newPos`,
        `控制流成本 = oldPos增量(${getIntCost(m.oldPos - lastCover.oldPos)}B) + length(${getUIntCost(m.len)}B) + gap(${getUIntCost(newPos - lastCover.newPos)}B)`)
      newPos++; continue
    }
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
          push(`④ [newPos=${newPos}] tryLinkExtend：与上一条 cover 间隙 ${linkSpace}B ≤ 511 → 接龙 ${oldLen}B → ${lc.length}B（省一条 cover 入场费）`,
            `diff.cpp:255 lastLinkCost>matchCost?return:false; diff.cpp:258 len=lastCover.length+linkSpaceLength+(matchCover.length*2/3)`,
            `两条相近匹配合并：中间 gap 用残差修正，总成本 < 2 条独立 cover`)
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
      `cover{oldPos:${m.oldPos}, newPos:${newPos}, length:${m.len}}`)
    newPos += m.len
  }

  push(covers.length
    ? `⑥ 扫描结束：${covers.length} 条 cover 进入序列化`
    : `⑥ 扫描结束：0 条 cover —— 全部内容走 gap 直出`,
    covers.length ? `serialize_single_compressed_diff(diff.cpp:994)` : `coverCount=0（实验1实证）`,
    covers.length ? `把 cover 拆成：①控制流 ②newDataDiff ③残差 RLE` : `patch 只有 newDataDiff + 头部`)

  // ---- 序列化：逐段写入 patch 二进制（真实布局）----
  const pb = buildPatchBinary(oldBytes, newBytes, covers)
  let cursor = 0
  for (const c of covers) {
    if (c.newPos > cursor) {
      push(`⑦ [gap] new[${cursor}..${c.newPos}) 共 ${c.newPos - cursor}B → newDataDiff（无分隔符连续存储）`,
        `TNewDataDiffStream(stream_serialize.cpp:198)`,
        `patch 端靠 cover.newPos−lastNewEnd 重新算边界（patch.c:2505）`)
      cursor = c.newPos
    }
    let nz = 0
    for (let i = 0; i < c.length; i++) if (newBytes[c.newPos + i] !== oldBytes[c.oldPos + i]) nz++
    push(`⑧ [cover] new[${c.newPos}..${c.newPos + c.length}) ← old[${c.oldPos}] 拷贝 ${c.length}B；残差 ${nz === 0 ? '全 0（rle0 只存长度不存数据）' : `${nz}B 非零（rle0 交替编码）`}`,
      `TNewDataSubDiffStream(stream_serialize.cpp:312); rle0(patch.c:2192)`,
      `残差 = new−old 模 256`)
    cursor += c.length
  }
  if (newBytes.length > cursor) {
    push(`⑨ [尾gap] 剩余 ${newBytes.length - cursor}B → newDataDiff`, `patch.c:2530 尾部 flush`, ``)
  }

  // ---- 二进制布局步骤（每段一步，高亮对应字节）----
  const L = pb.layout
  push(`🔒 写类型串 "HDIFF13&\\0"（${L.typeStr.length}B）`,
    `_outType(diff.cpp:636)`,
    `patch 端读它判断格式版本与压缩插件（patch.c:2111 getSingleCompressedDiffInfo 第一步）`)
  push(`🔢 写头部 packUInt ×10（${L.head.length}B）：${L.headFields.map(f => `${f.name}=${f.value}`).join(' ')}`,
    `serialize_compressed_diff(diff.cpp:1279-1289)`,
    `每个数用 7bit 变长编码（≤127 → 1 字节）。patch 端按同序反解（patch.c:2136-2146）`)
  if (L.coverBuf.length) {
    push(`📐 写 covers 控制流（${L.coverBuf.length}B）：每条 cover 3 个 packUInt（oldPos增量·length·gap）`,
      `TCoversStream(diff.cpp:1292+)`,
      `oldPos 是相对上一条 cover 的增量 → cover 越挨着越省`)
  }
  if (L.rleCtrl.length) {
    push(`📦 写残差 rle_ctrl（${L.rleCtrl.length}B）+ rle_code（${L.rleCode.length}B）`,
      `bytesRLE_save(diff.cpp:1271)`,
      `ctrl 是"0 长度串"计数，code 是非零残差字节 —— 全 0 匹配时 code 流为空`)
  }
  push(`💾 写 newDataDiff（${L.newDataDiff.length}B）：${covers.length ? 'gap 字节原样' : '整个新文件'}`,
    `TNewDataDiffStream(stream_serialize.cpp:198)`,
    `无分隔符——切分边界由 cover 表推导`)
  push(`📊 patch 完成：共 ${pb.bytes.length}B（new 的 ${(pb.bytes.length / newBytes.length * 100).toFixed(1)}%）${pb.bytes.length > newBytes.length ? ' ⚠️ 不划算，工程上应走全量' : ' ✅ 差分有效'}`,
    `diff.cpp 全流程结束`,
    `下一步切到「▶ patch 应用」模式，看 hpatchz 怎么用 old + 这个 patch 重建 new`)

  return { steps, patch: pb }
}

// ---------- patch 应用时间线（patch.c step loop）----------
function buildPatchSteps(oldText, patchBytes) {
  const steps = []
  const oldBytes = [...new TextEncoder().encode(oldText)]
  const out = []            // 重建中的 new
  const snap = () => [...out]
  const push = (text, src, detail) => steps.push({ text, src, detail, outSnapshot: snap() })

  let p = 0
  const readUInt = () => {
    let v = 0, shift = 0
    while (true) {
      const b = patchBytes[p++]
      v |= (b & 0x7F) << shift; shift += 7
      if (!(b & 0x80)) return v
    }
  }
  const readStr = () => { const s = []; while (patchBytes[p] !== 0 && p < patchBytes.length) s.push(patchBytes[p++]); p++; return s }

  push(`① 读类型串 "${String.fromCharCode(...readStrAt(0))}" → 识别 HDIFF13 格式、无压缩插件`,
    `getSingleCompressedDiffInfo(patch.c:2111)`,
    `hpatchz 先校验自己支持这个格式（对应 libhpatchz.so 里编入的解压插件）`)
  function readStrAt(off) { const s = []; let i = off; while (patchBytes[i] !== 0 && i < patchBytes.length) s.push(patchBytes[i++]); return s }

  // 头部 10 字段
  p = 8   // "HDIFF13&" = 8 字节 + '\0' = 9？ 实际 "HDIFF13&" 后跟 compressType 串（空）+ '\0'
  const typeEnd = (() => { let i = 0; while (patchBytes[i] !== 0) i++; return i + 1 })()
  p = typeEnd
  const H = {}
  for (const name of ['newSize','oldSize','coverCount','coverBufSize','compressCoverSize','rleCtrlSize','compressRleCtrlSize','rleCodeSize','compressRleCodeSize','newDataDiffSize']) {
    H[name] = readUInt()
  }
  push(`② 反解头部 10 个 packUInt：newSize=${H.newSize} oldSize=${H.oldSize} coverCount=${H.coverCount} coverBuf=${H.coverBufSize} rleCtrl=${H.rleCtrlSize} rleCode=${H.rleCodeSize} newDataDiff=${H.newDataDiffSize}`,
    `patch.c:2136-2146`,
    `这些大小让 patch 端能一次 seek 到任意段——流式处理的关键`)
  push(`③ 安全校验：newSize/oldSize 不超限、coverCount 合理、各段 size 之和 = patch 大小`,
    `patch.c:2147-2156（__RUN_MEM_SAFE_CHECK）`,
    `防恶意 patch 声明超大 size 导致内存 DoS（见安全篇）`)

  // 解析 covers
  const covers = []
  let q = typeEnd + (patchBytes.length - typeEnd) // placeholder
  // 实际偏移：头部后依次 coverBuf, rleCtrl, rleCode, newDataDiff
  let coverCur = p
  let lastOld = 0, lastNew = 0
  for (let i = 0; i < H.coverCount; i++) {
    const oldPosDelta = readUIntAt(coverCur); coverCur += uintLenAt(coverCur)
    const length = readUIntAt(coverCur); coverCur += uintLenAt(coverCur)
    const newGap = readUIntAt(coverCur); coverCur += uintLenAt(coverCur)
    // 源码 zigzag: oldPosDelta = 2*delta → delta = oldPosDelta/2（偶=正向）
    const oldPos = lastOld + oldPosDelta / 2
    const newPos = lastNew + newGap
    covers.push({ oldPos, newPos, length })
    lastOld = oldPos; lastNew = newPos
  }
  function readUIntAt(off) { let v = 0, shift = 0; while (true) { const b = patchBytes[off++]; v |= (b & 0x7F) << shift; shift += 7; if (!(b & 0x80)) return v } }
  function uintLenAt(off) { let n = 0; while (true) { if (!(patchBytes[off + n] & 0x80)) return n + 1; n++ } }

  push(`④ 解码 covers 控制流（${covers.length} 条）：oldPos增量/length/gap → 绝对坐标`,
    `sspatch_covers_nextCover(patch.c:2508)`,
    covers.map((c, i) => `cover[${i}]: oldPos=${c.oldPos} newPos=${c.newPos} len=${c.length}`).join('；'))

  // step loop（patch.c:2471）
  let coverIdx = 0
  let lastNewEnd = 0
  let coverCursor = 0
  // newDataDiff 读指针：位于 rleCode 之后
  const ndStart = typeEnd + H.coverBufSize + H.rleCtrlSize + H.rleCodeSize
  let ndPos = ndStart
  // rle 流读指针
  const rleCtrlStart = typeEnd + H.coverBufSize
  const rleCodeStart = rleCtrlStart + H.rleCtrlSize
  let rc = rleCtrlStart, rd = rleCodeStart
  const readRleCtrl = () => { const v = readUIntAt(rc); rc += uintLenAt(rc); return v }
  const readRleCode = () => patchBytes[rd++]

  let guard = 0
  while (coverIdx < H.coverCount || lastNewEnd < H.newSize) {
    if (++guard > H.newSize + 10) break
    if (coverIdx < H.coverCount) {
      const c = covers[coverIdx]
      if (c.newPos > lastNewEnd) {
        const gapLen = c.newPos - lastNewEnd
        for (let i = 0; i < gapLen; i++) out.push(patchBytes[ndPos++])
        push(`⑤ [gap] new[${lastNewEnd}..${c.newPos}) 无 cover 覆盖 → 从 newDataDiff 连续拷 ${gapLen}B（"copyFromClip"）`,
          `patch.c:2505 _TOutStreamCache_copyFromClip`,
          `patch 端自己算出这段长度 = cover.newPos − lastNewEnd， newDataDiff 里没有边界信息`)
      }
      // rle0: 读 len0（0 长度个数），再按需读非零
      const len0 = readRleCtrl()
      const coverOut = []
      let zeros = len0
      // rle0 解码（patch.c:2192 _rle0_decoder_add）：len0>0 表示接下来 len0 字节 = old 原样 + 0
      // 教学简化：rle_ctrl 里 [coverLen, 0,0,...,len0尾] 交替；这里按构建器同构解码
      let take = c.length
      while (take > 0) {
        const zeroRun = (coverIdx === 0 && zeros === c.length) ? zeros : readRleCtrl()
        zeros = 0
        const run = Math.min(zeroRun, take)
        for (let i = 0; i < run; i++) { out.push(oldBytes[c.oldPos + (coverOut.length)]); coverOut.push(oldBytes[c.oldPos + coverOut.length]) }
        take -= run
        if (take === 0) break
        const nzLen = readRleCtrl()
        for (let i = 0; i < nzLen; i++) { out.push((oldBytes[c.oldPos + coverOut.length] + readRleCode()) & 0xFF); coverOut.push(0) }
        take -= nzLen
      }
      push(`⑥ [cover] new[${c.newPos}..${c.newPos + c.length}) ← old[${c.oldPos}] 连续 ${c.length}B + 残差修正（"残差加法"）`,
        `patch.c:2529 _patch_add_old_with_rle0 → _rle0_decoder_add(patch.c:2192)`,
        `out[i] = (old[i] + subDiff[i]) mod 256。匹配质量好 → 残差几乎全 0 → rle0 只花几个长度字节`)
      lastNewEnd = c.newPos + c.length
      coverIdx++
    } else {
      const remain = H.newSize - lastNewEnd
      for (let i = 0; i < remain; i++) out.push(patchBytes[ndPos++])
      push(`⑦ [尾gap] 剩余 ${remain}B ← newDataDiff`, `patch.c:2530`, ``)
      lastNewEnd = H.newSize
    }
  }

  push(`⑧ flush 输出 + 终检（inClip 消费完 && outCache 写完 && coverCount==0）→ 成功`,
    `patch.c:2534-2542`,
    `重建结果应与原 new 逐字节一致（可 SHA1 校验——项目里 FilesCheck 就是干这个的）`)
  return steps
}

// ---------- Vue 状态 ----------
const mode = ref('diff')            // 'diff' | 'patch'
const oldText = ref('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')
const newText = ref('AAAABBBBXXXXYYYYZZZZWWWWHHHH')
const diffSteps = shallowRef([])
const patchSteps = shallowRef([])
const patchBin = shallowRef(null)   // {bytes, layout}
const diffIdx = ref(-1)
const patchIdx = ref(-1)

const steps = computed(() => mode.value === 'diff' ? diffSteps.value : patchSteps.value)
const stepIdx = computed({ get: () => mode.value === 'diff' ? diffIdx.value : patchIdx.value, set: (v) => { if (mode.value === 'diff') diffIdx.value = v; else patchIdx.value = v } })
const curStep = computed(() => steps.value[stepIdx.value] || null)
const visibleCovers = computed(() => mode.value === 'diff' ? (curStep.value?.coversSnapshot || []) : [])
const visibleOut = computed(() => mode.value === 'patch' ? (curStep.value?.outSnapshot || null) : null)
const atStart = computed(() => stepIdx.value < 0)
const atEnd = computed(() => stepIdx.value >= steps.value.length - 1)
const byteRows = computed(() => {
  if (!patchBin.value) return []
  const L = patchBin.value.layout
  const rows = []
  let off = 0
  const seg = (name, bytes, color, note) => { if (bytes.length) { rows.push({ off, len: bytes.length, hex: byteHex(bytes.slice(0, 32)), color, note, name }); off += bytes.length } }
  seg('类型串', L.typeStr, '#ffd8a8', '"HDIFF13&"+压缩类型+"\\0"')
  seg('头部 packUInt×10', L.head, '#a5d8ff', 'newSize/oldSize/coverCount/各段size（7bit变长）')
  seg('covers 控制流', L.coverBuf, '#d0bfff', '每条 cover: oldPos增量/length/gap')
  seg('rle_ctrl', L.rleCtrl, '#b2f2bb', '0 长度串计数')
  seg('rle_code', L.rleCode, '#ffc9c9', '非零残差字节')
  seg('newDataDiff', L.newDataDiff, '#fff3bf', 'gap 字节原样（无分隔符）')
  return rows
})

function runDiff() {
  const r = buildDiffSteps(oldText.value, newText.value)
  diffSteps.value = r.steps
  patchBin.value = r.patch
  diffIdx.value = -1
  if (mode.value === 'patch') { mode.value = 'diff' }
}
function runPatch() {
  if (!patchBin.value) { runDiff() }
  patchSteps.value = buildPatchSteps(oldText.value, patchBin.value.bytes)
  patchIdx.value = -1
  mode.value = 'patch'
}
function nextStep() { if (!atEnd.value) stepIdx.value++ }
function prevStep() { if (!atStart.value) stepIdx.value-- }
function resetAll() {
  diffSteps.value = []; patchSteps.value = []; patchBin.value = null
  diffIdx.value = -1; patchIdx.value = -1
  oldText.value = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'
  newText.value = 'AAAABBBBXXXXYYYYZZZZWWWWHHHH'
  mode.value = 'diff'
}
</script>

<template>
  <div style="font-family: system-ui, sans-serif; line-height: 1.6">
    <h3>🧪 HDiffPatch 单步调试模拟器（diff 生成 ⇄ patch 应用）</h3>

    <!-- 输入 -->
    <div style="background:#f6f8fa; padding:12px; border-radius:8px; margin-bottom:12px">
      <div style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">旧文件 old（文本）</label>
        <textarea v-model="oldText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div v-if="mode==='diff'" style="margin-bottom:8px">
        <label style="font-size:13px; font-weight:600">新文件 new（文本）</label>
        <textarea v-model="newText" rows="2" style="width:100%; font-family:monospace; font-size:12px; padding:6px; border:1px solid #ced4da; border-radius:4px"></textarea>
      </div>
      <div v-else style="font-size:12px; color:#868e96; margin-bottom:8px">
        patch 应用模式：用上面的 old + 下面生成的 patch 二进制 → 重建 new（数据来自 diff 模式的生成结果）
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">
        <button @click="runDiff" style="padding:6px 16px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">🎲 生成 diff 步骤</button>
        <button @click="runPatch" :disabled="!patchBin" style="padding:6px 16px; background:#37b24d; color:#fff; border:none; border-radius:6px; cursor:pointer" :title="patchBin ? '' : '先在 diff 模式生成一次'">▶ patch 应用步骤</button>
        <button @click="prevStep" :disabled="atStart" style="padding:6px 14px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">◀ 上一步</button>
        <button @click="nextStep" :disabled="atEnd || !steps.length" style="padding:6px 16px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
          下一步 ▶ {{ stepIdx >= 0 ? `${stepIdx+1}/${steps.length}` : (steps.length ? `(共 ${steps.length} 步)` : '') }}
        </button>
        <button @click="resetAll" style="padding:6px 12px; background:#e03131; color:#fff; border:none; border-radius:6px; cursor:pointer">🔄 重置</button>
        <span style="font-size:12px; color:#868e96">模式：<strong>{{ mode==='diff' ? 'diff 生成' : 'patch 应用' }}</strong></span>
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

    <!-- diff 模式可视化 -->
    <div v-if="mode==='diff' && curStep" style="border:2px solid #343a40; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:12px; font-weight:600; margin-bottom:6px">cover 覆盖图（紫=从 old 复用，黄=gap 直出）</div>
      <div style="display:flex; flex-wrap:wrap; font-family:monospace; font-size:11px">
        <span v-for="(ch, i) in newText" :key="i" :style="{
          padding:'2px 1px',
          background: visibleCovers.find(c => i >= c.newPos && i < c.newPos + c.length) ? '#d0bfff' : '#fff3bf',
          color: visibleCovers.find(c => i >= c.newPos && i < c.newPos + c.length) ? '#3b3b98' : '#e8590c'
        }" :title="`new[${i}]`">{{ ch }}</span>
      </div>
    </div>

    <!-- patch 模式可视化：重建中的 new -->
    <div v-if="mode==='patch' && curStep && visibleOut" style="border:2px solid #37b24d; border-radius:8px; padding:10px; background:#f8f9fa; margin-bottom:12px">
      <div style="font-size:12px; font-weight:600; margin-bottom:6px">重建中的 new（已写出 {{ visibleOut.length }}/{{ patchBin?.bytes ? '' : '' }}B）</div>
      <div style="display:flex; flex-wrap:wrap; font-family:monospace; font-size:11px">
        <span v-for="(ch, i) in newText" :key="i" :style="{
          padding:'2px 1px',
          background: i < visibleOut.length ? '#b2f2bb' : '#e9ecef',
          color: i < visibleOut.length ? '#2b8a3e' : '#adb5bd'
        }" :title="`new[${i}]`">{{ ch }}</span>
      </div>
      <div style="font-size:11px; color:#868e96; margin-top:6px">🟢 绿 = 已重建　⚪ 灰 = 还没写到</div>
    </div>

    <!-- patch 二进制结构 -->
    <div v-if="mode==='diff' && patchBin && stepIdx >= 0" style="margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">🧬 patch 二进制结构（{{ patchBin.bytes.length }}B）— 点开每段看字节</div>
      <table style="border-collapse:collapse; font-size:11px; width:100%">
        <thead><tr style="background:#e9ecef"><th style="border:1px solid #dee2e6; padding:4px 6px">偏移</th><th style="border:1px solid #dee2e6; padding:4px 6px">段</th><th style="border:1px solid #dee2e6; padding:4px 6px">长度</th><th style="border:1px solid #dee2e6; padding:4px 6px">字节（hex）</th><th style="border:1px solid #dee2e6; padding:4px 6px">说明</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in byteRows" :key="i">
            <td style="border:1px solid #dee2e6; padding:4px 6px; text-align:center; font-family:monospace">{{ r.off }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 6px"><span :style="{background:r.color, padding:'1px 6px', borderRadius:3}">{{ r.name }}</span></td>
            <td style="border:1px solid #dee2e6; padding:4px 6px; text-align:center">{{ r.len }}</td>
            <td style="border:1px solid #dee2e6; padding:4px 6px; font-family:monospace; word-break:break-all">{{ r.hex }}<span v-if="r.len > 32"> …</span></td>
            <td style="border:1px solid #dee2e6; padding:4px 6px; color:#495057">{{ r.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- cover 表（diff 模式）-->
    <div v-if="mode==='diff' && visibleCovers.length" style="margin-bottom:12px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">📐 cover 列表（{{ visibleCovers.length }} 条）</div>
      <table style="border-collapse:collapse; font-size:12px">
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
      💡 <strong>学习路线</strong>：<br>
      ① 「🎲 生成 diff 步骤」→ 下一步逐步看 <strong>diff 怎么决定哪些重复值得存</strong>（搜索→裁决→接龙→序列化→二进制结构表）<br>
      ② 看完序列化后切「▶ patch 应用步骤」→ 看同一份 patch 二进制怎么被 <strong>hpatchz 一步步重建出 new</strong>（读头→解码 cover→gap 拷贝→残差加法→flush）<br>
      ③ 改文本再跑一遍：试试 4 字节重复（隐形）、5 字节（卡门槛）、相邻两段重复（接龙）
    </div>
  </div>
</template>
