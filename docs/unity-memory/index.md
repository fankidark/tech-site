# Unity 内存管理分配细节 — 总览

> 本文基于 **Unity 2020 LTS 源码**（`Runtime/Allocator/`）逐行核实。
> 源码路径：`Runtime/Allocator/`、`External/Allocator/tlsf/`、`Runtime/Threads/ThreadSpecificValue.h`

## 一句话结论

Unity 的托管内存（Mono/IL2CPP GC）和**原生内存**是两套体系。本文讲的是原生侧：Unity C++ 引擎代码（以及 C# 侧 `NativeArray`、`Allocator.Temp` 等）在底层用哪套分配器、怎么分配。

原生内存分配的核心是 **MemoryManager 管理的一组专用分配器**，按用途分三条主路径：

| 分配器 | 用途 | 算法/结构 | 锁 |
|---|---|---|---|
| `TLSAllocator` | 帧内临时分配（`Allocator.Temp`） | 每线程 StackAllocator | **无锁**（TLS） |
| `DynamicHeapAllocator` | 通用堆（`Allocator.Persistent` 等） | **TLSF** + BucketAllocator 快路径 | 可选互斥锁 |
| `PageAllocator` / 系统 | 大块、对齐敏感 | 虚拟内存页 | 系统级 |

## 分配器体系（BaseAllocator 派生树）

`Runtime/Allocator/` 下所有分配器都继承自 `BaseAllocator`：

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

## 三篇文章路线

1. **[TLS：每线程临时内存分配](./tls)** — `TLSAllocator` 如何用线程局部存储实现无锁帧分配、块复用与容量管理
2. **[TLSF：两级分割适应算法](./tlsf)** — `External/Allocator/tlsf` 的完整算法拆解（两级位图、O(1) 查找、分割/合并）
3. **[DynamicHeapAllocator：TLSF 的工程集成](./dynamic-heap)** — 256MB 虚拟预留、多 Pool 扩展、BucketAllocator 快路径、LargeAlloc 溢出路径

> 阅读建议：先看 TLSF 算法（它是理解 DynamicHeapAllocator 的前提），再看工程集成。
