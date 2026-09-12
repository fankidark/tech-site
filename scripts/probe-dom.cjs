// probe-dom.cjs —— 用无头 Chrome 直接量"渲染后的 DOM 几何与颜色"
// 为什么不用截图：当前模型读不了图，modlens 视觉桥在本机 spawn EINVAL。
// 直接量 rect / 颜色 / visibility，比"看图"更硬：能拿到具体数字。
//
// 用法：
//   node scripts/probe-dom.cjs <url> <out.json> [waitMs]
//
// 输出：每个选择器命中的元素数量、尺寸、位置、背景色，以及若干"合理性断言"。

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const url = process.argv[2]
const outFile = process.argv[3] || 'probe.json'
const waitMs = Number(process.argv[4] || 9000)
// 可选：额外在页面里执行的表达式（用来验证交互组件确实会随操作变化）
// 用法：node probe-dom.cjs <url> <out.json> <waitMs> --expr "JS 表达式"
const exprIdx = process.argv.indexOf('--expr')
const extraExpr = exprIdx > 0 ? process.argv[exprIdx + 1] : null

const CHROME =
  process.env.MMDC_CHROME ||
  'C:\\Users\\liangqian\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'

const PORT = 9333
const userDir = path.join(process.env.TEMP || '.', 'probe-chrome-profile')

// 要量的东西：组件关键节点的几何与颜色
const PROBE_JS = `
(() => {
  const out = { url: location.href, title: document.title, selectors: {}, issues: [] };
  const want = [
    '.sp-root', '.sp-stage', '.sp-viz', '.sp-side', '.sp-btn-main', '.sp-track',
    '.mm-root', '.mm-bar', '.mm-block', '.mm-block.hi',
    '.bf-root', '.bf-bar', '.bf-field', '.bf-table',
    '.bg-root', '.bg-grid', '.bg-cell',
    '.cs-root', '.cs-line', '.cs-line.on',
    '.tf-root', '.tf-stack', '.tf-btn', '.tf-log li',
    '.aj-root', '.aj-node.on', '.aj-pick.on', '.aj-bucket.hit',
    '.aba-root', '.aba-node', '.aba-verdict',
    '.dt-root', '.dt-cell', '.dt-cell.target',
    '.pl-root', '.pl-blockmap',
    '.tw-root', '.tw-bitmap', '.tw-flbit.on',
    '.mermaid-pre', '.mermaid-pre svg', '.mermaid-error'
  ];
  for (const sel of want) {
    const els = [...document.querySelectorAll(sel)];
    out.selectors[sel] = {
      count: els.length,
      items: els.slice(0, 6).map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
          bg: cs.backgroundColor,
          color: cs.color,
          display: cs.display,
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'
        };
      })
    };
  }

  // ---- 断言：能机械判定的"渲染是否合理" ----
  const A = (cond, msg) => { if (!cond) out.issues.push(msg); };
  const cnt = (s) => (out.selectors[s] ? out.selectors[s].count : 0);
  const first = (s) => (out.selectors[s] && out.selectors[s].items[0]) || null;

  // 1. 不应该有 mermaid 渲染失败
  A(cnt('.mermaid-error') === 0, 'mermaid-error 出现 ' + cnt('.mermaid-error') + ' 个');
  // 2. 代码块容器不应塌陷
  const mm = first('.mm-bar');
  if (cnt('.mm-root')) A(mm && mm.w > 200 && mm.h > 20 && mm.h < 200, '内存图 mm-bar 尺寸异常: ' + JSON.stringify(mm));
  // 3. 位域条不应塌陷
  const bf = first('.bf-bar');
  if (cnt('.bf-root')) A(bf && bf.w > 200 && bf.h >= 20, '位域条 bf-bar 尺寸异常: ' + JSON.stringify(bf));
  // 4. 每个 mm-block 都要有非零宽度
  const mb = out.selectors['.mm-block'].items;
  if (mb.length) A(mb.every((b) => b.w > 0), '存在宽度为 0 的内存块');
  // 5. 播放器控制条按钮要可见
  const btn = first('.sp-btn-main');
  if (cnt('.sp-root')) A(btn && btn.visible && btn.w > 40, '播放按钮不可见或过小: ' + JSON.stringify(btn));
  // 6. 高亮节点要有可见底色
  const hi = first('.mm-block.hi');
  if (cnt('.mm-block.hi')) A(hi && hi.visible, '高亮内存块不可见');
  // 7. StepPlayer 两栏布局：viz 与 side 应该并排（y 接近）而不是重叠
  const viz = first('.sp-viz'), side = first('.sp-side');
  if (viz && side) A(Math.abs(viz.y - side.y) < 40, '播放器两栏未并排: viz.y=' + viz.y + ' side.y=' + side.y);
  // 8. 不应出现内容横向溢出（超过 viewport 太多）
  A(document.documentElement.scrollWidth <= window.innerWidth + 40,
    '页面横向溢出: scrollWidth=' + document.documentElement.scrollWidth + ' innerWidth=' + window.innerWidth);
  // 9. 关键交互节点计数（用于确认组件真的挂载了）
  out.mounted = {
    stepPlayer: cnt('.sp-root'),
    memoryMap: cnt('.mm-root'),
    bitField: cnt('.bf-root'),
    byteGrid: cnt('.bg-root'),
    codeStepper: cnt('.cs-root'),
    mermaid: cnt('.mermaid-pre svg')
  };
  // 诊断用：页面到底渲染出什么了
  out.diag = {
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    mainLen: (document.querySelector('main') || {}).innerHTML
      ? document.querySelector('main').innerHTML.length : 0,
    scripts: document.querySelectorAll('script').length,
    bodyHead: document.body ? document.body.innerText.slice(0, 300) : ''
  };
  return JSON.stringify(out, null, 1);
})()
`

// 逐步走：找到"下一步/播放"类按钮，逐步点击，每步量一次几何。
// 目的：验证"单步到底有没有内容变化"，而不只是看首屏渲染。
const STEPWALK_JS = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 找"下一步"按钮：StepPlayer 的那颗是纯图标（title="下一步（→）"），
  // 其他组件用的是文字按钮，两种都要认。
  const nextBtn = () => [...document.querySelectorAll('button')].find((b) => {
    const t = (b.textContent || '').trim();
    const title = b.getAttribute('title') || '';
    if (/下一步|下一帧/.test(t)) return true;
    return title.includes('下一步') && !b.disabled;
  });
  const stepText = () => {
    const el = document.querySelector('.sp-steptitle, .aba-action, .tw-bitmap-title');
    return el ? el.textContent.trim().slice(0, 40) : '';
  };
  const vizBox = () => {
    const el = document.querySelector('.sp-viz, .aba-stage, .tw-viz');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  const report = [];
  for (let i = 0; i < 12; i++) {
    const btn = nextBtn();
    if (!btn || btn.disabled) break;
    btn.click();
    await sleep(120);   // 等 Vue 把这一步渲染出来，否则读到的还是上一步
    report.push({
      step: i + 1,
      text: stepText(),
      viz: vizBox(),
      extraVisible: !!document.querySelector('.tw-bitmap, .aba-verdict, .dt-lookup-formula.active')
    });
  }
  const texts = report.map((r) => r.text).filter(Boolean);
  const uniq = new Set(texts);
  return JSON.stringify({
    steps: report.length,
    distinctTitles: uniq.size,
    sameTitleEveryStep: report.length > 2 && uniq.size === 1,
    walk: report
  });
})()
`

const chrome = spawn(  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1500,1400',
    '--virtual-time-budget=' + waitMs,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir,
    url,
  ],
  { stdio: 'ignore' }
)

async function main() {
  // 等 CDP 端口起来
  let targets = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await res.json()
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break
    } catch {
      /* 还没起来 */
    }
  }
  // 优先挑 URL 已经匹配的 page；否则拿第一个 page（下面会主动导航过去）
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const page =
    pages.find((t) => t.url && t.url.includes(new URL(url).pathname)) || pages[0]
  if (!page) throw new Error('找不到可调试的页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })

  let msgId = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg.method)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')
  // 主动导航，别指望 Chrome 启动参数里的 URL 已经加载完
  await send('Page.navigate', { url })
  // 等 load 事件（最多 20 秒）
  for (let i = 0; i < 40; i++) {
    if (events.includes('Page.loadEventFired')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  // 再给 Vue 一点挂载时间
  await new Promise((r) => setTimeout(r, 1500))

  const res = await send('Runtime.evaluate', {
    expression: PROBE_JS,
    returnByValue: true,
    awaitPromise: false,
  })
  if (res.exceptionDetails) {
    throw new Error('页面内脚本异常: ' + JSON.stringify(res.exceptionDetails.exception))
  }
  const result = res.result ? res.result.value : null

  // ---- 第二轮：自动逐步点击"下一步"，检查每一步都有内容且几何正常 ----
  let stepwalk = null
  try {
    const walkRes = await send('Runtime.evaluate', {
      expression: STEPWALK_JS,
      returnByValue: true,
      awaitPromise: true,
    })
    stepwalk = walkRes.result ? walkRes.result.value : null
  } catch (e) {
    stepwalk = 'stepwalk failed: ' + e.message
  }

  // ---- 第三轮：执行调用方给的额外表达式（用于验证特定交互的行为）----
  let custom = null
  if (extraExpr) {
    try {
      const r2 = await send('Runtime.evaluate', {
        expression: extraExpr,
        returnByValue: true,
        awaitPromise: true,
      })
      custom = r2.result ? r2.result.value : null
    } catch (e) {
      custom = 'custom expr failed: ' + e.message
    }
  }

  ws.close()
  chrome.kill()
  fs.writeFileSync(outFile, result || '{}', 'utf8')
  const parsed = JSON.parse(result || '{}')
  console.log('mounted:', JSON.stringify(parsed.mounted))
  console.log('issues:', parsed.issues && parsed.issues.length ? parsed.issues : '（无）')
  if (stepwalk) console.log('stepwalk:', stepwalk)
  if (custom) console.log('custom:', custom)
}

main().catch((e) => {
  try {
    chrome.kill()
  } catch {}
  console.error('probe failed:', e.message)
  process.exit(1)
})
