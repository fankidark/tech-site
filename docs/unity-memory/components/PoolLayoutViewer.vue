<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// PoolLayoutViewer —— 256MB 虚拟预留里"懒创建 Pool"的过程可视化
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\Runtime\Allocator\DynamicHeapAllocator.cpp / .h
//   kDynamicHeapChunkSize 16MB      MemoryManager.cpp:291
//   构造里算 m_PoolsPerBlock        DynamicHeapAllocator.cpp:95-98
//   预留粒度 256MB（PC 64 位）      LowLevelDefaultAllocator.h:74（1<<28）
//   InitializeTLSF 只建控制结构     DynamicHeapAllocator.cpp:113
//   CreateTLSFPool 切新 Pool        DynamicHeapAllocator.cpp:294
//   LargeAlloc 直通                 DynamicHeapAllocator.cpp:201 / :454
//   PoolInfo 挂在块尾               DynamicHeapAllocator.h:148-149
//
// 要讲清楚的核心事实：预留 ≠ 提交。256MB 只是虚拟地址，物理内存按 Pool 逐个 commit；
// 而 Pool 是"第一次用到才建"的，所以空跑的分配器几乎不占物理内存。
// ============================================================================

const BLOCK_MB = 256 // kReserveBlockGranularity (PC 64 位)
const POOL_MB = 16 // kDynamicHeapChunkSize

const poolsPerBlock = BLOCK_MB / POOL_MB // = 16

// 每个 Pool 的状态：created 表示已向系统 commit 了 16MB
const pools = ref(
  Array.from({ length: poolsPerBlock }, (_, i) => ({
    index: i,
    created: false,
    usedMB: 0,
    allocs: [],
  }))
)

const largeAllocs = ref([]) // 绕过 Pool 的大块
const log = ref([])
const nextId = ref(1)

function pushLog(text, kind = 'info') {
  log.value.unshift({ text, kind })
  if (log.value.length > 30) log.value.pop()
}

// 当前"有容量"的 Pool（已创建且未满）
function firstPoolWithRoom(sizeMB) {
  return pools.value.find((p) => p.created && p.usedMB + sizeMB <= POOL_MB)
}

function shouldGoLarge(sizeMB) {
  // 判据来自源码：size < m_RequestedPoolSize / 2 才建池，否则 LargeAlloc（DynamicHeapAllocator.cpp:454）
  return sizeMB >= POOL_MB / 2
}

function allocate(sizeMB, label) {
  const size = sizeMB

  if (shouldGoLarge(size)) {
    largeAllocs.value.push({ id: nextId.value++, sizeMB: size, label })
    pushLog(
      `申请 ${size}MB ≥ Pool 的一半（${POOL_MB / 2}MB）→ 判据 size < m_RequestedPoolSize/2 不成立，**绕开 Pool 直通 LargeAlloc**（DynamicHeapAllocator.cpp:454）`,
      'large'
    )
    return
  }

  let p = firstPoolWithRoom(size)
  if (p) {
    p.usedMB += size
    p.allocs.push({ size, label })
    pushLog(`申请 ${size}MB → Pool #${p.index + 1} 里 TLSF 直接切一块返回（命中主路径）`, 'hit')
    return
  }

  // 需要新建 Pool
  const empty = pools.value.find((x) => !x.created)
  if (!empty) {
    largeAllocs.value.push({ id: nextId.value++, sizeMB: size, label })
    pushLog(`16 个 Pool 都建满了，${size}MB 只能走 LargeAlloc`, 'large')
    return
  }
  empty.created = true
  empty.usedMB = size
  empty.allocs.push({ size, label })
  pushLog(
    `申请 ${size}MB → 现有 Pool 都装不下 → CreateTLSFPool 从预留里切出 **Pool #${empty.index + 1}**（16MB）并 tlsf_add_pool，然后重试成功（DynamicHeapAllocator.cpp:294）`,
    'newpool'
  )
}

function reset() {
  pools.value.forEach((p) => {
    p.created = false
    p.usedMB = 0
    p.allocs = []
  })
  largeAllocs.value = []
  log.value = []
  nextId.value = 1
}

// 常用尺寸按钮（贴近真实场景）
const PRESETS = [
  { size: 1, label: '1MB 贴图 mip', hint: '典型小块' },
  { size: 6, label: '6MB 网格数据', hint: '能进池' },
  { size: 7, label: '7MB 音频包', hint: '刚好 < 8MB 仍进池' },
  { size: 8, label: '8MB 大贴图', hint: '等于 Pool/2，被判定为大块' },
  { size: 24, label: '24MB AB 包', hint: '远超 Pool/2' },
]

const committedMB = computed(
  () => pools.value.filter((p) => p.created).length * POOL_MB
)
const poolUsedMB = computed(() =>
  pools.value.reduce((s, p) => s + p.usedMB, 0)
)
const largeMB = computed(() => largeAllocs.value.reduce((s, l) => s + l.sizeMB, 0))

// 预留块视图：16 个槽位
const slotBlocks = computed(() =>
  pools.value.map((p) => ({
    label: p.created ? `Pool#${p.index + 1} 用 ${p.usedMB}MB` : `空槽#${p.index + 1}`,
    size: POOL_MB,
    kind: p.created ? (p.usedMB >= POOL_MB ? 'used' : 'pad') : 'free',
    note: p.created
      ? `已向系统 commit 16MB；TLSF 已用 ${p.usedMB}MB，余 ${POOL_MB - p.usedMB}MB 空闲`
      : '仅存在于虚拟地址空间，未 commit，不占物理内存',
  }))
)
</script>

<template>
  <div class="pl-root">
    <h3 class="pl-h3">🗂 256MB 的预留块里，Pool 是"用到才建"的</h3>
    <p class="pl-sub">
      PC 64 位上，Unity 一次性<b>预留</b>（reserve）256MB 虚拟地址，切成 16 个 16MB 的 Pool 槽位；
      但<b>只有真正用到的槽位才会 commit 物理内存</b>。点下面的按钮模拟不同大小的分配，观察哪一步会新建 Pool、哪一步会绕开 Pool。
    </p>

    <div class="pl-panel">
      <div class="pl-presets">
        <button v-for="p in PRESETS" :key="p.size" class="pl-btn" @click="allocate(p.size, p.label)">
          <span class="pl-btn-name">+ {{ p.label }}</span>
          <span class="pl-btn-hint">{{ p.hint }}</span>
        </button>
      </div>
      <button class="pl-btn pl-btn-ghost" @click="reset">⟲ 重置</button>
    </div>

    <!-- 256MB 预留块 -->
    <div class="pl-blockmap">
      <div class="pl-blockmap-title">一块 256MB 虚拟预留（kReserveBlockGranularity = 1&lt;&lt;28）</div>
      <MemoryMap
        :blocks="slotBlocks"
        :px-per-byte="0.35"
        :min-block-px="46"
        base-label="预留基址"
        :show-ticks="false"
      />
    </div>

    <!-- 统计 -->
    <div class="pl-stat">
      <span>已 commit（物理内存）<b class="c-used">{{ committedMB }} MB</b></span>
      <span>Pool 内已用 <b>{{ poolUsedMB }} MB</b></span>
      <span>LargeAlloc 独立块 <b class="c-large">{{ largeMB }} MB</b></span>
      <span>预留总量 <b>{{ BLOCK_MB }} MB</b>（仅虚拟地址）</span>
    </div>

    <!-- LargeAlloc 独立区 -->
    <div v-if="largeAllocs.length" class="pl-large">
      <div class="pl-large-title">
        LargeAlloc 独立块（不走 TLSF，直接要虚拟页；释放时整块还给系统）
      </div>
      <MemoryMap
        :blocks="largeAllocs.map((l) => ({
          label: `${l.label}`,
          size: l.sizeMB,
          kind: 'waste',
          note: '独立预留 + 提交，与 Pool 内小块世界完全隔离',
        }))"
        :px-per-byte="6"
        :min-block-px="52"
        :show-ticks="false"
      />
    </div>

    <!-- 日志 -->
    <div class="pl-log">
      <div class="pl-log-head">决策日志</div>
      <ul>
        <li v-for="(l, i) in log.slice(0, 10)" :key="i" :class="'k-' + l.kind" v-html="l.text" />
        <li v-if="!log.length" class="pl-log-empty">还没有分配，点上面的按钮试试</li>
      </ul>
    </div>

    <div class="pl-foot">
      <b>三个容易搞混的概念</b>
      <ol>
        <li>
          <b>预留（reserve）≠ 提交（commit）。</b>256MB 只是"我把这段地址圈起来了，别人别用"，
          物理内存一个字节都没占。commit 才真正付出物理内存。所以 Unity 的"预留 256MB"
          在任务管理器里看不到 256MB。
        </li>
        <li>
          <b>Pool 是懒创建的。</b>`InitializeTLSF()` 只建 TLSF 的控制结构（位图 + 800 个链表头），
          <b>不建任何 Pool</b>。第一次分配时 `CreateTLSFPool` 才切第一个 16MB 出来。
        </li>
        <li>
          <b>大块必须绕开 Pool。</b>判据是 <code>size &lt; m_RequestedPoolSize / 2</code>。
          一个 10MB 的分配塞进 16MB 的 Pool，就把这个 Pool 废掉了——想通这点，
          就理解了为什么要在池外单独开一条 LargeAlloc 通道。
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.pl-root { margin: 22px 0; }
.pl-h3 { margin: 0 0 8px; }
.pl-sub { font-size: 13px; line-height: 1.8; color: var(--vp-c-text-2); margin: 0 0 12px; }

.pl-panel {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-start;
  margin-bottom: 12px;
}
.pl-presets { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
.pl-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  border-radius: 8px;
  padding: 5px 10px;
  cursor: pointer;
  text-align: left;
}
.pl-btn:hover { border-color: var(--vp-c-brand-1); }
.pl-btn-name { font-size: 12.5px; font-weight: 600; color: var(--vp-c-text-1); }
.pl-btn-hint { font-size: 10.5px; color: var(--vp-c-text-3); }
.pl-btn-ghost { color: var(--vp-c-text-3); justify-content: center; }

.pl-blockmap {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
}
.pl-blockmap-title { font-size: 12px; color: var(--vp-c-text-2); margin-bottom: 8px; }

.pl-stat {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin: 8px 0 0;
}
.pl-stat b { color: var(--vp-c-text-1); }
.c-used { color: #2F9E44 !important; }
.c-large { color: #E03131 !important; }

.pl-large {
  margin-top: 12px;
  border: 1px solid #FFC9C9;
  border-radius: 10px;
  padding: 10px 12px;
  background: #FFF5F5;
}
.pl-large-title { font-size: 12px; color: #C92A2A; margin-bottom: 8px; }

.pl-log {
  margin-top: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  padding: 8px 12px;
}
.pl-log-head { font-size: 11.5px; color: var(--vp-c-text-3); margin-bottom: 6px; }
.pl-log ul { margin: 0; padding: 0; list-style: none; max-height: 200px; overflow-y: auto; }
.pl-log li {
  font-size: 12px;
  line-height: 1.65;
  padding: 4px 0;
  border-bottom: 1px dashed var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.pl-log li:last-child { border-bottom: 0; }
.k-hit { color: #2F9E44; }
.k-newpool { color: #AE3EC9; font-weight: 600; }
.k-large { color: #E03131; }
.pl-log-empty { color: var(--vp-c-text-3); font-style: italic; }

.pl-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.pl-foot b { color: var(--vp-c-text-1); }
.pl-foot ol { margin: 6px 0 0; padding-left: 20px; }
.pl-foot li { margin-bottom: 6px; }
.pl-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
