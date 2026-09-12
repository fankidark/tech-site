# 小文件与小重复：为什么没有生成 diff

> 上一篇：[实战例子](./hdiff-example) | 下一篇：[项目落地](./hdiff-unity)
> 源码：`HDiffPatch v4.12.1`（本页行号实查）；实验用 `hdiffpatch_v5.1.0_bin_windows64` 实跑并人工解析 patch 二进制
> ⚠️ **口径说明**：本页的 7 组实验数据是原项目组用 **HDiffPatch v5.1.0 官方 Windows 二进制**跑出来的实测值，**本机没有该二进制、无法复跑**，因此表格里的数字**原样保留**。下面的源码行号全部基于本机的 **v4.12.1 源码树**逐条实查——两者版本不同，若你复跑出的数字与表格有差异，请以自己那次的输出为准。

<script setup>
import MatchCostScorer from './components/MatchCostScorer.vue'
import PatchBinaryAnatomy from './components/PatchBinaryAnatomy.vue'
</script>

## 一句话结论

这不是 bug，是**设计目标本身**：HDiffPatch 要最小化的是 **patch 文件的大小**，不是"复用率"。
一段 6 字节的重复，描述它要花 3~5 字节的控制流，省不下什么；把它当普通新字节存进去，patch 反而更小。

## 它到底解决什么问题

真实困惑（来自项目组的原话）：

> "我用小 txt 做实验，新文件里的重复内容没有生成 diff 数据，全量塞进了 patch——为什么？"

这个困惑背后藏着一个**默认的假设**："算法应该尽量找重复"。而 HDiffPatch 的假设是：**"找重复是为了省字节，如果省不下字节，找它干嘛"**。
所以你会看到一个违反直觉的现象：**有些重复被主动放弃了**。

生活类比：你帮同事改一份文档。

- 「尽量复用」的思路 = 能引用旧版就引用，附录里塞满"参见 v1.2 第 3 段"。
- HDiffPatch 的思路 = 如果你要改的地方只有 6 个字，那"参见 v1.2 第 3 段第 12 字起 6 个字"这句话本身比 6 个字还长——**那就直接写这 6 个字，别提引用**。

## 术语先对齐

| 术语 | 一句话解释 |
|---|---|
| **coverCount** | patch 里最终保留了几条 cover。它是本篇最重要的观测量 |
| **newDataDiff** | gap 区的新字节，原样保存。coverCount=0 时它就等于整个新文件 |
| **第一轮 / 初审** | `_search_cover`（`diff.cpp:299`）用**估算**的控制流成本初筛，门槛 `kMinMatchScore=2` |
| **第二轮 / 终审** | `_select_cover`（`diff.cpp:345`）用**压缩率模型**复筛，门槛 `kMinSingleMatchScore` |
| **压缩率模型** | `TCompressDetect`：用相邻字符转移概率表近似估计数据"好不好压" |
| **接龙** | `tryLinkExtend`：把两条相近匹配合并成一条更长的 cover |

## 先看实验：7 组真实数据

用 v5.1.0 的 `hdiffz` 实跑（默认参数），patch 二进制人工解析（HDIFF13 头部 packUInt 逐个解出）：

| 实验 | 输入 | 重复内容 | patch | coverCount | newDataDiff | 结论 |
|---|---|---|---|---|---|---|
| 1 | 80B → 64B | 8B + 32B | **86B** | **0** | 64B | patch 比 new 还大，重复片段全部放弃 |
| 3 | 2062B → 60B | 10B | 77B | **1** | 50B | 10B 重复成了一条 cover |
| 4 | 406B → 86B | 6B | 109B | **0** | 86B | 6B 重复**不够格**，全量塞 patch |
| 9 | 154B → 45B | 5B | 68B | **0** | — | 5B 卡在门槛上，没入选 |
| 10 | 364B → 52B | 12B | 66B | **1** | 40B | 12B 重复稳定入选 |
| 7 | 1KB 随机文本改 10 字节 | 大量 1KB 公共区 | **80B** | **6** | 13B | 改动稀疏时 cover 正常生长 |
| 11 | 10KB → 7.5KB | 12B 片段 | **34B** | **2** | 0B | 大文件中重复片段价值飙升 |

（实验 1/4/9 你会发现 `patch/new > 1`——这不是 bug，见文末"工程结论"。）

**读这张表的一个技巧**：横着看 `coverCount`，再横着看"重复内容"的长度。
`5B → 0`、`6B → 0`、`10B → 1`、`12B → 1`、`12B → 2`。分界线非常清楚。
下面四节解释这条分界线是怎么被算出来的。

## 规则一：`kMinMatchLen=5`，匹配太短直接"隐形"

这不是"评分不够"，是**看不见**。`getBestMatch`（`diff.cpp:149`）返回匹配长度时：

```cpp
// diff.cpp:160-161
TInt bestLength= kMinMatchLen -1;     // 初始值就是 4
TInt bestOldPos=-1;
// diff.cpp:187-189：只有更长的匹配才会更新它
if (curLength>bestLength){
    bestLength=curLength;
    bestOldPos=curOldPos;
}
```

`bestLength` 的**初值就是门槛减一**。这意味着返回值可能是 4（表示"没找到够格的"），而**永远不可能是 1、2、3**——任何短于 5 字节的匹配根本不会更新 `bestLength`。

`_search_cover` 随即把它拦下（`diff.cpp:314-317`）：

```cpp
if (matchEqLength<kMinMatchLen){        // <5
    newPos+=limitSkip;
    continue;                            // 跳过，连 cover 候选都不是
}
```

门槛常量在 `diff_types.h:71`：`kCoverMinMatchLen=5`。

> **所以 4 字节重复从算法上就不可能出现在 cover 里**——不是"不够好"，是"看不见"。
> 这也顺带解释了实验 9 的 5B 重复为什么 `coverCount=0`：它刚刚够到"看得见"的线，但下一关立刻把它拦下了。

## 规则二：过了长度关，还要过收益关

5 字节以上的匹配进入裁决（`diff.cpp:319`）：

```cpp
TOldCover matchCover(matchOldPos,newPos,matchEqLength);
if (matchEqLength-getCoverCtrlCost(matchCover,lastCover)<kMinMatchScore){
    ++newPos;  continue;    // 扣掉控制流成本后不赚 → 丢弃
}
```

控制流成本 `getCoverCtrlCost`（`diff.cpp:216-221`）：

```cpp
inline static TInt getCoverCtrlCost(const TOldCover& cover,const TOldCover& lastCover){
    static const int kUnLinkOtherScore=0;//0--2
    return _getIntCost<TInt,TUInt>((TInt)(cover.oldPos-lastCover.oldPos))  // oldPos 增量的编码字节数
         + _getUIntCost((TUInt)cover.length)                              // length 的编码字节数
         + _getUIntCost((TUInt)(cover.newPos-lastCover.newPos))           // gap 的编码字节数
         + kUnLinkOtherScore;
}
```

三个变长整数各 1~2 字节，所以一条 cover 的"入场费"**通常 3~5 字节**。而 `kMinMatchScore=2`（`diff.cpp:65`）。于是把实验里那些长度代进去：

<MatchCostScorer />

用上面这个计算器把参数拖成实验的形态，你会得到这张账单（`inc_oldPos` 取实验中量级，`inc_newPos` 取 gap 量级）：

| 重复长度 | 控制流成本 | 收益 `len − cost` | 门槛 2 | 与实测对照 |
|---|---|---|---|---|
| 5B | 2~3B | 2~3 | 压线 | 实验 9 实测 `coverCount=0` → **初审可能通过，死在终审** |
| 6B | 3~4B | 2~3 | 压线 | 实验 4 实测 `coverCount=0` → 同上 |
| 10B | 3~4B | 6~7 | ✔ 稳过 | 实验 3 实测 `coverCount=1` |
| 12B | 3~5B | 7~9 | ✔ 稳过 | 实验 10 实测 `coverCount=1`、实验 11 实测 `coverCount=2` |

**"5B 和 6B 明明算出来是正收益，为什么实测还是 0？"** —— 因为它们不是死在规则二，而是死在规则三。这正是下一节要讲的。

### 成本函数的精妙处：成本随上下文浮动

`inc_oldPos` 是相对**上一条 cover 的 oldEnd** 编码的。想象两条 cover 都落在 old 的一个未变动大区间里：

| 情形 | `inc_oldPos` | 编码 | 该条 cover 的入场费 |
|---|---|---|---|
| 两条 cover 在 old 里挨得近（增量 20） | 20 | 1 字节 | 几乎为零 |
| 第二条是孤立 cover（增量 50000） | 50000 | 3 字节 | 显著变贵 |

这自动达成了"**密集重复区拼命挖、稀疏重复区全放弃**"的宏观效果——不需要额外的启发式规则，成本函数自己就是规则。

## 规则三：第二轮 `_select_cover` 用压缩率模型终审

第一轮活下来的 cover 还要过终审（`diff.cpp:393-398`）：

```cpp
if (!isNeedSave){// Whether to keep the single cover.
    TInt noCoverCost=nocover_detect.cost(diff.newData+covers[i].newPos,covers[i].length);
    TInt coverCost=cover_detect.cost(diff.newData+covers[i].newPos,covers[i].length,
                                     diff.oldData+covers[i].oldPos);
    TInt coverSorce=noCoverCost-coverCost-getCoverCtrlCost(covers[i],lastCover);
    isNeedSave=(coverSorce>=kMinSingleMatchScore);
}
```

这一段在问一个**完全不同的问题**：

- `noCoverCost` = "这段内容当 gap 直出，会占多少字节？"
- `coverCost` = "这段内容当 cover（残差走 RLE），会占多少字节？"
- 两者相减再减控制流成本 → 这才是**真实的**收益

`TCompressDetect::cost`（`compress_detect.cpp:178`）用**相邻字符转移概率表**近似估计数据可压缩性。如果一段"匹配"的内容本身杂乱无章（残差不比直接放 gap 更省），终审照样删。

**门槛比第一轮更严**：

| 门槛常量 | 值 | 出处 |
|---|---|---|
| `kMinMatchScore`（第一轮，写死） | **2** | `diff.cpp:65` |
| `kMinSingleMatchScore_default`（库 API 默认） | **6** | `diff.h:34` |
| CLI 默认 | 打印的提示行写 `DEFAULT -m-6` | `hdiffz.cpp:169` |

> 这就解释了实验 9/4 的"矛盾"：5B/6B 的匹配在规则二里算出来是 +2~+3，看着过关；但终审换用**真实压缩率**一算，"这段 6 字节当 gap 直出的成本"和"当 cover 的成本"差别微乎其微，减去控制流后达不到门槛 → 删。

## 规则四：两条匹配可以"接龙"——`tryLinkExtend`

相邻匹配不是各自为战。`tryLinkExtend`（`diff.cpp:229`）尝试把 lastCover 延伸以吞掉 matchCover：

```cpp
// diff.cpp:229-255
static bool tryLinkExtend(TOldCover& lastCover,const TOldCover& matchCover,const TDiffData& diff,TDiffLimit* diffLimit){
    if (lastCover.length<=0) return false;
    const TInt linkSpaceLength=(matchCover.newPos-(lastCover.newPos+lastCover.length));
    assert(linkSpaceLength>=0);
    if (linkSpaceLength>kMaxLinkSpaceLength)     // kMaxLinkSpaceLength = 511（diff.cpp:73）
        return false;
    TInt linkOldPos=lastCover.oldPos+lastCover.length+linkSpaceLength;
    // ...（diffLimit 分支略）
    TInt matchCost=getCoverCtrlCost(matchCover,lastCover);
    TInt lastLinkCost=(TInt)getRegionRleCost(diff.newData+matchCover.newPos,matchCover.length,
                                             diff.oldData+linkOldPos);   // 假设接上后的残差成本
    if (lastLinkCost>matchCost)
        return false;                                                     // 接上更贵就别接
    TInt len=lastCover.length+linkSpaceLength+(matchCover.length*2/3);    // 先延伸 2/3
    len+=getEqualLength(...);                                             // 再贪心延伸到不等为止
    // ...（末尾还有个"逐字节回退到最后一个相同字节"的收尾循环）
    lastCover.length=len;
    return true;
}
```

关键思想：**两条 cover 之间的小 gap，与其"gap 直出 + 再付一条 cover 的入场费"，不如把整块当 cover、差异走残差。**
注意最后那个收尾循环（`diff.cpp:270-273`）——延伸完还要**逐字节往回退到最后一个新旧相同的字节**。因为 cover 末尾如果刚好卡在"不同的字节"上，残差就会多一个非零值，退一格反而更省。

同方向的还有 `tryCollinear`（`diff.cpp:279`）：old/new 成比例推进的等差匹配（比如步长固定的复制块）直接共线合并——它甚至不改长度，只把 `lastCover.oldPos` 挪到一个更划算的位置（`diff.cpp:293-294`）。

### 实验 1 的 86 字节是怎么来的

实验 1 里 `8B + 32B` 两条重复，最终 `coverCount=0`。原因链：

1. **8B 那条**：长度刚过门槛，但孤立 → 入场费 3~5 字节 → 终审删除
2. **32B 那条**：本来能活。但 80B 的小文件里，`_select_cover` 的压缩率模型判定"64B 全当 gap 直出的 RLE 成本"**低于**"32B 走 cover + 残差 + 控制流"的成本 → 也删
3. 两条都删 → `newDataDiff = 64B`（整个新文件）

那 86 字节到底花在哪？下一节。

## 规则五：head 固定开销——小文件的保底税

实验 1 的 patch=86B 里没有一条 cover，86 字节花在哪？手工解析：

```
"HDIFF13&" + compressType"\0"   = 9B    （格式串固定：8 字节版本串 + '&' + 空压缩类型 + '\0'）
头部 packUInt 字段              ≈ 8-10B （HDIFF13 声明 10 个字段：newSize/oldSize/coverCount/
                                          coverBuf/compressCover/3×rle/newDataDiff/compressNewDataDiff）
newDataDiff = 64B               = 64B   （整个新文件！coverCount=0，全量直出）
RLE ctrl                        = 2B
```

**哪怕什么复用都没有，一个 patch 也有 ~20B 的结构性开销。new 越小，这笔税占比越高。**

你可以在下面的组件里直接看到这笔税的形状——它把 `HDIFF13`（10 个头部字段、4 段数据）和 `HDIFFSF20`（6 个头部字段、1 条交织流）的同一输入字节摊开对照，并给出逐段账单：

<PatchBinaryAnatomy />

## 工程结论

结合实验数据回答最初的困惑：

1. **"小重复不生成 diff"是精确的、符合预期的行为**——HDiffPatch 的目标是最小化 patch 体积，不是"尽量复用"。几字节重复付不起控制流 + 残差的成本，直接进 `newDataDiff` 反而更小
2. **片段多长才值得？** 经验值：**≥8~12 字节且不是孤段**。实验 3 的 10B 能入选（因为它在一个 2062B 的文件里，`inc_oldPos` 相对而言小），实验 10 的 12B 稳定入选，实验 11 的 12B 在 10KB 文件里贡献了 34B 的 patch。**5~7 字节在默认参数下基本全灭**
3. **小文件别差分**。实验 1（80B→64B）patch 86B > new 64B，全量下载更小。成熟管线（如[打包与合并篇](./hdiff-pipeline)的项目链路）对极小文件直接跳过 patch 走全量 AB，或设 `patch/new` 比例阈值裁剪
4. **想挖更短的匹配**：CLI 用 `-m-0`（把 `kMinSingleMatchScore` 调到 0，取消收益分），或改库里的 `kCoverMinMatchLen`。但实验证明收益趋零——**成本公式决定了下限不在阈值，在信息论**：你没法用一个长度数字去描述一个比它还短的片段

## 常见误解

::: warning "coverCount=0 说明差分失败了"
不是失败，是**正确决策**。`coverCount=0` 时 patch = 头部 + 整个新文件，这恰恰是"全量直出"的最优形态——它没有为任何无用的复用关系浪费控制流字节。真正的失败是"生成了一个比全量还大的 patch 却还硬要用它"，那是管线策略问题，不是算法问题。
:::

::: warning "调低阈值就能挖出更多 cover"
把 `kMinMatchScore` 或 `kMinSingleMatchScore` 调到 0，确实会有更多短匹配变成 cover。但**每条 cover 都要付 3~5 字节控制流**，而这些字节本来可以直接存新内容。所以"阈值调低 → patch 变大"是常态，不是例外。阈值的存在是为了**帮你省钱**，不是因为算法保守。
:::

## 自检清单

- [ ] 能说出 `kMinMatchLen=5` 与 `kMinMatchScore=2 / kMinSingleMatchScore` 三道闸门各自的卡点
- [ ] 能算出一条孤立 cover 的入场费（3 个变长整数 ≈ 3~5B）
- [ ] 能解释"5B/6B 收益算出是正的、实测却 coverCount=0"的原因（死在终审，不是死在初审）
- [ ] 能解释为什么"两段相近匹配合并成一条"比"两条独立 cover"便宜
- [ ] 能从小文件 patch 的字节账单里指出 ~20B 的固定开销
- [ ] 能在 `diff.cpp:160`、`:319`、`:397` 分别找到三道闸门的判定行

---

上一篇：[实战例子](./hdiff-example) | 下一篇：[项目落地：Unity 热更中的完整链路](./hdiff-unity)
