import { ensureMermaidEnv } from './docs/.vitepress/mermaid-env.ts'
import { readFileSync } from 'fs'
ensureMermaidEnv()
console.log('window:', typeof window !== 'undefined' ? 'ok' : 'MISSING')
console.log('DOMPurify:', typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function' ? 'ok' : 'MISSING')
const { default: mermaid } = await import('mermaid')
mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' })
try {
  const code = readFileSync('/tmp/graph1.mmd', 'utf8')
  const { svg } = await mermaid.render('t', code)
  console.log('复杂图渲染成功, svg:', svg.length)
} catch (e) {
  console.log('复杂图失败:', e.message)
}
