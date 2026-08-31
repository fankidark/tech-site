---
layout: home
hero:
  name: TechDeepDive
  text: 技术细节解析站
  tagline: 引擎源码逐行核实 · 算法机制深度拆解 · 不做二手转述
  actions:
    - theme: brand
      text: 开始阅读
      link: /unity-memory/
    - theme: alt
      text: GitHub
      link: https://github.com/fankidark/tech-site
features:
  - icon: 🧠
    title: 基于源码核实
    details: 每篇文章直接引用引擎源码（Unity 2020 LTS），关键结论可回源码验证，不凭记忆转述
  - icon: ⚙️
    title: 算法机制拆解
    details: 从数据结构到算法流程逐层拆解，含内存布局图、状态转换、复杂度分析
  - icon: 📈
    title: 持续更新
    details: 按需添加技术主题（引擎内存/渲染/热更新/构建管线），每篇独立成文
---

# 技术主题

- **[Unity 内存管理分配细节](/unity-memory/)** — 从 `UNITY_NEW` 宏到物理内存的完整旅程：TLS 每线程临时分配 + TLSF 两级分割适应算法 + DynamicHeapAllocator 工程集成 + AtomicStack 无锁栈 + Deallocate 反查 + 托管堆 GC（IL2CPP 不分代不压缩）· 含 2 个交互模拟器
