# TechDeepDive — 技术细节解析站

基于 VitePress 的技术解析网站，自动部署到 GitHub Pages。
面向 **0 基础读者**：每篇都从"这东西解决什么问题"讲起，配可交互的单步演示，
并且每个结论都能在真实源码里翻到。

## 本地开发

```bash
npm install          # 安装依赖（注意：若 shell 里 NODE_ENV=production，需加 --include=dev）
npm run dev          # 本地预览 http://localhost:5173
npm run build        # 构建到 docs/.vitepress/dist
```

> Windows 上构建 mermaid 图需要 Chromium。`docs/.vitepress/mermaid-prerender.ts` 会自动探测
> Playwright 下载的 Chromium；也可以用 `MMDC_CHROME` 环境变量指定。

## 内容结构

```
docs/
├── index.md                  # 首页
├── unity-memory/             # Unity 内存管理分配细节（10 篇）
├── hot-update/               # 热更新差分 HDiffPatch（10 篇）
├── texture-compression/      # 纹理压缩 ETC / ASTC / BC（5 篇）
└── .vitepress/
    └── theme/components/     # 全站通用教学组件（全局注册，文章里直接写标签）
```

## 写作与质检（重要）

改任何文章前先读 **`CONTENT-GUIDE.md`**：它定义了读者画像、结构模板、
5 个通用组件的用法、以及不可放宽的质量门槛。

三道自动校验，改完必须都过：

```powershell
# ① 源码引用校验：文档里每个 `文件:行号` 都到真实源码树核对
$env:PYTHONIOENCODING='utf-8'
python scripts\verify_srcrefs.py
#   期望：文件找不到 0 条，行号越界 0 条

# ② 构建（含 mermaid 预渲染）
$env:NODE_ENV='development'
npx vitepress build docs
#   期望：build complete，且没有 "mermaid 渲染失败"

# ③ 渲染后 DOM 探测：起静态服务指向 dist，逐步点击交互组件量几何
node -e "..."   # 见下方说明，或直接 npx serve docs/.vitepress/dist
node scripts\probe-dom.cjs http://localhost:5200/unity-memory/tls out.json
```

`scripts/probe-dom.cjs` 用 CDP 打开构建产物，做两件事：
量关键组件的**尺寸/位置/颜色**（防塌陷、防重叠），以及**自动逐步点击**验证
"单步到底有没有内容变化"。它比截图更适合无人值守的回归检查。

`scripts/srcref.config.json` 里登记了源码树根目录与文件名映射——
新增主题时在这里补 root，短文件名引用才能被正确解析。

## 新增文章

1. 在 `docs/` 下建主题目录，写 markdown（按 `CONTENT-GUIDE.md` 的骨架）
2. 更新 `docs/.vitepress/config.mts` 的 sidebar
3. 跑上面三道校验
4. 提交推送 → Actions 自动部署

## 部署

push 到 `main` 分支后 GitHub Actions 自动构建并发布到 GitHub Pages。

文章原则：**所有结论基于源码逐行核实**，标注源码路径与行号，不做二手转述；
行号由 `scripts/verify_srcrefs.py` 在交付前批量校验。
