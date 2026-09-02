/// <reference types="vite/client" />
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'

// 修复「本页目录」点击后滚动条反复上下滚动：
// 1) window.scrollTo({ behavior: 'smooth' }) → 强制 auto（VitePress 锚点跳转）
// 2) Element.scrollIntoView({ behavior: 'smooth' }) → 强制 auto（组件/路由滚动）
// 3) mermaid 图在构建期由 mermaid-prerender 预渲染成 SVG（base64 存 data-svg），
//    这里在 app.mount 之前解码填充 → 首帧即完整布局，零异步渲染、零布局抖动
function fillPrerenderedMermaid() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre[data-svg]').forEach((el) => {
    const b64 = el.getAttribute('data-svg')
    if (!b64) return
    try {
      const svg = atob(b64)
      if (!el.querySelector('svg')) {
        el.innerHTML = svg
      }
      el.removeAttribute('data-svg')
    } catch (e) {
      console.error('[mermaid] 解码失败:', e)
    }
  })
}

// VitePress 入口是 module 脚本（defer）→ 模块顶层执行时 DOM 已解析完，
// 此时填充 data-svg → 用户看到首帧就是完整 SVG（enhanceApp 里再兜底一次）
if (typeof window !== 'undefined') {
  // 等微任务/首帧前填充：路由首次渲染可能在模块执行后，兜底用 MutationObserver
  fillPrerenderedMermaid()
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === 'undefined') return

    // 兜底：路由切换/内容更新后再填一次
    fillPrerenderedMermaid()
    const mo = new MutationObserver(() => fillPrerenderedMermaid())
    mo.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => mo.disconnect(), 8000)

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
