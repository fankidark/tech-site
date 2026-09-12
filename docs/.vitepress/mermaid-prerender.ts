import type { Plugin } from 'vite'
import { spawnSync, execSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir, homedir, platform } from 'os'
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

const IS_WIN = platform() === 'win32'

// ---------- 跨平台定位 mmdc 可执行文件 ----------
// Windows 上 npm 生成的是 mmdc.cmd（.ps1 给 PowerShell 用），
// 而 spawnSync 不带 shell 时不会自动补 .cmd 扩展名 → 直接 ENOENT。
// 之前只在 Linux CI 跑过，本地 Windows 表现为"每张图都渲染失败"。
function resolveMmdcBin(): string {
  const binDir = path.join(process.cwd(), 'node_modules', '.bin')
  const candidates = IS_WIN
    ? ['mmdc.cmd', 'mmdc.exe', 'mmdc']
    : ['mmdc', 'mmdc.cmd']
  for (const name of candidates) {
    const p = path.join(binDir, name)
    if (existsSync(p)) return p
  }
  return path.join(binDir, candidates[0]) // 让 spawnSync 报出清晰路径
}

// ---------- 跨平台定位 Chromium ----------
// 优先 MMDC_CHROME；否则找 Playwright 下载的 chromium
// （CI 用 /root/.cache/ms-playwright，Windows 本地在 %LOCALAPPDATA%\ms-playwright）
function findChrome(): string {
  if (process.env.MMDC_CHROME) return process.env.MMDC_CHROME

  const roots = [
    // Linux CI / root
    '/root/.cache/ms-playwright',
    // 当前用户的 Playwright 缓存（跨平台）
    path.join(homedir(), '.cache', 'ms-playwright'),
    ...(IS_WIN
      ? [path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')]
      : []),
  ]

  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    try {
      if (IS_WIN) {
        // chromium-<rev>\chrome-win64\chrome.exe / chrome-win\chrome.exe
        const found = execSync(
          `dir /b /s "${root}\\chrome.exe"`,
          { encoding: 'utf8', shell: 'cmd.exe' }
        )
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
        if (found.length) return found[0]
      } else {
        const out = execSync(
          `find "${root}" -name chrome -type f 2>/dev/null | head -1`,
          { encoding: 'utf8' }
        ).trim()
        if (out) return out
      }
    } catch {
      /* 换下一个候选根目录 */
    }
  }
  return ''
}

const CHROME_PATH = findChrome()

// 中文字体优先（防测量/渲染回退 DejaVu 导致乱码）+ 放宽标签换行 + 加大字号
const MERMAID_CONFIG = JSON.stringify({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  flowchart: { htmlLabels: true, wrappingWidth: 320 },
  themeVariables: {
    fontSize: '18px',
    fontFamily: IS_WIN
      ? '"Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", sans-serif'
      : '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "WenQuanYi Zen Hei", sans-serif',
  },
})

const PUPPETEER_CONFIG = JSON.stringify({
  executablePath: CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})

function renderWithMmdc(code: string, index: number): string {
  const mmdcBin = resolveMmdcBin()
  const dir = mkdtempSync(path.join(tmpdir(), 'mmd-pre-'))
  try {
    const inFile = path.join(dir, `g${index}.mmd`)
    const outFile = path.join(dir, `g${index}.svg`)
    const cfgFile = path.join(dir, 'puppeteer.json')
    const mmCfgFile = path.join(dir, 'mermaid-config.json')
    writeFileSync(inFile, code, 'utf8')
    writeFileSync(cfgFile, PUPPETEER_CONFIG)
    writeFileSync(mmCfgFile, MERMAID_CONFIG)
    const args = ['-i', inFile, '-o', outFile, '-p', cfgFile, '-c', mmCfgFile, '-q']
    const res = spawnSync(mmdcBin, args, {
      timeout: 120000,
      encoding: 'utf8',
      // Windows 的 .cmd 不是可执行文件（无 shell 时 spawn 直接 EINVAL），
      // 必须经 cmd.exe 转一手；临时目录路径由 mkdtempSync 生成，不含空格与特殊字符
      shell: IS_WIN ? 'cmd.exe' : false,
    })
    if (res.error) {
      throw new Error(
        `mmdc 无法启动（${(res.error as NodeJS.ErrnoException).code}）: ${mmdcBin}`
      )
    }
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
