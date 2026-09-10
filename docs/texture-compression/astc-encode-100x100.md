# ASTC 压缩单步：4×4 / 5×5 / 6×6 分别怎么压同一张 100×100

> 上一篇：[ETC 压缩单步 + 100×100 实例](./etc-encode-100x100) ｜ 下一篇：无（板块末篇）
> 数据可信度：用 **ARM astcenc v5.7.0**（`-cl -fast`，LDR linear）真实压缩；每个输出块的 128bit 位流用按官方 `physical_to_symbolic` 移植的解析器逐块拆字段（625/400/289 块零解析错误、位预算全部自洽）。另有 **4×4 位流中出现 HDR CEM 的实测发现**（md5 级可复现，见 4×4 小节末）。

## 与 ETC1 的本质差异（先建立直觉）

ETC1 是"格式写死"，ASTC 是"**每块自己选配置**"：

| | ETC1 | ASTC |
|---|---|---|
| 每块大小 | 64 bit 恒定 | **128 bit 恒定** |
| footprint | 只有 4×4 | 4×4 ~ 12×12 任意（本页演示 3 种） |
| 表达模型 | 2 基色 + 标量亮度修正 | 2 个**任意方向**端点色 + **每像素独立 weight** |
| 分区 | 无（最多切成 2 个规则半块） | 每块可切成 **1~4 个不规则分区**，各自独立端点 |
| 每像素存储 | 2bit 查表 | weight grid + 双线性上采样 |
| 编码器搜索空间 | 小（本页 ETC 文章穷举 64 组合/块） | 巨大（astcenc 要搜 block mode × partition × CEM × 量化） |

> ASTC 编码器的工作 = 在 128bit 预算里**分三段**：block mode（11bit，定 weight grid 与量化档）+ 配置（partition/CEM）+ weight 数据 + 端点数据。预算给 weight 多、端点就少——**编码器每块都在做这个权衡**，这就是它慢但质量高的原因。

## 分块：同图三种切法

| footprint | 每块像素 | 100×100 切成 | 每块 128bit → bpp | 文件 payload |
|---|---|---|---|---|
| 4×4 | 16 | 25×25 = 625 块 | 8.00 | 10,000 B |
| 5×5 | 25 | 20×20 = 400 块 | 5.12 | 6,400 B |
| 6×6 | 36 | 17×17 = **289 块** | 3.56 | 4,624 B |

同一张图三种切法（白色网格 = 每块 128bit 的边界）：

![三种 footprint 的切块对比](./assets/annot/astc-footprints.png)

> 💡 **看图要点**：块越大，单块里像素越多、每像素分到的 bit 越少（8 → 5.12 → 3.56 bpp）。第三张图注意最右/最下：**100 不能被 6 整除**，17 列/行块里最边缘一块实际覆盖到 102——压出来会带 2px pad（见文末 6×6 小节）。

## 每个块怎么编码（机制单步）

解码一个 128bit 块要按序读出：

![ASTC 128bit 布局色带（以真实块 block(6,6) 为例）](./assets/annot/astc-128bit-layout.png)

1. **block mode（bit 0..10）**：决定 weight grid 尺寸（≤ footprint）与 weight 量化档数
2. **partition count（bit 11..12）**：1~4 个分区
3. **CEM（bit 13..16 或更高）**：Color Endpoint Mode，决定端点怎么存（LDR RGB direct / base+offset / RGBA…16 种）
4. **weight 数据**：从 bit 127 往下填，每个 weight 用 ISE 打包（非 2 的幂档数如 3/6/10 用 trit/quint 编码）
5. **color endpoint 数据**：从低位往高位填，量化档数由剩余 bit 预算反推

编码器就是反向搜索这套配置。下面三种 footprint 各解剖一个真实块。

---

## 4×4 实例：25×25 块

### 解剖真实块 block(6,6)（Q1 渐变中段）

astcenc 对这块的 128bit 真实输出：

```
8de7797e59964000fb18000102e50241
```

| 位段 | 内容 | 值 |
|---|---|---|
| 0..10 | block mode | `01001000001` = 577 |
| 11..12 | partition count − 1 | `00` → **1 个分区** |
| 13..16 | CEM | `1000` = 8 → **LDR RGB direct**（两个端点各存 8bit RGB） |
| 17..69 | color endpoint 数据区 | 预算 53 bit |
| 70..127 | weight 数据（58 bit） | grid **4×4**、量化 **10 档** |

一次真实的"预算权衡"：Q1 渐变块颜色沿一条平滑曲线走，两个 8bit 端点 + 每像素插值足以还原 → 编码器把大头（58/128）给了 **weight**（4×4 grid = 每像素一个 weight，量化 10 档 ≈ 每 weight 3.6bit）；端点只花 53bit 存 6 个 8bit 端点值的量化。

> 为什么 weight 不存更多档？block mode 的 (H,R) 只能表达 **12 种 weight 档**（2,3,4,5,6,8,10,12,16,20,24,32），10 档已是"预算花不完时的常见选择"；档数再高 weight 区变长，会挤掉端点预算。

### 解码还原：同一块压前压后

![block(6,6) ASTC 4×4 压缩前后对比](./assets/annot/astc-block-before-after.png)

对比 ETC 篇那张 block(0,0) 前后图：同样 16 像素 → 8 字节（ETC1）/ 16 字节（ASTC 4×4），ASTC 的还原结果每个像素都不同——因为每个像素有自己的 weight 在两个端点色之间插值，而不是 ETC1 的"4 档修正选 1"。误差 Δ 基本在 ±2 以内（这也是 4×4 能到 55 dB 的原因）。

### 4×4 全图配置统计（真实）

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 625 / **193 块（31%）是 void** |
| 正常块 partition | pc1=388，pc2=42，pc3=2 |
| dual-plane | 2 块 |
| weight grid | 几乎全部 4×4（footprint=grid，无上采样） |
| weight 档分布 | 4 档×197、10 档×60、16 档×56、32 档×48、3 档×33、12 档×28… |
| 解码 PSNR | **55.02 dB** |

**193 块 void-extent** 是 4×4 最出彩的一点：Q2 右半大块纯黄、Q4 部分纯色区，整块颜色恒定。astcenc 用 void-extent 块（block mode 特例 `0x1FC`）只存 **RGBA 各 16bit 常量**，例：

```
block(13,0)  Q2 纯黄区 → ffff3c3cb4b4c8c8fffffffffffffdfc
               bits 8..15 = 常量色（官方解码 = (200,180,59) ≈ 原图 (200,180,60)）
```

### 分区块的例子（为什么用 2 个分区）

block(12,2) 覆盖像素 (48..51, 8..11)——正好骑在 **Q1/Q2 交界**：左边是红蓝渐变、右边是亮黄。两个色簇完全不相干，一个 partition 的两个端点不够描述。astcenc 选 **2 个分区**（partition seed=28，过程式哈希生成分区图案），解码结果：左 (106,0,148) 渐变、右 (200,180,59) 亮黄，各自独立端点。

> 分区机制不用逐像素存"属于哪个区"——只存 10bit seed，解码器用同一个哈希函数重建分区形状（vault 有 `hash52`/`select_partition` 完整代码）。

### 一个反直觉的实测：`-cl`（LDR）压出的位流里有 HDR CEM

拆 `block(12,2)` 的位流时发现它的两个分区 CEM 是 **[9, 7]**——`9` 是 LDR RGB base+offset，而 **`7` 按 ASTC 规范是"HDR RGB，base+scale"**（HDR 端点模式）。整张 4×4 图共 **16 个块**出现这种情况（CEM 值 `7`×12、`11`=HDR RGB direct×4），而 5×5 / 6×6 一张都没有。

这看着像解析 bug（LDR 压缩怎么会有 HDR 端点？），但四步验证排除了这个可能：

| 验证 | 方法 | 结果 |
|---|---|---|
| ① 逻辑对照 | 解析器逐行对照官方 `physical_to_symbolic`（`astcenc_symbolic_physical.cpp:442-476`） | 位级一致 |
| ② 手工核算 | 按规范多分区 CEM 布局手推 `enc=0xd6`（selector=`10` → 分区 class 1/2，序号 1/3） | 得 `[9,7]`，与解析器一致 |
| ③ **md5 级复现** | 用同参数重新 `-cl` 压同一张图 | 文件逐字节相同（md5 一致），现象稳定 |
| ④ 解码交叉验证 | 官方 `-dl` 解码这些块 | 像素误差正常（平均 0.5/255），非 error color |

第 ④ 步是关键：规范的"LDR 模式下 HDR 端点解码为 error color"**只约束最小 LDR 解码器**，astcenc 是全功能解码器，遇到 HDR CEM 照常解码——所以"解出来像素正常"不能反过来证明 CEM 不是 HDR。

![4×4 全图 HDR CEM 块位置（红框，全部骑在象限交界的色簇断裂带上）](./assets/annot/astc-hdr-cem-blocks.png)

> 💡 **看图要点**：红色方框不是随机分布——全部压在上半区垂直交界、右下棋盘格斜向分裂线等**高方差多色块**上（块内标准差 59~92）。这些块 2 分区后每分区只剩 4~6 个端点整数，预算紧绷，编码器在候选格式里挑出了 HDR 版本。

**换个质量档会怎样？**（同一张图、同一命令，只改质量档）

![fast / medium / thorough 三档的 HDR CEM 对比](./assets/annot/astc-hdr-cem-quality.png)

| 质量档 | HDR CEM 块数 | CEM 7 (base+scale) | CEM 11 (direct) |
|---|---|---|---|
| `-fast` | 16 | 12 | 4 |
| `-medium` | 16 | 14 | 2 |
| `-thorough` | **13** | 13 | **0** |

两个规律：质量档越高，**越只保留"省 bit"的 base+scale 格式**、淘汰更贵的 direct（thorough 档 `11` 彻底消失）；且剩下的块进一步收敛到最需要的那条交界列（thorough 的 13 块里 12 块在 x=12 那一列）。

> ⚠️ **诚实边界**：以上全部是**实测结论**（可复现、md5 可验）。至于 astcenc 内部**在哪个环节、基于什么判据**为 LDR 输入选到 HDR 端点格式（候选生成 or 权重对齐阶段），本文未逐行溯源——机制待查，但现象与解码正确性都已闭环。

**教学含义**：`-cl` ≠ "位流里绝不出现 HDR CEM"。CEM 是编码器在"误差 vs bit 预算"上的真实决策结果，规范允许的组合比直觉更多——这也是排查纹理问题时"自洽解析 ≠ 符合规范、符合规范 ≠ 符合直觉"的又一个例子。

![原图](./assets/test-100x100.png)  ![ASTC 4x4 解码](./assets/dec-astc4x4.png)

---

## 5×5 实例：20×20 块

每块 25 像素但只有 128bit（5.12bpp）——比 4×4 少 36% 的每像素预算。astcenc 靠 **weight grid 仍 5×5 但降档**来省钱。

### 解剖真实块 block(0,0)（Q1 左上角）

```
ee9ce9ca9ca1ca0ca00b920014eb20f3
```

| 位段 | 内容 | 值 |
|---|---|---|
| 0..10 | block mode | `00011110011` = 243 |
| 11..12 | partition count − 1 | `00` → 1 分区 |
| 13..16 | CEM | `1001` = 9 → **LDR RGB base+offset** |
| 17..52 | color endpoint 数据区 | 预算 36 bit |
| 53..127 | weight 数据（75 bit） | grid **5×5**、量化 **8 档** |

与 4×4 同位置块的对比很直观：5×5 有 25 个 weight（比 16 多 9 个）→ weight 区 75bit（多 17bit）→ **端点预算从 53 掉到 36bit**。于是 CEM 从"direct（6 个 8bit 值）"降级为 **base+offset（省一半）**。

### 5×5 全图统计（真实）

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 400 / 132（33%） |
| 正常块 partition | pc1=256，pc2=11，pc3=1 |
| weight 档分布 | **8 档×256**（全部正常块的 96%）、2 档×12 |
| 解码 PSNR | **51.67 dB** |

5×5 的编码器几乎全场选 **8 档 weight + CEM 8/9**——这是它在"25 像素 × 128bit"约束下的甜点。质量只比 4×4 掉 3.4dB，但体积省 36%。

---

## 6×6 实例：17×17 块（含 padding）

### 解剖真实块 block(0,0)——weight grid 比 footprint 小

```
9f8ff8778bb89a541281c9000ab7206f
```

| 位段 | 内容 | 值 |
|---|---|---|
| 0..10 | block mode | `00001101111` = 111 |
| 11..12 | partition count − 1 | `00` → 1 分区 |
| 13..16 | CEM | `1001` = 9 → LDR RGB base+offset |
| 17..49 | color endpoint 数据区 | 预算 33 bit |
| 50..127 | weight 数据（78 bit） | grid **5×6**、量化 **6 档** |

**6×6 footprint 的 weight grid 不是 6×6 而是 5×6**（30 个 weight，78bit）。weight 个数 < 像素数（36）→ 解码时把 5×6 weight grid **双线性上采样**到 6×6。这是 ASTC 与 ETC 的又一大差异：weight 密度可调。block(0,0) 是 Q1 平滑渐变，相邻像素 weight 高度相关，用 5×6 grid 上采样几乎无损，省下的 bit 给端点。

全图看 grid 选择（真实）：

| 6×6 块用的 weight grid | 块数 |
|---|---|
| 5×6 | 143 |
| 6×6 | 54 |
| 4×6 / 6×5 / 6×4 等 | 11 |

### 6×6 全图统计（真实）

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 289 / 81（28%） |
| 正常块 partition | pc1=190，pc2=16，pc3=2 |
| weight 档分布 | 6 档×148、2 档×52 |
| 解码 PSNR | **42.67 dB** |

### 6×6 的 padding 代价（工程要点）

100/6 = 16.67 → 编码器 pad 到 102×102，最右列和最底行的块有一半像素是 pad。astcenc 官方解码输出仍回 100×100，但那 17 个"骑在边缘"的块里 pad 像素参与了误差优化，可能拉低真实边缘像素质量。这也是规范建议**纹理尺寸取 footprint 倍数**（6×6 就用 12/24/48…）的原因。

![ASTC 5x5 解码](./assets/dec-astc5x5.png)  ![ASTC 6x6 解码](./assets/dec-astc6x6.png)

---

## 三 footprint 终极对比

| | 4×4 | 5×5 | 6×6 |
|---|---|---|---|
| 每块像素 | 16 | 25 | 36 |
| payload | 10,000 B | 6,400 B | 4,624 B |
| bpp | 8.00 | 5.12 | 3.56 |
| PSNR | **55.02 dB** | 51.67 dB | 42.67 dB |
| 相对 4×4 体积 | 1× | −36% | −54% |
| 相对 4×4 质量 | — | −3.4 dB | −12.4 dB |
| 典型用途（vault 选型表） | UI/法线/关键角色 | 法线/重要道具 | **场景/角色主力** |

质量-体积的剪刀差在 5×5→6×6 之间最大（体积再省 28%，代价却是 8.9dB）——这也是"**6×6 不是万能**：远处场景无所谓，近景角色/UI 掉画质一眼可见"这句工程经验的数据来源。

## 源码解析：128bit 在真实代码里怎么被切开

本页所有"解剖块"的字段都来自配套 Python 解析器 `astc_parse.py`——它逐行移植自 **ARM astcenc 官方解码函数** `physical_to_symbolic`（`astcenc_symbolic_physical.cpp:291`）。核心逻辑浓缩如下（行号 = 官方 5.7.0 源码）：

```cpp
// astcenc_symbolic_physical.cpp:301  物理 128bit → 语义字段
int block_mode = read_bits(11, 0, pcb);            // ① 前 11 bit 就是 block mode
int partition_count = read_bits(2, 11, pcb) + 1;   // ② 接下来 2 bit 是分区数−1
...
// astcenc_block_sizes.cpp:36  decode_block_mode_2d()
//   从 block mode 解出：weight grid 宽高 + 量化档 + 是否 dual-plane
//   （本页解析器把这段原样翻译成 Python 的 decode_block_mode_2d）
...
if (partition_count == 1)
    color_formats[0] = read_bits(4, 13, pcb);       // ③ pc=1：4 bit CEM 固定在 bit13..16
// 权重区：bits_for_weights 从 bit 127 向下占；端点数据从低位起
```

0 基础读者不用读懂 C++，只需抓住一点：**解码器的工作顺序，就是本文"机制单步"那 5 步的逆过程**——先读 block mode 知道 weight 网格和档位，再读分区与 CEM，最后按 ISE 规则把两段数据解出来插值。编码器（没贴，几万行）则是在巨大配置空间里"猜"哪套参数解码效果最好——猜得越准，图越接近原图。

## 复现数据的三句话

- ASTC 全部用 astcenc 5.7.0 `-cl -fast` 压同一张测试图，官方 `-dl` 解码算 PSNR
- 每块字段用按官方解码移植的解析器拆：625+400+289 块零解析错误、每块位预算自洽（block mode + pc + CEM + weight + endpoint = 恰好 128bit）
- 想验证任意一个 hex：`astcenc -dl xxx.astc out.png` 后对照像素

## 自检

- [ ] 能解释 ASTC"三段竞争"：weight 拿多了端点拿什么？
- [ ] 能说出 4×4 为什么 weight grid = footprint，而 6×6 常见 5×6
- [ ] 能解释 void-extent 块怎么做到近乎无损地表示纯色区
- [ ] 能说出 100×100 压 6×6 时发生了什么（pad），以及工程上怎么避免
- [ ] 能从三行对比表里读出"6×6 省 28% 体积却掉 8.9dB"的含义
- [ ] 能解释为什么 `-cl`（LDR）压出的位流里会出现 HDR 端点模式（CEM 7/11），以及怎么排除"解析器读错"（md5 复现 + 手工核算 + 解码交叉验证）

---
板块结束。完整格式原理、ETC2 T/H/Planar、EAC、ASTC 全部 16 种 CEM 与 6 条 Illegal 约束、工程选型见 vault《ETC 与 ASTC 纹理压缩实现原理》。
