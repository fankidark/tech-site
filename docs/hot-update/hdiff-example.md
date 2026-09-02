# 实战例子：手推一遍 diff 与 patch

> 上一篇：[patch 应用](./hdiff-patch) | 下一篇：[项目落地](./hdiff-unity)
> 本篇所有结论按源码默认参数（`kMinMatchLen=5`、`kMinMatchScore=2`）人工推演

## 输入

```text
oldData: ABCxxxxxDEFyyyyGHI   (18 字节)
newData: ABC123DEFyyyyZZ      (15 字节)
```

## diff 侧：搜索过程

从 `newPos=0` 开始扫描 newData，每次调用 `getBestMatch`（默认 `matchDeep=2`）：

| newPos | 直觉匹配 | 源码行为 | 形成 cover？ |
|---|---|---|---|
| 0 | `ABC` 长度 3 | `getBestMatch` 里 `bestLength` 初始为 `kMinMatchLen-1=4`，长度 3 不更新 → 返回 4 以下；`_search_cover` 判 `matchEqLength < kMinMatchLen` → 跳过 | ❌ |
| 1~5 | 无更好匹配 | 同上或收益不足 | ❌ |
| 6 | `DEFyyyy` 长度 7 | 返回 `oldPos=8, length=7`；收益判断 `7 − 控制流成本 ≥ 2` 通过 | ✅ cover1 |
| 13 | `ZZ` 长度 2 | < 5 → 跳过 | ❌ |

> **很多教程会画 `cover0 = {ABC}`——教学简化**。按源码 `kMinMatchLen=5` 的门槛，`ABC`（3 字节）够不到，进入 newDataDiff。

## diff 侧：产物

```
covers       = [ {oldPos:8, newPos:6, length:7} ]
newDataDiff  = "ABC123" + "ZZ" = "ABC123ZZ"   (gap 字节连续存储，无分隔符)
subDiff      = covered 区残差：new[6..13) − old[8..15) = 全 0
             → rle0 编码后 ≈ 一个 len0 字段
控制流       = inc_oldPos(8) + inc_newPos(6) + length(7)   各 1 字节
```

序列化（single / HDIFFSF20）：头部 6 个 packUInt + TStepStream 打包的单一压缩流。这个 15 字节新文件的 patch 包大约只有几十字节——真实项目里 5%~30% 的压缩比来自同样的机制放大到 MB 级文件。

## patch 侧：重放

按 [patch 应用篇](./hdiff-patch) 的统一模型，人工执行 `patchByClip`/single 主循环：

```text
newPosBack = 0

① cover1.newPos=6 > 0 → 前面有 6 字节 gap
   从 newDataDiff 拷 6 字节 "ABC123"      → 输出 [0,6)   = ABC123
   （残差流同步 skip 6，因为 gap 区没有残差）

② covered 区：cover1 {oldPos:8, length:7}
   读 old[8..15) = "DEFyyyy" 到缓存
   rle0 残差 = 全 0 → addData 加 0，缓存不变
   写出 7 字节                            → 输出 [6,13)  = DEFyyyy
   newPosBack = 6 + 7 = 13

③ 尾部 gap：newPosBack=13 < newDataSize=15
   从 newDataDiff 拷剩余 2 字节 "ZZ"      → 输出 [13,15) = ZZ

✓ 输出 = "ABC123DEFyyyyZZ" = newData，与 CI 产物逐字节一致
```

每一步的边界（6、13、15）都不是存进 diff 的，而是 patch 时用 `cover.newPos - lastNewEnd` 动态算出——这就是 gap 流"无分隔符连续存储"能工作的原因。

## 如果匹配再长一点：相似区的残差修正

把例子改一下：`newData = ABC123DEFyyyyxX`（covered 区最后 2 字节变了）：

- 搜索时 `DEFyyyyx`（7 字节公共前缀）仍是 cover1，`extend_cover` 可能把"相似"边界一并纳入
- 此时 `subDiff = new[6..13) − old[8..15)` **不再全 0**：最后 2 字节是 `x−y, X−y` 的模 256 差值
- rle0 编码：`len0=5`（跳 5 个 0）+ `lenv=2`（2 个非零字节）
- patch 端 `addData` 把残差加上 → 正确恢复

这就是"cover 不要求字节完全相同"（[cover 篇](./hdiff-cover)）的具体体现：**用 2 字节残差换掉一条新 cover 的控制流 + gap 切分**，多数情况更省。

## 反例：什么情况下 diff 反而不如全量

- **新旧文件完全无关**（比如换了一个引擎版本的所有资源）：几乎搜不出 ≥5 的匹配 → diff ≈ newData 全量 + 控制流开销。成熟的热更管线会在此场景直接回退全量下载
- **小文件**（几百字节）：控制流占比过高，diff 可能比 newData 还大。项目侧（见下一篇）用"有 patch 就用、失败就全量 AB 兜底"的双轨制规避

---
上一篇：[patch 应用](./hdiff-patch) | 下一篇：[项目落地：Unity 热更链路](./hdiff-unity)
