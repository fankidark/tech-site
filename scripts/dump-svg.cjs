// dump-svg.cjs —— 从构建产物里解出一张图的原生 SVG，打印它的根标签属性与尺寸
// 用途：排查 mermaid 图的宽度/换行问题时，直接看预渲染出来的 SVG 长什么样。
// 用法：node scripts/dump-svg.cjs <构建产物html路径> [第几张，默认0]
const fs = require('fs')

const file = process.argv[2]
const idx = Number(process.argv[3] || 0)
if (!file) {
  console.error('用法: node dump-svg.cjs <html路径> [序号]')
  process.exit(2)
}
const html = fs.readFileSync(file, 'utf8')
const svgs = [...html.matchAll(/data-svg="([A-Za-z0-9+/=]+)"/g)].map((m) =>
  Buffer.from(m[1], 'base64').toString('utf8')
)
if (!svgs.length) {
  console.error('这张页面里没有预渲染的 mermaid 图')
  process.exit(1)
}
const svg = svgs[idx] || svgs[0]
console.log('图总数:', svgs.length, ' 本次取第', idx)
console.log('--- 根标签（前 700 字符）---')
console.log(svg.slice(0, 700))
console.log('\n--- 各节点文本（前 12 个，看有没有不换行的长行）---')
const texts = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
  m[1].replace(/<[^>]+>/g, '').trim()
)
texts.slice(0, 24).forEach((t, i) => {
  console.log(`  [${i}] len=${t.length}  ${t.slice(0, 60)}`)
})
console.log('\n--- foreignObject / htmlLabel 节点 ---')
const fo = [...svg.matchAll(/<foreignObject[\s\S]*?<\/foreignObject>/g)]
console.log('  foreignObject 数量:', fo.length)
if (fo.length) console.log('  第一个宽度属性:', (fo[0][0].match(/width="[^"]*"/) || ['无'])[0])
