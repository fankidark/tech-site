# 🧪 TLSF 交互模拟器

> 动手体验 TLSF 的每一步：**分配 → 查找位图 → 分割 → trim → 释放 → 合并**。
> 开启「单步模式」，点分配/释放，用「下一步」逐步看算法执行，每步有解释。
> 算法忠实翻译自 `External/Allocator/tlsf/tlsf.c`（SL=32 槽、FL=25 类、8B 对齐、256B 小块阈值）。

<script setup>
import TlsfSimulator from './components/TlsfSimulator.vue'
</script>

<TlsfSimulator />

## 使用建议（按学习顺序）

1. **只看不动**：先点几次「分配」（如 64B/128B/32B），关单步模式直接完成，观察内存条上块如何分割、位图如何亮起
2. **单步学习**：开启「单步模式」分配一块 64B —— 你会依次看到：映射计算 → 位图查找 → 命中块 → 分割 → 剩余入池
3. **重点看释放**：分配两块相邻的内存再释放其中一块，观察 **block_merge_prev / block_merge_next** 的合并动画（两块合一大块）
4. **理解碎片**：连续分配 64B×6，释放第 2、4、6 块，再尝试分配 128B —— 观察外部碎片如何导致"有空闲但不够大"
5. **对照源码**：每步解释都对应 `tlsf.c` 的具体函数（mapping_search / search_suitable_block / block_split / block_merge_prev）

## 对照表：模拟器 ↔ 源码

| 模拟器步骤 | 源码函数 | 说明 |
|---|---|---|
| 映射计算 | `mapping_insert` / `mapping_search` (tlsf.c:508/528) | size → (fl, sl) 槽 |
| 位图查找 | `search_suitable_block` (tlsf.c:538) | sl_bitmap → fl_bitmap → ffs |
| 命中摘除 | `remove_free_block` (tlsf.c:571) | 双向链表摘除 + 位图维护 |
| 分割 | `block_split` (tlsf.c:642) | 切出请求大小，剩余为新空闲块 |
| 尾部回收 | `block_trim_free` (tlsf.c:705) | 分配后多余尾部还给池 |
| 释放合并 | `block_merge_prev` / `block_merge_next` (tlsf.c:674/689) | 前后相邻空闲块合并 |
| 插入链表 | `insert_free_block` (tlsf.c:600) | 头插 + 置位图 |

## 局限说明（教学简化）

- 模拟器用**物理块列表** + 每槽链表头表示空闲链表，真实 TLSF 是完整双向链表
- 内存条仅 512B（真实 Unity 用 256MB 虚拟预留 + 多 Pool），便于观察
- 块头开销（prev_phys_block + size 状态位）未逐字节模拟，聚焦算法流程
