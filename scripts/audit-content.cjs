// audit-content.cjs —— 文章结构审计
//
// 检查改版规范（CONTENT-GUIDE.md）里定的骨架是否每篇都落实：
//   · 有人话切入（常见标志：先说人话 / 一句话结论 / 它到底解决什么问题）
//   · 有术语表（术语先对齐 / 术语表）
//   · 正文终章有自检清单
//   · 无未替换的占位符（TODO / FIXME / XXX / 待补 / 建设中 等）
//   · 引用的 Vue 组件标签是否真实存在
//   · 相对图片是否真实存在
//   · 代码围栏是否成对
//
// 用法：node scripts/audit-content.cjs
const fs = require('fs')
const path = require('path')

const DOCS = path.resolve('docs')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['.vitepress', 'node_modules', 'public'].includes(e.name)) continue
      walk(p, out)
    } else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const files = walk(DOCS)

// 收集所有组件名（通用组件 + 各主题自己的组件）
const componentNames = new Set()
const globalCompDir = path.join(DOCS, '.vitepress', 'theme', 'components')
if (fs.existsSync(globalCompDir)) {
  for (const f of fs.readdirSync(globalCompDir)) {
    if (f.endsWith('.vue')) componentNames.add(f.replace('.vue', ''))
  }
}
for (const f of files) {
  const dir = path.join(path.dirname(f), 'components')
  if (fs.existsSync(dir)) {
    for (const c of fs.readdirSync(dir)) {
      if (c.endsWith('.vue')) componentNames.add(c.replace('.vue', ''))
    }
  }
}

const rows = []
const problems = []

for (const f of files) {
  const rel = path.relative(DOCS, f).replace(/\\/g, '/')
  const text = fs.readFileSync(f, 'utf8')
  const isTopicIndex = /index\.md$/.test(rel)

  const hasHuman =
    /先说人话|一句话结论|解决什么问题|为什么需要|什么痛点|先说一个|大白话|先说清|先说结论|为什么难|先给完全没接触|在帮你回答|回答什么|你在折腾什么/.test(
      text
    )
  const hasGlossary = /术语先对齐|术语表|\|\s*术语\s*\|/.test(text)
  const hasSelfCheck = /自检清单|自测|检验自己/.test(text)
  const hasInteractive = /<StepPlayer|<CodeStepper|<MemoryMap|<BitField|<ByteGrid|<StripDiagram|<[A-Z][A-Za-z]+(\s|\/|>)/.test(text)

  // 占位符：只认明确的待办标记，避免误伤"占位符"这种正常技术词
  const placeholders = []
  for (const m of text.matchAll(/TODO|FIXME|\bTBD\b|待补充|待写|待补|建设中|此处省略/g)) {
    const line = text.slice(0, m.index).split('\n').length
    placeholders.push(`${m[0]}@${line}`)
  }

  // 代码围栏成对
  const fences = (text.match(/^```/gm) || []).length

  // 引用的 Vue 组件是否存在。
  // 注意排除 C++ 代码里的泛型（List<T>、AtomicStack<T>、DualThreadAllocator<...>）
  // 与行内代码：先把围栏代码块与行内 code 抠掉再找标签。
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
  const used = new Set()
  for (const m of stripped.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) used.add(m[1])
  const missingComps = [...used].filter((c) => !componentNames.has(c))

  // 相对图片是否存在
  const missingImgs = []
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const src = m[1].split('?')[0]
    if (/^https?:/.test(src)) continue
    const p = path.resolve(path.dirname(f), decodeURIComponent(src))
    if (!fs.existsSync(p)) missingImgs.push(src)
  }

  rows.push({
    rel,
    lines: text.split('\n').length,
    human: hasHuman,
    glossary: hasGlossary,
    selfCheck: hasSelfCheck,
    interactive: hasInteractive,
    fences: fences,
  })

  if (fences % 2 !== 0) problems.push({ rel, kind: '代码围栏不配对', detail: `共 ${fences} 个 \`\`\`` })
  if (placeholders.length) problems.push({ rel, kind: '疑似占位符', detail: placeholders.join(', ') })
  if (missingComps.length) problems.push({ rel, kind: '组件不存在', detail: missingComps.join(', ') })
  if (missingImgs.length) problems.push({ rel, kind: '图片缺失', detail: missingImgs.join(', ') })
}

// 结构缺失（排除首页与纯索引页）
for (const r of rows) {
  if (r.rel === 'index.md') continue
  const missing = []
  if (!r.human) missing.push('人话切入')
  if (!r.selfCheck && !r.rel.endsWith('index.md')) missing.push('自检清单')
  if (missing.length) problems.push({ rel: r.rel, kind: '结构缺失', detail: missing.join('、') })
}

console.log(`审计 ${files.length} 篇 markdown\n`)
console.log('文件'.padEnd(46) + '行数  人话  术语  自检  交互')
for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const y = (v) => (v ? ' ✓  ' : ' –  ')
  console.log(
    r.rel.padEnd(46) +
      String(r.lines).padStart(4) +
      y(r.human) +
      y(r.glossary) +
      y(r.selfCheck) +
      y(r.interactive)
  )
}

console.log('')
if (!problems.length) {
  console.log('✅ 没有发现问题')
  process.exit(0)
}
console.log(`⚠️ 发现 ${problems.length} 处待处理：`)
const byKind = {}
for (const p of problems) (byKind[p.kind] ||= []).push(p)
for (const [k, list] of Object.entries(byKind)) {
  console.log(`\n--- ${k}（${list.length}）---`)
  for (const p of list) console.log(`  ${p.rel}  ${p.detail}`)
}
