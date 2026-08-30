# TechDeepDive — 技术细节解析站

基于 VitePress 的技术解析网站，自动部署到 GitHub Pages。

## 本地开发

```bash
npm install          # 安装依赖
npm run dev          # 本地预览 http://localhost:5173
npm run build        # 构建到 docs/.vitepress/dist
```

## 内容结构

```
docs/
├── index.md              # 首页
└── unity-memory/         # Unity 内存管理分配细节
    ├── index.md          # 总览：分配器体系
    ├── tls.md            # TLS：每线程临时内存分配
    ├── tlsf.md           # TLSF：两级分割适应算法
    └── dynamic-heap.md   # DynamicHeapAllocator：TLSF 的工程集成
```

## 新增文章

1. 在 `docs/` 下建主题目录，写 markdown
2. 更新 `docs/.vitepress/config.mts` 的 sidebar
3. 提交推送 → Actions 自动部署

## 部署

push 到 `main` 分支后 GitHub Actions 自动构建并发布到 GitHub Pages。

文章原则：**所有结论基于源码逐行核实**，标注源码路径，不做二手转述。
