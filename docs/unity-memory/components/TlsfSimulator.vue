<script setup>
import { ref, reactive, computed } from 'vue'

// ============ TLSF 算法核心（忠实翻译 tlsf.c） ============
// 简化模型：物理连续块列表 + 两级位图 + 空闲链表（从块推导）
const SL_LOG2 = 5, SL_COUNT = 32, FL_SHIFT = 8, SMALL = 256
const FL_MAX = 32, FL_COUNT = FL_MAX - FL_SHIFT + 1   // 25
const ALIGN = 8
const MEM_SIZE = 512                                   // 内存条 512 字节

class TlsfCore {
  constructor() {
    this.memSize = MEM_SIZE
    this.blocks = []            // 物理块 {id,start,size,free}
    this.seq = 0
    this.flBitmap = 0
    this.slBitmap = new Array(FL_COUNT).fill(0)
    this.blocks.push({ id: ++this.seq, start: 0, size: MEM_SIZE, free: true })
    this.rebuild()
  }
  fls(x) { let r = 0; while (x > 1) { x >>= 1; r++ } return r }
  ffs(x) { let r = 0; while (x && !(x & 1)) { x >>= 1; r++ } return x ? r : -1 }
  mapping(size) {
    if (size < SMALL) return [0, Math.floor(size / (SMALL / SL_COUNT))]
    let fl = this.fls(size)
    let sl = (size >> (fl - SL_LOG2)) ^ (1 << SL_LOG2)
    fl -= (FL_SHIFT - 1)
    return [fl, sl]
  }
  mappingSearch(size) {
    if (size >= SMALL) {
      const round = (1 << (this.fls(size) - SL_LOG2)) - 1
      size += round
    }
    return this.mapping(size)
  }
  rebuild() {
    // 从物理块列表重建位图与空闲链表（教学简化：链表头=每槽第一个空闲块）
    this.flBitmap = 0
    this.slBitmap = this.slBitmap.map(() => 0)
    this.freeHeads = Array.from({ length: FL_COUNT }, () => Array(SL_COUNT).fill(null))
    for (const b of this.blocks) {
      if (!b.free) continue
      const [fl, sl] = this.mapping(b.size)
      this.flBitmap |= 1 << fl
      this.slBitmap[fl] |= 1 << sl
      if (!this.freeHeads[fl][sl]) this.freeHeads[fl][sl] = b
    }
  }
  // 查找合适块（位图路径），返回 {block, fl, sl, steps}
  locate(size) {
    const [fl0, sl0] = this.mappingSearch(size)
    let fl = fl0, sl = sl0
    let slMap = this.slBitmap[fl] & (~0 << sl)
    if (!slMap) {
      const flMap = this.flBitmap & (~0 << (fl + 1))
      if (!flMap) return null
      fl = this.ffs(flMap)
      slMap = this.slBitmap[fl]
    }
    sl = this.ffs(slMap)
    return { block: this.freeHeads[fl][sl], fl, sl, fl0, sl0 }
  }
  // 分配：返回 {block, remain}，remain 为分割出的空闲块（可能 null）
  alloc(size) {
    size = Math.max(size, ALIGN)
    const loc = this.locate(size)
    if (!loc) return null
    const b = loc.block
    b.free = false
    let remain = null
    if (b.size >= size + ALIGN) {
      remain = { id: ++this.seq, start: b.start + size, size: b.size - size, free: true }
      b.size = size
      this.blocks.splice(this.blocks.indexOf(b) + 1, 0, remain)
    }
    this.rebuild()
    return { ...b, loc, remain }
  }
  free(id) {
    const idx = this.blocks.findIndex(b => b.id === id)
    if (idx < 0 || this.blocks[idx].free) return null
    const b = this.blocks[idx]
    b.free = true
    // 向前合并
    if (idx > 0 && this.blocks[idx - 1].free) {
      const prev = this.blocks[idx - 1]
      prev.size += b.size
      this.blocks.splice(idx, 1)
      b.id = prev.id
    }
    // 向后合并（索引可能变了，重新找）
    const i2 = this.blocks.findIndex(x => x.id === b.id)
    if (i2 < this.blocks.length - 1 && this.blocks[i2 + 1].free) {
      const next = this.blocks[i2 + 1]
      this.blocks[i2].size += next.size
      this.blocks.splice(i2 + 1, 1)
    }
    this.rebuild()
    return b
  }
  // 原子合并：向前合并（prev 吞并当前），返回合并后块
  mergePrev(id) {
    const idx = this.blocks.findIndex(b => b.id === id)
    if (idx <= 0 || !this.blocks[idx - 1].free) return null
    const prev = this.blocks[idx - 1], b = this.blocks[idx]
    prev.size += b.size
    this.blocks.splice(idx, 1)
    return prev
  }
  // 原子合并：向后合并（当前吞并 next）
  mergeNext(id) {
    const idx = this.blocks.findIndex(b => b.id === id)
    if (idx < 0 || idx >= this.blocks.length - 1 || !this.blocks[idx + 1].free) return null
    const b = this.blocks[idx], next = this.blocks[idx + 1]
    b.size += next.size
    this.blocks.splice(idx + 1, 1)
    return b
  }
}

// ============ Vue 状态 ============
const core = reactive(new TlsfCore())
const allocSize = ref(64)
const selectedFreeId = ref(null)
const log = ref([])
const stepMode = ref(true)          // 单步模式
const pendingSteps = ref([])        // 待执行步骤队列
const animHighlight = ref(null)     // 高亮块 id
const highlightType = ref('')       // 'split' | 'merge' | 'search' | 'alloc'
const currentStepText = ref('')
const speed = ref(900)

function logMsg(msg) { log.value.unshift({ t: new Date().toLocaleTimeString(), msg }) }

const COLOR = ['#4f8cff', '#42d392', '#ffa94d', '#ff6b6b', '#b197fc', '#63e6be', '#ffd43b', '#e599f7']

// 当前一级位图对应的 sl 行
const flList = computed(() => {
  const arr = []
  for (let fl = 0; fl < FL_COUNT; fl++) {
    if (core.flBitmap & (1 << fl)) arr.push(fl)
  }
  return arr.length ? arr : null
})

function blockColor(b) {
  if (!b.free) return COLOR[b.id % COLOR.length]
  return '#ffffff'
}

// 内存条比例
const PX = computed(() => core.memSize * 1.5)   // 512B → 768px

// 位图格子显示：一级 fl（25 格），二级 sl（32 格，显示当前最大 fl 的行）
const slRow = computed(() => {
  if (!flList.value) return null
  const fl = flList.value[flList.value.length - 1]
  return { fl, slots: Array.from({ length: SL_COUNT }, (_, i) => !!(core.slBitmap[fl] & (1 << i))) }
})

// ============ 单步执行引擎 ============
function pushSteps(steps) {
  pendingSteps.value = steps.map((s, i) => ({ ...s, i }))
}

function doNextStep() {
  if (!pendingSteps.value.length) return
  const s = pendingSteps.value.shift()
  currentStepText.value = s.text
  animHighlight.value = s.highlight || null
  highlightType.value = s.type || ''
  if (s.act) s.act()
  logMsg(`▶ ${s.text}`)
}

function finishSteps() {
  while (pendingSteps.value.length) doNextStep()
  animHighlight.value = null
  currentStepText.value = ''
}

// ============ 操作 ============
let lastAllocResult = null

function onAlloc() {
  let size = Math.max(8, Math.min(parseInt(allocSize.value) || 64, 256))
  size = Math.round(size / ALIGN) * ALIGN
  allocSize.value = size
  pendingSteps.value = []
  const [fls0, sls0] = core.mappingSearch(size)
  const loc = core.locate(size)
  lastAllocResult = null

  pushSteps([
    { text: `① 请求分配 ${size} 字节（对齐 ${ALIGN}B）`, highlight: null },
    { text: `② mapping_search：${size >= SMALL ? `size≥256 → 向上取整，fl=${fls0}, sl=${sls0}` : `size<256 → 进 fl=0，按 8B/槽：sl=${sls0}`}`, highlight: null },
    { text: `③ search_suitable_block：查 sl_bitmap[${fls0}] 从第 ${sls0} 位起，无则查 fl_bitmap 更高位，用 ffs 指令定位`, highlight: null },
  ])
  if (!loc) {
    pushSteps([{ text: `❌ 内存不足：fl_bitmap 无更高空闲类，无 ≥${size}B 空闲块` }])
  } else {
    pushSteps([
      { text: `④ 命中空闲块 id=${loc.block.id}（${loc.block.size}B，槽 fl=${loc.fl}, sl=${loc.sl}），从空闲链表摘除`, highlight: loc.block.id, type: 'search' },
      { text: `⑤ block_split：${loc.block.size}B ≥ ${size}B + 8B → 切出 ${size}B，剩余还给池`, highlight: loc.block.id, type: 'split',
        act: () => { lastAllocResult = core.alloc(size) } },
      { text: `⑥ 新空闲块入链表 + 置位图（mapping_insert + insert_free_block）`, highlight: null,
        act: () => {
          if (lastAllocResult && lastAllocResult.remain)
            logMsg(`   ➕ 剩余空闲块 id=${lastAllocResult.remain.id}（${lastAllocResult.remain.size}B）`)
        } },
      { text: `✅ 分配完成：已用块 id=${loc.block.id}（${size}B），返回指针`, highlight: loc.block.id, type: 'alloc' },
    ])
  }
  if (stepMode.value) {
    currentStepText.value = pendingSteps.value[0]?.text || ''
  } else {
    finishSteps()
  }
}

function onFree(id) {
  const b = core.blocks.find(x => x.id === id)
  if (!b || b.free) return
  pendingSteps.value = []
  const idx = core.blocks.indexOf(b)
  const prevFree = idx > 0 && core.blocks[idx - 1].free
  const nextFree = idx < core.blocks.length - 1 && core.blocks[idx + 1].free

  pushSteps([
    { text: `① 释放块 id=${b.id}（${b.size}B，地址 ${b.start}B）`, highlight: b.id, type: 'alloc',
      act: () => { core.blocks[core.blocks.indexOf(b)].free = true; core.rebuild() } },
  ])
  if (prevFree) {
    pushSteps([{ text: `② block_is_prev_free → block_merge_prev 向前合并（前块吞并本块）`, highlight: core.blocks[idx - 1].id, type: 'merge',
      act: () => { core.mergePrev(b.id); core.rebuild() } }])
  }
  if (nextFree) {
    pushSteps([{ text: `③ block_is_free(next) → block_merge_next 向后合并（本块吞并后块）`, highlight: b.id, type: 'merge',
      act: () => { core.mergeNext(b.id); core.rebuild() } }])
  }
  pushSteps([
    { text: `④ block_insert：合并后整块插入空闲链表 + 置位图`, highlight: null, act: () => core.rebuild() },
    { text: `✅ 释放完成：空闲块已归位，可被后续分配复用`, highlight: null },
  ])
  if (stepMode.value) {
    currentStepText.value = pendingSteps.value[0]?.text || ''
  } else {
    finishSteps()
  }
}

function onReset() {
  core.blocks = [{ id: ++core.seq, start: 0, size: MEM_SIZE, free: true }]
  core.rebuild()
  pendingSteps.value = []
  currentStepText.value = ''
  animHighlight.value = null
  log.value = []
  logMsg('🔄 已重置：512B 整块空闲')
}

function selectBlock(b) {
  if (!b.free) {
    onFree(b.id)
  } else {
    selectedFreeId.value = b.id
  }
}

function stepDone() {
  // 单步模式下执行完队列：真正的 alloc/free 动作在步骤执行时逐步做
  // 这里把"剩余动作"合并执行（简化：动作在 doNextStep 里即时执行）
  doNextStep()
}

// 初始化日志
logMsg('🟦 TLSF 模拟器就绪：512B 内存条，块 8B 对齐，两级位图 25×32')
logMsg('💡 开启「单步模式」，点分配/释放，用「下一步」逐步看算法执行')
</script>

<template>
  <div class="tlsf-sim" style="font-family: system-ui, sans-serif; line-height: 1.6">
    <h3>🧪 TLSF 可视化模拟器（512B 内存条）</h3>

    <!-- 控制面板 -->
    <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; background:#f6f8fa; padding:12px; border-radius:8px; margin-bottom:12px">
      <label>分配大小 <input v-model.number="allocSize" type="number" min="8" max="256" step="8"
        style="width:70px; margin-left:6px; padding:4px" /></label>
      <button @click="onAlloc" style="padding:6px 16px; background:#4f8cff; color:#fff; border:none; border-radius:6px; cursor:pointer">分配 Alloc</button>
      <button @click="stepDone" :disabled="!pendingSteps.length" style="padding:6px 16px; background:#ffa94d; color:#fff; border:none; border-radius:6px; cursor:pointer">
        下一步 ▶ ({{ pendingSteps.length }})</button>
      <button @click="finishSteps" :disabled="!pendingSteps.length" style="padding:6px 12px; background:#adb5bd; color:#fff; border:none; border-radius:6px; cursor:pointer">直接完成 ⏩</button>
      <label style="margin-left:8px"><input type="checkbox" v-model="stepMode" /> 单步模式</label>
      <button @click="onReset" style="padding:6px 12px; background:#e03131; color:#fff; border:none; border-radius:6px; cursor:pointer">重置</button>
    </div>

    <!-- 当前步骤 -->
    <div v-if="currentStepText" style="background:#fff9db; border:1px solid #ffd43b; padding:10px 14px; border-radius:8px; margin-bottom:12px">
      <strong style="color:#e8590c">{{ currentStepText }}</strong>
    </div>

    <!-- 内存条 -->
    <div style="border:2px solid #343a40; border-radius:8px; padding:8px; background:#f8f9fa">
      <svg :width="PX" :height="86" :viewBox="`0 0 ${PX} 86`" style="display:block; max-width:100%">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#343a40" />
          </marker>
        </defs>
        <rect x="0" y="8" :width="PX" height="54" fill="#e9ecef" rx="4" />
        <template v-for="b in core.blocks" :key="b.id">
          <rect :x="b.start * 1.5" y="8" :width="Math.max(b.size * 1.5 - 1, 2)" height="54"
            :fill="blockColor(b)" stroke="#343a40" :stroke-width="animHighlight === b.id ? 3 : 1"
            :stroke-dasharray="b.free ? '4 3' : 'none'"
            :style="{ transition: 'all 0.5s', cursor: b.free ? 'pointer' : 'pointer' }"
            @click="selectBlock(b)" />
          <text :x="b.start * 1.5 + 4" y="42" font-size="11" fill="#212529">{{ b.free ? 'FREE' : 'USED' }}</text>
          <text :x="b.start * 1.5 + 4" y="56" font-size="10" fill="#495057">{{ b.size }}B</text>
          <text :x="b.start * 1.5 + 4" y="18" font-size="9" fill="#868e96">id{{ b.id }}</text>
        </template>
        <!-- 地址刻度 -->
        <template v-for="i in [0, 128, 256, 384, 512]" :key="'t'+i">
          <line :x1="i * 1.5" :y1="8" :x2="i * 1.5" y2="14" stroke="#868e96" />
          <text :x="i * 1.5" y="80" font-size="9" fill="#868e96" text-anchor="middle">{{ i }}</text>
        </template>
      </svg>
      <div style="font-size:12px; color:#868e96; margin-top:4px">
        地址 0 ~ {{ core.memSize }}B ｜ 点击 <strong>USED</strong> 块 = 释放 ｜ 空闲块(FREE)点击 = 查看
      </div>
    </div>

    <!-- 位图 -->
    <div style="margin-top:14px; display:flex; gap:20px; flex-wrap:wrap">
      <div>
        <div style="font-size:13px; font-weight:600; margin-bottom:6px">一级位图 fl_bitmap（{{ FL_COUNT }} 类）</div>
        <div style="display:grid; grid-template-columns: repeat(13, 18px); gap:2px">
          <template v-for="fl in Array.from({length: FL_COUNT}, (_, i) => i)" :key="'fl'+fl">
            <div :title="`fl=${fl}（${Math.pow(2, fl + FL_SHIFT - 1)}B~）`"
              :style="{ width:18, height:18, borderRadius:3, border:'1px solid #adb5bd',
                background: core.flBitmap & (1 << fl) ? '#4f8cff' : '#f1f3f5',
                color: core.flBitmap & (1 << fl) ? '#fff' : '#adb5bd',
                fontSize:9, display:'flex', alignItems:'center', justifyContent:'center' }">{{ fl }}</div>
          </template>
        </div>
        <div style="font-size:11px; color:#868e96; margin-top:4px">亮 = 该类有空闲块（fl 越大块越大）</div>
      </div>
      <div v-if="slRow">
        <div style="font-size:13px; font-weight:600; margin-bottom:6px">二级位图 sl_bitmap[{{ slRow.fl }}]（32 槽）</div>
        <div style="display:grid; grid-template-columns: repeat(16, 18px); gap:2px">
          <template v-for="(on, i) in slRow.slots" :key="'sl'+i">
            <div :title="`sl=${i}`" :style="{ width:18, height:18, borderRadius:3, border:'1px solid #adb5bd',
              background: on ? '#42d392' : '#f1f3f5', color: on ? '#fff' : '#adb5bd',
              fontSize:9, display:'flex', alignItems:'center', justifyContent:'center' }">{{ i }}</div>
          </template>
        </div>
        <div style="font-size:11px; color:#868e96; margin-top:4px">亮 = 该二级槽有空闲块（展示 fl={{ slRow.fl }} 行）</div>
      </div>
      <div v-else>
        <div style="font-size:13px; color:#868e96">二级位图：暂无空闲块</div>
      </div>
    </div>

    <!-- 日志 -->
    <div style="margin-top:14px">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px">📜 操作日志</div>
      <div style="background:#212529; color:#e9ecef; border-radius:8px; padding:10px; max-height:160px; overflow-y:auto; font-size:12px">
        <div v-for="(l, i) in log" :key="i" style="padding:1px 0">{{ l.t }} {{ l.msg }}</div>
      </div>
    </div>
  </div>
</template>
