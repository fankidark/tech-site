# 🧪 内存布局查看器：class 与 object 逐字节

> 动手解析 **IL2CPP 对象内存布局**：切换预设类，看每个字段在对象里的存储位置、存储方式、GC bitmap 位。
> 与 [🧱 class 与 object 的存储结构](./object-layout) 一文配合：文章讲原理，这里看图。

<script setup>
import MemoryLayoutViewer from './components/MemoryLayoutViewer.vue'
</script>

## 这个查看器在帮你回答什么问题

你写了一个类，它到底占多少字节？字段是按你写的顺序排的吗？
为什么加个方法不涨体积，换个字段顺序却可能变小？**GC 又是怎么知道哪个字段是指针？**

这几个问题的答案都在同一个地方：对象的那段内存。但这段内存平时看不见——
只能在调试器里盯着一堆十六进制。这个查看器把它摊开画出来：
每个格子是 8 字节（一个字），颜色告诉你这格是什么，底下的 bitmap 告诉你 GC 怎么看它。

**一个提醒**：这里的对象头是固定的 16 字节（`klass` 指针 + `monitor`），
所以你哪怕只写一个 `bool` 字段，对象也要占 24 字节——**属于你数据的只有 1 字节**。
这是"少造小对象"这条建议的物理依据。

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

## 自检清单

- [ ] 对象头占多少字节？里面那两个字段分别是什么、各解决什么问题？
- [ ] 为什么引用字段那格的 bitmap 是 1，值类型是 0？这个 bit 给谁看？
- [ ] `Vector3` 字段在对象里占几个格子？如果是 `class` 而不是 `struct` 呢？
- [ ] 切换预设类时，`instance_size` 和"字段大小之和"对得上吗？差在哪？
- [ ] static 字段为什么不出现在对象布局里？它们存哪去了？
- [ ] 一个只有 `bool` 字段的类，实例实际占多少字节？你的数据占其中几字节？
- [ ] 如果给这个类加 10 个方法，上面的格子会变吗？为什么？

## 延伸阅读

- [class 与 object 的存储结构](./object-layout) — 原理详解（Il2CppClass / Il2CppObject 两套存储）
- 🧱 [自己排字段看对齐](./object-layout#亲手排一次字段-可交互) — 换个角度：动手调字段顺序，看 padding 怎么变
- [托管堆 GC](./managed-heap-gc) — bitmap 是怎么生成的、GC 怎么用它扫描
