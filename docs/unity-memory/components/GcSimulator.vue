<template>
  <div class="gc-sim">
    <div class="controls">
      <button @click="allocObject" :disabled="allocCount >= MAX_OBJS || gcRunning">+ 分配对象</button>
      <button @click="breakRandomRef" :disabled="gcRunning">断开一个引用</button>
      <button class="primary" @click="runGC" :disabled="(phase === 'marking' || phase === 'sweeping') && !history.length">▶ 运行 GC</button>
      <button v-if="phase === 'marking' || phase === 'sweeping'" class="skip" @click="skip = true">⏩ 跳过</button>
      <button @click="reset" :disabled="false">重置</button>
    </div>

    <div class="toggles">
      <label class="toggle">
        <input type="checkbox" v-model="stepMode" />
        <span>单步模式（逐步学习）</span>
      </label>
      <label class="toggle">
        <input type="checkbox" v-model="conservative" @change="recompute" />
        <span>保守式扫描（整数误判为引用）</span>
      </label>
      <label class="toggle">
        <input type="checkbox" v-model="incremental" />
        <span>增量式 GC（3ms 时间片 × 3）</span>
      </label>
      <label class="toggle">
        <input type="checkbox" v-model="barrier" />
        <span>写屏障（增量式必需）</span>
      </label>
    </div>

    <!-- 单步面板：当前步骤说明 + 控制 -->
    <div v-if="phase === 'marking' || phase === 'sweeping'" class="step-panel">
      <div class="step-text">{{ currentStepText || '准备中…' }}</div>
      <div class="step-controls">
        <button class="prev" @click="prevStep" :disabled="!history.length || (!pendingSteps.length && phase === 'done' && !history.length)">◀ 上一步</button>
        <button v-if="stepMode" class="next" @click="nextStep" :disabled="!pendingSteps.length">下一步 ▶</button>
        <button v-if="stepMode" class="fast" @click="finishSteps">⏩ 自动完成</button>
      </div>
    </div>

    <div class="status">
      <span class="phase" :class="phase">{{ phaseLabel }}</span>
      <span v-if="gcRunning" class="stw-badge">⏸ STW 业务暂停</span>
      <span v-if="atPause" class="inc-badge">⏱ 时间片间隙·可操作</span>
      <span v-if="stepMode && (phase === 'marking' || phase === 'sweeping')" class="step-count">
        步骤 {{ totalSteps - pendingSteps.length }}/{{ totalSteps }}
      </span>
      <span class="stat">存活 <b>{{ liveCount }}</b></span>
      <span class="stat">垃圾 <b>{{ garbageCount }}</b></span>
      <span v-if="floatingCount > 0" class="stat floating">浮动垃圾 <b>{{ floatingCount }}</b> ⚠️</span>
      <span class="stat">分配次数 <b>{{ allocCount }}</b></span>
    </div>

    <div class="heap">
      <div class="roots">
        <div class="section-title">GC Roots（栈/静态区）</div>
        <div class="root-card">Root</div>
      </div>
      <div class="objects">
        <div class="section-title">
          托管堆
          <span class="hint">对象卡片 = 堆上的对象；箭头 = 引用字段</span>
        </div>
        <div class="object-grid">
          <div
            v-for="o in objects"
            :key="o.id"
            class="object-card"
            :class="{
              marked: o.marked,
              garbage: o.garbage,
              floating: o.floating,
              misjudged: o.misjudged,
              active: activeStepObj === o,
              live: phase === 'idle' && o.live && !o.garbage && !o.floating
            }"
          >
            <div class="obj-head">
              <span class="obj-id">obj{{ o.id }}</span>
              <span class="obj-size">{{ o.size }}B</span>
            </div>
            <div class="obj-refs">
              <span v-if="o.refs.length === 0" class="no-ref">无引用</span>
              <span v-for="r in o.refs" :key="r" class="ref">→ obj{{ r }}</span>
            </div>
            <div v-if="o.floating" class="misjudge-badge">⚠️ 误判存活</div>
            <div v-else-if="o.misjudged && !o.garbage" class="misjudge-badge">⚠️ 误引他物</div>
          </div>
        </div>
      </div>
    </div>

    <div class="log">
      <div v-for="(line, i) in log" :key="i" class="log-line">{{ line }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'

const MAX_OBJS = 60
let nextId = 9

const phase = ref('idle')
const conservative = ref(true)
const incremental = ref(false)
const barrier = ref(true)   // 写屏障（增量式正确性依赖；关掉演示漏标 bug）
const stepMode = ref(true)
const allocCount = ref(0)
const skip = ref(false)
const log = ref([])

// 单步引擎状态
const pendingSteps = ref([])
const currentStepText = ref('')
const activeStepObj = ref(null)
const totalSteps = ref(0)
const history = ref([])   // 快照栈：每步执行前的完整状态（支持「上一步」）

const objects = reactive([])

// 预设场景：8 个对象，引用关系形成一棵树 + 一个环
const seed = () => {
  objects.length = 0
  nextId = 1
  const spec = [
    { size: 64, refs: [2, 3] },
    { size: 32, refs: [4] },
    { size: 48, refs: [] },
    { size: 128, refs: [5, 6] },
    { size: 24, refs: [] },
    { size: 256, refs: [] },
    { size: 96, refs: [8] },
    { size: 40, refs: [2] },   // 环：8 → 2 → 4
  ]
  for (const s of spec) {
    objects.push({ id: nextId++, size: s.size, refs: [...s.refs], live: false, marked: false, garbage: false, floating: false, misjudged: false })
  }
}
seed()

const phaseLabel = computed(() => ({
  idle: '空闲',
  marking: '标记中…',
  sweeping: '清除中…',
  done: '完成',
}[phase.value]))

const liveCount = computed(() => objects.filter(o => !o.garbage).length)
const garbageCount = computed(() => objects.filter(o => o.garbage).length)
const floatingCount = computed(() => objects.filter(o => o.floating).length)

// 业务线程能否操作堆：非增量式 GC 是 STW（全程禁操作）；
// 增量式在「⏸ 时间片结束」步骤后解禁（atPause 标记当前停在时间片边界）
const atPause = ref(false)
const gcRunning = computed(() =>
  (phase.value === 'marking' || phase.value === 'sweeping') && !atPause.value
)

function addLog(msg) {
  log.value.unshift(msg)
  if (log.value.length > 8) log.value.pop()
}

function allocObject() {
  if (allocCount.value >= MAX_OBJS) return
  const id = nextId++
  const size = [16, 32, 48, 64, 96, 128, 256][Math.floor(Math.random() * 7)]
  objects.push({ id, size, refs: [], live: false, marked: false, garbage: false, floating: false, misjudged: false })
  allocCount.value++
  addLog(`分配 obj${id}（${size}B）`)
}

function breakRandomRef() {
  const withRefs = objects.filter(o => o.refs.length > 0)
  if (withRefs.length === 0) { addLog('没有可断开的引用'); return }
  const o = withRefs[Math.floor(Math.random() * withRefs.length)]
  const r = o.refs.splice(Math.floor(Math.random() * o.refs.length), 1)[0]
  addLog(`断开 obj${o.id} → obj${r}`)
}

// 从根出发的引用闭包（精确可达）
function reachableFromRoot() {
  const seen = new Set()
  const stack = objects.filter(o => o.fromRoot)
  while (stack.length) {
    const o = stack.pop()
    if (seen.has(o.id)) continue
    seen.add(o.id)
    for (const r of o.refs) {
      const target = objects.find(x => x.id === r)
      if (target) stack.push(target)
    }
  }
  return seen
}

// 保守式：模拟存活对象里的"整数字段"被误判成引用，指向某些真实垃圾对象
function simulateMisjudgedRefs(exactReachable) {
  const misjudged = new Set()
  if (!conservative.value) return misjudged
  const survivors = objects.filter(o => exactReachable.has(o.id))
  const candidates = objects.filter(o => !exactReachable.has(o.id))
  for (const src of survivors) {
    const words = Math.max(1, Math.floor(src.size / 8))
    for (const g of candidates) {
      if (Math.random() < 0.04 * words) misjudged.add(g.id)
    }
  }
  return misjudged
}

function conservativeReachable(base, misjudged) {
  const reach = new Set(base)
  for (const id of misjudged) reach.add(id)
  let changed = true
  while (changed) {
    changed = false
    for (const o of objects) {
      if (!reach.has(o.id)) continue
      for (const r of o.refs) {
        if (!reach.has(r)) {
          const t = objects.find(x => x.id === r)
          if (t) { reach.add(r); changed = true }
        }
      }
    }
  }
  return reach
}

function recompute() {
  for (const o of objects) o.fromRoot = false
  if (objects.length > 0) objects[0].fromRoot = true
  const base = reachableFromRoot()
  const misjudged = simulateMisjudgedRefs(base)
  const reach = conservative.value ? conservativeReachable(base, misjudged) : base
  for (const o of objects) {
    o.live = reach.has(o.id)
    o.garbage = !reach.has(o.id)
    o.floating = false
    o.misjudged = misjudged.has(o.id)
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms))

// ============ 单步引擎 ============

// 生成 GC 全流程步骤队列（每步含教学文案 + 视觉变化）
function buildGCSteps() {
  const steps = []
  for (const o of objects) { o.marked = false; o.garbage = false; o.floating = false; o.misjudged = false }

  // —— 预计算 ——
  const base = reachableFromRoot()
  const misjudged = simulateMisjudgedRefs(base)
  const reach = conservative.value ? conservativeReachable(base, misjudged) : base
  const floatingIds = new Set([...misjudged].filter(id => !base.has(id)))

  // BFS 标记顺序 + 每个对象的"为什么可达"文案
  const markOrder = []
  const seen = new Set()
  const stack = objects.filter(o => o.fromRoot)
  const reasonOf = {}
  while (stack.length) {
    const o = stack.pop()
    if (seen.has(o.id)) continue
    seen.add(o.id)
    markOrder.push(o)
    for (const r of o.refs) {
      const t = objects.find(x => x.id === r)
      if (t && !seen.has(t.id)) {
        reasonOf[t.id] = o.id
        stack.push(t)
      }
    }
  }
  const garbage = objects.filter(o => !reach.has(o.id))

  // —— 生成步骤 ——
  steps.push({ text: `① GC 开始：从 GC Roots（栈/静态区）出发，找出所有可达对象`, type: 'info' })
  const rootObj = objects.filter(o => o.fromRoot)
  for (const o of rootObj) {
    steps.push({
      text: `② 根引用：Root → obj${o.id}，obj${o.id} 从根直接可达 → 标记`,
      type: 'mark', obj: o,
      apply: () => { o.marked = true }
    })
  }
  for (const o of markOrder) {
    if (o.fromRoot) continue
    const via = reasonOf[o.id]
    steps.push({
      text: `③ 标记 obj${o.id}：obj${via} 引用它 → 沿引用链传递可达 → 标记`,
      type: 'mark', obj: o,
      apply: () => { o.marked = true }
    })
  }
  // 保守式误判（如果有）
  if (conservative.value && misjudged.size > 0) {
    const misObjs = objects.filter(o => misjudged.has(o.id))
    for (const m of misObjs) {
      const floating = floatingIds.has(m.id)
      steps.push({
        text: floating
          ? `⚠️ 保守式扫描：某存活对象的整数字段值恰好等于 obj${m.id} 的地址 → 被误判为引用（obj${m.id} 实际是垃圾！）`
          : `⚠️ 保守式扫描：obj${m.id} 被整数字段误判为引用`,
        type: 'misjudge', obj: m,
        apply: () => { m.misjudged = true; if (floating) m.floating = true }
      })
    }
  }
  steps.push({ text: `④ 标记完成：共 ${seen.size} 个对象可达${conservative.value && misjudged.size > 0 ? `（含 ${misjudged.size} 个误判存活）` : ''}`, type: 'info' })

  if (garbage.length > 0) {
    steps.push({ text: `⑤ 清除阶段开始：未被标记的对象就是垃圾`, type: 'info' })
    for (const g of garbage) {
      const floating = floatingIds.has(g.id)
      steps.push({
        text: floating
          ? `⑥ 扫描 obj${g.id}：无引用链 → 是垃圾。⚠️ 但它被误判引用，保守式认为它存活 → 本轮不回收（浮动垃圾）`
          : `⑥ 扫描 obj${g.id}：无任何可达引用 → 垃圾 → 回收`,
        type: 'sweep', obj: g,
        apply: () => { g.garbage = true; if (floating) g.floating = true }
      })
    }
  } else {
    steps.push({ text: `⑤ 清除阶段：没有垃圾对象，全部存活`, type: 'info' })
  }

  const realReclaimed = garbage.filter(g => !floatingIds.has(g.id)).length
  steps.push({
    text: realReclaimed > 0
      ? `⑦ GC 完成：回收 ${realReclaimed} 个垃圾对象${floatingIds.size > 0 ? `；${floatingIds.size} 个浮动垃圾留在堆上，下一轮 GC 再处理` : ''}`
      : (floatingIds.size > 0 ? `⑦ GC 完成：本轮回收 0 个，${floatingIds.size} 个垃圾全被误判存活（浮动垃圾）` : `⑦ GC 完成：本轮没有可回收对象`),
    type: 'info',
    apply: () => {
      if (floatingIds.size > 0) addLog('⚠️ 保守式扫描把整数字段误判成引用 → 浮动垃圾本轮收不掉，等下一轮 GC')
    }
  })

  // ============ 增量式：时间片切分 + 标记中途对象死亡 ============
  // 非增量：整场 GC 一次跑完（STW），业务线程完全暂停。
  // 增量式：标记切成 3 个 ≤3ms 时间片，**切片之间业务线程继续跑**——
  //   用户可以在时间片间隙「断开引用」，被断对象在标记开始后死亡 → 本轮收不掉（浮动垃圾）。
  //   写屏障保证中途改引用不漏标（三色不变式）；关掉写屏障则演示漏标 bug。
  if (incremental.value) {
    const markStepsIdx = steps.length
    // 找标记类步骤（type mark/misjudge）与首个清除步骤的位置，插入时间片边界
    const firstSweepIdx = steps.findIndex(s => s.type === 'sweep' || (s.type === 'info' && s.text.startsWith('⑤')))
    if (firstSweepIdx > 0) {
      const third = Math.max(1, Math.floor(firstSweepIdx / 3))
      // 在 1/3、2/3 处插入「时间片结束」步骤（倒序插入避免索引失效）
      const slices = [
        { at: firstSweepIdx - third * 2, n: 1 },
        { at: firstSweepIdx - third, n: 2 },
      ].filter(s => s.at > 0).sort((a, b) => b.at - a.at)
      for (const sl of slices) {
        steps.splice(sl.at, 0, {
          text: `⏸ 时间片 ${sl.n}/3 用完（≤3ms）→ 交还主线程跑业务帧，标记暂停（Root/白/灰/黑三色状态保持）`,
          type: 'pause',
          apply: () => addLog(`⏸ 增量式：时间片 ${sl.n}/3 结束，标记暂停——此刻可以「断开引用」/「分配对象」再点下一步`),
        })
      }
      // 标记完成后（清除阶段开始前）插入「中途死亡」演示步骤（写屏障/漏标分步讲解）
      const deadCandidates = objects.filter(o => reach.has(o.id) && !o.fromRoot && o.refs.length > 0)
      if (deadCandidates.length > 0) {
        const victim = deadCandidates[0]
        const willFloat = !barrier.value
        // 通用链路：标记开始 → 时间片间隙死亡 → 恢复标记 → 结局
        // 结合真实源码链（2020 LTS 实证）：
        //   il2cpp 写引用 = WriteBarrier::GenericStore (gc/WriteBarrier.cpp:6)
        //     → BoehmGC.cpp:205 SetWriteBarrier → GC_END_STUBBORN_CHANGE(ptr)
        //     → mallocx.c:614 GC_end_stubborn_change → GC_dirty(p)（标记所在页为脏页）
        //     → os_dep.c:3078 GC_dirty_inner: async_set_pht_entry_from_index(GC_dirty_pages, PHT_HASH(p))
        //   GC 恢复时: mark.c:266 GC_initiate_gc → GC_read_dirty 收脏页
        //     → mark.c:338 MS_PUSH_RESCUERS: GC_push_next_marked_dirty 只扫脏页上已标黑对象
        //     → 标黑后死亡的对象若有新写入（脏页）→ 重扫其引用 → 死亡可见 → 正确回收
        if (willFloat) {
          steps.push({
            text: `❌ 漏标演示 [1/2]：时间片间隙，业务线程把 obj${victim.id} 的引用断开（标记开始后才死亡）。此刻 obj${victim.id} 已经标黑——三色标记的规矩是"黑不再扫"`,
            type: 'barrier', obj: victim,
            apply: () => {
              victim.refs = []
              addLog(`⏱ 时间片间隙：obj${victim.id} 的引用被业务线程断开（标记开始后死亡）`)
            },
          })
          steps.push({
            text: `❌ 漏标演示 [2/2]：没有写屏障记录这次变化 → 恢复标记时 GC 不会重扫 obj${victim.id}（它不在任何脏页上）→ 本轮当存活放行 = 浮动垃圾。真实代码：漏掉 WriteBarrier::GenericStore 这一步，GC_dirty 永远不会被调`,
            type: 'barrier', obj: victim,
            apply: () => {
              victim.garbage = false
              victim.floating = true
              addLog(`❌ 无写屏障：obj${victim.id} 标黑后死亡 → 无脏页记录 → 不重扫 → 本轮放行（浮动垃圾）`)
            },
          })
        } else {
          steps.push({
            text: `🛡️ 写屏障 [1/3]：时间片间隙，业务线程把 obj${victim.id} 的引用断开。虽然对象已标黑，但刚才"改引用"这个动作本身留了痕——看代码：`,
            type: 'barrier', obj: victim,
            apply: () => {
              victim.refs = []
              addLog(`⏱ 时间片间隙：obj${victim.id} 的引用被业务线程断开（标记开始后死亡）`)
            },
          })
          steps.push({
            text: `🛡️ 写屏障 [2/3]：il2cpp 写引用必经 WriteBarrier::GenericStore (WriteBarrier.cpp:6)：先 *(void**)ptr = value 再 SetWriteBarrier(ptr) → BoehmGC.cpp:205 GC_END_STUBBORN_CHANGE → mallocx.c:616 GC_dirty(p) → os_dep.c:3078 把 obj 所在页记进 GC_dirty_pages 脏页表`,
            type: 'barrier', obj: victim,
            apply: () => {
              addLog('🛡️ 写屏障：改引用的内存页被记入 GC_dirty_pages（脏页表）')
            },
          })
          steps.push({
            text: `🛡️ 写屏障 [3/3]：GC 恢复标记（mark.c:331 MS_PUSH_RESCUERS）只扫脏页：GC_push_next_marked_dirty → obj${victim.id} 所在页是脏的 → 重扫发现引用已断 → 置灰重标 → 清除阶段确认死亡回收。三色不变式补上了`,
            type: 'barrier', obj: victim,
            apply: () => {
              victim.marked = false
              victim.garbage = true
              addLog(`🛡️ 写屏障：恢复标记重扫脏页 → obj${victim.id} 重新置灰 → 确认死亡，本轮回收`)
            },
          })
        }
      }
      // 开场说明
      steps.unshift({
        text: `⏱ 增量式模式：标记切 3 个 ≤3ms 时间片，切片间业务线程照常跑（可断引用/分配）——代价是需要写屏障维持三色不变式`,
        type: 'info',
        apply: () => addLog('⏱ 增量式 GC：时间片模式，注意每个 ⏸ 处可以操作对象'),
      })
      void markStepsIdx
    }
  }
  return steps
}

async function runGC() {
  // 回退后 phase 可能停在 marking/sweeping——此时运行按钮允许重新起跑
  if ((phase.value === 'marking' || phase.value === 'sweeping') && !history.value.length) return
  skip.value = false
  atPause.value = false
  history.value = []
  log.value = []
  addLog(incremental.value ? 'GC 开始（增量式：3 个时间片，⏸ 处业务线程可操作）' : 'GC 开始（STW：全程暂停业务线程，不能操作对象）')
  phase.value = 'marking'
  activeStepObj.value = null

  pendingSteps.value = buildGCSteps()
  totalSteps.value = pendingSteps.value.length

  if (stepMode.value) {
    // 单步模式：显示第一步，等待用户点"下一步"
    currentStepText.value = pendingSteps.value[0]?.text || ''
  } else {
    // 自动模式：逐条播放
    await finishSteps()
  }
}

// 执行一步（单步模式点击"下一步"，或自动模式逐条调用）
function execStep(s) {
  if (s.obj) activeStepObj.value = s.obj
  if (s.type === 'sweep' && phase.value !== 'sweeping') phase.value = 'sweeping'
  if (s.type === 'info' && s.text.startsWith('⑤')) phase.value = 'sweeping'
  // 增量式时间片边界：暂停后业务线程解禁；下一个标记步骤恢复"GC 运行中"
  if (s.type === 'pause') atPause.value = true
  else if (atPause.value && (s.type === 'mark' || s.type === 'misjudge' || s.type === 'barrier' || (s.type === 'info' && s.text.startsWith('⑤')))) atPause.value = false
  if (s.apply) s.apply()
  // 日志（仅关键步骤）
  if (s.type === 'misjudge' || s.type === 'pause' || s.type === 'barrier' || (s.type === 'info' && (s.text.includes('⑦') || s.text.startsWith('⏱')))) addLog(s.text.replace(/^[①②③④⑤⑥⑦⏱]\s*/, ''))
}

function nextStep() {
  if (!pendingSteps.value.length) return
  const s = pendingSteps.value.shift()
  // 执行前拍快照（对象状态 + 剩余步骤 + 阶段）→ 供「上一步」回退
  history.value.push({
    objs: objects.map(o => ({ ...o, refs: [...o.refs] })),
    pending: pendingSteps.value.map(x => x),
    phase: phase.value,
    atPause: atPause.value,
    text: currentStepText.value,
    active: activeStepObj.value?.id ?? null,
  })
  if (history.value.length > 80) history.value.shift()
  execStep(s)
  currentStepText.value = pendingSteps.value[0]?.text || ''
  if (!pendingSteps.value.length) {
    phase.value = 'done'
    activeStepObj.value = null
    atPause.value = false
  }
}

// 回退到上一步执行前的状态（可反复按，一直退到 GC 开始）
function prevStep() {
  const snap = history.value.pop()
  if (!snap) return
  // 就地恢复（保持对象引用不变！）——步骤的 apply 闭包抓着原对象，
  // 若用副本替换数组元素，闭包改的是脱离数组的旧对象，视觉状态从此不再刷新
  const byId = new Map(objects.map(o => [o.id, o]))
  const snapIds = new Set(snap.objs.map(o => o.id))
  for (const so of snap.objs) {
    const o = byId.get(so.id)
    if (o) {
      o.refs = [...so.refs]
      o.marked = so.marked
      o.garbage = so.garbage
      o.floating = so.floating
      o.misjudged = so.misjudged
      o.fromRoot = so.fromRoot
    }
  }
  // 移除快照之后新分配的对象（增量式时间片间隙里可以分配）
  for (let i = objects.length - 1; i >= 0; i--) {
    if (!snapIds.has(objects[i].id)) objects.splice(i, 1)
  }
  pendingSteps.value = snap.pending
  phase.value = snap.phase
  atPause.value = snap.atPause
  currentStepText.value = snap.text
  activeStepObj.value = snap.active != null ? byId.get(snap.active) ?? null : null
  // 恢复日志：去掉最后一条（execStep 加的那条）
  if (log.value.length > 0) log.value.shift()
}

async function finishSteps() {
  while (pendingSteps.value.length) {
    if (skip.value) { pendingSteps.value = []; break }
    const s = pendingSteps.value.shift()
    execStep(s)
    // 增量式单步模式下自动播放也要在时间片边界停住（给用户操作窗口）
    if (stepMode.value && s.type === 'pause') return
    await sleep(stepMode.value ? 120 : 180)
  }
  phase.value = 'done'
  activeStepObj.value = null
  atPause.value = false
}

function reset() {
  phase.value = 'idle'
  skip.value = false
  atPause.value = false
  history.value = []
  log.value = []
  objects.length = 0
  nextId = 1
  allocCount.value = 0
  pendingSteps.value = []
  currentStepText.value = ''
  activeStepObj.value = null
  totalSteps.value = 0
  seed()
  recompute()
}

// 初始状态：obj1 从根可达
recompute()
</script>

<style scoped>
.gc-sim {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 16px;
  margin: 16px 0;
  background: #f8fafc;
}
.controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.controls button {
  padding: 6px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.controls button:hover:not(:disabled) { background: #f1f5f9; }
.controls button.primary { background: #1971c2; color: #fff; border-color: #1971c2; }
.controls button.skip { background: #f08c00; color: #fff; border-color: #f08c00; }
.controls button.prev { background: #495057; color: #fff; border-color: #495057; }
.controls button.prev:disabled { opacity: 0.45; cursor: not-allowed; }
.controls button:disabled { opacity: 0.5; cursor: not-allowed; }
.toggles { display: flex; gap: 18px; margin-bottom: 10px; font-size: 13px; flex-wrap: wrap; }
.toggle { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.step-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: #fff9db;
  border: 1px solid #f08c00;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
}
.step-text { font-size: 13px; color: #343a40; line-height: 1.5; flex: 1; }
.step-controls { display: flex; gap: 8px; flex-shrink: 0; }
.step-controls button {
  padding: 5px 14px;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.step-controls button.next { background: #1971c2; color: #fff; border-color: #1971c2; }
.step-controls button.fast { background: #f08c00; color: #fff; border-color: #f08c00; }
.step-controls button:disabled { opacity: 0.5; cursor: not-allowed; }
.status { display: flex; gap: 14px; margin-bottom: 12px; font-size: 13px; align-items: center; flex-wrap: wrap; }
.phase { font-weight: 700; padding: 2px 10px; border-radius: 10px; background: #e2e8f0; }
.phase.marking { background: #ffec99; }
.phase.sweeping { background: #ffc9c9; }
.phase.done { background: #b2f2bb; }
.step-count { font-weight: 600; color: #f08c00; }
.stat b { color: #1971c2; }
.stat.floating b { color: #e03131; }
.heap { display: flex; gap: 16px; }
.roots { width: 110px; flex-shrink: 0; }
.section-title { font-size: 12px; color: #64748b; margin-bottom: 8px; font-weight: 600; }
.root-card {
  border: 2px dashed #1971c2;
  border-radius: 8px;
  padding: 12px 8px;
  text-align: center;
  font-weight: 700;
  color: #1971c2;
  background: #e7f5ff;
}
.objects { flex: 1; min-width: 0; }
.hint { font-weight: 400; color: #94a3b8; margin-left: 8px; }
.object-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.object-card {
  border: 2px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px;
  width: 108px;
  background: #fff;
  transition: all 0.25s ease;
  position: relative;
}
.object-card.live { border-color: #2f9e44; background: #ebfbee; }
.object-card.marked { border-color: #f08c00; background: #fff9db; box-shadow: 0 0 0 3px rgba(240, 140, 0, 0.15); }
.object-card.garbage { opacity: 0.45; border-style: dashed; background: #f1f3f5; filter: grayscale(1); }
.object-card.floating { opacity: 0.8; border-color: #e03131; background: #fff5f5; filter: none; }
.object-card.misjudged { box-shadow: 0 0 0 2px rgba(224, 49, 49, 0.25); }
.object-card.active { outline: 3px solid #1971c2; outline-offset: 2px; transform: scale(1.04); }
.obj-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; margin-bottom: 5px; }
.obj-size { color: #94a3b8; font-weight: 400; }
.obj-refs { font-size: 11px; color: #475569; display: flex; flex-wrap: wrap; gap: 3px; }
.ref { background: #e2e8f0; border-radius: 4px; padding: 1px 5px; }
.no-ref { color: #cbd5e1; }
.misjudge-badge {
  position: absolute;
  top: -8px; right: -8px;
  background: #e03131;
  color: #fff;
  font-size: 10px;
  border-radius: 8px;
  padding: 1px 6px;
  white-space: nowrap;
  z-index: 1;
}
.log {
  margin-top: 12px;
  background: #0f172a;
  border-radius: 8px;
  padding: 10px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #a5f3fc;
  min-height: 40px;
}
.log-line { line-height: 1.6; }
.stw-badge { background: #fff0f6; color: #c2255c; border: 1px solid #f783ac; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.inc-badge { background: #e7f5ff; color: #1971c2; border: 1px solid #74c0fc; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
</style>
