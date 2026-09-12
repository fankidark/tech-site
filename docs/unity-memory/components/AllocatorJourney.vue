<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// AllocatorJourney —— 一次分配的完整旅程（选定尺寸，逐步走完全链路）
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\Runtime\Allocator\ 下的真实代码。
// 每一步的 src.line 都是实查行号，关键判据与常量出处：
//   UNITY_NEW 宏                       MemoryMacros.h:202
//   operator new → malloc_internal     MemoryManager.cpp:204 / :367
//   MemoryManager::Allocate            MemoryManager.cpp:1631（Temp 分流、路由、fallback）
//   GetAllocator 路由查表              MemoryManager.cpp:2235
//   LabelInfo / m_AllocatorMap         MemoryManager.h:298 / :316
//   DualThreadAllocator::Allocate      DualThreadAllocator.cpp:194
//   BucketAllocator::Allocate          BucketAllocator.cpp:87
//   DynamicHeapAllocator::Allocate     DynamicHeapAllocator.cpp:409
//     ├ 小对象截流                     :414（CanAllocate ≤ m_MaxBucketSize）
//     ├ 真实大小计算                   :424
//     ├ TLSF 主路径                    :444
//     └ 池满分支 size < pool/2         :454（不满足 → LargeAlloc）
//   默认池大小 16MB                    MemoryManager.cpp:291 / :942-943（kDynamicHeapChunkSize）
//
// 架构：每个场景的步骤一次性算好，播放器只做时间线回放（不要在回调里推进状态机）。
// ============================================================================

const POOL_MB = 16
const POOL = POOL_MB * 1024 * 1024
const BUCKET_MAX = 64

// 场景：真实的几种典型分配
const SCENARIOS = [
  {
    id: 'small',
    label: 'ListNode 48B',
    size: 48,
    align: 16,
    memLabel: 'kMemDefault',
    hint: '链表节点、句柄这类海量小对象',
    poolUsedBefore: 11.2,
  },
  {
    id: 'mesh',
    label: 'Mesh 约 1.2KB',
    size: 1248,
    align: 16,
    memLabel: 'kMemGeometry',
    hint: '常态分配，走 TLSF 池',
    poolUsedBefore: 13.4,
  },
  {
    id: 'temp',
    label: 'Allocator.Temp 256B',
    size: 256,
    align: 16,
    memLabel: 'kMemTempAlloc',
    hint: '帧内临时，走线程本地栈',
    poolUsedBefore: 13.4,
  },
  {
    id: 'pool',
    label: '4MB 动画数据',
    size: 4 * 1024 * 1024,
    align: 16,
    memLabel: 'kMemAnimation',
    hint: '池子装不下了，看它怎么扩池',
    poolUsedBefore: 15.6,
  },
  {
    id: 'large',
    label: '40MB 大块数据',
    size: 40 * 1024 * 1024,
    align: 16,
    memLabel: 'kMemAnimation',
    hint: '超过池子一半 → 直通虚拟内存',
    poolUsedBefore: 15.6,
  },
]

const cur = ref('mesh')
const scenario = computed(() => SCENARIOS.find((s) => s.id === cur.value))

function fmtMB(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1) + 'MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return bytes + 'B'
}

// ---------- 为一个场景生成完整步骤 ----------
function buildSteps(s) {
  const steps = []
  const push = (o) => steps.push(o)

  // 逐步推演出的"事实"
  const isTemp = s.memLabel === 'kMemTempAlloc'
  const toBucket = !isTemp && s.size <= BUCKET_MAX
  const poolFreeMB = POOL_MB - s.poolUsedBefore
  const needNewPool = !isTemp && !toBucket && s.size >= poolFreeMB * 1024 * 1024
  const toLargeAlloc = needNewPool && s.size >= POOL / 2
  const realSize = s.size + 16 // AllocationHeader 占位：真实实现见 AllocationHeader::GetSize()

  // 步骤 1：宏展开
  push({
    title: `起点：${s.label}`,
    text:
      s.memLabel === 'kMemTempAlloc'
        ? `你写的是 C# 的 Allocator.Temp 分配。它最终会带着 kMemTempAlloc 这个 label 进引擎——label 就是"这块内存干什么用的"身份证。`
        : `C++ 里的一句 ${s.memLabel === 'kMemGeometry' ? 'UNITY_NEW(Mesh, kMemGeometry)' : `UNITY_MALLOC(${s.memLabel}, ${s.size})`}，展开后是把 label、对齐、文件名、行号一起交给重载的 operator new。注意 file/line 是编译期就塞进去的常量字符串——这是 Memory Profiler 能回答"这块内存谁分配的"的根本原因，也是平时零成本、只在开 Profiler 时才取用的元数据。`,
    src: {
      file: 'MemoryMacros.h',
      line: 202,
      excerpt:
        '#define UNITY_NEW(type, label)  new (label, alignof(type), __FILE_STRIPPED__, __LINE__) type\n#define UNITY_MALLOC(label, size)  malloc_internal(size, kDefaultMemoryAlignment, label, kAllocateOptionNone, __FILE_STRIPPED__, __LINE__)',
      note: 'UNITY_MALLOC 在 :178，UNITY_NEW 在 :202（同一文件）',
    },
    viz: { stage: 'macro', size: s.size, align: s.align },
  })

  push({
    title: 'operator new → malloc_internal',
    text: `这两层都不做实事，只是把 C++ 的语法世界接到引擎单例 MemoryManager 上。注意参数里的 kAllocateOptionNone：默认**分配失败直接崩**，不返回 NULL——游戏运行时 OOM 基本没法优雅恢复，早崩早拿 dump 比带着坏状态跑下去强。`,
    src: {
      file: 'MemoryManager.cpp',
      line: 367,
      excerpt:
        'void* malloc_internal(size_t size, size_t align, MemLabelRef label, AllocateOptions allocateOptions, const char* file, int line)',
      note: '调用方 operator new 在 :204',
    },
    viz: { stage: 'entry', size: s.size },
  })

  // 步骤 3：MemoryManager::Allocate 的四个预处理
  push({
    title: '总调度入口：四道检查',
    text:
      `对齐必须是 2 的幂；size==0 会被改成 1（因为在免费列表里，0 大小无法和"未分配"区分）；对齐值至少抬到默认对齐；然后判断引擎是否已初始化。这几步都不涉及真正的内存操作，但每一个都对应过一次线上事故。`,
    src: {
      file: 'MemoryManager.cpp',
      line: 1631,
      excerpt:
        'void* MemoryManager::Allocate(size_t size, size_t align, MemLabelRef label, AllocateOptions allocateOptions, const char* file, int line)\n{\n    DebugAssert(IsPowerOfTwo(align));\n    if (size == 0) size = 1;\n    align = MaxAlignment(align, kDefaultMemoryAlignment);',
    },
    viz: { stage: 'dispatch', size: s.size, align: s.align, isTemp },
  })

  // 步骤 4：Temp 分流
  push({
    title: isTemp ? '命中 Temp 分支 → 走线程本地栈' : '不是 Temp → 继续查路由表',
    text: isTemp
      ? `代码先问一句"IsTempLabel(label)"。是的话直接把它甩给 TLSAllocator——每个线程一个栈，分配就是栈指针上移，**完全不需要锁**。这就是 Allocator.Temp 便宜的真正原因。如果栈满了（ptr == NULL），它会用 GetFallbackLabel 换一个 label 重来一次，而不是直接失败。`
      : `label 不是 Temp，于是进入主线：GetAllocator(label) 去查路由表。这一步是整套内存系统的"主轴"——把"用途"翻译成"该用哪个分配器"。`,
    src: {
      file: 'MemoryManager.cpp',
      line: isTemp ? 1654 : 2235,
      excerpt: isTemp
        ? 'if (IsTempLabel(label))\n{\n    void* ptr = NULL;\n    if (IsTempAllocatorLabel(label))\n        ptr = ((TLSAllocator*)m_FrameTempAllocator)->TLSAllocator::Allocate(size, align);\n    ...\n    ptr = Allocate(size, align, GetFallbackLabel(label), allocateOptions, file, line);\n}'
        : 'BaseAllocator* MemoryManager::GetAllocator(MemLabelRef label)',
      note: isTemp
        ? 'Temp 分支在 :1654-1682（栈满走 :1676 的 fallback 递归）'
        : '路由函数本体；表体是 MemoryManager.h:316',
    },
    viz: { stage: isTemp ? 'tls' : 'route', size: s.size, memLabel: s.memLabel },
  })

  if (isTemp) {
    push({
      title: '完事：栈指针一移就返回',
      text: `没有任何空闲块搜索、没有位图、没有锁。代价是**不能跨帧持有**——帧末整栈直接回退，之前拿到的指针全部失效。把它存进长期引用的字段里，下一帧就是野指针。`,
      src: {
        file: 'TLSAllocator.cpp',
        line: 1,
        excerpt: '// 详见《TLS：每线程临时内存分配》一篇的单步拆解',
        note: 'TLSAllocator 的分配细节在那篇讲',
      },
      viz: { stage: 'done', path: 'tls' },
    })
    return steps
  }

  // 步骤 5：路由表
  push({
    title: `路由表查出：${s.memLabel} → DualThreadAllocator`,
    text:
      `m_AllocatorMap 是一张**平坦数组**，下标就是 labelId，所以这一步就是一次数组索引——没有 map、没有 hash、没有锁。所有 label 在初始化时被批量指向默认分配器（MemoryManager.cpp:955-956），个别 label 再被覆盖成专用分配器。`,
    src: {
      file: 'MemoryManager.h',
      line: 316,
      excerpt:
        'struct LabelInfo\n{\n    BaseAllocator*     alloc;\n    BaseAllocator*     relatedThreadAllocator;\n    MemLabelIdentifier fallbackLabel;\n};\nLabelInfo m_AllocatorMap[kMemLabelCount];',
      note: 'LabelInfo 结构定义在 :298，数组在 :316',
    },
    viz: { stage: 'route', memLabel: s.memLabel },
  })

  // 步骤 6：DualThread 小对象截流
  push({
    title: toBucket ? `尺寸 ${fmtMB(s.size)} ≤ 64B → 被桶分配器截流` : `尺寸 ${fmtMB(s.size)} > 64B → 桶分配器放行`,
    text: toBucket
      ? `海量的小对象（链表节点、句柄、字符串头）在这里就被拦下了，根本不进主堆。桶里存的是"已经切好的定长小块"串成的无锁栈，分配 = Pop，释放 = Push，热路径上一把锁都没有。`
      : `桶只收 ≤64B 的对象，${fmtMB(s.size)} 超了，于是落到按线程区分的堆分配器上。主线程用免锁的那一个，工作线程用带锁的那一个——主线程分配最频繁，单独给它开小灶。`,
    src: {
      file: 'DualThreadAllocator.cpp',
      line: 194,
      excerpt:
        'if (m_BucketAllocator != NULL && m_BucketAllocator->BucketAllocator::CanAllocate(size, align))\n{\n    void* ptr = m_BucketAllocator->BucketAllocator::Allocate(size, align);\n    if (ptr != NULL) return ptr;\n}\nUnderlyingAllocator* alloc = GetCurrentAllocator();\nreturn alloc->UnderlyingAllocator::Allocate(size, align);',
    },
    viz: { stage: toBucket ? 'bucket' : 'dual', size: s.size },
  })

  if (toBucket) {
    push({
      title: 'Bucket：无锁 Pop 一次就返回',
      text: `几十纳秒级返回。只有当"桶空了要扩容"这种低频事件发生时才会进 mutex，而且进去还要 double-check 别人是不是已经扩过了。这就是"乐观快路径 + 悲观慢路径"的经典分层。`,
      src: {
        file: 'BucketAllocator.cpp',
        line: 87,
        excerpt:
          'void* BucketAllocator::Allocate(size_t size, int alignment)\n{\n    if (!CanAllocate(size, alignment))\n        return NULL;\n    Buckets* buckets = GetBucketsForSize(size);\n    while (true)\n    {\n        newRealPtr = buckets->PopBucket();',
      },
      viz: { stage: 'done', path: 'bucket', size: s.size },
    })
    return steps
  }

  // DynamicHeapAllocator 主线
  push({
    title: '进堆之前先算"真实大小"',
    text:
      `用户要 ${fmtMB(s.size)}，但分配器要给这块内存配一份"户口本"（AllocationHeader，记录归属与大小），所以真实申请量更大。之后还有一次"按 TLSF 块要求向上对齐"的处理：对 >32B 的请求，取 size>>5 的最高位算出对齐掩码再抹平——目的是让块尺寸分布更规整，减少碎块。`,
    src: {
      file: 'DynamicHeapAllocator.cpp',
      line: 424,
      excerpt:
        'size_t realSize = AllocationHeader::CalculateNeededAllocationSize(size, align);\n\n/// align size to tlsf block requirements\nif (realSize > 32)\n{\n    size_t tlsfalign = (1 << HighestBit(realSize >> 5)) - 1;\n    realSize = (realSize + tlsfalign) & ~tlsfalign;\n}',
    },
    viz: { stage: 'realsize', size: s.size, realSize },
  })

  push({
    title: 'TLSF 主路径：O(1) 找一个够大的空闲块',
    text:
      `tlsf_memalign 用两级位图在常数时间内定位空闲块（怎么做到的见《TLSF》一篇）。当前池已用 ${s.poolUsedBefore}MB / ${POOL_MB}MB，剩余约 ${poolFreeMB.toFixed(1)}MB。`,
    src: {
      file: 'DynamicHeapAllocator.cpp',
      line: 444,
      excerpt: 'newRealPtr = (char*)tlsf_memalign(m_TlsfInstance, allocationAlignment, realSize);',
    },
    viz: {
      stage: 'tlsf',
      size: s.size,
      realSize,
      poolUsedBefore: s.poolUsedBefore,
      poolFreeMB,
      fits: !needNewPool,
    },
  })

  if (!needNewPool) {
    push({
      title: `命中：从池里切一块给你`,
      text: `这是绝大多数分配的结局——亚微秒级返回。之后把块头里的地址换算成用户指针交出去。`,
      src: {
        file: 'DynamicHeapAllocator.cpp',
        line: 446,
        excerpt: 'GetPoolInfo(newRealPtr)->allocationCount += 1;',
      },
      viz: { stage: 'done', path: 'tlsf', size: s.size, realSize },
    })
    return steps
  }

  // 池满分支
  push({
    title: toLargeAlloc ? '池里装不下，而且块太大 → 跳过建池，直通虚拟内存' : '池里装不下 → 新建一个 16MB 的池再试',
    text: toLargeAlloc
      ? `关键判据是 size < poolSize / 2。这次要 ${fmtMB(s.size)}，已经超过 ${POOL_MB}MB 池子的一半——**大块进池会把池子切得稀碎**，制造出"池被一个分配占掉一半"的伪碎片。所以它绕开池，直接向系统要一块独立虚拟内存，释放时整块还给 OS。`
      : `判据 size < poolSize / 2 成立，所以先 CreateTLSFPool 要一个新的 16MB 池，tlsf_add_pool 挂进 TLSF，然后再试一次 tlsf_memalign。这笔钱花得值：池是批量要来的，之后成百上千次分配都能在里面零成本切。`,
    src: {
      file: 'DynamicHeapAllocator.cpp',
      line: 454,
      excerpt:
        '// only try to make new tlsfBlocks if the amount is less than half of the blocksize - else spill to LargeAllocations\nif (size < m_RequestedPoolSize / 2)\n{\n    size_t blockSize;\n    void* memoryBlock = CreateTLSFPool(blockSize);\n    tlsf_add_pool(m_TlsfInstance, memoryBlock, blockSize);\n    newRealPtr = (char*)tlsf_memalign(m_TlsfInstance, allocationAlignment, realSize);',
      note: 'pool 大小 16MB 来自 MemoryManager.cpp:291 的 kDynamicHeapChunkSize，在 :942-943 传给 DynamicHeapAllocator',
    },
    viz: { stage: toLargeAlloc ? 'large' : 'newpool', size: s.size, poolMB: POOL_MB },
  })

  push({
    title: toLargeAlloc ? 'LargeAlloc：走 ReserveMemoryBlock 直接要页' : '新池就位，重试成功',
    text: toLargeAlloc
      ? `大块分配走的是另一本账（LargeAlloc 列表），不和普通块混在一起。代价是每次都有系统调用开销，第一笔写入还会触发缺页中断——所以大块分配"看起来慢"往往慢在这里，不在分配器算法上。`
      : `新池挂上后重试成功。注意池是**预留（reserve）**的虚拟地址，真正用到的页才提交（commit）——所以"预留 16MB"不等于立刻吃掉 16MB 物理内存。`,
    src: {
      file: 'DynamicHeapAllocator.cpp',
      line: 201,
      excerpt: 'void* DynamicHeapAllocator::RequestLargeAllocMemory(size_t size, size_t& commitSize)',
    },
    viz: { stage: 'done', path: toLargeAlloc ? 'large' : 'newpool', size: s.size },
  })

  return steps
}

const steps = computed(() => buildSteps(scenario.value))
const idx = ref(0)
const step = computed(() => steps.value[idx.value] || {})
const viz = computed(() => step.value.viz || {})

// 池子占用示意
const poolBlocks = computed(() => {
  const v = viz.value
  const used = v.poolUsedBefore ?? scenario.value.poolUsedBefore
  const remain = Math.max(0, POOL_MB - used)
  return [
    { label: '已分配', size: used, kind: 'used', note: '池内已经切出去的块' },
    {
      label: v.stage === 'newpool' || v.path === 'newpool' ? '新池 +16MB' : remain < 0.2 ? '几乎耗尽' : '空闲',
      size: Math.max(remain, 0.5),
      kind: 'free',
      note: `池上限 ${POOL_MB}MB`,
    },
  ]
})

// 路径指示：把全链路画成一条可点亮的链
const PATH = [
  { key: 'macro', name: '宏展开' },
  { key: 'entry', name: 'operator new' },
  { key: 'dispatch', name: 'Allocate 总调度' },
  { key: 'tls', name: 'TLS 栈', alt: true },
  { key: 'route', name: '路由表' },
  { key: 'bucket', name: 'Bucket 桶', alt: true },
  { key: 'tlsf', name: 'TLSF 池' },
  { key: 'large', name: 'LargeAlloc', alt: true },
]
const stageOrder = ['macro', 'entry', 'dispatch', 'tls', 'route', 'bucket', 'tlsf', 'large', 'newpool', 'done']
const reached = computed(() => {
  const set = new Set()
  for (let i = 0; i <= idx.value; i++) {
    const st = steps.value[i]?.viz?.stage
    if (st) set.add(st)
  }
  return set
})
function pathState(k) {
  if (reached.value.has(k)) return 'on'
  return 'off'
}
</script>

<template>
  <div class="aj-root">
    <h3 class="aj-h3">🚀 一次分配的完整旅程（选个尺寸，看它走哪条路）</h3>
    <p class="aj-sub">
      同一句分配代码，尺寸或 label 换个值，走的分配器就完全不同。下面选一个场景，
      然后按"播放"或"下一步"逐步走完，每一步都会告诉你<strong>现在在哪、依据哪一行源码做了这个判断</strong>。
    </p>

    <!-- 场景选择 -->
    <div class="aj-picker">
      <button
        v-for="s in SCENARIOS"
        :key="s.id"
        class="aj-pick"
        :class="{ on: s.id === cur }"
        @click="cur = s.id; idx = 0"
      >
        <span class="aj-pick-name">{{ s.label }}</span>
        <span class="aj-pick-hint">{{ s.hint }}</span>
      </button>
    </div>

    <!-- 路径指示链 -->
    <div class="aj-path">
      <template v-for="(p, i) in PATH" :key="p.key">
        <span class="aj-node" :class="[pathState(p.key), { alt: p.alt }]">{{ p.name }}</span>
        <span v-if="i < PATH.length - 1" class="aj-arrow">→</span>
      </template>
    </div>

    <StepPlayer
      :steps="steps"
      :title="`场景：${scenario.label}（${scenario.memLabel}）`"
      source-root="Runtime/Allocator/"
      @update:index="idx = $event"
    >
      <template #viz>
        <div class="aj-viz">
          <!-- 当前所在层 -->
          <div class="aj-where">
            <div class="aj-where-label">此刻在这</div>
            <div class="aj-where-value">
              {{
                viz.stage === 'tls' ? 'TLSAllocator（每线程栈）'
                : viz.stage === 'bucket' ? 'BucketAllocator（≤64B 无锁桶）'
                : viz.stage === 'route' ? '路由表 m_AllocatorMap'
                : viz.stage === 'dual' ? 'DualThreadAllocator'
                : viz.stage === 'realsize' ? 'DynamicHeapAllocator（算真实大小）'
                : viz.stage === 'tlsf' ? 'TLSF 两级位图查找'
                : viz.stage === 'newpool' ? 'CreateTLSFPool 新建池'
                : viz.stage === 'large' ? 'LargeAlloc 直通虚拟内存'
                : viz.stage === 'done' ? '✅ 已返回用户指针'
                : '内存入口'
              }}
            </div>
            <div v-if="viz.realSize" class="aj-where-sub">
              用户要 {{ viz.size }}B → 实际申请 {{ viz.realSize }}B
            </div>
          </div>

          <!-- 池子占用条 -->
          <MemoryMap
            v-if="['tlsf', 'newpool', 'large', 'done'].includes(viz.stage) && viz.path !== 'bucket' && viz.path !== 'tls'"
            :blocks="poolBlocks"
            :px-per-byte="7"
            :min-block-px="60"
            base-label="TLSF 池起点"
            :show-ticks="false"
            :title="`主堆池占用（16MB 一个池）`"
          />

          <div v-else class="aj-note">
            <template v-if="viz.stage === 'macro' || viz.stage === 'entry'">
              还没碰到任何内存结构——现在只是把参数从 C++ 语法层传到引擎层。
            </template>
            <template v-else-if="viz.stage === 'dispatch'">
              四道预处理检查：对齐是不是 2 的幂、size==0 改 1、对齐抬到默认值、引擎是否已初始化。
            </template>
            <template v-else-if="viz.stage === 'tls'">
              Temp 走了捷径：没有空闲块搜索，栈指针上移即可。
            </template>
            <template v-else-if="viz.stage === 'route'">
              <code>m_AllocatorMap[labelId]</code> → 一次数组索引，O(1) 无锁。
            </template>
            <template v-else-if="viz.stage === 'bucket'">
              Bucket 里存的是预先切好的定长小块，Pop 走的是无锁栈（AtomicStack）。
            </template>
            <template v-else-if="viz.stage === 'dual'">
              桶放行了，现在按"当前是哪个线程"挑一个堆分配器。
            </template>
          </div>

          <!-- 桶的示意 -->
          <div v-if="viz.stage === 'bucket' || viz.path === 'bucket'" class="aj-buckets">
            <div class="aj-buckets-title">BucketAllocator 的四档桶（定长块串成的无锁栈）</div>
            <div class="aj-bucket-row">
              <span v-for="(b, i) in [16, 32, 48, 64]" :key="b" class="aj-bucket" :class="{ hit: viz.size && viz.size <= b && (i === 0 || viz.size > [16, 32, 48, 64][i - 1]) }">
                {{ b }}B
                <span class="aj-bucket-bar" />
              </span>
            </div>
            <div class="aj-buckets-hint">
              档位少 → 内部碎片可控（最坏 15B）；代价是 65~256B 的中小对象没有快路径
            </div>
          </div>
        </div>
      </template>
    </StepPlayer>

    <div class="aj-foot">
      <b>这条瀑布的设计逻辑（一句话版）</b>
      <ul>
        <li><b>TLS 栈</b>处理"帧内用完就扔"——牺牲跨帧能力换零锁。</li>
        <li><b>Bucket 桶</b>处理"又多又小"——牺牲尺寸灵活度换无锁与快。</li>
        <li><b>TLSF 池</b>处理绝大多数常态分配——用位图换 O(1)。</li>
        <li><b>LargeAlloc</b>处理"又大又少"——绕开池，避免把池切碎。</li>
      </ul>
      <p class="aj-foot-p">
        四级里没有一级是"通用最优"，每一级都是拿某个维度的灵活性去换另一个维度的速度或碎片表现。
        理解这一点，比记住每层函数名重要得多。
      </p>
    </div>
  </div>
</template>

<style scoped>
.aj-root { margin: 22px 0; }
.aj-h3 { margin: 0 0 8px; }
.aj-sub {
  font-size: 13px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  margin: 0 0 12px;
}

.aj-picker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.aj-pick {
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
  max-width: 190px;
}
.aj-pick:hover { border-color: var(--vp-c-brand-1); }
.aj-pick.on {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.aj-pick-name { font-size: 12.5px; font-weight: 600; color: var(--vp-c-text-1); }
.aj-pick-hint { font-size: 11px; color: var(--vp-c-text-3); line-height: 1.35; }

.aj-path {
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
.aj-node {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg);
  white-space: nowrap;
}
.aj-node.on {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
}
.aj-node.alt { border-style: dashed; }
.aj-arrow { color: var(--vp-c-text-3); }

.aj-viz { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

.aj-where {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--vp-c-bg-soft);
}
.aj-where-label { font-size: 11px; color: var(--vp-c-text-3); }
.aj-where-value { font-size: 14px; font-weight: 600; color: var(--vp-c-brand-1); margin-top: 2px; }
.aj-where-sub { font-size: 11.5px; color: var(--vp-c-text-2); margin-top: 2px; }

.aj-note {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
  border-left: 3px solid var(--vp-c-divider);
  padding: 6px 10px;
  background: var(--vp-c-bg-soft);
  border-radius: 0 6px 6px 0;
}
.aj-note code {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.aj-buckets {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--vp-c-bg-soft);
}
.aj-buckets-title { font-size: 11.5px; color: var(--vp-c-text-3); margin-bottom: 6px; }
.aj-bucket-row { display: flex; gap: 8px; }
.aj-bucket {
  flex: 1;
  text-align: center;
  font-size: 11.5px;
  font-family: var(--vp-font-family-mono);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 0 8px;
  position: relative;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
}
.aj-bucket.hit {
  border-color: #F59F00;
  box-shadow: 0 0 0 2px #FFF3BF;
  color: #E8590C;
  font-weight: 700;
}
.aj-bucket-bar {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 4px;
  height: 3px;
  border-radius: 2px;
  background: var(--vp-c-divider);
}
.aj-bucket.hit .aj-bucket-bar { background: #F59F00; }
.aj-buckets-hint { font-size: 11px; color: var(--vp-c-text-3); margin-top: 6px; }

.aj-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.aj-foot b { color: var(--vp-c-text-1); }
.aj-foot ul { margin: 6px 0 8px; padding-left: 20px; }
.aj-foot li { margin-bottom: 3px; }
.aj-foot-p { margin: 0; }
</style>
