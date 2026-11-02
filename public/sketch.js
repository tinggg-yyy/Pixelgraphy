// Pixelgraphy —— 32×32 像素画板（从 Predate 的兽人形象画板拆出来）
// 画笔：同一格反复划过会逐级加深（4 级）；输入文字后画出来的是文字格子

const N = 32;
let tool = "brush";

let grid = [];
let currentText = "";

let history = []; // 每一笔的 diff 列表
let currentStroke = []; // 当前这笔中被修改的格子 {x, y, oldVal}
let strokeCells = new Set(); // 当前笔中已记录的格子，避免重复记录
let pressInCanvas = false; // 这一笔是否从画框内开始

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
  grid = blankGrid();
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

  const shadowOn = () => {
    if (!withShadow) return;
    ctx.shadowColor = themeInk(0.6);
    ctx.shadowOffsetX = 2 * (size / width);
    ctx.shadowOffsetY = 2 * (size / width);
    ctx.shadowBlur = 0;
  };
  const shadowOff = () => (ctx.shadowColor = "rgba(0,0,0,0)");

  g.noStroke();
  g.textAlign(CENTER, CENTER);
  g.textSize(cellSize);
  g.textFont("Zpix");

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
        g.text(charAt(x, y), px + cellSize / 2, py + cellSize / 2);
        shadowOff();
      } else if (cell !== null && cell !== "/") {
        g.fill(...ink, 255);
        shadowOn();
        g.text(cell, px + cellSize / 2, py + cellSize / 2);
        shadowOff();
      }
    }
  }
}

function draw() {
  clear();
  renderGrid(window, width);

  // 网格线（拓麻歌子 LCD 质感）
  const cellSize = width / N;
  stroke(...themeInkRGB(), 22);
  strokeWeight(0.5);
  for (let i = 0; i <= N; i++) {
    line(i * cellSize, 0, i * cellSize, height);
    line(0, i * cellSize, width, i * cellSize);
  }
  noStroke();
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

// ── 画（鼠标和手指都走这里：p5 会把 touch 转成 mouse 事件）──────

function inCanvas() {
  return mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
}

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

function mousePressed() {
  currentStroke = [];
  strokeCells = new Set();
  pressInCanvas = inCanvas();
  if (!pressInCanvas) return true; // 画框外：让页面正常响应（按钮、滚动）
  paintAt(mouseX, mouseY);
  return false;
}

function mouseDragged() {
  if (!pressInCanvas) return true;
  if (inCanvas()) paintAt(mouseX, mouseY);
  return false;
}

function mouseReleased() {
  if (currentStroke.length > 0) history.push(currentStroke);
  currentStroke = [];
  strokeCells = new Set();
  const was = pressInCanvas;
  pressInCanvas = false;
  return was ? false : true;
}

function windowResized() {
  const s = canvasSize();
  resizeCanvas(s, s);
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

// ── 导出 PNG ─────────────────────────────────────────

function savePNG() {
  const S = 1024; // 32px 一格
  const g = createGraphics(S, S);
  g.pixelDensity(1);
  const withBg = document.getElementById("bg-toggle")?.checked;
  if (withBg) g.background(themeBg());
  else g.clear();
  renderGrid(g, S);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  save(g, `pixelgraphy-${stamp}.png`);
  g.remove();
}

// ── 配色按钮 ─────────────────────────────────────────

function buildThemeSwatches() {
  const row = document.getElementById("theme-row");
  if (!row) return;
  row.innerHTML = "";
  for (const t of THEME_PRESETS) {
    const b = document.createElement("button");
    b.className = "swatch" + (t.id === currentTheme.id ? " swatch-active" : "");
    b.title = `${t.zh} ${t.en}`;
    b.style.background = t.bg;
    b.style.boxShadow = `inset 0 0 0 5px ${t.bg}, inset 0 0 0 20px ${t.ink}`;
    b.onclick = () => {
      setTheme(t);
      buildThemeSwatches();
    };
    row.appendChild(b);
  }
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
    if (document.activeElement === input) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      setUndo();
    } else if (e.key === "b") setBrush();
    else if (e.key === "e") setEraser();
  });

  buildThemeSwatches();
});
