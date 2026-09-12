<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// OldNewPatchFlow —— old / new / 残差 / patch 四行字节的「三向对照器」
// ----------------------------------------------------------------------------
// 为什么需要它：讲差分最反直觉的一点是"new 里的某个字节，既可能来自 old 的
// 某个位置，也可能来自 patch 包里的 gap 字节，还可能来自 old+残差"。
// 文字说不清，因为读者在脑子里要同时维护三张表。这里把三行字节并排钉在
// 同一套 newPos 坐标上，鼠标放到哪一列，三行同时亮——一眼看出这一字节的来路。
//
// 默认算例取原文的两个真实例子：
//   ① hdiff-example：old "ABCxxxxxDEFyyyyGHI"(18B) → new "ABC123DEFyyyyZZ"(15B)
//      cover{oldPos:8,newPos:6,length:7}，残差全 0
//   ② 残差版：new "ABC123DEFyyyyxX"(15B)，最后两字节残差非 0
// ============================================================================

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0')
const bytesOf = (s) => [...s].map((c) => c.charCodeAt(0))

// ---------- 两个真实算例 ----------
const CASES = {
  clean: {
    key: 'clean',
    label: '例① 残差全 0（hdiff-example 的原始例子）',
    oldStr: 'ABCxxxxxDEFyyyyGHI',
    newStr: 'ABC123DEFyyyyZZ',
    cover: { oldPos: 8, newPos: 6, length: 7 },
    note: 'covered 区 new[6..13) 与 old[8..15) 逐字节相同 → 残差 7 个 0 → rle0 只花 1 个长度字节',
  },
  residual: {
    key: 'residual',
    label: '例② 残差非 0（cover 末尾变了 2 字节）',
    oldStr: 'ABCxxxxxDEFyyyyGHI',
    newStr: 'ABC123DEFyyyyxX',
    cover: { oldPos: 8, newPos: 6, length: 7 },
    note: 'covered 区最后 2 字节不同 → rle0 编码成 len0=5 + lenv=2，多花 2 个字节但省掉一条新 cover',
  },
}

const caseKey = ref('clean')
const C = computed(() => CASES[caseKey.value])
const oldBytes = computed(() => bytesOf(C.value.oldStr))
const newBytes = computed(() => bytesOf(C.value.newStr))
const cover = computed(() => C.value.cover)

// ---------- 每个 newPos 的"来路" ----------
// kind: 'cover' 从 old 复用（可能带残差） | 'gap' 从 patch 的 newDataDiff 直出
// step: 1 = gap 前缀, 2 = covered 区, 3 = 尾 gap
const cols = computed(() => {
  const c = cover.value
  return newBytes.value.map((b, i) => {
    const inCover = i >= c.newPos && i < c.newPos + c.length
    const oldIdx = inCover ? c.oldPos + (i - c.newPos) : -1
    const oldByte = inCover ? oldBytes.value[oldIdx] : null
    const sub = inCover ? (b - oldByte + 256) % 256 : null
    let step
    if (i < c.newPos) step = 1
    else if (inCover) step = 2
    else step = 3
    return {
      i,
      ch: C.value.newStr[i],
      hexN: hex(b),
      kind: inCover ? 'cover' : 'gap',
      oldIdx,
      oldCh: inCover ? C.value.oldStr[oldIdx] : '',
      oldHex: inCover ? hex(oldByte) : '',
      sub,
      subHex: inCover ? hex(sub) : '',
      step,
    }
  })
})

// ---------- 单步状态（gap 前缀 → covered 区 → 尾 gap）----------
const STEP_DEFS = computed(() => {
  const c = cover.value
  return [
    {
      n: 1,
      title: '① 前缀 gap：从 patch 包里拷',
      text: `cover1.newPos=${c.newPos} > lastNewEnd=0 → 前面有 ${c.newPos} 字节没有 cover 覆盖。`
        + `patch 端算出长度 = cover.newPos − lastNewEnd，从 newDataDiff 连续拷 ${c.newPos} 字节。`,
      src: 'patch.c:2504-2506',
      range: [0, c.newPos],
      from: 'patch 包 newDataDiff',
    },
    {
      n: 2,
      title: '② covered 区：old + 残差',
      text: `读 old[${c.oldPos}..${c.oldPos + c.length}) 到缓存，rle0 残差逐个加上去`
        + `（${c.length} 个残差里非零 ${cols.value.filter((x) => x.kind === 'cover' && x.sub !== 0).length} 个），再写出。`,
      src: 'patch.c:2515 → :2244 _patch_add_old_with_rle0',
      range: [c.newPos, c.newPos + c.length],
      from: 'old 文件 + rle0 码流',
    },
    {
      n: 3,
      title: '③ 尾部 gap：剩下的也要补',
      text: `cover 用完后 newPosBack=${c.newPos + c.length} < newDataSize=${newBytes.value.length}，`
        + `把 newDataDiff 里剩余 ${newBytes.value.length - c.newPos - c.length} 字节补齐，然后 flush 终检。`,
      src: 'patch.c:2530-2535',
      range: [c.newPos + c.length, newBytes.value.length],
      from: 'patch 包 newDataDiff',
    },
  ]
})
const stepIdx = ref(0)
const curStep = computed(() => STEP_DEFS.value[stepIdx.value])
const visibleUpTo = computed(() => curStep.value.range[1])   // 已重建到的 newPos（不含）

// 鼠标十字光标：newPos 下标
const cursor = ref(-1)
const curCol = computed(() => (cursor.value >= 0 ? cols.value[cursor.value] : null))

// ---------- patch 包内容（四行里的第三、四行）----------
// 第三行：残差（subDiff）——只有 covered 区有，长度 = cover 总长
const subDiffBytes = computed(() =>
  cols.value.filter((c) => c.kind === 'cover').map((c) => c.sub),
)
// 第四行：patch 里的两条数据流的实际字节
const newDataDiff = computed(() => cols.value.filter((c) => c.kind === 'gap').map((c) => c.ch).join(''))
const coverCtrl = computed(() => {
  const c = cover.value
  const pack = (v) => {
    const out = []
    do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(hex(b)) } while (v)
    return out
  }
  return [
    { name: 'inc_oldPos（×2 后当无符号写）', hex: pack(2 * (c.oldPos - 0)) },
    { name: 'length', hex: pack(c.length) },
    { name: 'inc_newPos', hex: pack(c.newPos - 0) },
  ]
})
const nzCount = computed(() => subDiffBytes.value.filter((b) => b !== 0).length)

// ---------- 配色 ----------
const KIND_STYLE = {
  cover: { bg: '#d0bfff', fg: '#3b3b98', name: '从 old 复用' },
  gap: { bg: '#fff3bf', fg: '#e8590c', name: '从 patch 拷' },
}
function colStyle(c) {
  const s = KIND_STYLE[c.kind]
  const dim = c.step > curStep.value.n - 1 && c.i >= visibleUpTo.value
  return {
    background: s.bg,
    color: s.fg,
    opacity: dim ? 0.35 : 1,
    outline: cursor.value === c.i ? '2px solid #e8590c' : 'none',
  }
}
</script>

<template>
  <div class="onp">
    <div class="onp-head">
      <strong>🔀 old / new / 残差 / patch 三向对照</strong>
      <span class="onp-sub">同一个 newPos 坐标上四行对齐 —— 鼠标放到任意一列，看这一字节的来路</span>
    </div>

    <div class="onp-tabs">
      <button
        v-for="cs in [CASES.clean, CASES.residual]"
        :key="cs.key"
        class="onp-tab"
        :class="{ on: caseKey === cs.key }"
        @click="caseKey = cs.key; stepIdx = 0; cursor = -1"
      >{{ cs.label }}</button>
    </div>

    <!-- 四行字节 -->
    <div class="onp-grid">
      <!-- 行 0：newDataIndex 标尺 -->
      <div class="onp-rowlabel">newPos</div>
      <div class="onp-row onp-ruler">
        <span v-for="c in cols" :key="'r' + c.i" class="onp-cell onp-idx">{{ c.i }}</span>
        <span v-for="n in (24 - cols.length)" :key="'p' + n" class="onp-cell onp-pad" />
      </div>

      <!-- 行 1：oldData -->
      <div class="onp-rowlabel">old（{{ oldBytes.length }}B）</div>
      <div class="onp-row">
        <span
          v-for="(b, i) in oldBytes" :key="'o' + i"
          class="onp-cell"
          :class="{ used: curCol && curCol.kind === 'cover' && curCol.oldIdx === i, dim: !(curCol && curCol.kind === 'cover' && curCol.oldIdx === i) && curCol }"
        >{{ C.oldStr[i] }}</span>
      </div>

      <!-- 行 2：newData -->
      <div class="onp-rowlabel">
        new（{{ newBytes.length }}B）
        <span class="onp-hint">← 鼠标点这里</span>
      </div>
      <div class="onp-row">
        <span
          v-for="c in cols" :key="'n' + c.i"
          class="onp-cell onp-clickable"
          :style="colStyle(c)"
          @mouseenter="cursor = c.i"
          @mouseleave="cursor = -1"
        >{{ c.ch }}</span>
      </div>

      <!-- 行 3：残差 subDiff -->
      <div class="onp-rowlabel">残差 new−old</div>
      <div class="onp-row">
        <span v-for="c in cols" :key="'s' + c.i" class="onp-cell onp-mono">
          <template v-if="c.kind === 'gap'">—</template>
          <template v-else>
            <span :class="{ 'onp-nz': c.sub !== 0 }">{{ c.sub }}</span>
          </template>
        </span>
      </div>
    </div>

    <!-- 十字光标读数 -->
    <div class="onp-readout">
      <template v-if="curCol">
        <span class="onp-chip" :style="{ background: KIND_STYLE[curCol.kind].bg, color: KIND_STYLE[curCol.kind].fg }">
          new[{{ curCol.i }}] = '{{ curCol.ch }}'（0x{{ curCol.hexN }}）
        </span>
        <span v-if="curCol.kind === 'cover'">
          来自 <b>old[{{ curCol.oldIdx }}]</b> = '{{ curCol.oldCh }}'（0x{{ curCol.oldHex }}）
          ＋ 残差 <b :class="{ 'onp-nz': curCol.sub !== 0 }">{{ curCol.sub }}</b>（0x{{ curCol.subHex }}）→
          (0x{{ curCol.oldHex }} + 0x{{ curCol.subHex }}) mod 256 = 0x{{ curCol.hexN }}
          <span v-if="curCol.sub === 0" class="onp-ok">✔ 残差为 0，这一字节在 patch 里只占"长度"，不占数据</span>
        </span>
        <span v-else>
          来自 <b>patch 包的 newDataDiff</b>（gap 区原样字节）——old 里没有对应位置
        </span>
      </template>
      <span v-else>把鼠标移到 new 那一行的任意字符上</span>
    </div>

    <!-- 单步重放 -->
    <div class="onp-step">
      <div class="onp-stepbar">
        <button class="onp-btn" :disabled="stepIdx === 0" @click="stepIdx--">◀ 上一步</button>
        <strong>{{ curStep.title }}</strong>
        <button class="onp-btn" :disabled="stepIdx >= STEP_DEFS.length - 1" @click="stepIdx++">下一步 ▶</button>
        <span class="onp-mono onp-src">{{ curStep.src }}</span>
      </div>
      <p class="onp-steptext">{{ curStep.text }}</p>
      <div class="onp-bar">
        <div
          v-for="d in STEP_DEFS" :key="d.n"
          class="onp-bar-seg"
          :class="{ on: d.n === curStep.n }"
          :style="{ flex: d.range[1] - d.range[0] }"
          @click="stepIdx = d.n - 1"
        >{{ d.n }}. {{ d.from }}</div>
      </div>
      <div class="onp-progress">
        已重建 <b>{{ visibleUpTo }}</b> / {{ newBytes.length }} 字节
        <div class="onp-track"><div class="onp-track-fill" :style="{ width: (visibleUpTo / newBytes.length * 100) + '%' }" /></div>
      </div>
    </div>

    <!-- patch 包里到底存了什么 -->
    <div class="onp-pack">
      <div class="onp-sub-title">patch 包里实际存了什么</div>
      <table class="onp-tbl">
        <thead><tr><th>数据流</th><th>内容</th><th>本次字节数</th><th>怎么被 patch 端读出来</th></tr></thead>
        <tbody>
          <tr>
            <td class="onp-mono">cover 控制流</td>
            <td class="onp-mono">
              <span v-for="(f, i) in coverCtrl" :key="i">{{ f.hex.join(' ') }}<span class="onp-dim">({{ f.name }})</span> </span>
            </td>
            <td class="onp-mono">{{ coverCtrl.reduce((a, f) => a + f.hex.length, 0) }}B</td>
            <td><code class="onp-code">patch.c:2260 sspatch_covers_nextCover</code> 逐条解码，oldPos 带 1bit 符号 tag</td>
          </tr>
          <tr>
            <td class="onp-mono">残差 rle0</td>
            <td class="onp-mono">
              {{ nzCount === 0
                ? `len0=${cover.length}（一个 packUInt）+ 尾 0`
                : `len0=${subDiffBytes.findIndex(b => b !== 0)} + lenv=${nzCount}` }}
            </td>
            <td class="onp-mono">{{ nzCount === 0 ? 2 : 3 }}B</td>
            <td><code class="onp-code">patch.c:2192 _rle0_decoder_add</code>：先跳 N 个 0，再加 M 个非零</td>
          </tr>
          <tr>
            <td class="onp-mono">newDataDiff</td>
            <td class="onp-mono">"{{ newDataDiff }}"</td>
            <td class="onp-mono">{{ newDataDiff.length }}B</td>
            <td><code class="onp-code">patch.c:2504</code> 用 cover.newPos−lastNewEnd 算长度，流里没有分隔符</td>
          </tr>
        </tbody>
      </table>
      <p class="onp-foot">{{ C.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.onp {
  margin: 18px 0;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
}
.onp-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.onp-sub { font-size: 12px; color: var(--vp-c-text-2); }

.onp-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.onp-tab {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 7px; padding: 5px 10px; font-size: 12.5px; cursor: pointer;
}
.onp-tab.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); font-weight: 600; }

.onp-grid {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 4px 8px;
  align-items: center;
  overflow-x: auto;
}
.onp-rowlabel {
  font-size: 11px; color: var(--vp-c-text-3); text-align: right;
  display: flex; flex-direction: column; align-items: flex-end;
}
.onp-hint { font-size: 10px; color: var(--vp-c-brand-1); }
.onp-row { display: flex; flex-wrap: wrap; gap: 2px; min-width: 0; }
.onp-cell {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  min-width: 17px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  transition: opacity 0.12s;
}
.onp-mono { font-family: var(--vp-font-family-mono); }
.onp-idx { font-size: 9.5px; color: var(--vp-c-text-3); background: none; border: 0; }
.onp-pad { background: none; border: 0; }
.onp-clickable { cursor: pointer; }
.onp-row .used { background: #4c6ef5; color: #fff; border-color: #4c6ef5; }
.onp-row .dim { opacity: 0.45; }
.onp-nz { color: #e03131; font-weight: 700; }
.onp-ok { color: #2b8a3e; }

.onp-readout {
  margin: 10px 0;
  padding: 8px 10px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  font-size: 12.5px;
  line-height: 1.8;
  min-height: 44px;
  color: var(--vp-c-text-2);
}
.onp-chip { padding: 1px 7px; border-radius: 4px; font-family: var(--vp-font-family-mono); margin-right: 6px; }

.onp-step { margin: 10px 0 12px; }
.onp-stepbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.onp-btn {
  border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); color: var(--vp-c-text-1);
  border-radius: 6px; padding: 3px 9px; font-size: 12.5px; cursor: pointer;
}
.onp-btn:disabled { opacity: 0.45; cursor: default; }
.onp-src { font-size: 11px; color: var(--vp-c-text-3); margin-left: auto; }
.onp-steptext { margin: 6px 0; font-size: 12.5px; line-height: 1.75; }
.onp-bar { display: flex; gap: 3px; margin: 6px 0; }
.onp-bar-seg {
  padding: 4px 8px; border-radius: 5px; font-size: 11.5px;
  background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2); cursor: pointer; text-align: center; overflow: hidden; white-space: nowrap;
}
.onp-bar-seg.on { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); font-weight: 600; background: var(--vp-c-bg-soft); }
.onp-progress { font-size: 12px; color: var(--vp-c-text-2); display: flex; align-items: center; gap: 8px; }
.onp-track { flex: 1; height: 6px; background: var(--vp-c-divider); border-radius: 3px; overflow: hidden; }
.onp-track-fill { height: 100%; background: var(--vp-c-brand-1); transition: width 0.15s; }

.onp-pack { margin-top: 12px; }
.onp-sub-title { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.onp-tbl { width: 100%; border-collapse: collapse; font-size: 12px; display: table; }
.onp-tbl th, .onp-tbl td { border: 1px solid var(--vp-c-divider); padding: 3px 7px; text-align: left; vertical-align: top; line-height: 1.6; }
.onp-tbl th { background: var(--vp-c-bg-soft); font-weight: 600; white-space: nowrap; }
.onp-dim { color: var(--vp-c-text-3); font-size: 10px; }
.onp-code { font-size: 11px; }
.onp-foot { font-size: 12px; line-height: 1.75; color: var(--vp-c-text-2); margin: 8px 0 0; }
</style>
