<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// AbaSimulator —— 无锁栈的 ABA 事故现场 + DCAS 版本号如何化解
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\Runtime\Threads\AtomicQueue.h
//   :16      源码注释："second word in atomic_word2 is for counter to avoid ABA problem"
//   :39      class alignas(PLATFORM_CACHE_LINE_SIZE) AtomicStack
//   :41-44   ATOMIC_HAS_DCAS 分支：有 DCAS 用 atomic_word2(128 位)，没有退化为 atomic_word
//   :56      AtomicNode *Pop();
//   :30      注释："Any thread can Push / Pop nodes to the stack."
//   Pop 实现见 AtomicQueue.cpp（本页演示聚焦并发时序，不逐行贴实现）
//
// 演示两条时间线（同一个并发交错，开关只差"版本号"这一项）：
//   关掉 DCAS → CAS 比较 64 位指针：A 回来了就被骗过 → 栈顶指向已被复用的 B → 双重分配
//   打开 DCAS → CAS 比较 128 位整体：版本号对不上 → 失败重试 → 安然无恙
// ============================================================================

const useDcas = ref(true)
const stepIdx = ref(0)

// 时间线：每一步给出两个线程的动作、栈状态、以及"此刻 CAS 会怎样"
const TIMELINE = [
  {
    actor: '初始',
    action: '栈是 A → B → C，栈顶 top = A，版本号 v = 1',
    stack: ['A', 'B', 'C'],
    top: 'A',
    ver: 1,
    t1Note: '线程 1 还没开始',
    t2Note: '线程 2 还没开始',
  },
  {
    actor: '线程 1',
    action: 'Pop：读到 top = A，并且算好 newtop = B，准备执行 CAS(&top, A, B)',
    stack: ['A', 'B', 'C'],
    top: 'A',
    ver: 1,
    t1Note: '已读到旧值 A，即将 CAS',
    t2Note: '还没动',
  },
  {
    actor: '线程 1',
    action: '⏸ 被操作系统调度挂起（就这一瞬间，事故有了窗口）',
    stack: ['A', 'B', 'C'],
    top: 'A',
    ver: 1,
    t1Note: '挂起中…手里攥着"A → B"这个计划',
    t2Note: '还没动',
  },
  {
    actor: '线程 2',
    action: 'Pop A：top 变成 B，版本号 +1',
    stack: ['B', 'C'],
    top: 'B',
    ver: 2,
    t1Note: '仍挂起',
    t2Note: '拿到 A',
  },
  {
    actor: '线程 2',
    action: 'Pop B：top 变成 C，版本号 +1。B 这块内存被挪作他用（比如当成新桶的数据区）',
    stack: ['C'],
    top: 'C',
    ver: 3,
    t1Note: '仍挂起',
    t2Note: '拿到 B（B 随后被复用）',
  },
  {
    actor: '线程 2',
    action: '把 A push 回来：top = A，版本号 +1。注意——**栈顶的"值"又变回 A 了**',
    stack: ['A', 'C'],
    top: 'A',
    ver: 4,
    t1Note: '仍挂起',
    t2Note: 'A 被放回栈顶',
  },
  {
    actor: '线程 1',
    action: '恢复执行 CAS(&top, A, B)',
    stack: ['A', 'C'],
    top: 'A',
    ver: 4,
    t1Note: '执行 CAS 中…',
    t2Note: '已完成',
    isCas: true,
  },
]

const cur = computed(() => TIMELINE[Math.min(stepIdx.value, TIMELINE.length - 1)])
const atCas = computed(() => stepIdx.value >= TIMELINE.length - 1)

// CAS 结果：只比指针 → 成功（错）；比 128 位 → 失败（对）
const casResult = computed(() => {
  if (!atCas.value) return null
  return useDcas.value ? 'fail' : 'succeed'
})

// 模拟"如果 CAS 成功"的后果
const corrupted = computed(() => atCas.value && !useDcas.value)

// 栈最终状态（CAS 成功时会把 B 塞回栈顶，而 B 已被复用）
const finalStack = computed(() => {
  if (!corrupted.value) return ['A', 'C']
  return ['B(已被复用!)', 'C']
})

function next() {
  if (stepIdx.value < TIMELINE.length - 1) stepIdx.value++
}
function prev() {
  if (stepIdx.value > 0) stepIdx.value--
}
function reset() {
  stepIdx.value = 0
}

// DCAS 模式的"重试"演示
const retryCount = ref(0)
function doRetry() {
  retryCount.value++
}
</script>

<template>
  <div class="aba-root">
    <h3 class="aba-h3">💥 ABA 事故现场：同一个指针值，两个不同的世界</h3>
    <p class="aba-sub">
      无锁栈只用一个 CAS 就能安全工作——除非有人把<strong>已经弹出去的节点又放回来</strong>。
      下面这条时间线是真实会发生的一种交错。先关掉 DCAS 看它怎么翻车，再打开看版本号怎么救场。
    </p>

    <!-- DCAS 开关 —— 整个演示的核心对照 -->
    <div class="aba-toggle">
      <button class="aba-switch" :class="{ on: useDcas }" @click="useDcas = !useDcas; reset()">
        <span class="aba-switch-knob" />
        <span class="aba-switch-label">
          {{ useDcas ? '已开启：DCAS + 版本号（128 位比较）' : '已关闭：只比较指针（64 位 CAS）' }}
        </span>
      </button>
      <span class="aba-toggle-hint">
        源码依据：<code>AtomicQueue.h:41-44</code> —— <code>ATOMIC_HAS_DCAS</code> 分支决定用
        <code>atomic_word2</code>（指针 + 版本号）还是单字
      </span>
    </div>

    <!-- 时间线控制 -->
    <div class="aba-ctrl">
      <button class="aba-btn" @click="reset">⏮ 回到开头</button>
      <button class="aba-btn" @click="prev" :disabled="stepIdx === 0">◀ 上一步</button>
      <button class="aba-btn aba-btn-main" @click="next" :disabled="atCas">下一步 ▶</button>
      <span class="aba-progress">第 {{ stepIdx + 1 }} / {{ TIMELINE.length }} 步</span>
    </div>

    <div class="aba-stage">
      <!-- 栈状态 -->
      <div class="aba-stackbox">
        <div class="aba-stack-title">栈状态（栈顶在左）</div>
        <div class="aba-stack">
          <div
            v-for="(n, i) in (atCas ? finalStack : cur.stack)"
            :key="i"
            class="aba-node"
            :class="{ top: i === 0 && !corrupted, danger: String(n).includes('复用') }"
          >
            <span class="aba-node-name">{{ n }}</span>
            <span v-if="i === 0 && !corrupted" class="aba-node-tag">top</span>
            <span v-if="String(n).includes('复用')" class="aba-node-tag">已复用</span>
          </div>
          <span class="aba-null">→ null</span>
        </div>
        <div class="aba-topfield">
          <div class="aba-field">
            <span class="aba-field-name">top 指针 (lo)</span>
            <span class="aba-field-val">{{ atCas && corrupted ? 'B' : cur.top }}</span>
          </div>
          <div class="aba-field" :class="{ live: useDcas }">
            <span class="aba-field-name">版本号 (hi)</span>
            <span class="aba-field-val">{{ cur.ver }}</span>
            <span v-if="!useDcas" class="aba-field-off">未启用</span>
          </div>
        </div>
      </div>

      <!-- 当前动作 -->
      <div class="aba-actionbox">
        <div class="aba-actor" :class="cur.actor === '线程 1' ? 't1' : cur.actor === '线程 2' ? 't2' : 'init'">
          {{ cur.actor }}
        </div>
        <p class="aba-action" v-html="cur.action" />

        <div class="aba-notes">
          <div class="aba-note t1"><b>线程 1</b>{{ cur.t1Note }}</div>
          <div class="aba-note t2"><b>线程 2</b>{{ cur.t2Note }}</div>
        </div>
      </div>
    </div>

    <!-- CAS 判定 —— 全部意义所在 -->
    <div v-if="atCas" class="aba-verdict" :class="casResult">
      <template v-if="casResult === 'succeed'">
        <div class="aba-verdict-title">❌ CAS 成功 —— 但这是灾难</div>
        <p>
          CAS 比较的是 <code>top</code> 那 64 位。线程 1 手里记的是"A"，
          而此刻栈顶<strong>确实又是 A</strong>（线程 2 把它放回来了），所以比较通过、替换执行。
        </p>
        <p>
          问题是线程 1 组装的新栈顶是 <strong>B</strong>——而 B 早已被弹出、并且<strong>已经被挪作他用</strong>。
          结果：栈顶指向一块正在被别人写的数据。在 <code>BucketAllocator</code> 的场景里，
          AtomicNode 就是内存桶本身，这意味着两个线程可能同时拿到同一个桶——
          <strong>等价于双重分配</strong>，后续写内存会互相覆盖。
        </p>
        <p class="aba-verdict-key">
          根因一句话：<b>CAS 只比较"值"，不比较"历史"。</b>
          地址 A 经历"弹出 → 放回"之后，值相同，但世界已经变了。
        </p>
      </template>
      <template v-else>
        <div class="aba-verdict-title">✅ CAS 失败 —— 这正是我们要的</div>
        <p>
          开启 DCAS 后，<code>_top</code> 是一个 <strong>128 位</strong>整体：低 64 位是指针，高 64 位是版本号。
          每次成功修改都会让版本号 +1。
        </p>
        <p>
          线程 1 记下的是 <code>{A, v1}</code>，而此刻内存里是 <code>{A, v4}</code>——
          指针那半对得上，<strong>版本号对不上</strong>，于是 CAS 整体失败。
        </p>
        <p class="aba-verdict-key">
          线程 1 只需要重读栈顶再来一次。ABA 序列从 <code>A→B→A</code> 变成了
          <code>A(v1)→B(v2)→A(v4)</code>——<b>永不相等</b>。
        </p>
        <div class="aba-retry">
          <button class="aba-btn aba-btn-main" @click="doRetry">模拟线程 1 重试一次</button>
          <span v-if="retryCount" class="aba-retry-info">
            已重试 {{ retryCount }} 次；真实实现里这是个 do-while 循环，重试直到成功
          </span>
        </div>
      </template>
    </div>

    <div class="aba-foot">
      <b>为什么这个坑对 BucketAllocator 特别致命</b>
      <p>
        其他地方 ABA 顶多导致"数据不对"，可以事后发现。<code>BucketAllocator</code> 的无锁栈里，
        栈节点<strong>就是内存块本身</strong>——Pop 出来的瞬间就会被写用户数据。
        如果两个线程因为 ABA 拿到同一个节点，它们会同时往同一块内存里写，
        表现为两块互不相干的逻辑内存互相污染。这种 bug 极难复现（要精确的线程交错），
        也极难定位（现象和"野指针"一模一样）。
      </p>
      <p>
        <b>代价是什么？</b> 128 位 CAS 需要 x64 的 <code>cmpxchg16b</code> 指令支持，
        而且必须 16 字节对齐——所以源码里能看到
        <code>class alignas(PLATFORM_CACHE_LINE_SIZE)</code>（`AtomicQueue.h:39`）
        这种缓存行对齐的写法：既满足对齐要求，也避免伪共享。
        不支持 DCAS 的平台只能退回单字原子操作，ABA 防护就得换别的办法（比如 LL/SC 或危险指针）。
      </p>
    </div>
  </div>
</template>

<style scoped>
.aba-root { margin: 22px 0; }
.aba-h3 { margin: 0 0 8px; }
.aba-sub { font-size: 13px; line-height: 1.8; color: var(--vp-c-text-2); margin: 0 0 12px; }

.aba-toggle {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.aba-switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #FFC9C9;
  background: #FFF5F5;
  border-radius: 24px;
  padding: 6px 16px 6px 8px;
  cursor: pointer;
  align-self: flex-start;
}
.aba-switch.on { border-color: #B2F2BB; background: #EBFBEE; }
.aba-switch-knob {
  width: 34px;
  height: 18px;
  border-radius: 10px;
  background: #E03131;
  position: relative;
  flex: 0 0 auto;
  transition: background 0.2s;
}
.aba-switch.on .aba-switch-knob { background: #2F9E44; }
.aba-switch-knob::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.aba-switch.on .aba-switch-knob::after { transform: translateX(16px); }
.aba-switch-label { font-size: 12.5px; font-weight: 600; color: var(--vp-c-text-1); }
.aba-toggle-hint { font-size: 11.5px; color: var(--vp-c-text-3); }
.aba-toggle-hint code {
  font-family: var(--vp-font-family-mono);
  background: var(--vp-code-bg);
  padding: 1px 4px;
  border-radius: 3px;
}

.aba-ctrl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.aba-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.aba-btn:hover:not(:disabled) { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.aba-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.aba-btn-main { background: var(--vp-c-brand-1); border-color: var(--vp-c-brand-1); color: #fff; font-weight: 600; }
.aba-btn-main:hover:not(:disabled) { color: #fff; opacity: 0.9; }
.aba-progress { font-size: 11.5px; color: var(--vp-c-text-3); margin-left: auto; }

.aba-stage {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@media (max-width: 820px) { .aba-stage { grid-template-columns: 1fr; } }

.aba-stackbox, .aba-actionbox {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
}
.aba-stack-title { font-size: 11.5px; color: var(--vp-c-text-3); margin-bottom: 8px; }

.aba-stack { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.aba-node {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  position: relative;
  transition: all 0.2s;
}
.aba-node.top { border-color: var(--vp-c-brand-1); box-shadow: 0 0 0 2px var(--vp-c-brand-soft); font-weight: 700; }
.aba-node.danger { border-color: #E03131; background: #FFF5F5; color: #C92A2A; box-shadow: 0 0 0 2px #FFC9C9; }
.aba-node-tag {
  font-size: 9px;
  font-family: inherit;
  background: var(--vp-c-text-3);
  color: #fff;
  border-radius: 8px;
  padding: 0 5px;
}
.aba-node.top .aba-node-tag { background: var(--vp-c-brand-1); }
.aba-node.danger .aba-node-tag { background: #E03131; }
.aba-null { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-3); }

.aba-topfield { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.aba-field {
  flex: 1;
  min-width: 120px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--vp-c-bg);
  position: relative;
}
.aba-field.live { border-color: #B2F2BB; background: #EBFBEE; }
.aba-field-name { display: block; font-size: 10.5px; color: var(--vp-c-text-3); }
.aba-field-val { display: block; font-family: var(--vp-font-family-mono); font-size: 15px; font-weight: 700; color: var(--vp-c-text-1); }
.aba-field-off {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 9.5px;
  color: #E03131;
}

.aba-actor {
  display: inline-block;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 10px;
  padding: 1px 10px;
  margin-bottom: 6px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.aba-actor.t1 { border-color: #A5D8FF; background: #E7F5FF; color: #1971C2; }
.aba-actor.t2 { border-color: #FFE066; background: #FFF9DB; color: #E8590C; }

.aba-action { font-size: 13px; line-height: 1.8; color: var(--vp-c-text-1); margin: 0 0 10px; }
.aba-action b { color: #E03131; }

.aba-notes { display: flex; flex-direction: column; gap: 4px; }
.aba-note {
  font-size: 12px;
  color: var(--vp-c-text-2);
  border-left: 3px solid var(--vp-c-divider);
  padding: 3px 8px;
  background: var(--vp-c-bg);
  border-radius: 0 5px 5px 0;
}
.aba-note b { margin-right: 6px; color: var(--vp-c-text-1); }
.aba-note.t1 { border-left-color: #4C6EF5; }
.aba-note.t2 { border-left-color: #F59F00; }

.aba-verdict {
  margin-top: 12px;
  border-radius: 10px;
  padding: 12px 14px;
  border: 1px solid;
}
.aba-verdict.succeed { background: #FFF5F5; border-color: #FFC9C9; }
.aba-verdict.fail { background: #EBFBEE; border-color: #B2F2BB; }
.aba-verdict-title { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
.aba-verdict.succeed .aba-verdict-title { color: #C92A2A; }
.aba-verdict.fail .aba-verdict-title { color: #2B8A3E; }
.aba-verdict p { font-size: 12.5px; line-height: 1.8; color: var(--vp-c-text-2); margin: 0 0 6px; }
.aba-verdict code {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--vp-c-text-1);
}
.aba-verdict-key { font-size: 13px !important; color: var(--vp-c-text-1) !important; }
.aba-retry { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.aba-retry-info { font-size: 11.5px; color: var(--vp-c-text-3); }

.aba-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.aba-foot b { color: var(--vp-c-text-1); }
.aba-foot p { margin: 6px 0 0; }
.aba-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
