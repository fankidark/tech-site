import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'TechDeepDive',
  description: '技术细节解析站 — 引擎源码深度解析',
  lang: 'zh-CN',
  lastUpdated: true,
  cleanUrls: true,
  vite: {
    optimizeDeps: {
      include: ['mermaid'],
    },
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'Unity 内存管理', link: '/unity-memory/' },
      { text: 'GitHub', link: 'https://github.com/fankidark/tech-site' },
    ],
    sidebar: {
      '/unity-memory/': [
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
}))
