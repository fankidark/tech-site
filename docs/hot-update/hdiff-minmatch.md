# 小文件与小重复：为什么没有生成 diff

> 上一篇：[打包与合并](./hdiff-pipeline) | 返回：[总览](/)
> 源码：`HDiffPatch v4.12.1`（行号实测）；实验用 `hdiffpatch_v5.1.0_bin_windows64` 实跑并解析 patch 二进制
> 回答一个真实困惑：**"我用小 txt 做实验，新文件里的重复内容没有生成 diff 数据，全量塞进了 patch"——为什么？**

## 先看实验：5 组真实数据

用 v5.1.0 的 `hdiffz` 实跑（默认参数），patch 二进制手工解析（HDIFF13 头部 packUInt 逐个解出）：

| 实验 | 输入 | 重复内容 | patch | coverCount | newDataDiff | 结论 |
|---|---|---|---|---|---|---|
| 1 | 80B → 64B | 8B + 32B | **86B** | **0** | 64B | patch 比 new 还大，重复片段全部放弃 |
| 3 | 2062B → 60B | 10B | 77B | **1** | 50B | 10B 重复成了一条 cover |
| 4 | 406B → 86B | 6B | 109B | **0** | 86B | 6B 重复**不够格**，全量塞 patch |
| 9 | 154B → 45B | 5B | 68B | **0** | — | 5B 卡在门槛上，没入选 |
| 10 | 364B → 52B | 12B | 66B | **1** | 40B | 12B 重复稳定入选 |
| 7 | 1KB 随机文本改 10 字节 | 大量 1KB 公共区 | **80B** | **6** | 13B | 改动稀疏时 cover 正常生长 |
| 11 | 10KB → 7.5KB | 12B 片段 | **34B** | **2** | 0B | 大文件中重复片段价值飙升 |

（实验 1/4/9 你会发现 `patch/new > 1`——这不是 bug，是小文件本来就不适合差分，见文末"工程结论"。）

## 规则一：kMinMatchLen=5，匹配太短直接"隐形"

`getBestMatch`（`diff.cpp:149`）返回匹配长度时：

```cpp
TInt bestLength= kMinMatchLen -1;   // 初始值 = 4
// ...
if (curLength>bestLength){ bestLength=curLength; bestOldPos=curOldPos; }
```

初始值就是 `kMinMatchLen-1`，**任何 <5 字节的匹配根本不会更新 bestLength**。`_search_cover`（`diff.cpp:319`）随即：

```cpp
if (matchEqLength<kMinMatchLen){   // <5
    newPos+=limitSkip;  continue;  // 跳过，连 cover 候选都不是
}
```

门槛常量在 `diff_types.h:71`：`kCoverMinMatchLen=5`。

> 所以 4 字节重复（实验 8）从算法上就**不可能**出现在 cover 里——不是"不够好"，是"看不见"。

## 规则二：≥5 还要过收益关——`长度 − 控制流成本 ≥ kMinMatchScore`

5 字节以上的匹配进入裁决（`diff.cpp:323`）：

```cpp
TOldCover matchCover(matchOldPos,newPos,matchEqLength);
if (matchEqLength-getCoverCtrlCost(matchCover,lastCover)<kMinMatchScore){
    ++newPos;  continue;    // 扣掉控制流成本后不赚 → 丢弃
}
```

控制流成本 `getCoverCtrlCost`（`diff.cpp:216`）：

```cpp
inline static TInt getCoverCtrlCost(const TOldCover& cover,const TOldCover& lastCover){
    static const int kUnLinkOtherScore=0;
    return _getIntCost((TInt)(cover.oldPos-lastCover.oldPos))   // oldPos 增量编码字节数
         + _getUIntCost((TUInt)cover.length)                    // length 编码字节数
         + _getUIntCost((TUInt)(cover.newPos-lastCover.newPos)) // gap 编码字节数
         + kUnLinkOtherScore;
}
```

三个变长整数各 1~2 字节，所以一条 cover 的"入场费"大约 **3~5 字节**。`kMinMatchScore=2`（`diff.cpp:65`），于是：

```
6B 匹配:  6 − 3~5 ≈ 1~3   → 压线，第一轮可能入选，但第二轮 _select_cover 常删（实验 4 实测被删）
5B 匹配:  5 − 3~5 ≈ 0~2   → 基本必死（实验 9 实测 coverCount=0）
12B 匹配: 12 − 3~5 ≈ 7~9  → 稳定入选（实验 10 实测 coverCount=1）
```

**这正是"小重复内容不会生成 diff 数据"的直接原因**：几字节的重复就算免费送，也付不起描述它的控制流钱。

### 成本函数的精妙处：成本随上下文浮动

`oldPos` 增量是相对**上一条 cover 的 oldEnd** 编码的。两条 cover 在 old 里挨得近 → 增量小 → 1 字节搞定 → 后面那条的入场费几乎为零。反之孤立 cover 全额付费。这自动达成了"密集重复区拼命挖、稀疏重复区全放弃"的宏观效果。

## 规则三：第二轮 `_select_cover` 用压缩率模型终审

第一轮活下来的 cover 还要过终审（`diff.cpp:390-397`）：

```cpp
TInt noCoverCost=nocover_detect.cost(diff.newData+covers[i].newPos,covers[i].length);   // 当 gap 直出的压缩成本
TInt coverCost=cover_detect.cost(diff.newData+covers[i].newPos,covers[i].length,
                                 diff.oldData+covers[i].oldPos);                        // 当 cover（残差 RLE）的成本
TInt coverSorce=noCoverCost-coverCost-getCoverCtrlCost(covers[i],lastCover);
isNeedSave=(coverSorce>=kMinSingleMatchScore);
```

`TCompressDetect`（`compress_detect.cpp:70+`）用**相邻字符转移概率表**近似估计数据可压缩性。如果一段"匹配"内容本身杂乱无章（残差不比直接放 gap 更省），终审照样删。CLI 默认 `kMinSingleMatchScore=4`（`hdiffz -m-4`），库 API 默认 6（`diff.h:34`）——**比第一轮的 2 更严**。

## 规则四：两条匹配可以"接龙"——tryLinkExtend 让碎片变整段

相邻匹配不是各自为战。`tryLinkExtend`（`diff.cpp:229`）尝试把 lastCover 延伸吞掉 matchCover：

```cpp
const TInt linkSpaceLength=(matchCover.newPos-(lastCover.newPos+lastCover.length));
if (linkSpaceLength>kMaxLinkSpaceLength) return false;   // 间隙 > 511B 不接龙（:73）
TInt matchCost=getCoverCtrlCost(matchCover,lastCover);
TInt lastLinkCost=(TInt)getRegionRleCost(diff.newData+matchCover.newPos,matchCover.length,
                                         diff.oldData+linkOldPos);  // 假设接上后的残差成本
if (lastLinkCost>matchCost) return false;
TInt len=lastCover.length+linkSpaceLength+(matchCover.length*2/3);   // 先延伸大部分
len+=getEqualLength(...);                                            // 再贪到头
```

关键思想：**两条 cover 之间的小 gap，与其"gap 直出 + 再付一条 cover 的入场费"，不如把整块当 cover、差异走残差**。实验 1 里 `8B + 32B` 两条重复最终 coverCount=0 的原因就在这：8B 那条太短付不起入场费，32B 那条原本能活——但 80B 的小文件里 `_select_cover` 的压缩率模型判断"64B 全当 gap 直出的 RLE 更省"，全删。

同方向的还有 `tryCollinear`（`diff.cpp:279`）：old/new 成比例推进的等差匹配（如步长固定的复制块）直接共线合并。

## 规则五：head 固定开销——小文件的保底税

实验 1 的 patch=86B 里没有一条 cover，86 字节花在哪？手工解析：

```
"HDIFF13&" + compressType"\0"   = 9B    （格式串固定）
7 个 packUInt 头字段            ≈ 8-10B （newSize/oldSize/coverCount/coverBuf/3×rle/newDataDiff）
newDataDiff = 64B               = 64B   （整个新文件！coverCount=0，全量直出）
RLE ctrl                        = 2B
```

**哪怕什么复用都没有，一个 patch 也有 ~20B 的结构性开销**。new 越小这笔税占比越高。

## 工程结论

结合实验数据回答最初的困惑：

1. **"小重复不生成 diff"是精确的、符合预期的行为**——HDiffPatch 的目标是最小化 patch 体积，不是"尽量复用"。几字节重复付不起控制流+残差的成本，直接进 newDataDiff 反而更小
2. **片段多长才值得？** 经验值：**≥8~12 字节且不是孤段**（实验 3 的 10B 入选是 2062B 文件、实验 10 的 12B 稳定入选、实验 11 的 12B 在 10KB 文件里贡献了 34B 的 patch）。5~7 字节在默认参数下基本全灭
3. **小文件别差分**。实验 1（80B→64B）patch 86B > new 64B，全量下载更小。成熟管线（如[打包与合并篇](./hdiff-pipeline)的项目链路）对极小文件直接跳过 patch 走全量 AB，或设 patch/new 比例阈值裁剪
4. **想挖更短的匹配**：CLI `-m-0`（`kMinSingleMatchScore=0`，取消收益分）+ 库里改 `kCoverMinMatchLen`，但实验证明收益趋零——成本公式决定了下限不在阈值，在信息论

## 自检

- [ ] 能说出 `kMinMatchLen=5` 与 `kMinMatchScore=2/4/6` 两道闸门各自的卡点
- [ ] 能算出一条孤立 cover 的入场费（3 个变长整数 ≈ 3~5B）
- [ ] 能解释为什么"两段相近匹配合并成一条"比"两条独立 cover"便宜
- [ ] 能从 HDIFF13 头部手工解出 coverCount 和 newDataDiffSize

---
上一篇：[打包与合并](./hdiff-pipeline) | 返回：[总览](/)
