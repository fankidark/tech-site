/// <reference types="vite/client" />
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'
import StepPlayer from './components/StepPlayer.vue'
import CodeStepper from './components/CodeStepper.vue'
import MemoryMap from './components/MemoryMap.vue'
import BitField from './components/BitField.vue'
import ByteGrid from './components/ByteGrid.vue'
import StripDiagram from './components/StripDiagram.vue'

// 通用教学组件全局注册：文章里直接写 <StepPlayer> / <BitField> 即可，
// 不需要每个 .md 里 import（VitePress markdown 支持 Vue 组件标签）。
const globalComponents = {
  StepPlayer,
  CodeStepper,
  MemoryMap,
  BitField,
  ByteGrid,
  StripDiagram,
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

// 图太宽时的可读性处理（修「节点内容显示不全」）：
//   CSS 已经把 SVG 缩放到栏宽内（max-width:100%），保证"绝不裁切"；
//   但缩得太狠（比如 3790px 的图缩到 688px，只剩 18% 字号）就读不清了，
//   所以这里给缩放过度的图补一条提示 + 「原始尺寸」开关 + 滚轮缩放。
const SCALE_HINT_THRESHOLD = 0.75 // 缩放比低于这个值就提示读者
const READABLE_SCALE = 0.6 // 低于这个值认为"缩得看不清了"

function setupMermaidWidth() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre').forEach((el) => {
    if (el.dataset.wzDone) return
    const svg = el.querySelector('svg')
    if (!svg) return
    el.dataset.wzDone = '1'

    const naturalW = Number(el.dataset.naturalW || svg.getAttribute('data-natural-w') || 0)
    const naturalH = Number(el.dataset.naturalH || svg.getAttribute('data-natural-h') || 0)
    if (!naturalW || !naturalH) return

    const avail = el.clientWidth || 688
    const scale = Math.min(1, avail / naturalW)
    // 放得下就不用管，保持原本的居中显示
    if (naturalW <= avail + 8) return

    el.dataset.scaled = String(scale.toFixed(3))

    const hint = document.createElement('div')
    hint.className = 'mermaid-zoomhint'
    const info = document.createElement('span')
    info.className = 'mz-info'
    info.textContent =
      `原图 ${naturalW}×${naturalH}px，已缩放到 ${Math.round(scale * 100)}% 完整显示` +
      (scale < READABLE_SCALE ? '（字偏小，建议点「原始尺寸」或全屏查看）' : '')

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.textContent = '🔍 原始尺寸'
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation() // 别触发全屏 lightbox
      const full = el.classList.toggle('mermaid-fullwidth')
      // 原始尺寸下 SVG 需要写死的宽高，否则 max-width:none 后没有内在尺寸依据
      svg.setAttribute('width', String(naturalW))
      svg.setAttribute('height', String(naturalH))
      toggle.textContent = full ? '↩ 适应宽度' : '🔍 原始尺寸'
      info.textContent = full
        ? `原始尺寸 ${naturalW}×${naturalH}px（可左右拖动查看）`
        : `原图 ${naturalW}×${naturalH}px，已缩放到 ${Math.round(scale * 100)}% 完整显示` +
          (scale < READABLE_SCALE ? '（字偏小，建议点「原始尺寸」或全屏查看）' : '')
    })

    hint.appendChild(info)
    hint.appendChild(toggle)
    el.insertAdjacentElement('afterend', hint)
  })
}

// 全屏查看：点击图打开 lightbox（浅色底 + 可缩放拖动），Esc/点击空白关闭
function setupMermaidLightbox() {
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.mermaid-pre').forEach((el) => {
    if (el.dataset.lbDone) return
    el.dataset.lbDone = '1'
    el.title = '点击全屏查看（滚轮缩放，拖动平移）'
    el.addEventListener('click', (ev) => {
      // 折叠状态下点的是展开按钮，不弹 lightbox
      if (el.classList.contains('mermaid-folded')) return
      // 「原始尺寸」按钮/提示条上的点击不弹
      const t = ev.target as HTMLElement
      if (t && t.closest && t.closest('.mermaid-zoomhint')) return
      const svg = el.querySelector('svg')
      if (!svg) return

      const lb = document.createElement('div')
      lb.className = 'mermaid-lightbox'
      const scroll = document.createElement('div')
      scroll.className = 'mmlb-scroll'
      const stage = document.createElement('div')
      stage.className = 'mmlb-stage'
      const clone = svg.cloneNode(true) as SVGSVGElement
      // 克隆件在 lightbox 里用自然尺寸，避免继承页面上的缩放
      const nw = Number(el.dataset.naturalW || svg.getAttribute('data-natural-w') || 0)
      const nh = Number(el.dataset.naturalH || svg.getAttribute('data-natural-h') || 0)
      if (nw) clone.setAttribute('width', String(nw))
      if (nh) clone.setAttribute('height', String(nh))
      stage.appendChild(clone)
      scroll.appendChild(stage)
      lb.appendChild(scroll)

      // 滚轮缩放（以鼠标位置为锚点）+ 拖动平移 + 双击复位
      let zoom = 1
      const applyZoom = () => {
        clone.style.transformOrigin = '0 0'
        clone.style.transform = `scale(${zoom})`
        stage.style.width = nw ? nw * zoom + 'px' : ''
        stage.style.height = nh ? nh * zoom + 'px' : ''
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`
      }
      scroll.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault()
          const rect = scroll.getBoundingClientRect()
          const mx = e.clientX - rect.left + scroll.scrollLeft
          const my = e.clientY - rect.top + scroll.scrollTop
          const prev = zoom
          zoom = Math.min(6, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
          const k = zoom / prev
          applyZoom()
          scroll.scrollLeft = mx * k - (e.clientX - rect.left)
          scroll.scrollTop = my * k - (e.clientY - rect.top)
        },
        { passive: false }
      )
      let dragging = false
      let sx = 0
      let sy = 0
      let sleft = 0
      let stop = 0
      scroll.addEventListener('mousedown', (e) => {
        dragging = true
        sx = e.clientX
        sy = e.clientY
        sleft = scroll.scrollLeft
        stop = scroll.scrollTop
        scroll.classList.add('dragging')
      })
      window.addEventListener('mouseup', () => {
        dragging = false
        scroll.classList.remove('dragging')
      })
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return
        scroll.scrollLeft = sleft - (e.clientX - sx)
        scroll.scrollTop = stop - (e.clientY - sy)
      })
      scroll.addEventListener('dblclick', () => {
        zoom = 1
        applyZoom()
      })

      const bar = document.createElement('div')
      bar.className = 'mmlb-bar'
      const hint = document.createElement('span')
      hint.className = 'mmlb-hint'
      hint.textContent = '滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭'
      const zoomLabel = document.createElement('span')
      zoomLabel.className = 'mmlb-zoom'
      zoomLabel.textContent = '100%'
      bar.appendChild(hint)
      bar.appendChild(zoomLabel)
      lb.appendChild(bar)

      // 只有点空白处/关闭按钮才关，点图本身不关（否则拖完就没了）
      lb.addEventListener('click', (e) => {
        if (e.target === lb) lb.remove()
      })
      const closeBtn = document.createElement('button')
      closeBtn.className = 'mmlb-close'
      closeBtn.textContent = '✕'
      closeBtn.addEventListener('click', () => lb.remove())
      lb.appendChild(closeBtn)

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

// 长流程图折叠：默认收起 + 「展开完整流程图」按钮。
// 阈值随视口变化：窄屏（手机）下一张 600px 高的图只占半屏，不该折；
// 宽屏下 600px 的图会把正文推得很远，才需要折。
function setupMermaidFold() {
  if (typeof document === 'undefined') return
  const vh = window.innerHeight || 800
  const foldThreshold = Math.max(620, Math.round(vh * 0.95))
  document.querySelectorAll<HTMLElement>('.mermaid-pre').forEach((el) => {
    if (el.dataset.foldDone) return
    el.dataset.foldDone = '1'
    const svg = el.querySelector('svg')
    if (!svg) return
    const h = svg.getBoundingClientRect().height
    if (h <= foldThreshold) return
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
  setupMermaidWidth()
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
    setupMermaidWidth()
    setupMermaidFold()
    setupMermaidLightbox()
    // 常驻观察器：SPA 路由切换可能在任意时刻发生（用户浏览首页 10s 后才点进文章），
    // 固定 8s 断开会导致之后进入的页面图不填充（空 div）。观察器只处理 data-svg
    // 节点且 fill 有幂等保护（querySelector svg 判重 + removeAttribute），开销可忽略。
    const mo = new MutationObserver(() => {
      fillPrerenderedMermaid()
      setupMermaidWidth()
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
