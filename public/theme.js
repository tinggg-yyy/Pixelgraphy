// ── 配色（色调）──────────────────────────────────────────────
// 整套配色只由两个颜色决定：底色 bg + 墨色 ink（文字、线条、像素图标）。
// 按钮底色、阴影线、深色、浅色这些都按比例混出来，和原版灰绿配色基本一致。
// 预设配色在 THEME_PRESETS；自定义 = 用户自己选的 bg / ink。

const _THEME_KEY = "pixelgraphy_theme";

const THEME_PRESETS = [
  { id: "gameboy", zh: "原版灰绿", en: "GameBoy", bg: "#a9b0a2", ink: "#283023" },
  { id: "sakura", zh: "樱花粉", en: "Sakura", bg: "#e3b9c0", ink: "#4a2230" },
  { id: "paper", zh: "旧报纸", en: "Newsprint", bg: "#e4dfd2", ink: "#2a2a2a" },
  { id: "night", zh: "夜间", en: "Night", bg: "#23281f", ink: "#c8d4b8" },
  // 跳色 / 对比色：底色和墨色取互补或撞色，对比度都在 4.5 以上
  { id: "pinkgreen", zh: "粉配绿", en: "Pink & Green", bg: "#f4a7c0", ink: "#164a2d" },
  { id: "klein", zh: "克莱因蓝", en: "Klein & Yellow", bg: "#2342b8", ink: "#f5d547" },
  { id: "tomato", zh: "番茄配藏青", en: "Tomato & Navy", bg: "#f26b4b", ink: "#16245e" },
  { id: "lemon", zh: "柠檬配紫", en: "Lemon & Purple", bg: "#efe35a", ink: "#4a2a8a" },
  { id: "mint", zh: "薄荷配红", en: "Mint & Red", bg: "#a6e3c8", ink: "#a3122f" },
  { id: "orangeblue", zh: "橙配蓝", en: "Orange & Blue", bg: "#ffa94d", ink: "#123c73" },
  { id: "skyrust", zh: "天蓝配橙", en: "Sky & Rust", bg: "#9ad0ec", ink: "#8a2d0a" },
  { id: "coralteal", zh: "珊瑚配青", en: "Coral & Teal", bg: "#ff8a7a", ink: "#0a3d3d" },
  { id: "mustard", zh: "芥末配宝蓝", en: "Mustard & Royal", bg: "#e0b83e", ink: "#1b2f8f" },
  { id: "lilac", zh: "丁香配橄榄", en: "Lilac & Olive", bg: "#d6c4ee", ink: "#3d4a12" },
  { id: "cream", zh: "奶白配红", en: "Cream & Red", bg: "#f6efe2", ink: "#c81e1e" },
  { id: "cyanmagenta", zh: "青配洋红", en: "Cyan & Magenta", bg: "#3fd0c9", ink: "#7a0a4f" },
  { id: "hazard", zh: "黄配黑", en: "Yellow & Black", bg: "#ffd400", ink: "#1a1a1a" },
  { id: "redcream", zh: "红配奶白", en: "Red & Cream", bg: "#c8102e", ink: "#fff1d6" },
  { id: "purpleyellow", zh: "紫配黄", en: "Purple & Yellow", bg: "#5b2a86", ink: "#ffd23f" },
  { id: "forestpink", zh: "墨绿配粉", en: "Forest & Pink", bg: "#1f5c45", ink: "#ffb3c7" },
  { id: "winemint", zh: "酒红配薄荷", en: "Wine & Mint", bg: "#6b1530", ink: "#a8f0d0" },
  { id: "blackpink", zh: "黑配粉", en: "Black & Pink", bg: "#1a1a1a", ink: "#ff8fb8" },
  { id: "acid", zh: "黑配荧光绿", en: "Black & Acid", bg: "#151515", ink: "#b6ff3b" },
];

const _hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const _rgbToHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
// a 往 b 走 t 那么多（t=0 就是 a，t=1 就是 b）
const _mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const _WHITE = [255, 255, 255];

// 由底色 + 墨色推出整套 CSS 变量
function themePalette(bgHex, inkHex) {
  const bg = _hexToRgb(bgHex);
  const ink = _hexToRgb(inkHex);
  const line = _mix(ink, bg, 0.12);
  const panel = _mix(bg, _WHITE, 0.25);
  const rgbStr = (c) => c.map(Math.round).join(" ");
  return {
    "--c-bg": _rgbToHex(bg),
    "--c-btn-bg": _rgbToHex(_mix(bg, _WHITE, 0.12)),
    "--c-text": _rgbToHex(ink),
    "--c-btn-shadow": _rgbToHex(line),
    "--c-dark": _rgbToHex(_mix(ink, bg, 0.25)),
    "--c-mid": _rgbToHex(_mix(ink, bg, 0.7)),
    "--c-light": _rgbToHex(_mix(bg, _WHITE, 0.55)),
    // 头像背景格子：比底色稍微深一点点
    "--c-dead": _rgbToHex(_mix(bg, ink, 0.05)),
    "--ink-rgb": rgbStr(ink),
    "--line-rgb": rgbStr(line),
    "--panel-rgb": rgbStr(panel),
  };
}

// 「自动底色」「自动墨色」按钮：按另一个颜色配一个同色相、深浅相反的颜色。
// 很深、很浅两个候选都算出来，挑和原色对比度更高的那个（紫、红这类中间亮度的颜色单看明暗容易挑错）
function contrastColor(hex) {
  const [r, g, b] = _hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const targetS = Math.min(s, 0.35);
  // HSL → RGB
  const fromHsl = (targetL) => {
    const q = targetL < 0.5 ? targetL * (1 + targetS) : targetL + targetS - targetL * targetS;
    const p = 2 * targetL - q;
    const hue = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return _rgbToHex([hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => v * 255));
  };
  // WCAG 对比度
  const lum = (x) => {
    const [R, G, B] = _hexToRgb(x).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const contrast = (x) => {
    const [lo, hi] = [lum(x), lum(hex)].sort((m, n) => m - n);
    return (hi + 0.05) / (lo + 0.05);
  };
  const dark = fromHsl(0.15), light = fromHsl(0.85);
  return contrast(dark) >= contrast(light) ? dark : light;
}

// 现在的配色：{ id, bg, ink }（id 是预设名或 "custom"）
let currentTheme = THEME_PRESETS[0];
try {
  const saved = JSON.parse(localStorage.getItem(_THEME_KEY) || "null");
  if (saved?.id === "custom" && saved.bg && saved.ink) currentTheme = saved;
  else if (saved?.id) currentTheme = THEME_PRESETS.find((t) => t.id === saved.id) || currentTheme;
} catch (_) {}

function _applyThemeVars(theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themePalette(theme.bg, theme.ink))) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
}
_applyThemeVars(currentTheme);

function setTheme(theme) {
  currentTheme = theme;
  _applyThemeVars(theme);
  try {
    localStorage.setItem(_THEME_KEY, JSON.stringify(theme.id === "custom" ? theme : { id: theme.id }));
  } catch (_) {}
  // 像素图标、头像、画板这些画在 canvas 上的东西，收到这个事件后按新墨色重画
  document.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

// 画 canvas 用的墨色 / 底色（画板每一帧每个格子都会调用，按配色缓存，不重复解析）
let _inkCache = { hex: null, rgb: null };
function themeInkRGB() {
  if (_inkCache.hex !== currentTheme.ink) _inkCache = { hex: currentTheme.ink, rgb: _hexToRgb(currentTheme.ink) };
  return _inkCache.rgb;
}
function themeInk(alpha = 1) {
  const [r, g, b] = themeInkRGB();
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}
function themeBg() {
  return currentTheme.bg;
}
