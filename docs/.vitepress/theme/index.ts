/// <reference types="vite/client" />
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'
import StepPlayer from './components/StepPlayer.vue'
import CodeStepper from './components/CodeStepper.vue'
import MemoryMap from './components/MemoryMap.vue'
import BitField from './components/BitField.vue'
import ByteGrid from './components/ByteGrid.vue'

// 通用教学组件全局注册：文章里直接写 <StepPlayer> / <BitField> 即可，
// 不需要每个 .md 里 import（VitePress markdown 支持 Vue 组件标签）。
const globalComponents = {
  StepPlayer,
  CodeStepper,
  MemoryMap,
  BitField,
  ByteGrid,
}

// 修复「本页目录」点击后滚动条反复上下滚动：
// 1) window.scrollTo({ behavior: 'smooth' }) → 强制 auto（VitePress 锚点跳转）
// 2) Element.scrollIntoView({ behavior: 'smooth' }) → 强制 auto（组件/路由滚动）
// 3) mermaid 图在构建期由 mermaid-prerender 预渲染成 SVG（base64 存 data-svg），
//    这里在 app.mount 之前解码填充 → 首帧即完整布局，零异步渲染、零布局抖动
// base64 → UTF-8 字符串：atob() 返回 Latin-1 串，多字节 UTF-8 必须逐字节还原，
// 否则中文全部变乱码（ç¬ç« 之类）。TextDecoder 按字节流解码是标准做法。
function b64ToUtf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function fillPrerenderedMermaid() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre[data-svg]').forEach((el) => {
    const b64 = el.getAttribute('data-svg')
    if (!b64) return
    try {
      const svg = b64ToUtf8(b64)
      if (!el.querySelector('svg')) {
        el.innerHTML = svg
      }
      el.removeAttribute('data-svg')
    } catch (e) {
      console.error('[mermaid] 解码失败:', e)
    }
  })
}

// 全屏查看：点击图打开 lightbox（浅色底+原始尺寸，可拖动滚动），Esc/点击关闭
function setupMermaidLightbox() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre').forEach((el) => {
    if (el.dataset.lbDone) return
    el.dataset.lbDone = '1'
    el.title = '点击全屏查看'
    el.addEventListener('click', (ev) => {
      // 折叠状态下点的是展开按钮，不弹 lightbox
      if (el.classList.contains('mermaid-folded')) return
      const svg = el.querySelector('svg')
      if (!svg) return
      const lb = document.createElement('div')
      lb.className = 'mermaid-lightbox'
      const scroll = document.createElement('div')
      scroll.className = 'mmlb-scroll'
      scroll.appendChild(svg.cloneNode(true))
      lb.appendChild(scroll)
      const hint = document.createElement('div')
      hint.className = 'mmlb-hint'
      hint.textContent = '滚动/拖动查看 · 点击任意处或按 Esc 关闭'
      lb.appendChild(hint)
      lb.addEventListener('click', () => lb.remove())
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') {
          lb.remove()
          document.removeEventListener('keydown', esc)
        }
      })
      document.body.appendChild(lb)
    })
  })
}

// 长流程图折叠：>620px 高的图默认收起 + 「展开完整流程图」按钮
function setupMermaidFold() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre').forEach((el) => {
    if (el.dataset.foldDone) return
    el.dataset.foldDone = '1'
    const svg = el.querySelector('svg')
    if (!svg) return
    const h = svg.getBoundingClientRect().height
    if (h <= 620) return
    el.classList.add('mermaid-folded')
    const btn = document.createElement('button')
    btn.className = 'mermaid-expand'
    btn.textContent = `展开完整流程图（高 ${Math.round(h)}px，当前折叠）`
    btn.addEventListener('click', () => {
      el.classList.remove('mermaid-folded')
      btn.remove()
    })
    el.appendChild(btn)
  })
}

// VitePress 入口是 module 脚本（defer）→ 模块顶层执行时 DOM 已解析完，
// 此时填充 data-svg → 用户看到首帧就是完整 SVG（enhanceApp 里再兜底一次）
if (typeof window !== 'undefined') {
  fillPrerenderedMermaid()
  setupMermaidFold()
  setupMermaidLightbox()
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    for (const [name, comp] of Object.entries(globalComponents)) {
      app.component(name, comp)
    }
    if (typeof window === 'undefined') return

    // 兜底：路由切换/内容更新后再填一次
    fillPrerenderedMermaid()
    setupMermaidFold()
    setupMermaidLightbox()
    // 常驻观察器：SPA 路由切换可能在任意时刻发生（用户浏览首页 10s 后才点进文章），
    // 固定 8s 断开会导致之后进入的页面图不填充（空 div）。观察器只处理 data-svg
    // 节点且 fill 有幂等保护（querySelector svg 判重 + removeAttribute），开销可忽略。
    const mo = new MutationObserver(() => {
      fillPrerenderedMermaid()
      setupMermaidFold()
      setupMermaidLightbox()
    })
    mo.observe(document.body, { childList: true, subtree: true })

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
