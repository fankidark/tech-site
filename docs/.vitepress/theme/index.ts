import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'

// 修复「本页目录」点击后页面反复上下滚动：
// VitePress 内部对锚点跳转使用 window.scrollTo({ behavior: 'smooth' })，
// 平滑动画期间滚动事件持续触发 TOC 高亮重算，叠加页面异步内容
// （mermaid 图渲染/字体加载）改变布局高度，目标位置漂移，出现震荡。
// 统一改为 instant 跳转：一次定位，无动画、无中间态。
export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === 'undefined') return
    const originalScrollTo = window.scrollTo.bind(window)
    // 包装 window.scrollTo：{ left, top, behavior } 形式强制 behavior='auto'
    window.scrollTo = ((arg1: unknown, arg2?: unknown) => {
      if (typeof arg1 === 'object' && arg1 !== null) {
        originalScrollTo({ ...(arg1 as ScrollToOptions), behavior: 'auto' })
      } else {
        originalScrollTo(arg1 as number, arg2 as number)
      }
    }) as typeof window.scrollTo
  },
} satisfies Theme
