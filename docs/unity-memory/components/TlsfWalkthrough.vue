<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// TlsfWalkthrough —— TLSF 分配全过程单步演示
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\External\Allocator\tlsf\tlsf.c
//   每一步的 src.line 都是该文件里真实存在的行（改版后由 scripts/verify_srcrefs.py 兜底校验）。
//
// 尺寸口径（32 位，源码里的分支）：
//   ALIGN_SIZE              = 8    tlsf.c:224（32 位走 ALIGN_SIZE_LOG2 = 2）
//   SL_INDEX_COUNT_LOG2     = 5    tlsf.c:211
//   SL_INDEX_COUNT          = 32   tlsf.c:246
//   FL_INDEX_SHIFT          = 7    tlsf.c:247（= 5 + 2）
//   SMALL_BLOCK_SIZE        = 256  tlsf.c:250（≥256 才走两级位图）
//   block_header_overhead   = 4    tlsf.c:328（sizeof(size_t)）
//   sizeof(block_header_t)  = 24   → block_size_min = 20? 不：见 :339-340 的说明
//
// 场景（每一笔都为了让某个判据"刚好踩在临界点上"）：
//   1KB 池 → 分配 400B → 分配 400B → 分配 120B → 再申请 88B（触发"不敢切"分支）
//
// 架构：所有快照一次性算好，播放器只做时间线回放。
// 在 watch/回调里推进状态机会递归死循环，别改。
// ============================================================================

const HEAP = 1024
const OVERHEAD = 4 // block_header_overhead：size 字段寄生在前一块尾部
const HDR = 24 // sizeof(block_header_t)（32 位：4 + 4 + 8 + 8）
const ALIGN = 8
const SMALL = 256

const fls = (v) => {
  let n = 0
  while (v > 1) {
    v >>= 1
    n++
  }
  return n
}

// mapping_insert（tlsf.c:508-525）的 32 位口径
function mappingInsert(size) {
  if (size < SMALL) return { fl: 0, sl: Math.floor(size / 8) }
  const fl0 = fls(size)
  const sl = (size >> (fl0 - 5)) ^ 32
  return { fl: fl0 - 6, sl }
}

// mapping_search（tlsf.c:528-536）：先向上取整到二级粒度，再落到桶
function mappingSearch(size) {
  let s = size
  let round = 0
  if (s >= SMALL) {
    round = (1 << (fls(s) - 5)) - 1
    s += round
  }
  return { search: s, round, ...mappingInsert(s) }
}

// adjust_request_size：对齐 + 不小于最小块
function adjustRequest(size) {
  let v = Math.ceil(size / ALIGN) * ALIGN
  if (v < HDR) v = HDR
  return v
}

// block_can_split（tlsf.c:636-639）
const canSplit = (blockSize, size) => blockSize >= HDR + size

// ---------- 一次性算出全部步骤 ----------
function buildSteps() {
  const steps = []
  let pool = [{ off: 0, size: HEAP, used: false }]
  const snap = () => pool.map((b) => ({ ...b }))
  const push = (o) => steps.push({ ...o, pool: snap() })

  push({
    title: '起点：1KB 的空池',
    text:
      '池子里只有一个空闲块。要特别提醒：块的 size 字段（4 字节）并不额外占地方，它寄生在前一个块的尾部——源码注释里那句"prev_phys_block is stored inside the previous free block"讲的就是这个设计。',
    src: {
      file: 'tlsf.c',
      line: 326,
      excerpt: '** The prev_phys_block field is stored *inside* the previous free block.',
    },
    viz: { phase: 'init' },
  })

  const requests = [400, 400, 120, 88]
  let n = 0

  for (const req of requests) {
    n++
    const adjust = adjustRequest(req)
    const m = mappingSearch(adjust)

    // ① 对齐
    push({
      title: `第 ${n} 笔请求：${req} 字节`,
      text:
        adjust === req
          ? `${req} 已经是 ${ALIGN} 的整数倍，adjust_request_size 原样返回 ${adjust}。源码里这一行是 tlsf_malloc 的第一步。`
          : `请求 ${req} 字节 → 向上对齐到 ${ALIGN} 的整数倍 = ${adjust} 字节。多出来的 ${adjust - req} 字节不是浪费，是对齐的硬要求：所有块的起始地址都必须是 ${ALIGN} 的倍数。`,
      src: {
        file: 'tlsf.c',
        line: 1103,
        excerpt: 'const size_t adjust = adjust_request_size(size, ALIGN_SIZE);',
        note: `ALIGN_SIZE 在 32 位配置下是 8（tlsf.c:224）`,
      },
      viz: { phase: 'adjust', req, adjust },
    })

    // ② 向上取整到档位
    push({
      title:
        m.round > 0
          ? `向上取整到档位：${adjust} → ${m.search}`
          : `小尺寸不取整：${adjust} < ${SMALL}，直接进第 0 级链表`,
      text:
        m.round > 0
          ? `mapping_search 会把尺寸向上取到二级链表的粒度。这里 fls(${adjust}) = ${fls(adjust)}，粒度 = 2^${fls(adjust) - 5} = ${1 << (fls(adjust) - 5)} 字节，于是补到 ${m.search}。宁可拿稍大的块，也不漏掉刚好能用的块。`
          : `${SMALL} 字节以下的块不做两级划分（再分下去每格不足 8 字节，没意义），全部塞进第 0 级链表，用"尺寸 ÷ 8"直接定位桶号。源码里那个 if 就是在区分这两种情况。`,
      src: {
        file: 'tlsf.c',
        line: m.round > 0 ? 532 : 511,
        excerpt:
          m.round > 0
            ? 'const size_t round = (1 << (tlsf_fls_sizet(size) - SL_INDEX_COUNT_LOG2)) - 1;'
            : 'if (size < SMALL_BLOCK_SIZE)\n{\n    /* Store small blocks in first list. */\n    fl = 0;\n    sl = tlsf_cast(int, size) / (SMALL_BLOCK_SIZE / SL_INDEX_COUNT);\n}',
      },
      viz: { phase: 'search', adjust, search: m.search, round: m.round },
    })

    // ③ 算桶号
    push({
      title: `算落到哪个桶：fl = ${m.fl}，sl = ${m.sl}`,
      text:
        m.fl === 0
          ? `落进第 0 级链表的第 ${m.sl} 个桶。第 0 级的桶是按 ${SMALL} / 32 = 8 字节一格的细粒度划分。`
          : `先按 2 的幂分大档（fl = ${m.fl}），再在大档内等分 32 小格（sl = ${m.sl}）。这样 ${'<' + SMALL} 的尺寸空间被压成"大档 + 小格"两层索引，查一次桶号只需要几条位运算。`,
      src: {
        file: 'tlsf.c',
        line: 519,
        excerpt:
          'fl = tlsf_fls_sizet(size);\nsl = tlsf_cast(int, size >> (fl - SL_INDEX_COUNT_LOG2)) ^ (1 << SL_INDEX_COUNT_LOG2);\nfl -= (FL_INDEX_SHIFT - 1);',
        note: 'mapping_insert 的两级分桶（tlsf.c:519-521）',
      },
      viz: { phase: 'map', search: m.search, fl: m.fl, sl: m.sl },
    })

    // ④ 找块：同档位优先，否则向更大档位借
    const freeBlocks = pool.filter((b) => !b.used)
    const exact = freeBlocks
      .filter((b) => {
        const bm = mappingInsert(b.size)
        return bm.fl === m.fl && bm.sl >= m.sl
      })
      .sort((a, b) => a.size - b.size)[0]
    const bigger = freeBlocks.filter((b) => b.size >= m.search).sort((a, b) => a.size - b.size)
    const chosen = exact || bigger[0]
    const borrowed = !exact && !!bigger[0]

    push({
      title: exact ? '本档命中：直接取链表头' : borrowed ? '本档为空 → 向更大的档位借' : '池子已经装不下了',
      text: exact
        ? `sl_bitmap[${m.fl}] 里从第 ${m.sl} 位往上还有 1，说明这一档有可用空闲块，直接取该链表头节点——一次位运算加一次取指针，这就是 TLSF 敢说自己查找是 O(1) 的原因。`
        : borrowed
          ? `sl_map = sl_bitmap[${m.fl}] & (~0 << ${m.sl}) 全是 0，本档及更高小格都没块。于是改看 fl_bitmap 里比 ${m.fl} 更大的大档——"分割适应"里"适应"的那一步：不要求尺寸刚好，只要够大就拿来用。`
          : `两级位图全空，申请失败返回空指针。真实实现里 DynamicHeapAllocator 还会再往上层要内存（多 Pool 扩展），见 DynamicHeapAllocator 一篇。`,
      src: {
        file: 'tlsf.c',
        line: 547,
        excerpt:
          'unsigned int sl_map = control->sl_bitmap[fl] & (~0U << sl);\nif (!sl_map)\n{\n    /* No block exists. Search in the next largest first-level list. */\n    const unsigned int fl_map = control->fl_bitmap & (~0U << (fl + 1));',
        note: 'search_suitable_block：先本档、再更高档（tlsf.c:547-558）',
      },
      viz: {
        phase: 'locate',
        search: m.search,
        fl: m.fl,
        sl: m.sl,
        borrowed,
        foundOff: chosen ? chosen.off : null,
      },
    })

    if (!chosen) break

    // ⑤ 切还是整块给
    const split = canSplit(chosen.size, adjust)
    const remain = chosen.size - (adjust + OVERHEAD)
    const take = split ? adjust : chosen.size

    push({
      title: split ? '块够大 → 切一刀，剩余还回空闲链表' : '切完剩余块养不活自己 → 整块给出去',
      text: split
        ? `判据：block_size(${chosen.size}) >= sizeof(block_header_t) + ${adjust} = ${HDR + adjust}，成立。切出 ${remain} 字节的剩余块重新归入空闲链表，不浪费。`
        : `判据：block_size(${chosen.size}) >= ${HDR} + ${adjust} = ${HDR + adjust}，不成立——切完剩下的 ${remain} 字节连自己的块头都放不下（块头要 ${HDR} 字节）。TLSF 的选择是整块给出去，宁可产生 ${chosen.size - adjust} 字节内部碎片，也不留一个无法管理的小块。这就是"内部碎片"在真实分配器里的来源。`,
      src: {
        file: 'tlsf.c',
        line: 638,
        excerpt: 'return block_size(block) >= sizeof(block_header_t) + size;',
        note: 'block_can_split（tlsf.c:636-639）；被 block_trim_free 在 :708 调用',
      },
      viz: {
        phase: 'split',
        foundOff: chosen.off,
        chosenSize: chosen.size,
        take,
        remain,
        split,
      },
    })

    // 提交池状态
    pool = pool.flatMap((b) => {
      if (b.off !== chosen.off) return [b]
      if (!split) return [{ ...b, used: true }]
      return [
        { off: b.off, size: take, used: true },
        { off: b.off + take + OVERHEAD, size: remain, used: false },
      ]
    })

    push({
      title: `第 ${n} 笔完成，用户拿到 ${take} 字节`,
      text:
        `用户指针指向 size 字段之后（block_start_offset = offsetof(size) + sizeof(size_t)，tlsf.c:331-332）。` +
        (split
          ? `被占用的块从空闲链表摘除，位图对应位清零。`
          : `这次实际给了 ${take} 字节，比申请的 ${req} 多 ${take - req} 字节——这部分空间既没给用户，也没法给别人，只能等这块被释放才能回收。`) +
        `池子剩余可用 ${pool.filter((b) => !b.used).reduce((s, b) => s + b.size, 0)} 字节。`,
      src: {
        file: 'tlsf.c',
        line: 776,
        excerpt: 'p = block_to_ptr(block);',
        note: 'block_prepare_used 的最后一步（tlsf.c:768-779）',
      },
      viz: { phase: 'done', take },
    })
  }

  return steps
}

const steps = buildSteps()
const cur = ref(0)
const curStep = computed(() => steps[cur.value])
const v = computed(() => curStep.value.viz || {})

// 把逻辑块翻译成"含块头"的物理布局，交给 MemoryMap 画
const blocks = computed(() => {
  const p = curStep.value.pool
  const out = [
    {
      label: '前哨',
      size: OVERHEAD,
      kind: 'meta',
      note: '池起始处前面没有块，这 4 字节是首块 size 字段的位置',
    },
  ]
  p.forEach((b, i) => {
    out.push({
      label: b.used ? `占用 ${b.size}B` : `空闲 ${b.size}B`,
      size: b.size,
      kind: b.used ? 'used' : 'free',
      note: `池内偏移 ${b.off}`,
    })
    if (i < p.length - 1) {
      out.push({ label: '块头', size: OVERHEAD, kind: 'meta', note: '下一块的 size 字段' })
    }
  })
  return out
})

// fl_bitmap：哪些大档上挂着空闲块（真实值由池内空闲块反推）
const flBits = computed(() => {
  const on = new Set()
  curStep.value.pool.forEach((b) => {
    if (!b.used) on.add(mappingInsert(b.size).fl)
  })
  return [...Array(16)].map((_, i) => ({ i, on: on.has(i) }))
})

const freeTotal = computed(() =>
  curStep.value.pool.filter((b) => !b.used).reduce((s, b) => s + b.size, 0)
)
</script>

<template>
  <div class="tw-root">
    <h3 class="tw-h3">🔬 单步走一遍：1KB 的池子被慢慢用光</h3>
    <p class="tw-sub">
      下面每一步都对应 <code>tlsf.c</code> 里真实的一行。左边是池子的物理布局
      （<b>地址从左到右递增</b>，灰色是块头，蓝色是已分配给用户的，白色是空闲），
      右边是该行源码与它在做什么。尺寸统一按 <b>32 位</b>口径。
    </p>

    <StepPlayer
      :steps="steps"
      title="TLSF 分配时间线（4 笔请求）"
      source-root="External/Allocator/tlsf/"
      @update:index="cur = $event"
    >
      <template #viz>
        <div class="tw-viz">
          <MemoryMap
            :blocks="blocks"
            base-label="pool+0"
            :px-per-byte="0.4"
            title="池子当前布局"
          />

          <div class="tw-stat">
            <span>空闲合计 <b>{{ freeTotal }} B</b></span>
            <span>块头开销 <b>{{ OVERHEAD }} B</b></span>
            <span>最小可切块 = {{ HDR }} + 申请量</span>
          </div>

          <div v-if="v.search" class="tw-bitmap">
            <div class="tw-bitmap-title">
              两级位图：找 <b>{{ v.search }}B</b> →
              目标桶 <b>fl={{ v.fl }} / sl={{ v.sl }}</b>
              <span v-if="v.borrowed" class="tw-borrow">本档为空，已向更大档位借</span>
            </div>

            <div class="tw-row">
              <span class="tw-row-label">fl_bitmap</span>
              <span
                v-for="b in flBits"
                :key="b.i"
                class="tw-flbit"
                :class="{ on: b.on, cur: b.i === v.fl && v.phase !== 'done' }"
              >{{ b.i }}</span>
            </div>

            <div class="tw-row">
              <span class="tw-row-label">sl_bitmap[{{ v.fl }}]</span>
              <span class="tw-slbits">
                <span
                  v-for="i in 32"
                  :key="i"
                  class="tw-slbit"
                  :class="{ ge: i - 1 >= v.sl, cur: i - 1 === v.sl }"
                />
              </span>
              <span class="tw-sl-hint">
                从第 {{ v.sl }} 位往上看（黄色 = 会被检查的区间）
              </span>
            </div>
          </div>
        </div>
      </template>
    </StepPlayer>

    <div class="tw-foot">
      <b>三个容易被忽略的点</b>
      <ol>
        <li>
          <b>块头是"寄生"的。</b>每个块前面的 4 字节 size 字段，位置正好压在前一个块的尾巴上，
          所以相邻块的实际间距是 <code>本块 size + 4</code>，不是 <code>本块 size</code>。
        </li>
        <li>
          <b>"适应"不等于"刚好"。</b>搜索时先向上取整到档位粒度，再从那个桶往更大的档位找，
          允许拿一个明显更大的块——切一刀比继续找更划算。
        </li>
        <li>
          <b>内部碎片的来源。</b>当剩余空间不够放下一个块头时，分配器选择整块交出，
          多给的字节锁死在这块里，直到它被释放。这也是为什么"反复申请/释放不同尺寸"
          会让堆越来越碎。
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.tw-root { margin: 22px 0; }
.tw-h3 { margin: 0 0 8px; }
.tw-sub {
  font-size: 13px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  margin: 0 0 10px;
}
.tw-sub code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  color: var(--vp-c-brand-1);
  padding: 1px 5px;
  border-radius: 4px;
}

.tw-viz { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

.tw-stat {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.tw-stat b { color: var(--vp-c-text-1); }

.tw-bitmap {
  border: 1px dashed var(--vp-c-divider);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--vp-c-bg-soft);
}
.tw-bitmap-title {
  font-size: 12px;
  color: var(--vp-c-text-2);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tw-borrow {
  background: #FFF3BF;
  color: #E8590C;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
}

.tw-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.tw-row-label {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
  width: 104px;
  flex: 0 0 auto;
}
.tw-flbit {
  width: 17px;
  height: 17px;
  border-radius: 3px;
  border: 1px solid var(--vp-c-divider);
  font-size: 9.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg);
}
.tw-flbit.on { background: #DEE2E6; color: #212529; font-weight: 600; }
.tw-flbit.cur { box-shadow: 0 0 0 2px #F59F00; color: #E8590C; }

.tw-slbits { display: inline-flex; gap: 2px; }
.tw-slbit {
  width: 7px;
  height: 17px;
  border-radius: 2px;
  background: var(--vp-c-divider);
}
.tw-slbit.ge { background: #FFE066; }
.tw-slbit.cur { background: #F59F00; }
.tw-sl-hint { font-size: 11px; color: var(--vp-c-text-3); margin-left: 6px; }

.tw-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.tw-foot b { color: var(--vp-c-text-1); }
.tw-foot ol { margin: 6px 0 0; padding-left: 20px; }
.tw-foot li { margin-bottom: 4px; }
.tw-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
