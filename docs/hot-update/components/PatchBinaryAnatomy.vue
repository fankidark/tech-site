<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// PatchBinaryAnatomy —— patch 二进制「逐段解剖 + 十字光标联动」组件
// ----------------------------------------------------------------------------
// 为什么需要它：差分主题里读者最看不见的是"字节"。讲 10 遍"头部是 10 个
// packUInt"，不如把真实字节摊开、鼠标点哪一段就联动高亮哪一段，并同时给出
// "这段字节解出来是什么数、对应源码哪一行"。
//
// 数据是**手工算出来的真实字节**，不是运行时随机生成的：
//   old = "AAAABBBBCCCCDDDD" (16B) / new = "AAAABBBBBBCC" (12B)
//   → 1 条 cover{oldPos:4,newPos:4,length:6}，newDataDiff = "AAAACC"
//   字节全部按 HDiffPatch v4.12.1 的真实编码规则逐字节推演
//   （见页面正文的推演表，可逐字节复核）。
//
// 两种格式并排对照：HDIFF13（classic，4 条独立数据流）与
// HDIFFSF20（single，1 条交织 step 流）——同一个输入，体积差 27B vs 39B。
// ============================================================================

// ---------- 变长整数（hpatch_packUInt：7bit 数据 + MSB 续位，低位在前）----------
function packUInt(v) {
  const out = []
  do {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return out
}
const bytesOf = (s) => [...s].map((c) => c.charCodeAt(0))
const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0')
const hexStr = (arr) => arr.map(hex).join(' ')
function hexRange(arr, start, len) {
  return arr.slice(start, start + len).map(hex).join(' ')
}

// ---------- 真实算例 ----------
const OLD = 'AAAABBBBCCCCDDDD'
const NEW = 'AAAABBBBBBCC'
const COVER = { oldPos: 4, newPos: 4, length: 6 }
const GAP = 'AAAACC'          // new[0..4) + new[10..12)
const OLD_SIZE = OLD.length   // 16
const NEW_SIZE = NEW.length   // 12

// 类型串："HDIFF13" + "&" + ""（无压缩插件）+ "\0"
const TYPE_CLASSIC = [...bytesOf('HDIFF13&'), 0]
// "HDIFFSF20" + "&" + "" + "\0"
const TYPE_SINGLE = [...bytesOf('HDIFFSF20&'), 0]
// compressType 为单个 '\0'（空串）
const COMPRESS_TYPE = [0]

// ---------- HDIFF13：type + 10 个 packUInt + 4 段数据 ----------
// 真实头字段声明顺序（无压缩时压缩尺寸字段 = 0）：
//   newSize, oldSize, coverCount, coverBufSize, compressCoverSize,
//   rleCtrlSize, compressRleCtrlSize, rleCodeSize, compressRleCodeSize, newDataDiffSize
const c13coverBuf = [
  ...packUInt(2 * (COVER.oldPos - 0)),   // oldPos 增量，zigzag ×2（源码 _packUIntWithTag）
  ...packUInt(COVER.length),
  ...packUInt(COVER.newPos - 0),
]
const c13rleCtrl = [...packUInt(COVER.length), ...packUInt(0)]  // "6 个零残差" + 尾标记
const c13rleCode = []
const c13newDataDiff = bytesOf(GAP)
const c13headFields = [
  { name: 'newSize', value: NEW_SIZE },
  { name: 'oldSize', value: OLD_SIZE },
  { name: 'coverCount', value: 1 },
  { name: 'coverBufSize', value: c13coverBuf.length },
  { name: 'compressCoverSize', value: 0 },
  { name: 'rleCtrlSize', value: c13rleCtrl.length },
  { name: 'compressRleCtrlSize', value: 0 },
  { name: 'rleCodeSize', value: c13rleCode.length },
  { name: 'compressRleCodeSize', value: 0 },
  { name: 'newDataDiffSize', value: c13newDataDiff.length },
]
const c13head = c13headFields.flatMap((f) => packUInt(f.value))
const c13bytes = [...TYPE_CLASSIC, ...c13head, ...c13coverBuf, ...c13rleCtrl, ...c13newDataDiff]

// ---------- HDIFFSF20：type + 6 个 packUInt + 1 条交织 step 流 ----------
// patchStepMemSize 被钳到 newSize（diff.cpp:999-1002），所以小文件 stepMemSize=12
// 一个 step 的内部布局（忠实 _flush_step_code，stream_serialize.cpp:679-701）：
//   packUInt(bufCover_size) + packUInt(bufRle_size) + cover 表 + rle 码流，
// 紧接着是这一步要直出的 gap 新字节（step_dataDiff）。
// 注意 rle 段没有自己的"结束标记"——它的边界就是 bufRle_size，
// patch 端把 [covers_cacheEnd, bufRle_cache_end) 整段当作 rle 码流（patch.c:2499）。
const STEP = {
  coverBuf: [...packUInt(c13coverBuf.length), ...packUInt(c13rleCtrl.length), ...c13coverBuf],
  rleBuf: c13rleCtrl,
  newDataDiff: c13newDataDiff,
}
const sfUncompressed = STEP.coverBuf.length + STEP.rleBuf.length + STEP.newDataDiff.length
const sfHeadFields = [
  { name: 'newDataSize', value: NEW_SIZE },
  { name: 'oldDataSize', value: OLD_SIZE },
  { name: 'coverCount', value: 1 },
  { name: 'stepMemSize', value: NEW_SIZE },
  { name: 'uncompressedSize', value: sfUncompressed },
  { name: 'compressedSize', value: sfUncompressed },  // 无压缩插件：压缩尺寸 = 原始尺寸
]
const sfHead = sfHeadFields.flatMap((f) => packUInt(f.value))
const sfbytes = [...TYPE_SINGLE, ...COMPRESS_TYPE, ...sfHead,
                 ...STEP.coverBuf, ...STEP.rleBuf, ...STEP.newDataDiff]

// ---------- 两套「段视图」 ----------
// 每段：{ off, name, color, bytes, kind, note, fields? }
function buildSegments13() {
  let off = 0
  const segs = []
  const push = (name, bytes, color, note, kind) => {
    segs.push({ off, name, bytes, color, note, kind })
    off += bytes.length
  }
  push('类型串', TYPE_CLASSIC, '#ffd8a8',
    '"HDIFF13" + "&" + 压缩类型(空) + "\\0"。patch 端 getSingleCompressedDiffInfo 读它判版本',
    'type')
  push('头部 packUInt ×10', c13head, '#a5d8ff',
    '10 个变长整数，无压缩时 3 个 compress* 字段为 0（占 1 字节但不表示数据量）',
    'head')
  push('covers 控制流', c13coverBuf, '#d0bfff',
    '每条 cover 3 个 packUInt：oldPos 增量(带符号) / length / newPos 增量',
    'cover')
  push('rle_ctrl', c13rleCtrl, '#b2f2bb',
    'rle0 的"零长度串"计数：tell patch 端接下来 N 个字节残差全是 0',
    'rlectrl')
  if (c13rleCode.length) push('rle_code', c13rleCode, '#ffc9c9',
    '非零残差字节。全 0 匹配时这里是空的', 'rlecode')
  push('newDataDiff', c13newDataDiff, '#fff3bf',
    'gap 区新字节原样保存，物理上连续、无分隔符',
    'newdatadiff')
  return segs
}
function buildSegmentsSF() {
  let off = 0
  const segs = []
  const push = (name, bytes, color, note, kind) => {
    segs.push({ off, name, bytes, color, note, kind })
    off += bytes.length
  }
  push('类型串', TYPE_SINGLE, '#ffd8a8',
    '"HDIFFSF20" + "&" + 压缩类型(空) + "\\0"', 'type')
  push('压缩类型串', COMPRESS_TYPE, '#ffe066',
    '空串（单个 \\0）→ patch 端不需要开解压插件', 'ctype')
  push('头部 packUInt ×6', sfHead, '#a5d8ff',
    'newDataSize / oldDataSize / coverCount / stepMemSize / uncompressedSize / compressedSize',
    'head')
  push('step head + cover 表', STEP.coverBuf, '#d0bfff',
    'step 头是两个 packUInt：bufCover_size、bufRle_size；随后紧跟该 step 的 cover 控制流',
    'cover')
  push('step 里的 rle 码流', STEP.rleBuf, '#b2f2bb',
    '和 cover 表共用同一块 step_cache，靠 bufRle_size 切分（patch.c:2485-2499）', 'rlectrl')
  push('step 的 gap 新字节', STEP.newDataDiff, '#fff3bf',
    '紧跟在 step_cache 之后（step_dataDiff），靠 coverCount 与 newSize 收敛', 'newdatadiff')
  return segs
}

const FORMATS = {
  classic: {
    key: 'classic',
    label: 'HDIFF13（classic compressed diff）',
    versionType: 'kHDiffVersionType',
    bytes: c13bytes,
    segments: buildSegments13(),
    headFields: c13headFields,
    serSrc: 'diff.cpp:1269-1286',
    parseSrc: 'patch.c:984 patchByClip → :996-1010',
    streams: 4,
  },
  single: {
    key: 'single',
    label: 'HDIFFSF20（single compressed diff）',
    versionType: 'kHDiffSFVersionType',
    bytes: sfbytes,
    segments: buildSegmentsSF(),
    headFields: sfHeadFields,
    serSrc: 'diff.cpp:994-1018',
    parseSrc: 'patch.c:2111 getSingleCompressedDiffInfo',
    streams: 1,
  },
}

// ---------- 交互状态 ----------
const fmt = ref('classic')
const hoverSeg = ref(-1)
const pickSeg = ref(0)          // 点选的段
const hoverByte = ref(-1)       // 鼠标悬停的具体字节偏移

const cur = computed(() => FORMATS[fmt.value])
const segs = computed(() => cur.value.segments)

const activeSegIdx = computed(() => (hoverSeg.value >= 0 ? hoverSeg.value : pickSeg.value))
const activeSeg = computed(() => segs.value[activeSegIdx.value] || null)

// 段内字节 → 逐字节 ASCII/十进制小表（选中的段才展开）
const byteRows = computed(() => {
  const s = activeSeg.value
  if (!s) return []
  return s.bytes.map((b, i) => ({
    off: s.off + i,
    hex: hex(b),
    dec: b,
    ascii: b >= 32 && b < 127 ? String.fromCharCode(b) : '·',
  }))
})

// 每条 cover 3 个 packUInt 的逐字段推演（点 covers 段时显示）
const coverFields = computed(() => [
  {
    name: 'inc_oldPos',
    raw: 2 * (COVER.oldPos - 0),
    bytes: hexStr(packUInt(2 * (COVER.oldPos - 0))),
    note: `oldPos 相对上一条 cover 的 oldEnd 的增量。源码用 packWithTag(...,tag,1) 编符号位，`
      + `生成侧把它 ×2 后当无符号数写（2×${COVER.oldPos}=${2 * COVER.oldPos}）`,
  },
  {
    name: 'length',
    raw: COVER.length,
    bytes: hexStr(packUInt(COVER.length)),
    note: '复用长度，无符号变长整数',
  },
  {
    name: 'inc_newPos',
    raw: COVER.newPos - 0,
    bytes: hexStr(packUInt(COVER.newPos - 0)),
    note: '相对上一条 cover 的 newEnd 的间隙，恒 ≥ 0，所以不需要符号位',
  },
])

const totalLen = computed(() => cur.value.bytes.length)

function segAt(off) {
  return segs.value.findIndex((s) => off >= s.off && off < s.off + s.bytes.length)
}
function onByteEnter(off) {
  hoverByte.value = off
  const i = segAt(off)
  if (i >= 0) hoverSeg.value = i
}
function onByteLeave() {
  hoverByte.value = -1
  hoverSeg.value = -1
}
function selectSeg(i) {
  pickSeg.value = i
  hoverSeg.value = -1
}
// 每字节一个格子的"字节带"：用 flex 权重按段长分配，鼠标可逐字节定位
const band = computed(() =>
  segs.value.map((s, i) => ({
    i,
    seg: s,
    flex: s.bytes.length,
    items: s.bytes.map((b, k) => ({ off: s.off + k, hex: hex(b) })),
  })),
)
function bandStyle(i) {
  const on = activeSegIdx.value === i
  return {
    background: segs.value[i].color,
    opacity: activeSegIdx.value >= 0 && !on ? 0.35 : 1,
    boxShadow: on ? 'inset 0 0 0 2px #e8590c' : 'none',
  }
}

// 同一输入换格式的账单（逐段算清楚差在哪）
const compare = computed(() => [
  {
    k: '类型串 + 头',
    v13: TYPE_CLASSIC.length + c13head.length,
    vsf: TYPE_SINGLE.length + COMPRESS_TYPE.length + sfHead.length,
    why: '13 头 10 个 packUInt，SF 头 6 个 + 1 个压缩类型串',
  },
  {
    k: 'step 头 + cover 表',
    v13: c13coverBuf.length,
    vsf: STEP.coverBuf.length,
    why: 'SF 每个 step 都要多带 bufCover_size / bufRle_size 两个 packUInt',
  },
  {
    k: 'rle 码流',
    v13: c13rleCtrl.length + c13rleCode.length,
    vsf: STEP.rleBuf.length,
    why: '同样内容，SF 与 cover 共用 step_cache 但字节数不变',
  },
  {
    k: 'gap 新字节',
    v13: c13newDataDiff.length,
    vsf: STEP.newDataDiff.length,
    why: '两种格式都必须原样保存，谁也省不掉',
  },
])
const sum13 = computed(() => compare.value.reduce((a, r) => a + r.v13, 0))
const sumSF = computed(() => compare.value.reduce((a, r) => a + r.vsf, 0))
</script>

<template>
  <div class="pba">
    <div class="pba-head">
      <strong>🧬 patch 二进制逐段解剖</strong>
      <span class="pba-sub">
        真实算例：old <code>{{ OLD }}</code>（{{ OLD_SIZE }}B）→ new <code>{{ NEW }}</code>（{{ NEW_SIZE }}B），
        1 条 cover，字节逐条推演得出
      </span>
    </div>

    <!-- 格式切换 -->
    <div class="pba-tabs">
      <button
        v-for="f in [FORMATS.classic, FORMATS.single]"
        :key="f.key"
        class="pba-tab"
        :class="{ on: fmt === f.key }"
        @click="fmt = f.key; pickSeg = 0"
      >{{ f.label }}　<span class="pba-len">{{ f.bytes.length }}B</span></button>
    </div>

    <!-- 字节带：点段 / 逐字节悬停 -->
    <div class="pba-band">
      <div v-for="b in band" :key="b.i" class="pba-band-seg" :style="bandStyle(b.i)" @click="selectSeg(b.i)">
        <div class="pba-band-label">{{ b.seg.name }}</div>
        <div class="pba-band-bytes">
          <span
            v-for="it in b.items"
            :key="it.off"
            class="pba-byte"
            :class="{ hot: hoverByte === it.off }"
            @mouseenter="onByteEnter(it.off)"
            @mouseleave="onByteLeave"
          >{{ it.hex }}</span>
        </div>
      </div>
    </div>
    <div class="pba-axis">
      <span>偏移 0</span>
      <span>共 {{ totalLen }} 字节</span>
      <span v-if="hoverByte >= 0">光标停在偏移 <strong>{{ hoverByte }}</strong>（属于「{{ segs[segAt(hoverByte)]?.name }}」）</span>
      <span v-else>点任意段看细节，或把鼠标移到某个字节上</span>
    </div>

    <!-- 选中段详情 -->
    <div v-if="activeSeg" class="pba-detail">
      <div class="pba-detail-head">
        <span class="pba-chip" :style="{ background: activeSeg.color }">{{ activeSeg.name }}</span>
        <span class="pba-mono">偏移 {{ activeSeg.off }} · 长度 {{ activeSeg.bytes.length }}B</span>
      </div>
      <p class="pba-note">{{ activeSeg.note }}</p>

      <table class="pba-tbl">
        <thead><tr><th>偏移</th><th>hex</th><th>十进制</th><th>字符</th></tr></thead>
        <tbody>
          <tr v-for="r in byteRows" :key="r.off" :class="{ hot: hoverByte === r.off }"
              @mouseenter="hoverByte = r.off" @mouseleave="hoverByte = -1">
            <td class="pba-mono">{{ r.off }}</td>
            <td class="pba-mono">{{ r.hex }}</td>
            <td class="pba-mono">{{ r.dec }}</td>
            <td class="pba-mono">{{ r.ascii }}</td>
          </tr>
        </tbody>
      </table>

      <!-- covers 段：3 个 packUInt 逐字段 -->
      <div v-if="activeSeg.kind === 'cover'" class="pba-sub-block">
        <div class="pba-sub-title">这段为什么是 {{ activeSeg.bytes.length }} 字节：3 个变长整数逐条推演</div>
        <table class="pba-tbl">
          <thead><tr><th>字段</th><th>原值</th><th>编码字节</th><th>怎么读</th></tr></thead>
          <tbody>
            <tr v-for="f in coverFields" :key="f.name">
              <td class="pba-mono">{{ f.name }}</td>
              <td class="pba-mono">{{ f.raw }}</td>
              <td class="pba-mono">{{ f.bytes }}</td>
              <td>{{ f.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 头部段：字段表 -->
      <div v-if="activeSeg.kind === 'head'" class="pba-sub-block">
        <div class="pba-sub-title">
          头部字段逐个对照（{{ cur.headFields.length }} 个 packUInt，共 {{ activeSeg.bytes.length }} 字节）
        </div>
        <table class="pba-tbl">
          <thead><tr><th>字段</th><th>值</th><th>编码字节</th><th>它让 patch 端能做什么</th></tr></thead>
          <tbody>
            <tr v-for="f in cur.headFields" :key="f.name">
              <td class="pba-mono">{{ f.name }}</td>
              <td class="pba-mono">{{ f.value }}</td>
              <td class="pba-mono">{{ hexStr(packUInt(f.value)) }}</td>
              <td>{{ f.name.startsWith('compress')
                ? '无压缩插件时固定 0；有插件时是"该段压缩后多大"，patch 端据此切段'
                : '让 patch 端不必读完整包就能算出各段起点（流式处理的前提）' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 两种格式账单 -->
    <div class="pba-sub-block">
      <div class="pba-sub-title">同一个输入，两种格式的字节账单</div>
      <table class="pba-tbl">
        <thead>
          <tr><th>部段</th><th>HDIFF13</th><th>HDIFFSF20</th><th>差在哪</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in compare" :key="r.k">
            <td>{{ r.k }}</td>
            <td class="pba-mono">{{ r.v13 }}B</td>
            <td class="pba-mono">{{ r.vsf }}B</td>
            <td>{{ r.why }}</td>
          </tr>
          <tr class="pba-total">
            <td><b>合计</b></td>
            <td class="pba-mono"><b>{{ sum13 }}B</b></td>
            <td class="pba-mono"><b>{{ sumSF }}B</b></td>
            <td>new 只有 {{ NEW_SIZE }}B —— 两种格式都"不划算"，这正是小文件别差分的原因</td>
          </tr>
        </tbody>
      </table>
      <p class="pba-foot">
        序列化侧：<code>{{ cur.serSrc }}</code>；解析侧：<code>{{ cur.parseSrc }}</code>。
        HDIFF13 把数据拆成 <b>{{ FORMATS.classic.streams }}</b> 条独立流（各自压缩 → patch 端要同时开同样多个解压句柄）；
        HDIFFSF20 只留 <b>{{ FORMATS.single.streams }}</b> 条交织的 step 流（patch 端 1 个句柄 + step_cache 循环）。
        这正是"小文件 classic 更省、大文件 single 更省"的结构性原因。
      </p>
    </div>
  </div>
</template>

<style scoped>
.pba {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
}
.pba-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.pba-sub { font-size: 12px; color: var(--vp-c-text-2); }
.pba-sub code, .pba-foot code { font-size: 11.5px; }

.pba-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.pba-tab {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 7px;
  padding: 5px 10px;
  font-size: 12.5px;
  cursor: pointer;
}
.pba-tab.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); font-weight: 600; }
.pba-len { color: var(--vp-c-text-3); font-size: 11px; }

.pba-band {
  display: flex;
  align-items: stretch;
  min-height: 58px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-bg);
}
.pba-band-seg {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 3px;
  border-right: 1px solid rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: opacity 0.15s;
  overflow: hidden;
}
.pba-band-seg:last-child { border-right: 0; }
.pba-band-label {
  font-size: 10px;
  font-weight: 600;
  color: #212529;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pba-band-bytes { display: flex; flex-wrap: wrap; gap: 1px; }
.pba-byte {
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
  color: #212529;
  background: rgba(255, 255, 255, 0.55);
  border-radius: 2px;
  padding: 0 2px;
}
.pba-byte.hot { background: #e8590c; color: #fff; }

.pba-axis {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--vp-c-text-3);
  margin: 5px 0 10px;
}

.pba-detail {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--vp-c-bg);
  margin-bottom: 12px;
}
.pba-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.pba-chip { padding: 1px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; color: #212529; }
.pba-note { margin: 0 0 8px; font-size: 12.5px; line-height: 1.7; color: var(--vp-c-text-2); }

.pba-sub-block { margin-top: 12px; }
.pba-sub-title { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }

.pba-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  display: table;
  margin-bottom: 6px;
}
.pba-tbl th, .pba-tbl td {
  border: 1px solid var(--vp-c-divider);
  padding: 3px 7px;
  text-align: left;
  vertical-align: top;
  line-height: 1.6;
}
.pba-tbl th { background: var(--vp-c-bg-soft); font-weight: 600; white-space: nowrap; }
.pba-tbl tr.hot td { background: rgba(232, 89, 12, 0.12); }
.pba-total td { background: var(--vp-c-bg-soft); }
.pba-mono { font-family: var(--vp-font-family-mono); white-space: nowrap; }
.pba-foot { font-size: 12px; line-height: 1.75; color: var(--vp-c-text-2); margin: 8px 0 0; }
</style>
