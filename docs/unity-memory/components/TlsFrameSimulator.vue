<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// TlsFrameSimulator —— 每线程临时栈：帧内分配 / 帧末整体回收
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\Runtime\Allocator\TLSAllocator.cpp /
//          StackAllocator.cpp / StackAllocator.h（行号实查，见 steps 内 src.line）
//
// 要讲清的核心事实（源码依据）：
//   ① 每线程一个 StackAllocator，指针存在 TLS 里   TLSAllocator.cpp:10
//   ② 线程首次分配才创建，不是启动就建            TLSAllocator.cpp:54
//   ③ 分配 = 栈顶（m_LastAlloc）上移，不搜索空闲块  StackAllocator.cpp:75
//   ④ 帧末 FrameMaintenance → Reset，整栈 O(1) 回收 TLSAllocator.cpp:134
//   ⑤ 线程退出把内存块压回复用池，新线程优先复用   TLSAllocator.cpp:124 / :92
//   ⑥ 栈块按需 commit：越界才扩，不是一次给满      StackAllocator.cpp:87
//
// 交互设计：可以"分配/释放/进入下一帧"，也可以"开一个新线程"，
// 每个线程一条独立的栈条 —— 让"无锁"这件事变成肉眼可见的"两条栈互不相干"。
// ============================================================================

const CAP_KB = 16 // 为画图方便取了小容量；真实起始 16MB(Editor)/4MB(Runtime)，见 TLSAllocator.h:19-22

let uid = 0

const threads = ref([
  { id: 1, name: '主线程', color: '#4C6EF5', initialized: false, blocks: [], nextAddr: 0, busy: false },
  { id: 2, name: '工作线程 A', color: '#12B886', initialized: false, blocks: [], nextAddr: 0, busy: false },
])

const frame = ref(1)
const log = ref([])
const activeThread = ref(1)

function pushLog(text, kind = 'info') {
  log.value.unshift({ id: ++uid, text, kind, frame: frame.value })
  if (log.value.length > 40) log.value.pop()
}

const thread = (id) => threads.value.find((t) => t.id === id)

function ensureInit(t) {
  if (t.initialized) return false
  t.initialized = true
  pushLog(`【${t.name}】首次分配 → ThreadInitialize：为这个线程 new 一个 StackAllocator，指针写进 TLS（TLSAllocator.cpp:54-58）`, 'init')
  return true
}

// 分配：栈顶顺序上移，不搜索、不合并
function doAlloc(tid, size, tag) {
  const t = thread(tid)
  ensureInit(t)
  t.blocks.push({ id: ++uid, size, tag, frame: frame.value })
  pushLog(`【${t.name}】Allocate(${size}B) → 栈顶直接上移，返回偏移 ${t.blocks.reduce((s, b) => s + b.size, 0) - size}（StackAllocator.cpp:75）`, 'alloc')
  activeThread.value = tid
}

// 释放：栈式分配器只支持"释放栈顶"（LIFO），这正好对应临时变量的作用域退出
function doFreeTop(tid) {
  const t = thread(tid)
  if (!t.blocks.length) {
    pushLog(`【${t.name}】栈是空的，没有可释放的块`, 'warn')
    return
  }
  const b = t.blocks[t.blocks.length - 1]
  t.blocks.pop()
  pushLog(`【${t.name}】Deallocate 栈顶那块 ${b.size}B（tag="${b.tag}"）—— 只能按后进先出释放（StackAllocator.cpp:156）`, 'free')
}

function nextFrame() {
  frame.value++
  threads.value.forEach((t) => {
    if (t.initialized && t.blocks.length) {
      const n = t.blocks.length
      const bytes = t.blocks.reduce((s, b) => s + b.size, 0)
      t.blocks = []
      pushLog(`【${t.name}】FrameMaintenance → Reset：整栈 ${n} 块 / ${bytes}B 一次性回收，O(1)（TLSAllocator.cpp:134-151）`, 'reset')
    }
  })
}

function newThread() {
  const n = threads.value.length + 1
  const t = {
    id: n,
    name: `工作线程 ${String.fromCharCode(64 + n)}`,
    color: ['#F59F00', '#AE3EC9', '#E8590C', '#1098AD'][n % 4],
    initialized: false,
    blocks: [],
    nextAddr: 0,
    busy: false,
  }
  threads.value.push(t)
  pushLog(`新线程创建（此时还没有 StackAllocator——它是惰性的，等第一次分配才建）`, 'init')
}

function exitThread(tid) {
  const i = threads.value.findIndex((t) => t.id === tid)
  if (i < 0 || threads.value.length <= 1) return
  const t = threads.value[i]
  pushLog(`【${t.name}】线程退出 → ThreadCleanup → ReturnBlock：内存块压回 m_AvailableBlocks 复用池，不还给系统（TLSAllocator.cpp:69-81 / :124）`, 'warn')
  threads.value.splice(i, 1)
}

function reset() {
  threads.value = [
    { id: 1, name: '主线程', color: '#4C6EF5', initialized: false, blocks: [], nextAddr: 0, busy: false },
    { id: 2, name: '工作线程 A', color: '#12B886', initialized: false, blocks: [], nextAddr: 0, busy: false },
  ]
  frame.value = 1
  log.value = []
  activeThread.value = 1
}

function usedBytes(t) {
  return t.blocks.reduce((s, b) => s + b.size, 0)
}

// 把一条线程的栈画成 MemoryMap 的块序列：
// [已提交但没用到的空间] 由"容量-已用"隐含，这里显式画出来让读者看到"栈顶之外还有余量"
function mapBlocks(t) {
  const out = []
  if (!t.initialized) {
    return [{ label: '未初始化（等第一次分配）', size: CAP_KB, kind: 'gap', note: '线程创建时并不分配栈，第一次 Allocate 才建' }]
  }
  t.blocks.forEach((b, i) => {
    out.push({
      label: `${b.tag} ${b.size}B`,
      size: b.size,
      kind: 'used',
      note: `第 ${i + 1} 块 · 帧 ${b.frame} 分配`,
    })
  })
  const used = usedBytes(t)
  const remain = (CAP_KB * 1024 - used) / 1024
  out.push({
    label: remain > 0.05 ? `余量 ${remain.toFixed(1)}KB` : '已满',
    size: Math.max(remain, 0.05),
    kind: 'free',
    note: '栈顶以上的空间；真实实现里这部分按需 commit（StackAllocator.cpp:87）',
  })
  return out
}

const totalUsed = computed(() => threads.value.reduce((s, t) => s + usedBytes(t), 0))

const PRESETS = [
  { tag: 'AABB 包围盒', size: 128 },
  { tag: '临时顶点数组', size: 2048 },
  { tag: '路径字符串', size: 256 },
  { tag: '临时 Transform 列表', size: 512 },
]
function quickAlloc(tid, p) {
  doAlloc(tid, p.size, p.tag)
}
</script>

<template>
  <div class="tf-root">
    <h3 class="tf-h3">🧵 每线程一条独立的栈：帧内随便分，帧末一键清</h3>
    <p class="tf-sub">
      点「分配」往某个线程的栈上放东西，点「下一帧」看整栈如何被一次性回收。
      注意<strong>两条线程的栈完全不相干</strong>——这就是"完全无锁"的直观含义：
      没有共享状态，也就没有锁可争。容量为了画图缩到 {{ CAP_KB }}KB（真实起始容量 Editor 16MB / Runtime 4MB）。
    </p>

    <!-- 操作面板 -->
    <div class="tf-panel">
      <div class="tf-group">
        <span class="tf-group-label">往哪个线程分配</span>
        <div class="tf-thread-pick">
          <button
            v-for="t in threads"
            :key="t.id"
            class="tf-tbtn"
            :class="{ on: activeThread === t.id }"
            :style="activeThread === t.id ? { borderColor: t.color, color: t.color } : {}"
            @click="activeThread = t.id"
          >
            <i class="tf-dot" :style="{ background: t.color }" />{{ t.name }}
          </button>
        </div>
      </div>

      <div class="tf-group">
        <span class="tf-group-label">分配点什么</span>
        <div class="tf-actions">
          <button v-for="p in PRESETS" :key="p.tag" class="tf-btn" @click="quickAlloc(activeThread, p)">
            + {{ p.tag }}（{{ p.size }}B）
          </button>
        </div>
      </div>

      <div class="tf-group">
        <span class="tf-group-label">帧与线程</span>
        <div class="tf-actions">
          <button class="tf-btn tf-btn-main" @click="nextFrame">⏭ 进入下一帧（FrameMaintenance）</button>
          <button class="tf-btn" @click="doFreeTop(activeThread)">− 释放栈顶</button>
          <button class="tf-btn" @click="newThread">+ 新建线程</button>
          <button
            v-if="threads.length > 1"
            class="tf-btn"
            @click="exitThread(activeThread === 1 ? threads[threads.length - 1].id : activeThread)"
          >
            − 退出选中线程
          </button>
          <button class="tf-btn tf-btn-ghost" @click="reset">⟲ 重置</button>
        </div>
      </div>
    </div>

    <!-- 栈视图 -->
    <div class="tf-stacks">
      <div v-for="t in threads" :key="t.id" class="tf-stack" :class="{ hot: activeThread === t.id }" @click="activeThread = t.id">
        <div class="tf-stack-head">
          <i class="tf-dot" :style="{ background: t.color }" />
          <b>{{ t.name }}</b>
          <span class="tf-stack-meta">
            {{ t.initialized ? `已用 ${usedBytes(t)}B · ${t.blocks.length} 块` : '栈尚未创建' }}
          </span>
        </div>
        <MemoryMap
          :blocks="mapBlocks(t)"
          :px-per-byte="0.16"
          :min-block-px="34"
          :show-ticks="false"
        />
      </div>
    </div>

    <div class="tf-stat">
      本帧所有线程合计占用 <b>{{ totalUsed }}B</b> ·
      当前第 <b>{{ frame }}</b> 帧 ·
      线程数 <b>{{ threads.length }}</b>
    </div>

    <!-- 操作日志 -->
    <div class="tf-log">
      <div class="tf-log-head">操作日志（每条都标注了对应的源码行）</div>
      <ul>
        <li v-for="l in log.slice(0, 12)" :key="l.id" :class="'k-' + l.kind">
          <span class="tf-log-frame">F{{ l.frame }}</span>{{ l.text }}
        </li>
        <li v-if="!log.length" class="tf-log-empty">还没有操作，点上面的按钮试试</li>
      </ul>
    </div>

    <!-- 源码对照 -->
    <CodeStepper
      file="Runtime/Allocator/TLSAllocator.cpp"
      :lines="[
        { n: 54, code: 'void TLSAllocator::ThreadInitialize(size_t threadStackSize)', note: '线程第一次分配时才调这里——栈是惰性创建的，线程光创建不用内存，就不建栈。' },
        { n: 58, code: 'void* stackAddress = GetNewBlock(threadStackSize, &commitSize, &reservedSize);', note: '优先从 m_AvailableBlocks 复用池里拿一块旧线程退回的内存，池空才向系统要。' },
        { n: 134, code: 'void TLSAllocator::FrameMaintenance(bool cleanup)', note: '帧末入口。它内部调 StackAllocator::FrameMaintenance/Reset，把栈顶直接拨回起点。' },
        { n: 69, code: 'void TLSAllocator::ThreadCleanup()', note: '线程退出：把内存块退回池子，而不是还给操作系统——下次新线程可以直接复用。' },
        { n: 124, code: 'void TLSAllocator::ReturnBlock(void* block, size_t commitSize, size_t reserveSize)', note: '退块的具体实现，进 m_AvailableBlocks 链表（受锁保护——但这是线程生死时的事，不在热路径上）。' }
      ]"
      :active="2"
      :vars="[
        { name: '线程数', value: String(threads.length) },
        { name: '当前帧', value: String(frame) },
        { name: '合计占用', value: totalUsed + 'B' }
      ]"
    />

    <div class="tf-foot">
      <b>为什么"帧末整体回收"是可行的？</b>
      <p>
        因为临时分配的生命周期天然受限于一帧。渲染一帧需要的临时几何、中间容器，
        帧画完就没用了。既然全都没用了，就不需要一个一个 free——
        <b>把栈顶指针拨回起点就是全部工作</b>，O(1)。
      </p>
      <p>
        代价是<b>不能跨帧持有</b>。把 <code>Allocator.Temp</code> 拿到的
        <code>NativeArray</code> 存进一个长期字段，下一帧它就是野指针——
        这类 bug 在 C# 侧通常表现为莫名其妙的随机数据损坏，而不是干脆崩溃，所以格外难查。
      </p>
    </div>
  </div>
</template>

<style scoped>
.tf-root { margin: 22px 0; }
.tf-h3 { margin: 0 0 8px; }
.tf-sub {
  font-size: 13px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  margin: 0 0 12px;
}

.tf-panel {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tf-group { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.tf-group-label { font-size: 11.5px; color: var(--vp-c-text-3); flex: 0 0 86px; }
.tf-thread-pick, .tf-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.tf-tbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  border-radius: 14px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.tf-tbtn.on { font-weight: 600; }

.tf-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.tf-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.tf-btn-main { background: var(--vp-c-brand-1); border-color: var(--vp-c-brand-1); color: #fff; font-weight: 600; }
.tf-btn-main:hover { color: #fff; opacity: 0.9; }
.tf-btn-ghost { color: var(--vp-c-text-3); }

.tf-stacks { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.tf-stack {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 8px 10px 2px;
  background: var(--vp-c-bg-soft);
  cursor: pointer;
}
.tf-stack.hot { box-shadow: 0 0 0 2px var(--vp-c-brand-soft); }
.tf-stack-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.tf-stack-meta { margin-left: auto; font-size: 11px; color: var(--vp-c-text-3); }
.tf-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

.tf-stat {
  margin-top: 8px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.tf-stat b { color: var(--vp-c-text-1); }

.tf-log {
  margin-top: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  padding: 8px 12px;
}
.tf-log-head { font-size: 11.5px; color: var(--vp-c-text-3); margin-bottom: 6px; }
.tf-log ul { margin: 0; padding: 0; list-style: none; max-height: 190px; overflow-y: auto; }
.tf-log li {
  font-size: 12px;
  line-height: 1.6;
  padding: 3px 0;
  border-bottom: 1px dashed var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.tf-log li:last-child { border-bottom: 0; }
.tf-log-frame {
  display: inline-block;
  min-width: 30px;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  color: var(--vp-c-text-3);
}
.k-init { color: #1971C2; }
.k-alloc { color: #2F9E44; }
.k-free { color: #E8590C; }
.k-reset { color: #AE3EC9; font-weight: 600; }
.k-warn { color: #E03131; }
.tf-log-empty { color: var(--vp-c-text-3); font-style: italic; }

.tf-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.tf-foot b { color: var(--vp-c-text-1); }
.tf-foot p { margin: 6px 0 0; }
.tf-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
