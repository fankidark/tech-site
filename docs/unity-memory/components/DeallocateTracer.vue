<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// DeallocateTracer —— 释放一个裸指针时的"信任降级瀑布"
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\Runtime\Allocator\MemoryManager.cpp
//   Deallocate(ptr, label, file, line) 主入口           :1874 起
//     ├ 引擎未初始化 → FallbackDeallocate               :1879
//     ├ Temp label 分支 → TLSAllocator::TryDeallocate   :1885 / :1894
//     │     失败 → Deallocate(ptr, GetFallbackLabel())  :1906
//     └ 普通 label：
//          ENABLE_MEM_PROFILER：alloc->Contains(ptr) 判定 :1925
//          release：alloc->TryDeallocate(ptr)             :1951
//          两条路失败都退到 fallback label 或"通用释放"   :1931 / :1934 / :1957
//   BlockInfo 表（地址空间户口本）
//     MarkMemoryBlocks 登记                             :616-626
//     GetBlockInfoFromPointer 按地址反查                :721-724
//     GetAllocatorFromPointer                           :716
//     GetBlockInfoFromPointer 里 ptr/粒度 = 格号        :702-713 / :723
//
// 交互：选一个"释放场景"，逐步看它怎么一层层降级，最后靠什么找到归属。
// ============================================================================

// 模拟的地址空间：按 256KB 粒度切格，每格登记一个 allocator 编号
const GRAN = 256 // KB，为了画图缩小；真实 PC 64 位是 256MB（kReserveBlockGranularity）
const CELLS = [
  { owner: 'TLSAllocator(主线程)', color: '#4C6EF5', note: '帧临时栈的内存块' },
  { owner: 'TLSAllocator(主线程)', color: '#4C6EF5', note: '帧临时栈的内存块' },
  { owner: 'TLSAllocator(主线程)', color: '#4C6EF5', note: '帧临时栈的内存块' },
  { owner: 'DynamicHeapAllocator(主)', color: '#12B886', note: '主堆的一块预留' },
  { owner: 'DynamicHeapAllocator(主)', color: '#12B886', note: '主堆的一块预留' },
  { owner: 'BucketAllocator', color: '#F59F00', note: '小对象桶的内存块' },
  { owner: 'DynamicHeapAllocator(线程)', color: '#AE3EC9', note: '工作线程堆' },
  { owner: 'DynamicHeapAllocator(线程)', color: '#AE3EC9', note: '工作线程堆' },
  { owner: 'LargeAlloc 独立块', color: '#E03131', note: '大块直通的独立预留' },
  { owner: '未登记(0)', color: '#ADB5BD', note: '系统 malloc 或非 Unity 内存' },
]

// 释放场景：每个都对应真实会踩到的坑
const SCENARIOS = [
  {
    id: 'hit',
    name: '正常：label 对、指针也对',
    ptrCell: 3,
    givenLabel: 'kMemGeometry',
    truthLabel: 'kMemGeometry',
    desc: '最常见的情况，TryDeallocate 一次命中',
  },
  {
    id: 'tempFallback',
    name: '坑一：Temp 栈满了，实际从堆里给的',
    ptrCell: 3,
    givenLabel: 'kMemTempAlloc',
    truthLabel: 'kMemGeometry',
    desc: '分配时 Temp 栈溢出走了 fallback，释放时调用方还拿着 Temp label',
  },
  {
    id: 'crossThread',
    name: '坑二：主线程分配，工作线程释放',
    ptrCell: 6,
    givenLabel: 'kMemDefault',
    truthLabel: 'kMemDefault',
    desc: '同一个 label 在不同线程解析出的 allocator 不是同一个实例',
  },
  {
    id: 'wrongLabel',
    name: '坑三：label 完全传错',
    ptrCell: 4,
    givenLabel: 'kMemBucket',
    truthLabel: 'kMemGeometry',
    desc: '泛型容器/C 接口回调里只有裸指针，label 是猜的',
  },
]

const cur = ref('tempFallback')
const scenario = computed(() => SCENARIOS.find((s) => s.id === cur.value))

// 逐场景生成降级步骤
function buildSteps(s) {
  const steps = []
  const cell = CELLS[s.ptrCell]
  const isTemp = s.givenLabel === 'kMemTempAlloc'
  const labelOwner = isTemp ? 'TLSAllocator(主线程)' : s.givenLabel === 'kMemBucket' ? 'BucketAllocator' : 'DynamicHeapAllocator(主)'
  const labelHits = cell.owner === labelOwner

  const push = (o) => steps.push(o)

  push({
    title: `调用 Deallocate(ptr, ${s.givenLabel})`,
    text: s.desc + `。指针落在第 ${s.ptrCell} 格，那一格的登记主人是「${cell.owner}」。`,
    src: {
      file: 'MemoryManager.cpp',
      line: 1872,
      excerpt:
        'void MemoryManager::Deallocate(void* ptr, MemLabelRef label, const char* file, int line)\n{\n    if (ptr == NULL) return;\n    if (!IsActive()) { FallbackDeallocate(ptr, label, file, line); return; }',
      note: '带 label 的主入口（:1872）；无 label 的重载在 :1965',
    },
    viz: { stage: 'entry', ptrCell: s.ptrCell, labelHits },
  })

  if (isTemp) {
    push({
      title: '先走 Temp 分支：问 TLS 栈"这指针是你的吗"',
      text:
        `因为 label 是 Temp，代码直接调 TLSAllocator::TryDeallocate(ptr)，让栈自己去认领。` +
        `重点在于 **TryDeallocate 不信任调用方**——它会自己检查指针是否在自己的地址区间内（StackAllocator.h:176 的 Contains 判定），不是就返回 false。`,
      src: {
        file: 'MemoryManager.cpp',
        line: 1894,
        excerpt:
          'if (IsTempAllocatorLabel(label))\n    success = ((TLSAllocator*)m_FrameTempAllocator)->TLSAllocator::TryDeallocate(ptr);\nelse\n    success = GetAllocator(label)->TryDeallocate(ptr);\n\nif (success)\n    return;',
      },
      viz: { stage: 'tempTry', ptrCell: s.ptrCell, willFail: !labelHits },
    })

    push({
      title: !labelHits ? '认领失败 → 用 fallback label 递归一次' : '认领成功，直接返回',
      text: !labelHits
        ? `指针根本不在这个线程的栈区间里，TryDeallocate 返回 false。代码没有报错、也没有崩溃，而是**换一个 label 重新走一遍整个释放流程**（递归调用自己）。这正是 label 可能"骗人"时系统能自愈的原因。`
        : `指针确实在这个线程的栈上，栈顶回退，释放完成。注意栈式分配只能释放栈顶——这块如果不是栈顶，TryDeallocate 也会失败并落到 fallback。`,
      src: {
        file: 'MemoryManager.cpp',
        line: 1906,
        excerpt: 'Deallocate(ptr, GetFallbackLabel(label));',
        note: '递归降级：整条释放流程用 fallback label 再走一遍',
      },
      viz: { stage: labelHits ? 'done' : 'fallback', ptrCell: s.ptrCell },
    })

    if (labelHits) return steps
  } else {
    push({
      title: '普通 label：先让 label 指向的分配器"自证"',
      text:
        `拿到 alloc 之后，代码不直接释放，而是先问一句"这指针在我管的地盘上吗"。` +
        `注意这里有 **两个版本**：开了 Profiler 走 ` + '`alloc->Contains(ptr)`' + `（:1925），release 走 ` + '`alloc->TryDeallocate(ptr)`' + `（:1951）。` +
        `前者是查询，后者是"检查并通过则顺手释放"，release 版少一次虚函数调用。`,
      src: {
        file: 'MemoryManager.cpp',
        line: 1925,
        excerpt:
          '#if ENABLE_MEM_PROFILER\n    if (!alloc->Contains(ptr))\n    {\n        if (GetLabelIdentifier(GetFallbackLabel(label)) != kMemInvalidLabelId)\n            return Deallocate(ptr, GetFallbackLabel(label), file, line);\n        Deallocate(ptr);\n        return;\n    }\n#else\n    if (!alloc->TryDeallocate(ptr))\n    { ... }\n#endif',
        note: 'Profiler 版在 :1925，release 版在 :1951（同一函数内）',
      },
      viz: { stage: 'selfCheck', ptrCell: s.ptrCell, labelHits },
    })
  }

  if (!labelHits) {
    push({
      title: '自证失败 → 降级到 fallback label，还不行就"通用释放"',
      text:
        `这是关键的分层设计：**先信 label，信不过就换 label，再信不过就完全不信 label**。` +
        `最后那个 Deallocate(ptr)（不带 label 的重载）只能靠地址反查——也就是下面那张户口本。`,
      src: {
        file: 'MemoryManager.cpp',
        line: 1934,
        excerpt: 'Deallocate(ptr);   // 不带 label：只能按地址反查归属',
      },
      viz: { stage: 'fallback', ptrCell: s.ptrCell },
    })
  }

  // 按地址反查
  const blockIndex = s.ptrCell
  push({
    title: `最后一道防线：拿地址去"户口本"里查`,
    text:
      `把指针地址除以预留粒度（真实是 ${256}MB，本图缩成 ${GRAN}KB 方便画），得到格号 ${blockIndex}；` +
      `再查 BlockInfo 表，读出这一格的主人是谁。**一次除法 + 一次数组读**，不遍历、不加锁、不碰指针指向的内存——最后这点特别重要，因为传进来的指针可能已经是个野指针，读它会崩。`,
    src: {
      file: 'MemoryManager.cpp',
      line: 723,
      excerpt:
        'MemoryManager::VirtualAllocator::BlockInfo MemoryManager::VirtualAllocator::GetBlockInfoFromPointer(const void* ptr)\n{\n    int blockIndex = (size_t)ptr / kReserveBlockGranularity;\n    return GetMemoryBlockOwnerAndOffset(blockIndex);\n}',
      note: 'GetAllocatorFromPointer 在 :716，反查核心在 :721-724',
    },
    viz: { stage: 'lookup', ptrCell: s.ptrCell, blockIndex, owner: cell.owner },
  })

  push({
    title: `找到归属：${cell.owner}`,
    text:
      cell.owner.startsWith('未登记')
        ? `这一格没有登记任何 allocator —— 说明这块内存不是 Unity 分配器给的（可能来自系统 malloc 或第三方库）。这种情况下只能交给低层分配器处理，或者干脆放弃追踪。`
        : `查到了归属，交给它释放。整套降级链到此结束：label 错了两轮，最终靠地址反查兜住。**这就是"释放比分配难"的解法。**`,
    src: {
      file: 'MemoryManager.cpp',
      line: 616,
      excerpt:
        'void MemoryManager::VirtualAllocator::MarkMemoryBlocks(void* ptr, size_t size, BlockInfo info)\n{\n    UInt32 startBlock = ((size_t)ptr) / kReserveBlockGranularity;\n    UInt32 endBlock = ((size_t)ptr + size) / kReserveBlockGranularity;\n    ...\n    SetMemoryBlockOwnerAndOffset(i, info);\n}',
      note: '登记侧：向系统要内存时顺手写户口本（:616-626）',
    },
    viz: { stage: 'done', ptrCell: s.ptrCell, owner: cell.owner },
  })

  return steps
}

const steps = computed(() => buildSteps(scenario.value))
const idx = ref(0)
const step = computed(() => steps.value[idx.value] || {})
const viz = computed(() => step.value.viz || {})

// 降级链的状态
const CHAIN = [
  { key: 'entry', name: '① 信 label' },
  { key: 'tempTry', name: '② Temp 栈自认领' },
  { key: 'selfCheck', name: '② 分配器 Contains 自证' },
  { key: 'fallback', name: '③ fallback label 递归' },
  { key: 'lookup', name: '④ 地址反查户口本' },
  { key: 'done', name: '⑤ 找到归属' },
]
const reached = computed(() => {
  const set = new Set()
  for (let i = 0; i <= idx.value; i++) {
    const st = steps.value[i]?.viz?.stage
    if (st) set.add(st)
  }
  return set
})
</script>

<template>
  <div class="dt-root">
    <h3 class="dt-h3">🗑 释放一个裸指针：四层信任降级</h3>
    <p class="dt-sub">
      分配时你有 label 指路，释放时 label 可能<strong>是错的</strong>（栈溢出走了 fallback、
      跨线程、调用方猜的）。所以释放路径设计成一串"先信、再验证、最后放弃信任改查表"的降级链。
      选一个场景，逐步看它怎么兜底。
    </p>

    <div class="dt-picker">
      <button
        v-for="s in SCENARIOS"
        :key="s.id"
        class="dt-pick"
        :class="{ on: s.id === cur }"
        @click="cur = s.id; idx = 0"
      >
        <span class="dt-pick-name">{{ s.name }}</span>
        <span class="dt-pick-desc">{{ s.desc }}</span>
      </button>
    </div>

    <div class="dt-chain">
      <template v-for="(c, i) in CHAIN" :key="c.key">
        <span class="dt-node" :class="{ on: reached.has(c.key) }">{{ c.name }}</span>
        <span v-if="i < CHAIN.length - 1" class="dt-arrow">→</span>
      </template>
    </div>

    <StepPlayer
      :steps="steps"
      :title="`场景：${scenario.name}`"
      source-root="Runtime/Allocator/"
      @update:index="idx = $event"
    >
      <template #viz>
        <div class="dt-viz">
          <!-- 户口本 -->
          <div class="dt-table-box">
            <div class="dt-table-title">
              地址空间户口本（BlockInfo 表，按 {{ GRAN }}KB 一格）
              <span v-if="viz.ptrCell != null" class="dt-ptr-hint">← 待释放指针在第 {{ viz.ptrCell }} 格</span>
            </div>
            <div class="dt-cells">
              <div
                v-for="(c, i) in CELLS"
                :key="i"
                class="dt-cell"
                :class="{ target: i === viz.ptrCell, scanned: viz.stage === 'lookup' }"
                :style="{ background: c.color }"
                :title="`第 ${i} 格：${c.owner}（${c.note}）`"
              >
                <span class="dt-cell-idx">{{ i }}</span>
                <span class="dt-cell-owner">{{ c.owner.replace(/\(.*\)/, '') }}</span>
              </div>
            </div>
            <div class="dt-lookup-formula" :class="{ active: viz.stage === 'lookup' }">
              <code>格号 = 指针地址 ÷ {{ GRAN }}KB</code>
              <template v-if="viz.blockIndex != null">
                <span class="dt-eq">=</span>
                <code class="dt-hit">{{ viz.blockIndex }}</code>
                <span class="dt-eq">→</span>
                <code class="dt-owner">{{ viz.owner }}</code>
              </template>
            </div>
          </div>

          <!-- 当前判断结果 -->
          <div v-if="viz.labelHits != null" class="dt-verdict" :class="viz.labelHits ? 'ok' : 'bad'">
            <b>label 自证结果：</b>
            {{ viz.labelHits
              ? '✅ 指针确实在这个 label 指向的分配器地盘上 → 直接释放，降级链不用走完'
              : '❌ 指针不在这个 label 指向的分配器地盘上 → 进入降级' }}
          </div>
        </div>
      </template>
    </StepPlayer>

    <div class="dt-foot">
      <b>为什么必须做到"不信任 label"？</b>
      <p>
        因为 label 是人写的。C++ 里 <code>UNITY_DELETE(ptr, label)</code> 的 label 由调用方决定，
        而调用方可能：拿错对象、从泛型容器里掏出一个裸指针、或者根本不知道当初是谁分配的。
        如果释放路径无条件相信 label，一个写错的 label 就会把内存还给错误的分配器——
        这类错误通常不会立刻崩，而是在几分钟后以"随机数据被覆盖"的形式爆发。
      </p>
      <p>
        <b>降级链的真正价值</b>：把"调用方可能出错"这个事实变成系统设计的一部分。
        先给一次机会（信 label），失败了降级（换 label），再失败就彻底放弃信任、
        改用不可骗的证据（地址户口本）。<b>每一步的代价都比上一步高，但每一步都保证不会静默出错。</b>
      </p>
    </div>
  </div>
</template>

<style scoped>
.dt-root { margin: 22px 0; }
.dt-h3 { margin: 0 0 8px; }
.dt-sub { font-size: 13px; line-height: 1.8; color: var(--vp-c-text-2); margin: 0 0 12px; }

.dt-picker { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.dt-pick {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  text-align: left;
  max-width: 220px;
}
.dt-pick:hover { border-color: var(--vp-c-brand-1); }
.dt-pick.on { border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.dt-pick-name { font-size: 12.5px; font-weight: 600; color: var(--vp-c-text-1); }
.dt-pick-desc { font-size: 11px; color: var(--vp-c-text-3); line-height: 1.35; }

.dt-chain {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  margin-bottom: 12px;
  font-size: 11.5px;
}
.dt-node {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg);
  white-space: nowrap;
}
.dt-node.on {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
}
.dt-arrow { color: var(--vp-c-text-3); }

.dt-viz { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

.dt-table-box {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--vp-c-bg-soft);
}
.dt-table-title { font-size: 11.5px; color: var(--vp-c-text-3); margin-bottom: 6px; }
.dt-ptr-hint { color: #E8590C; font-weight: 600; }

.dt-cells { display: flex; gap: 3px; flex-wrap: wrap; }
.dt-cell {
  position: relative;
  width: 62px;
  height: 44px;
  border-radius: 5px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 9px;
  text-align: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.4);
  transition: box-shadow 0.2s, transform 0.2s;
}
.dt-cell-owner {
  padding: 0 2px;
  line-height: 1.15;
  word-break: break-all;
}
.dt-cell-idx { font-size: 8px; opacity: 0.8; }
.dt-cell.target {
  box-shadow: 0 0 0 3px #F59F00;
  transform: translateY(-2px);
  z-index: 1;
}
.dt-cell.scanned { opacity: 0.85; }

.dt-lookup-formula {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11.5px;
}
.dt-lookup-formula code {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  background: var(--vp-code-block-bg);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--vp-c-text-2);
}
.dt-lookup-formula.active code { color: var(--vp-c-text-1); }
.dt-eq { color: var(--vp-c-text-3); }
.dt-hit { color: #E8590C !important; font-weight: 700; }
.dt-owner { color: #2F9E44 !important; font-weight: 600; }

.dt-verdict {
  font-size: 12.5px;
  line-height: 1.7;
  border-radius: 8px;
  padding: 8px 12px;
}
.dt-verdict.ok { background: #EBFBEE; color: #2B8A3E; border: 1px solid #B2F2BB; }
.dt-verdict.bad { background: #FFF5F5; color: #C92A2A; border: 1px solid #FFC9C9; }

.dt-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.dt-foot b { color: var(--vp-c-text-1); }
.dt-foot p { margin: 6px 0 0; }
.dt-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
