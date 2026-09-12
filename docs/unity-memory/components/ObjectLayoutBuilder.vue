<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// ObjectLayoutBuilder —— 拖字段看布局：对齐、padding、对象头、引用字段
// ----------------------------------------------------------------------------
// 真相来源：C:\References\unity2020lts\External\il2cpp\builds\libil2cpp\
//   Il2CppObject 对象头（klass + monitor，16 字节）  il2cpp-object-internals.h:66-74
//   Il2CppString 布局（对象头 + length + chars）      il2cpp-object-internals.h:129-137
//   Il2CppClass.instance_size / actualSize           il2cpp-class-internals.h:431-432
//   Il2CppClass.vtable[]（零长数组在结构体尾部）     il2cpp-class-internals.h:474
//
// 演示的核心事实：
//   ① 托管对象的地址前 16 字节永远是对象头（klass 指针 + monitor），你的第一个字段从 16 开始
//   ② 字段不是"按声明顺序紧凑排"的，而是每个字段对齐到自身大小的边界 → 产生 padding
//   ③ 调换字段顺序可以让结构体变小 —— 这就是"字段重排"优化的原理
//   ④ 引用类型字段在 IL2CPP 里就是一个 8 字节指针（指向托管堆），值类型字段是内联展开的
// ============================================================================

// 字段类型表：size 为字节数，align 为对齐要求
const TYPES = {
  bool: { size: 1, align: 1, kind: 'value', label: 'bool', note: '1 字节，但 C# 里 bool 默认占 1 字节' },
  byte: { size: 1, align: 1, kind: 'value', label: 'byte' },
  sbyte: { size: 1, align: 1, kind: 'value', label: 'sbyte' },
  char: { size: 2, align: 2, kind: 'value', label: 'char（UTF-16）' },
  short: { size: 2, align: 2, kind: 'value', label: 'short' },
  int: { size: 4, align: 4, kind: 'value', label: 'int' },
  uint: { size: 4, align: 4, kind: 'value', label: 'uint' },
  float: { size: 4, align: 4, kind: 'value', label: 'float' },
  long: { size: 8, align: 8, kind: 'value', label: 'long' },
  double: { size: 8, align: 8, kind: 'value', label: 'double' },
  Vector3: { size: 12, align: 4, kind: 'value', label: 'Vector3（3×float）', note: '值类型内联展开：12 字节直接占在对象里' },
  ref: { size: 8, align: 8, kind: 'ref', label: '引用字段（class 类型）', note: '8 字节指针，指向托管堆上的另一个对象' },
  string: { size: 8, align: 8, kind: 'ref', label: 'string', note: 'string 是引用类型，对象里只存 8 字节指针' },
}

const HEADER = 16 // Il2CppObject: klass(8) + monitor(8)

let uid = 0
const fields = ref([
  { id: ++uid, type: 'ref', name: 'target' },
  { id: ++uid, type: 'int', name: 'hp' },
  { id: ++uid, type: 'bool', name: 'alive' },
])

// 可选字段类型下拉
const TYPE_KEYS = Object.keys(TYPES)

function addField(type = 'int') {
  fields.value.push({ id: ++uid, type, name: 'f' + uid })
}
function removeField(id) {
  fields.value = fields.value.filter((f) => f.id !== id)
}
function moveField(i, dir) {
  const j = i + dir
  if (j < 0 || j >= fields.value.length) return
  const arr = fields.value.slice()
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  fields.value = arr
}
function sortByAlign() {
  // 经典优化：按对齐要求从大到小排，padding 最少
  fields.value = fields.value
    .slice()
    .sort((a, b) => TYPES[b.type].align - TYPES[a.type].align)
}
function reset() {
  fields.value = [
    { id: ++uid, type: 'ref', name: 'target' },
    { id: ++uid, type: 'int', name: 'hp' },
    { id: ++uid, type: 'bool', name: 'alive' },
  ]
}

// ---------- 布局计算：忠实实现"每个字段对齐到自身大小的边界" ----------
const layout = computed(() => {
  const blocks = []
  let offset = 0

  blocks.push({
    kind: 'header',
    label: '对象头 (Il2CppObject)',
    detail: 'klass 指针 8B + monitor 8B',
    from: 0,
    to: HEADER,
  })
  offset = HEADER

  for (const f of fields.value) {
    const t = TYPES[f.type]
    // padding：把 offset 抬到 align 的倍数
    const pad = (t.align - (offset % t.align)) % t.align
    if (pad > 0) {
      blocks.push({
        kind: 'pad',
        label: `padding ${pad}B`,
        detail: `为了把「${f.name}」对齐到 ${t.align} 字节边界`,
        from: offset,
        to: offset + pad,
      })
      offset += pad
    }
    blocks.push({
      kind: t.kind === 'ref' ? 'ref' : 'value',
      label: `${t.label}  ${f.name}`,
      detail: t.note || `${t.size} 字节，对齐 ${t.align}`,
      from: offset,
      to: offset + t.size,
    })
    offset += t.size
  }

  // 结构体总大小要对齐到最大成员对齐值（IL2CPP 里 instance_size 也是这么来的）
  const maxAlign = Math.max(1, ...fields.value.map((f) => TYPES[f.type].align))
  const tailPad = (maxAlign - (offset % maxAlign)) % maxAlign
  if (tailPad > 0) {
    blocks.push({
      kind: 'pad',
      label: `尾部 padding ${tailPad}B`,
      detail: `整体大小要补齐到最大对齐值 ${maxAlign} 的倍数`,
      from: offset,
      to: offset + tailPad,
    })
    offset += tailPad
  }

  return { blocks, totalSize: offset, maxAlign }
})

// 紧凑排列（无 padding）会占多少 —— 用来量化"对齐的代价"
const packedSize = computed(
  () => HEADER + fields.value.reduce((s, f) => s + TYPES[f.type].size, 0)
)

const paddingBytes = computed(() => layout.value.totalSize - packedSize.value)

// 引用字段数 → 给 GC 的扫描提示
const refCount = computed(() => fields.value.filter((f) => TYPES[f.type].kind === 'ref').length)

function blockStyle(b) {
  const t = layout.value.totalSize || 1
  return {
    left: (b.from / t) * 100 + '%',
    width: ((b.to - b.from) / t) * 100 + '%',
  }
}

const KIND_STYLE = {
  header: { bg: '#868E96', fg: '#fff', name: '对象头' },
  value: { bg: '#4C6EF5', fg: '#fff', name: '值类型字段（内联）' },
  ref: { bg: '#12B886', fg: '#fff', name: '引用字段（8B 指针）' },
  pad: { bg: '#FFE066', fg: '#212529', name: 'padding（对齐填充）' },
}

const hovered = ref(-1)
</script>

<template>
  <div class="olb-root">
    <h3 class="olb-h3">🧱 自己排字段：看对齐怎么吃掉你的内存</h3>
    <p class="olb-sub">
      右边加字段、调顺序，左边实时算出真实布局。<strong>同样的字段、不同的顺序，对象大小可能不一样</strong>——
      这就是 Unity 里"把大字段放前面"这条建议的来历。数字口径是 <b>64 位</b>平台（指针 8 字节）。
    </p>

    <div class="olb-grid">
      <!-- 左：布局条 -->
      <div class="olb-viz">
        <div class="olb-total">
          对象总大小 <b>{{ layout.totalSize }}</b> 字节
          <span class="olb-sub-note">
            其中对象头 {{ HEADER }}B、padding <b>{{ paddingBytes }}</b>B
          </span>
        </div>

        <div class="olb-bar">
          <div
            v-for="(b, i) in layout.blocks"
            :key="i"
            class="olb-seg"
            :class="{ dim: hovered >= 0 && hovered !== i }"
            :style="{ ...blockStyle(b), background: KIND_STYLE[b.kind].bg, color: KIND_STYLE[b.kind].fg }"
            :title="`${b.label}｜${b.from}–${b.to - 1} 字节｜${b.detail}`"
            @mouseenter="hovered = i"
            @mouseleave="hovered = -1"
          >
            <span class="olb-seg-label">{{ b.label }}</span>
            <span class="olb-seg-range">{{ b.from }}</span>
          </div>
        </div>

        <!-- 逐字节刻度：标注每个字段的起始偏移 -->
        <div class="olb-scale">
          <span
            v-for="(b, i) in layout.blocks"
            :key="i"
            class="olb-scale-tick"
            :style="{ left: (b.from / (layout.totalSize || 1)) * 100 + '%' }"
          >{{ b.from }}</span>
        </div>

        <ul class="olb-blocklist">
          <li
            v-for="(b, i) in layout.blocks"
            :key="i"
            :class="{ hot: hovered === i }"
            @mouseenter="hovered = i"
            @mouseleave="hovered = -1"
          >
            <i class="olb-dot" :style="{ background: KIND_STYLE[b.kind].bg }" />
            <b>{{ b.from }}–{{ b.to - 1 }}</b>
            <span class="olb-blockname">{{ b.label }}</span>
            <span class="olb-blockdetail">{{ b.detail }}</span>
          </li>
        </ul>
      </div>

      <!-- 右：字段编辑器 -->
      <div class="olb-editor">
        <div class="olb-editor-head">
          字段列表（GitHub 里这样排）
          <span class="olb-editor-hint">{{ fields.length }} 个字段</span>
        </div>

        <div v-for="(f, i) in fields" :key="f.id" class="olb-row">
          <span class="olb-row-idx">{{ i + 1 }}</span>
          <select v-model="f.type" class="olb-select">
            <option v-for="k in TYPE_KEYS" :key="k" :value="k">{{ TYPES[k].label }}</option>
          </select>
          <input v-model="f.name" class="olb-input" spellcheck="false" />
          <span class="olb-row-btns">
            <button class="olb-mini" :disabled="i === 0" @click="moveField(i, -1)" title="上移">▲</button>
            <button class="olb-mini" :disabled="i === fields.length - 1" @click="moveField(i, 1)" title="下移">▼</button>
            <button class="olb-mini olb-del" @click="removeField(f.id)" title="删除">✕</button>
          </span>
        </div>

        <div class="olb-addbar">
          <button class="olb-btn" @click="addField('int')">+ int</button>
          <button class="olb-btn" @click="addField('ref')">+ 引用字段</button>
          <button class="olb-btn" @click="addField('bool')">+ bool</button>
          <button class="olb-btn" @click="addField('Vector3')">+ Vector3</button>
        </div>

        <div class="olb-tools">
          <button class="olb-btn olb-btn-main" @click="sortByAlign">⇅ 按对齐从大到小重排（优化）</button>
          <button class="olb-btn olb-btn-ghost" @click="reset">⟲ 重置</button>
        </div>

        <div class="olb-readout">
          <div><span>紧凑排布需要</span><b>{{ packedSize }} B</b></div>
          <div><span>实际占用（含 padding）</span><b class="olb-hl">{{ layout.totalSize }} B</b></div>
          <div><span>对齐浪费</span><b :class="paddingBytes > 0 ? 'olb-warn' : ''">{{ paddingBytes }} B</b></div>
          <div><span>GC 需要扫描的引用字段</span><b>{{ refCount }} 个</b></div>
        </div>

        <p class="olb-tip">
          试试把 <code>bool</code> 放到 <code>int</code> 前面，再放回后面——观察 padding 的变化。
        </p>
      </div>
    </div>

    <div class="olb-foot">
      <b>三条能直接用在项目里的结论</b>
      <ol>
        <li>
          <b>对象头是固定成本。</b>每个托管对象都先付 16 字节（<code>klass</code> 指针 + <code>monitor</code>）。
          一个只有 1 个 <code>bool</code> 字段的小对象，实际占用是 16 + 1 + 7(padding) = 24 字节——
          真正属于你的只有 1 字节。这也是"减少小对象数量"比"减少小对象字段"更重要的原因。
        </li>
        <li>
          <b>字段顺序会影响大小，但不是所有类型都受影响。</b>只有混用了不同对齐要求的类型
          （比如 <code>bool</code> 和 <code>long</code>）才有 padding 空间可挤。全 <code>int</code> 的类怎么排都一样。
        </li>
        <li>
          <b>引用字段在对象里只是一个 8 字节地址。</b><code>string</code> 不把字符存进对象，
          只存一个指针；<code>Vector3</code> 这种值类型则是 12 字节直接内联。
          这也是为什么"把 struct 塞进 class"不会节省对象头，反而可能因为装箱多付一次头。
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.olb-root { margin: 22px 0; }
.olb-h3 { margin: 0 0 8px; }
.olb-sub { font-size: 13px; line-height: 1.8; color: var(--vp-c-text-2); margin: 0 0 12px; }

.olb-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 900px) { .olb-grid { grid-template-columns: 1fr; } }

.olb-viz {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
  min-width: 0;
}
.olb-total { font-size: 13px; color: var(--vp-c-text-2); margin-bottom: 8px; }
.olb-total b { font-size: 17px; color: var(--vp-c-brand-1); }
.olb-sub-note { font-size: 11.5px; color: var(--vp-c-text-3); margin-left: 8px; }
.olb-sub-note b { font-size: inherit; color: var(--vp-c-text-2); }

.olb-bar {
  display: flex;
  height: 46px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  position: relative;
}
.olb-seg {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-size: 10.5px;
  line-height: 1.15;
  border-right: 1px solid rgba(255, 255, 255, 0.5);
  transition: opacity 0.15s;
  cursor: default;
  position: relative;
}
.olb-seg:last-child { border-right: 0; }
.olb-seg.dim { opacity: 0.4; }
.olb-seg-label {
  padding: 0 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  font-weight: 600;
}
.olb-seg-range { font-size: 9px; opacity: 0.8; }

.olb-scale { position: relative; height: 14px; }
.olb-scale-tick {
  position: absolute;
  font-size: 9px;
  color: var(--vp-c-text-3);
  transform: translateX(-50%);
  font-family: var(--vp-font-family-mono);
}

.olb-blocklist {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
}
.olb-blocklist li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  color: var(--vp-c-text-2);
  flex-wrap: wrap;
}
.olb-blocklist li.hot { background: var(--vp-c-bg); }
.olb-blocklist b {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  min-width: 52px;
}
.olb-dot { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 auto; }
.olb-blockname { color: var(--vp-c-text-1); }
.olb-blockdetail { color: var(--vp-c-text-3); font-size: 11px; flex-basis: 100%; padding-left: 15px; }

.olb-editor {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--vp-c-bg-soft);
  min-width: 0;
}
.olb-editor-head {
  font-size: 12px;
  color: var(--vp-c-text-2);
  margin-bottom: 8px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.olb-editor-hint { margin-left: auto; font-size: 11px; color: var(--vp-c-text-3); }

.olb-row { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
.olb-row-idx {
  font-size: 10px;
  color: var(--vp-c-text-3);
  width: 12px;
  flex: 0 0 auto;
  text-align: right;
}
.olb-select, .olb-input {
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 11.5px;
  padding: 3px 5px;
  min-width: 0;
}
.olb-select { flex: 0 0 96px; }
.olb-input { flex: 1 1 auto; font-family: var(--vp-font-family-mono); }
.olb-row-btns { display: flex; gap: 2px; flex: 0 0 auto; }
.olb-mini {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  border-radius: 4px;
  font-size: 9px;
  padding: 1px 4px;
  cursor: pointer;
  line-height: 1.4;
}
.olb-mini:disabled { opacity: 0.35; cursor: not-allowed; }
.olb-mini:hover:not(:disabled) { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.olb-del:hover { border-color: #E03131; color: #E03131; }

.olb-addbar, .olb-tools { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
.olb-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 11.5px;
  cursor: pointer;
}
.olb-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.olb-btn-main { background: var(--vp-c-brand-1); border-color: var(--vp-c-brand-1); color: #fff; font-weight: 600; }
.olb-btn-main:hover { color: #fff; opacity: 0.9; }
.olb-btn-ghost { color: var(--vp-c-text-3); }

.olb-readout {
  margin-top: 10px;
  border-top: 1px dashed var(--vp-c-divider);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.olb-readout > div { display: flex; justify-content: space-between; gap: 8px; }
.olb-readout b { color: var(--vp-c-text-1); font-family: var(--vp-font-family-mono); }
.olb-hl { color: var(--vp-c-brand-1) !important; font-size: 13px; }
.olb-warn { color: #E8590C !important; }
.olb-tip { font-size: 11.5px; color: var(--vp-c-text-3); margin: 8px 0 0; line-height: 1.6; }
.olb-tip code {
  font-family: var(--vp-font-family-mono);
  background: var(--vp-code-bg);
  padding: 1px 4px;
  border-radius: 3px;
}

.olb-foot {
  font-size: 13px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 8px 8px 0;
  padding: 10px 16px;
  margin-top: 14px;
}
.olb-foot b { color: var(--vp-c-text-1); }
.olb-foot ol { margin: 6px 0 0; padding-left: 20px; }
.olb-foot li { margin-bottom: 6px; }
.olb-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: var(--vp-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
