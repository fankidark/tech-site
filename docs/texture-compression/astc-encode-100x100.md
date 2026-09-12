<script setup>
import AstcBlockAnatomy from './components/AstcBlockAnatomy.vue'
</script>

# ASTC 单步：4×4 / 5×5 / 6×6 分别怎么压同一张 100×100

> 上一篇：[ETC 压缩单步 + 100×100 实例](./etc-encode-100x100) ｜ 下一篇：[DXT / BC1-7 家族](./dxt-bc1-7)

> **源码口径声明**：本页行号基于 **ARM astcenc 5.7.0** 源码树
> （`C:\References\astc-encoder-5.7.0\Source\astcenc_*.cpp`，已用 `Select-String` 逐条定位）。
> 原文提到的配套 Python 解析器 `astc_parse.py` **未随本站开源、本机也不存在**，
> 因此行号引用已全部改指到官方 C++ 源码；原文基于该解析器的位流实测结论
> （625/400/289 块零解析错误、HDR CEM 实测）作为历史数据原样保留。

> ⚠️ **版本口径统一说明**：老文章里同时出现过 `astc_symbolic_physical.cpp`（**1.x 命名**）
> 和 `astcenc_symbolic_physical.cpp`（**5.x 命名**）两套写法，行号也是两套。本页已**统一到 5.7.0**：
> 文件名一律 `astcenc_*`，行号一律来自 5.7.0 源码树。
> 对照关系：1.3 的 `astc_symbolic_physical.cpp:226`（`physical_to_symbolic` 定义）在 5.7.0 是 **291**；
> 1.3 的 `astc_block_sizes2.cpp` 在 5.7.0 是 **`astcenc_block_sizes.cpp`**。

## 一句话结论

> **ASTC 每块固定 128 bit，但"这 128 bit 怎么花"由编码器每块现选。**
> block mode（11 bit）定下 weight 网格大小与量化档，剩下的位在**端点数据**和**weight 数据**之间此消彼长。
> 给 weight 多、端点就少；块越大，这个取舍越紧张 —— 这就是 6×6 掉 12.4 dB 的根源。

## 它到底解决什么问题

ETC1 的问题是"格式写死"：64 bit 怎么花是规范定死的，编码器毫无话语权。结果就是 Q1 那种渐变块只能认命。

ASTC 换了个思路：**128 bit 是死的，但怎么花是活的。** 编码器对每一块都可以重新决定：

- 一块覆盖几个像素？（footprint 4×4 ~ 12×12）
- 内部切几个分区？（1 ~ 4 个不规则分区）
- 端点色怎么存？（16 种 CEM，从 4bit/通道到 8bit/通道、从 LDR 到 HDR）
- weight 网格多大、量化成几档？（网格可以比 footprint 小，靠上采样补）

生活类比：ETC1 像一个**只有一种格子的储物柜**——所有东西必须按同一个格子尺寸放。ASTC 像**可调隔板的柜子**：这一格放个大件（端点色精度高），那一格放一堆小件（weight 网格密）。柜子总容量不变（128 bit），怎么隔由你。

代价是编码器要搜索的空间爆炸：block mode × 分区 × CEM × 量化档，组合数是几万到几十万量级。**ASTC 慢但质量高，根因在这里。**

## 术语先对齐

| 术语 | 一句话解释 |
|---|---|
| **footprint** | 一块覆盖的像素区域，如 4×4、5×5、6×6 |
| **block mode**（11 bit） | 块头的头 11 位，定下 weight 网格尺寸、量化档、是否 dual-plane |
| **weight grid** | 权重网格，可以**小于** footprint，解码时上采样到 footprint 大小 |
| **weight 量化档** | 权重被量化成几个整数档（2/3/4/5/6/8/10/12/16/20/24/32 共 12 种） |
| **CEM** | Color Endpoint Mode，端点数据的存法。8 = LDR RGB 直存 8bit/通道，9 = base+offset |
| **dual-plane** | 权重分两个平面（比如 R 一个平面、GB 另一个），更精细也更贵 |
| **void-extent** | 恒定色块特例：整块一个颜色，只存 RGBA 各 16bit |
| **ISE** | Integer Sequence Encoding：把 3/5 档这种非 2 的幂的量化用 trit/quint 打包 |
| **pad** | 尺寸补到 footprint 倍数 |

## 主图解：同图三种切法

| footprint | 每块像素 | 100×100 切成 | 每块 128bit → bpp | 文件 payload |
|---|---|---|---|---|
| 4×4 | 16 | 25×25 = 625 块 | 8.00 | 10,000 B |
| 5×5 | 25 | 20×20 = 400 块 | 5.12 | 6,400 B |
| 6×6 | 36 | 17×17 = **289 块** | 3.56 | 4,624 B |

![三种 footprint 的切块对比](./assets/annot/astc-footprints.png)

> 💡 **看图要点**：块越大，单块里像素越多、每像素分到的 bit 越少（8 → 5.12 → 3.56 bpp）。第三张图注意最右/最下：**100 不能被 6 整除**，17 列/行块里最边缘一块实际覆盖到 102——压出来会带 2px pad（见文末 6×6 小节）。

## 128 bit 到底怎么排（机制单步）

解码一个 128bit 块要按序读出五样东西：

![ASTC 128bit 布局色带（以真实块 block(6,6) 为例）](./assets/annot/astc-128bit-layout.png)

| 顺序 | 内容 | 位置 | 作用 |
|---:|---|---|---|
| 1 | **block mode** | bit 0..10 | 定 weight 网格尺寸 + 量化档 + 是否 dual-plane |
| 2 | **partition count** | bit 11..12 | 分区数 − 1（所以是 1~4） |
| 3 | **CEM** | 单分区 bit 13..16；多分区时从 bit 23 起（13 + 10 bit seed） | 端点数据怎么解释 |
| 4 | **weight 数据** | 从 bit 127 往下占 | 每个 weight 用 ISE 打包 |
| 5 | **color endpoint 数据** | 从 bit 17 往上填 | 量化档数由剩余预算反推 |

**关键在 4 和 5 是"对撞"的**：weight 区从高位往低走、端点区从低位往高走，中间那条分界线就是预算分配的结果。编码器改一个 block mode 的值，这条线就动了。

### 官方解码器逐行

这三行就是上面五步里的前三步（行号已核对到 5.7.0）：

<CodeStepper
  file="astcenc_symbolic_physical.cpp（ARM astcenc 5.7.0，全文 556 行）"
  :lines="[
    { n: 54, code: 'static inline int read_bits(', note: '读位原语。签名是 read_bits(要读几位, 从第几位开始, 数据指针) —— 第 2 个参数是起始位。' },
    { n: 291, code: 'void physical_to_symbolic(', note: '物理位流 → 结构化字段的入口。5.7.0 全文 556 行，这个函数从 291 行一直到文件尾。' },
    { n: 301, code: 'int block_mode = read_bits(11, 0, pcb);', note: '头 11 位。var pcb 在 5.x 里是形参名；1.3 时代这个变量叫 pb.data —— 这也是判别你手上是哪一版的指纹。' },
    { n: 302, code: 'if ((block_mode & 0x1FF) == 0x1FC)', note: 'void-extent 特例入口：低 9 位全 1 且第 9 位为 0 时，这块是恒定色，不做插值。' },
    { n: 390, code: 'int partition_count = read_bits(2, 11, pcb) + 1;', note: '官方写的是「分区数 − 1」，所以位流里的 0 表示 1 个分区。' },
    { n: 439, code: 'color_formats[0] = read_bits(4, 13, pcb);', note: '单分区：4 位 CEM 固定在 bit 13..16。注意 range() 是 0..15，但只有部分取值合法。' },
    { n: 446, code: 'int encoded_type = read_bits(6, 13 + PARTITION_INDEX_BITS, pcb) |', note: '多分区：CEM 变复杂了 —— 低位 6 位在这里，高位散在 weight 区下方（下一行的 447 行取出）。' },
    { n: 477, code: 'scb.partition_index = static_cast<uint16_t>(read_bits(10, 13, pcb));', note: '多分区时，10 bit 的 seed 就放在 bit 13..22 —— 分区形状不逐像素存，靠这个 seed 用哈希函数现算。' }
  ]" />

`PARTITION_INDEX_BITS` 是 `astcenc_internal.h:106` 定义的常量，值为 **10** —— 所以多分区块的 CEM 起点从 bit 13 挪到了 bit 23。

## 三种 footprint 的真实块解剖

下面这个交互组把三种 footprint 各挑一个真实块，**现场从 block mode 反推配置**（算法复刻官方 `decode_block_mode_2d`），并把 128 bit 摊成位域。点上面的标签切换：

<AstcBlockAnatomy />

### 每块都在做"预算权衡"

三块放在一起看，ASTC 的核心机制就一目了然了：

| | 4×4 block(6,6) | 5×5 block(0,0) | 6×6 block(0,0) |
|---|---|---|---|
| footprint 像素数 | 16 | 25 | 36 |
| weight grid | 4×4 = 16 | 5×5 = 25 | **5×6 = 30** |
| weight 个数 vs 像素数 | 相等（1:1） | 相等（1:1） | **30 < 36，要上采样** |
| weight 量化档 | 10 档 | 8 档 | 6 档 |
| block mode 原值 | 577 | 243 | 111 |
| weight 区 bit 数 | **58** | **75** | **78** |
| 端点预算 | **53 bit** | **36 bit** | **33 bit** |
| 后果 | CEM 8（端点直存 8bit/通道） | CEM 9（base+offset 省一半） | CEM 9（预算更紧） |

读法：**footprint 一大，weight 个数就多，weight 区立刻吃掉端点预算**。4×4 时端点有 53 bit 挥霍，到 5×5 只剩 36 bit，编码器被迫把 CEM 从"直存 8bit"降级成"base+offset"。

三块的 block mode 值分别是 577 / 243 / 111，全部能在 `astcenc_block_sizes.cpp:36` 的 `decode_block_mode_2d` 里手推出来 —— 上面那个交互组就是照着这个函数实现的。

> 为什么 weight 不干脆少存几档省点位？因为 block mode 的 (H,R) 位只能表达 **12 种档位**（QUANT_2 到 QUANT_32，见 `astcenc_integer_sequence.cpp:353-364` 的 `btq_counts` 表）。10 档已经是"预算花不完时"的常见选择；档数再高 weight 区变长，会挤掉端点预算。

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

> 这几个数字可以直接对上面那个解码循环验算：block mode 577 经 `decode_block_mode_2d` 解出 **4×4 网格、10 档**，16 个 weight 在 10 档下用 ISE 打包要 **58 bit**；128 − 17（块头）− 58 = **53 bit** 留给端点；CEM 8 表示要存 6 个值（两端的 RGB），53 ÷ 6 ≈ 8.8 → 每通道 8 bit 刚好放得下。

一次真实的"预算权衡"：Q1 渐变块颜色沿一条平滑曲线走，两个 8bit 端点 + 每像素插值足以还原 → 编码器把大头（58/128）给了 **weight**（4×4 grid = 每像素一个 weight，量化 10 档 ≈ 每 weight 3.6bit）；端点只花 53bit 存 6 个 8bit 端点值的量化。

> 为什么 weight 不存更多档？block mode 的 (H,R) 位只能表达 **12 种 weight 档**（QUANT_2 到 QUANT_32，见 `astcenc_integer_sequence.cpp:353-364` 的 `btq_counts` 表）；10 档已是"预算花不完时的常见选择"；档数再高 weight 区变长，会挤掉端点预算。

### 解码还原：同一块压前压后

![block(6,6) ASTC 4×4 压缩前后对比](./assets/annot/astc-block-before-after.png)

对比 ETC 篇那张 block(0,0) 前后图：同样 16 像素 → 8 字节（ETC1）/ 16 字节（ASTC 4×4），ASTC 的还原结果每个像素都不同——因为每个像素有自己的 weight 在两个端点色之间插值，而不是 ETC1 的"4 档修正选 1"。误差 Δ 基本在 ±2 以内（这也是 4×4 能到 55 dB 的原因）。

### 4×4 的 void-extent：恒定色块的免费午餐

4×4 全图 625 块里有 **193 块（31%）是 void-extent** —— Q2 右半大块纯黄、Q4 部分纯色区，整块颜色恒定。

void-extent 的位布局极简：**头 8 字节固定，后 8 字节直接是 RGBA 各 16bit 常量**。astcenc 写这块的代码只有十来行：

<CodeStepper
  file="astcenc_symbolic_physical.cpp（ARM astcenc 5.7.0）"
  :lines="[
    { n: 110, code: 'if (scb.block_type == SYM_BTYPE_CONST_U16)', note: '恒定色块走一条完全独立的分支，不参与后面的 weight/端点计算。' },
    { n: 113, code: 'static const uint8_t cbytes[8] { 0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };', note: '头 8 字节写死。第 0 字节 0xFC 就是 block mode 的低 9 位 = 0x1FC 那个特例；第 1 字节 0xFD 而不是 0xFF，是为了让读到 bit 8..11 的解码器看到合法的 CEM。' },
    { n: 119, code: 'for (unsigned int i = 0; i < BLOCK_MAX_COMPONENTS; i++)', note: 'BLOCK_MAX_COMPONENTS 是 4（RGBA），循环 4 次。' },
    { n: 121, code: 'pcb[2 * i + 8] = scb.constant_color[i] & 0xFF;', note: '第 i 个通道的低字节写进第 8+2i 字节 —— 即 16bit 小端。所以第 8 字节起依次是 R、G、B、A 各 16bit。' },
    { n: 122, code: 'pcb[2 * i + 9] = (scb.constant_color[i] >> 8) & 0xFF;', note: '高字节。解码端在 319 行用同样的算式读回来：pcb[2*i+8] | (pcb[2*i+9] << 8)。' }
  ]" />

实测例子（Q2 纯黄区的真实输出）：

```
block(13,0)  →  ffff3c3cb4b4c8c8fffffffffffffdfc
                 ↑               ↑
                 后 8 字节 = R,G,B,A 各 16bit 常量（官方解码 ≈ 原图 (200,180,60)）
```

对照上面的代码：`pcb[8..9] = 0x3C3C`、`pcb[10..11] = 0xB4B4`、`pcb[12..13] = 0xC8C8`、`pcb[14..15] = 0xFFFF`，与 hex 串结尾那 16 个字符逐字节吻合。

**为什么这种块能近乎无损？** 因为它压根不插值 —— 整块 16 个像素解出来是同一个颜色。对纯色区来说，"一个常量"就是完美表达，还省下了全部 weight 位。这也是 ASTC 在大色块 UI 上表现极好的原因。

### 分区块：为什么这里必须用 2 个分区

block(12,2) 覆盖像素 (48..51, 8..11)——正好骑在 **Q1/Q2 交界**：左边是红蓝渐变、右边是亮黄。两个色簇完全不相干，用 1 个分区的两个端点去拟合，等于要用一条直线同时穿过两个相距很远的点簇，怎么选都错。

astcenc 选 **2 个分区**（partition seed=28），解码结果：左 (106,0,148) 渐变、右 (200,180,59) 亮黄，各自有独立的端点色。

> 分区机制不用逐像素存"属于哪个区"——**只存 10 bit seed**，解码器用同一个哈希函数重建分区形状。哈希函数本体在 `astcenc_partition_tables.cpp:114`（`hash52`），分区形状的生成入口在同文件 `:142`（`select_partition`）。10 bit 换来整块的分区图案，这是 ASTC 最省的一笔买卖。

### 一个反直觉的实测：`-cl`（LDR）压出的位流里有 HDR CEM

拆 `block(12,2)` 的位流时发现它的两个分区 CEM 是 **[9, 7]**——`9` 是 LDR RGB base+offset，而 **`7` 按 ASTC 规范是"HDR RGB，base+scale"**（HDR 端点模式）。整张 4×4 图共 **16 个块**出现这种情况（CEM 值 `7`×12、`11`=HDR RGB direct×4），而 5×5 / 6×6 一张都没有。

这看着像解析 bug（LDR 压缩怎么会有 HDR 端点？），但四步验证排除了这个可能：

| 验证 | 方法 | 结果 |
|---|---|---|
| ① 逻辑对照 | 解析器逐行对照官方 `physical_to_symbolic`（`astcenc_symbolic_physical.cpp:442-476`，astcenc 5.7.0） | 位级一致 |
| ② 手工核算 | 按规范多分区 CEM 布局手推 `enc=0xd6`（selector=`10` → 分区 class 1/2，序号 1/3） | 得 `[9,7]`，与解析器一致 |
| ③ **md5 级复现** | 用同参数重新 `-cl` 压同一张图 | 文件逐字节相同（md5 一致），现象稳定 |
| ④ 解码交叉验证 | 官方 `-dl` 解码这些块 | 像素误差正常（平均 0.5/255），非 error color |

> 第 ① 步的 `442-476` 正是多分区 CEM 解码段：头部在 **446** 行读 6 bit 低位、**447** 行读散落在 weight 区下方的高位，**453** 行把两者拼回 4bit CEM，**467** 与 **473** 行再按分区编号拆成各自的 class 与低两位。5.7.0 的 `astcenc_symbolic_physical.cpp` 全文 556 行，这个区间完全在文件范围内。

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

### 4×4 全图配置统计（真实）

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 625 / **193 块（31%）是 void** |
| 正常块 partition | pc1=388，pc2=42，pc3=2 |
| dual-plane | 2 块 |
| weight grid | 几乎全部 4×4（footprint=grid，无上采样） |
| weight 档分布 | 4 档×197、10 档×60、16 档×56、32 档×48、3 档×33、12 档×28… |
| 解码 PSNR | **55.02 dB** |

## 5×5 实例：20×20 块

每块 25 像素但只有 128bit（5.12bpp）——比 4×4 少 36% 的每像素预算。astcenc 靠 **weight grid 仍 5×5 但降档**来省钱。

真实块 block(0,0)（Q1 左上角）：block mode = 243 → **5×5 网格、8 档量化**、单分区、CEM 9（LDR RGB base+offset）、端点预算 36 bit。

与 4×4 同位置块的对比很直观：5×5 有 25 个 weight（比 16 多 9 个）→ weight 区 75bit（多 17bit）→ **端点预算从 53 掉到 36bit**。于是 CEM 从"direct（6 个 8bit 值）"降级为 **base+offset（省一半）**。

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 400 / 132（33%） |
| 正常块 partition | pc1=256，pc2=11，pc3=1 |
| weight 档分布 | **8 档×256**（全部正常块的 96%）、2 档×12 |
| 解码 PSNR | **51.67 dB** |

5×5 的编码器几乎全场选 **8 档 weight + CEM 8/9**——这是它在"25 像素 × 128bit"约束下的甜点。质量只比 4×4 掉 3.4dB，但体积省 36%。

## 6×6 实例：17×17 块（含 padding）

真实块 block(0,0)：block mode = 111 → **5×6 网格、6 档量化**、单分区、CEM 9、端点预算 33 bit。

**6×6 footprint 的 weight grid 不是 6×6 而是 5×6**（30 个 weight，78bit）。weight 个数 < 像素数（36）→ 解码时把 5×6 weight grid **双线性上采样**到 6×6。这是 ASTC 与 ETC 的又一大差异：**weight 密度可调**。block(0,0) 是 Q1 平滑渐变，相邻像素 weight 高度相关，用 5×6 grid 上采样几乎无损，省下的 bit 给端点。

全图看 grid 选择（真实）：

| 6×6 块用的 weight grid | 块数 |
|---|---|
| 5×6 | 143 |
| 6×6 | 54 |
| 4×6 / 6×5 / 6×4 等 | 11 |

| 项 | 值 |
|---|---|
| 总块数 / void-extent | 289 / 81（28%） |
| 正常块 partition | pc1=190，pc2=16，pc3=2 |
| weight 档分布 | 6 档×148、2 档×52 |
| 解码 PSNR | **42.67 dB** |

### 6×6 的 padding 代价（工程要点）

100/6 = 16.67 → 编码器 pad 到 102×102，最右列和最底行的块有一半像素是 pad。astcenc 官方解码输出仍回 100×100，但那 17 个"骑在边缘"的块里 pad 像素参与了误差优化，可能拉低真实边缘像素质量。这也是规范建议**纹理尺寸取 footprint 倍数**（6×6 就用 12/24/48…）的原因。

![ASTC 5x5 解码](./assets/dec-astc5x5.png)  ![ASTC 6x6 解码](./assets/dec-astc6x6.png)

### 6×6 对同一张图的实际切法

![6×6 footprint 切块（注意最右/最下的 pad）](./assets/grid-6x6.png)

对照 5×5 的切法，能直观看出块变大之后"每块要照顾的像素"多了多少：

![5×5 footprint 切块](./assets/grid-5x5.png)

## 三 footprint 终极对比

| | 4×4 | 5×5 | 6×6 |
|---|---|---|---|
| 每块像素 | 16 | 25 | 36 |
| payload | 10,000 B | 6,400 B | 4,624 B |
| bpp | 8.00 | 5.12 | 3.56 |
| PSNR | **55.02 dB** | 51.67 dB | 42.67 dB |
| 相对 4×4 体积 | 1× | −36% | −54% |
| 相对 4×4 质量 | — | −3.4 dB | −12.4 dB |
| 典型用途 | UI/法线/关键角色 | 法线/重要道具 | **场景/角色主力** |

质量-体积的剪刀差在 5×5→6×6 之间最大（体积再省 28%，代价却是 8.9dB）——这也是"**6×6 不是万能**：远处场景无所谓，近景角色/UI 掉画质一眼可见"这句工程经验的数据来源。

## 常见误解 / 踩坑

::: warning 五个容易想歪的点
1. **"128 bit 是给 16 个像素的"** —— 128 bit 是给**一块**的，一块几个像素由 footprint 决定。6×6 时同样是 128 bit 要喂 36 个像素。
2. **"weight grid 一定等于 footprint"** —— 4×4 时确实几乎总是相等，但 6×6 的主流选择是 **5×6**（143/208 块）。grid 比 footprint 小是常态，不是例外。
3. **"CEM 是编码器显式选的一个枚举值"** —— 单分区时它确实就是 bit 13..16 那 4 位；但**多分区时 CEM 被拆成"类 + 低两位"散在两个位置**（`astcenc_symbolic_physical.cpp:446-447` 读、`:467/:473` 拼）。手算时最容易在这里出错。
4. **"void-extent 是一种压缩技巧"** —— 它是规范里的一个**特例 block mode**（`block_mode & 0x1FF == 0x1FC`），位布局完全不同。它不是"特别好的插值"，而是"根本不做插值"。
5. **"块越大越省，所以无脑用 6×6"** —— 看对比表：6×6 省 54% 体积但掉 12.4 dB。正确的做法是**按贴图用途分批选 footprint**，不是全局一个值。
:::

## 复现数据的三句话

- ASTC 全部用 astcenc 5.7.0 `-cl -fast` 压同一张测试图，官方 `-dl` 解码算 PSNR
- 每块字段用按官方解码移植的解析器拆：625+400+289 块零解析错误、每块位预算自洽（block mode + pc + CEM + weight + endpoint = 恰好 128bit）
- 想验证任意一个 hex：`astcenc -dl xxx.astc out.png` 后对照像素

> 复现说明：配套 Python 解析器 `astc_parse.py` 未随本站开源。想自己拆位流，可以直接对着上面
> `physical_to_symbolic` 的三行核心逻辑（`read_bits` / `decode_block_mode_2d` / CEM 读取）写，
> 或者用 [实验台](./lab) 看教学编码器的合法位流是怎么拼出来的。

## 自检清单

- [ ] 能解释 ASTC"三段竞争"：weight 拿多了端点拿什么？
- [ ] 能说出 4×4 为什么 weight grid = footprint，而 6×6 常见 5×6
- [ ] 能解释 void-extent 块怎么做到近乎无损地表示纯色区（提示：它不插值）
- [ ] 能说出 100×100 压 6×6 时发生了什么（pad），以及工程上怎么避免
- [ ] 能从三行对比表里读出"6×6 省 28% 体积却掉 8.9dB"的含义
- [ ] 能解释为什么 `-cl`（LDR）压出的位流里会出现 HDR 端点模式（CEM 7/11），以及怎么排除"解析器读错"（md5 复现 + 手工核算 + 解码交叉验证）
- [ ] 知道本页行号来自 astcenc 5.7.0，以及 1.x 的 `astc_symbolic_physical.cpp:226` 对应 5.7.0 的哪一行

---
板块继续：[DXT / BC1-7 家族](./dxt-bc1-7) —— 另一套"线性调色板"范式
