# 手推一遍：18 个字节能变成多小的补丁

> 上一篇：[patch 应用](./hdiff-patch) | 下一篇：[小文件与小重复](./hdiff-minmatch)
> 本篇的每一步都按源码默认参数人工推演（`kMinMatchLen=5`、`kMinMatchScore=2`、7bit 变长整数）。
> 文末给出这个例子在 HDIFF13 与 HDIFFSF20 下的**逐字节**版本，可拿纸笔核对。

<script setup>
import OldNewPatchFlow from './components/OldNewPatchFlow.vue'
import PatchBinaryAnatomy from './components/PatchBinaryAnatomy.vue'
</script>

## 一句话结论

碰上一个 18 字节的旧文件、15 字节的新文件，HDiffPatch 最后只会记住 **一条 cover**（`oldPos:8, newPos:6, length:7`）和 **6 个 gap 字节**。
`ABC` 这三字节虽然在两边都出现，却**根本进不了 cover**——因为 3 字节过不了长度的门槛。

## 输入

```text
oldData: ABCxxxxxDEFyyyyGHI   (18 字节)
newData: ABC123DEFyyyyZZ      (15 字节)
```

肉眼能看出：中间的 `DEFyyyy` 两边一模一样，头和尾都变了。

## 术语先对齐

| 术语 | 一句话解释 |
|---|---|
| **gap** | new 里没被任何 cover 盖住的区间，字节只能原样存进 patch |
| **covered 区** | 被某条 cover 盖住的区间，字节可以从 old 搬 |
| **残差（subDiff）** | covered 区里 `new − old` 的逐字节差（模 256） |
| **控制流成本** | 描述一条 cover 要花的字节数（3 个变长整数） |
| **rle0** | 把"连续的 0"压成一个长度的编码 |

## 主图解：三行字节怎么对上

<OldNewPatchFlow />

先在这个组件里把两步走一遍——**看 ②「covered 区」时把鼠标停在 `DEFyyyy` 上**，你会看到那 7 个字节的残差全是 0。这就是后面"这条 cover 几乎免费"的来源。

## 逐步骤推演

### 步骤 1：从 `newPos=0` 开始扫描

`_search_cover`（`diff.cpp:309`）从 new 的第一个字节开始，每个位置调一次 `getBestMatch`（默认 `matchDeep=2`）：

| newPos | 直觉上能找到什么 | 源码实际行为 | 形成 cover？ |
|---|---|---|---|
| 0 | `ABC` 长度 3 | `getBestMatch` 里 `bestLength` 初值是 `kMinMatchLen-1=4`（`diff.cpp:160`），长度 3 不更新它 → 返回值 < 5；`_search_cover` 判 `matchEqLength<kMinMatchLen` → 跳过（`diff.cpp:314-317`） | ❌ |
| 1~5 | 无更好匹配 | 同上，或匹配长度不足 5 被跳过 | ❌ |
| **6** | **`DEFyyyy` 长度 7** | 返回 `oldPos=8, length=7`；收益判断 `7 − 控制流成本 ≥ 2` 通过（`diff.cpp:319`） | ✅ cover1 |
| 13 | `ZZ` 长度 2 | < 5 → 跳过 | ❌ |

> **很多教程会画 `cover0 = {ABC}`——那是教学简化。** 按源码的 `kMinMatchLen=5` 门槛，`ABC` 这 3 字节根本够不到，它的字节只能进 `newDataDiff`。这一条是本篇最值得记住的"反直觉点"——下一篇文章（[小文件与小重复](./hdiff-minmatch)）会用 7 组实测数据证明它。

### 步骤 2：算控制流成本（决定"7 字节匹配值不值"）

一条 cover 要写三个变长整数（`stream_serialize.cpp:94-101`）。本例是**第一条 cover**，`lastOldEnd` 和 `lastNewEnd` 都是 0：

| 字段 | 值 | 编码 |
|---|---|---|
| `inc_oldPos` | oldPos 8 − lastOldEnd 0 = 8 | 源码把它 ×2 后当无符号写 → 16 → 1 字节 `0x10` |
| `length` | 7 | 1 字节 `0x07` |
| `inc_newPos` | newPos 6 − lastNewEnd 0 = 6 | 1 字节 `0x06` |
| **合计** | | **3 字节** |

收益 `7 − 3 = 4 ≥ 2` ✔ 通过。**注意：即使控制流成本是 5 字节，`7 − 5 = 2 ≥ 2` 也照样通过。** 7 字节的匹配在这个算例里是"稳过"的。

### 步骤 3：产物

```text
covers       = [ {oldPos:8, newPos:6, length:7} ]
newDataDiff  = "ABC123" + "ZZ" = "ABC123ZZ"   (gap 字节连续存储，无分隔符)
subDiff      = covered 区残差：new[6..13) − old[8..15) = 全 0
             → rle0 编码后 = 一个 len0 字段 + 尾标记
控制流       = inc_oldPos(8) + length(7) + inc_newPos(6)   各 1 字节
```

### 步骤 4：应用侧重放

按 [patch 应用篇](./hdiff-patch) 的统一模型，人工执行 single 主循环（`patch.c:2471-2536`）：

```text
newPosBack = 0

① cover1.newPos=6 > 0 → 前面有 6 字节 gap
   从 newDataDiff 拷 6 字节 "ABC123"      → 输出 [0,6)   = ABC123
   （残差流同步跳过这 6 字节，因为 gap 区没有残差）

② covered 区：cover1 {oldPos:8, length:7}
   读 old[8..15) = "DEFyyyy" 到缓存
   rle0 残差 = 全 0 → addData 加 0，缓存不变（patch.c:326-328）
   写出 7 字节                            → 输出 [6,13)  = DEFyyyy
   newPosBack = 6 + 7 = 13

③ 尾部 gap：newPosBack=13 < newDataSize=15
   从 newDataDiff 拷剩余 2 字节 "ZZ"      → 输出 [13,15) = ZZ

④ 终检：inClip 读完 ✔ / outCache 写完 ✔ / coverCount==0 ✔  → 成功
   ✓ 输出 = "ABC123DEFyyyyZZ" = newData，与 CI 产物逐字节一致
```

**每一步的边界（6、13、15）都不是存进 patch 的**，而是应用时用 `cover.newPos − lastNewEnd` 动态算出来的——这就是 gap 流"无分隔符连续存储"能工作的原因。

## 这个例子的 patch 到底有多少字节

上面这个算例太小，正好适合"逐字节摊开"。在 `old="AAAABBBBCCCCDDDD"`（16B）→ `new="AAAABBBBBBCC"`（12B）的同类算例上，两种格式的真实字节是这样长出来的：

<PatchBinaryAnatomy />

**27 字节 vs 45 字节，而 new 只有 12 字节**——两种格式都"亏本"。这不是实现问题，而是差分本身的固定开销：
类型串要 9~10 字节，头部要 10 个或 6 个变长整数，gap 字节一个都省不掉（12 字节里只有 6 字节被复用）。
下一篇会把这笔账算到底。

## 如果匹配再长一点：相似区的残差修正

把例子改一下：`newData = ABC123DEFyyyyxX`（covered 区最后 2 字节变了）：

- 搜索时 `DEFyyyy` 这 7 字节的公共前缀仍然构成 cover1；`extend_cover`（`diff.cpp:467`）可能把"相似"的边界一并纳入
- 此时 `subDiff = new[6..13) − old[8..15)` **不再全 0**：最后 2 字节是 `x − y`、`X − y` 的模 256 差值
- rle0 编码成：`len0=5`（跳过 5 个 0）+ `lenv=2`（2 个非零字节）+ 2 个残差数据字节
- 应用侧 `addData` 把残差加上去 → 正确恢复

这就是"cover 不要求字节完全相同"（[cover 篇](./hdiff-cover)）的具体体现：**用 2 字节残差换掉一条新 cover 的控制流 + 一次 gap 切分**，多数情况更省。在组件里切到「例② 残差非 0」可以直接看到这 2 个红色数字：

<OldNewPatchFlow />

## 反例：什么情况下 diff 反而不如全量

| 场景 | 会发生什么 | 工程对策 |
|---|---|---|
| **新旧文件完全无关**（换了引擎版本的全部资源） | 几乎搜不出 ≥5 字节的匹配 → patch ≈ newData 全量 + 控制流开销 | 成熟管线直接回退全量下载 |
| **小文件**（几百字节） | 控制流与头部占比过高，patch 可能比 new 还大 | 项目侧用"有 patch 就用、失败就全量 AB 兜底"的双轨制规避（见[项目落地](./hdiff-unity)） |
| **高度压缩过的资源** | 压缩后已接近熵极限，差分省下的字节里再压缩也挤不出多少 | 在生成侧比较 patch 体积 vs 全量体积，超阈值就放弃这条 patch |

## 常见误解

::: warning "`ABC` 在两边都有，为什么不算复用？"
因为它太短。`kMinMatchLen=5` 是**硬门槛**，而且卡在最早的一步：`getBestMatch` 的返回值根本不是"最长匹配长度"，而是"最长匹配长度，且不足 5 就报 4"。所以 3 字节匹配**在算法眼里压根不存在**，谈不上"值不值得"。
:::

::: warning "gap 字节是压缩后存的"
在无压缩插件的 patch 里，gap 字节就是**原样**存在 `newDataDiff` 里的（`TNewDataDiffStream`，`stream_serialize.cpp:198`）。打开压缩插件后，整条 step 流会一起被压缩——但那是"整包压缩"，不是对 gap 单独做的特殊处理。
:::

## 自检清单

- [ ] 能说出为什么 `ABC`（3 字节）不形成 cover，而 `DEFyyyy`（7 字节）能
- [ ] 能算出本例第一条 cover 的控制流成本是 3 字节
- [ ] 能解释 gap 边界（6/13/15）为什么不需要存进 patch
- [ ] 能说清"残差全 0"和"残差有 2 个非零"在 rle0 码流上的区别
- [ ] 能举出至少两个"差分不如全量"的场景

---

上一篇：[patch 应用](./hdiff-patch) | 下一篇：[小文件与小重复：为什么没有生成 diff](./hdiff-minmatch)
