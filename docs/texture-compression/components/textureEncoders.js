// textureEncoders.js — 教学纹理编码器（纯 JS，无依赖）
// ETC1 / BC1：全真 bitstream（与配套 Python 对拍一致）
// ASTC（4x4/5x5/6x6）：教学简化但【合法】bitstream（官方 astcenc 可解；端点=bbox，非最优）
// 全部 64/128bit 位流用 BigInt（JS 位运算仅 32bit）
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const b = (n) => BigInt(n);
const B = (n) => 1n << b(n);
// Python round() = 银行家舍入（.5 取偶数）；JS Math.round 是四舍五入 → 两者决策会系统性不同
const pyround = (x) => { const f = Math.floor(x); const d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return f % 2 === 0 ? f : f + 1; };

// ============ ETC1 ============
const ETC1_MOD = [[2,8,-2,-8],[5,17,-5,-17],[9,29,-9,-29],[13,42,-13,-42],
                  [18,60,-18,-60],[24,80,-24,-80],[33,106,-33,-106],[47,183,-47,-183]];
const extend4 = x => ((x << 4) | x) & 255;
const extend5 = x => ((x << 3) | (x >> 2)) & 255;
const LK = i => (i >= 4 ? i - 8 : i);

export function etc1EncodeBlock(px) {
  let best = null;
  for (let flip = 0; flip < 2; flip++) {
    const sub = (x, y) => (flip ? (y >= 2 ? 1 : 0) : (x >= 2 ? 1 : 0));
    const avg = [[0,0,0],[0,0,0]], cnt = [0,0];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
      const s = sub(x,y), o = (y*4+x)*3;
      for (let c = 0; c < 3; c++) avg[s][c] += px[o+c];
      cnt[s]++;
    }
    for (let s = 0; s < 2; s++) for (let c = 0; c < 3; c++) avg[s][c] = pyround(avg[s][c]/cnt[s]);
    const base555 = [0,0,0].map((_,c) => clamp(pyround(avg[0][c]/8), 0, 31));
    const dl = [0,0,0];
    for (let c = 0; c < 3; c++) {
      let bd = 0, be = Infinity;
      for (let d = -4; d <= 3; d++) {
        const v = base555[c]+d;
        if (v < 0 || v > 31) continue;
        const e = (extend5(v)-avg[1][c])**2;
        if (e < be) { be = e; bd = d; }
      }
      dl[c] = bd;
    }
    const base2_555 = [0,1,2].map(c => base555[c]+dl[c]);
    const q1 = [0,1,2].map(c => clamp(pyround(avg[0][c]/17), 0, 15));
    const q2 = [0,1,2].map(c => clamp(pyround(avg[1][c]/17), 0, 15));
    for (const mode of ['diff','ind']) {
      const c1 = mode==='diff' ? base555.map(extend5) : q1.map(extend4);
      const c2 = mode==='diff' ? base2_555.map(extend5) : q2.map(extend4);
      for (let tb1 = 0; tb1 < 8; tb1++) for (let tb2 = 0; tb2 < 8; tb2++) {
        const m1 = ETC1_MOD[tb1], m2 = ETC1_MOD[tb2];
        const idxs = new Uint8Array(16);
        let mse = 0;
        for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
          const s = sub(x,y), o = (y*4+x)*3;
          const cs = s===0 ? c1 : c2, ms = s===0 ? m1 : m2;
          let bi = 0, be = Infinity;
          for (let k = 0; k < 4; k++) {
            const e = (clamp(cs[0]+ms[k],0,255)-px[o])**2 + (clamp(cs[1]+ms[k],0,255)-px[o+1])**2 + (clamp(cs[2]+ms[k],0,255)-px[o+2])**2;
            if (e < be) { be = e; bi = k; }
          }
          idxs[y*4+x] = bi; mse += be;
        }
        mse /= 48;
        if (!best || mse < best[0]) {
          best = [mse, {flip, mode, tb1, tb2,
            base1q: mode==='diff' ? base555.slice() : q1.slice(),
            base2q: mode==='diff' ? base2_555.slice() : q2.slice(),
            dl: mode==='diff' ? dl.slice() : null,
            base1: c1.slice(), base2: c2.slice()}, idxs.slice()];
        }
      }
    }
  }
  const [mse, info, idxs] = best;
  let w = 0n;
  if (info.mode === 'diff') {
    w = b(info.base1q[0]&31)<<59n | b(info.dl[0]&7)<<56n | b(info.base1q[1]&31)<<51n | b(info.dl[1]&7)<<48n
      | b(info.base1q[2]&31)<<43n | b(info.dl[2]&7)<<40n;
  } else {
    w = b(info.base1q[0]&15)<<60n | b(info.base2q[0]&15)<<56n | b(info.base1q[1]&15)<<52n | b(info.base2q[1]&15)<<48n
      | b(info.base1q[2]&15)<<44n | b(info.base2q[2]&15)<<40n;
  }
  w |= b(info.tb1&7)<<37n | b(info.tb2&7)<<34n | b(info.mode==='diff'?1:0)<<33n | b(info.flip&1)<<32n;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const bit = y + x*4, v = BigInt(idxs[y*4+x]);
    w &= ~(B(bit) | B(16+bit));
    w |= ((v>>1n)&1n)<<b(16+bit) | (v&1n)<<b(bit);
  }
  return { w, info, mse, idxs };
}
export function etc1DecodeBlock(w) {
  const flip = Number((w>>32n)&1n), diff = Number((w>>33n)&1n);
  let c1, c2;
  if (diff) {
    const b1 = [Number((w>>59n)&31n), Number((w>>51n)&31n), Number((w>>43n)&31n)];
    const d = [LK(Number((w>>56n)&7n)), LK(Number((w>>48n)&7n)), LK(Number((w>>40n)&7n))];
    const b2 = b1.map((v,i) => clamp(v+d[i], 0, 31));
    c1 = b1.map(extend5); c2 = b2.map(extend5);
  } else {
    c1 = [extend4(Number((w>>60n)&15n)), extend4(Number((w>>52n)&15n)), extend4(Number((w>>44n)&15n))];
    c2 = [extend4(Number((w>>56n)&15n)), extend4(Number((w>>48n)&15n)), extend4(Number((w>>40n)&15n))];
  }
  const tb1 = Number((w>>37n)&7n), tb2 = Number((w>>34n)&7n);
  const out = new Uint8ClampedArray(48);
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const bit = y + x*4;
    const idx = (Number((w>>b(16+bit))&1n)<<1) | Number((w>>b(bit))&1n);
    const s = flip ? (y>=2?1:0) : (x>=2?1:0);
    const cs = s===0 ? c1 : c2, ms = s===0 ? ETC1_MOD[tb1] : ETC1_MOD[tb2];
    const o = (y*4+x)*3, m = ms[idx];
    out[o] = clamp(cs[0]+m,0,255); out[o+1] = clamp(cs[1]+m,0,255); out[o+2] = clamp(cs[2]+m,0,255);
  }
  return out;
}

// ============ BC1 (DXT1, 4-color mode) ============
const to565 = ([r,g,b]) => ((r>>3)<<11)|((g>>2)<<5)|(b>>3);
const from565 = v => [((v>>11)&31)<<3|((v>>11)&31)>>2, ((v>>5)&63)<<2|((v>>5)&63)>>4, (v&31)<<3|(v&31)>>2];
export function bc1EncodeBlock(px) {
  let best = null;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    if (i === j) continue;
    let c0 = to565([px[i*3],px[i*3+1],px[i*3+2]]), c1 = to565([px[j*3],px[j*3+1],px[j*3+2]]);
    if (c0 <= c1) { const t = c0; c0 = c1; c1 = t; }
    const ca = from565(c0), cb = from565(c1);
    const cands = [ca, cb, ca.map((v,k)=>Math.round(v+(cb[k]-v)/3)), ca.map((v,k)=>Math.round(v+(cb[k]-v)*2/3))];
    const idxs = new Uint8Array(16);
    let mse = 0;
    for (let p = 0; p < 16; p++) {
      let bi = 0, be = Infinity;
      for (let k = 0; k < 4; k++) {
        const e = (cands[k][0]-px[p*3])**2 + (cands[k][1]-px[p*3+1])**2 + (cands[k][2]-px[p*3+2])**2;
        if (e < be) { be = e; bi = k; }
      }
      idxs[p] = bi; mse += be;
    }
    if (!best || mse < best[0]) best = [mse, c0, c1, idxs.slice()];
  }
  const [mse, c0, c1, idxs] = best;
  let w = b(c0) | b(c1)<<16n;
  for (let k = 0; k < 16; k++) w |= b(idxs[k]) << b(2*k+32);
  return { w, mse: mse/48, endpoints: [from565(c0), from565(c1)] };
}
export function bc1DecodeBlock(w) {
  const c0 = Number(w & 0xFFFFn), c1 = Number((w>>16n) & 0xFFFFn);
  const ca = from565(c0), cb = from565(c1);
  const cands = [ca, cb, ca.map((v,k)=>Math.round(v+(cb[k]-v)/3)), ca.map((v,k)=>Math.round(v+(cb[k]-v)*2/3))];
  const out = new Uint8ClampedArray(48);
  for (let k = 0; k < 16; k++) {
    const idx = Number((w >> b(2*k+32)) & 3n);
    out[k*3] = cands[idx][0]; out[k*3+1] = cands[idx][1]; out[k*3+2] = cands[idx][2];
  }
  return out;
}

// ============ ASTC 教学（合法 bitstream） ============
const ASTC_FP = {
  '4x4': { fx:4, fy:4, gx:4, gy:4, bm: 83n },
  '5x5': { fx:5, fy:5, gx:5, gy:5, bm: 243n },
  '6x6': { fx:6, fy:6, gx:5, gy:5, bm: 243n },
};
export function astcTeachEncodeBlock(px, fpKey) {
  const { fx, fy, gx, gy, bm } = ASTC_FP[fpKey];
  const n = fx*fy;
  const pix = [];
  for (let p = 0; p < n; p++) pix.push([px[p*3], px[p*3+1], px[p*3+2]]);
  const cmin = [255,255,255], cmax = [0,0,0];
  for (const p of pix) for (let c = 0; c < 3; c++) {
    cmin[c] = Math.min(cmin[c], p[c]); cmax[c] = Math.max(cmax[c], p[c]);
  }
  if ((cmax[0]+cmax[1]+cmax[2]) - (cmin[0]+cmin[1]+cmin[2]) < 24) {
    const avg = [0,0,0];
    for (const p of pix) { avg[0]+=p[0]; avg[1]+=p[1]; avg[2]+=p[2]; }
    for (let c = 0; c < 3; c++) { const a = Math.round(avg[c]/n); cmin[c] = a; cmax[c] = a; }
  }
  const span = cmax.map((v,c) => Math.max(1, v - cmin[c]));
  const den = span[0]*span[0]+span[1]*span[1]+span[2]*span[2];
  const tOf = p => clamp(((p[0]-cmin[0])*span[0] + (p[1]-cmin[1])*span[1] + (p[2]-cmin[2])*span[2])/den, 0, 1);
  const gw = [];
  for (let gy_ = 0; gy_ < gy; gy_++) for (let gx_ = 0; gx_ < gx; gx_++) {
    let idx;
    if (gx === fx && gy === fy) idx = gy_*fx + gx_;
    else {
      const ty = Math.round(gy_*(fy-1)/Math.max(1, gy-1));
      const tx = Math.round(gx_*(fx-1)/Math.max(1, gx-1));
      idx = ty*fx + tx;
    }
    gw.push(Math.round(tOf(pix[idx])*7));
  }
  let v = 0n;
  for (let j = 0; j < gx*gy; j++) for (let qb = 0; qb < 3; qb++) v |= b((gw[j]>>qb)&1) << b(127-(j*3+qb));
  v |= bm | 8n<<13n;
  const nvals = 6, cb = 111 - gx*gy*3;
  let ebits = 0;
  for (let eb = 8; eb >= 1; eb--) if (nvals*eb <= cb) { ebits = eb; break; }
  const maxq = (1<<ebits)-1;
  let pos = 17n;
  for (let c = 0; c < 3; c++) for (const val of [cmin[c], cmax[c]]) {
    const q = Math.round(val*maxq/255);
    for (let eb = 0; eb < ebits; eb++) v |= b((q>>eb)&1) << pos++;
  }
  return { w: v, cmin, cmax, gw, ebits, cb };
}
export function astcTeachDecodeBlock(blk, fpKey) {
  const { fx, fy, gx, gy } = ASTC_FP[fpKey];
  const out = new Uint8ClampedArray(fx*fy*4);
  for (let y = 0; y < fy; y++) for (let x = 0; x < fx; x++) {
    let idx;
    if (gx === fx && gy === fy) idx = y*gx + x;
    else {
      const gy_ = Math.round(y*(gy-1)/Math.max(1, fy-1));
      const gx_ = Math.round(x*(gx-1)/Math.max(1, fx-1));
      idx = gy_*gx + gx_;
    }
    const t = blk.gw[idx]/7;
    const o = (y*fx+x)*4;
    for (let c = 0; c < 3; c++) out[o+c] = clamp(Math.round(blk.cmin[c] + (blk.cmax[c]-blk.cmin[c])*t), 0, 255);
    out[o+3] = 255;
  }
  return out;
}

// ============ 全图编码 ============
export function encodeImage(rgba, W, H, format) {
  const bs = format === 'etc1' || format === 'bc1' ? 4 : parseInt(format.slice(4), 10);
  const blocks = [];
  const dec = new Uint8ClampedArray(W*H*4);
  const bpr = Math.ceil(W/bs), bpc = Math.ceil(H/bs);
  let bytes = 0, mseSum = 0;
  const modeCount = {};
  for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpr; bx++) {
    const px = [];
    for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
      const xx = Math.min(bx*bs+x, W-1), yy = Math.min(by*bs+y, H-1), o = (yy*W+xx)*4;
      px.push(rgba[o], rgba[o+1], rgba[o+2]);
    }
    let blk, decBlk;
    if (format === 'etc1') { blk = etc1EncodeBlock(px); decBlk = etc1DecodeBlock(blk.w); }
    else if (format === 'bc1') { blk = bc1EncodeBlock(px); decBlk = bc1DecodeBlock(blk.w); }
    else {
      const key = format === 'astc4' ? '4x4' : format === 'astc5' ? '5x5' : '6x6';
      blk = astcTeachEncodeBlock(px, key);
      decBlk = astcTeachDecodeBlock(blk, key);
    }
    for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
      const xx = bx*bs+x, yy = by*bs+y;
      if (xx >= W || yy >= H) continue;
      const o = (yy*W+xx)*4;
      const po = (y*bs+x) * ((format === 'etc1' || format === 'bc1') ? 3 : 4); // 解码块每像素通道数
      for (let c = 0; c < 3; c++) {
        const d = decBlk[po+c];
        dec[o+c] = d;
        const src = rgba[o+c];
        mseSum += (src-d)*(src-d);
      }
      dec[o+3] = 255;
    }
    bytes += (format === 'etc1' || format === 'bc1') ? 8 : 16;
    if (format === 'etc1') {
      const k = blk.info.mode + (blk.info.flip?'/f1':'/f0') + ':t' + blk.info.tb1 + blk.info.tb2;
      modeCount[k] = (modeCount[k]||0)+1;
    } else if (format === 'bc1') {
      modeCount['bc1 4色'] = (modeCount['bc1 4色']||0)+1;
    } else {
      const key = format === 'astc4' ? '4x4' : format === 'astc5' ? '5x5' : '6x6';
      modeCount[`astc ${key} · CEM8`] = (modeCount[`astc ${key} · CEM8`]||0)+1;
    }
    blocks.push({ bx, by, blk });
  }
  const mse = mseSum / (W*H*3);
  const psnr = mse > 0 ? 10*Math.log10(255*255/mse) : 99;
  const bpp = bytes*8/(W*H);
  return { blocks, dec, bytes, psnr, bpp, modeCount, mse };
}
