<template>
  <div class="gc-sim">
    <div class="controls">
      <button @click="allocObject">+ 分配对象</button>
      <button @click="breakRandomRef" :disabled="phase !== 'idle'">断开一个引用</button>
      <button class="primary" @click="runGC" :disabled="phase !== 'idle'">▶ 运行 GC</button>
      <button @click="reset" :disabled="phase !== 'idle'">重置</button>
    </div>

    <div class="toggles">
      <label class="toggle">
        <input type="checkbox" v-model="conservative" @change="recompute" />
        <span>保守式扫描（整数误判为引用）</span>
      </label>
      <label class="toggle">
        <input type="checkbox" v-model="incremental" />
        <span>增量式 GC（3ms 时间片 × 3）</span>
      </label>
    </div>

    <div class="status">
      <span class="phase" :class="phase">{{ phaseLabel }}</span>
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
              misjudged: o.misjudged,
              live: phase === 'idle' && o.live && !o.garbage
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
            <div v-if="o.misjudged" class="misjudge-badge">⚠️ 整数误判</div>
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

let nextId = 9
let nextAlloc = 0

const phase = ref('idle')
const conservative = ref(true)
const incremental = ref(false)
const allocCount = ref(0)
const log = ref([])

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
    objects.push({ id: nextId++, size: s.size, refs: [...s.refs], live: false, marked: false, garbage: false, misjudged: false })
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
const floatingCount = computed(() => objects.filter(o => o.garbage && o.misjudged).length)

function addLog(msg) {
  log.value.unshift(msg)
  if (log.value.length > 8) log.value.pop()
}

function allocObject() {
  const id = nextId++
  const size = [16, 32, 48, 64, 96, 128, 256][Math.floor(Math.random() * 7)]
  objects.push({ id, size, refs: [], live: false, marked: false, garbage: false, misjudged: false })
  nextAlloc++
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

// 保守式：扫描每个对象的"字长"（size/8 个字），值恰好等于某个对象地址的整数会被误判为引用
function computeMisjudged() {
  for (const o of objects) {
    o.misjudged = false
    if (!conservative.value) continue
    const words = Math.max(1, Math.floor(o.size / 8))
    // 模拟：每个对象里有一个"看起来像指针"的整数槽位，其值恰好等于某个垃圾对象地址
    for (const other of objects) {
      if (other.garbage && Math.random() < 0.15 * words) {
        o.misjudged = true
        break
      }
    }
  }
}

// 从根出发的引用闭包
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

// 保守式：被误判引用的对象也"活"
function conservativeReachable(base) {
  const reach = new Set(base)
  let changed = true
  while (changed) {
    changed = false
    for (const o of objects) {
      if (o.misjudged && !reach.has(o.id)) {
        // 被误判对象引用着的对象也被视为可达（保守式沿着误判引用继续扫）
        for (const r of o.refs) {
          if (reach.has(r)) { reach.add(o.id); changed = true; break }
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
  const reach = conservative.value ? conservativeReachable(base) : base
  for (const o of objects) {
    o.live = reach.has(o.id)
    o.garbage = !reach.has(o.id)
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms))

async function runGC() {
  if (phase.value !== 'idle') return
  phase.value = 'marking'
  log.value = []
  addLog('GC 开始')

  // 先算保守式误判（标记前快照）
  for (const o of objects) { o.marked = false; o.garbage = false; o.misjudged = false }
  computeMisjudged()

  const base = reachableFromRoot()
  const reach = conservative.value ? conservativeReachable(base) : base

  // 标记阶段：BFS 从根点亮
  const markOrder = []
  const seen = new Set()
  const stack = objects.filter(o => o.fromRoot)
  while (stack.length) {
    const o = stack.pop()
    if (seen.has(o.id)) continue
    seen.add(o.id)
    markOrder.push(o)
    for (const r of o.refs) {
      const t = objects.find(x => x.id === r)
      if (t) stack.push(t)
    }
  }

  const slices = incremental.value ? 3 : 1
  const perSlice = Math.ceil(markOrder.length / slices)
  for (let s = 0; s < slices; s++) {
    const chunk = markOrder.slice(s * perSlice, (s + 1) * perSlice)
    for (const o of chunk) {
      o.marked = true
      await sleep(260)
    }
    if (incremental.value && s < slices - 1) {
      addLog(`增量暂停（时间片 ${s + 1}/3 用完，~3ms）→ 下一帧继续`)
      await sleep(700)
    }
  }
  addLog(`标记完成：${seen.size} 个对象可达`)

  // 清除阶段
  phase.value = 'sweeping'
  const garbage = objects.filter(o => !reach.has(o.id))
  for (const o of garbage) {
    o.garbage = true
    await sleep(240)
  }
  addLog(`清除：回收 ${garbage.length} 个垃圾对象`)
  if (floatingCount.value > 0) {
    addLog(`⚠️ 保守式误判 ${floatingCount.value} 个对象为存活（浮动垃圾，本轮收不掉）`)
  }
  phase.value = 'done'
}

function reset() {
  phase.value = 'idle'
  log.value = []
  objects.length = 0
  nextId = 1
  allocCount.value = 0
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
.controls button:disabled { opacity: 0.5; cursor: not-allowed; }
.toggles { display: flex; gap: 18px; margin-bottom: 10px; font-size: 13px; }
.toggle { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.status { display: flex; gap: 14px; margin-bottom: 12px; font-size: 13px; align-items: center; }
.phase { font-weight: 700; padding: 2px 10px; border-radius: 10px; background: #e2e8f0; }
.phase.marking { background: #ffec99; }
.phase.sweeping { background: #ffc9c9; }
.phase.done { background: #b2f2bb; }
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
.object-card.misjudged { border-color: #e03131; }
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
