import { defineConfig } from 'vitepress'
import { mermaidPrerender } from './mermaid-prerender'

// mermaid 渲染策略（dev + build 统一）：
// mermaidPrerender 插件用 mmdc（Chromium）把 ```mermaid 预渲染成 SVG，
// base64 存 data-svg 属性；客户端 enhanceApp 在 mount 前解码填充 →
// 首帧即完整布局，零异步渲染（不再依赖 vitepress-plugin-mermaid 运行时渲染）

// GitHub Pages 部署在 fankidark.github.io/tech-site/ 子路径下，
// CI 环境必须用 /tech-site/ base，否则资源 404；本地 dev 保持 /
const base = process.env.GITHUB_ACTIONS ? '/tech-site/' : '/'

export default defineConfig({
    base,
    title: 'TechDeepDive',
    description: '技术细节解析站 — 引擎源码深度解析',
    lang: 'zh-CN',
    lastUpdated: true,
    cleanUrls: true,
    vite: {
      plugins: [mermaidPrerender()],
      optimizeDeps: {
        include: ['mermaid'],
      },
    },
    themeConfig: {
      nav: [
        { text: '首页', link: '/' },
        { text: 'GitHub', link: 'https://github.com/fankidark/tech-site' },
      ],
      // 全站统一侧栏：所有技术页面共享同一份目录，随时跳转任意系列
      // （VitePress sidebar 多 key 按前缀匹配，这里用 '/' 兜底 key 覆盖全部页面）
      sidebar: {
        '/': [
          {
            text: 'Unity 内存管理分配细节',
            collapsed: false,
            items: [
              { text: '总览：分配器体系', link: '/unity-memory/' },
              { text: '🧪 交互模拟器（TLSF 可视化）', link: '/unity-memory/tlsf-sim' },
              { text: '🚀 一次分配的完整旅程', link: '/unity-memory/allocator-journey' },
              { text: 'TLS：每线程临时内存分配', link: '/unity-memory/tls' },
              { text: 'TLSF：两级分割适应算法', link: '/unity-memory/tlsf' },
              { text: 'DynamicHeapAllocator：TLSF 的工程集成', link: '/unity-memory/dynamic-heap' },
              { text: 'AtomicStack：无锁栈（DCAS/ABA）', link: '/unity-memory/atomic-stack' },
              { text: 'Deallocate：指针如何找回 Allocator', link: '/unity-memory/deallocate' },
              { text: '🧪 托管堆 GC：不分代不压缩 + 模拟器', link: '/unity-memory/managed-heap-gc' },
              { text: '🧱 class 与 object 的存储结构', link: '/unity-memory/object-layout' },
              { text: '🧪 内存布局查看器', link: '/unity-memory/object-layout-sim' },
            ],
          },
          {
            text: '热更新差分（HDiffPatch）',
            collapsed: false,
            items: [
              { text: '总览：原理与全链路', link: '/hot-update/' },
              { text: '🧪 diff 生成 · 单步调试模拟器', link: '/hot-update/hdiff-sim' },
              { text: 'cover：差量的核心数据结构', link: '/hot-update/hdiff-cover' },
              { text: 'diff 生成：cover 搜索与序列化', link: '/hot-update/hdiff-generate' },
              { text: 'patch 应用：新文件重建', link: '/hot-update/hdiff-patch' },
              { text: '实战例子：手推 diff 与 patch', link: '/hot-update/hdiff-example' },
              { text: '小文件与小重复：为什么没生成 diff', link: '/hot-update/hdiff-minmatch' },
              { text: '项目落地：Unity 热更链路', link: '/hot-update/hdiff-unity' },
              { text: '打包与合并：patch 的完整生命周期', link: '/hot-update/hdiff-pipeline' },
              { text: '安全与踩坑（OPENREAD 实录）', link: '/hot-update/hdiff-security' },
            ],
          },
          {
            text: '纹理压缩（ETC / ASTC）',
            collapsed: false,
            items: [
              { text: '总览：编码器单步详解', link: '/texture-compression/' },
              { text: 'ETC 压缩单步 + 100×100 实例', link: '/texture-compression/etc-encode-100x100' },
              { text: 'ASTC 压缩单步 + 100×100 实例', link: '/texture-compression/astc-encode-100x100' },
            ],
          },
        ],
      },
      outline: { level: [2, 3], label: '本页目录' },
      socialLinks: [
        { icon: 'github', link: 'https://github.com/fankidark/tech-site' },
      ],
      footer: {
        message: '基于 Unity 源码（2020 LTS）逐行核实',
        copyright: 'TechDeepDive © 2026',
      },
    },
})
