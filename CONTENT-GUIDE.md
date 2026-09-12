# TECH-SITE 内容改造规范（所有改写都必须遵守）

> 这份文档是 `C:\References\tech-site` 改版的**唯一风格与质量口径**。
> 改任何一篇文章前先读完；与本文冲突的写法一律以本文为准。

## 一、改造目标

读者画像是 **0 基础、非计算机科班**，想搞懂"这东西到底怎么工作的"，但看不懂大段源码。
因此每篇文章要同时做到：

1. **先讲人话**：这东西解决什么痛点？没有它会怎样？用什么生活类比能秒懂？
2. **图解优先**：能用一张图说清的，不要写三段文字。
3. **单步可动**：凡是"过程"，都要能一步一步走，每一步给出**当前状态**。
4. **源码可查**：每个关键结论后面标真实源码位置（文件:行号），读者能自己翻。
5. **结论表格化**：对比、选型、参数，一律用表格，不要埋在段落里。
6. **自测收尾**：文末给"自检清单"，让读者确认自己真的懂了。

**风格不要全站统一成同一个模板。** 每个主题按自己的内容需要布局：
- 内存分配类 → 状态图 + 位图 + 单步时间线
- 文件差分类 → 字节序列 + 二进制字段解剖 + 前后对照
- 纹理压缩类 → 像素块矩阵 + 压缩前后画质对比 + 位域解剖

但**信息密度和质量门槛是统一的**（见第四节）。

## 二、可用组件（已全局注册，文章里直接写标签即可）

这些放在 `docs/.vitepress/theme/components/`，已在 `theme/index.ts` 里全局注册：

| 组件 | 用途 | 典型场景 |
|---|---|---|
| `<StepPlayer>` | 单步播放器底座：播放/暂停/单步/变速/进度条 + 右侧源码行 | 任何"过程"演示 |
| `<CodeStepper>` | 源码逐行对照，点行看该行在干嘛 | 讲一段关键函数 |
| `<MemoryMap>` | 地址空间布局横条，块带状态与大小 | 堆布局、块头前后区、文件分段 |
| `<BitField>` | 位域解剖横条 + 字段表 | 位流格式、flag 位、位图 |
| `<ByteGrid>` | 二维格子矩阵 | 纹理块像素、子块划分、页内小块 |

文章自己目录下的组件（如 `docs/unity-memory/components/XXX.vue`）需要在该 md 里写：

```md
<script setup>
import Xxx from './components/Xxx.vue'
</script>
```

**已有组件优先复用**，不要为同样的图重写一个。

## 三、内容结构模板（每篇都要有的骨架，顺序可按内容微调）

```md
# 标题：用"人话问题"命名，不要用术语堆砌

> 源码：`路径/文件.cpp`（本页行号已核对）

## 一句话结论
（3 行以内说清核心因果链）

## 它到底解决什么问题
（痛点 → 没有它会怎样 → 生活类比）

## 术语先对齐
（表格：术语 / 一句话解释。只列本篇要用的）

## 主图解
（mermaid 或组件，先给全局，再进细节）

## 单步拆解 / 逐层深入
（StepPlayer 或 CodeStepper，每步配源码行号）

## 源码逐行核实
（关键函数贴真实代码 + 行号 + 白话解释）

## 常见误解 / 踩坑
（::: warning 容器）

## 自检清单
- [ ] …
```
## 四、质量硬门槛（不达标视为未完成）

1. **禁止编造行号。** 任何 `文件:行号` 必须先用 `Select-String` 到源码里定位过。
   改完必须跑：
   ```powershell
   cd C:\References\tech-site
   python scripts\verify_srcrefs.py
   ```
   必须输出 `文件找不到 0 条，行号越界 0 条`。新增引用的文件若要提前钉死，
   在 `scripts/srcref.config.json` 的 `map` 里加一条。

2. **禁止编造 API / 函数名 / 常量值。** 引用的每个符号都要能在源码里 grep 到。
   数字（对齐值、块头大小、位宽）要给出源码出处或明确标注"本机 32 位口径实测"。

3. **每篇至少一个"动态"元素**：`<StepPlayer>` 或一个可交互组件（点击/切换/单步）。
   纯静态图不算达标。

4. **构建必须通过**：
   ```powershell
   cd C:\References\tech-site
   $env:NODE_ENV='development'; npx vitepress build docs
   ```
   要求：`build complete`、且输出里没有本页相关的 `mermaid 渲染失败`。
   `mermaid` 代码块在构建期会被预渲染成 SVG，语法错会报 `mermaid-error`。

5. **保留原始可信结论。** 改写是"重组 + 加图 + 加白话"，不是重新发明。
   原文里已经核实过的实测数据（PSNR、字节数、md5、耗时）**必须原样保留**，
   不能因为重写而丢失或改数。

6. **Vue 组件写法约束**（踩过的坑）：
   - 状态快照必须**一次性算好**，播放只做时间线回放。在回调/watch 里推进状态机会递归死循环 → 页面 OOM。
   - 所有 `window` / `document` / 定时器 / 事件监听必须在 `onMounted` 内，SSR 构建期没有 window。
   - 组件内不要 `import` 上面那 5 个全局组件，直接用标签。

## 五、源码根目录（引用必须来自这些真实树）

| 主题 | 源码根 |
|---|---|
| Unity 内存 / 线程 / GC | `C:\References\unity2020lts`（`Runtime\Allocator`、`External\Allocator\tlsf`、`External\il2cpp\builds\external\bdwgc`） |
| HDiffPatch C/C++ | `C:\References\haru_hdiff\HDiffPatchv4_12_1`（`libHDiffPatch\HDiff\diff.cpp`、`libHDiffPatch\HPatch\patch.c`） |
| 热更 Unity 侧 C# | `D:\hdiff\Dev\Client\Packages\com.haru.hdiff\Runtime\*.cs`、`D:\hdiff\Dev\Client\Assets\Editor\XGame\XBuilder*.cs` |
| 纹理压缩 | **`C:\References\astc-encoder-5.7.0`**（本机新检出的 5.7.0 worktree，`Source\astcenc_*.cpp`，**这是本系列的口径基准**）、站点自身 `docs\texture-compression\components\textureEncoders.js` |

> ⚠️ **astcenc 版本口径（已定案，别再翻案）**
> 本机有两棵树：
> - `C:\References\astc-encoder-5.7.0` —— `git worktree` 检出的 **5.7.0**（`Source\astcenc_symbolic_physical.cpp` 556 行、`Source\astcenc_block_sizes.cpp` 1218 行）。**文章统一用这棵**。
> - `C:\References\astc-encoder` —— 原分支工作树停在 **1.3**（`Source\astc_symbolic_physical.cpp` 431 行，文件名无 `enc` 前缀）。
>
> 历史经过：老文章写的是 `astcenc_symbolic_physical.cpp:291/301/442-476`、`astcenc_block_sizes.cpp:36`。
> 审计一度以为这些行号与 1.3 不符是错误，实测后发现它们在 **5.7.0 上逐字命中**（`physical_to_symbolic` 定义、
> `int block_mode = read_bits(11, 0, pcb);`、多分区 CEM 解码段、`decode_block_mode_2d`）。
> 也就是说：**引用原本是对的，口径声明才是缺的**。现已检出 5.7.0 真树 + 正文显式声明版本，
> 并在 `scripts/srcref.config.json` 里把 `astcenc_*` 文件名 map 钉到 5.7.0 树。
> 若引用 1.x 命名（`astc_symbolic_physical.cpp` / `astc_block_sizes2.cpp`），那是另一套口径，不要混用。

## 六、语言风格

- 中文技术写作，**第二人称跟读者说话**："你会看到…""注意这里…"。
- 术语首次出现**用大白话解释一次**，之后可放心用。
- 允许并鼓励用类比，但类比之后必须回到真实机制（类比只是入口，不能代替解释）。
- 不写"众所周知""显然""简单来说"这类敷衍词。
- 代码注释用中文，且注释要解释**为什么**，不是复述**是什么**。
- 表格里的每一列都要有信息量，不要为了凑格式加没用的列。

## 七、交付前自查（逐条打勾）

- [ ] `python scripts\verify_srcrefs.py` → 0 找不到、0 越界
- [ ] `npx vitepress build docs` → build complete，无 mermaid-error
- [ ] 本篇至少 1 个动态/交互元素
- [ ] 新增的每个行号都是 grep 出来的，不是推的
- [ ] 原文实测数据一字未改
- [ ] 自检清单存在
- [ ] 术语表存在（或明确说明本篇无新术语）
