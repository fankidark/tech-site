// check-tables.cjs —— markdown 表格结构检查
//
// 为什么需要：管道表格如果某一行少一个 `|`，VitePress 不会报错，
// 而是把它渲染成错位的列——读者看到的是"数据和表头对不上"，
// 但作者在源码里看每一行都挺正常，很难发现。
//
// 检查项：
//   1. 同一张表里各行单元格数是否一致（与表头对齐）
//   2. 分隔行（|---|---|）单元格数是否与表头一致
//   3. 连续两行表头之间没有分隔行（漏写分隔行会导致整表退化成段落）
//
// 用法：node scripts/check-tables.cjs
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

// 拆单元格：忽略行内代码里的管道符与转义管道
function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells
}

const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l)
const isSeparator = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-')

const problems = []
let tables = 0

for (const f of walk(DOCS)) {
  const rel = path.relative(DOCS, f).replace(/\\/g, '/')
  const lines = fs.readFileSync(f, 'utf8').split('\n')

  let i = 0
  while (i < lines.length) {
    if (!isTableLine(lines[i])) { i++; continue }
    // 表头 + 分隔行
    const header = splitRow(lines[i])
    if (!isSeparator(lines[i + 1] || '')) {
      problems.push({ rel, line: i + 1, kind: '表格缺分隔行', detail: `表头 ${header.length} 列` })
      i++
      continue
    }
    const sep = splitRow(lines[i + 1])
    tables++
    if (sep.length !== header.length) {
      problems.push({
        rel, line: i + 2, kind: '分隔行列数不符',
        detail: `表头 ${header.length} 列，分隔行 ${sep.length} 列`,
      })
    }
    // 表体
    let j = i + 2
    while (j < lines.length && isTableLine(lines[j])) {
      const cells = splitRow(lines[j])
      if (cells.length !== header.length) {
        problems.push({
          rel, line: j + 1, kind: '行单元格数不符',
          detail: `应为 ${header.length} 列，实际 ${cells.length} 列：${lines[j].trim().slice(0, 50)}`,
        })
      }
      j++
    }
    i = j
  }
}

console.log(`扫描 ${walk(DOCS).length} 篇，识别到 ${tables} 张表格`)
if (!problems.length) {
  console.log('✅ 所有表格列数一致')
  process.exit(0)
}
console.log(`⚠️ 发现 ${problems.length} 处表格问题：`)
for (const p of problems.slice(0, 50)) {
  console.log(`  ${p.rel}:${p.line}  ${p.kind}  ${p.detail}`)
}
