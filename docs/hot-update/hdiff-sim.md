# 🧪 diff 生成 · 单步调试模拟器

> 动手体验 HDiffPatch 怎么"决定哪些重复内容值得生成 diff 数据"：
> **搜索 → 收益裁决 → 接龙合并 → gap/cover 序列化 → 最终账单**，每步附源码对照（文件:行号）。
> 算法忠实翻译自 `HDiffPatch v4.12.1` 的 `diff.cpp`（常量与源码一致：kMinMatchLen=5、初审 score≥2、终审 score≥4）。

<script setup>
import HDiffSimulator from './components/HDiffSimulator.vue'
</script>

<HDiffSimulator />

## 它会判断吗？——会，而且是三道闸门

模拟器里每一步都对应真实源码的判定。回答"patch 内容是否有优化判断"这个问题：

| 闸门 | 判什么 | 源码 | 拒绝后果 |
|---|---|---|---|
| ① 长度门槛 | 匹配 < 5 字节 → 连候选都不算 | `getBestMatch` diff.cpp:158（bestLength 初始=4） | 内容进 gap，newDataDiff 原样保存 |
| ② 收益裁决 | `匹配长度 − 控制流成本 ≥ 阈值` | `_search_cover` diff.cpp:323 | 同上——**几字节的重复付不起"入场费"** |
| ③ 压缩率终审 | 残差 RLE 成本 vs gap 直出成本 | `_select_cover` diff.cpp:390-397 | 杂乱内容的"伪匹配"被删 |

控制流成本 = 一条 cover 要存 3 个变长整数（oldPos 增量 / length / gap），约 3~5 字节。**所以 5 字节匹配 ≈ 0~2 分，基本必死；12 字节以上才稳定入选。**

## 使用建议（按学习顺序）

1. **默认输入直接跑**：`AAAABBBB...` 8 字节重复——你会看到它过闸门、形成 cover
2. **复现你的实验**：把重复片段改成 4 字节（如 `ABCD`），观察"②隐形"直接跳过
3. **看收益裁决**：改成 6 字节重复但放得很孤立，观察"③拒绝"（成本算给你看）
4. **看接龙**：放两段相近的重复（中间隔 2~3 字节），观察"④tryLinkExtend"合并成一条、只付一次入场费
5. **看最终账单**：最后一步把 patch 拆成 头部+控制流+newDataDiff+残差，和 new 比较——小文件会看到 ⚠️ "不划算，应走全量"

## 对照表：模拟器 ↔ 源码

| 模拟器步骤 | 源码 | 说明 |
|---|---|---|
| 生成候选匹配 | `getBestMatch` (diff.cpp:149) | 教学版朴素搜索；真实实现 = 后缀数组 lower_bound + 左右探测 2 个候选 |
| 长度门槛 | diff.cpp:158/319 | kMinMatchLen=5，短匹配"隐形" |
| 收益裁决 | diff.cpp:323 | `len − getCoverCtrlCost ≥ kMinMatchScore` |
| 接龙合并 | `tryLinkExtend` (diff.cpp:229) | 间隙 ≤511B 时合并，省一条 cover 的入场费 |
| 共线合并 | `tryCollinear` (diff.cpp:279) | old/new 成比例推进的匹配直接合并 |
| 终审删除 | `_select_cover` (diff.cpp:345) | TCompressDetect 压缩率模型（CLI 默认 score≥4） |
| gap 序列化 | `TNewDataDiffStream` (stream_serialize.cpp:198) | 无分隔符连续存储，patch 端按 cover 边界切 |
| 残差序列化 | `_subData` (stream_serialize.cpp:312) + rle0 (patch.c:2192) | new−old 模 256，全 0 段只存长度 |
| 最终账单 | `serialize_compressed_diff` (diff.cpp:1269-1286) | HDIFF13 头部 + 4 段数据 |

## 与实测实验互证

[小文件与小重复](./hdiff-minmatch)一篇用 v5.1.0 `hdiffz` 实跑 7 组实验并解析 patch 二进制（coverCount 实测）——本模拟器的判定逻辑与实验结果一致：

- 5B 重复 → coverCount=0（卡门槛）
- 6B 孤立重复 → coverCount=0（收益不足）
- 12B 重复 → coverCount=1
- 80B 小文件 → patch 86B > new（头部+gap 全量，账单里的 ⚠️ 就是它）
