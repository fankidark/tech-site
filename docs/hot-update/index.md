# HDiffPatch：热更差分补丁的原理与实现

> 源码：`HDiffPatch v4.12.1`（`C:\References\haru_hdiff\HDiffPatchv4_12_1`，所有行号已逐条对照本地源码验证）
> 项目落地：`D:\hdiff\Dev\Client\Packages\com.haru.hdiff`（C# 层）+ `Product/Lua/Launch/XLaunchUpdate`（Lua 状态机层）

## 一句话模型

> **HDiffPatch 不保存完整新文件，而是保存"如何从旧文件恢复新文件"的指令集合。**

```mermaid
flowchart LR
    OLD["旧文件 oldData<br/>(用户手机上)"] --> D
    NEW["新文件 newData<br/>(CI 构建)"] --> D
    D["hdiffz<br/>搜索复用关系"] --> P["diffData<br/>(通常只有新文件的 5%~30%)"]
    P --> H["hpatchz<br/>old + diff → new"]
    H --> OUT["新文件<br/>(与 CI 产物逐字节一致)"]

    style D fill:#a5d8ff,stroke:#1971c2
    style H fill:#b2f2bb,stroke:#2f9e44
    style P fill:#fff3bf,stroke:#f08c00
```

学习时抓住三个词就够了：

| 核心词 | 一句话 | 所在代码 |
|---|---|---|
| **cover** | 新文件某段可从旧文件某段复用，`{oldPos, newPos, length}` | `patch_types.h:270` |
| **step stream** | single diff 把 patch 数据按 256KB 步进切块，低内存顺序消费 | `stream_serialize.cpp:475` |
| **ref stream** | 目录 diff 把多文件拼成逻辑流，套在文件级 hdiff 外面 | `dir_diff.cpp:281` |

## 生成侧 → 应用侧全链路

```mermaid
flowchart TB
    subgraph gen["📦 hdiffz 生成侧"]
        A1["hdiff_by_stream()<br/>hdiffz.cpp:1412"] --> A2["get_diff()<br/>diff.cpp:883<br/>后缀数组搜 cover"]
        A2 --> A3{"选格式"}
        A3 -->|推荐| A4["serialize_single_compressed_diff()<br/>diff.cpp:994 → HDIFFSF20"]
        A3 -->|兼容| A5["serialize_compressed_diff()<br/>diff.cpp:1250 → HDIFF13"]
    end
    subgraph apply["🔧 hpatchz 应用侧"]
        B1["读文件头<br/>patch.c:2111 getSingleCompressedDiffInfo"] --> B2{"格式头"}
        B2 -->|HDIFFSF20| B3["patch_single_stream_diff()<br/>patch.c:2431"]
        B2 -->|HDIFF13| B4["patchByClip()<br/>patch.c:984"]
    end
    A4 -->|diffData| B1
    A5 -->|diffData| B1

    style A2 fill:#a5d8ff,stroke:#1971c2
    style B3 fill:#b2f2bb,stroke:#2f9e44
```

## 本文结构

1. **[cover：差量的核心数据结构](./hdiff-cover)** —— 三元组怎么来、怎么算账、怎么被裁剪
2. **[diff 生成：cover 搜索与序列化](./hdiff-generate)** —— 后缀数组匹配、收益模型、HDIFFSF20/HDIFF13 两种格式
3. **[patch 应用：新文件如何被重建](./hdiff-patch)** —— gap 拷贝 + 残差加法、step 流式消费、运行时安全检查
4. **[实战例子：手推一遍 diff 与 patch](./hdiff-example)** —— 18 字节 → 15 字节，逐步重放
5. **[小文件与小重复：为什么没生成 diff](./hdiff-minmatch)** —— kMinMatchLen/收益模型/_select_cover 终审 + 7 组实测
6. **[项目落地：Unity 热更中的完整链路](./hdiff-unity)** —— C# HDiffManager/Lua 状态机/native 库三层如何协作
7. **[打包与合并：patch 的完整生命周期](./hdiff-pipeline)** —— 打包机侧生成/发布流程 + 客户端差异计算/下载/合并/校验修复回合
8. **[安全与踩坑](./hdiff-security)** —— 路径穿越、内存 DoS、OPENREAD_ERROR 排查实录
