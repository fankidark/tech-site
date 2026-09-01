/// <reference types="vite/client" />
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'

// 修复「本页目录」点击后滚动条反复上下滚动：
// 1) window.scrollTo({ behavior: 'smooth' }) → 强制 auto（VitePress 锚点跳转）
// 2) Element.scrollIntoView({ behavior: 'smooth' }) → 强制 auto（组件/路由滚动）
// 3) 布局抖动（mermaid 异步渲染）由 style.css 的 overflow-anchor: none 兜底
export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === 'undefined') return
    const originalScrollTo = window.scrollTo.bind(window)
    window.scrollTo = ((arg1: unknown, arg2?: unknown) => {
      if (typeof arg1 === 'object' && arg1 !== null) {
        originalScrollTo({ ...(arg1 as ScrollToOptions), behavior: 'auto' })
      } else {
        originalScrollTo(arg1 as number, arg2 as number)
      }
    }) as typeof window.scrollTo

    const originalScrollIntoView: Element['scrollIntoView'] =
      Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions
    ) {
      if (typeof arg === 'object' && arg !== null) {
        originalScrollIntoView.call(this, { ...arg, behavior: 'auto' })
      } else {
        originalScrollIntoView.call(this, arg)
      }
    }
  },
} satisfies Theme
