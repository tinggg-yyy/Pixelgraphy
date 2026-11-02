// ── 滤镜 ─────────────────────────────────────────────
// 都是在画好的整张图上做后期：虚焦、晕染 / 加深、颗粒、RGB 错位、色调；闪粉是单独的开关，能叠在任何滤镜上。
// 全用 Canvas 2D 的混合模式，不逐像素算，所以画板每帧都能实时套滤镜，和导出的一模一样。
// 所有尺寸按「图宽的几分之几」算（u = 宽 / 1024），屏幕和 1024 的导出图看起来比例一致。

// grain 可以叠好几层：type 是噪点种类，a 是透明度，mode 是混合模式
// bleed 是把模糊后的副本叠回去：默认按墨色深浅自动用 multiply / screen；
// mode: "color-burn" 是「加深」—— 中间调被烧得更深更艳（灼烧那几款靠这个）；
// lift 先把模糊副本往白提一点（0～1），浅色的底就几乎不被烧，只烧字和阴影
const PINK_BLUE = ["#ff8ae0", "#7d8dff", "#b9a4ff", "#ffffff"];
const FILTERS = {
  none: {},
  // 图 1：轻微虚焦 + 发灰 + 墨色晕开
  soft: {
    blur: 1.8, bleed: { r: 7, a: 0.4 }, wash: 0.16,
    grain: [{ type: "mono", a: 0.12, mode: "overlay" }],
  },
  // 图 2：粉蓝彩色颗粒 + 渐变色调 + 字边晕开
  dreamy: {
    blur: 1, bleed: { r: 5, a: 0.45 },
    tint: { from: "#ff7ad9", to: "#6f8cff", a: 0.4 },
    grain: [
      { type: "color", a: 0.2, mode: "source-over", colors: PINK_BLUE },
      { type: "mono", a: 0.25, mode: "overlay" },
    ],
  },
  // 图 4：胶片颗粒 + 虚焦 + 轻微色差
  film: {
    blur: 1.6, shift: 1.5, bleed: { r: 4, a: 0.3 },
    grain: [{ type: "mono", a: 0.32, mode: "overlay" }],
  },
  // 图 5：强烈红 / 青错位 + 虚焦 + 斑驳纹理
  rgb: {
    blur: 1.8, shift: 5,
    grain: [
      { type: "mottle", a: 0.22, mode: "overlay", scale: 2 },
      { type: "mono", a: 0.18, mode: "overlay" },
    ],
  },
  // 灼烧：中间调烧成饱和的深色（蓝墨 + 粉阴影 → 红橙），底色基本不动 + 细彩色颗粒
  burn: {
    blur: 1, bleed: { r: 2.5, a: 0.85, mode: "color-burn", lift: 0.55 },
    grain: [
      { type: "color", a: 0.14, mode: "soft-light", colors: PINK_BLUE },
      { type: "mono", a: 0.16, mode: "overlay" },
    ],
  },
  // 柔烧：加深 + 更重的虚焦，整体更朦胧
  softburn: {
    blur: 2, bleed: { r: 5, a: 0.6, mode: "color-burn", lift: 0.5 },
    grain: [
      { type: "color", a: 0.12, mode: "soft-light", colors: PINK_BLUE },
      { type: "mono", a: 0.22, mode: "overlay" },
    ],
  },
  // 烧错位：加深 + RGB 错位 + 粉蓝斑驳
  burnshift: {
    blur: 1.4, shift: 4, bleed: { r: 2.5, a: 0.8, mode: "color-burn", lift: 0.5 },
    grain: [
      { type: "mottle", a: 0.4, mode: "soft-light", scale: 1.5, colors: ["#ff7fb0", "#7fb0ff"] },
      { type: "mono", a: 0.2, mode: "overlay" },
    ],
  },
};

// 固定种子的随机数：噪点每帧、每次导出都一样，不会闪
function _rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// 临时画布按名字复用，避免每帧新建
const _scratch = {};
function _tmp(name, w, h) {
  let c = _scratch[name];
  if (!c) c = _scratch[name] = _canvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  return [c, ctx];
}

// 噪点贴图（256×256，平铺）。mono 灰度颗粒 / color 彩色颗粒 / mottle 云团斑驳（给 colors 就是彩色斑驳）
const _noiseCache = {};
function _noiseTile(grain) {
  const key = grain.type + (grain.colors || []).join();
  if (_noiseCache[key]) return _noiseCache[key];
  const S = 256;
  const c = _canvas(S, S);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const rand = _rng(20261102);
  const cols = (grain.colors || []).map(_hexToRgb);
  for (let i = 0; i < S * S; i++) {
    const p = i * 4;
    if (grain.type === "mono") {
      const v = rand() * 255;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    } else if (grain.type === "color") {
      const [r, g, b] = cols[Math.floor(rand() * cols.length)];
      const v = 0.6 + rand() * 0.6;
      d[p] = r * v;
      d[p + 1] = g * v;
      d[p + 2] = b * v;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (grain.type === "mottle") {
    // 斑驳：先撒一层小噪点，分几步放大（一步放大会出方块），糊成一团一团的云
    let prev = _canvas(48, 48);
    const pctx = prev.getContext("2d");
    const simg = pctx.createImageData(48, 48);
    for (let i = 0; i < 48 * 48; i++) {
      const p = i * 4;
      if (cols.length) {
        const [r, g, b] = cols[Math.floor(rand() * cols.length)];
        simg.data[p] = r;
        simg.data[p + 1] = g;
        simg.data[p + 2] = b;
      } else simg.data[p] = simg.data[p + 1] = simg.data[p + 2] = rand() * 255;
      simg.data[p + 3] = 255;
    }
    pctx.putImageData(simg, 0, 0);
    for (const step of [96, 192]) {
      const next = _canvas(step, step);
      const nctx = next.getContext("2d");
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = "high";
      nctx.drawImage(prev, 0, 0, step, step);
      prev = next;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(prev, 0, 0, S, S);
    // 再叠一层细颗粒
    ctx.globalAlpha = 0.35;
    const fine = _noiseTile({ type: "mono" });
    ctx.drawImage(fine, 0, 0);
    ctx.globalAlpha = 1;
  }
  return (_noiseCache[key] = c);
}

// 闪粉：1024×1024 上只撒七八十个发白的柔边小光点（导出图正好一张，不会看出重复）
let _sparkleCanvas = null;
function _sparkleTile() {
  if (_sparkleCanvas) return _sparkleCanvas;
  const S = 1024;
  const c = (_sparkleCanvas = _canvas(S, S));
  const ctx = c.getContext("2d");
  const rand = _rng(7031);
  for (let i = 0; i < 75; i++) {
    const x = rand() * S, y = rand() * S;
    const r = 2 + rand() * 5;
    const a = 0.25 + rand() * 0.45;
    const tone = rand() < 0.6 ? "255,255,255" : "215,245,255"; // 大多纯白，少数微微偏青
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tone},${a})`);
    g.addColorStop(0.4, `rgba(${tone},${a * 0.5})`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

// ctx.filter 的 blur 最快，但旧版 Safari 不支持；不支持就用「缩小再放大」糊一下
const _hasCtxFilter = (() => {
  const ctx = _canvas(1, 1).getContext("2d");
  if (!("filter" in ctx)) return false;
  ctx.filter = "blur(1px)";
  return ctx.filter === "blur(1px)";
})();

// 把 src 模糊 r 像素后画到 ctx 上（ctx 的混合模式 / 透明度由调用方设好）
function _drawBlurred(ctx, src, r) {
  const w = src.width, h = src.height;
  if (r < 0.5) return ctx.drawImage(src, 0, 0);
  if (_hasCtxFilter) {
    const prev = ctx.filter;
    ctx.filter = `blur(${r}px)`;
    ctx.drawImage(src, 0, 0);
    ctx.filter = prev;
    return;
  }
  const f = Math.max(1, r * 1.5);
  const [s, sctx] = _tmp("blurSmall", Math.max(1, Math.round(w / f)), Math.max(1, Math.round(h / f)));
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, 0, 0, s.width, s.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(s, 0, 0, w, h);
}

// 取出一个颜色通道（color 是 "#ff0000" 这种），保留原来的透明度
function _channel(name, src, color) {
  const [c, ctx] = _tmp(name, src.width, src.height);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(src, 0, 0);
  return c;
}

// 墨色比底色深 → 晕染用 multiply 往深里晕；夜间这类浅墨深底 → 用 screen 往亮里晕
function _inkIsDark() {
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  return lum(_hexToRgb(currentTheme.ink)) < lum(_hexToRgb(currentTheme.bg));
}

// 在 canvas 上原地套滤镜（按物理像素算，不管 p5 的缩放）；sparkle 为 true 时再撒一层闪粉
function applyFilter(canvas, id, sparkle = false) {
  const f = FILTERS[id] || {};
  if ((id === "none" || !FILTERS[id]) && !sparkle) return;
  const w = canvas.width, h = canvas.height;
  const u = w / 1024;
  const out = canvas.getContext("2d");
  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.shadowColor = "rgba(0,0,0,0)";
  out.globalAlpha = 1;
  out.globalCompositeOperation = "source-over";

  // 原图先拷一份
  const [src, sctx] = _tmp("src", w, h);
  sctx.drawImage(canvas, 0, 0);

  // RGB 错位：红往右、蓝往左。先在原位垫一层同通道，错开后边上不会露出一条缺色的边
  if (f.shift) {
    const dx = Math.max(1, Math.round(f.shift * u));
    const r = _channel("chR", src, "#ff0000");
    const g = _channel("chG", src, "#00ff00");
    const b = _channel("chB", src, "#0000ff");
    const [rb, rbctx] = _tmp("chRB", w, h);
    rbctx.drawImage(r, 0, 0);
    rbctx.drawImage(r, dx, 0);
    const [bb, bbctx] = _tmp("chBB", w, h);
    bbctx.drawImage(b, 0, 0);
    bbctx.drawImage(b, -dx, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(rb, 0, 0);
    sctx.globalCompositeOperation = "lighter";
    sctx.drawImage(g, 0, 0);
    sctx.drawImage(bb, 0, 0);
    sctx.globalCompositeOperation = "source-over";
  }

  out.clearRect(0, 0, w, h);
  // 虚焦：原图垫底（边缘不会被糊透明），模糊版盖上去
  out.drawImage(src, 0, 0);
  if (f.blur) _drawBlurred(out, src, f.blur * u);

  // 晕染：大半径模糊的副本叠回去
  if (f.bleed) {
    let copy = src;
    if (f.bleed.lift) {
      const [lc, lctx] = _tmp("lift", w, h);
      _drawBlurred(lctx, src, f.bleed.r * u);
      lctx.globalCompositeOperation = "source-atop";
      lctx.globalAlpha = f.bleed.lift;
      lctx.fillStyle = "#fff";
      lctx.fillRect(0, 0, w, h);
      copy = lc;
    }
    out.globalAlpha = f.bleed.a;
    out.globalCompositeOperation = f.bleed.mode || (_inkIsDark() ? "multiply" : "screen");
    if (copy === src) _drawBlurred(out, src, f.bleed.r * u);
    else out.drawImage(copy, 0, 0);
    out.globalAlpha = 1;
    out.globalCompositeOperation = "source-over";
  }

  // 后面这些只叠在有画的地方（透明底导出时不往透明处撒颗粒）
  const atop = "source-atop";

  // 发灰：盖一层半透明底色，对比度降下来
  if (f.wash) {
    out.globalCompositeOperation = atop;
    out.globalAlpha = f.wash;
    out.fillStyle = currentTheme.bg;
    out.fillRect(0, 0, w, h);
  }

  // 色调：左上到右下的渐变
  if (f.tint) {
    const grad = out.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, f.tint.from);
    grad.addColorStop(1, f.tint.to);
    out.globalCompositeOperation = "soft-light";
    out.globalAlpha = f.tint.a;
    out.fillStyle = grad;
    out.fillRect(0, 0, w, h);
  }

  // 颗粒（一层一层叠）
  for (const grain of f.grain || []) {
    const pat = out.createPattern(_noiseTile(grain), "repeat");
    const scale = (grain.scale || 1) * u;
    pat.setTransform?.(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
    out.globalCompositeOperation = grain.mode;
    out.globalAlpha = grain.a;
    out.fillStyle = pat;
    out.fillRect(0, 0, w, h);
  }

  // 闪粉：最后撒，叠在所有效果上面
  if (sparkle) {
    const pat = out.createPattern(_sparkleTile(), "repeat");
    pat.setTransform?.(new DOMMatrix([u, 0, 0, u, 0, 0]));
    out.globalCompositeOperation = "screen";
    out.globalAlpha = 1;
    out.fillStyle = pat;
    out.fillRect(0, 0, w, h);
  }

  // soft-light / overlay / screen 会改到透明区域，最后按原图的透明度裁一下
  out.globalAlpha = 1;
  out.globalCompositeOperation = "destination-in";
  out.drawImage(src, 0, 0);
  out.restore();
}

// ── 屏幕上的滤镜 ─────────────────────────────────────
// 屏幕上要连 CSS 画的画框一起套滤镜，canvas 管不到画框，所以套在包着画框的元素上，拆成两部分：
//   模糊 / 晕染 / RGB 错位 → SVG 滤镜，用 CSS filter: url(#…) 套在这个元素上
//   发灰 / 色调 / 颗粒 / 闪粉 → 在它外面（父元素里）盖一层图层（不挡画画），用 mix-blend-mode 叠。
//                              不能放进被滤镜的元素里，不然颗粒会先被加深 / 模糊，和导出的顺序不一样
// 噪点贴图和 canvas 导出用的是同一张。unit = 画布在屏幕上的宽度 / 1024，看起来和导出的 1024 图比例一样。

const _CSS_BLEND = { "source-over": "normal", lighter: "plus-lighter" };
const _tileURL = {};

function _svgFilter(f, unit) {
  const parts = [];
  let last = "SourceGraphic";
  if (f.shift) {
    const dx = (f.shift * unit).toFixed(2);
    // 每个通道都先当成不透明来拆、来加（不然三份透明度加起来，半透明的地方会被叠深），最后再按原透明度裁
    const only = (r, g, b) => `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 0 1`;
    parts.push(
      `<feColorMatrix in="${last}" values="${only(1, 0, 0)}" result="r0"/>`,
      `<feOffset in="r0" dx="${dx}" result="r"/>`,
      `<feColorMatrix in="${last}" values="${only(0, 1, 0)}" result="g"/>`,
      `<feColorMatrix in="${last}" values="${only(0, 0, 1)}" result="b0"/>`,
      `<feOffset in="b0" dx="-${dx}" result="b"/>`,
      `<feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>`,
      `<feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" result="shifted0"/>`,
      `<feComposite in="shifted0" in2="SourceAlpha" operator="in" result="shifted"/>`
    );
    last = "shifted";
  }
  if (f.blur) {
    parts.push(`<feGaussianBlur in="${last}" stdDeviation="${(f.blur * unit).toFixed(2)}" result="blurred"/>`);
    last = "blurred";
  }
  if (f.bleed) {
    const a = f.bleed.a;
    parts.push(
      `<feGaussianBlur in="${last}" stdDeviation="${(f.bleed.r * unit).toFixed(2)}" result="big0"/>`,
      // lift：每个通道 c → c·(1-lift) + lift，往白提
      `<feComponentTransfer in="big0" result="big">${["R", "G", "B"]
        .map((ch) => `<feFunc${ch} type="linear" slope="${1 - (f.bleed.lift || 0)}" intercept="${f.bleed.lift || 0}"/>`)
        .join("")}</feComponentTransfer>`,
      `<feBlend in="big" in2="${last}" mode="${f.bleed.mode || (_inkIsDark() ? "multiply" : "screen")}" result="bled"/>`,
      `<feComposite in="bled" in2="${last}" operator="arithmetic" k2="${a}" k3="${1 - a}" result="bleedOut"/>`
    );
    last = "bleedOut";
  }
  return parts.join("");
}

function applyScreenFilter(el, id, unit, sparkle = false) {
  const f = FILTERS[id] || {};
  let svg = document.getElementById("fx-svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "fx-svg";
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    document.body.appendChild(svg);
  }
  let overlay = document.getElementById("fx-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "fx-overlay";
    el.parentElement.appendChild(overlay);
  }

  const fe = _svgFilter(f, unit);
  // 每次换一个 id，Safari 才会认新的滤镜内容
  const fid = `fx-${id}-${Date.now()}`;
  svg.innerHTML = fe
    ? `<filter id="${fid}" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">${fe}</filter>`
    : "";
  el.style.filter = fe ? `url(#${fid})` : "";

  overlay.innerHTML = "";
  const layer = (css) => {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;inset:0;${css}`;
    overlay.appendChild(d);
  };
  if (f.wash) layer(`background:${currentTheme.bg};opacity:${f.wash}`);
  if (f.tint)
    layer(`background:linear-gradient(to bottom right, ${f.tint.from}, ${f.tint.to});mix-blend-mode:soft-light;opacity:${f.tint.a}`);
  for (const grain of f.grain || []) {
    const key = grain.type + (grain.colors || []).join();
    const url = (_tileURL[key] ||= _noiseTile(grain).toDataURL());
    const size = 256 * (grain.scale || 1) * unit;
    layer(
      `background-image:url(${url});background-size:${size}px ${size}px;` +
        `mix-blend-mode:${_CSS_BLEND[grain.mode] || grain.mode};opacity:${grain.a}`
    );
  }
  if (sparkle) {
    _tileURL.sparkle ||= _sparkleTile().toDataURL();
    const size = 1024 * unit;
    layer(`background-image:url(${_tileURL.sparkle});background-size:${size}px ${size}px;mix-blend-mode:screen`);
  }
}

// ── 故障 ─────────────────────────────────────────────
// 和闪粉一样是单独的开关，能叠在任何滤镜上。先在画面上做故障，再套滤镜。
// 位置、宽度都按画面比例算，种子固定：屏幕上看到的和导出的是同一套故障
function applyGlitch(canvas, seed) {
  const W = canvas.width, H = canvas.height;
  const r = _rng(seed);
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // 1. 错位条：横着切几条，左右挪开，挪出去的部分从另一边绕回来
  const [snap, sctx] = _tmp("glitchSnap", W, H);
  sctx.drawImage(canvas, 0, 0);
  const shifts = 5 + Math.floor(r() * 4);
  for (let i = 0; i < shifts; i++) {
    const h = Math.max(1, Math.round(H * (0.008 + r() * 0.05)));
    const y = Math.round(r() * (H - h));
    const dir = r() < 0.5 ? -1 : 1;
    const dx = Math.round(dir * W * (0.01 + r() * 0.06));
    ctx.clearRect(0, y, W, h);
    ctx.drawImage(snap, 0, y, W, h, dx, y, W, h);
    ctx.drawImage(snap, 0, y, W, h, dx - dir * W, y, W, h);
  }

  // 2. 色偏条：几条里红、青通道往两边分开
  const splits = 2 + Math.floor(r() * 2);
  for (let i = 0; i < splits; i++) {
    const h = Math.max(2, Math.round(H * (0.02 + r() * 0.06)));
    const y = Math.round(r() * (H - h));
    const d = Math.max(1, Math.round(W * (0.004 + r() * 0.01)));
    const [band, bctx] = _tmp("glitchBand", W, h);
    bctx.drawImage(canvas, 0, y, W, h, 0, 0, W, h);
    const red = _channel("glitchR", band, "#ff0000");
    const cyan = _channel("glitchC", band, "#00ffff");
    ctx.clearRect(0, y, W, h);
    ctx.globalCompositeOperation = "lighter";
    // 和错位条一样从另一边绕回来，不然左右边缘只剩一个通道，露出纯红 / 纯青的竖块
    ctx.drawImage(red, d, y);
    ctx.drawImage(red, d - W, y);
    ctx.drawImage(cyan, -d, y);
    ctx.drawImage(cyan, W - d, y);
    ctx.globalCompositeOperation = "source-over";
  }

  // 3. 几根细亮线
  const lines = 2 + Math.floor(r() * 3);
  const colors = ["#ffffff", "#5ff6ff", "#ff4fd8"];
  for (let i = 0; i < lines; i++) {
    const lh = Math.max(1, Math.round(H * (0.0015 + r() * 0.002)));
    const x = Math.round(r() * W * 0.6);
    const w = Math.round(W * (0.2 + r() * 0.5));
    ctx.globalAlpha = 0.45 + r() * 0.25;
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.fillRect(x, Math.round(r() * H), w, lh);
  }
  ctx.restore();
}
