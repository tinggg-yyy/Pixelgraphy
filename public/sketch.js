// Pixelgraphy —— N×N 像素画板（默认 32，可调）（从 Predate 的兽人形象画板拆出来）
// 画笔：同一格反复划过会逐级加深（4 级）；输入文字后画出来的是文字格子

let N = 32;
const N_MIN = 4, N_MAX = 128;
let tool = "brush";

let grid = [];
let currentText = "";

let history = []; // 每一笔的 diff 列表
let redoStack = []; // 撤销掉的笔：{x, y, oldVal, newVal}，重做时按 newVal 改回去；画了新的一笔就清空
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
  // 上下留白按实际算（里面有手机、平板顶部 / 底部的安全区，不让开会被液态玻璃盖住）
  const main = getComputedStyle(document.querySelector("main"));
  const padY = parseFloat(main.paddingTop) + parseFloat(main.paddingBottom);
  if (window.matchMedia(WIDE_QUERY).matches) {
    // 画布竖向撑满一屏（减去上下留白、顶栏下间距 12、画框外阴影 4），宽不超过中间那栏
    const col = document.getElementById("canvas-col");
    const colW = (col?.clientWidth || windowWidth - 400) - 4;
    return Math.floor(Math.max(200, Math.min(colW, windowHeight - headerH - padY - 16)));
  }
  const tools = document.getElementById("tools");
  const left = document.getElementById("left-panel");
  // 再加上顶栏下间距、两处 14px 间距和画框外阴影
  const reserved = (tools?.offsetHeight || 140) + headerH + (left?.offsetHeight || 0) + padY + 12 + 28 + 4;
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
  markDirty();
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

      // 文字格轮到的字是空格，或者字已经删光了：照同样的深浅画成普通格子，不要空着
      const isText = cell === "text" || cell === "#" || TEXT_ALPHA[cell] !== undefined;
      const ch = isText ? charAt(x, y) : "";
      if (cell === "pixel" || cell === 4 || PIXEL_ALPHA[cell] !== undefined || (isText && !ch.trim())) {
        const a = cell === "pixel" ? 255 : (PIXEL_ALPHA[cell] ?? TEXT_ALPHA[cell] ?? 255);
        g.fill(...ink, a);
        shadowOn();
        g.rect(px, py, cellSize, cellSize);
        shadowOff();
      } else if (isText) {
        const a = TEXT_ALPHA[cell] ?? 255;
        g.fill(...ink, a);
        shadowOn();
        g.text(ch, px + cellSize / 2 + tx, py + cellSize / 2 + ty);
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

// ── 自制滤镜 ─────────────────────────────────────────
// 自制就是用滑杆调滤镜的几个部件；调的时候是 FILTERS.custom，收藏后存成 FILTERS["my-…"]

// [参数, 中文, 英文, 最大值, 步长]
const FILTER_PARAMS = [
  ["blur", "虚焦", "Blur", 8, 0.2],
  ["bleed", "晕染", "Bleed", 0.8, 0.05],
  ["burn", "灼烧", "Burn", 1, 0.05],
  ["shift", "错位", "RGB shift", 24, 1],
  ["wash", "发灰", "Fade", 0.6, 0.02],
  ["grain", "颗粒", "Grain", 1, 0.02],
  ["color", "彩色颗粒", "Color grain", 0.4, 0.02],
  ["mottle", "斑驳", "Mottle", 1, 0.02],
];
const CUSTOM_DEFAULT = { blur: 1, bleed: 0.3, burn: 0, shift: 0, wash: 0, grain: 0.15, color: 0.1, mottle: 0 };

// 滑杆参数 → 滤镜定义（和 filters.js 里预设的写法一样）
function filterFromParams(p) {
  const f = { blur: p.blur, shift: p.shift, wash: p.wash, bleed: [], grain: [] };
  if (p.bleed) f.bleed.push({ r: 5, a: p.bleed });
  if (p.burn) f.bleed.push({ r: 2.5, a: p.burn, mode: "color-burn", lift: 0.5 });
  if (p.color) f.grain.push({ type: "color", a: p.color, mode: "source-over", colors: PINK_BLUE });
  if (p.mottle) f.grain.push({ type: "mottle", a: p.mottle, mode: "soft-light", scale: 1.5, colors: ["#ff7fb0", "#7fb0ff"] });
  if (p.grain) f.grain.push({ type: "mono", a: p.grain, mode: "overlay" });
  return f;
}

// 滤镜定义 → 滑杆参数：从预设开始改的时候，滑杆先摆到这个预设的位置（大致还原）
function paramsFromFilter(f) {
  const p = { ...CUSTOM_DEFAULT };
  for (const [k] of FILTER_PARAMS) p[k] = 0;
  p.blur = f.blur || 0;
  p.shift = f.shift || 0;
  p.wash = f.wash || 0;
  for (const b of [].concat(f.bleed || [])) {
    if (b.mode === "color-burn") p.burn = b.a;
    else p.bleed = b.a;
  }
  for (const g of f.grain || []) {
    const k = g.type === "mono" ? "grain" : g.type;
    p[k] = Math.min(p[k] + g.a, FILTER_PARAMS.find(([key]) => key === k)[3]);
  }
  return p;
}

const CUSTOM_FILTER_KEY = "pixelgraphy_custom_filter";
const SAVED_FILTERS_KEY = "pixelgraphy_saved_filters";
let customParams = { ...CUSTOM_DEFAULT };
// 收藏的滤镜：[{ id: "my-时间戳", name, p }]，id 固定不变，删了别的也不会串
let savedFilters = [];
try {
  customParams = { ...CUSTOM_DEFAULT, ...JSON.parse(localStorage.getItem(CUSTOM_FILTER_KEY) || "{}") };
  const list = JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY) || "[]");
  if (Array.isArray(list)) savedFilters = list.filter((x) => x?.id?.startsWith("my-") && x.p);
} catch (_) {}
FILTERS.custom = filterFromParams(customParams);
for (const x of savedFilters) FILTERS[x.id] = filterFromParams({ ...CUSTOM_DEFAULT, ...x.p });

function storeSavedFilters() {
  try {
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(savedFilters));
  } catch (_) {}
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
  buildOverlayPanel();
}

function setSparkle(on) {
  sparkleOn = on;
  try {
    localStorage.setItem("pixelgraphy_sparkle", on ? "1" : "0");
  } catch (_) {}
  markDirty();
  buildOverlayPanel();
}

function setFilter(id) {
  if (!FILTERS[id]) return;
  currentFilter = id;
  try {
    localStorage.setItem("pixelgraphy_filter", id);
  } catch (_) {}
  markDirty();
  buildFilterPanel();
}

// ── 滤镜按钮 ─────────────────────────────────────────
// 点开是一个面板：预设滤镜（单选）、我的滤镜、自制。叠加效果（闪粉、故障）是旁边单独的按钮

const FILTER_LABELS = {
  none: ["无", "None"],
  soft: ["柔焦", "Soft"],
  dreamy: ["梦幻", "Dreamy"],
  film: ["胶片", "Film"],
  rgb: ["错位", "RGB Shift"],
  burn: ["灼烧", "Burn"],
  softburn: ["柔烧", "Soft Burn"],
  burnshift: ["烧错位", "Burn Shift"],
};

let filterEditorOpen = false;

const filterName = (id) => {
  if (id === "custom") return t("自制", "Custom");
  const mine = savedFilters.find((x) => x.id === id);
  if (mine) return mine.name || t("我的滤镜", "My filter");
  return t(...(FILTER_LABELS[id] || FILTER_LABELS.none));
};

// 按钮上：选了滤镜就显示滤镜名，没选就显示「滤镜」
function updateFilterLabel() {
  const label = document.getElementById("filter-name");
  if (label) label.textContent = currentFilter !== "none" ? filterName(currentFilter) : t("滤镜", "Filter");
}

// 叠加按钮：闪粉、故障各自开关；按钮上显示开着的那几样，都没开就显示「叠加」
function buildOverlayPanel() {
  const panel = document.getElementById("overlay-panel");
  const label = document.getElementById("overlay-name");
  if (!panel || !label) return;
  const items = [
    [t("闪粉", "Sparkle"), sparkleOn, () => setSparkle(!sparkleOn)],
    [t("故障", "Glitch"), glitchSeed > 0, () => setGlitch(!glitchSeed)],
  ];
  const on = items.filter(([, active]) => active).map(([text]) => text);
  label.textContent = on.length ? on.join(" + ") : t("叠加", "Overlay");

  panel.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "option-grid two-col";
  for (const [text, active, onClick] of items) {
    const b = document.createElement("button");
    b.className = "nes-btn small-btn" + (active ? " tool-active" : "");
    b.textContent = text;
    b.setAttribute("aria-pressed", active);
    b.onclick = onClick;
    grid.appendChild(b);
  }
  panel.appendChild(grid);
  positionOpenPop();
}

// 现在这个滤镜的滑杆参数（自制的就是它自己；收藏的用存下的；预设的大致还原）
function currentFilterParams() {
  if (currentFilter === "custom") return customParams;
  const mine = savedFilters.find((x) => x.id === currentFilter);
  if (mine) return { ...CUSTOM_DEFAULT, ...mine.p };
  return paramsFromFilter(FILTERS[currentFilter] || {});
}

// 拖滑杆：改成自制滤镜，实时生效（不重建面板，不然滑杆拖到一半就没了）
function tweakCustomFilter(patch) {
  customParams = { ...currentFilterParams(), ...patch };
  FILTERS.custom = filterFromParams(customParams);
  currentFilter = "custom";
  try {
    localStorage.setItem(CUSTOM_FILTER_KEY, JSON.stringify(customParams));
    localStorage.setItem("pixelgraphy_filter", "custom");
  } catch (_) {}
  markDirty();
  updateFilterLabel();
}

function buildFilterPanel() {
  const panel = document.getElementById("filter-panel");
  if (!panel) return;
  updateFilterLabel();

  panel.innerHTML = "";
  const section = (title, className = "option-grid") => {
    const h = document.createElement("div");
    h.className = "theme-section-title";
    h.textContent = title;
    const grid = document.createElement("div");
    grid.className = className;
    panel.append(h, grid);
    return grid;
  };
  const option = (grid, text, active, onClick) => {
    const b = document.createElement("button");
    b.className = "nes-btn small-btn" + (active ? " tool-active" : "");
    b.textContent = text;
    b.title = text;
    b.setAttribute("aria-pressed", active);
    b.onclick = onClick;
    grid.appendChild(b);
    return b;
  };

  const presets = section(t("滤镜", "Filter"));
  for (const id of Object.keys(FILTER_LABELS))
    if (FILTERS[id]) option(presets, filterName(id), id === currentFilter, () => setFilter(id));

  const mine = section(t("我的滤镜", "My filters"), "option-grid two-col");
  for (const x of savedFilters) option(mine, filterName(x.id), x.id === currentFilter, () => setFilter(x.id));
  const unsavedChip = () => {
    const b = option(mine, t("自制（未收藏）", "Custom (unsaved)"), true, () => {});
    b.dataset.custom = "1";
  };
  if (currentFilter === "custom") unsavedChip();
  if (!mine.children.length) {
    const hint = document.createElement("span");
    hint.className = "theme-hint";
    hint.textContent = t("点「自制」调一个，再收藏", "Tap Make to tune one, then Save");
    mine.appendChild(hint);
  }

  // 自制：点开是一排滑杆，从现在这个滤镜的样子开始调
  const editToggle = document.createElement("button");
  editToggle.className = "nes-btn small-btn filter-edit-toggle" + (filterEditorOpen ? " tool-active" : "");
  editToggle.textContent = `${t("自制", "Make")} ${filterEditorOpen ? "▴" : "▾"}`;
  editToggle.onclick = () => {
    filterEditorOpen = !filterEditorOpen;
    buildFilterPanel();
  };
  panel.appendChild(editToggle);
  // 面板高度变了（展开 / 收起自制），重新定位一下，免得超出屏幕
  if (!filterEditorOpen) return positionOpenPop();

  const editor = document.createElement("div");
  editor.className = "filter-editor";
  panel.appendChild(editor);
  const params = currentFilterParams();
  // 一拖滑杆就变成「自制（未收藏）」：就地改高亮，不重建面板
  const markCustom = () => {
    for (const el of panel.querySelectorAll(".option-grid .tool-active"))
      if (!el.dataset.custom) el.classList.remove("tool-active");
    if (!mine.querySelector("[data-custom]")) {
      mine.querySelector(".theme-hint")?.remove();
      unsavedChip();
    }
    setAction(null);
  };
  for (const [key, zh, en, max, step] of FILTER_PARAMS) {
    const row = document.createElement("label");
    row.className = "bg-label";
    const text = document.createElement("span");
    text.textContent = t(zh, en);
    const range = document.createElement("input");
    range.type = "range";
    range.min = 0;
    range.max = max;
    range.step = step;
    range.value = params[key];
    range.addEventListener("input", () => {
      tweakCustomFilter({ [key]: Number(range.value) });
      markCustom();
    });
    row.append(text, range);
    editor.appendChild(row);
  }

  // 名字 + 收藏 / 删除：自制还没收藏 → 起名 + 收藏；选中的是收藏 → 改名 + 删除；选的是预设就不显示
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
  panel.appendChild(nameRow);

  const saveCurrent = () => {
    const id = `my-${Date.now()}`;
    const name = nameInput.value.trim() || `${t("我的滤镜", "My filter")} ${savedFilters.length + 1}`;
    savedFilters.push({ id, name, p: { ...customParams } });
    FILTERS[id] = filterFromParams(customParams);
    storeSavedFilters();
    setFilter(id);
  };
  let actionFor; // 只在切换「收藏 / 自制」时重填名字，拖滑杆时不清掉已经输入的名字
  const setAction = (mineEntry) => {
    nameRow.hidden = !mineEntry && currentFilter !== "custom";
    if (actionFor !== mineEntry) nameInput.value = mineEntry ? mineEntry.name || "" : "";
    actionFor = mineEntry;
    nameInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (mineEntry) nameInput.blur();
      else saveCurrent();
    };
    // 已收藏的滤镜：改完名字（回车或离开输入框）就存；只更新文字不重建面板（同配色的改名）
    nameInput.onchange = mineEntry
      ? () => {
          mineEntry.name = nameInput.value.trim() || mineEntry.name;
          storeSavedFilters();
          updateFilterLabel();
          const btn = [...mine.children].find((el) => el.classList.contains("tool-active"));
          if (btn) btn.textContent = btn.title = filterName(mineEntry.id);
        }
      : null;
    action.textContent = mineEntry ? t("× 删除", "× Delete") : t("★ 收藏", "★ Save");
    action.onclick = mineEntry
      ? () => {
          savedFilters = savedFilters.filter((x) => x !== mineEntry);
          delete FILTERS[mineEntry.id];
          storeSavedFilters();
          setFilter("none");
        }
      : saveCurrent;
  };
  setAction(savedFilters.find((x) => x.id === currentFilter) || null);
  positionOpenPop();
}

// 画框也画在画布里（不用 CSS 边框），这样滤镜能连框一起盖住。
// 屏幕上的滤镜直接套在画布像素上，和导出用同一套代码：
// 以前用 CSS filter / mix-blend-mode 套在画框外面，iPhone、iPad 的 Safari 对套在 canvas 上的这两样支持不好，
// 滤镜会只盖到框、盖不到画，画面变了也要过一会儿才更新
const FRAME = 2; // 画框宽度（CSS 像素）
const innerSize = () => width - 2 * FRAME;
let frameColor = null;
document.addEventListener("themechange", () => (frameColor = null));

function draw() {
  if (!dirty) return;
  dirty = false;
  background(themeBg());
  push();
  translate(FRAME, FRAME);
  renderGrid(window, innerSize());
  renderCellLines(window, innerSize());
  pop();
  // 画框：和以前 CSS 边框一样的颜色（线条色 45%）
  frameColor ||= `rgb(${getComputedStyle(document.documentElement).getPropertyValue("--line-rgb").trim()} / 0.45)`;
  const ctx = drawingContext;
  ctx.save();
  ctx.strokeStyle = frameColor;
  ctx.lineWidth = FRAME;
  ctx.strokeRect(FRAME / 2, FRAME / 2, width - FRAME, height - FRAME);
  ctx.restore();
  // 和导出一样的顺序：先故障，再滤镜
  if (glitchSeed) applyGlitch(ctx.canvas, glitchSeed);
  applyFilter(ctx.canvas, currentFilter, sparkleOn);
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
  if (stroke.length) {
    history.push(stroke); // 清空也能撤销
    redoStack = [];
  }
}

function setUndo() {
  if (history.length === 0) return;
  const stroke = history.pop();
  // 撤销前先记下现在的样子，重做时改回来
  redoStack.push(stroke.map((c) => ({ ...c, newVal: grid[c.y][c.x] })));
  for (const { x, y, oldVal } of stroke) grid[y][x] = oldVal;
}

// 重做：撤销点多了可以一步步改回来
function setRedo() {
  if (redoStack.length === 0) return;
  const stroke = redoStack.pop();
  for (const { x, y, newVal } of stroke) grid[y][x] = newVal;
  history.push(stroke.map(({ x, y, oldVal }) => ({ x, y, oldVal })));
}

// ── 画（鼠标、手指、触控笔都走 pointer 事件）────────────

let drawing = false;

// 触控笔（Apple Pencil 这类）的力度 → 深浅 1~4；轻轻画是浅的，用力画是深的
function pressureLevel(p) {
  if (p < 0.2) return 1;
  if (p < 0.4) return 2;
  if (p < 0.65) return 3;
  return 4;
}

// 在画布坐标 (mx, my) 所在的格子上画一下。
// pressure：触控笔的力度（0~1），有就按力度定深浅；鼠标、手指拿不到真实力度，传 null，还是逐级加深
function paintAt(mx, my, pressure = null) {
  // 画布坐标 → 格子：扣掉画框
  const gx = floor(((mx - FRAME) / innerSize()) * N);
  const gy = floor(((my - FRAME) / innerSize()) * N);
  if (gx < 0 || gx >= N || gy < 0 || gy >= N) return;

  const cur = grid[gy][gx];
  let newVal = cur;

  if (tool === "brush" && pressure !== null) {
    // 按力度定深浅，只会加深不会变浅（轻轻划过已经很深的格子不会把它擦淡）
    const want = pressureLevel(pressure);
    const empty = cur === "/" || cur === null;
    if (currentText !== "") {
      // 文字模式：空格、像素格、文字格都变成文字格（像素格保留原来的深浅）
      const lv = empty ? 0 : typeof cur === "number" ? cur : TEXT_ALPHA[cur] !== undefined ? Number(cur.slice(1)) : 4;
      newVal = `#${Math.max(lv, want)}`;
    } else if (empty || typeof cur === "number") {
      // 像素模式：只画空格和像素格，文字格不动（和逐级加深一样）
      newVal = Math.max(empty ? 0 : cur, want);
    }
  } else if (tool === "brush") {
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
  if (currentStroke.length > 0) {
    history.push(currentStroke);
    redoStack = [];
  }
  currentStroke = [];
  strokeCells = new Set();
}

// 只有触控笔给的是真实力度；鼠标按下永远是 0.5，手指在大部分手机上是 0 或 1
const penPressure = (e) => (e.pointerType === "pen" && e.pressure > 0 ? e.pressure : null);

function attachPointerEvents(el) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button > 0) return; // 只认左键 / 手指
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    drawing = true;
    currentStroke = [];
    strokeCells = new Set();
    const { x, y } = canvasXY(e, el);
    paintAt(x, y, penPressure(e));
  });
  el.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    e.preventDefault();
    // 手指快速划过时浏览器会合并事件，把中间的点也取出来，线不会断
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const { x, y } = canvasXY(ev, el);
      if (x >= 0 && x <= width && y >= 0 && y <= height) paintAt(x, y, penPressure(ev));
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
  redoStack = [];
}

function windowResized() {
  const s = canvasSize();
  resizeCanvas(s, s);
  markDirty();
  positionOpenPop();
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
  markDirty();
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
  buildFilterPanel();
  buildOverlayPanel();
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

// 配色、阴影、滤镜、叠加四个面板：同一时间只开一个（null / "theme" / "shadow" / "filter" / "overlay"）
let openPop = null;
const STATIC_POPS = {
  shadow: ["shadow-panel", "shadow-btn"],
  filter: ["filter-panel", "filter-btn"],
  overlay: ["overlay-panel", "overlay-btn"],
};
function setOpenPop(name) {
  openPop = name;
  buildThemeSwatches();
  for (const [key, [panelId, btnId]] of Object.entries(STATIC_POPS)) {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (panel) panel.hidden = name !== key;
    if (btn) {
      btn.setAttribute("aria-expanded", name === key);
      btn.querySelector(".caret").textContent = name === key ? "▴" : "▾";
    }
  }
  positionOpenPop();
}
// 面板出现在按下的那个按钮正下方；右边放不下就往左挪，不超出屏幕
const POP_PARTS = {
  theme: [".theme-pop", ".theme-btn"],
  shadow: ["#shadow-panel", "#shadow-btn"],
  filter: ["#filter-panel", "#filter-btn"],
  overlay: ["#overlay-panel", "#overlay-btn"],
};
function positionOpenPop() {
  if (!openPop) return;
  const [panelSel, btnSel] = POP_PARTS[openPop];
  const panel = document.querySelector(panelSel), btn = document.querySelector(btnSel);
  const row = document.getElementById("style-row");
  if (!panel || !btn || !row || panel.hidden) return;
  const r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
  const maxLeft = window.innerWidth - 16 - panel.offsetWidth - r.left;
  panel.style.left = `${Math.max(16 - r.left, Math.min(b.left - r.left, maxLeft))}px`;
  // 都往下弹；下面实在放不下（比如滤镜展开自制后很高）才往上弹，上面也放不下就贴着屏幕顶
  const h = panel.offsetHeight;
  const below = b.bottom + 8;
  const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, b.top - 8 - h);
  panel.style.top = `${top - r.top}px`;
}

function toggleShadowPop() {
  setOpenPop(openPop === "shadow" ? null : "shadow");
}
function toggleFilterPop() {
  setOpenPop(openPop === "filter" ? null : "filter");
}
function toggleOverlayPop() {
  setOpenPop(openPop === "overlay" ? null : "overlay");
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

  // current：选中的那个配色的全名，跟在标题后面（按钮上英文名太长会被截断，这里能看全）
  const section = (title, current) => {
    const h = document.createElement("div");
    h.className = "theme-section-title";
    const text = document.createElement("span");
    text.textContent = title;
    h.appendChild(text);
    if (current) {
      const c = document.createElement("span");
      c.className = "theme-current";
      c.textContent = current;
      h.appendChild(c);
    }
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

  const presetGrid = section(t("预设", "Presets"), currentTheme.id !== "custom" && t(currentTheme.zh, currentTheme.en));
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
      pop.querySelector(".theme-current")?.remove();
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
  auto(t("自动", "Auto"), t("按墨色自动配一个底色", "Pick a background that suits the ink"), () => ({
    bg: contrastColor(currentTheme.ink),
    ink: currentTheme.ink,
  }));
  picker(t("墨色", "Ink"), t("自定义墨色", "Custom ink"), currentTheme.ink, (ink) =>
    setTheme({ id: "custom", bg: currentTheme.bg, ink })
  );
  auto(t("自动", "Auto"), t("按底色自动配一个墨色", "Pick an ink color that suits the background"), () => ({
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
  positionOpenPop();
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
  // 边打字边把像素格换成字（drawText 也会同步 currentText）。
  // 以前只在回车 / 离开输入框时换，第一次打字时画上还没有文字格，要等很久才看到字；
  // 手机上点画布也不会让输入框失焦（画布按下时 preventDefault 了），更是迟迟不换
  // 拼音输入法选字时输入框里是字母，先不换，选完字（compositionend）再换
  input.addEventListener("input", (e) => !e.isComposing && drawText());
  input.addEventListener("compositionend", drawText);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      drawText();
      e.target.blur();
    }
  });
  input.addEventListener("blur", drawText);

  // 键盘快捷键：B 画笔 / E 橡皮 / Cmd(Ctrl)+Z 撤销 / Cmd+Shift+Z 或 Ctrl+Y 重做
  document.addEventListener("keydown", (e) => {
    if (document.activeElement?.matches("input, select")) return;
    const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      setRedo();
    } else if (mod && key === "z") {
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

  // 会改画面的交互都标记重画（捕获阶段，先于各自的处理函数）
  for (const ev of ["pointerdown", "pointerup", "input", "change", "click", "keydown", "focusout", "themechange"])
    document.addEventListener(ev, markDirty, true);
  document.addEventListener("pointermove", () => drawing && markDirty(), true);
  document.fonts?.addEventListener?.("loadingdone", markDirty);
  document.fonts?.ready.then(markDirty);

  buildFilterPanel();
  buildOverlayPanel();
  syncShadowInputs();

  const sizeInput = document.getElementById("grid-size");
  sizeInput.value = N;
  sizeInput.addEventListener("change", (e) => setGridSize(e.target.value));
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  applyLang();
});
