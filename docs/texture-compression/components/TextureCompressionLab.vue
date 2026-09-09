<template>
  <div class="tclab">
    <!-- ===== 参数条 ===== -->
    <div class="bar">
      <div class="grp">
        <span class="lbl">图片</span>
        <select v-model="srcSel" @change="loadSample" :disabled="busy">
          <option value="sample">内置测试图（四象限）</option>
          <option value="upload">上传图片…</option>
        </select>
        <input v-show="srcSel === 'upload'" type="file" accept="image/*" @change="onFile" />
        <span v-if="imgLoaded" class="meta">{{ W }}×{{ H }}</span>
      </div>
      <div class="grp">
        <span class="lbl">尺寸</span>
        <select v-model="sizeSel" @change="loadSample" :disabled="busy">
          <option :value="100">100×100（标准）</option>
          <option :value="120">120×120（6×6 整块无 pad）</option>
          <option :value="160">160×160（更大图，更慢）</option>
        </select>
      </div>
      <div class="grp">
        <span class="lbl">格式</span>
        <select v-model="fmt" :disabled="busy">
          <option value="etc1">ETC1（真实编码器）</option>
          <option value="bc1">BC1 / DXT1（真实编码器）</option>
          <option value="astc4">ASTC 4×4（教学合法）</option>
          <option value="astc5">ASTC 5×5（教学合法）</option>
          <option value="astc6">ASTC 6×6（教学合法）</option>
        </select>
      </div>
      <button class="run" @click="run" :disabled="busy || !imgLoaded">▶ {{ busy ? '压缩中…' : '开始压缩' }}</button>
      <span v-if="done" class="badge">✔ {{ res.fmtName }}</span>
    </div>

    <!-- ===== 双画布 ===== -->
    <div class="viewrow" v-if="imgLoaded">
      <div class="cvbox">
        <div class="cvt">{{ animPhase < 2 ? '① 原图' : (animDone ? '① 原图（参考）' : '① 原图（参考）') }}</div>
        <canvas ref="cvOrig" :width="viewW" :height="viewH"></canvas>
      </div>
      <div class="cvbox" style="cursor:pointer" @click="pickBlock">
        <div class="cvt">② 压缩解码（逐块进行中…）<span class="hint">点击任意块看单步详解</span></div>
        <canvas ref="cvDec" :width="viewW" :height="viewH"></canvas>
        <div v-if="animating" class="curmark" :style="markStyle"></div>
      </div>
      <div class="cvbox">
        <div class="cvt">③ 误差热图（|解码−原图|×8）</div>
        <canvas ref="cvErr" :width="viewW" :height="viewH"></canvas>
      </div>
    </div>

    <!-- ===== 进度 & 统计 ===== -->
    <div class="stats" v-if="res">
      <span>块数 {{ res.nBlocks }}（{{ res.bpr }}×{{ res.bpc }}）</span>
      <span>文件 {{ res.bytes }} B（{{ res.bpp.toFixed(2) }} bpp）</span>
      <span>PSNR <b>{{ res.psnr.toFixed(2) }} dB</b></span>
      <span class="note">ASTC 教学编码器=合法 bitstream（官方可解）但非最优；ETC1/BC1=穷举最优</span>
    </div>
    <div class="stats small" v-if="res">
      <span class="lbl">模式分布：</span>
      <span v-for="(v,k) in res.modeCount" :key="k" class="mc">{{ k }}:{{ v }}</span>
    </div>

    <!-- ===== 日志 ===== -->
    <div class="logwrap" v-if="log.length">
      <div class="logh">流水线日志（每块：真实决策）<span class="cnt">{{ log.length }}/{{ totalBlocks }}</span></div>
      <div class="log" ref="logEl">
        <div v-for="(l,i) in log" :key="i" class="logrow" :class="{cur: i===log.length-1}">{{ l }}</div>
      </div>
    </div>

    <!-- ===== 当前块详情 ===== -->
    <div class="detail" v-if="curDetail">
      <div class="deth">当前块详情 <code>block({{ curDetail.bx }}, {{ curDetail.by }})</code> <span class="dsub">{{ curDetail.title }}</span></div>
      <div v-html="curDetail.html"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import * as enc from './textureEncoders.js';

// ---------- 状态 ----------
const srcSel = ref('sample');
const sizeSel = ref(100);
const fmt = ref('etc1');
const busy = ref(false);
const imgLoaded = ref(false);
const W = ref(100), H = ref(100);
const rgba = ref(null);
const viewScale = 4; // canvas 放大倍数
const viewW = computed(() => W.value * viewScale);
const viewH = computed(() => H.value * viewScale);
const cvOrig = ref(null), cvDec = ref(null), cvErr = ref(null);
const res = ref(null);
const log = ref([]);
const animating = ref(false);
const animDone = ref(false);
const animPhase = ref(0);
const totalBlocks = ref(0);
const curDetail = ref(null);
const logEl = ref(null);
const markStyle = ref({});
let timer = null;

const fmtName = { etc1: 'ETC1', bc1: 'BC1/DXT1', astc4: 'ASTC 4×4', astc5: 'ASTC 5×5', astc6: 'ASTC 6×6' };

// ---------- 样例图（复刻 /tmp/tc 四象限 100×100） ----------
function makeSample(n) {
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const o = (y * n + x) * 4;
    let r, g, b;
    if (x < n / 2 && y < n / 2) {          // Q1 灰度渐变
      const t = (x + y) / (n - 2); r = g = b = Math.round(255 * (1 - t));
    } else if (x >= n / 2 && y < n / 2) {  // Q2 色相渐变
      const t = (x - n / 2 + y) / (n - 2); r = Math.round(255 * (1 - t)); g = Math.round(255 * t * 0.8); b = Math.round(255 * t * 0.35);
    } else if (x < n / 2 && y >= n / 2) {  // Q3 暗色块
      const cx = Math.floor((x) / (n / 8)), cy = Math.floor((y - n / 2) / (n / 8));
      const pal = [[30, 28, 60], [90, 40, 30], [20, 70, 40], [70, 60, 20]];
      const p = pal[(cx * 2 + cy) % 4]; r = p[0] + (cx * 13) % 30; g = p[1] + (cy * 9) % 25; b = p[2] + (cx + cy) * 7;
    } else {                                // Q4 棋盘高频
      const bx = Math.floor(x / (n / 20)), by = Math.floor((y - n / 2) / (n / 20));
      if ((bx + by) % 2 === 0) { r = 40; g = 36; b = 12; } else { r = 220; g = 190; b = 70; }
    }
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}

function loadSample() {
  if (srcSel.value === 'sample') {
    const n = Number(sizeSel.value);
    W.value = n; H.value = n; rgba.value = makeSample(n); imgLoaded.value = true;
  }
  nextTick(() => drawImage(cvOrig.value, rgba.value));
  resetOut();
}

function onFile(e) {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    const n = Number(sizeSel.value);
    const c = document.createElement('canvas'); c.width = n; c.height = n;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, n, n);
    const d = cx.getImageData(0, 0, n, n);
    W.value = n; H.value = n; rgba.value = new Uint8ClampedArray(d.data); imgLoaded.value = true;
    srcSel.value = 'upload';
    drawImage(cvOrig.value, rgba.value);
    resetOut();
  };
  img.src = URL.createObjectURL(f);
}

function drawImage(cv, px) {
  if (!cv || !px) return;
  const ctx = cv.getContext('2d');
  const tmp = ctx.createImageData(W.value, H.value);
  tmp.data.set(px.subarray(0, W.value * H.value * 4));
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, viewW.value, viewH.value);
  // 放大到 viewScale（像素风格）
  for (let y = 0; y < W.value; y++) for (let x = 0; x < W.value; x++) {
    const o = (y * W.value + x) * 4;
    ctx.fillStyle = `rgb(${px[o]},${px[o + 1]},${px[o + 2]})`;
    ctx.fillRect(x * viewScale, y * viewScale, viewScale, viewScale);
  }
}

function resetOut() {
  res.value = null; log.value = []; animDone.value = false; animPhase.value = 0;
  curDetail.value = null; totalBlocks.value = 0;
  const cv = cvDec.value, ce = cvErr.value;
  if (cv) { cv.getContext('2d').clearRect(0, 0, viewW.value, viewH.value); }
  if (ce) { ce.getContext('2d').clearRect(0, 0, viewW.value, viewH.value); }
}

// ---------- 压缩 ----------
function run() {
  if (!rgba.value || busy.value) return;
  busy.value = true; resetOut(); log.value = []; curDetail.value = null;
  animPhase.value = 1;
  setTimeout(() => {
    const r = enc.encodeImage(rgba.value, W.value, H.value, fmt.value);
    const bs = bsOf(fmt.value);
    r.nBlocks = r.blocks.length;
    r.bpr = Math.ceil(W.value / bs);
    r.bpc = Math.ceil(H.value / bs);
    r.fmtName = fmtName[fmt.value];
    res.value = r;
    totalBlocks.value = r.blocks.length;
    busy.value = false;
    // 预计算每块摘要行
    log.value = r.blocks.map((b, i) => summaryLine(r, b, i));
    animPhase.value = 2;
    startAnim(r);
  }, 30);
}

function bsOf(fmt) { return fmt === 'etc1' || fmt === 'bc1' ? 4 : parseInt(fmt.slice(4), 10); }
function hexOf(w) { return w.toString(16).padStart(w > 0xffffffffffffffffn ? 32 : 16, '0').toUpperCase(); }

function summaryLine(r, b, i) {
  const k = fmt.value;
  const blk = b.blk;
  if (k === 'etc1') {
    const inf = blk.info;
    return `#${i} block(${b.bx},${b.by})  ${inf.mode}${inf.flip ? '·下分' : '·左分'} 表${inf.tb1}/${inf.tb2}  基色${JSON.stringify(inf.base1)}|${JSON.stringify(inf.base2)}  hex ${hexOf(blk.w)}  mse ${blk.mse.toFixed(1)}`;
  }
  if (k === 'bc1') {
    const ep = blk.endpoints;
    return `#${i} block(${b.bx},${b.by})  端点${JSON.stringify(ep[0])}→${JSON.stringify(ep[1])}  hex ${hexOf(blk.w)}  mse ${blk.mse.toFixed(1)}`;
  }
  const key = k === 'astc4' ? '4x4' : k === 'astc5' ? '5x5' : '6x6';
  return `#${i} block(${b.bx},${b.by})  grid${key} 端点(${JSON.stringify(blk.cmin)})→(${JSON.stringify(blk.cmax)})  weight${blk.gw.length}×3bit 端点在${blk.ebits}bit  hex ${hexOf(blk.w)}`;
}

// ---------- 动画：逐块揭示解码图 ----------
function startAnim(r) {
  const cv = cvDec.value, ce = cvErr.value;
  if (!cv) { animating.value = false; animDone.value = true; return; }
  const cctx = cv.getContext('2d'), ectx = ce.getContext('2d');
  const bs = bsOf(fmt.value);
  let i = 0;
  const n = r.blocks.length;
  const orig = rgba.value;
  animating.value = true;
  const stepMs = Math.max(4, Math.min(200, 2600 / n));
  const tick = () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 8 && i < n) { // 每帧尽量快，帧率优先
      const b = r.blocks[i];
      const by = b.by, bx = b.bx;
      for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
        const xx = bx * bs + x, yy = by * bs + y;
        if (xx >= W.value || yy >= H.value) continue;
        const o = (yy * W.value + xx) * 4;
        const d = [r.dec[o], r.dec[o + 1], r.dec[o + 2]];
        cctx.fillStyle = `rgb(${d[0]},${d[1]},${d[2]})`;
        cctx.fillRect(xx * viewScale, yy * viewScale, viewScale, viewScale);
        const e = Math.abs(d[0] - orig[o]) + Math.abs(d[1] - orig[o + 1]) + Math.abs(d[2] - orig[o + 2]);
        const ev = Math.min(255, Math.round(e * 8));
        ectx.fillStyle = `rgb(${ev},${Math.round((255 - ev) * 0.3)},${Math.round((255 - ev) * 0.2)})`;
        ectx.fillRect(xx * viewScale, yy * viewScale, viewScale, viewScale);
      }
      markStyle.value = { left: (bx * bs * viewScale) + 'px', top: (by * bs * viewScale) + 'px', width: (bs * viewScale) + 'px', height: (bs * viewScale) + 'px' };
      i++;
    }
    const el = logEl.value; if (el) el.scrollTop = el.scrollHeight;
    if (i < n) timer = setTimeout(tick, stepMs);
    else { animating.value = false; animDone.value = true; }
  };
  timer = setTimeout(tick, 30);
}

// ---------- 块详情（点击解码图触发 + 当前块常显可选） ----------
function pxOfBlock(bx, by, bs, pxArr) {
  const rows = [];
  for (let y = 0; y < bs; y++) {
    const row = [];
    for (let x = 0; x < bs; x++) {
      const o = ((by * bs + y) * W.value + (bx * bs + x)) * 4;
      row.push([pxArr[o], pxArr[o + 1], pxArr[o + 2]]);
    }
    rows.push(row);
  }
  return rows;
}
function htmlPx(rows, size, dec = null, tag = 'orig') {
  let h = '<table class="pxgrid">';
  rows.forEach((row, y) => {
    h += '<tr>';
    row.forEach((c, x) => {
      const bg = `rgb(${c[0]},${c[1]},${c[2]})`;
      const lum = (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
      let txt = c.join(',');
      if (dec && tag === 'both') {
        const d = dec[y][x];
        const dd = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
        txt = c.join(',') + '<br/><span class="dd">' + (dd[0] >= 0 ? '+' : '') + dd[0] + ',' + (dd[1] >= 0 ? '+' : '') + dd[1] + ',' + (dd[2] >= 0 ? '+' : '') + dd[2] + '</span>';
      } else if (dec && tag === 'dec') {
        txt = d = dec[y][x]; txt = d.join(',');
      }
      h += `<td class="px" style="background:${bg};color:${lum < 140 ? '#eee' : '#111'}">${txt}</td>`;
    });
    h += '</tr>';
  });
  return h + '</table>';
}
function tableField(fields) {
  let h = '<table class="fieldt"><tr><th>字段</th><th>值</th><th>说明</th></tr>';
  for (const f of fields) h += `<tr><td>${f[0]}</td><td><code>${f[1]}</code></td><td class="fm">${f[2]}</td></tr>`;
  return h + '</table>';
}

const fmtHelp = {
  etc1: 'ETC1 单块流程：① 4×4 分左右/上下两个子块 → ② 每子块求均值作基色(5bit) → ③ diff/ind 决定第二个子块存法 → ④ 试 8×8 修正表选误差最小 → ⑤ 每像素从 4 档表值选最近 → ⑥ 打包 64bit',
  bc1: 'BC1 单块流程：① 取 4×4 像素 → ② 穷举两像素作端点(压缩 RGB565) → ③ 插值出 4 色调色板 → ④ 每像素选最近档(2bit) → ⑤ 打包 64bit（16bit 端点×2 + 32bit 索引）',
  astc4: 'ASTC 单块流程（教学编码器=真实合法 bitstream）：① 块内求每通道 min/max 作两端点 → ② 每像素在端点线段上投影得权重(0..1) → ③ 权重量化到 8 档(3bit) → ④ 端点量化到解码器推定的档位 → ⑤ 按 block mode/partition/CEM/endpoint/weight 布局打包 128bit',
  astc5: 'ASTC 5×5：同 4×4 流程，footprint 25 像素；weight grid 也取 5×5（25 权重 ×3bit=75bit，端点预算只剩 36bit → 端点用 6bit/通道量化）',
  astc6: 'ASTC 6×6：36 像素，weight grid 合法上限 30 权重 → 取 5×5 再上采样（本教学用 5×5 grid 直接映射近似），端点预算 36bit → 6bit/通道',
};

// ---------- 点击解码画布 → 块详情 ----------
function pickBlock(e) {
  if (!res.value || !cvDec.value) return;
  const rect = cvDec.value.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) / viewScale);
  const py = Math.floor((e.clientY - rect.top) / viewScale);
  const bs = bsOf(fmt.value);
  const bx = Math.min(Math.floor(px / bs), res.value.bpr - 1);
  const by = Math.min(Math.floor(py / bs), res.value.bpc - 1);
  const blk = res.value.blocks.find(b => b.bx === bx && b.by === by);
  if (!blk) return;
  const decRows = pxOfBlock(bx, by, bs, res.value.dec);
  const k = fmt.value;
  const hex = hexOf(blk.blk.w);
  const title = `格式 ${fmtName[k]} · ${res.value.nBlocks} 块中 block(${bx},${by}) · 输出 ${hex} (${hex.length/2} B)`;
  let html = '<div class="dcols">';
  html += '<div><div class="dsub2">① 原始像素</div>' + htmlPx(pxOfBlock(bx, by, bs, rgba.value)) + '</div>';
  html += '<div><div class="dsub2">② 压缩后解码（含 Δ 误差）</div>' + htmlPx(pxOfBlock(bx, by, bs, rgba.value), bs, decRows, 'both') + '</div>';
  html += '</div>';
  if (k === 'etc1') {
    const inf = blk.blk.info;
    html += '<div class="dsub2">③ 编码决策（穷举 flip×mode×表 最小 MSE）</div>' + tableField([
      ['flip', inf.flip ? '1（上下分）' : '0（左右分）', '子块划分方向'],
      ['mode', inf.mode, inf.mode === 'diff' ? '基色 5bit + 差分 -4..+3' : 'independent：各存 4bit 基色'],
      ['base1(5bit)', JSON.stringify(inf.base1q), '→ 解码色 ' + JSON.stringify(inf.base1)],
      ['base2(5bit)', JSON.stringify(inf.base2q), '→ 解码色 ' + JSON.stringify(inf.base2)],
      ['dR/dG/dB', JSON.stringify(inf.dl), 'diff 模式下第二子块相对偏移'],
      ['修正表', inf.tb1 + ' / ' + inf.tb2, '子块1 用表 ' + inf.tb1 + '，子块2 用表 ' + inf.tb2 + '（0..7 共 8 张 ×4 档）'],
    ]);
    html += '<div class="dsub2">④ 每像素索引（0..3 → 表值）</div>' + htmlIdx(blk.blk.idxs, 4);
  } else if (k === 'bc1') {
    const ep = blk.blk.endpoints;
    html += '<div class="dsub2">③ 端点与插值调色板</div>' + tableField([
      ['端点0 RGB565', ep[0].join(','), '每通道 5/6/5 bit'],
      ['端点1 RGB565', ep[1].join(','), ''],
    ]);
    const c0 = ep[0], c1 = ep[1];
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const cands = [c0, c1, mix(c0, c1, 1 / 3), mix(c0, c1, 2 / 3)];
    html += '<div class="dsub2">④ 调色板（每像素 2bit 选一档）</div>';
    cands.forEach((c, i) => { html += `<span class="sw" style="background:rgb(${c[0]},${c[1]},${c[2]})">档${i}</span>`; });
  } else {
    const key = k === 'astc4' ? '4x4' : k === 'astc5' ? '5x5' : '6x6';
    html += '<div class="dsub2">③ 编码决策（bbox 端点 + 权重投影，教学编码器）</div>' + tableField([
      ['footprint', key, '每块像素数 ' + (parseInt(key[0]) * parseInt(key[2]))],
      ['端点 cmin', JSON.stringify(blk.blk.cmin), '块内每通道最小值'],
      ['端点 cmax', JSON.stringify(blk.blk.cmax), '块内每通道最大值'],
      ['weight 量化', blk.blk.gw.length + ' 个 × 3bit', '8 档（qm=5，纯 bit 无 trit）'],
      ['端点预算', (111 - blk.blk.gw.length * 3) + ' bit', '→ 每通道 ' + blk.blk.ebits + 'bit（range ' + (1 << blk.blk.ebits) + '）'],
      ['CEM', '8 (LDR RGB direct)', '端点排列 R0 R1 G0 G1 B0 B1（通道交错）'],
    ]);
    html += '<div class="dsub2">④ 权重网格（grid 尺寸）</div>' + htmlGw(blk.blk.gw, blk.blk, key);
  }
  html += '<div class="dsub2">⑤ 输出 bitstream（' + (hex.length / 2) + ' B）</div><code class="hexline">' + hex + '</code>';
  curDetail.value = { bx, by, html, title };
}

function htmlIdx(idxs, size) {
  let h = '<table class="pxgrid">';
  for (let y = 0; y < size; y++) {
    h += '<tr>';
    for (let x = 0; x < size; x++) h += `<td class="px" style="background:#182030;color:#ffd500">${idxs[y*size+x]}</td>`;
    h += '</tr>';
  }
  return h + '</table>';
}
function htmlGw(gw, blk, key) {
  const gx = gw.length === 16 ? 4 : gw.length === 25 ? 5 : 6;
  const gy = gw.length / gx;
  let h = '<table class="pxgrid">';
  for (let y = 0; y < gy; y++) {
    h += '<tr>';
    for (let x = 0; x < gx; x++) {
      const q = gw[y * gx + x];
      const t = q / 7;
      const col = blk.cmin.map((v, c) => Math.round(v + (blk.cmax[c] - v) * t));
      h += `<td class="px" style="background:rgb(${col[0]},${col[1]},${col[2]});color:#fff">${q}</td>`;
    }
    h += '</tr>';
  }
  return h + '</table><div class="fm">格值=量化权重 q（0..7）；底色=该权重插值出的颜色预览（cmin→cmax 线性）</div>';
}

onMounted(() => loadSample());
onUnmounted(() => { if (timer) clearTimeout(timer); });
</script>

<style scoped>
.tclab { font-size: 14px; line-height: 1.6; }
.hint { color: #666; font-size: 11px; margin-left: 8px; }
:deep(.dcols) { display: flex; flex-wrap: wrap; gap: 14px; }
:deep(.dsub2) { color: #7c9fd0; font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
:deep(.hexline) { display: block; word-break: break-all; background: #0a0e16; padding: 6px 10px; border-radius: 4px; font-size: 13px; color: #ffd500; }
:deep(.sw) { display: inline-block; padding: 4px 10px; margin-right: 8px; border-radius: 4px; border: 1px solid #555; font-size: 12px; }
:deep(.fm) { color: #888; font-size: 12px; }
.bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px; background: #0f1420; border-radius: 8px; margin-bottom: 10px; }
.grp { display: flex; gap: 6px; align-items: center; }
.lbl { color: #8ab4f8; font-size: 12px; }
select, button { background: #1a2333; color: #eee; border: 1px solid #334; border-radius: 6px; padding: 5px 8px; }
button.run { background: #1f6feb; color: #fff; border: none; padding: 6px 14px; cursor: pointer; }
button.run:disabled { opacity: 0.5; }
.badge { color: #3fb950; font-weight: 600; }
.meta { color: #888; font-size: 12px; }
.viewrow { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.cvbox { position: relative; border: 1px solid #223; border-radius: 6px; padding: 4px; background: #0b0f18; }
.cvt { color: #9aa; font-size: 12px; padding: 2px 4px 6px; }
canvas { image-rendering: pixelated; display: block; }
.curmark { position: absolute; border: 2px solid #ffd500; pointer-events: none; box-sizing: border-box; z-index: 5; }
.stats { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 4px; }
.stats.small { font-size: 12px; color: #999; }
.mc { background: #151d2e; padding: 2px 8px; border-radius: 4px; }
.note { color: #888; font-size: 12px; }
.logwrap { border: 1px solid #223; border-radius: 6px; margin: 8px 0; background: #0a0e16; }
.logh { padding: 6px 10px; color: #8ab4f8; font-weight: 600; border-bottom: 1px solid #223; display: flex; justify-content: space-between; }
.cnt { color: #666; font-weight: 400; }
.log { max-height: 180px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px; padding: 4px 10px; }
.logrow { color: #9db; padding: 1px 0; }
.logrow.cur { color: #ffd500; }
.detail { border: 1px solid #2a3; border-radius: 6px; padding: 8px 12px; background: #0c1018; }
.deth { color: #8ab4f8; font-weight: 600; margin-bottom: 6px; }
.dsub { color: #888; font-weight: 400; font-size: 12px; margin-left: 6px; }
.detail :deep(table.pxgrid) { border-collapse: collapse; margin: 6px 0; display: inline-block; vertical-align: top; margin-right: 12px; }
.detail :deep(.px) { border: 1px solid #334; text-align: center; font-size: 10px; font-family: ui-monospace, monospace; padding: 1px 2px; min-width: 30px; }
.detail :deep(.dd) { color: #ff9; font-size: 9px; }
.detail :deep(table.fieldt) { border-collapse: collapse; margin: 6px 0; }
.detail :deep(.fieldt th) { text-align: left; color: #8ab4f8; font-size: 12px; padding: 2px 8px; border-bottom: 1px solid #334; }
.detail :deep(.fieldt td) { padding: 2px 8px; border-bottom: 1px solid #1c2333; font-size: 12px; }
.detail :deep(.fm) { color: #888; }
</style>
