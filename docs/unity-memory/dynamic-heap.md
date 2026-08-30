# DynamicHeapAllocator：TLSF 的工程集成

> 源码：`Runtime/Allocator/DynamicHeapAllocator.cpp` / `.h`
> Unity 把纯 C 的 TLSF 封装成生产级分配器：**256MB 虚拟预留 + 多 Pool 扩展 + BucketAllocator 快路径 + LargeAlloc 溢出路径**。

## 设计总览（源码注释）

`DynamicHeapAllocator.h` 开头注释直接写明：

> DynamicHeapAllocator - 基于 TLSF 的主力通用分配器
> TLSF (Two-Level Segregated Fit) 算法:
>   VirtualAllocator 预留大块虚拟地址 (kReserveBlockGranularity = 256MB)
>   → 划分为多个 Pool (每个 Pool 是一个独立的 TLSF 实例)
>   → 每个 Pool 内部 TLSF 管理小块分配
>   - 小分配先尝试 BucketAllocator (≤64B, lock-free, 更快)
>   - 中等分配走 TLSF (确定性 O(1))
>   - 大分配直接向 VirtualAllocator 申请独立块

## 内存布局

源码内的 ASCII 布局图（DynamicHeapAllocator.cpp:21-54）：

```
64 位（每大块内多个 TLSF Pool）：
|---------------|---------------|---------------|---------------|
|MBInfo|FreeList|*  xx       x  |*  x    xxx    |* xxx       xx |
|* x    x    xx |   x     x     |        x  xx  |     xx    x   |
|  x         |PI|    xxx     |PI|   xxxxx x  |PI|   xx    xx |PI|
|---------------|---------------|---------------|---------------|

32 位（独立 TLSF Pool）：
|----------------------------------------------------------------|
|  x           xx       xxx   x          x x      x xx        |PI|
|----------------------------------------------------------------|

Large Alloc（大块独立分配）：
|-----------------------------------|
|LAInfo|xxxxxxxxxxxxxxxxxxxxxxxxxxxx|
|-----------------------------------|
```

- `MBInfo`：MemoryBlockInfo，管理一块 256MB 预留内所有 Pool 的链表
- `PI`：PoolInfo，每个 TLSF Pool 的头信息
- `LAInfo`：LargeAllocInfo，大块分配的头信息

## 构造：预留与 TLSF 实例

```cpp
// DynamicHeapAllocator.cpp:84
DynamicHeapAllocator::DynamicHeapAllocator(
    UInt32 poolIncrementSize, bool useLocking,
    BucketAllocator* bucketAllocator, LowLevelVirtualAllocator* llAlloc,
    const char* name, bool checkEmptyOnDestruct)
    : m_BucketAllocator(bucketAllocator)
    , m_UseLocking(useLocking)
{
    m_RequestedPoolSize = poolIncrementSize;   // 单个 Pool 大小（2 的幂）
    m_RequestedBlockSize = LowLevelVirtualAllocator::kReserveBlockGranularity; // 256MB
    m_RequestedBlockSize = std::max(m_RequestedBlockSize, (size_t)poolIncrementSize);
#if MEMORY_USE_LARGE_BLOCKS
    m_PoolsPerBlock = m_RequestedBlockSize / poolIncrementSize;  // 一块 256MB 切 N 个 Pool
#endif
    InitializeTLSF();
}

// 创建一个全局 TLSF 控制结构（800 链表头 + 位图）
void DynamicHeapAllocator::InitializeTLSF()
{
    m_TlsfInstance = tlsf_create(GetMemoryManager().LowLevelAllocate(tlsf_size(), tlsf_align_size()));
}
```

## Allocate：三级路径

```cpp
// DynamicHeapAllocator.cpp:409
void* DynamicHeapAllocator::Allocate(size_t size, int align)
{
    // 路径 1：≤64B 走 BucketAllocator（lock-free 桶分配，更快）
    if (m_BucketAllocator != NULL && m_BucketAllocator->CanAllocate(size, align))
    {
        void* realPtr = m_BucketAllocator->Allocate(size, align);
        if (realPtr != NULL)
            return realPtr;
    }

    // realSize 先做 AllocationHeader 开销 + 对齐 + TLSF 块对齐（>32B 时对齐到 2 的幂边界）
    size_t realSize = AllocationHeader::CalculateNeededAllocationSize(size, align);
    if (realSize > 32)
    {
        size_t tlsfalign = (1 << HighestBit(realSize >> 5)) - 1;
        realSize = (realSize + tlsfalign) & ~tlsfalign;
    }

    if (m_UseLocking) m_DHAMutex.Lock();       // 可选互斥锁

    // 路径 2：TLSF（主体）
    newRealPtr = (char*)tlsf_memalign(m_TlsfInstance, allocationAlignment, realSize);
    if (newRealPtr)
        GetPoolInfo(newRealPtr)->allocationCount += 1;

    if (m_UseLocking) m_DHAMutex.Unlock();

    if (newRealPtr == NULL)
    {
        // 路径 2b：TLSF 满了且请求 < Pool/2 → 新建 Pool 扩容（懒扩展）
        if (size < m_RequestedPoolSize / 2)
        {
            size_t blockSize;
            void* memoryBlock = CreateTLSFPool(blockSize);   // 从 256MB 预留里切新 Pool
            tlsf_add_pool(m_TlsfInstance, memoryBlock, blockSize);
            newRealPtr = (char*)tlsf_memalign(m_TlsfInstance, allocationAlignment, realSize);
        }

        if (newRealPtr == NULL)
        {
            // 路径 3：大块 → 直接虚拟内存分配（绕过 TLSF）
            realSize = AllocationHeaderWithSize::CalculateNeededAllocationSize(
                size + sizeof(LargeAllocInfo), align);
            realSize = AlignSize(realSize, m_LLAlloc->GetPageSize());
            void* largeAllocPtr = RequestLargeAllocMemory(realSize, commitSize);
            LargeAllocInfo* largeAllocNode = (LargeAllocInfo*)largeAllocPtr;
            new(largeAllocNode) LargeAllocInfo();
            largeAllocNode->allocatedSize = commitSize;
            mbInfo->m_LargeAllocs.push_back(*largeAllocNode);   // 记录到大块链表
            newRealPtr = (char*)(largeAllocNode + 1);
        }
    }
    // 写入 AllocationHeader（大小/对齐信息，供 free/realloc/Contains 用）
}
```

**三级路径决策**：

| 请求大小 | 路径 | 特点 |
|---|---|---|
| ≤ 64 B | BucketAllocator | 无锁桶，最快 |
| 64 B ~ Pool 大小 | TLSF | O(1) 确定性，碎片可控 |
| ≥ Pool/2 或 TLSF 扩容失败 | LargeAlloc | 直接虚拟分配，独立块 |

## Pool 扩展策略

- 初始：只创建 TLSF 控制结构，**不预分配用户内存**（懒加载）
- 首次分配：`CreateTLSFPool()` 从 256MB 预留中切出第一个 Pool（大小 = `m_RequestedPoolSize`，默认 64KB/128KB 级别，可按需配置）
- 后续 TLSF 满：`size < m_RequestedPoolSize/2` 时继续切新 Pool 并 `tlsf_add_pool`（一个 TLSF 实例可挂多个 pool）
- 大请求（≥ Pool/2）：直接 `RequestLargeAllocMemory`，避免大块挤占 Pool 空间造成碎片

## 为什么分 Pool

TLSF 的单 pool 是连续内存段。Unity 用 256MB 虚拟预留 + 多 Pool：
1. **虚拟地址连续，物理按需 commit**：256MB 只是 reserve，真正 commit 才占物理内存
2. **碎片隔离**：大块走 LargeAlloc，不和小块混在同一个 Pool 里
3. **Pool 粒度管理**：Pool 用完可以整块归还，分配计数 `allocationCount` 支持空 Pool 检测

## 与 TLSAllocator 的分工

| | TLSAllocator | DynamicHeapAllocator |
|---|---|---|
| 生命周期 | 帧内临时（Temp） | 长命/通用（Persistent/默认） |
| 结构 | 每线程 StackAllocator | TLSF + Bucket + LargeAlloc |
| 锁 | 无锁 | 可选互斥锁（useLocking） |
| 回收 | 帧末整体重置 | free 时合并 |
| 容量 | Editor 128MB / Runtime 8MB | 256MB 虚拟预留 + 懒扩展 |

**典型协作**：`Allocator.Temp` 数据帧末被 TLSAllocator 整体回收；需要跨帧存活的数据（`Allocator.Persistent`）走 DynamicHeapAllocator；两者都最终向 `LowLevelVirtualAllocator`（系统虚拟内存）要页。

## 关键代码索引

| 位置 | 内容 |
|---|---|
| `DynamicHeapAllocator.cpp:84` | 构造函数（Pool 大小、锁、256MB 预留） |
| `DynamicHeapAllocator.cpp:113` | `InitializeTLSF()` |
| `DynamicHeapAllocator.cpp:409` | `Allocate()` 三级路径 |
| `DynamicHeapAllocator.cpp:21-54` | 内存布局 ASCII 图 |
| `DynamicHeapAllocator.h` | 设计注释（TLSF 集成策略） |

## 延伸阅读

- [TLSF：两级分割适应算法](./tlsf) — 算法本身
- [TLS：每线程临时内存分配](./tls) — 互补的帧临时分配路径
