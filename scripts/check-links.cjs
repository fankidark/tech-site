// check-links.cjs —— 构建产物内部链接 / 图片 / 锚点 的机械检查
//
// 为什么需要：文章里大量使用相对链接（`./tlsf`、`./managed-heap-gc#锚点`）和
// 相对图片（`./assets/xxx.png`）。改版期间侧栏、标题、锚点都可能变动，
// 一个断链在页面上是"点了没反应"，很难靠肉眼发现。
//
// 检查项：
//   1. 所有 <a href> 指向的站内页面是否真实存在
//   2. 带 #锚点 的链接，目标页面是否真的有那个 id
//   3. 所有 <img src> 的资源是否真实存在
//   4. 报告中列出每个问题的来源页面
//
// 用法：node scripts/check-links.cjs [dist目录]
const fs = require('fs')
const path = require('path')

const DIST = process.argv[2] || path.join('docs', '.vitepress', 'dist')
const distAbs = path.resolve(DIST)

if (!fs.existsSync(distAbs)) {
  console.error('找不到构建产物目录:', distAbs, '—— 先跑 npm run build')
  process.exit(2)
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const allFiles = walk(distAbs)
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'))
const fileSet = new Set(allFiles.map((f) => f.replace(/\\/g, '/')))

// 解析每个页面的锚点（id="..."）
const anchorsByPage = new Map()
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8')
  const ids = new Set()
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(decodeURIComponent(m[1]))
  // VitePress 的标题锚点也会出现在 href="#..."，同时兼容 name=
  for (const m of html.matchAll(/\sname="([^"]+)"/g)) ids.add(decodeURIComponent(m[1]))
  anchorsByPage.set(f.replace(/\\/g, '/'), ids)
}

const problems = []
let checkedLinks = 0
let checkedImgs = 0

function resolveUrl(fromFile, url) {
  // 去掉查询串
  const clean = url.split('?')[0]
  const hashIdx = clean.indexOf('#')
  const pathPart = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean
  const hash = hashIdx >= 0 ? clean.slice(hashIdx + 1) : ''
  if (!pathPart) return { ok: true, hit: fromFile.replace(/\\/g, '/'), hash }

  // VitePress 的 markdown 链接会保留成相对形式（如 "./hdiff-generate"），
  // 而产物里是 hdiff-generate.html；VitePress 自己的侧栏则写成绝对路径。
  // 两种都要按"相对当前页面所在目录"解析。
  const baseDir = path.posix.dirname(fromFile.replace(/\\/g, '/'))
  const target = pathPart.startsWith('/')
    ? path.join(distAbs, decodeURIComponent(pathPart))
    : path.join(baseDir, decodeURIComponent(pathPart))

  // cleanUrls 模式下，无扩展名资源由托管方映射到 .html（GitHub Pages 实测支持）
  const candidates = [
    target,
    target + '.html',
    path.join(target, 'index.html'),
  ]
  const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
  return { ok: !!hit, hit: hit ? hit.replace(/\\/g, '/') : null, hash }
}

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8')
  const page = f.replace(/\\/g, '/')
  const rel = path.relative(distAbs, f).replace(/\\/g, '/')

  // --- 链接 ---
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
    const href = m[1]
    if (/^(https?:|mailto:|tel:|javascript:)/i.test(href)) continue
    if (href.startsWith('#') || href === '') continue
    checkedLinks++
    const r = resolveUrl(f, href)
    if (!r.ok) {
      problems.push({ kind: '断链', page: rel, target: href })
      continue
    }    // 锚点校验
    if (r.hash && r.hit && r.hit.endsWith('.html')) {
      const ids = anchorsByPage.get(r.hit)
      const h = decodeURIComponent(r.hash)
      if (ids && !ids.has(h)) {
        problems.push({ kind: '锚点不存在', page: rel, target: href })
      }
    }
  }

  // --- 图片 ---
  for (const m of html.matchAll(/<img\s[^>]*src="([^"]+)"/g)) {
    const src = m[1]
    if (/^(https?:|data:)/i.test(src)) continue
    checkedImgs++
    if (!src.startsWith('/')) continue
    const p = path.join(distAbs, decodeURIComponent(src.split('?')[0]))
    if (!fs.existsSync(p)) {
      problems.push({ kind: '断图', page: rel, target: src })
    }
  }
}

console.log(`检查页面 ${htmlFiles.length} 个，站内链接 ${checkedLinks} 条，图片 ${checkedImgs} 张`)
if (!problems.length) {
  console.log('✅ 没有断链 / 断图 / 失效锚点')
  process.exit(0)
}
console.log(`❌ 发现 ${problems.length} 个问题：`)
const byKind = {}
for (const p of problems) (byKind[p.kind] ||= []).push(p)
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n--- ${kind}（${list.length}）---`)
  const shown = list.slice(0, 40)
  for (const p of shown) console.log(`  ${p.page}  ->  ${p.target}`)
  if (list.length > shown.length) console.log(`  ... 另有 ${list.length - shown.length} 条`)
}
process.exit(1)
