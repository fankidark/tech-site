<template>
  <div class="layout-viewer">
    <!-- 分页：类选择 -->
    <div class="class-tabs">
      <button
        v-for="c in CLASSES"
        :key="c.name"
        :class="{ active: current.name === c.name }"
        @click="selectClass(c.name)"
      >{{ c.label }}</button>
    </div>

    <!-- 代码 + 内存布局对照 -->
    <div class="layout-row">
      <div class="code-panel">
        <div class="panel-title">C# 代码</div>
        <pre><code>{{ current.code }}</code></pre>
      </div>

      <div class="mem-panel">
        <div class="panel-title">内存布局（64 位，每格 = 8 字节 word）</div>

        <!-- 内存条 -->
        <div class="mem-bar">
          <div
            v-for="(cell, i) in cells"
            :key="i"
            class="mem-cell"
            :class="{
              head: cell.head,
              ref: cell.ref,
              value: cell.value,
              pad: cell.pad,
              active: activeCell === i
            }"
            @mouseenter="activeCell = i"
            @mouseleave="activeCell = -1"
          >
            <div class="cell-offset">{{ cell.offsetText }}</div>
            <div class="cell-main">
              <div v-if="cell.fields.length === 1" class="cell-name">{{ cell.fields[0].name }}</div>
              <div v-else class="cell-name multi">
                <span v-for="f in cell.fields" :key="f.name">{{ f.name }}</span>
              </div>
            </div>
            <div class="cell-bit">bit {{ i }} = {{ cell.ref ? '1' : '0' }}</div>
          </div>
        </div>

        <!-- GC bitmap -->
        <div class="bitmap-row">
          <div class="bitmap-label">GC bitmap</div>
          <div
            v-for="(b, i) in cells"
            :key="i"
            class="bit"
            :class="{ one: b.ref, head: b.head }"
            @mouseenter="activeCell = i"
          >{{ b.ref ? 1 : 0 }}</div>
        </div>

        <!-- 图例 -->
        <div class="legend">
          <span class="lg lg-head">对象头</span>
          <span class="lg lg-ref">引用字段（bit=1，GC 扫描）</span>
          <span class="lg lg-value">值类型字段（bit=0）</span>
          <span class="lg lg-pad">对齐 padding</span>
        </div>

        <!-- 详情面板 -->
        <div class="detail-panel">
          <template v-if="activeCell >= 0">
            <div class="detail-title">word {{ activeCell }}（0x{{ (activeCell * 8).toString(16).padStart(2, '0') }}）</div>
            <div v-for="f in cells[activeCell].fields" :key="f.name" class="detail-row">
              <span class="detail-name">{{ f.name }}</span>
              <span class="detail-type">{{ f.type }}</span>
              <span class="detail-desc">{{ f.desc }}</span>
            </div>
            <div v-if="cells[activeCell].pad" class="detail-row">
              <span class="detail-name">padding</span>
              <span class="detail-type">对齐</span>
              <span class="detail-desc">{{ cells[activeCell].padDesc }}</span>
            </div>
          </template>
          <div v-else class="detail-empty">← 鼠标悬停到内存条/bitmap 上查看每个字段的存储细节</div>
        </div>
      </div>
    </div>

    <!-- 教学要点 -->
    <div class="teach">
      <div class="teach-title">🎯 {{ current.teachTitle }}</div>
      <ul>
        <li v-for="(t, i) in current.teach" :key="i">{{ t }}</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

// ============ 预设类（分页解析） ============
const CLASSES = [
  {
    name: 'simple',
    label: '① 引用 + 值类型',
    code: `class Player
{
    string name;   // 引用 → 8B 堆指针
    int level;     // 值类型 → 4B 内联
}`,
    layout: [
      { off: 0x00, size: 8, head: true, fields: [{ name: 'klass/vtable', type: '对象头', desc: '类型描述符指针（也是虚表入口），GC 从这里拿 gc_desc' }] },
      { off: 0x08, size: 8, head: true, fields: [{ name: 'monitor', type: '对象头', desc: '锁数据指针（lock/wait 用），默认 null' }] },
      { off: 0x10, size: 8, ref: true, fields: [{ name: 'name', type: 'string 引用', desc: '指向堆上的 string 对象。引用字段必须 8B 对齐，bitmap 置位 → GC 沿它扫描 string 内容（保守）' }] },
      { off: 0x18, size: 4, value: true, fields: [{ name: 'level', type: 'int', desc: '4B 内联值，直接存在对象里，不指向任何地方' }] },
      { off: 0x1C, size: 4, pad: true, fields: [], padDesc: 'int 只占 4B，后面补 4B 对齐到 8B 边界（对象尾部对齐到最大成员）' },
    ],
    teachTitle: '引用 vs 值类型的第一性区别',
    teach: [
      '引用字段存的是"堆上另一个对象的地址"（8B 指针），值类型字段存的是"数据本身"',
      'GC bitmap 只对引用字段置位——值类型字段的值再大也不会被当成指针',
      'instance_size = 16B 头 + 8B name + 4B level + 4B padding = 32B',
    ],
  },
  {
    name: 'struct',
    label: '② struct 内联展开',
    code: `struct Vector3 { float x, y, z; }

class Transform
{
    Vector3 pos;      // struct → 12B 内联展开
    Vector3 rot;      // 3×float = 12B
    int index;        // 值类型
}`,
    layout: [
      { off: 0x00, size: 8, head: true, fields: [{ name: 'klass/vtable', type: '对象头', desc: '类型描述符指针' }] },
      { off: 0x08, size: 8, head: true, fields: [{ name: 'monitor', type: '对象头', desc: '锁数据指针' }] },
      { off: 0x10, size: 8, value: true, fields: [{ name: 'pos.x', type: 'float', desc: 'struct 字段内联展开——成员直接嵌在对象里，不存指针' }, { name: 'pos.y', type: 'float', desc: '3 个 float 连续存放，共 12B' }] },
      { off: 0x18, size: 4, value: true, fields: [{ name: 'pos.z', type: 'float', desc: '第 12 字节，与下一个字段同 word' }] },
      { off: 0x1C, size: 8, value: true, fields: [{ name: 'rot.x', type: 'float', desc: '第 2 个 struct 从 0x1C 开始（float 4B 对齐）' }, { name: 'rot.y', type: 'float', desc: '' }, { name: 'rot.z', type: 'float', desc: '' }] },
      { off: 0x24, size: 4, value: true, fields: [{ name: 'index', type: 'int', desc: '4B 内联值' }] },
      { off: 0x28, size: 4, pad: true, fields: [], padDesc: '对象尾部对齐到 8B → instance_size = 0x30 = 48B' },
    ],
    teachTitle: 'struct 字段是"展开"不是"引用"',
    teach: [
      'struct 成员直接嵌在对象里（GetBitmapNoInit 递归进 struct 内部置位引用字段）——struct 不产生堆对象',
      'struct 里的引用字段（如 struct S { string s; }）会被递归标记进 bitmap',
      'struct 字段按自身最大成员对齐（float=4B），对象整体按 8B 对齐',
    ],
  },
  {
    name: 'array',
    label: '③ 数组/字符串引用',
    code: `class Inventory
{
    int[] slots;       // array 引用 → 8B 指针
    string title;      // string 引用 → 8B 指针
    int count;         // 值类型
}`,
    layout: [
      { off: 0x00, size: 8, head: true, fields: [{ name: 'klass/vtable', type: '对象头', desc: 'Inventory 的 Il2CppClass（rank=0）' }] },
      { off: 0x08, size: 8, head: true, fields: [{ name: 'monitor', type: '对象头', desc: '锁数据指针' }] },
      { off: 0x10, size: 8, ref: true, fields: [{ name: 'slots', type: 'int[] 引用', desc: '指向堆上的数组对象。数组对象的 klass->rank>0，GC 描述符 = GC_NO_DESCRIPTOR（内容保守扫描）' }] },
      { off: 0x18, size: 8, ref: true, fields: [{ name: 'title', type: 'string 引用', desc: '指向堆上的 string 对象。string 类同样无精确描述符 → 内容按保守扫' }] },
      { off: 0x20, size: 4, value: true, fields: [{ name: 'count', type: 'int', desc: '4B 内联值' }] },
      { off: 0x24, size: 4, pad: true, fields: [], padDesc: '对齐 padding → instance_size = 0x28 = 40B' },
    ],
    teachTitle: 'array/string 是引用，但 GC 描述符是保守的',
    teach: [
      '数组和字符串的引用字段会被 bitmap 置位（它们是引用）',
      '但数组/string 对象自身没有精确 GCJ 描述符（MakeDescriptorForArray/String 返回 GC_NO_DESCRIPTOR）——它们的元素/内容按保守式扫描',
      '所以"数组里的 int 恰好等于某对象地址"仍可能误判——这是浮动垃圾的来源之一',
    ],
  },
  {
    name: 'inherit',
    label: '④ 继承链字段排列',
    code: `class Character  // : Object
{
    string name;      // 基类字段
    int hp;           // 基类字段
}

class Player : Character
{
    string mainWeapon; // 派生字段
    bool isAlive;      // 派生字段
}`,
    layout: [
      { off: 0x00, size: 8, head: true, fields: [{ name: 'klass/vtable', type: '对象头', desc: 'Player 的 Il2CppClass（klass->parent = Character 的 Il2CppClass）' }] },
      { off: 0x08, size: 8, head: true, fields: [{ name: 'monitor', type: '对象头', desc: '锁数据指针' }] },
      { off: 0x10, size: 8, ref: true, fields: [{ name: 'name', type: 'string 引用', desc: '基类字段排前面（继承链：Object → Character → Player 的字段顺序）' }] },
      { off: 0x18, size: 4, value: true, fields: [{ name: 'hp', type: 'int', desc: '基类值类型字段' }] },
      { off: 0x1C, size: 4, pad: true, fields: [], padDesc: 'padding 到 8B' },
      { off: 0x20, size: 8, ref: true, fields: [{ name: 'mainWeapon', type: 'string 引用', desc: '派生类字段在基类之后' }] },
      { off: 0x28, size: 1, value: true, fields: [{ name: 'isAlive', type: 'bool', desc: '1B 内联值' }] },
      { off: 0x29, size: 7, pad: true, fields: [], padDesc: '尾部 padding → instance_size = 0x30 = 48B' },
    ],
    teachTitle: '继承 = 字段按基类→派生顺序连续排列',
    teach: [
      '基类字段在前、派生字段在后（C# 布局保证派生类对象可以安全强转成基类指针）',
      'GetBitmapNoInit 遍历"当前类 → parent 链向上"，但按绝对 offset 置位，顺序不影响正确性',
      'is 检查走 klass->typeHierarchy（从 Object 到 Player 的指针链），与字段布局无关',
    ],
  },
  {
    name: 'alltypes',
    label: '⑤ 全类型大杂烩',
    code: `class Everything
{
    string name;      // 引用
    Vector3 pos;      // struct 内联
    int[] buffs;      // array 引用
    long score;       // 8B 值类型
    bool active;      // 1B
    IntPtr nativePtr; // 指针（非引用）
    // static int count;  ⭐ 不在实例里！
}`,
    layout: [
      { off: 0x00, size: 8, head: true, fields: [{ name: 'klass/vtable', type: '对象头', desc: '类型描述符指针' }] },
      { off: 0x08, size: 8, head: true, fields: [{ name: 'monitor', type: '对象头', desc: '锁数据指针' }] },
      { off: 0x10, size: 8, ref: true, fields: [{ name: 'name', type: 'string 引用', desc: '引用 → bitmap 置位' }] },
      { off: 0x18, size: 8, value: true, fields: [{ name: 'pos.x', type: 'float', desc: 'struct 展开（3×float=12B）' }, { name: 'pos.y', type: 'float', desc: '' }] },
      { off: 0x20, size: 4, value: true, fields: [{ name: 'pos.z', type: 'float', desc: '12B 的第 3 个 float' }] },
      { off: 0x24, size: 4, pad: true, fields: [], padDesc: '对齐到 8B（下一个是 8B 引用）' },
      { off: 0x28, size: 8, ref: true, fields: [{ name: 'buffs', type: 'int[] 引用', desc: '数组引用 → bitmap 置位' }] },
      { off: 0x30, size: 8, value: true, fields: [{ name: 'score', type: 'long', desc: '8B 值类型，整格内联' }] },
      { off: 0x38, size: 1, value: true, fields: [{ name: 'active', type: 'bool', desc: '1B 内联' }] },
      { off: 0x39, size: 7, pad: true, fields: [], padDesc: 'IntPtr 是 8B 类型要 8B 对齐 → 补 7B' },
      { off: 0x40, size: 8, value: true, fields: [{ name: 'nativePtr', type: 'IntPtr', desc: '8B 内联。注意：PTR 类型 bitmap 不置位（GetBitmapNoInit 的 IL2CPP_TYPE_PTR 分支直接 break）——GC 不扫它' }] },
    ],
    teachTitle: '全部存储方式 + static 去哪了',
    teach: [
      'GC bitmap 只有 3 个 1：name(2)、buffs(5)——IntPtr 是 PTR 类型，即使 8B 也不置位',
      'static 字段不在实例里！它存在 klass->static_fields 指向的独立内存区，是 GC Root',
      'instance_size = 0x48 = 72B，实例只含非静态字段',
    ],
  },
]

const current = ref(CLASSES[0])
const activeCell = ref(-1)

const cells = computed(() => {
  const layout = current.value.layout
  const maxWord = Math.max(...layout.map(f => Math.floor(f.off / 8))) + 1
  // 布局按 offset 排序，逐格映射到 8B word
  const result = []
  for (let i = 0; i < maxWord; i++) {
    const start = i * 8
    const inThis = layout.filter(f => f.off >= start && f.off < start + 8)
    if (!inThis.length) continue
    const cell = {
      offsetText: '0x' + start.toString(16).padStart(2, '0'),
      fields: inThis.flatMap(f => f.fields.length ? f.fields : [{ name: '(padding)', type: '对齐', desc: '' }]),
      head: inThis.some(f => f.head),
      ref: inThis.some(f => f.ref),
      value: inThis.some(f => f.value),
      pad: inThis.some(f => f.pad),
      padDesc: (inThis.find(f => f.pad) || {}).padDesc || '',
    }
    result.push(cell)
  }
  return result
})

function selectClass(name) {
  current.value = CLASSES.find(c => c.name === name) || CLASSES[0]
  activeCell.value = -1
}
</script>

<style scoped>
.layout-viewer {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 16px;
  margin: 16px 0;
  background: #f8fafc;
}
.class-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.class-tabs button {
  padding: 6px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.class-tabs button.active {
  background: #1971c2;
  color: #fff;
  border-color: #1971c2;
}
.layout-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.code-panel, .mem-panel {
  flex: 1;
  min-width: 300px;
}
.panel-title {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 8px;
  font-weight: 600;
}
.code-panel pre {
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
  overflow-x: auto;
}
.mem-bar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.mem-cell {
  width: 88px;
  min-height: 64px;
  border: 2px solid #cbd5e1;
  border-radius: 6px;
  background: #fff;
  padding: 5px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mem-cell:hover, .mem-cell.active {
  transform: scale(1.06);
  z-index: 2;
  box-shadow: 0 3px 10px rgba(0,0,0,0.15);
}
.mem-cell.head { border-color: #1971c2; background: #e7f5ff; }
.mem-cell.ref { border-color: #2f9e44; background: #ebfbee; }
.mem-cell.value { border-color: #f08c00; background: #fff9db; }
.mem-cell.pad { border-color: #cbd5e1; background: #f1f3f5; border-style: dashed; }
.cell-offset { font-family: ui-monospace, Menlo, monospace; color: #94a3b8; font-size: 10px; }
.cell-name { font-weight: 700; font-size: 11px; color: #343a40; }
.cell-name.multi { display: flex; flex-wrap: wrap; gap: 3px; }
.cell-name.multi span { background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; }
.cell-bit { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #94a3b8; margin-top: auto; }
.bitmap-row {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-bottom: 10px;
}
.bitmap-label { font-size: 11px; color: #64748b; font-weight: 600; margin-right: 6px; }
.bit {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid #cbd5e1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  background: #f1f3f5;
  color: #94a3b8;
}
.bit.one { background: #2f9e44; color: #fff; border-color: #2f9e44; }
.bit.head { background: #1971c2; color: #fff; border-color: #1971c2; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: #64748b; margin-bottom: 12px; }
.lg::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: -1px;
}
.lg-head::before { background: #1971c2; }
.lg-ref::before { background: #2f9e44; }
.lg-value::before { background: #f08c00; }
.lg-pad::before { background: #e9ecef; border: 1px dashed #adb5bd; }
.detail-panel {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 14px;
  min-height: 70px;
  font-size: 12px;
}
.detail-title { font-weight: 700; margin-bottom: 6px; color: #343a40; }
.detail-row { display: flex; gap: 10px; margin-bottom: 4px; align-items: baseline; }
.detail-name { font-weight: 600; width: 90px; color: #1971c2; flex-shrink: 0; }
.detail-type { width: 110px; color: #f08c00; flex-shrink: 0; }
.detail-desc { color: #475569; }
.detail-empty { color: #94a3b8; }
.teach {
  margin-top: 14px;
  background: #fff9db;
  border: 1px solid #f08c00;
  border-radius: 8px;
  padding: 10px 14px;
}
.teach-title { font-weight: 700; margin-bottom: 6px; font-size: 13px; color: #343a40; }
.teach ul { margin: 0; padding-left: 18px; font-size: 12px; color: #495057; line-height: 1.8; }
</style>
