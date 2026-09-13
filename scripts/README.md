# scripts

这里的脚本都是**质检工具**，服务于"文章结论必须可核实、页面必须真能看"这条底线。
改完文章后建议按 `check-links → verify_srcrefs → audit-content → build → probe-dom` 的顺序跑一遍。

## 内容与源码校验

- `verify_srcrefs.py` — **源码引用校验**。把文档里每个 `` `文件.c:行号` `` 抽出来，
  到真实源码树逐条核对（同名文件自动择优），行号越界/文件找不到都会报出来。
  跑法：`python scripts/verify_srcrefs.py`（先 `set PYTHONIOENCODING=utf-8`，否则 Windows 控制台中文会乱码）。
  源码根目录与文件名映射写在 `srcref.config.json` —— **换机器要改这里**。

- `audit-content.cjs` — **文章结构审计**。检查每篇是否有"人话切入 / 术语表 / 自检清单"、
  有无遗留占位符、代码围栏是否配对、引用的 Vue 组件与相对图片是否真实存在。
  跑法：`node scripts/audit-content.cjs`

- `check-tables.cjs` — **markdown 表格结构检查**。管道表格少一个 `|` 不会报错，
  只会渲染成错位的列（读者看到"数据和表头对不上"，作者看源码却很正常）。
  这个脚本按行拆单元格（正确处理行内代码里的 `|`）并对齐列数。
  跑法：`node scripts/check-tables.cjs`

## 构建产物校验

- `check-links.cjs` — **断链 / 断图 / 失效锚点检查**。扫 dist 里所有页面，
  校验站内链接、`#锚点` 是否真实存在（VitePress 把标题里的标点转成 `-`，手写锚点极易写错）。
  跑法：`node scripts/check-links.cjs`（先构建）

- `probe-dom.cjs` — **渲染后 DOM 探针**。用 CDP 打开构建产物，量关键组件的尺寸/位置/颜色
  （防塌陷、防重叠、防横向溢出），并自动逐步点击交互组件，验证"单步有没有内容变化"。
  比截图更适合无人值守回归。
  跑法：`node scripts/probe-dom.cjs <url> <out.json> [waitMs] [--size 414,900] [--expr "<js>"]`

- `dump-svg.cjs` — 从构建产物里解出一张 mermaid 图的原始 SVG，打印根标签尺寸与各节点文本。
  排查"图太宽 / 标签不换行"时用它。
  跑法：`node scripts/dump-svg.cjs docs/.vitepress/dist/<页面>.html [第几张]`

## 线上验收

- `verify_lab.py` — 纹理压缩实验台线上端到端验收（Playwright 真实浏览器）。
  跑法：`python3 scripts/verify_lab.py`（需 playwright 的 chromium）。
  覆盖 6 用例：ETC1/BC1 100×100、ASTC 4×4/6×6、ASTC 6×6 120×120、ETC1 160×160；
  每例断言块数/文件字节/bpp/PSNR/日志行数，并点击②画布验证块级下钻面板；
  收集 console 错误（应为 0）。

## 一次性诊断（用完可删）

- `_expr-*.js` — 给 `probe-dom.cjs --expr` 用的临时表达式片段。属临时文件，
  不要把长期有用的检查留在这个命名下，应该并进上面某个脚本。
