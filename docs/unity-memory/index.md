# Unity 内存管理分配细节 — 总览

> 本文基于 **Unity 2020 LTS 源码**（`Runtime/Allocator/`、`Runtime/Threads/`、`External/il2cpp/`）逐行核实。
> 源码路径：`Runtime/Allocator/`、`External/Allocator/tlsf/`、`Runtime/Threads/`、`External/il2cpp/builds/libil2cpp/gc/`

## 一句话结论

Unity 的内存是**两套体系**：

- **原生内存**：引擎 C++ 代码（以及 C# 侧 `NativeArray`、`Allocator.Temp`）在底层用 MemoryManager 管理的一组专用分配器；
- **托管内存**：C# 侧 `new` 出来的对象，由 GC 自动回收——**IL2CPP（真机）用 Boehm 保守式 GC，不分代不压缩；Mono（Editor）用 sgen，真分代真移动**。

原生内存分配的核心是 **MemoryManager 管理的一组专用分配器**，按用途分三条主路径：

| 分配器 | 用途 | 算法/结构 | 锁 |
|---|---|---|---|
| `TLSAllocator` | 帧内临时分配（`Allocator.Temp`） | 每线程 StackAllocator | **无锁**（TLS） |
| `DynamicHeapAllocator` | 通用堆（`Allocator.Persistent` 等） | **TLSF** + BucketAllocator 快路径 | 可选互斥锁 |
| `PageAllocator` / 系统 | 大块、对齐敏感 | 虚拟内存页 | 系统级 |

## 分配器体系（BaseAllocator 派生树）

```
BaseAllocator
├── TLSAllocator                  ← 每线程 StackAllocator（kMemTempAlloc）
├── DynamicHeapAllocator          ← TLSF 主力通用分配器（kMemDefault）
├── StackAllocator                ← 栈式分配（TLSAllocator 内部使用）
├── LinearAllocator               ← 线性分配（一次性）
├── BlockDoublingLinearAllocator  ← 倍增线性分配
├── BatchAllocator                ← 批量分配
├── BucketAllocator               ← ≤64B 无锁桶分配（DynamicHeap 快路径）
├── DualThreadAllocator           ← 双线程配对
├── QueueAllocator                ← 队列式
├── FixedSizeAllocator            ← 定长块
├── PageAllocator                 ← 页分配
└── DebugAllocator                ← 调试用（内存标记/泄漏检测）
```

顶层由 `MemoryManager`（`MemoryManager.h`）统一注册与管理，`ALLOC_XXX` 宏按 label 路由到对应分配器。

## 核心分配标签

| Label | 分配器 | 典型场景 |
|---|---|---|
| `kMemTempAlloc` / `ALLOC_TEMP_AUTO` | `TLSAllocator` | 帧内临时内存、`Allocator.Temp` |
| `kMemDefault` | `DynamicHeapAllocator` | 通用持久分配、`Allocator.Persistent` |
| `kMemProfiler` / 专用 | 专用实例 | Profiler 数据等 |

## 系列文章路线

### 原生侧：分配与释放

1. **[一次分配的完整旅程](./allocator-journey)** — `UNITY_NEW` 从宏到物理内存：label 路由 → DualThread → Bucket/TLSF/LargeAlloc 三级瀑布。**系列入口，先读这篇**
2. **[TLS：每线程临时内存分配](./tls)** — `TLSAllocator` 如何用线程局部存储实现无锁帧分配、块复用与容量管理
3. **[TLSF：两级分割适应算法](./tlsf)** — `External/Allocator/tlsf` 的完整算法拆解（两级位图、O(1) 查找、分割/合并）+ 🧪 交互模拟器
4. **[DynamicHeapAllocator：TLSF 的工程集成](./dynamic-heap)** — 256MB 虚拟预留、多 Pool 扩展、BucketAllocator 快路径、LargeAlloc 溢出路径
5. **[AtomicStack：无锁栈](./atomic-stack)** — 128 位 DCAS（指针+版本号）免疫 ABA、release/acquire 最小充分内存序
6. **[Deallocate 全流程](./deallocate)** — 一个裸指针如何找回自己的 Allocator：信任降级瀑布 + BlockInfo 户口本反查

### 托管侧：GC

7. **[托管堆 GC：为什么不分代不压缩](./managed-heap-gc)** — Boehm 保守式 GC 的因果链、增量式 GC 与写屏障、Mono/IL2CPP 跨后端对比 + 🧪 标记-清除模拟器

### 🧪 交互模拟器

- [TLSF 可视化模拟器](./tlsf-sim) — 单步执行分配/释放、位图可视化、分割合并动画
- [GC 标记-清除模拟器](./managed-heap-gc#🧪-动手体验保守式标记-清除-gc-模拟器) — 保守式扫描的误判可视化、增量式分片

> 阅读建议：先走一遍 [一次分配的完整旅程](./allocator-journey) 建立全局，再看 TLSF 算法，然后按需深入各环节；托管 GC 与原生堆是两套体系，可独立阅读。
