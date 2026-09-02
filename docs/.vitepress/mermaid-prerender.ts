import type { Plugin } from 'vite'
import { spawnSync, execSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// mermaid 构建期预渲染（mmdc CLI 方案）：
// vitepress-plugin-mermaid 是运行时渲染（客户端空 div → 异步 SVG），
// 每次进页面都会引起布局高度变化 → TOC 跳转目标漂移 → 滚动条反复上下滚动。
// 本插件在 markdown 被 VitePress 处理之前，把 ```mermaid 代码块用
// @mermaid-js/mermaid-cli（mmdc，真 Chromium 渲染，可靠）转成内联 SVG，
// 页面加载即完整布局，零异步渲染、零布局抖动。

// 复用 Playwright 的 chromium（可用环境变量 MMDC_CHROME 覆盖）
const CHROME_PATH =
  process.env.MMDC_CHROME ||
  (() => {
    try {
      const out = execSync(
        'find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null | head -1',
        { encoding: 'utf8' }
      ).trim()
      if (out) return out
    } catch { /* ignore */ }
    return ''
  })()

function renderWithMmdc(code: string, index: number): string {
  const mmdcBin = path.join(process.cwd(), 'node_modules', '.bin', 'mmdc')
  const dir = mkdtempSync(path.join(tmpdir(), 'mmd-pre-'))
  try {
    const inFile = path.join(dir, `g${index}.mmd`)
    const outFile = path.join(dir, `g${index}.svg`)
    const cfgFile = path.join(dir, 'puppeteer.json')
    writeFileSync(inFile, code, 'utf8')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        executablePath: CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
    )
    const args = ['-i', inFile, '-o', outFile, '-p', cfgFile, '-q']
    if (CHROME_PATH) {
      const res = spawnSync(mmdcBin, args, { timeout: 60000, encoding: 'utf8' })
      if (res.status !== 0) {
        throw new Error((res.stderr || res.stdout || 'mmdc failed').slice(0, 300))
      }
    } else {
      // 无 chromium 时退回运行时方案（保留 vitepress-plugin-mermaid 的类名）
      throw new Error('未找到 chromium（MMDC_CHROME 或 Playwright 缓存）')
    }
    const svg = readFileSync(outFile, 'utf8')
    // mmdc 输出包含 XML 头/外层容器 → 只取 <svg ...>...</svg>
    const m = svg.match(/<svg[\s\S]*?<\/svg>/)
    if (!m) throw new Error('mmdc 输出无 svg')
    return `<div class="mermaid mermaid-pre">${m[0]}</div>`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function mermaidPrerender(): Plugin {
  return {
    name: 'mermaid-prerender',
    enforce: 'pre',
    // 仅 build 阶段预渲染：dev 走 vitepress-plugin-mermaid 运行时渲染
    apply: 'build',
    transform(code: string, id: string) {
      if (!id.endsWith('.md') && !id.endsWith('.md?vue')) return null
      if (!code.includes('```mermaid')) return null

      const fenceRe = /```mermaid\n([\s\S]*?)```/g
      let out = code
      let idx = 0
      let match: RegExpExecArray | null
      while ((match = fenceRe.exec(code))) {
        const full = match[0]
        const content = match[1]
        try {
          const div = renderWithMmdc(content, idx++)
          out = out.replace(full, div)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(`[mermaid-prerender] ${id} 渲染失败:`, msg)
          out = out.replace(
            full,
            `<pre class="mermaid-error">mermaid 渲染失败: ${msg}</pre>`
          )
        }
      }
      return out
    },
  }
}
