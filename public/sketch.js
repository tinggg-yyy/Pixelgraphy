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

function canvasSize() {
  const tools = document.getElementById("tools");
  const header = document.querySelector("header");
  const reserved = (tools?.offsetHeight || 140) + (header?.offsetHeight || 60) + 60;
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
try {
  const saved = localStorage.getItem("pixelgraphy_filter");
  if (FILTERS[saved]) currentFilter = saved;
  sparkleOn = localStorage.getItem("pixelgraphy_sparkle") === "1";
} catch (_) {}

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

function buildThemeSwatches() {
  const row = document.getElementById("theme-row");
  if (!row) return;
  row.innerHTML = "";
  for (const p of THEME_PRESETS) {
    const b = document.createElement("button");
    b.className = "swatch" + (p.id === currentTheme.id ? " swatch-active" : "");
    b.title = t(p.zh, p.en);
    b.style.background = p.bg;
    b.style.boxShadow = `inset 0 0 0 5px ${p.bg}, inset 0 0 0 20px ${p.ink}`;
    b.onclick = () => {
      setTheme(p);
      buildThemeSwatches();
    };
    row.appendChild(b);
  }

  // 自定义：底色 + 墨色两个取色器。只改底色时墨色自动配（suggestInk），之后可以再单独改墨色
  const custom = currentTheme.id === "custom";
  const picker = (title, value, onPick) => {
    const label = document.createElement("label");
    label.className = "swatch swatch-picker" + (custom ? " swatch-active" : "");
    label.title = title;
    label.style.background = value;
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    // 拖动取色时只更新颜色，不重建按钮（重建会把打开的取色器关掉）
    input.addEventListener("input", () => {
      onPick(input.value);
      for (const el of row.children) el.classList.toggle("swatch-active", el.classList.contains("swatch-picker"));
      bgPick.style.background = currentTheme.bg;
      inkPick.style.background = currentTheme.ink;
    });
    label.appendChild(input);
    row.appendChild(label);
    return label;
  };
  const bgPick = picker(t("自定义底色", "Custom background"), currentTheme.bg, (bg) =>
    setTheme({ id: "custom", bg, ink: suggestInk(bg) })
  );
  const inkPick = picker(t("自定义墨色", "Custom ink"), currentTheme.ink, (ink) =>
    setTheme({ id: "custom", bg: currentTheme.bg, ink })
  );
  bgPick.classList.add("swatch-bg");
  inkPick.classList.add("swatch-ink");
}

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
  syncShadowInputs();

  const sizeInput = document.getElementById("grid-size");
  sizeInput.value = N;
  sizeInput.addEventListener("change", (e) => setGridSize(e.target.value));
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  applyLang();
});
