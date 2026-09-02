# 🧪 内存布局查看器：class 与 object 逐字节

> 动手解析 **IL2CPP 对象内存布局**：切换预设类，看每个字段在对象里的存储位置、存储方式、GC bitmap 位。
> 与 [🧱 class 与 object 的存储结构](./object-layout) 一文配合：文章讲原理，这里看图。

<script setup>
import MemoryLayoutViewer from './components/MemoryLayoutViewer.vue'
</script>

<MemoryLayoutViewer />

## 使用建议（按学习顺序）

1. **① 引用 + 值类型**：先看最简单的——`name`（引用字段）整格绿色、bit=1；`level`（值类型）黄色、bit=0。这是全部布局知识的地基
2. **② struct 内联展开**：看 `Vector3` 的 3 个 float 怎么"嵌"在对象里——**没有指针、没有堆对象**，hover 到格子看解释
3. **③ 数组/字符串引用**：引用字段置位，但记住数组/string **对象本身**没有精确描述符（内容保守扫）
4. **④ 继承链**：基类字段在前、派生字段在后——这就是"派生类对象能强转成基类指针"的物理基础
5. **⑤ 全类型大杂烩**：覆盖全部存储方式 + IntPtr（PTR 类型不置位）+ static 字段去哪了

## 每个格子怎么看

| 格子颜色 | 含义 | bitmap |
|---|---|---|
| 🔵 蓝色 | 对象头（klass/vtable + monitor，16B） | 恒 0 |
| 🟢 绿色 | **引用字段**（8B 堆指针） | **1**（GC 扫描） |
| 🟡 黄色 | 值类型字段（内联数据） | 0 |
| ⬜ 虚线灰 | 对齐 padding（不是字段） | 0 |

**悬停任意格子** → 底部详情面板显示该 word 里每个字段的存储说明（为什么这样存、GC 怎么看它）。

## 对应源码

| 布局规则 | 源码 |
|---|---|
| bitmap 按 `offset/8` 置位 | `libil2cpp/vm/Class.cpp:1869-1928`（GetBitmapNoInit） |
| struct 字段递归置位 | `libil2cpp/vm/Class.cpp:1934` |
| 引用字段 8B 对齐断言 | `libil2cpp/vm/Class.cpp:1904` |
| 分配按 instance_size 开内存 | `libil2cpp/vm/Object.cpp:299-304` |
| 对象头 16B（klass+monitor） | `libil2cpp/il2cpp-object-internals.h:66` |
