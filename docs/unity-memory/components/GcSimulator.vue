<template>
  <div class="gc-sim">
    <div class="controls">
      <button @click="allocObject" :disabled="allocCount >= MAX_OBJS">+ 分配对象</button>
      <button @click="breakRandomRef" :disabled="phase === 'marking' || phase === 'sweeping'">断开一个引用</button>
      <button class="primary" @click="runGC" :disabled="phase === 'marking' || phase === 'sweeping'">▶ 运行 GC</button>
      <button v-if="phase === 'marking' || phase === 'sweeping'" class="skip" @click="skip = true">⏩ 跳过</button>
      <button @click="reset" :disabled="phase === 'marking' || phase === 'sweeping'">重置</button>
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
    </div>

    <!-- 单步面板：当前步骤说明 + 控制 -->
    <div v-if="phase === 'marking' || phase === 'sweeping'" class="step-panel">
      <div class="step-text">{{ currentStepText || '准备中…' }}</div>
      <div class="step-controls">
        <button v-if="stepMode" class="next" @click="nextStep" :disabled="!pendingSteps.length">下一步 ▶</button>
        <button v-if="stepMode" class="fast" @click="finishSteps">⏩ 自动完成</button>
      </div>
    </div>

    <div class="status">
      <span class="phase" :class="phase">{{ phaseLabel }}</span>
      <span v-if="stepMode && (phase === 'marking' || phase === 'sweeping')" class="step-count">
        步骤 {{ totalSteps - pendingSteps.length + 1 }}/{{ totalSteps }}
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
const stepMode = ref(true)
const allocCount = ref(0)
const skip = ref(false)
const log = ref([])

// 单步引擎状态
const pendingSteps = ref([])
const currentStepText = ref('')
const activeStepObj = ref(null)
const totalSteps = ref(0)

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
  return steps
}

async function runGC() {
  if (phase.value === 'marking' || phase.value === 'sweeping') return
  skip.value = false
  log.value = []
  addLog('GC 开始')
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
  if (s.apply) s.apply()
  // 日志（仅关键步骤）
  if (s.type === 'misjudge' || (s.type === 'info' && s.text.includes('⑦'))) addLog(s.text.replace(/^[①②③④⑤⑥⑦]\s*/, ''))
}

function nextStep() {
  if (!pendingSteps.value.length) return
  const s = pendingSteps.value.shift()
  execStep(s)
  currentStepText.value = pendingSteps.value[0]?.text || ''
  if (!pendingSteps.value.length) {
    phase.value = 'done'
    activeStepObj.value = null
  }
}

async function finishSteps() {
  while (pendingSteps.value.length) {
    if (skip.value) { pendingSteps.value = []; break }
    const s = pendingSteps.value.shift()
    execStep(s)
    await sleep(stepMode.value ? 120 : 180)
  }
  phase.value = 'done'
  activeStepObj.value = null
}

function reset() {
  phase.value = 'idle'
  skip.value = false
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
</style>
