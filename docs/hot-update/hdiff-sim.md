# 🧪 单步实验手册：在浏览器里把 diff 生成和 patch 应用各跑一遍

> **这是一个"先动手"的页面。** 你不需要先读懂前五篇，只要会点按钮。
> 每做完一个实验，回来看"预期结果"那一栏，对上了就说明你真看懂了。
> 所有源码行号都已按本机 `HDiffPatch v4.12.1` 源码树逐条实查；模拟器的算法是这套源码的忠实翻译（`kMinMatchLen=5`、初审 score ≥ 2、终审 score ≥ 4、7bit 变长整数）。

<script setup>
import HDiffSimulator from './components/HDiffSimulator.vue'
import MatchSearchSimulator from './components/MatchSearchSimulator.vue'
</script>

## 一句话结论

这个页面的两个模拟器把**真实源码的判定逻辑**翻译成了可视化的单步过程：
**diff 生成**（哪些重复值得存）+ **patch 应用**（怎么用 old + patch 重建 new）+ **后缀数组查找**（二分怎么一步步找到匹配）。
你看到的每一步都对应源码里的一行，不是动画示意。

## 术语先对齐（不用背，做着做着就熟了）

| 术语 | 一句话解释 |
|---|---|
| **diff / patch** | 补丁包。一份"指令单"，描述怎么从 old 得到 new |
| **cover** | 一条"从 old 的某处复制 N 字节到 new 的某处"的指令。diff 的核心内容就是一串 cover |
| **gap / 新增段** | 两段 cover 之间"old 里没有"的字节，只能原样写进 patch |
| **残差（rle0）** | cover 区间里 new 与 old 不完全相同的字节差值；全 0 的连续段会被压缩掉 |
| **后缀数组** | 把 old 的所有后缀排序后的索引表，用来 O(log n) 查"最长匹配在哪" |
| **`getBestMatch`** | 用二分 + 左右探测在后缀数组上找最长匹配 |
| **收益裁决** | cover 的判据：`匹配长度 − 存这条指令的成本 ≥ 阈值`。不够格就不存 |
| **`kMinMatchLen`** | 最小匹配长度 5：短于它的一律不看（存指令比省下来的还贵） |
| **HDIFF13 / HDIFFSF20** | 两种 patch 二进制格式。差别在头部字段与覆盖流组织方式 |
| **`packUInt`** | 变长整数编码：小数值占 1 字节，大的才多占，把头部压小 |
| **`hpatchz`** | 应用侧工具：读 old + patch，重建出 new |

## 30 秒上手

<div style="border:2px solid #e8590c;border-radius:10px;padding:12px 16px;background:#fff9db">

**第一步**：下面这个大框里，直接点绿色的 **「🎲 生成 diff 步骤」**。

**第二步**：反复点橙色的 **「下一步 ▶」** 按钮（键盘 `→` 也行），从第 1 步走到最后一步。**先别看代码，只看每步的说明和紫色的 cover 表**。

**第三步**：走到最后（出现"📊 patch 完成"那一步），点绿色的 **「▶ patch 应用步骤」**——**注意：这时候 new 输入框消失了**，因为你正在做的是"从 old + 已有 patch 重建 new"，不需要 new 了。

**第四步**：再点一遍「下一步 ▶」，看重建中的 new 一行行变绿。走到最后，绿满 = 重建成功。

</div>

<HDiffSimulator />

## 实验一：默认输入——"能复用就该复用"长什么样

**怎么操作**：保持默认的 old / new 不动，点「🎲 生成 diff 步骤」，然后用「下一步 ▶」走完全程。

**预期你会看到**：

| 走到哪一步 | 你应该看到 | 为什么 |
|---|---|---|
| 前几步 | 出现若干条"匹配 < kMinMatchLen(5) → 跳过" | 默认输入开头是一段短相同的文本，够不到 5 字节门槛 |
| 中间 | 出现"✅ 匹配 N B @oldPos=M，收益 N−成本 = S ≥ 2 → 收入 cover" | 这一条通过了收益裁决，进入了 cover 列表 |
| 序列化阶段 | 一行"🔢 写头部 packUInt ×10" | 头部字段的**实际数值**都列出来了 |
| 最后 | 一张 **patch 二进制结构表**（偏移 / 段 / 长度 / hex 字节 / 说明） | 这是 patch 文件真实的字节布局 |
| 最后一行 | "📊 patch 完成：共 N B（new 的 X%）" | 如果 N > new 的大小，会带一个 ⚠️ |

**关键观察点**：patch 二进制结构表里，`newDataDiff` 段通常是**最长**的一段。因为它存的是 gap 区的原始字节——**这部分一个字节都省不掉**。

## 实验二：4 字节重复——"隐形"

**怎么操作**：把 old 和 new 都改短，构造一个只有 4 个字节相同的例子。比如：

```text
old: AAAABBBB
new: AAAACCCC
```

点「🎲 生成 diff 步骤」→ 走完。

**预期你会看到**：`coverCount = 0`，patch 里没有任何 cover 段，`newDataDiff` 装了整个 new。

**为什么**：`getBestMatch` 里 `bestLength` 的初值是 `kMinMatchLen-1 = 4`（`diff.cpp:160`）——**短于 5 的匹配永远不会更新它**。所以 4 字节重复对算法来说"不存在"，不是"评分不够"。

> 这一步对应源码 `diff.cpp:160` 与 `diff.cpp:314`。想验证的话，去 [小文件与小重复](./hdiff-minmatch) 看实验 8 的实测数据。

## 实验三：6 字节孤立重复——"看得见但付不起"

**怎么操作**：

```text
old: xxxxxxABCDEFyyyyyyyyyy
new: zzzzzzABCDEFwwww
```

（把 6 个字节 `ABCDEF` 孤立地放在两边）

**预期你会看到**：可能先看到"匹配 6B ≥ 5，但收益不足 → 拒绝"，或者看到它进了 cover 但后面被"终审删除"。

**为什么**：`6 − 控制流成本(3~5) = 1~3`，刚刚卡在 `kMinMatchScore=2` 附近。而且第二轮 `_select_cover` 的门槛更严。**实测（[小文件篇](./hdiff-minmatch) 实验 4）：6B 重复 → coverCount=0。**

> 想精确知道自己那组参数下"多长才够"，去用 [diff 生成篇](./hdiff-generate) 里的**收益模型计算器**拖滑块。

## 实验四：两段相邻重复——"接龙"

**怎么操作**：

```text
old: AAAABBBBXXXXCCCCDDDD
new: AAAABBBBYYYYCCCCDDDD
```

（两段重复中间夹一段不同的内容）

**预期你会看到**：出现 "④ tryLinkExtend：与上一条 cover 间隙 N B ≤ 511 → 接龙" 这样的一步。

**为什么**：`tryLinkExtend`（`diff.cpp:229`）会尝试把两条相近的匹配**并成一条**——中间那段不同的内容用残差修正，比"gap 直出 + 再付一条 cover 的入场费"更省。间隙上限是 `kMaxLinkSpaceLength = 511`（`diff.cpp:73`）。

**观察点**：接龙之后，cover 列表里**不会多出一条**，而是上一条的 `length` 变大了。

## 实验五：patch 应用——重建的每一步发生在哪

**怎么操作**：从实验一的状态直接切「▶ patch 应用步骤」，走完全程。

**预期你会看到**（每一步都和源码一一对应）：

| 步骤 | 你在屏幕上看到 | 源码 |
|---|---|---|
| ① | 读类型串 `HDIFF13` | `getSingleCompressedDiffInfo`（`patch.c:2111`） |
| ② | 反解头部 10 个 packUInt | `patch.c:2129-2134` |
| ③ | 安全校验三条 | `patch.c:2136-2141` |
| ④ | 解码 covers 控制流，列出每条 cover 的绝对坐标 | `sspatch_covers_nextCover`（`patch.c:2260`） |
| ⑤ | `[gap]` 从 newDataDiff 连续拷 N 字节 | `patch.c:2505`（`_TOutStreamCache_copyFromClip`） |
| ⑥ | `[cover]` 从 old 拷贝 + 残差修正 | `patch.c:2515` → `_patch_add_old_with_rle0`（`patch.c:2244`） |
| ⑦ | `[尾gap]` 补上剩余字节 | `patch.c:2530-2531` |
| ⑧ | flush + 三重终检 → 成功 | `patch.c:2530-2535` |

**关键观察点**：界面上方"重建中的 new"那一行，**第 ⑤ 步的字节是跳着变绿的**（只填 gap 区），第 ⑥ 步才补上中间的 covered 区。这个"跳着填"的顺序，就是 `patch.c:2471` 那个 `while (coverCount)` step 循环的真实行为。

## 实验六：后缀数组二分——`getBestMatch` 内部发生了什么

上面那个模拟器每次调 `getBestMatch` 时，真实源码内部会做两件事：**在有序后缀数组上二分**，然后**在命中位左右探测**。下面这个组件把这两件事逐步放给你看：

<MatchSearchSimulator />

**它有 A / B / C 三个区，按这个顺序玩**：

| 区 | 怎么操作 | 预期看到什么 |
|---|---|---|
| **A. 查找轮次全景** | 点 new 文本里的任意一个字符 | 跳到"覆盖这个位置的那一轮查找"。灰=太短跳过、红=收益不足拒绝、绿=形成了 cover |
| **B. SA 构建** | 反复点「分桶下一步 ▶」 | 后缀数组从"全在一个桶里"到"每个桶只剩一个后缀"。每步只按一个字符位分裂 |
| **C. 二分 + 探测** | 点「查找下一步 ▶」 | 二分每步丢一半区间（黄色是当前区间、橙色是中点）；二分结束后进入"探测"阶段，看 `sai` 和 `sai−1` 两个候选哪个更长 |

**C 区最值得盯的一行**：探测阶段显示的"公共前缀 N 字符，首个差异 'x' vs 'y'"——这就是 `getEqualLength` 的结果，也是最终 `bestLength` 的来源。源码在 `diff.cpp:164-209`。

## 对照表：模拟器 ↔ 源码（全部实查过）

| 模拟器步骤 | 源码位置 | 说明 |
|---|---|---|
| 建后缀数组 | `diff.cpp:898`（调用）→ `suffix_string.cpp:275`（实现） | 生产用 divsufsort（`suffix_string.cpp:141`/`:143`） |
| 二分查找 | `suffix_string.cpp:155`（`_lower_bound`，eq 缓存在 `:163-193`） | 每步从"已比过的位置"接着比，不重复比较 |
| 生成候选匹配 | `diff.cpp:149`（`getBestMatch`），循环体 `:164-209` | matchDeep=2：看 sai 与 sai−1 |
| 长度门槛 | `diff.cpp:160`（初值）/ `diff.cpp:314`（判据） | `kMinMatchLen=5`、`kCoverMinMatchLen=5`（`diff_types.h:71`） |
| 收益裁决 | `diff.cpp:319` | `len − getCoverCtrlCost ≥ kMinMatchScore(2)`（`diff.cpp:65`） |
| 接龙合并 | `diff.cpp:229`（间隙上限 `:73`） | 间隙 ≤ 511B 时可合并，省一条 cover 入场费 |
| 共线对齐 | `diff.cpp:279` | 等差推进的匹配直接改 oldPos |
| 终审删除 | `diff.cpp:345`，判定在 `:393-398` | 压缩率模型；门槛 `kMinSingleMatchScore`（库默认 6，`diff.h:34`） |
| 序列化布局（HDIFF13） | `diff.cpp:1269-1286` | 类型串 → 10 个 packUInt → covers → rle_ctrl → rle_code → newDataDiff |
| 序列化布局（HDIFFSF20） | `diff.cpp:994-1018` | 类型串 → 6 个 packUInt → 单条交织 step 流 |
| 读类型串 / 头 | `patch.c:2111` / `patch.c:2129-2134` | 按与生成侧相同的顺序反解 |
| 头安全校验 | `patch.c:2136-2141` | 三条，无条件执行 |
| 解码 cover | `patch.c:2260` | oldPos 带 1bit 符号 tag |
| gap 拷贝 | `patch.c:2505` | 边界 = `cover.newPos − lastNewEnd`，流里没有分隔符 |
| 残差加法 | `patch.c:2515` → `:2244` → `:2192` | `out[i] = (old[i] + sub[i]) mod 256` |
| step loop | `patch.c:2471` | 每步先读两个 size 字段再读 step_cache |
| flush + 终检 | `patch.c:2530-2535` | 输入读完 && 输出写完 && coverCount==0 |

## 模拟器的正确性怎么保证

模拟器内建的 patch 编码器与解码器互为镜像——**应用模式跑完，重建结果与输入 new 逐字节一致**。
三组场景实测验证过：8B 重复 / 5B 重复 / 445B→69B 长重复。

所以：**你看到的每一步就是真实的合并逻辑，不是动画示意。** 每一步卡片右下角的 📄 行号，都可以拿本机源码树逐字对照。

## 与实测实验互证

[小文件与小重复](./hdiff-minmatch) 那一篇用 v5.1.0 `hdiffz` 实跑了 7 组实验并人工解析 patch 二进制（coverCount 为实测值）。本模拟器的判定逻辑与实验结果一致：

| 输入特征 | 模拟器判定 | 实测 coverCount |
|---|---|---|
| 5B 重复 | 卡门槛 / 终审删除 | **0** |
| 6B 孤立重复 | 收益不足 | **0** |
| 12B 重复 | 通过 | **1** |
| 80B 小文件 | 头部开销占主导 | **0**（patch 86B > new 64B） |

> ⚠️ **口径说明**：那 7 组数据来自 **v5.1.0 官方二进制**（本机没有，无法复跑）；模拟器和本页行号基于**本机 v4.12.1 源码树**。版本不同，阈值常量若在期间变过，数字会略有差异——以下面两个模拟器的实际输出为准。

## 自检清单

- [ ] 能在模拟器里跑出一个 `coverCount ≥ 1` 的例子，并说出是哪一步收进 cover 的
- [ ] 能跑出一个 `coverCount = 0` 的例子，并说出死在**哪一道**闸门（长度 / 收益 / 终审）
- [ ] 能说出 patch 应用模式里"重建中的 new 跳着变绿"对应哪一行源码
- [ ] 能在对照表里找到任意一个步骤对应的源码行号，并到本机源码树里验证
- [ ] 能说出 A/B/C 三个区分别在演示什么

---

[← 返回总览](/hot-update/) | 想读推导过程：[cover 数据结构](./hdiff-cover) → [diff 生成](./hdiff-generate) → [patch 应用](./hdiff-patch)
