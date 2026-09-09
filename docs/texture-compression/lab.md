---
title: 纹理压缩实验台
---

<script setup>
import TextureCompressionLab from './components/TextureCompressionLab.vue'
</script>

# 🧪 纹理压缩实验台

> 上传一张图，**亲眼看它被块压缩的每一步**：切块 → 逐块编码（基色/端点/权重怎么算、怎么打包成 64/128bit）→ 解码对比 → 误差热图。点解码图上的任意块可下钻该块完整单步数据。

<TextureCompressionLab />

## 怎么用

1. **图片**：内置四象限测试图（覆盖渐变/色相/暗色块/高频棋盘四种编码场景），或上传你自己的图（会自动缩放到所选尺寸）
2. **尺寸**：100×100 标准（4×4 与 5×5 整除、6×6 触发 pad——正好演示非倍数尺寸的工程处理）；120×120 三种 footprint 全部整块
3. **格式**：
   - **ETC1 / BC1**：真实编码器（穷举求最优 64bit），与配套 Python 参考编码器**逐块完全一致**
   - **ASTC 4×4/5×5/6×6**：教学编码器——输出**真实合法 bitstream**（ARM 官方 astcenc 可直接解码，已在 100×100 测试图验证 4×4=21.8dB / 5×5=22.3dB / 6×6=20.4dB），但只做 bbox 端点 + 权重投影，不做分区/模式搜索，所以质量低于 astcenc 的 42~55dB
4. **压缩后**：三画布对照（原图 / 压缩解码逐块动画 / 误差热图），底部流水线日志列出每块真实决策；**点击②画布任意位置**弹出该块 ①原始像素 → ②解码含 Δ ③决策字段 → ④索引/权重网格 → ⑤完整 hex bitstream

## 技术要点（对应本板块文章）

| 你在实验台看到的 | 对应讲解 |
|---|---|
| block 决策里 base1/base2、修正表 0..7 | [ETC 单步 + 100×100 实例](./etc-encode-100x100) |
| ASTC 的 cmin/cmax 端点与权重网格、CEM8 通道交错 | [ASTC 单步 + 100×100 实例](./astc-encode-100x100) |
| BC1 端点 + 调色板 4 档 | [DXT / BC1-7 家族](./dxt-bc1-7) |
| 为什么不同格式同图 PSNR 差这么多 | [总览（真实对比表）](./) |

> 数据可信度：所有 PSNR / bitstream / 块决策均为浏览器内真实编码输出（ETC1/BC1 与 Mesa 口径解码对拍零差异；ASTC 教学块可被官方 astcenc 解码）。引擎源码：`texture-compression/components/textureEncoders.js`。

板块：[总览](./) → [ETC 单步](./etc-encode-100x100) → [ASTC 单步](./astc-encode-100x100) → [DXT/BC](./dxt-bc1-7) → [纹理压缩实验台](./lab)
