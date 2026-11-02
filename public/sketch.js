// Pixelgraphy —— N×N 像素画板（默认 32，可调）（从 Predate 的兽人形象画板拆出来）
// 画笔：同一格反复划过会逐级加深（4 级）；输入文字后画出来的是文字格子

let N = 32;
const N_MIN = 4, N_MAX = 128;
let tool = "brush";

let grid = [];
let currentText = "";

let history = []; // 每一笔的 diff 列表
let currentStroke = []; // 当前这笔中被修改的格子 {x, y, oldVal}
let strokeCells = new Set(); // 当前笔中已记录的格子，避免重复记录

// 阴影：偏移按「一格的几分之几」算，屏幕和导出的比例就一样；color 为 null 时跟着墨色走
const _SHADOW_KEY = "pixelgraphy_shadow";
const SHADOW_DEFAULT = { x: 0.2, y: 0.2, alpha: 0.6, color: null };
let shadow = { ...SHADOW_DEFAULT };
try {
  shadow = { ...SHADOW_DEFAULT, ...JSON.parse(localStorage.getItem(_SHADOW_KEY) || "{}") };
} catch (_) {}

function shadowCSS() {
  const [r, g, b] = shadow.color ? _hexToRgb(shadow.color) : themeInkRGB();
  return `rgba(${r},${g},${b},${shadow.alpha})`;
}

const PIXEL_ALPHA = { 1: 65, 2: 125, 3: 190, 4: 255 };
const TEXT_ALPHA = { "#1": 65, "#2": 125, "#3": 190, "#4": 255 };

// 电脑 / iPad 横屏：三栏布局（和 style.css 里的媒体查询一致）
const WIDE_QUERY = "(min-width: 900px) and (orientation: landscape)";

function canvasSize() {
  const header = document.querySelector("header");
  const headerH = header?.offsetHeight || 60;
  if (window.matchMedia(WIDE_QUERY).matches) {
    // 画布竖向撑满一屏（减去上下留白 14+14、顶栏下间距 12、边框和外阴影 8），宽不超过中间那栏
    const col = document.getElementById("canvas-col");
    const colW = (col?.clientWidth || windowWidth - 400) - 8;
    return Math.floor(Math.max(200, Math.min(colW, windowHeight - headerH - 48)));
  }
  const tools = document.getElementById("tools");
  const left = document.getElementById("left-panel");
  const reserved = (tools?.offsetHeight || 140) + headerH + (left?.offsetHeight || 0) + 60;
  return Math.floor(Math.max(200, Math.min(windowWidth * 0.9, windowHeight - reserved, 640)));
}

function blankGrid() {
  const g = [];
  for (let y = 0; y < N; y++) {
    g[y] = [];
    for (let x = 0; x < N; x++) g[y][x] = "/";
  }
  return g;
}

function setup() {
  const s = canvasSize();
  const canvas = createCanvas(s, s);
  canvas.parent("p5-canvas-container");
  refreshPageFilter();
  attachPointerEvents(canvas.elt);
  grid = blankGrid();
}

// Zpix 的字形在字框里偏左上，按字框居中画出来会整体偏左、偏下（约 0.08 / 0.05 格）。
// 在一块小画布上真的画一个方块字，扫像素找出墨迹中心，返回要补的偏移（单位：画布坐标）。
// 不用 measureText：iOS Safari 在居中对齐时给的 actualBoundingBox 不可靠。
// 所有字用同一个偏移，「。」「g」这类字形本身的高低不受影响；按字号缓存，不会每帧都扫
const _textOffsetCache = new Map();
function textCenterOffset(ctx, pd) {
  const fontPx = parseFloat(ctx.font.match(/([\d.]+)px/)?.[1]) || 12;
  const key = `${fontPx}@${pd}`;
  if (_textOffsetCache.has(key)) return _textOffsetCache.get(key);
  if (!document.fonts.check(`${fontPx}px Zpix`)) return [0, 0]; // 字体还没加载好，先不补，也不缓存

  const size = Math.ceil(fontPx * pd * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const m = c.getContext("2d", { willReadFrequently: true });
  m.font = `${fontPx * pd}px Zpix`;
  m.textAlign = "center";
  m.textBaseline = "middle";
  m.fillStyle = "#000";
  m.fillText("国", size / 2, size / 2);
  const d = m.getImageData(0, 0, size, size).data;
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (d[(y * size + x) * 4 + 3] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const off = x1 < 0 ? [0, 0] : [(size - (x0 + x1 + 1)) / 2 / pd, (size - (y0 + y1 + 1)) / 2 / pd];
  _textOffsetCache.set(key, off);
  return off;
}

// 把整张格子画到任意 p5 画布上（屏幕上的画板 + 导出 PNG 共用）
function renderGrid(g, size, withShadow = true) {
  const cellSize = size / N;
  const ink = themeInkRGB();
  const ctx = g.drawingContext;

  // 多字文字：按行优先给文字格编号，循环分配字符
  const textCellIdx = {};
  if (currentText.length > 1) {
    let idx = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const c = grid[y][x];
        if (c === "text" || c === "#" || TEXT_ALPHA[c] !== undefined) textCellIdx[`${x},${y}`] = idx++;
      }
  }
  const charAt = (x, y) =>
    currentText.length > 1 ? currentText[(textCellIdx[`${x},${y}`] ?? 0) % currentText.length] : currentText;

  // canvas 的阴影偏移是物理像素，不跟着缩放走，所以要乘上像素密度（手机屏幕一般是 3）
  const pd = g.pixelDensity();
  const shadowColor = shadowCSS();
  const shadowOn = () => {
    if (!withShadow) return;
    ctx.shadowColor = shadowColor;
    ctx.shadowOffsetX = shadow.x * cellSize * pd;
    ctx.shadowOffsetY = shadow.y * cellSize * pd;
    ctx.shadowBlur = 0;
  };
  const shadowOff = () => (ctx.shadowColor = "rgba(0,0,0,0)");

  g.noStroke();
  g.textAlign(CENTER, CENTER);
  g.textSize(cellSize);
  g.textFont("Zpix");
  const [tx, ty] = textCenterOffset(ctx, pd);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = grid[y][x];
      const px = x * cellSize, py = y * cellSize;

      if (cell === "pixel" || cell === 4 || PIXEL_ALPHA[cell] !== undefined) {
        const a = cell === "pixel" ? 255 : PIXEL_ALPHA[cell];
        g.fill(...ink, a);
        shadowOn();
        g.rect(px, py, cellSize, cellSize);
        shadowOff();
      } else if (cell === "text" || cell === "#" || TEXT_ALPHA[cell] !== undefined) {
        const a = TEXT_ALPHA[cell] ?? 255;
        g.fill(...ink, a);
        shadowOn();
        g.text(charAt(x, y), px + cellSize / 2 + tx, py + cellSize / 2 + ty);
        shadowOff();
      } else if (cell !== null && cell !== "/") {
        g.fill(...ink, 255);
        shadowOn();
        g.text(cell, px + cellSize / 2 + tx, py + cellSize / 2 + ty);
        shadowOff();
      }
    }
  }
}

// 格子线（拓麻歌子 LCD 质感）
function renderCellLines(g, size, weight = 0.5) {
  const cellSize = size / N;
  g.stroke(...themeInkRGB(), 22);
  g.strokeWeight(weight);
  for (let i = 0; i <= N; i++) {
    g.line(i * cellSize, 0, i * cellSize, size);
    g.line(0, i * cellSize, size, i * cellSize);
  }
  g.noStroke();
}

// 只在画面可能变了的时候重画：滤镜每帧算很费电，画板不动时没必要重复算。
// 不在每个改格子的函数里手动标记，而是监听所有会改画面的交互（见 DOMContentLoaded 里），漏不掉
let dirty = true;
function markDirty() {
  dirty = true;
}

let currentFilter = "none";
let sparkleOn = false; // 闪粉：单独的开关，能叠在任何滤镜上
let glitchSeed = 0; // 故障：0 = 关；每次打开换一个种子，换一套故障
try {
  const saved = localStorage.getItem("pixelgraphy_filter");
  if (FILTERS[saved]) currentFilter = saved;
  sparkleOn = localStorage.getItem("pixelgraphy_sparkle") === "1";
  glitchSeed = Number(localStorage.getItem("pixelgraphy_glitch")) || 0;
} catch (_) {}

function setGlitch(on) {
  glitchSeed = on ? 1 + Math.floor(Math.random() * 1e9) : 0;
  try {
    localStorage.setItem("pixelgraphy_glitch", String(glitchSeed));
  } catch (_) {}
  markDirty();
}

function setSparkle(on) {
  sparkleOn = on;
  try {
    localStorage.setItem("pixelgraphy_sparkle", on ? "1" : "0");
  } catch (_) {}
  refreshPageFilter();
}

function setFilter(id) {
  if (!FILTERS[id]) return;
  currentFilter = id;
  try {
    localStorage.setItem("pixelgraphy_filter", id);
  } catch (_) {}
  refreshPageFilter();
  markDirty();
}

// 屏幕上滤镜套在画框（连框一起）上，导出时在导出图上整张套一遍
function refreshPageFilter() {
  applyScreenFilter(document.getElementById("p5-canvas-container"), currentFilter, width / 1024, sparkleOn);
}

function draw() {
  if (!dirty) return;
  dirty = false;
  // 画上底色（和画框的 CSS 底色一样），滤镜的颗粒、色调才能落在底上，和导出的一致
  background(themeBg());
  renderGrid(window, width);
  renderCellLines(window, width);
  if (glitchSeed) applyGlitch(drawingContext.canvas, glitchSeed);
}

// ── 工具 ─────────────────────────────────────────────

function setBrush() {
  tool = "brush";
  document.getElementById("brush-btn")?.classList.add("tool-active");
  document.getElementById("eraser-btn")?.classList.remove("tool-active");
}

function setEraser() {
  tool = "eraser";
  document.getElementById("eraser-btn")?.classList.add("tool-active");
  document.getElementById("brush-btn")?.classList.remove("tool-active");
}

function setClear() {
  const stroke = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (grid[y][x] !== "/") {
        stroke.push({ x, y, oldVal: grid[y][x] });
        grid[y][x] = "/";
      }
  if (stroke.length) history.push(stroke); // 清空也能撤销
}

function setUndo() {
  if (history.length === 0) return;
  const stroke = history.pop();
  for (const { x, y, oldVal } of stroke) grid[y][x] = oldVal;
}

// ── 画（鼠标、手指、触控笔都走 pointer 事件）────────────

let drawing = false;

// 在画布坐标 (mx, my) 所在的格子上画一下
function paintAt(mx, my) {
  const gx = floor((mx / width) * N);
  const gy = floor((my / height) * N);
  if (gx < 0 || gx >= N || gy < 0 || gy >= N) return;

  const cur = grid[gy][gx];
  let newVal = cur;

  if (tool === "brush") {
    if (currentText !== "") {
      // 文字模式：逐级加深
      if (cur === "/" || cur === null) newVal = "#1";
      else if (cur === "#1") newVal = "#2";
      else if (cur === "#2") newVal = "#3";
      else if (cur === "#3") newVal = "#4";
      else if (typeof cur === "number") newVal = `#${cur}`; // 已有像素格 → 同级文字格
    } else {
      // 像素模式：逐级加深
      if (cur === "/" || cur === null) newVal = 1;
      else if (cur === 1) newVal = 2;
      else if (cur === 2) newVal = 3;
      else if (cur === 3) newVal = 4;
    }
  } else if (tool === "eraser") {
    newVal = "/";
  }

  if (newVal !== cur) {
    const key = `${gx},${gy}`;
    if (!strokeCells.has(key)) {
      strokeCells.add(key);
      currentStroke.push({ x: gx, y: gy, oldVal: cur });
    }
    grid[gy][gx] = newVal;
  }
}


// 把屏幕坐标换算成画布坐标
function canvasXY(e, el) {
  const r = el.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
}

function endStroke() {
  if (!drawing) return;
  drawing = false;
  if (currentStroke.length > 0) history.push(currentStroke);
  currentStroke = [];
  strokeCells = new Set();
}

function attachPointerEvents(el) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button > 0) return; // 只认左键 / 手指
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    drawing = true;
    currentStroke = [];
    strokeCells = new Set();
    const { x, y } = canvasXY(e, el);
    paintAt(x, y);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    e.preventDefault();
    // 手指快速划过时浏览器会合并事件，把中间的点也取出来，线不会断
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const { x, y } = canvasXY(ev, el);
      if (x >= 0 && x <= width && y >= 0 && y <= height) paintAt(x, y);
    }
  });
  el.addEventListener("pointerup", endStroke);
  el.addEventListener("pointercancel", endStroke);
  el.addEventListener("lostpointercapture", endStroke);
  // 禁止长按弹出菜单 / iOS 放大镜
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// 改格子数：按最近邻把现在的画缩放到新尺寸（缩小会丢细节）；旧的撤销记录对不上新格子，清掉
function setGridSize(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return;
  n = Math.max(N_MIN, Math.min(N_MAX, n));
  const sizeInput = document.getElementById("grid-size");
  if (sizeInput) sizeInput.value = n;
  if (n === N) return;
  const old = grid, oldN = N;
  N = n;
  grid = blankGrid();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) grid[y][x] = old[Math.floor((y * oldN) / N)][Math.floor((x * oldN) / N)];
  history = [];
}

function windowResized() {
  const s = canvasSize();
  resizeCanvas(s, s);
  refreshPageFilter();
  markDirty();
}

// ── 文字 ─────────────────────────────────────────────

// 确认文字：把已有的像素格子转成同级别的文字格子
function drawText() {
  const input = document.getElementById("text-input").value.trim();
  currentText = input;
  if (input === "") return;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cell = grid[y][x];
      if (cell === "pixel" || cell === 4) grid[y][x] = "#4";
      else if (cell === 3) grid[y][x] = "#3";
      else if (cell === 2) grid[y][x] = "#2";
      else if (cell === 1) grid[y][x] = "#1";
    }
}

// ── 导出图片 ─────────────────────────────────────────

const EXPORT_FORMATS = {
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
};

// 手机 / 平板：走系统分享面板，里面有「存储图像 / 保存到相册」；电脑：直接下载文件
function canShareToAlbum(file) {
  return matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] });
}

// dataURL → Blob，同步完成（分享要在点击的同一时刻发起，iOS 才认）
function dataURLToBlob(url) {
  const [head, body] = url.split(",");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.match(/data:(.*?);/)[1] });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 样式：plain 纯色底 / framed 带框带格子（和 icon.png 一样）/ transparent 透明底 / framed-clear 带框透明底
// 格式：png / jpg / webp（jpg 没有透明，透明底会自动垫上底色）
function saveImage() {
  const S = 1024;
  const g = createGraphics(S, S);
  g.pixelDensity(1);
  const style = document.getElementById("export-style")?.value || "plain";
  const fmt = EXPORT_FORMATS[document.getElementById("export-format")?.value] || EXPORT_FORMATS.png;
  const transparent = (style === "transparent" || style === "framed-clear") && fmt.ext !== "jpg";
  if (style.startsWith("framed")) renderFramed(g, S, transparent);
  else {
    if (transparent) g.clear();
    else g.background(themeBg());
    renderGrid(g, S);
  }
  if (glitchSeed) applyGlitch(g.elt, glitchSeed);
  applyFilter(g.elt, currentFilter, sparkleOn);
  const blob = dataURLToBlob(g.elt.toDataURL(fmt.mime, 0.95));
  g.remove();

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  // 浏览器不支持的格式（比如部分 Safari 的 webp）会悄悄退回 png，按实际格式起名
  const ext = blob.type === fmt.mime ? fmt.ext : "png";
  const name = `pixelgraphy-${stamp}.${ext}`;
  const file = new File([blob], name, { type: blob.type });
  if (canShareToAlbum(file)) {
    navigator.share({ files: [file] }).catch((err) => {
      if (err.name !== "AbortError") downloadBlob(blob, name); // 用户取消就算了，其他失败退回下载
    });
  } else downloadBlob(blob, name);
}

// 带框样式：底色 + 细格纹，中间一个带阴影的画框，框里画格子线和画
// transparent 时去掉底色、细格纹和投影，只留框线、格子线和画
function renderFramed(g, S, transparent = false) {
  const k = S / 512; // 按 512 的设计稿等比放大
  const ink = themeInkRGB();
  const m = Math.round(12 * k); // 画框离边的距离
  const B = S - 2 * m;

  if (transparent) g.clear();
  else {
    g.background(themeBg());
    // 整张底上的细格纹（同页面背景，每 4px 一条）
    g.stroke(...ink, 18);
    g.strokeWeight(k * 0.5);
    for (let i = 0; i <= S; i += 4 * k) {
      g.line(i, 0, i, S);
      g.line(0, i, S, i);
    }
    g.noStroke();
    // 投影
    g.fill(...ink, 70);
    g.rect(m + 3 * k, m + 4 * k, B, B);
    // 框里的底色
    g.fill(themeBg());
    g.rect(m, m, B, B);
  }
  // 边框（外 1px + 内 2px，同页面画框）
  g.noFill();
  g.stroke(...ink, 128);
  g.strokeWeight(k);
  g.rect(m - k / 2, m - k / 2, B + k, B + k);
  g.stroke(...ink, 115);
  g.strokeWeight(2 * k);
  g.rect(m + k, m + k, B - 2 * k, B - 2 * k);
  g.noStroke();

  const pad = 3 * k;
  const inner = B - 2 * pad;
  g.push();
  g.translate(m + pad, m + pad);
  renderGrid(g, inner);
  renderCellLines(g, inner, k * 0.5);
  g.pop();
}

// ── 阴影设置 ─────────────────────────────────────────

function setShadow(patch) {
  Object.assign(shadow, patch);
  try {
    localStorage.setItem(_SHADOW_KEY, JSON.stringify(shadow));
  } catch (_) {}
  syncShadowInputs();
}

function resetShadow() {
  setShadow({ ...SHADOW_DEFAULT });
}

function syncShadowInputs() {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  set("shadow-x", shadow.x);
  set("shadow-y", shadow.y);
  set("shadow-alpha", shadow.alpha);
  set("shadow-color", shadow.color || currentTheme.ink);
  // 阴影按钮上的小方块：底色上叠一层现在的阴影色（带透明度）
  const preview = document.getElementById("shadow-preview");
  if (preview) preview.style.background = `linear-gradient(${shadowCSS()}, ${shadowCSS()}), ${currentTheme.bg}`;
}

// ── 中 / 英切换 ───────────────────────────────────────
// 页面上的文字写在 data-zh / data-en（placeholder、aria-label 用 data-zh-placeholder、data-zh-aria）

const _LANG_KEY = "pixelgraphy_lang";
let lang = "zh";
try {
  lang = localStorage.getItem(_LANG_KEY) || (navigator.language.startsWith("zh") ? "zh" : "en");
} catch (_) {}

const t = (zh, en) => (lang === "zh" ? zh : en);

function applyLang() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-zh]")) el.textContent = el.dataset[lang];
  for (const el of document.querySelectorAll("[data-zh-placeholder]")) el.placeholder = el.dataset[`${lang}Placeholder`];
  for (const el of document.querySelectorAll("[data-zh-aria]")) el.setAttribute("aria-label", el.dataset[`${lang}Aria`]);
  const btn = document.getElementById("lang-btn");
  if (btn) btn.textContent = lang === "zh" ? "EN" : "中"; // 按钮显示要切去的语言
  buildThemeSwatches(); // 色块的提示文字也要换
}

function toggleLang() {
  lang = lang === "zh" ? "en" : "zh";
  try {
    localStorage.setItem(_LANG_KEY, lang);
  } catch (_) {}
  applyLang();
}

// ── 配色按钮 ─────────────────────────────────────────

// 收藏的自定义配色：[{ bg, ink, name }]，不限个数；没起名的显示「我的配色 N」
const SAVED_THEMES_KEY = "pixelgraphy_saved_themes";
function loadSavedThemes() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_THEMES_KEY) || "[]");
    return Array.isArray(list) ? list.filter((c) => c?.bg && c?.ink) : [];
  } catch (_) {
    return [];
  }
}
function storeSavedThemes(list) {
  try {
    localStorage.setItem(SAVED_THEMES_KEY, JSON.stringify(list));
  } catch (_) {}
}
const sameColors = (a, b) => a.bg.toLowerCase() === b.bg.toLowerCase() && a.ink.toLowerCase() === b.ink.toLowerCase();

// 配色、阴影两个面板：同一时间只开一个（null / "theme" / "shadow"）
let openPop = null;
function setOpenPop(name) {
  openPop = name;
  buildThemeSwatches();
  const panel = document.getElementById("shadow-panel");
  const btn = document.getElementById("shadow-btn");
  if (panel) panel.hidden = name !== "shadow";
  if (btn) {
    btn.setAttribute("aria-expanded", name === "shadow");
    btn.querySelector(".caret").textContent = name === "shadow" ? "▴" : "▾";
  }
}
function toggleShadowPop() {
  setOpenPop(openPop === "shadow" ? null : "shadow");
}

// 配色：平时只有一个按钮（当前色块 + 名字），点开才出现预设、我的配色和自定义取色

function paintSwatch(el, colors) {
  el.style.background = colors.bg;
  el.style.boxShadow = `inset 0 0 0 5px ${colors.bg}, inset 0 0 0 20px ${colors.ink}`;
}

function buildThemeSwatches() {
  const row = document.getElementById("theme-row");
  if (!row) return;
  row.innerHTML = "";
  const custom = currentTheme.id === "custom";
  const saved = loadSavedThemes();
  // 现在的自定义配色是不是已经收藏过（是的话高亮那个收藏，按钮变成删除）
  const savedIndex = custom ? saved.findIndex((c) => sameColors(c, currentTheme)) : -1;
  const savedName = (c, i) => c.name || `${t("我的配色", "My palette")} ${i + 1}`;
  const themeName = () =>
    currentTheme.id !== "custom"
      ? t(currentTheme.zh, currentTheme.en)
      : savedIndex >= 0
        ? savedName(saved[savedIndex], savedIndex)
        : t("自定义", "Custom");

  // 开关按钮
  const toggle = document.createElement("button");
  toggle.className = "nes-btn theme-btn";
  toggle.setAttribute("aria-expanded", openPop === "theme");
  const preview = document.createElement("span");
  preview.className = "swatch";
  paintSwatch(preview, currentTheme);
  const name = document.createElement("span");
  name.className = "theme-name";
  name.textContent = themeName();
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = openPop === "theme" ? "▴" : "▾";
  toggle.append(preview, name, caret);
  toggle.onclick = () => setOpenPop(openPop === "theme" ? null : "theme");
  row.appendChild(toggle);

  const pop = document.createElement("div");
  pop.className = "pop-panel theme-pop";
  pop.hidden = openPop !== "theme";
  row.appendChild(pop);

  const section = (title) => {
    const h = document.createElement("div");
    h.className = "theme-section-title";
    h.textContent = title;
    const grid = document.createElement("div");
    grid.className = "swatch-grid";
    pop.append(h, grid);
    return grid;
  };
  const swatch = (grid, title, colors, active, onClick) => {
    const b = document.createElement("button");
    b.className = "swatch" + (active ? " swatch-active" : "");
    b.title = title;
    b.setAttribute("aria-label", title);
    paintSwatch(b, colors);
    b.onclick = () => {
      onClick();
      buildThemeSwatches();
    };
    grid.appendChild(b);
  };

  const presetGrid = section(t("预设", "Presets"));
  for (const p of THEME_PRESETS) swatch(presetGrid, t(p.zh, p.en), p, p.id === currentTheme.id, () => setTheme(p));

  // 收藏的配色带名字：色块 + 名字，两列排开
  const savedGrid = section(t("我的配色", "My palettes"));
  savedGrid.classList.add("saved-grid");
  const chipLabels = [];
  saved.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "saved-chip" + (i === savedIndex ? " saved-chip-active" : "");
    b.title = savedName(c, i);
    const chip = document.createElement("span");
    chip.className = "swatch";
    paintSwatch(chip, c);
    const label = document.createElement("span");
    label.className = "saved-chip-name";
    label.textContent = savedName(c, i);
    chipLabels.push(label);
    b.append(chip, label);
    b.onclick = () => {
      setTheme({ id: "custom", bg: c.bg, ink: c.ink });
      buildThemeSwatches();
    };
    savedGrid.appendChild(b);
  });
  if (!saved.length) {
    const hint = document.createElement("span");
    hint.className = "theme-hint";
    hint.textContent = t("调好颜色后点「收藏」", "Pick colors, then Save");
    savedGrid.appendChild(hint);
  }

  // 自定义：底色 + 墨色两个取色器，各改各的（改底色不会动墨色）
  const customRow = document.createElement("div");
  customRow.className = "theme-custom";
  pop.appendChild(customRow);
  const picker = (label, title, value, onPick) => {
    const wrap = document.createElement("label");
    wrap.className = "bg-label";
    wrap.title = title;
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "color";
    input.className = "color-input";
    input.value = value;
    // 拖动取色时只更新颜色，不重建面板（重建会把打开的取色器关掉）
    input.addEventListener("input", () => {
      onPick(input.value);
      for (const el of pop.querySelectorAll(".swatch-active, .saved-chip-active"))
        el.classList.remove("swatch-active", "saved-chip-active");
      paintSwatch(preview, currentTheme);
      name.textContent = t("自定义", "Custom");
      setAction(-1);
    });
    // 取色器关掉后再按收藏状态重建一次（选回了已收藏的颜色就显示删除）
    input.addEventListener("change", buildThemeSwatches);
    wrap.append(text, input);
    customRow.appendChild(wrap);
  };
  // 每个取色器后面一个「自动」按钮：想省事就点，按另一个颜色配一个；不点就保留自己选的
  const auto = (label, title, makeTheme) => {
    const b = document.createElement("button");
    b.className = "nes-btn small-btn";
    b.textContent = label;
    b.title = title;
    b.onclick = () => {
      setTheme({ id: "custom", ...makeTheme() });
      buildThemeSwatches();
    };
    customRow.appendChild(b);
  };
  picker(t("底色", "Bg"), t("自定义底色", "Custom background"), currentTheme.bg, (bg) =>
    setTheme({ id: "custom", bg, ink: currentTheme.ink })
  );
  auto(t("自动底色", "Auto bg"), t("按墨色自动配一个底色", "Pick a background that suits the ink"), () => ({
    bg: contrastColor(currentTheme.ink),
    ink: currentTheme.ink,
  }));
  picker(t("墨色", "Ink"), t("自定义墨色", "Custom ink"), currentTheme.ink, (ink) =>
    setTheme({ id: "custom", bg: currentTheme.bg, ink })
  );
  auto(t("自动墨色", "Auto ink"), t("按底色自动配一个墨色", "Pick an ink color that suits the background"), () => ({
    bg: currentTheme.bg,
    ink: contrastColor(currentTheme.bg),
  }));

  // 名字 + 收藏 / 删除：自定义配色还没收藏 → 起名 + 收藏；选中的是收藏 → 改名 + 删除；选的是预设就不显示
  const nameRow = document.createElement("div");
  nameRow.className = "theme-name-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "nes-input small-input";
  nameInput.maxLength = 16;
  nameInput.placeholder = t("起个名字", "Name it");
  const action = document.createElement("button");
  action.className = "nes-btn small-btn";
  nameRow.append(nameInput, action);
  pop.appendChild(nameRow);

  const saveCurrent = () => {
    const list = loadSavedThemes().filter((c) => !sameColors(c, currentTheme));
    const entry = { bg: currentTheme.bg, ink: currentTheme.ink };
    if (nameInput.value.trim()) entry.name = nameInput.value.trim();
    list.push(entry);
    storeSavedThemes(list);
    buildThemeSwatches();
  };
  // 已收藏的配色：改完名字（回车或离开输入框）就存；只更新文字不重建面板，
  // 不然改完名直接点「删除」时，面板先被重建，这一下点击就丢了
  const rename = (i) => {
    const list = loadSavedThemes();
    if (!list[i]) return;
    const v = nameInput.value.trim();
    if (v) list[i].name = v;
    else delete list[i].name;
    storeSavedThemes(list);
    saved[i] = list[i];
    name.textContent = chipLabels[i].textContent = chipLabels[i].parentElement.title = savedName(list[i], i);
  };
  const setAction = (i) => {
    nameRow.hidden = currentTheme.id !== "custom";
    nameInput.value = i >= 0 ? saved[i].name || "" : "";
    nameInput.onchange = i >= 0 ? () => rename(i) : null;
    nameInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (i >= 0) nameInput.blur();
      else saveCurrent();
    };
    action.textContent = i >= 0 ? t("× 删除", "× Delete") : t("★ 收藏", "★ Save");
    action.onclick =
      i >= 0
        ? () => {
            storeSavedThemes(loadSavedThemes().filter((_, j) => j !== i));
            buildThemeSwatches();
          }
        : saveCurrent;
  };
  setAction(savedIndex);
}

// 点面板外面或按 Esc 收起面板
document.addEventListener("pointerdown", (e) => {
  if (openPop && !e.target.closest("#style-row")) setOpenPop(null);
});
document.addEventListener("keydown", (e) => {
  if (openPop && e.key === "Escape") setOpenPop(null);
});

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("text-input");
  // 实时同步 currentText（手机端 blur 可能晚于开始画）
  input.addEventListener("input", (e) => (currentText = e.target.value.trim()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      drawText();
      e.target.blur();
    }
  });
  input.addEventListener("blur", drawText);

  // 键盘快捷键：B 画笔 / E 橡皮 / Cmd(Ctrl)+Z 撤销
  document.addEventListener("keydown", (e) => {
    if (document.activeElement?.matches("input, select")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      setUndo();
    } else if (e.key === "b") setBrush();
    else if (e.key === "e") setEraser();
  });

  for (const [id, key] of [["shadow-x", "x"], ["shadow-y", "y"], ["shadow-alpha", "alpha"]])
    document.getElementById(id).addEventListener("input", (e) => setShadow({ [key]: Number(e.target.value) }));
  document.getElementById("shadow-color").addEventListener("input", (e) => setShadow({ color: e.target.value }));
  // 阴影颜色没单独选过时跟着墨色，换配色后取色器也要跟着变
  document.addEventListener("themechange", syncShadowInputs);
  // 发灰用的底色、晕染方向都跟配色有关
  document.addEventListener("themechange", () => typeof width !== "undefined" && refreshPageFilter());

  // 会改画面的交互都标记重画（捕获阶段，先于各自的处理函数）
  for (const ev of ["pointerdown", "pointerup", "input", "change", "click", "keydown", "focusout", "themechange"])
    document.addEventListener(ev, markDirty, true);
  document.addEventListener("pointermove", () => drawing && markDirty(), true);
  document.fonts?.addEventListener?.("loadingdone", markDirty);
  document.fonts?.ready.then(markDirty);

  const filterSelect = document.getElementById("filter-select");
  filterSelect.value = currentFilter;
  filterSelect.addEventListener("change", (e) => setFilter(e.target.value));
  const sparkleToggle = document.getElementById("sparkle-toggle");
  sparkleToggle.checked = sparkleOn;
  sparkleToggle.addEventListener("change", (e) => setSparkle(e.target.checked));
  const glitchToggle = document.getElementById("glitch-toggle");
  glitchToggle.checked = glitchSeed > 0;
  glitchToggle.addEventListener("change", (e) => setGlitch(e.target.checked));
  syncShadowInputs();

  const sizeInput = document.getElementById("grid-size");
  sizeInput.value = N;
  sizeInput.addEventListener("change", (e) => setGridSize(e.target.value));
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  applyLang();
});
