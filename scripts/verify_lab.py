#!/usr/bin/env python3
"""线上 lab 端到端验收 v2(完成判据 = 日志计数分子==分母)。"""
import json
from playwright.sync_api import sync_playwright

URL = "https://fankidark.github.io/tech-site/texture-compression/lab"
DONE_JS = """() => {
  const b = document.querySelector('button.run');
  const lh = document.querySelector('.logh');
  if (!b || !lh || !document.querySelector('.stats')) return false;
  if (b.innerText.includes('压缩中')) return false;
  const last = lh.innerText.split('\\n').pop().trim();
  const m = last.match(/^(\\d+)\\/(\\d+)$/);
  return !!(m && m[1] === m[2]);
}"""

OUT = {}
with sync_playwright() as p:
    br = p.chromium.launch(headless=True)
    page = br.new_page(viewport={"width": 1500, "height": 1300})
    errs = []
    page.on("pageerror", lambda e: errs.append(f"pageerror: {str(e)[:180]}"))
    page.on("console", lambda m: errs.append(f"console.error: {m.text[:180]}") if m.type == "error" else None)
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_selector(".tclab", timeout=30000)

    def run_case(fmt, size, label, pick=True):
        import time
        t0 = time.time()
        page.select_option(".tclab select >> nth=1", str(size))
        page.wait_for_timeout(700)
        page.select_option(".tclab select >> nth=2", fmt)
        page.wait_for_timeout(700)
        page.click("button.run")
        page.wait_for_function(DONE_JS, timeout=300000)
        page.wait_for_timeout(900)
        dt = time.time() - t0
        stats = page.locator(".stats >> nth=0").inner_text().replace("\n", " | ")
        loghead = page.locator(".logh").inner_text().replace("\n", " ")
        rows = page.locator(".logrow").count()
        d = {"secs": round(dt, 1), "stats": stats, "loghead": loghead, "log_rows": rows}
        if pick:
            box = page.locator(".cvbox >> nth=1").bounding_box()
            page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            page.wait_for_timeout(900)
            if page.locator(".detail").count():
                d["detail"] = page.locator(".detail").inner_text().replace("\n", " | ")[:260]
            else:
                d["detail"] = "(no panel)"
        OUT[label] = d

    run_case("etc1", 100, "ETC1_100x100")
    run_case("bc1", 100, "BC1_100x100")
    run_case("astc4", 100, "ASTC4_100x100")
    run_case("astc6", 100, "ASTC6_100x100_pad")
    run_case("astc6", 120, "ASTC6_120x120_nopad")
    run_case("etc1", 160, "ETC1_160x160")

    page.screenshot(path="/tmp/tc/lab_verify.png", full_page=False)
    OUT["console_errors"] = errs[:10]
    OUT["n_console_errors"] = len(errs)
    br.close()

print(json.dumps(OUT, ensure_ascii=False, indent=1))
