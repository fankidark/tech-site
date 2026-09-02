import type { Plugin } from 'vite'
import { spawnSync, execSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// mermaid 构建期预渲染（mmdc CLI 方案，dev + build 统一）：
// vitepress-plugin-mermaid 是运行时渲染（客户端空 div → 异步 SVG），
// 每次进页面都会引起布局高度变化 → TOC 跳转目标漂移 → 滚动条反复上下滚动。
//
// 本插件在 markdown 被 VitePress 处理之前，把 ```mermaid 代码块用
// @mermaid-js/mermaid-cli（真 Chromium 渲染）转成 SVG，**base64 编码存入
// data-svg 属性**（避开 Vue 模板编译器对 SVG 内 <style> 的报错）；
// 客户端 enhanceApp（app.mount 之前）解码填充 innerHTML——
// 页面首帧即完整 SVG，零异步渲染、零布局抖动。

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
    const mmCfgFile = path.join(dir, 'mermaid-config.json')
    writeFileSync(inFile, code, 'utf8')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        executablePath: CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
    )
    // 中文字体优先（防测量/渲染回退 DejaVu 导致乱码）+ 放宽标签换行 + 加大字号
    writeFileSync(
      mmCfgFile,
      JSON.stringify({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        flowchart: { htmlLabels: true, wrappingWidth: 320 },
        themeVariables: {
          fontSize: '18px',
          fontFamily:
            '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "WenQuanYi Zen Hei", sans-serif',
        },
      })
    )
    const res = spawnSync(
      mmdcBin,
      ['-i', inFile, '-o', outFile, '-p', cfgFile, '-c', mmCfgFile, '-q'],
      {
        timeout: 60000,
        encoding: 'utf8',
      }
    )
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || 'mmdc failed').slice(0, 300))
    }
    let svg = readFileSync(outFile, 'utf8')
    const m = svg.match(/<svg[\s\S]*?<\/svg>/)
    if (!m) throw new Error('mmdc 输出无 svg')
    svg = m[0]
    // 宽图不再压扁：写死自然尺寸（width/height = viewBox），
    // 容器 overflow-x 横向滚动，文字保持矢量清晰；窄图居中正常显示
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
    if (vb) {
      const w = Math.round(parseFloat(vb[1]))
      const h = Math.round(parseFloat(vb[2]))
      svg = svg
        .replace(/width="100%"/, `width="${w}"`)
        .replace(/style="max-width:[^;"]*;?/, `style="`)
      svg = svg.replace('<svg ', `<svg preserveAspectRatio="xMidYMid meet" data-natural-w="${w}" data-natural-h="${h}" `)
    }
    return svg
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function mermaidPrerender(): Plugin {
  return {
    name: 'mermaid-prerender',
    enforce: 'pre',
    transform(code: string, id: string) {
      // 匹配所有 .md 变体，排除 node_modules
      if (!id.includes('.md') || id.includes('node_modules')) return null
      if (!code.includes('```mermaid')) return null

      const fenceRe = /```mermaid\n([\s\S]*?)```/g
      let out = code
      let idx = 0
      let match: RegExpExecArray | null
      while ((match = fenceRe.exec(code))) {
        const full = match[0]
        const content = match[1]
        try {
          const svg = renderWithMmdc(content, idx++)
          // base64 编码存入 data-svg：SVG 内的 <style> 不进入 Vue 模板 → 无编译报错
          const b64 = Buffer.from(svg, 'utf8').toString('base64')
          out = out.replace(
            full,
            `<div class="mermaid mermaid-pre" data-svg="${b64}"></div>`
          )
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
