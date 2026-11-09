/* =====================================================================
 * 指尖绽放 · Bloom at Fingertips
 * 手势控制花朵绽放 —— MediaPipe Hands + Canvas 2D + Web Audio
 * 视觉：宣纸／淡墨／朱砂；四季靠光、雾、水纹、风、纸纹区分
 * ===================================================================== */

/* ---------------- 可调参数（集中配置，便于调参） ---------------- */
const CONFIG = {
  // 绽放弹簧：比旧版更慢、更软，留出一次呼吸的余地
  spring: { k: 34, d: 9.6 },
  // 手指伸展比映射区间（指尖到腕距 / 指根到腕距 的均值）
  open: { min: 1.02, max: 1.72 },
  // 拇指-食指捏合距离（归一化）：低于 closed 视为捏合收拢
  pinch: { closed: 0.16, open: 0.72 },
  // 左手换花判定（全部基于屏幕空间方向）
  swipe: {
    minOpen: 0.5,
    dist: 0.20,
    windowMs: 800,
    cooldownMs: 1000,
  },
  hands: { swap: false },
  camera: { width: { ideal: 1280 }, height: { ideal: 720 } },
  mp: {
    bundle:    "./vendor/mediapipe/vision_bundle.mjs",
    bundleAlt: "./vendor/mediapipe/vision_bundle.js",
    wasm:      "./vendor/mediapipe/wasm",
    model:     "./vendor/models/hand_landmarker.task",
  },
  transitionDur: 1.9,   // 换季：整幅画的色、光、雾一起渡过去
  handAway: { holdMs: 1200, rest: 0.30 },
  demo: { scale: 1.12 },
  music: {
    url: "assets/music/yongshang-video-loop.mp3",
    gain: 0.24,         // 默认很低
    fadeIn: 6,          // 六秒淡入
  },
};

/* ---------------- 小工具 ---------------- */
const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth  = v => { v = clamp01(v); return v * v * (3 - 2 * v); };
const lerp    = (a, b, k) => a + (b - a) * k;
const mix3    = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const rgba    = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const TAU = Math.PI * 2;
const rnd = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const params = new URLSearchParams(location.search);
const lockBloom = (() => {
  const v = parseFloat(params.get("bloom"));
  return Number.isFinite(v) ? clamp01(v) : null;
})();
const lockFlower = (() => {
  const v = parseInt(params.get("f"), 10);
  return Number.isFinite(v) ? v : null;
})();
const STILL = params.get("still") === "1";   // 截图/静态检查：不请求摄像头与音频
const DEMO_START = params.get("demo") === "1";

/* ---------------- 全局状态 ---------------- */
const state = {
  time: 0,
  bloom: 0,
  bloomVel: 0,
  manualBloom: 0,
  flowerIndex: 0,
  transition: null,
  particles: [],
  partAcc: 0,
  burst: [],
  hands: { right: null, left: null },
  handSeen: { right: 0, left: 0 },
  handCount: 0,
  mode: "loading",
  loadingMsg: "正在加载手势库…",
  libraryError: "",
  demo: false,
  still: STILL,
  noHandSince: 0,
};

/* ---------------- DOM ---------------- */
const stage   = document.getElementById("stage");
const ctx     = stage.getContext("2d");
const video   = document.getElementById("cam");
const skel    = document.getElementById("skel");
const skelCtx = skel.getContext("2d");
const el = {
  nameZh:     document.getElementById("flowerNameZh"),
  season:     document.getElementById("flowerSeason"),
  quote:      document.getElementById("flowerQuote"),
  camWrap:    document.getElementById("camWrap"),
  toast:      document.getElementById("toast"),
  gate:       document.getElementById("gate"),
  startBtn:   document.getElementById("startBtn"),
  soundBtn:   document.getElementById("soundBtn"),
  muteGlyph:  document.getElementById("muteGlyph"),
  reveal:     document.getElementById("reveal"),
  blackout:   document.getElementById("blackout"),
  errDetail:  document.getElementById("errDetail"),
  tagLeft:    document.getElementById("tagLeft"),
  tagRight:   document.getElementById("tagRight"),
};

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  stage.width = W * DPR; stage.height = H * DPR;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingQuality = "high";
}
window.addEventListener("resize", resize);
resize();

/* =====================================================================
 * 花瓣基础形状（贴图失败时的程序化降级）
 * =================================================================== */
function petalPath(c, len, wid, curl = 0.25) {
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(-wid, -len * 0.18, -wid * 1.06, -len * 0.62, -curl * wid, -len * 0.93);
  c.quadraticCurveTo(0, -len * 1.07, curl * wid, -len * 0.93);
  c.bezierCurveTo(wid * 1.06, -len * 0.62, wid, -len * 0.18, 0, 0);
  c.closePath();
}
function pointedPetal(c, len, wid) {
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(-wid, -len * 0.28, -wid * 0.72, -len * 0.78, 0, -len);
  c.bezierCurveTo(wid * 0.72, -len * 0.78, wid, -len * 0.28, 0, 0);
  c.closePath();
}
function layerBloom(b, delay) {
  return smooth((b - delay * 0.55) / (1 - delay * 0.55));
}
function drawPetalRing(c, { n, len, wid, rot, delay, g0, g1, curl, pointed, breathe }, lb, t, seedBase) {
  if (lb <= 0.002) return;
  const br = Math.sin(t * 0.6 + seedBase) * 0.025 * (breathe ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rot + br;
    const jit = (rnd(seedBase * 91 + i * 7) - 0.5) * 0.12;
    const L = len * (0.16 + 0.84 * lb) * (1 + jit * 0.5);
    const Wd = wid * L * (0.55 + 0.45 * lb);
    const off = lb * L * 0.15;
    c.save();
    c.rotate(a + jit);
    c.translate(0, -off);
    const g = c.createLinearGradient(0, 0, 0, -L);
    g.addColorStop(0, g0);
    g.addColorStop(1, g1);
    c.fillStyle = g;
    if (pointed) pointedPetal(c, L, Wd);
    else petalPath(c, L, Wd, curl + 0.12 * rnd(i + seedBase));
    c.fill();
    c.restore();
  }
}
function drawStamens(c, amount, color, dotColor, maxLen = 0.16, count = 26) {
  if (amount <= 0.03) return;
  c.save();
  c.globalAlpha = amount;
  c.strokeStyle = color;
  c.fillStyle = dotColor;
  c.lineWidth = 0.011;
  for (let i = 0; i < count; i++) {
    const a = rnd(i * 3.3) * TAU;
    const l = (0.05 + rnd(i * 7.7) * maxLen) * amount;
    const x = Math.cos(a) * l, y = Math.sin(a) * l;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(x, y); c.stroke();
    c.beginPath(); c.arc(x, y, 0.015, 0, TAU); c.fill();
  }
  c.restore();
}

/* ---------------- 程序化花朵（仅作降级） ---------------- */
function drawPeony(c, b, t) {
  drawPetalRing(c, { n: 12, len: 1.00, wid: 0.40, rot: 0.12, delay: 0.00, g0: "#ff9ec4", g1: "#ffe9f2", curl: 0.24, breathe: 1 }, layerBloom(b, 0.00), t, 1);
  drawPetalRing(c, { n: 9,  len: 0.82, wid: 0.44, rot: 0.48, delay: 0.12, g0: "#f87fb0", g1: "#ffd3e5", curl: 0.20, breathe: 1 }, layerBloom(b, 0.12), t, 2);
  drawPetalRing(c, { n: 7,  len: 0.62, wid: 0.48, rot: 0.05, delay: 0.24, g0: "#ef5f9c", g1: "#ffb9d6", curl: 0.18, breathe: 1 }, layerBloom(b, 0.24), t, 3);
  drawPetalRing(c, { n: 5,  len: 0.42, wid: 0.52, rot: 0.62, delay: 0.36, g0: "#e0447f", g1: "#ff97c2", curl: 0.15, breathe: 1 }, layerBloom(b, 0.36), t, 4);
  drawStamens(c, layerBloom(b, 0.30), "#e0a93e", "#ffd97a", 0.15, 30);
}
function drawGardenia(c, b, t) {
  drawPetalRing(c, { n: 6, len: 1.06, wid: 0.26, rot: 0.00, delay: 0.00, g0: "#f0e6c8", g1: "#ffffff", curl: 0.10, breathe: 1 }, layerBloom(b, 0.00), t, 11);
  drawPetalRing(c, { n: 6, len: 0.78, wid: 0.23, rot: Math.PI / 6, delay: 0.20, g0: "#e9dbb2", g1: "#fdfbf2", curl: 0.08, breathe: 1 }, layerBloom(b, 0.20), t, 12);
  const cb = layerBloom(b, 0.15);
  if (cb > 0.03) {
    c.save();
    c.globalAlpha = cb;
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 0.14);
    g.addColorStop(0, "#f5e6b8"); g.addColorStop(1, "rgba(245,230,184,0)");
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, 0.14, 0, TAU); c.fill();
    c.restore();
  }
  drawStamens(c, layerBloom(b, 0.25), "#d9c06a", "#f5e6b8", 0.08, 14);
}
function drawRose(c, b, t) {
  drawPetalRing(c, { n: 6, len: 1.04, wid: 0.42, rot: 0.30, delay: 0.00, g0: "#a4133c", g1: "#ff6d8f", curl: 0.30, breathe: 1 }, layerBloom(b, 0.00), t, 21);
  const N = 30;
  const expand = 0.24 + b * 0.60;
  for (let i = N; i >= 1; i--) {
    const k = i / N;
    const a = i * 2.399963 + t * 0.03;
    const r = Math.sqrt(k) * expand;
    const s = (0.14 + 0.34 * k) * (0.45 + 0.65 * b);
    c.save();
    c.translate(Math.cos(a) * r, Math.sin(a) * r);
    c.rotate(a + Math.PI / 2 + Math.sin(t * 0.4 + i) * 0.02);
    const g = c.createLinearGradient(0, 0, 0, -s);
    if (k > 0.5) { g.addColorStop(0, "#8f1136"); g.addColorStop(1, "#ff4d6d"); }
    else         { g.addColorStop(0, "#590d22"); g.addColorStop(1, "#c9184a"); }
    c.fillStyle = g;
    petalPath(c, s, s * 0.85, 0.35);
    c.fill();
    c.restore();
  }
}
/* 缢裂中的细胞轮廓：腰线在 x=0，从上下两端缢入 */
function divisionCellPath(c, R, el, pinch, tt = 0) {
  c.beginPath();
  const N = 84;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    // 缢裂沟较宽、平滑过渡，避免出现尖角
    const waist = 1 - pinch * Math.exp(-Math.pow(Math.cos(a) / 0.52, 2));
    const wob = 0.005 * Math.sin(a * 5 + tt * 0.9) * (0.2 + 0.8 * pinch);
    const rMod = 1 + 0.011 * Math.sin(a * 2 + 1.1) + 0.006 * Math.sin(a * 3 - 0.6) + wob;
    const x = Math.cos(a) * R * el * rMod;
    const y = Math.sin(a) * R * 0.96 * waist * rMod;
    i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
  }
  c.closePath();
}

/* 一条姐妹染色单体：V 形，尖端（着丝点）朝向所在极 */
function drawChromatid(c, x, y, dir, s, color, rot) {
  c.save();
  c.translate(x, y);
  if (rot) c.rotate(rot);
  c.strokeStyle = color;
  c.lineWidth = 0.013;
  c.lineCap = "round";
  c.beginPath();
  if (dir < 0) {
    c.moveTo(s * 0.58, -s * 0.58);
    c.quadraticCurveTo(-s * 0.08, 0, s * 0.58, s * 0.58);
  } else {
    c.moveTo(-s * 0.58, -s * 0.58);
    c.quadraticCurveTo(s * 0.08, 0, -s * 0.58, s * 0.58);
  }
  c.stroke();
  c.fillStyle = color;
  c.beginPath();
  c.arc(dir * s * 0.08, 0, s * 0.11, 0, TAU);
  c.fill();
  c.restore();
}

/* 夏：有丝分裂（间期→前期→中期→后期→末期）→ 子细胞长成小鱼 */
function drawCellFish(c, b, t) {
  /* 各阶段的连续进度（bloom 0 → 1） */
  const chrCond = smooth((b - 0.08) / 0.16);      // 前期：染色质浓缩
  const envA    = 1 - smooth((b - 0.18) / 0.10);  // 前中期：核膜解体
  const meta    = smooth((b - 0.28) / 0.14);      // 中期：排到赤道板
  const ana     = smooth((b - 0.44) / 0.09);      // 后期：单体快速分离
  const telo    = smooth((b - 0.54) / 0.14);      // 末期：缢裂、核膜重建
  const splitA  = smooth((b - 0.66) / 0.05);      // 两个子细胞分开
  const fishA   = smooth((b - 0.72) / 0.08);      // 子细胞长成小鱼
  const leftA   = 1 - smooth((b - 0.72) / 0.09);  // 左侧子细胞淡出
  const rightCellA = 1 - smooth((b - 0.74) / 0.09);

  const R = 0.40;
  // 8 条染色体：赤道板位置、前期散乱位置、大小
  const CHR = [
    [-0.158, -0.07, -0.10, 0.046],
    [-0.112, 0.06, -0.06, 0.040],
    [-0.066, -0.04, 0.00, 0.052],
    [-0.020, 0.08, 0.07, 0.036],
    [0.024, -0.09, -0.02, 0.044],
    [0.070, 0.05, 0.10, 0.050],
    [0.116, -0.06, 0.05, 0.038],
    [0.162, 0.07, -0.07, 0.045]
  ];
  const sep = 0.020 + 0.190 * ana;
  const poleX = 0.16 + 0.14 * smooth((b - 0.14) / 0.24);
  const el = 1 + 0.16 * ana + 0.06 * telo;
  const pinch = 0.94 * telo;

  /* ===== 1. 分裂中的母细胞 ===== */
  if (splitA < 0.995) {
    c.save();
    c.globalAlpha = Math.pow(1 - splitA, 1.5);
    c.translate(Math.sin(t * 0.4) * 0.006, Math.cos(t * 0.35) * 0.005);

    // 胞质外晕
    const halo = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * 1.5);
    halo.addColorStop(0, "rgba(150,196,178,0.14)");
    halo.addColorStop(1, "rgba(150,196,178,0)");
    c.fillStyle = halo;
    c.beginPath(); c.arc(0, 0, R * 1.5, 0, TAU); c.fill();

    // 细胞膜（双层）
    divisionCellPath(c, R, el, pinch, t);
    const cyto = c.createRadialGradient(-R * 0.22, -R * 0.26, R * 0.06, 0, 0, R * 1.1);
    cyto.addColorStop(0, "rgba(238,249,243,0.97)");
    cyto.addColorStop(0.55, "rgba(204,231,219,0.94)");
    cyto.addColorStop(1, "rgba(157,196,181,0.90)");
    c.fillStyle = cyto;
    c.fill();
    c.strokeStyle = "rgba(52,92,78,0.52)";
    c.lineWidth = 0.010;
    c.stroke();
    c.save();
    c.scale(0.972, 0.972);
    divisionCellPath(c, R, el, pinch, t);
    c.strokeStyle = "rgba(52,92,78,0.18)";
    c.lineWidth = 0.0035;
    c.stroke();
    c.restore();

    // 线粒体（6 个，大小与朝向略有差异）
    const mito = [
      [-0.235, -0.15, 0.45, 1.00],
      [0.225, -0.20, -0.35, 0.92],
      [-0.24, 0.17, -0.65, 0.96],
      [0.235, 0.17, 0.25, 0.88],
      [-0.19, -0.27, 0.15, 0.78],
      [0.19, 0.27, -0.15, 0.80]
    ];
    for (const [x, y, rot, k] of mito) {
      c.save();
      c.translate(x, y);
      c.rotate(rot + Math.sin(t * 0.3 + x * 10) * 0.04);
      c.fillStyle = "rgba(174,212,195,0.55)";
      c.beginPath(); c.ellipse(0, 0, 0.06 * k, 0.026 * k, 0, 0, TAU); c.fill();
      c.strokeStyle = "rgba(58,96,84,0.28)";
      c.lineWidth = 0.0045;
      c.stroke();
      c.beginPath();
      c.moveTo(-0.04 * k, 0);
      c.quadraticCurveTo(-0.012 * k, -0.013 * k, 0.006 * k, 0);
      c.quadraticCurveTo(0.026 * k, 0.013 * k, 0.044 * k, 0);
      c.stroke();
      c.restore();
    }

    // 高尔基体：几层略弯的膜囊
    c.save();
    c.translate(0.27, -0.02);
    c.rotate(-0.25);
    c.strokeStyle = "rgba(120,166,148,0.30)";
    c.lineWidth = 0.0045;
    for (let k = 0; k < 4; k++) {
      c.beginPath();
      c.arc(0, 0, 0.045 + k * 0.008, 0.35, 1.65);
      c.stroke();
    }
    c.fillStyle = "rgba(200,228,216,0.55)";
    for (let k = 0; k < 2; k++) {
      c.beginPath();
      c.arc(0.05 + k * 0.02, 0.05, 0.006, 0, TAU);
      c.fill();
    }
    c.restore();

    // 内质网
    c.strokeStyle = "rgba(120,166,148,0.30)";
    c.lineWidth = 0.0045;
    for (const off of [0, 0.017]) {
      c.beginPath();
      c.moveTo(-0.33, -0.05 + off);
      c.bezierCurveTo(-0.26, -0.14 + off, -0.20, -0.01 + off, -0.135, -0.08 + off);
      c.stroke();
    }

    // 溶酶体与小囊泡
    const ves = [
      [-0.10, -0.30, 0.012], [0.31, -0.04, 0.010], [0.10, 0.28, 0.013], [-0.32, 0.25, 0.009],
      [-0.30, -0.27, 0.006], [0.33, 0.20, 0.007], [0.07, -0.31, 0.007], [-0.29, 0.04, 0.008]
    ];
    for (const [x, y, r] of ves) {
      c.fillStyle = "rgba(218,238,229,0.68)";
      c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      c.strokeStyle = "rgba(58,96,84,0.22)";
      c.lineWidth = 0.0035;
      c.stroke();
    }
    c.fillStyle = "rgba(130,172,156,0.40)";
    for (const [x, y] of [[-0.19, 0.28], [0.28, 0.08], [0.02, -0.32]]) {
      c.beginPath(); c.arc(x, y, 0.010, 0, TAU); c.fill();
    }

    // 胞质中的核糖体颗粒
    c.fillStyle = "rgba(120,164,148,0.15)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 4.7) * TAU;
      const rr = Math.sqrt(rnd(i * 8.3)) * R * 0.92;
      c.beginPath();
      c.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.94, 0.0042, 0, TAU);
      c.fill();
    }

    // 纺锤体：桶状轮廓、动粒微管、极间微管、中心体与星射线
    const spindleA = smooth((b - 0.20) / 0.10) * (1 - smooth((b - 0.68) / 0.05));
    if (spindleA > 0.02) {
      c.save();
      c.globalAlpha *= spindleA;
      c.strokeStyle = "rgba(92,132,118,0.07)";
      c.lineWidth = 0.004;
      for (const yy of [-0.19, 0.19]) {
        c.beginPath();
        c.moveTo(-poleX, 0);
        c.quadraticCurveTo(0, yy, poleX, 0);
        c.stroke();
      }
      for (const s of [-1, 1]) {
        // 动粒微管：每条染色单体一束
        for (let i = 0; i < CHR.length; i++) {
          const x2 = s * sep, y2 = CHR[i][0];
          c.strokeStyle = "rgba(72,108,96,0.16)";
          c.lineWidth = 0.0035;
          for (const off of [-0.006, 0.006]) {
            c.beginPath();
            c.moveTo(s * poleX, off);
            c.quadraticCurveTo((s * poleX + x2) / 2 + s * 0.02, y2 * 0.55, x2, y2);
            c.stroke();
          }
        }
        // 极间微管：越赤道伸向对侧
        c.strokeStyle = "rgba(72,108,96,0.10)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 5; k++) {
          const yEnd = -0.14 + k * 0.07;
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.quadraticCurveTo(s * 0.02, yEnd * 0.4, -s * 0.10, yEnd);
          c.stroke();
        }
        // 星射线
        c.strokeStyle = "rgba(72,108,96,0.13)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * TAU;
          const len = 0.035 + 0.03 * (0.5 + 0.5 * Math.sin(k * 2.3));
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.lineTo(s * poleX + Math.cos(a) * len, Math.sin(a) * len);
          c.stroke();
        }
        // 中心体：一对相互垂直的中心粒
        c.fillStyle = "rgba(58,96,84,0.55)";
        c.beginPath();
        c.ellipse(s * poleX, -0.010, 0.010, 0.004, Math.PI / 2, 0, TAU);
        c.fill();
        c.beginPath();
        c.ellipse(s * poleX + (s < 0 ? -0.015 : 0.015), 0.002, 0.010, 0.004, 0, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 核膜、核仁、染色质细丝（前期逐渐解体）
    if (envA > 0.02) {
      c.save();
      c.globalAlpha *= envA;
      const nr = 0.16;
      const ng = c.createRadialGradient(-nr * 0.35, -nr * 0.4, nr * 0.1, 0, 0, nr);
      ng.addColorStop(0, "rgba(238,249,244,0.62)");
      ng.addColorStop(1, "rgba(190,223,208,0.40)");
      c.fillStyle = ng;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(58,96,84,0.38)";
      c.lineWidth = 0.008;
      c.stroke();
      c.strokeStyle = "rgba(58,96,84,0.20)";
      c.lineWidth = 0.004;
      c.beginPath(); c.arc(0, 0, nr * 0.92, 0, TAU); c.stroke();

      // 染色质细丝
      c.strokeStyle = `rgba(126,170,153,${0.55 * (1 - chrCond)})`;
      c.lineWidth = 0.006;
      for (let i = 0; i < 4; i++) {
        const a0 = i * 1.7 + t * 0.05;
        c.beginPath();
        c.moveTo(Math.cos(a0) * nr * 0.55, Math.sin(a0) * nr * 0.55);
        c.bezierCurveTo(
          Math.cos(a0 + 0.9) * nr * 0.8, Math.sin(a0 + 0.9) * nr * 0.8,
          Math.cos(a0 + 0.4) * nr * 0.25, Math.sin(a0 + 0.4) * nr * 0.25,
          Math.cos(a0) * nr * 0.1, Math.sin(a0) * nr * 0.1
        );
        c.stroke();
      }

      // 核仁（比核膜更早消失）
      c.save();
      c.globalAlpha *= Math.pow(envA, 1.2);
      const nol = c.createRadialGradient(-0.02, -0.03, 0.003, 0.015, 0.01, 0.045);
      nol.addColorStop(0, "rgba(96,142,124,0.65)");
      nol.addColorStop(1, "rgba(120,164,146,0.42)");
      c.fillStyle = nol;
      c.beginPath(); c.arc(0.015, 0.01, 0.045, 0, TAU); c.fill();
      c.restore();
      c.restore();
    }

    // 核膜解体后散落的膜小泡
    const envVesA = smooth((b - 0.19) / 0.08) * (1 - smooth((b - 0.36) / 0.08));
    if (envVesA > 0.02) {
      c.save();
      c.globalAlpha *= envVesA;
      c.fillStyle = "rgba(120,164,148,0.32)";
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU + 0.3;
        const rr = 0.16 + 0.02 * Math.sin(k * 1.7 + t * 0.8);
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0055, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 染色体：前期浓缩、中期排队、后期分离、末期解聚
    const chrA = smooth((b - 0.08) / 0.12) * (1 - smooth((b - 0.55) / 0.08));
    if (chrA > 0.02) {
      for (let i = 0; i < CHR.length; i++) {
        const jy = (rnd(i * 3.3) - 0.5) * 0.030 * meta;
        const jx = (rnd(i * 7.1) - 0.5) * 0.028 * meta;
        const tilt = (rnd(i * 5.9) - 0.5) * 0.75 * meta;
        const sway = Math.sin(t * 0.8 + i * 1.9) * 0.0045 * meta;
        const y = lerp(CHR[i][2], CHR[i][0], meta) + jy + sway;
        const bx = lerp(CHR[i][1], 0, meta) + jx;
        const size = CHR[i][3] * (1 - 0.45 * telo);   // 末期解聚、臂缩短
        const color = `rgba(146,74,78,${(0.70 + 0.12 * rnd(i * 9.4)) * chrA})`;
        drawChromatid(c, bx - sep, y, -1, size, color, tilt);
        drawChromatid(c, bx + sep, y, 1, size, color, tilt);
      }
    }

    // 末期：两极重建新核（双层核膜、染色质解聚、核仁再现）
    const nucNewA = smooth((b - 0.55) / 0.10);
    if (nucNewA > 0.02) {
      c.save();
      c.globalAlpha *= nucNewA;
      for (const s of [-1, 1]) {
        const nx = s * (0.17 + 0.045 * telo);
        const nr = 0.055 + 0.030 * telo;
        const ng2 = c.createRadialGradient(nx - nr * 0.3, -nr * 0.35, 0.005, nx, 0, nr);
        ng2.addColorStop(0, "rgba(236,248,242,0.75)");
        ng2.addColorStop(1, "rgba(196,226,212,0.50)");
        c.fillStyle = ng2;
        c.beginPath(); c.arc(nx, 0, nr, 0, TAU); c.fill();
        c.strokeStyle = "rgba(58,96,84,0.36)";
        c.lineWidth = 0.0055;
        c.stroke();
        c.strokeStyle = "rgba(58,96,84,0.18)";
        c.lineWidth = 0.003;
        c.beginPath(); c.arc(nx, 0, nr * 0.90, 0, TAU); c.stroke();

        // 解聚中的染色质细丝
        c.strokeStyle = "rgba(126,170,153,0.34)";
        c.lineWidth = 0.004;
        for (let k = 0; k < 2; k++) {
          c.beginPath();
          c.moveTo(nx - nr * 0.32, -nr * 0.22 + k * nr * 0.28);
          c.quadraticCurveTo(nx + nr * 0.05, -nr * 0.02 + k * nr * 0.24, nx + nr * 0.30, nr * 0.14 - k * nr * 0.10);
          c.stroke();
        }

        // 核仁稍晚出现
        const nolA = smooth((b - 0.62) / 0.08);
        if (nolA > 0.02) {
          c.save();
          c.globalAlpha *= nolA;
          c.fillStyle = "rgba(92,136,118,0.50)";
          c.beginPath(); c.arc(nx + nr * 0.18, -nr * 0.16, nr * 0.25, 0, TAU); c.fill();
          c.restore();
        }
      }
      c.restore();
    }

    // 缢裂处残留的中间体
    if (telo > 0.15 && splitA < 0.6) {
      c.strokeStyle = `rgba(96,140,122,${0.45 * telo})`;
      c.lineWidth = 0.011;
      c.lineCap = "round";
      c.beginPath(); c.moveTo(-0.035, 0); c.lineTo(0.035, 0); c.stroke();
    }

    c.restore();
  }

  /* ===== 2. 两个子细胞 ===== */
  if (splitA > 0.02) {
    for (const s of [-1, 1]) {
      const alpha = splitA * (s < 0 ? leftA : rightCellA);
      if (alpha <= 0.02) continue;
      c.save();
      c.globalAlpha = alpha;
      c.translate(s * 0.225, 0);

      const rx = 0.198, ry = 0.224;
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const cg = c.createRadialGradient(-rx * 0.3, -ry * 0.35, 0.02, 0, 0, rx);
      cg.addColorStop(0, "rgba(238,249,243,0.97)");
      cg.addColorStop(0.55, "rgba(204,231,219,0.94)");
      cg.addColorStop(1, "rgba(157,196,181,0.90)");
      c.fillStyle = cg;
      c.fill();
      c.strokeStyle = "rgba(52,92,78,0.50)";
      c.lineWidth = 0.008;
      c.stroke();
      c.save();
      c.scale(0.965, 0.965);
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      c.strokeStyle = "rgba(52,92,78,0.16)";
      c.lineWidth = 0.003;
      c.stroke();
      c.restore();

      // 新细胞核：双层核膜、核仁、少量染色质（略偏，避免"煎蛋"式对称）
      const nr = 0.082;
      c.save();
      c.translate(-0.020, -0.012);
      const ng3 = c.createRadialGradient(-nr * 0.3, -nr * 0.35, 0.01, 0, 0, nr);
      ng3.addColorStop(0, "rgba(232,246,239,0.85)");
      ng3.addColorStop(1, "rgba(186,220,205,0.62)");
      c.fillStyle = ng3;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(58,96,84,0.40)";
      c.lineWidth = 0.0055;
      c.stroke();
      c.strokeStyle = "rgba(58,96,84,0.18)";
      c.lineWidth = 0.003;
      c.beginPath(); c.arc(0, 0, nr * 0.90, 0, TAU); c.stroke();
      c.strokeStyle = "rgba(126,170,153,0.30)";
      c.lineWidth = 0.004;
      c.beginPath();
      c.moveTo(-nr * 0.35, nr * 0.10);
      c.quadraticCurveTo(0, -nr * 0.28, nr * 0.38, nr * 0.05);
      c.stroke();
      c.beginPath();
      c.moveTo(-nr * 0.22, -nr * 0.30);
      c.quadraticCurveTo(nr * 0.10, -nr * 0.05, nr * 0.24, nr * 0.28);
      c.stroke();
      c.fillStyle = "rgba(92,136,118,0.52)";
      c.beginPath(); c.arc(nr * 0.22, -nr * 0.18, nr * 0.28, 0, TAU); c.fill();
      c.restore();

      // 少量细胞器
      c.fillStyle = "rgba(174,212,195,0.52)";
      c.strokeStyle = "rgba(58,96,84,0.26)";
      c.lineWidth = 0.0035;
      for (const [x, y, rot] of [[-0.09, 0.13, 0.5], [0.10, -0.14, -0.3]]) {
        c.save();
        c.translate(x, y);
        c.rotate(rot);
        c.beginPath(); c.ellipse(0, 0, 0.045, 0.019, 0, 0, TAU);
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(-0.028, 0);
        c.quadraticCurveTo(-0.005, -0.009, 0.010, 0);
        c.stroke();
        c.restore();
      }
      // 高尔基体与内质网
      c.save();
      c.translate(0.108, 0.080);
      c.rotate(-0.35);
      c.strokeStyle = "rgba(120,166,148,0.30)";
      c.lineWidth = 0.0035;
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        c.arc(0, 0, 0.024 + k * 0.006, 0.40, 1.70);
        c.stroke();
      }
      c.restore();
      c.strokeStyle = "rgba(120,166,148,0.28)";
      c.lineWidth = 0.0035;
      c.beginPath();
      c.moveTo(-0.155, 0.105);
      c.bezierCurveTo(-0.115, 0.150, -0.060, 0.080, -0.010, 0.130);
      c.stroke();

      c.fillStyle = "rgba(218,238,229,0.70)";
      for (const [x, y, r] of [[-0.11, -0.12, 0.010], [0.12, 0.12, 0.009], [0.14, 0.03, 0.006], [-0.05, 0.16, 0.006], [0.02, 0.17, 0.005], [0.15, -0.05, 0.007], [-0.14, 0.06, 0.008]]) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      }
      c.fillStyle = "rgba(120,164,148,0.16)";
      for (let i = 0; i < 10; i++) {
        const a = rnd(i * 4.1) * TAU;
        const rr = Math.sqrt(rnd(i * 6.7)) * 0.19;
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0035, 0, TAU);
        c.fill();
      }

      c.restore();
    }
  }

  /* ---------- 小鱼 ---------- */
  if (fishA > 0.02) {
    const g = 0.50 + 0.50 * smooth((b - 0.72) / 0.20);
    const fx = 0.225 * (1 - smooth((b - 0.74) / 0.22));   // 从右侧子细胞游向画面中心
    const wiggle = Math.sin(t * 1.15) * (0.05 + 0.10 * b);

    c.save();
    c.globalAlpha = fishA;
    c.translate(fx + Math.sin(t * 0.42) * 0.015, Math.cos(t * 0.57) * 0.012 + 0.015 * (1 - g));
    c.scale(g * 1.18, g * 1.18);
    c.rotate(Math.sin(t * 0.9) * 0.012);

    // 尾鳍：先画在鱼身之后
    const tailA = smooth((b - 0.77) / 0.07);
    if (tailA > 0.02) {
      c.save();
      c.globalAlpha *= tailA;
      c.translate(-0.36, 0);
      c.rotate(wiggle * 0.8);
      const tl = 0.24, sp = 0.20;
      c.beginPath();
      c.moveTo(0, 0);
      c.quadraticCurveTo(-tl * 0.55, -sp * 1.05, -tl, -sp * 1.18);
      c.quadraticCurveTo(-tl * 0.78, -sp * 0.15, -tl * 0.95, 0);
      c.quadraticCurveTo(-tl * 0.78, sp * 0.15, -tl, sp * 1.18);
      c.quadraticCurveTo(-tl * 0.55, sp * 1.05, 0, 0);
      c.closePath();
      const tg = c.createLinearGradient(0, 0, -tl, 0);
      tg.addColorStop(0, "rgba(170,206,192,0.55)");
      tg.addColorStop(1, "rgba(214,235,227,0.16)");
      c.fillStyle = tg;
      c.fill();
      c.strokeStyle = "rgba(58,96,84,0.35)";
      c.lineWidth = 0.008;
      c.stroke();
      c.strokeStyle = "rgba(58,96,84,0.22)";
      c.lineWidth = 0.006;
      for (let i = -2; i <= 2; i++) {
        c.beginPath();
        c.moveTo(0, 0);
        c.quadraticCurveTo(-tl * 0.6, sp * i * 0.36, -tl * 0.95, sp * i * 0.46);
        c.stroke();
      }
      c.restore();
    }

    // 背鳍 / 腹鳍
    const finA = smooth((b - 0.84) / 0.07);
    if (finA > 0.02) {
      c.save();
      c.globalAlpha *= finA;
      c.fillStyle = "rgba(168,206,190,0.42)";
      c.strokeStyle = "rgba(58,96,84,0.30)";
      c.lineWidth = 0.007;
      c.beginPath();
      c.moveTo(-0.28, -0.105);
      c.quadraticCurveTo(-0.14, -0.44, 0.12, -0.20);
      c.quadraticCurveTo(-0.02, -0.17, -0.28, -0.105);
      c.closePath(); c.fill(); c.stroke();
      c.strokeStyle = "rgba(58,96,84,0.20)";
      c.lineWidth = 0.005;
      for (let i = 1; i <= 3; i++) {
        c.beginPath();
        c.moveTo(-0.26 + i * 0.02, -0.115);
        c.quadraticCurveTo(-0.14, -0.30 - i * 0.02, -0.16 + i * 0.10, -0.150 - i * 0.012);
        c.stroke();
      }
      c.strokeStyle = "rgba(58,96,84,0.30)";
      c.lineWidth = 0.007;
      c.beginPath();
      c.moveTo(-0.10, 0.135);
      c.quadraticCurveTo(-0.02, 0.30, 0.10, 0.180);
      c.quadraticCurveTo(0.03, 0.155, -0.10, 0.135);
      c.closePath(); c.fill(); c.stroke();
      c.restore();
    }

    // 鱼身
    c.beginPath();
    c.moveTo(0.52, 0);
    c.bezierCurveTo(0.44, -0.20, 0.14, -0.31, -0.20, -0.15);
    c.bezierCurveTo(-0.30, -0.10, -0.34, -0.05, -0.38, 0);
    c.bezierCurveTo(-0.34, 0.05, -0.30, 0.10, -0.20, 0.15);
    c.bezierCurveTo(0.14, 0.31, 0.44, 0.20, 0.52, 0);
    c.closePath();
    const bg = c.createLinearGradient(0, -0.30, 0, 0.30);
    bg.addColorStop(0, "rgba(214,236,226,0.95)");
    bg.addColorStop(0.45, "rgba(176,212,196,0.95)");
    bg.addColorStop(1, "rgba(126,172,154,0.9)");
    c.fillStyle = bg;
    c.fill();
    c.strokeStyle = "rgba(48,88,76,0.50)";
    c.lineWidth = 0.010;
    c.stroke();

    // 鳞：几道很淡的弧
    c.save();
    c.clip();
    c.strokeStyle = "rgba(48,88,76,0.16)";
    c.lineWidth = 0.006;
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 4; i++) {
        c.beginPath();
        c.arc(-0.18 + i * 0.14, -0.10 + r * 0.10, 0.085, -1.2, 1.2);
        c.stroke();
      }
    }
    c.restore();

    // 鳃线
    c.strokeStyle = "rgba(48,88,76,0.28)";
    c.lineWidth = 0.007;
    c.beginPath();
    c.arc(0.26, 0, 0.10, -1.05, 1.05);
    c.stroke();

    // 眼：最后一步才睁开
    const eyeA = smooth((b - 0.90) / 0.06);
    if (eyeA > 0.02) {
      c.save();
      c.globalAlpha *= eyeA;
      c.fillStyle = "rgba(246,249,244,0.95)";
      c.beginPath(); c.arc(0.385, -0.045, 0.042, 0, TAU); c.fill();
      c.strokeStyle = "rgba(48,88,76,0.45)";
      c.lineWidth = 0.007;
      c.stroke();
      c.fillStyle = "rgba(52,84,74,0.92)";
      c.beginPath(); c.arc(0.395, -0.045, 0.022, 0, TAU); c.fill();
      c.restore();
    }

    // 嘴
    c.strokeStyle = "rgba(48,88,76,0.40)";
    c.lineWidth = 0.007;
    c.beginPath();
    c.moveTo(0.505, 0.020);
    c.quadraticCurveTo(0.470, 0.030, 0.455, 0.020);
    c.stroke();
    c.restore();
  }
}

/* =====================================================================
 * 春：有丝分裂 → 子细胞长成蝴蝶
 * =================================================================== */
function drawCellButterfly(c, b, t) {
  /* 各阶段的连续进度（bloom 0 → 1） */
  const chrCond = smooth((b - 0.08) / 0.16);      // 前期：染色质浓缩
  const envA    = 1 - smooth((b - 0.18) / 0.10);  // 前中期：核膜解体
  const meta    = smooth((b - 0.28) / 0.14);      // 中期：排到赤道板
  const ana     = smooth((b - 0.44) / 0.09);      // 后期：单体快速分离
  const telo    = smooth((b - 0.54) / 0.14);      // 末期：缢裂、核膜重建
  const splitA  = smooth((b - 0.66) / 0.05);      // 两个子细胞分开
  const fishA   = smooth((b - 0.72) / 0.08);      // 子细胞长成spring
  const leftA   = 1 - smooth((b - 0.72) / 0.09);  // 左侧子细胞淡出
  const rightCellA = 1 - smooth((b - 0.74) / 0.09);

  const R = 0.40;
  // 8 条染色体：赤道板位置、前期散乱位置、大小
  const CHR = [
    [-0.158, -0.07, -0.10, 0.046],
    [-0.112, 0.06, -0.06, 0.040],
    [-0.066, -0.04, 0.00, 0.052],
    [-0.020, 0.08, 0.07, 0.036],
    [0.024, -0.09, -0.02, 0.044],
    [0.070, 0.05, 0.10, 0.050],
    [0.116, -0.06, 0.05, 0.038],
    [0.162, 0.07, -0.07, 0.045]
  ];
  const sep = 0.020 + 0.190 * ana;
  const poleX = 0.16 + 0.14 * smooth((b - 0.14) / 0.24);
  const el = 1 + 0.16 * ana + 0.06 * telo;
  const pinch = 0.94 * telo;

  /* ===== 1. 分裂中的母细胞 (spring) ===== */
  if (splitA < 0.995) {
    c.save();
    c.globalAlpha = Math.pow(1 - splitA, 1.5);
    c.translate(Math.sin(t * 0.4) * 0.006, Math.cos(t * 0.35) * 0.005);

    // 胞质外晕
    const halo = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * 1.5);
    halo.addColorStop(0, "rgba(246,206,190,0.14)");
    halo.addColorStop(1, "rgba(246,206,190,0)");
    c.fillStyle = halo;
    c.beginPath(); c.arc(0, 0, R * 1.5, 0, TAU); c.fill();

    // 细胞膜（双层）
    divisionCellPath(c, R, el, pinch, t);
    const cyto = c.createRadialGradient(-R * 0.22, -R * 0.26, R * 0.06, 0, 0, R * 1.1);
    cyto.addColorStop(0, "rgba(252,244,236,0.97)");
    cyto.addColorStop(0.55, "rgba(238,210,192,0.94)");
    cyto.addColorStop(1, "rgba(214,174,160,0.90)");
    c.fillStyle = cyto;
    c.fill();
    c.strokeStyle = "rgba(158,94,84,0.52)";
    c.lineWidth = 0.010;
    c.stroke();
    c.save();
    c.scale(0.972, 0.972);
    divisionCellPath(c, R, el, pinch, t);
    c.strokeStyle = "rgba(158,94,84,0.18)";
    c.lineWidth = 0.0035;
    c.stroke();
    c.restore();

    // 线粒体（6 个，大小与朝向略有差异）
    const mito = [
      [-0.235, -0.15, 0.45, 1.00],
      [0.225, -0.20, -0.35, 0.92],
      [-0.24, 0.17, -0.65, 0.96],
      [0.235, 0.17, 0.25, 0.88],
      [-0.19, -0.27, 0.15, 0.78],
      [0.19, 0.27, -0.15, 0.80]
    ];
    for (const [x, y, rot, k] of mito) {
      c.save();
      c.translate(x, y);
      c.rotate(rot + Math.sin(t * 0.3 + x * 10) * 0.04);
      c.fillStyle = "rgba(240,206,188,0.55)";
      c.beginPath(); c.ellipse(0, 0, 0.06 * k, 0.026 * k, 0, 0, TAU); c.fill();
      c.strokeStyle = "rgba(146,86,74,0.28)";
      c.lineWidth = 0.0045;
      c.stroke();
      c.beginPath();
      c.moveTo(-0.04 * k, 0);
      c.quadraticCurveTo(-0.012 * k, -0.013 * k, 0.006 * k, 0);
      c.quadraticCurveTo(0.026 * k, 0.013 * k, 0.044 * k, 0);
      c.stroke();
      c.restore();
    }

    // 高尔基体：几层略弯的膜囊
    c.save();
    c.translate(0.27, -0.02);
    c.rotate(-0.25);
    c.strokeStyle = "rgba(178,130,114,0.30)";
    c.lineWidth = 0.0045;
    for (let k = 0; k < 4; k++) {
      c.beginPath();
      c.arc(0, 0, 0.045 + k * 0.008, 0.35, 1.65);
      c.stroke();
    }
    c.fillStyle = "rgba(248,224,212,0.55)";
    for (let k = 0; k < 2; k++) {
      c.beginPath();
      c.arc(0.05 + k * 0.02, 0.05, 0.006, 0, TAU);
      c.fill();
    }
    c.restore();

    // 内质网
    c.strokeStyle = "rgba(178,130,114,0.30)";
    c.lineWidth = 0.0045;
    for (const off of [0, 0.017]) {
      c.beginPath();
      c.moveTo(-0.33, -0.05 + off);
      c.bezierCurveTo(-0.26, -0.14 + off, -0.20, -0.01 + off, -0.135, -0.08 + off);
      c.stroke();
    }

    // 溶酶体与小囊泡
    const ves = [
      [-0.10, -0.30, 0.012], [0.31, -0.04, 0.010], [0.10, 0.28, 0.013], [-0.32, 0.25, 0.009],
      [-0.30, -0.27, 0.006], [0.33, 0.20, 0.007], [0.07, -0.31, 0.007], [-0.29, 0.04, 0.008]
    ];
    for (const [x, y, r] of ves) {
      c.fillStyle = "rgba(250,236,226,0.68)";
      c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      c.strokeStyle = "rgba(146,86,74,0.22)";
      c.lineWidth = 0.0035;
      c.stroke();
    }
    c.fillStyle = "rgba(214,166,150,0.40)";
    for (const [x, y] of [[-0.19, 0.28], [0.28, 0.08], [0.02, -0.32]]) {
      c.beginPath(); c.arc(x, y, 0.010, 0, TAU); c.fill();
    }

    // 胞质中的核糖体颗粒
    c.fillStyle = "rgba(178,130,114,0.15)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 4.7) * TAU;
      const rr = Math.sqrt(rnd(i * 8.3)) * R * 0.92;
      c.beginPath();
      c.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.94, 0.0042, 0, TAU);
      c.fill();
    }

    // 纺锤体：桶状轮廓、动粒微管、极间微管、中心体与星射线
    const spindleA = smooth((b - 0.20) / 0.10) * (1 - smooth((b - 0.68) / 0.05));
    if (spindleA > 0.02) {
      c.save();
      c.globalAlpha *= spindleA;
      c.strokeStyle = "rgba(186,132,116,0.07)";
      c.lineWidth = 0.004;
      for (const yy of [-0.19, 0.19]) {
        c.beginPath();
        c.moveTo(-poleX, 0);
        c.quadraticCurveTo(0, yy, poleX, 0);
        c.stroke();
      }
      for (const s of [-1, 1]) {
        // 动粒微管：每条染色单体一束
        for (let i = 0; i < CHR.length; i++) {
          const x2 = s * sep, y2 = CHR[i][0];
          c.strokeStyle = "rgba(166,112,96,0.16)";
          c.lineWidth = 0.0035;
          for (const off of [-0.006, 0.006]) {
            c.beginPath();
            c.moveTo(s * poleX, off);
            c.quadraticCurveTo((s * poleX + x2) / 2 + s * 0.02, y2 * 0.55, x2, y2);
            c.stroke();
          }
        }
        // 极间微管：越赤道伸向对侧
        c.strokeStyle = "rgba(166,112,96,0.10)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 5; k++) {
          const yEnd = -0.14 + k * 0.07;
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.quadraticCurveTo(s * 0.02, yEnd * 0.4, -s * 0.10, yEnd);
          c.stroke();
        }
        // 星射线
        c.strokeStyle = "rgba(166,112,96,0.13)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * TAU;
          const len = 0.035 + 0.03 * (0.5 + 0.5 * Math.sin(k * 2.3));
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.lineTo(s * poleX + Math.cos(a) * len, Math.sin(a) * len);
          c.stroke();
        }
        // 中心体：一对相互垂直的中心粒
        c.fillStyle = "rgba(146,86,74,0.55)";
        c.beginPath();
        c.ellipse(s * poleX, -0.010, 0.010, 0.004, Math.PI / 2, 0, TAU);
        c.fill();
        c.beginPath();
        c.ellipse(s * poleX + (s < 0 ? -0.015 : 0.015), 0.002, 0.010, 0.004, 0, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 核膜、核仁、染色质细丝（前期逐渐解体）
    if (envA > 0.02) {
      c.save();
      c.globalAlpha *= envA;
      const nr = 0.16;
      const ng = c.createRadialGradient(-nr * 0.35, -nr * 0.4, nr * 0.1, 0, 0, nr);
      ng.addColorStop(0, "rgba(252,244,236,0.62)");
      ng.addColorStop(1, "rgba(232,196,180,0.40)");
      c.fillStyle = ng;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(146,86,74,0.38)";
      c.lineWidth = 0.008;
      c.stroke();
      c.strokeStyle = "rgba(146,86,74,0.20)";
      c.lineWidth = 0.004;
      c.beginPath(); c.arc(0, 0, nr * 0.92, 0, TAU); c.stroke();

      // 染色质细丝
      c.strokeStyle = `rgba(188,134,118,${0.55 * (1 - chrCond)})`;
      c.lineWidth = 0.006;
      for (let i = 0; i < 4; i++) {
        const a0 = i * 1.7 + t * 0.05;
        c.beginPath();
        c.moveTo(Math.cos(a0) * nr * 0.55, Math.sin(a0) * nr * 0.55);
        c.bezierCurveTo(
          Math.cos(a0 + 0.9) * nr * 0.8, Math.sin(a0 + 0.9) * nr * 0.8,
          Math.cos(a0 + 0.4) * nr * 0.25, Math.sin(a0 + 0.4) * nr * 0.25,
          Math.cos(a0) * nr * 0.1, Math.sin(a0) * nr * 0.1
        );
        c.stroke();
      }

      // 核仁（比核膜更早消失）
      c.save();
      c.globalAlpha *= Math.pow(envA, 1.2);
      const nol = c.createRadialGradient(-0.02, -0.03, 0.003, 0.015, 0.01, 0.045);
      nol.addColorStop(0, "rgba(178,106,90,0.65)");
      nol.addColorStop(1, "rgba(200,140,124,0.42)");
      c.fillStyle = nol;
      c.beginPath(); c.arc(0.015, 0.01, 0.045, 0, TAU); c.fill();
      c.restore();
      c.restore();
    }

    // 核膜解体后散落的膜小泡
    const envVesA = smooth((b - 0.19) / 0.08) * (1 - smooth((b - 0.36) / 0.08));
    if (envVesA > 0.02) {
      c.save();
      c.globalAlpha *= envVesA;
      c.fillStyle = "rgba(178,130,114,0.32)";
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU + 0.3;
        const rr = 0.16 + 0.02 * Math.sin(k * 1.7 + t * 0.8);
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0055, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 染色体：前期浓缩、中期排队、后期分离、末期解聚
    const chrA = smooth((b - 0.08) / 0.12) * (1 - smooth((b - 0.55) / 0.08));
    if (chrA > 0.02) {
      for (let i = 0; i < CHR.length; i++) {
        const jy = (rnd(i * 3.3) - 0.5) * 0.030 * meta;
        const jx = (rnd(i * 7.1) - 0.5) * 0.028 * meta;
        const tilt = (rnd(i * 5.9) - 0.5) * 0.75 * meta;
        const sway = Math.sin(t * 0.8 + i * 1.9) * 0.0045 * meta;
        const y = lerp(CHR[i][2], CHR[i][0], meta) + jy + sway;
        const bx = lerp(CHR[i][1], 0, meta) + jx;
        const size = CHR[i][3] * (1 - 0.45 * telo);   // 末期解聚、臂缩短
        const color = `rgba(200,70,90,${(0.70 + 0.12 * rnd(i * 9.4)) * chrA})`;
        drawChromatid(c, bx - sep, y, -1, size, color, tilt);
        drawChromatid(c, bx + sep, y, 1, size, color, tilt);
      }
    }

    // 末期：两极重建新核（双层核膜、染色质解聚、核仁再现）
    const nucNewA = smooth((b - 0.55) / 0.10);
    if (nucNewA > 0.02) {
      c.save();
      c.globalAlpha *= nucNewA;
      for (const s of [-1, 1]) {
        const nx = s * (0.17 + 0.045 * telo);
        const nr = 0.055 + 0.030 * telo;
        const ng2 = c.createRadialGradient(nx - nr * 0.3, -nr * 0.35, 0.005, nx, 0, nr);
        ng2.addColorStop(0, "rgba(250,240,230,0.75)");
        ng2.addColorStop(1, "rgba(234,200,184,0.50)");
        c.fillStyle = ng2;
        c.beginPath(); c.arc(nx, 0, nr, 0, TAU); c.fill();
        c.strokeStyle = "rgba(146,86,74,0.36)";
        c.lineWidth = 0.0055;
        c.stroke();
        c.strokeStyle = "rgba(146,86,74,0.18)";
        c.lineWidth = 0.003;
        c.beginPath(); c.arc(nx, 0, nr * 0.90, 0, TAU); c.stroke();

        // 解聚中的染色质细丝
        c.strokeStyle = "rgba(188,134,118,0.34)";
        c.lineWidth = 0.004;
        for (let k = 0; k < 2; k++) {
          c.beginPath();
          c.moveTo(nx - nr * 0.32, -nr * 0.22 + k * nr * 0.28);
          c.quadraticCurveTo(nx + nr * 0.05, -nr * 0.02 + k * nr * 0.24, nx + nr * 0.30, nr * 0.14 - k * nr * 0.10);
          c.stroke();
        }

        // 核仁稍晚出现
        const nolA = smooth((b - 0.62) / 0.08);
        if (nolA > 0.02) {
          c.save();
          c.globalAlpha *= nolA;
          c.fillStyle = "rgba(170,96,80,0.50)";
          c.beginPath(); c.arc(nx + nr * 0.18, -nr * 0.16, nr * 0.25, 0, TAU); c.fill();
          c.restore();
        }
      }
      c.restore();
    }

    // 缢裂处残留的中间体
    if (telo > 0.15 && splitA < 0.6) {
      c.strokeStyle = `rgba(172,102,86,${0.45 * telo})`;
      c.lineWidth = 0.011;
      c.lineCap = "round";
      c.beginPath(); c.moveTo(-0.035, 0); c.lineTo(0.035, 0); c.stroke();
    }

    c.restore();
  }

  /* ===== 2. 两个子细胞 (spring) ===== */
  if (splitA > 0.02) {
    for (const s of [-1, 1]) {
      const alpha = splitA * (s < 0 ? leftA : rightCellA);
      if (alpha <= 0.02) continue;
      c.save();
      c.globalAlpha = alpha;
      c.translate(s * 0.225, 0);

      const rx = 0.198, ry = 0.224;
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const cg = c.createRadialGradient(-rx * 0.3, -ry * 0.35, 0.02, 0, 0, rx);
      cg.addColorStop(0, "rgba(252,244,236,0.97)");
      cg.addColorStop(0.55, "rgba(238,210,192,0.94)");
      cg.addColorStop(1, "rgba(214,174,160,0.90)");
      c.fillStyle = cg;
      c.fill();
      c.strokeStyle = "rgba(158,94,84,0.50)";
      c.lineWidth = 0.008;
      c.stroke();
      c.save();
      c.scale(0.965, 0.965);
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      c.strokeStyle = "rgba(158,94,84,0.16)";
      c.lineWidth = 0.003;
      c.stroke();
      c.restore();

      // 新细胞核：双层核膜、核仁、少量染色质（略偏，避免"煎蛋"式对称）
      const nr = 0.082;
      c.save();
      c.translate(-0.020, -0.012);
      const ng3 = c.createRadialGradient(-nr * 0.3, -nr * 0.35, 0.01, 0, 0, nr);
      ng3.addColorStop(0, "rgba(250,242,232,0.85)");
      ng3.addColorStop(1, "rgba(228,192,176,0.62)");
      c.fillStyle = ng3;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(146,86,74,0.40)";
      c.lineWidth = 0.0055;
      c.stroke();
      c.strokeStyle = "rgba(146,86,74,0.18)";
      c.lineWidth = 0.003;
      c.beginPath(); c.arc(0, 0, nr * 0.90, 0, TAU); c.stroke();
      c.strokeStyle = "rgba(188,134,118,0.30)";
      c.lineWidth = 0.004;
      c.beginPath();
      c.moveTo(-nr * 0.35, nr * 0.10);
      c.quadraticCurveTo(0, -nr * 0.28, nr * 0.38, nr * 0.05);
      c.stroke();
      c.beginPath();
      c.moveTo(-nr * 0.22, -nr * 0.30);
      c.quadraticCurveTo(nr * 0.10, -nr * 0.05, nr * 0.24, nr * 0.28);
      c.stroke();
      c.fillStyle = "rgba(170,96,80,0.52)";
      c.beginPath(); c.arc(nr * 0.22, -nr * 0.18, nr * 0.28, 0, TAU); c.fill();
      c.restore();

      // 少量细胞器
      c.fillStyle = "rgba(240,206,188,0.52)";
      c.strokeStyle = "rgba(146,86,74,0.26)";
      c.lineWidth = 0.0035;
      for (const [x, y, rot] of [[-0.09, 0.13, 0.5], [0.10, -0.14, -0.3]]) {
        c.save();
        c.translate(x, y);
        c.rotate(rot);
        c.beginPath(); c.ellipse(0, 0, 0.045, 0.019, 0, 0, TAU);
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(-0.028, 0);
        c.quadraticCurveTo(-0.005, -0.009, 0.010, 0);
        c.stroke();
        c.restore();
      }
      // 高尔基体与内质网
      c.save();
      c.translate(0.108, 0.080);
      c.rotate(-0.35);
      c.strokeStyle = "rgba(178,130,114,0.30)";
      c.lineWidth = 0.0035;
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        c.arc(0, 0, 0.024 + k * 0.006, 0.40, 1.70);
        c.stroke();
      }
      c.restore();
      c.strokeStyle = "rgba(178,130,114,0.28)";
      c.lineWidth = 0.0035;
      c.beginPath();
      c.moveTo(-0.155, 0.105);
      c.bezierCurveTo(-0.115, 0.150, -0.060, 0.080, -0.010, 0.130);
      c.stroke();

      c.fillStyle = "rgba(250,236,226,0.70)";
      for (const [x, y, r] of [[-0.11, -0.12, 0.010], [0.12, 0.12, 0.009], [0.14, 0.03, 0.006], [-0.05, 0.16, 0.006], [0.02, 0.17, 0.005], [0.15, -0.05, 0.007], [-0.14, 0.06, 0.008]]) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      }
      c.fillStyle = "rgba(178,130,114,0.16)";
      for (let i = 0; i < 10; i++) {
        const a = rnd(i * 4.1) * TAU;
        const rr = Math.sqrt(rnd(i * 6.7)) * 0.19;
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0035, 0, TAU);
        c.fill();
      }

      c.restore();
    }
  }

  
  /* ---------- 蝴蝶 ---------- */
  const wingA   = smooth((b - 0.72) / 0.10);
  const bodyA   = smooth((b - 0.70) / 0.08);
  const antennaA= smooth((b - 0.86) / 0.07);
  const eyeA    = smooth((b - 0.92) / 0.05);
  if (bodyA > 0.02) {
    const g = 0.55 + 0.45 * smooth((b - 0.70) / 0.22);
    const fx = 0.225 * (1 - smooth((b - 0.74) / 0.20));
    const flap = Math.sin(t * 3.2) * (0.18 + 0.30 * b);

    c.save();
    c.globalAlpha = bodyA;
    c.translate(fx + Math.sin(t * 0.5) * 0.015, Math.cos(t * 0.7) * 0.012 + 0.010 * (1 - g));
    c.scale(g * 1.15, g * 1.15);
    c.rotate(Math.sin(t * 1.1) * 0.02);

    // 翅膀（先画在身体之下）
    if (wingA > 0.02) {
      c.save();
      c.globalAlpha *= wingA;
      const wg0 = "rgba(248,204,188,0.90)";
      const wg1 = "rgba(220,152,132,0.85)";
      const wg2 = "rgba(180,96,80,0.80)";
      const wingStroke = "rgba(146,86,74,0.55)";
      const veins = "rgba(146,86,74,0.35)";

      for (const s of [-1, 1]) {
        c.save();
        c.translate(s * 0.02, 0);
        c.rotate(s * flap * 0.35);
        // 前翅（上）
        c.beginPath();
        c.moveTo(0, 0);
        c.quadraticCurveTo(s * 0.05, -0.18, s * 0.22, -0.22);
        c.quadraticCurveTo(s * 0.28, -0.10, s * 0.18, -0.02);
        c.quadraticCurveTo(s * 0.10, 0.02, 0, 0);
        c.closePath();
        const wgT = c.createRadialGradient(s * 0.18, -0.14, 0.01, s * 0.14, -0.10, 0.26);
        wgT.addColorStop(0, wg0); wgT.addColorStop(0.55, wg1); wgT.addColorStop(1, wg2);
        c.fillStyle = wgT; c.fill();
        c.strokeStyle = wingStroke; c.lineWidth = 0.007; c.stroke();
        // 翅脉
        c.strokeStyle = veins; c.lineWidth = 0.004;
        for (let i = 0; i < 4; i++) {
          c.beginPath();
          c.moveTo(0, 0);
          c.quadraticCurveTo(s * (0.06 + i * 0.03), -0.14 + i * 0.04, s * (0.14 + i * 0.04), -0.20 + i * 0.02);
          c.stroke();
        }
        // 后翅（下）
        c.beginPath();
        c.moveTo(0, 0);
        c.quadraticCurveTo(s * 0.05, 0.10, s * 0.16, 0.16);
        c.quadraticCurveTo(s * 0.20, 0.02, s * 0.10, -0.02);
        c.quadraticCurveTo(s * 0.04, -0.01, 0, 0);
        c.closePath();
        const wgB = c.createRadialGradient(s * 0.10, 0.07, 0.01, s * 0.08, 0.06, 0.20);
        wgB.addColorStop(0, wg1); wgB.addColorStop(1, wg2);
        c.fillStyle = wgB; c.fill();
        c.strokeStyle = wingStroke; c.lineWidth = 0.006; c.stroke();
        // 后翅斑纹：3 个小圆点
        c.fillStyle = "rgba(108,48,42,0.55)";
        for (const [dx, dy, r] of [[0.09,0.03,0.014],[0.12,-0.02,0.010],[0.06,0.07,0.009]]) {
          c.beginPath(); c.arc(s * dx, dy, r, 0, TAU); c.fill();
        }
        c.restore();
      }
      c.restore();
    }

    // 身体：圆柱状（胸+头）
    c.beginPath();
    c.ellipse(0, 0, 0.06, 0.22, 0, 0, TAU);
    c.fillStyle = "rgba(108,58,48,0.88)";
    c.fill();
    c.strokeStyle = "rgba(86,42,34,0.70)";
    c.lineWidth = 0.006;
    c.stroke();
    // 胸节横条纹
    c.strokeStyle = "rgba(86,42,34,0.40)";
    c.lineWidth = 0.004;
    for (let k = 0; k < 4; k++) {
      c.beginPath();
      c.moveTo(-0.058, -0.08 + k * 0.04);
      c.lineTo(0.058, -0.08 + k * 0.04);
      c.stroke();
    }
    // 头（顶端圆）
    c.beginPath(); c.arc(0, -0.23, 0.038, 0, TAU);
    c.fillStyle = "rgba(86,42,34,0.88)"; c.fill();
    c.stroke();

    // 触角
    if (antennaA > 0.02) {
      c.save();
      c.globalAlpha *= antennaA;
      c.strokeStyle = "rgba(86,42,34,0.75)";
      c.lineWidth = 0.004;
      c.lineCap = "round";
      for (const s of [-1, 1]) {
        c.beginPath();
        c.moveTo(s * 0.012, -0.245);
        c.quadraticCurveTo(s * 0.032, -0.32, s * 0.055, -0.36);
        c.stroke();
        // 触角末端小球
        c.fillStyle = "rgba(86,42,34,0.80)";
        c.beginPath(); c.arc(s * 0.055, -0.36, 0.006, 0, TAU); c.fill();
      }
      c.restore();
    }

    // 复眼（最后出现）
    if (eyeA > 0.02) {
      c.save();
      c.globalAlpha *= eyeA;
      c.fillStyle = "rgba(240,224,212,0.92)";
      for (const s of [-1, 1]) {
        c.beginPath(); c.arc(s * 0.02, -0.21, 0.012, 0, TAU); c.fill();
      }
      c.fillStyle = "rgba(86,42,34,0.85)";
      for (const s of [-1, 1]) {
        c.beginPath(); c.arc(s * 0.02, -0.21, 0.006, 0, TAU); c.fill();
      }
      c.restore();
    }

    c.restore();
  }

}


/* =====================================================================
 * 秋：有丝分裂 → 子细胞长成麻雀
 * =================================================================== */
function drawCellSparrow(c, b, t) {
  /* 各阶段的连续进度（bloom 0 → 1） */
  const chrCond = smooth((b - 0.08) / 0.16);      // 前期：染色质浓缩
  const envA    = 1 - smooth((b - 0.18) / 0.10);  // 前中期：核膜解体
  const meta    = smooth((b - 0.28) / 0.14);      // 中期：排到赤道板
  const ana     = smooth((b - 0.44) / 0.09);      // 后期：单体快速分离
  const telo    = smooth((b - 0.54) / 0.14);      // 末期：缢裂、核膜重建
  const splitA  = smooth((b - 0.66) / 0.05);      // 两个子细胞分开
  const fishA   = smooth((b - 0.72) / 0.08);      // 子细胞长成autumn
  const leftA   = 1 - smooth((b - 0.72) / 0.09);  // 左侧子细胞淡出
  const rightCellA = 1 - smooth((b - 0.74) / 0.09);

  const R = 0.40;
  // 8 条染色体：赤道板位置、前期散乱位置、大小
  const CHR = [
    [-0.158, -0.07, -0.10, 0.046],
    [-0.112, 0.06, -0.06, 0.040],
    [-0.066, -0.04, 0.00, 0.052],
    [-0.020, 0.08, 0.07, 0.036],
    [0.024, -0.09, -0.02, 0.044],
    [0.070, 0.05, 0.10, 0.050],
    [0.116, -0.06, 0.05, 0.038],
    [0.162, 0.07, -0.07, 0.045]
  ];
  const sep = 0.020 + 0.190 * ana;
  const poleX = 0.16 + 0.14 * smooth((b - 0.14) / 0.24);
  const el = 1 + 0.16 * ana + 0.06 * telo;
  const pinch = 0.94 * telo;

  /* ===== 1. 分裂中的母细胞 (autumn) ===== */
  if (splitA < 0.995) {
    c.save();
    c.globalAlpha = Math.pow(1 - splitA, 1.5);
    c.translate(Math.sin(t * 0.4) * 0.006, Math.cos(t * 0.35) * 0.005);

    // 胞质外晕
    const halo = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * 1.5);
    halo.addColorStop(0, "rgba(220,186,130,0.14)");
    halo.addColorStop(1, "rgba(220,186,130,0)");
    c.fillStyle = halo;
    c.beginPath(); c.arc(0, 0, R * 1.5, 0, TAU); c.fill();

    // 细胞膜（双层）
    divisionCellPath(c, R, el, pinch, t);
    const cyto = c.createRadialGradient(-R * 0.22, -R * 0.26, R * 0.06, 0, 0, R * 1.1);
    cyto.addColorStop(0, "rgba(250,242,220,0.97)");
    cyto.addColorStop(0.55, "rgba(234,210,160,0.94)");
    cyto.addColorStop(1, "rgba(196,162,110,0.90)");
    c.fillStyle = cyto;
    c.fill();
    c.strokeStyle = "rgba(140,96,40,0.52)";
    c.lineWidth = 0.010;
    c.stroke();
    c.save();
    c.scale(0.972, 0.972);
    divisionCellPath(c, R, el, pinch, t);
    c.strokeStyle = "rgba(140,96,40,0.18)";
    c.lineWidth = 0.0035;
    c.stroke();
    c.restore();

    // 线粒体（6 个，大小与朝向略有差异）
    const mito = [
      [-0.235, -0.15, 0.45, 1.00],
      [0.225, -0.20, -0.35, 0.92],
      [-0.24, 0.17, -0.65, 0.96],
      [0.235, 0.17, 0.25, 0.88],
      [-0.19, -0.27, 0.15, 0.78],
      [0.19, 0.27, -0.15, 0.80]
    ];
    for (const [x, y, rot, k] of mito) {
      c.save();
      c.translate(x, y);
      c.rotate(rot + Math.sin(t * 0.3 + x * 10) * 0.04);
      c.fillStyle = "rgba(226,194,140,0.55)";
      c.beginPath(); c.ellipse(0, 0, 0.06 * k, 0.026 * k, 0, 0, TAU); c.fill();
      c.strokeStyle = "rgba(130,88,34,0.28)";
      c.lineWidth = 0.0045;
      c.stroke();
      c.beginPath();
      c.moveTo(-0.04 * k, 0);
      c.quadraticCurveTo(-0.012 * k, -0.013 * k, 0.006 * k, 0);
      c.quadraticCurveTo(0.026 * k, 0.013 * k, 0.044 * k, 0);
      c.stroke();
      c.restore();
    }

    // 高尔基体：几层略弯的膜囊
    c.save();
    c.translate(0.27, -0.02);
    c.rotate(-0.25);
    c.strokeStyle = "rgba(172,132,76,0.30)";
    c.lineWidth = 0.0045;
    for (let k = 0; k < 4; k++) {
      c.beginPath();
      c.arc(0, 0, 0.045 + k * 0.008, 0.35, 1.65);
      c.stroke();
    }
    c.fillStyle = "rgba(240,216,170,0.55)";
    for (let k = 0; k < 2; k++) {
      c.beginPath();
      c.arc(0.05 + k * 0.02, 0.05, 0.006, 0, TAU);
      c.fill();
    }
    c.restore();

    // 内质网
    c.strokeStyle = "rgba(172,132,76,0.30)";
    c.lineWidth = 0.0045;
    for (const off of [0, 0.017]) {
      c.beginPath();
      c.moveTo(-0.33, -0.05 + off);
      c.bezierCurveTo(-0.26, -0.14 + off, -0.20, -0.01 + off, -0.135, -0.08 + off);
      c.stroke();
    }

    // 溶酶体与小囊泡
    const ves = [
      [-0.10, -0.30, 0.012], [0.31, -0.04, 0.010], [0.10, 0.28, 0.013], [-0.32, 0.25, 0.009],
      [-0.30, -0.27, 0.006], [0.33, 0.20, 0.007], [0.07, -0.31, 0.007], [-0.29, 0.04, 0.008]
    ];
    for (const [x, y, r] of ves) {
      c.fillStyle = "rgba(248,228,186,0.68)";
      c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      c.strokeStyle = "rgba(130,88,34,0.22)";
      c.lineWidth = 0.0035;
      c.stroke();
    }
    c.fillStyle = "rgba(186,146,90,0.40)";
    for (const [x, y] of [[-0.19, 0.28], [0.28, 0.08], [0.02, -0.32]]) {
      c.beginPath(); c.arc(x, y, 0.010, 0, TAU); c.fill();
    }

    // 胞质中的核糖体颗粒
    c.fillStyle = "rgba(172,132,76,0.15)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 4.7) * TAU;
      const rr = Math.sqrt(rnd(i * 8.3)) * R * 0.92;
      c.beginPath();
      c.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.94, 0.0042, 0, TAU);
      c.fill();
    }

    // 纺锤体：桶状轮廓、动粒微管、极间微管、中心体与星射线
    const spindleA = smooth((b - 0.20) / 0.10) * (1 - smooth((b - 0.68) / 0.05));
    if (spindleA > 0.02) {
      c.save();
      c.globalAlpha *= spindleA;
      c.strokeStyle = "rgba(164,122,64,0.07)";
      c.lineWidth = 0.004;
      for (const yy of [-0.19, 0.19]) {
        c.beginPath();
        c.moveTo(-poleX, 0);
        c.quadraticCurveTo(0, yy, poleX, 0);
        c.stroke();
      }
      for (const s of [-1, 1]) {
        // 动粒微管：每条染色单体一束
        for (let i = 0; i < CHR.length; i++) {
          const x2 = s * sep, y2 = CHR[i][0];
          c.strokeStyle = "rgba(142,102,50,0.16)";
          c.lineWidth = 0.0035;
          for (const off of [-0.006, 0.006]) {
            c.beginPath();
            c.moveTo(s * poleX, off);
            c.quadraticCurveTo((s * poleX + x2) / 2 + s * 0.02, y2 * 0.55, x2, y2);
            c.stroke();
          }
        }
        // 极间微管：越赤道伸向对侧
        c.strokeStyle = "rgba(142,102,50,0.10)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 5; k++) {
          const yEnd = -0.14 + k * 0.07;
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.quadraticCurveTo(s * 0.02, yEnd * 0.4, -s * 0.10, yEnd);
          c.stroke();
        }
        // 星射线
        c.strokeStyle = "rgba(142,102,50,0.13)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * TAU;
          const len = 0.035 + 0.03 * (0.5 + 0.5 * Math.sin(k * 2.3));
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.lineTo(s * poleX + Math.cos(a) * len, Math.sin(a) * len);
          c.stroke();
        }
        // 中心体：一对相互垂直的中心粒
        c.fillStyle = "rgba(130,88,34,0.55)";
        c.beginPath();
        c.ellipse(s * poleX, -0.010, 0.010, 0.004, Math.PI / 2, 0, TAU);
        c.fill();
        c.beginPath();
        c.ellipse(s * poleX + (s < 0 ? -0.015 : 0.015), 0.002, 0.010, 0.004, 0, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 核膜、核仁、染色质细丝（前期逐渐解体）
    if (envA > 0.02) {
      c.save();
      c.globalAlpha *= envA;
      const nr = 0.16;
      const ng = c.createRadialGradient(-nr * 0.35, -nr * 0.4, nr * 0.1, 0, 0, nr);
      ng.addColorStop(0, "rgba(250,242,218,0.62)");
      ng.addColorStop(1, "rgba(230,198,154,0.40)");
      c.fillStyle = ng;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(130,88,34,0.38)";
      c.lineWidth = 0.008;
      c.stroke();
      c.strokeStyle = "rgba(130,88,34,0.20)";
      c.lineWidth = 0.004;
      c.beginPath(); c.arc(0, 0, nr * 0.92, 0, TAU); c.stroke();

      // 染色质细丝
      c.strokeStyle = `rgba(186,146,90,${0.55 * (1 - chrCond)})`;
      c.lineWidth = 0.006;
      for (let i = 0; i < 4; i++) {
        const a0 = i * 1.7 + t * 0.05;
        c.beginPath();
        c.moveTo(Math.cos(a0) * nr * 0.55, Math.sin(a0) * nr * 0.55);
        c.bezierCurveTo(
          Math.cos(a0 + 0.9) * nr * 0.8, Math.sin(a0 + 0.9) * nr * 0.8,
          Math.cos(a0 + 0.4) * nr * 0.25, Math.sin(a0 + 0.4) * nr * 0.25,
          Math.cos(a0) * nr * 0.1, Math.sin(a0) * nr * 0.1
        );
        c.stroke();
      }

      // 核仁（比核膜更早消失）
      c.save();
      c.globalAlpha *= Math.pow(envA, 1.2);
      const nol = c.createRadialGradient(-0.02, -0.03, 0.003, 0.015, 0.01, 0.045);
      nol.addColorStop(0, "rgba(170,118,54,0.65)");
      nol.addColorStop(1, "rgba(192,140,70,0.42)");
      c.fillStyle = nol;
      c.beginPath(); c.arc(0.015, 0.01, 0.045, 0, TAU); c.fill();
      c.restore();
      c.restore();
    }

    // 核膜解体后散落的膜小泡
    const envVesA = smooth((b - 0.19) / 0.08) * (1 - smooth((b - 0.36) / 0.08));
    if (envVesA > 0.02) {
      c.save();
      c.globalAlpha *= envVesA;
      c.fillStyle = "rgba(172,132,76,0.32)";
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU + 0.3;
        const rr = 0.16 + 0.02 * Math.sin(k * 1.7 + t * 0.8);
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0055, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 染色体：前期浓缩、中期排队、后期分离、末期解聚
    const chrA = smooth((b - 0.08) / 0.12) * (1 - smooth((b - 0.55) / 0.08));
    if (chrA > 0.02) {
      for (let i = 0; i < CHR.length; i++) {
        const jy = (rnd(i * 3.3) - 0.5) * 0.030 * meta;
        const jx = (rnd(i * 7.1) - 0.5) * 0.028 * meta;
        const tilt = (rnd(i * 5.9) - 0.5) * 0.75 * meta;
        const sway = Math.sin(t * 0.8 + i * 1.9) * 0.0045 * meta;
        const y = lerp(CHR[i][2], CHR[i][0], meta) + jy + sway;
        const bx = lerp(CHR[i][1], 0, meta) + jx;
        const size = CHR[i][3] * (1 - 0.45 * telo);   // 末期解聚、臂缩短
        const color = `rgba(170,78,34,${(0.70 + 0.12 * rnd(i * 9.4)) * chrA})`;
        drawChromatid(c, bx - sep, y, -1, size, color, tilt);
        drawChromatid(c, bx + sep, y, 1, size, color, tilt);
      }
    }

    // 末期：两极重建新核（双层核膜、染色质解聚、核仁再现）
    const nucNewA = smooth((b - 0.55) / 0.10);
    if (nucNewA > 0.02) {
      c.save();
      c.globalAlpha *= nucNewA;
      for (const s of [-1, 1]) {
        const nx = s * (0.17 + 0.045 * telo);
        const nr = 0.055 + 0.030 * telo;
        const ng2 = c.createRadialGradient(nx - nr * 0.3, -nr * 0.35, 0.005, nx, 0, nr);
        ng2.addColorStop(0, "rgba(250,240,214,0.75)");
        ng2.addColorStop(1, "rgba(234,204,160,0.50)");
        c.fillStyle = ng2;
        c.beginPath(); c.arc(nx, 0, nr, 0, TAU); c.fill();
        c.strokeStyle = "rgba(130,88,34,0.36)";
        c.lineWidth = 0.0055;
        c.stroke();
        c.strokeStyle = "rgba(130,88,34,0.18)";
        c.lineWidth = 0.003;
        c.beginPath(); c.arc(nx, 0, nr * 0.90, 0, TAU); c.stroke();

        // 解聚中的染色质细丝
        c.strokeStyle = "rgba(186,146,90,0.34)";
        c.lineWidth = 0.004;
        for (let k = 0; k < 2; k++) {
          c.beginPath();
          c.moveTo(nx - nr * 0.32, -nr * 0.22 + k * nr * 0.28);
          c.quadraticCurveTo(nx + nr * 0.05, -nr * 0.02 + k * nr * 0.24, nx + nr * 0.30, nr * 0.14 - k * nr * 0.10);
          c.stroke();
        }

        // 核仁稍晚出现
        const nolA = smooth((b - 0.62) / 0.08);
        if (nolA > 0.02) {
          c.save();
          c.globalAlpha *= nolA;
          c.fillStyle = "rgba(166,110,48,0.50)";
          c.beginPath(); c.arc(nx + nr * 0.18, -nr * 0.16, nr * 0.25, 0, TAU); c.fill();
          c.restore();
        }
      }
      c.restore();
    }

    // 缢裂处残留的中间体
    if (telo > 0.15 && splitA < 0.6) {
      c.strokeStyle = `rgba(168,116,50,${0.45 * telo})`;
      c.lineWidth = 0.011;
      c.lineCap = "round";
      c.beginPath(); c.moveTo(-0.035, 0); c.lineTo(0.035, 0); c.stroke();
    }

    c.restore();
  }

  /* ===== 2. 两个子细胞 (autumn) ===== */
  if (splitA > 0.02) {
    for (const s of [-1, 1]) {
      const alpha = splitA * (s < 0 ? leftA : rightCellA);
      if (alpha <= 0.02) continue;
      c.save();
      c.globalAlpha = alpha;
      c.translate(s * 0.225, 0);

      const rx = 0.198, ry = 0.224;
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const cg = c.createRadialGradient(-rx * 0.3, -ry * 0.35, 0.02, 0, 0, rx);
      cg.addColorStop(0, "rgba(250,242,220,0.97)");
      cg.addColorStop(0.55, "rgba(234,210,160,0.94)");
      cg.addColorStop(1, "rgba(196,162,110,0.90)");
      c.fillStyle = cg;
      c.fill();
      c.strokeStyle = "rgba(140,96,40,0.50)";
      c.lineWidth = 0.008;
      c.stroke();
      c.save();
      c.scale(0.965, 0.965);
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      c.strokeStyle = "rgba(140,96,40,0.16)";
      c.lineWidth = 0.003;
      c.stroke();
      c.restore();

      // 新细胞核：双层核膜、核仁、少量染色质（略偏，避免"煎蛋"式对称）
      const nr = 0.082;
      c.save();
      c.translate(-0.020, -0.012);
      const ng3 = c.createRadialGradient(-nr * 0.3, -nr * 0.35, 0.01, 0, 0, nr);
      ng3.addColorStop(0, "rgba(248,240,214,0.85)");
      ng3.addColorStop(1, "rgba(226,194,150,0.62)");
      c.fillStyle = ng3;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(130,88,34,0.40)";
      c.lineWidth = 0.0055;
      c.stroke();
      c.strokeStyle = "rgba(130,88,34,0.18)";
      c.lineWidth = 0.003;
      c.beginPath(); c.arc(0, 0, nr * 0.90, 0, TAU); c.stroke();
      c.strokeStyle = "rgba(186,146,90,0.30)";
      c.lineWidth = 0.004;
      c.beginPath();
      c.moveTo(-nr * 0.35, nr * 0.10);
      c.quadraticCurveTo(0, -nr * 0.28, nr * 0.38, nr * 0.05);
      c.stroke();
      c.beginPath();
      c.moveTo(-nr * 0.22, -nr * 0.30);
      c.quadraticCurveTo(nr * 0.10, -nr * 0.05, nr * 0.24, nr * 0.28);
      c.stroke();
      c.fillStyle = "rgba(166,110,48,0.52)";
      c.beginPath(); c.arc(nr * 0.22, -nr * 0.18, nr * 0.28, 0, TAU); c.fill();
      c.restore();

      // 少量细胞器
      c.fillStyle = "rgba(226,194,140,0.52)";
      c.strokeStyle = "rgba(130,88,34,0.26)";
      c.lineWidth = 0.0035;
      for (const [x, y, rot] of [[-0.09, 0.13, 0.5], [0.10, -0.14, -0.3]]) {
        c.save();
        c.translate(x, y);
        c.rotate(rot);
        c.beginPath(); c.ellipse(0, 0, 0.045, 0.019, 0, 0, TAU);
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(-0.028, 0);
        c.quadraticCurveTo(-0.005, -0.009, 0.010, 0);
        c.stroke();
        c.restore();
      }
      // 高尔基体与内质网
      c.save();
      c.translate(0.108, 0.080);
      c.rotate(-0.35);
      c.strokeStyle = "rgba(172,132,76,0.30)";
      c.lineWidth = 0.0035;
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        c.arc(0, 0, 0.024 + k * 0.006, 0.40, 1.70);
        c.stroke();
      }
      c.restore();
      c.strokeStyle = "rgba(172,132,76,0.28)";
      c.lineWidth = 0.0035;
      c.beginPath();
      c.moveTo(-0.155, 0.105);
      c.bezierCurveTo(-0.115, 0.150, -0.060, 0.080, -0.010, 0.130);
      c.stroke();

      c.fillStyle = "rgba(248,228,186,0.70)";
      for (const [x, y, r] of [[-0.11, -0.12, 0.010], [0.12, 0.12, 0.009], [0.14, 0.03, 0.006], [-0.05, 0.16, 0.006], [0.02, 0.17, 0.005], [0.15, -0.05, 0.007], [-0.14, 0.06, 0.008]]) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      }
      c.fillStyle = "rgba(172,132,76,0.16)";
      for (let i = 0; i < 10; i++) {
        const a = rnd(i * 4.1) * TAU;
        const rr = Math.sqrt(rnd(i * 6.7)) * 0.19;
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0035, 0, TAU);
        c.fill();
      }

      c.restore();
    }
  }

  
  /* ---------- 麻雀 ---------- */
  const bodyA = smooth((b - 0.72) / 0.08);
  const wingA = smooth((b - 0.78) / 0.06);
  const beakA = smooth((b - 0.86) / 0.06);
  const eyeA  = smooth((b - 0.92) / 0.05);
  if (bodyA > 0.02) {
    const g = 0.55 + 0.45 * smooth((b - 0.72) / 0.20);
    const fx = 0.225 * (1 - smooth((b - 0.75) / 0.18));
    const bob = Math.sin(t * 2.0) * 0.015;
    const hWing = Math.sin(t * 4.5) * (0.02 + 0.06 * b);

    c.save();
    c.globalAlpha = bodyA;
    c.translate(fx + Math.sin(t * 0.55) * 0.014, Math.cos(t * 0.75) * 0.010 + 0.020 * (1 - g) + bob);
    c.scale(g * 1.15, g * 1.15);
    c.rotate(-0.02 + Math.sin(t * 0.8) * 0.02);

    // 尾巴（先画，在身体之后）
    c.save();
    c.translate(-0.18, 0.02);
    c.rotate(Math.sin(t * 3.0) * 0.08);
    c.fillStyle = "rgba(168,124,64,0.88)";
    c.strokeStyle = "rgba(112,76,30,0.70)";
    c.lineWidth = 0.006;
    c.beginPath();
    c.moveTo(0, 0);
    c.quadraticCurveTo(-0.08, -0.02, -0.14, -0.03);
    c.lineTo(-0.14, 0.03);
    c.quadraticCurveTo(-0.08, 0.02, 0, 0);
    c.closePath(); c.fill(); c.stroke();
    c.restore();

    // 翅膀
    if (wingA > 0.02) {
      c.save();
      c.globalAlpha *= wingA;
      c.translate(-0.02, -0.02);
      c.rotate(-0.25 + hWing);
      const wg = c.createLinearGradient(0, 0, 0, -0.10);
      wg.addColorStop(0, "rgba(180,140,82,0.92)");
      wg.addColorStop(1, "rgba(130,90,40,0.85)");
      c.fillStyle = wg;
      c.strokeStyle = "rgba(92,60,20,0.65)";
      c.lineWidth = 0.006;
      c.beginPath();
      c.moveTo(-0.05, 0.01);
      c.quadraticCurveTo(-0.02, -0.10, 0.10, -0.12);
      c.quadraticCurveTo(0.14, -0.06, 0.04, 0.02);
      c.quadraticCurveTo(0.00, 0.03, -0.05, 0.01);
      c.closePath(); c.fill(); c.stroke();
      // 翅膀上的深色斑纹
      c.fillStyle = "rgba(92,60,20,0.55)";
      c.beginPath(); c.arc(0.03, -0.06, 0.012, 0, TAU); c.fill();
      c.beginPath(); c.arc(0.07, -0.09, 0.010, 0, TAU); c.fill();
      c.restore();
    }

    // 身体
    c.beginPath();
    c.moveTo(0.20, 0.00);
    c.bezierCurveTo(0.16, -0.14, -0.02, -0.18, -0.18, -0.02);
    c.bezierCurveTo(-0.20, 0.10, -0.06, 0.18, 0.14, 0.14);
    c.bezierCurveTo(0.22, 0.08, 0.22, 0.02, 0.20, 0.00);
    c.closePath();
    const bg = c.createLinearGradient(0, -0.14, 0, 0.14);
    bg.addColorStop(0, "rgba(186,144,86,0.95)");
    bg.addColorStop(0.45, "rgba(160,116,60,0.95)");
    bg.addColorStop(1, "rgba(108,72,28,0.90)");
    c.fillStyle = bg;
    c.fill();
    c.strokeStyle = "rgba(88,56,18,0.55)";
    c.lineWidth = 0.008;
    c.stroke();

    // 胸腹部较浅（奶油色）
    c.save();
    c.beginPath();
    c.ellipse(0.03, 0.08, 0.14, 0.08, -0.1, 0, TAU);
    c.clip();
    c.fillStyle = "rgba(244,220,172,0.75)";
    c.beginPath();
    c.ellipse(0.03, 0.08, 0.14, 0.08, -0.1, 0, TAU);
    c.fill();
    c.restore();

    // 头顶黑斑
    c.fillStyle = "rgba(68,44,14,0.55)";
    c.beginPath();
    c.arc(0.12, -0.10, 0.032, 0, TAU);
    c.fill();

    // 嘴（短尖）
    if (beakA > 0.02) {
      c.save();
      c.globalAlpha *= beakA;
      c.fillStyle = "rgba(196,140,44,0.95)";
      c.strokeStyle = "rgba(120,78,18,0.70)";
      c.lineWidth = 0.004;
      c.beginPath();
      c.moveTo(0.20, -0.02);
      c.lineTo(0.26, 0.00);
      c.lineTo(0.20, 0.02);
      c.closePath(); c.fill(); c.stroke();
      c.restore();
    }

    // 眼
    if (eyeA > 0.02) {
      c.save();
      c.globalAlpha *= eyeA;
      c.fillStyle = "rgba(250,240,222,0.95)";
      c.beginPath(); c.arc(0.14, -0.06, 0.017, 0, TAU); c.fill();
      c.strokeStyle = "rgba(88,56,18,0.55)"; c.lineWidth = 0.004; c.stroke();
      c.fillStyle = "rgba(48,28,8,0.92)";
      c.beginPath(); c.arc(0.145, -0.06, 0.009, 0, TAU); c.fill();
      c.restore();
    }

    // 两条小腿（简化为 V 形）
    c.save();
    c.strokeStyle = "rgba(148,102,34,0.85)";
    c.lineWidth = 0.005;
    c.lineCap = "round";
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(0.02, 0.14);
      c.lineTo(s * 0.015, 0.21);
      c.stroke();
    }
    c.restore();

    c.restore();
  }

}


/* =====================================================================
 * 冬：有丝分裂 → 子细胞长成丹顶鹤
 * =================================================================== */
function drawCellCrane(c, b, t) {
  /* 各阶段的连续进度（bloom 0 → 1） */
  const chrCond = smooth((b - 0.08) / 0.16);      // 前期：染色质浓缩
  const envA    = 1 - smooth((b - 0.18) / 0.10);  // 前中期：核膜解体
  const meta    = smooth((b - 0.28) / 0.14);      // 中期：排到赤道板
  const ana     = smooth((b - 0.44) / 0.09);      // 后期：单体快速分离
  const telo    = smooth((b - 0.54) / 0.14);      // 末期：缢裂、核膜重建
  const splitA  = smooth((b - 0.66) / 0.05);      // 两个子细胞分开
  const fishA   = smooth((b - 0.72) / 0.08);      // 子细胞长成winter
  const leftA   = 1 - smooth((b - 0.72) / 0.09);  // 左侧子细胞淡出
  const rightCellA = 1 - smooth((b - 0.74) / 0.09);

  const R = 0.40;
  // 8 条染色体：赤道板位置、前期散乱位置、大小
  const CHR = [
    [-0.158, -0.07, -0.10, 0.046],
    [-0.112, 0.06, -0.06, 0.040],
    [-0.066, -0.04, 0.00, 0.052],
    [-0.020, 0.08, 0.07, 0.036],
    [0.024, -0.09, -0.02, 0.044],
    [0.070, 0.05, 0.10, 0.050],
    [0.116, -0.06, 0.05, 0.038],
    [0.162, 0.07, -0.07, 0.045]
  ];
  const sep = 0.020 + 0.190 * ana;
  const poleX = 0.16 + 0.14 * smooth((b - 0.14) / 0.24);
  const el = 1 + 0.16 * ana + 0.06 * telo;
  const pinch = 0.94 * telo;

  /* ===== 1. 分裂中的母细胞 (winter) ===== */
  if (splitA < 0.995) {
    c.save();
    c.globalAlpha = Math.pow(1 - splitA, 1.5);
    c.translate(Math.sin(t * 0.4) * 0.006, Math.cos(t * 0.35) * 0.005);

    // 胞质外晕
    const halo = c.createRadialGradient(0, 0, R * 0.55, 0, 0, R * 1.5);
    halo.addColorStop(0, "rgba(200,216,232,0.14)");
    halo.addColorStop(1, "rgba(200,216,232,0)");
    c.fillStyle = halo;
    c.beginPath(); c.arc(0, 0, R * 1.5, 0, TAU); c.fill();

    // 细胞膜（双层）
    divisionCellPath(c, R, el, pinch, t);
    const cyto = c.createRadialGradient(-R * 0.22, -R * 0.26, R * 0.06, 0, 0, R * 1.1);
    cyto.addColorStop(0, "rgba(242,246,250,0.97)");
    cyto.addColorStop(0.55, "rgba(214,226,238,0.94)");
    cyto.addColorStop(1, "rgba(176,194,212,0.90)");
    c.fillStyle = cyto;
    c.fill();
    c.strokeStyle = "rgba(50,74,100,0.52)";
    c.lineWidth = 0.010;
    c.stroke();
    c.save();
    c.scale(0.972, 0.972);
    divisionCellPath(c, R, el, pinch, t);
    c.strokeStyle = "rgba(50,74,100,0.18)";
    c.lineWidth = 0.0035;
    c.stroke();
    c.restore();

    // 线粒体（6 个，大小与朝向略有差异）
    const mito = [
      [-0.235, -0.15, 0.45, 1.00],
      [0.225, -0.20, -0.35, 0.92],
      [-0.24, 0.17, -0.65, 0.96],
      [0.235, 0.17, 0.25, 0.88],
      [-0.19, -0.27, 0.15, 0.78],
      [0.19, 0.27, -0.15, 0.80]
    ];
    for (const [x, y, rot, k] of mito) {
      c.save();
      c.translate(x, y);
      c.rotate(rot + Math.sin(t * 0.3 + x * 10) * 0.04);
      c.fillStyle = "rgba(196,212,228,0.55)";
      c.beginPath(); c.ellipse(0, 0, 0.06 * k, 0.026 * k, 0, 0, TAU); c.fill();
      c.strokeStyle = "rgba(54,80,108,0.28)";
      c.lineWidth = 0.0045;
      c.stroke();
      c.beginPath();
      c.moveTo(-0.04 * k, 0);
      c.quadraticCurveTo(-0.012 * k, -0.013 * k, 0.006 * k, 0);
      c.quadraticCurveTo(0.026 * k, 0.013 * k, 0.044 * k, 0);
      c.stroke();
      c.restore();
    }

    // 高尔基体：几层略弯的膜囊
    c.save();
    c.translate(0.27, -0.02);
    c.rotate(-0.25);
    c.strokeStyle = "rgba(150,172,194,0.30)";
    c.lineWidth = 0.0045;
    for (let k = 0; k < 4; k++) {
      c.beginPath();
      c.arc(0, 0, 0.045 + k * 0.008, 0.35, 1.65);
      c.stroke();
    }
    c.fillStyle = "rgba(220,232,244,0.55)";
    for (let k = 0; k < 2; k++) {
      c.beginPath();
      c.arc(0.05 + k * 0.02, 0.05, 0.006, 0, TAU);
      c.fill();
    }
    c.restore();

    // 内质网
    c.strokeStyle = "rgba(150,172,194,0.30)";
    c.lineWidth = 0.0045;
    for (const off of [0, 0.017]) {
      c.beginPath();
      c.moveTo(-0.33, -0.05 + off);
      c.bezierCurveTo(-0.26, -0.14 + off, -0.20, -0.01 + off, -0.135, -0.08 + off);
      c.stroke();
    }

    // 溶酶体与小囊泡
    const ves = [
      [-0.10, -0.30, 0.012], [0.31, -0.04, 0.010], [0.10, 0.28, 0.013], [-0.32, 0.25, 0.009],
      [-0.30, -0.27, 0.006], [0.33, 0.20, 0.007], [0.07, -0.31, 0.007], [-0.29, 0.04, 0.008]
    ];
    for (const [x, y, r] of ves) {
      c.fillStyle = "rgba(232,240,248,0.68)";
      c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      c.strokeStyle = "rgba(54,80,108,0.22)";
      c.lineWidth = 0.0035;
      c.stroke();
    }
    c.fillStyle = "rgba(164,186,208,0.40)";
    for (const [x, y] of [[-0.19, 0.28], [0.28, 0.08], [0.02, -0.32]]) {
      c.beginPath(); c.arc(x, y, 0.010, 0, TAU); c.fill();
    }

    // 胞质中的核糖体颗粒
    c.fillStyle = "rgba(150,172,194,0.15)";
    for (let i = 0; i < 26; i++) {
      const a = rnd(i * 4.7) * TAU;
      const rr = Math.sqrt(rnd(i * 8.3)) * R * 0.92;
      c.beginPath();
      c.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.94, 0.0042, 0, TAU);
      c.fill();
    }

    // 纺锤体：桶状轮廓、动粒微管、极间微管、中心体与星射线
    const spindleA = smooth((b - 0.20) / 0.10) * (1 - smooth((b - 0.68) / 0.05));
    if (spindleA > 0.02) {
      c.save();
      c.globalAlpha *= spindleA;
      c.strokeStyle = "rgba(130,150,174,0.07)";
      c.lineWidth = 0.004;
      for (const yy of [-0.19, 0.19]) {
        c.beginPath();
        c.moveTo(-poleX, 0);
        c.quadraticCurveTo(0, yy, poleX, 0);
        c.stroke();
      }
      for (const s of [-1, 1]) {
        // 动粒微管：每条染色单体一束
        for (let i = 0; i < CHR.length; i++) {
          const x2 = s * sep, y2 = CHR[i][0];
          c.strokeStyle = "rgba(110,132,156,0.16)";
          c.lineWidth = 0.0035;
          for (const off of [-0.006, 0.006]) {
            c.beginPath();
            c.moveTo(s * poleX, off);
            c.quadraticCurveTo((s * poleX + x2) / 2 + s * 0.02, y2 * 0.55, x2, y2);
            c.stroke();
          }
        }
        // 极间微管：越赤道伸向对侧
        c.strokeStyle = "rgba(110,132,156,0.10)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 5; k++) {
          const yEnd = -0.14 + k * 0.07;
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.quadraticCurveTo(s * 0.02, yEnd * 0.4, -s * 0.10, yEnd);
          c.stroke();
        }
        // 星射线
        c.strokeStyle = "rgba(110,132,156,0.13)";
        c.lineWidth = 0.003;
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * TAU;
          const len = 0.035 + 0.03 * (0.5 + 0.5 * Math.sin(k * 2.3));
          c.beginPath();
          c.moveTo(s * poleX, 0);
          c.lineTo(s * poleX + Math.cos(a) * len, Math.sin(a) * len);
          c.stroke();
        }
        // 中心体：一对相互垂直的中心粒
        c.fillStyle = "rgba(54,80,108,0.55)";
        c.beginPath();
        c.ellipse(s * poleX, -0.010, 0.010, 0.004, Math.PI / 2, 0, TAU);
        c.fill();
        c.beginPath();
        c.ellipse(s * poleX + (s < 0 ? -0.015 : 0.015), 0.002, 0.010, 0.004, 0, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 核膜、核仁、染色质细丝（前期逐渐解体）
    if (envA > 0.02) {
      c.save();
      c.globalAlpha *= envA;
      const nr = 0.16;
      const ng = c.createRadialGradient(-nr * 0.35, -nr * 0.4, nr * 0.1, 0, 0, nr);
      ng.addColorStop(0, "rgba(242,246,250,0.62)");
      ng.addColorStop(1, "rgba(212,226,240,0.40)");
      c.fillStyle = ng;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(54,80,108,0.38)";
      c.lineWidth = 0.008;
      c.stroke();
      c.strokeStyle = "rgba(54,80,108,0.20)";
      c.lineWidth = 0.004;
      c.beginPath(); c.arc(0, 0, nr * 0.92, 0, TAU); c.stroke();

      // 染色质细丝
      c.strokeStyle = `rgba(158,182,206,${0.55 * (1 - chrCond)})`;
      c.lineWidth = 0.006;
      for (let i = 0; i < 4; i++) {
        const a0 = i * 1.7 + t * 0.05;
        c.beginPath();
        c.moveTo(Math.cos(a0) * nr * 0.55, Math.sin(a0) * nr * 0.55);
        c.bezierCurveTo(
          Math.cos(a0 + 0.9) * nr * 0.8, Math.sin(a0 + 0.9) * nr * 0.8,
          Math.cos(a0 + 0.4) * nr * 0.25, Math.sin(a0 + 0.4) * nr * 0.25,
          Math.cos(a0) * nr * 0.1, Math.sin(a0) * nr * 0.1
        );
        c.stroke();
      }

      // 核仁（比核膜更早消失）
      c.save();
      c.globalAlpha *= Math.pow(envA, 1.2);
      const nol = c.createRadialGradient(-0.02, -0.03, 0.003, 0.015, 0.01, 0.045);
      nol.addColorStop(0, "rgba(118,142,168,0.65)");
      nol.addColorStop(1, "rgba(142,166,192,0.42)");
      c.fillStyle = nol;
      c.beginPath(); c.arc(0.015, 0.01, 0.045, 0, TAU); c.fill();
      c.restore();
      c.restore();
    }

    // 核膜解体后散落的膜小泡
    const envVesA = smooth((b - 0.19) / 0.08) * (1 - smooth((b - 0.36) / 0.08));
    if (envVesA > 0.02) {
      c.save();
      c.globalAlpha *= envVesA;
      c.fillStyle = "rgba(150,172,194,0.32)";
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU + 0.3;
        const rr = 0.16 + 0.02 * Math.sin(k * 1.7 + t * 0.8);
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0055, 0, TAU);
        c.fill();
      }
      c.restore();
    }

    // 染色体：前期浓缩、中期排队、后期分离、末期解聚
    const chrA = smooth((b - 0.08) / 0.12) * (1 - smooth((b - 0.55) / 0.08));
    if (chrA > 0.02) {
      for (let i = 0; i < CHR.length; i++) {
        const jy = (rnd(i * 3.3) - 0.5) * 0.030 * meta;
        const jx = (rnd(i * 7.1) - 0.5) * 0.028 * meta;
        const tilt = (rnd(i * 5.9) - 0.5) * 0.75 * meta;
        const sway = Math.sin(t * 0.8 + i * 1.9) * 0.0045 * meta;
        const y = lerp(CHR[i][2], CHR[i][0], meta) + jy + sway;
        const bx = lerp(CHR[i][1], 0, meta) + jx;
        const size = CHR[i][3] * (1 - 0.45 * telo);   // 末期解聚、臂缩短
        const color = `rgba(170,40,58,${(0.70 + 0.12 * rnd(i * 9.4)) * chrA})`;
        drawChromatid(c, bx - sep, y, -1, size, color, tilt);
        drawChromatid(c, bx + sep, y, 1, size, color, tilt);
      }
    }

    // 末期：两极重建新核（双层核膜、染色质解聚、核仁再现）
    const nucNewA = smooth((b - 0.55) / 0.10);
    if (nucNewA > 0.02) {
      c.save();
      c.globalAlpha *= nucNewA;
      for (const s of [-1, 1]) {
        const nx = s * (0.17 + 0.045 * telo);
        const nr = 0.055 + 0.030 * telo;
        const ng2 = c.createRadialGradient(nx - nr * 0.3, -nr * 0.35, 0.005, nx, 0, nr);
        ng2.addColorStop(0, "rgba(240,246,250,0.75)");
        ng2.addColorStop(1, "rgba(216,230,244,0.50)");
        c.fillStyle = ng2;
        c.beginPath(); c.arc(nx, 0, nr, 0, TAU); c.fill();
        c.strokeStyle = "rgba(54,80,108,0.36)";
        c.lineWidth = 0.0055;
        c.stroke();
        c.strokeStyle = "rgba(54,80,108,0.18)";
        c.lineWidth = 0.003;
        c.beginPath(); c.arc(nx, 0, nr * 0.90, 0, TAU); c.stroke();

        // 解聚中的染色质细丝
        c.strokeStyle = "rgba(158,182,206,0.34)";
        c.lineWidth = 0.004;
        for (let k = 0; k < 2; k++) {
          c.beginPath();
          c.moveTo(nx - nr * 0.32, -nr * 0.22 + k * nr * 0.28);
          c.quadraticCurveTo(nx + nr * 0.05, -nr * 0.02 + k * nr * 0.24, nx + nr * 0.30, nr * 0.14 - k * nr * 0.10);
          c.stroke();
        }

        // 核仁稍晚出现
        const nolA = smooth((b - 0.62) / 0.08);
        if (nolA > 0.02) {
          c.save();
          c.globalAlpha *= nolA;
          c.fillStyle = "rgba(112,136,162,0.50)";
          c.beginPath(); c.arc(nx + nr * 0.18, -nr * 0.16, nr * 0.25, 0, TAU); c.fill();
          c.restore();
        }
      }
      c.restore();
    }

    // 缢裂处残留的中间体
    if (telo > 0.15 && splitA < 0.6) {
      c.strokeStyle = `rgba(114,138,164,${0.45 * telo})`;
      c.lineWidth = 0.011;
      c.lineCap = "round";
      c.beginPath(); c.moveTo(-0.035, 0); c.lineTo(0.035, 0); c.stroke();
    }

    c.restore();
  }

  /* ===== 2. 两个子细胞 (winter) ===== */
  if (splitA > 0.02) {
    for (const s of [-1, 1]) {
      const alpha = splitA * (s < 0 ? leftA : rightCellA);
      if (alpha <= 0.02) continue;
      c.save();
      c.globalAlpha = alpha;
      c.translate(s * 0.225, 0);

      const rx = 0.198, ry = 0.224;
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const cg = c.createRadialGradient(-rx * 0.3, -ry * 0.35, 0.02, 0, 0, rx);
      cg.addColorStop(0, "rgba(242,246,250,0.97)");
      cg.addColorStop(0.55, "rgba(214,226,238,0.94)");
      cg.addColorStop(1, "rgba(176,194,212,0.90)");
      c.fillStyle = cg;
      c.fill();
      c.strokeStyle = "rgba(50,74,100,0.50)";
      c.lineWidth = 0.008;
      c.stroke();
      c.save();
      c.scale(0.965, 0.965);
      c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
      c.strokeStyle = "rgba(50,74,100,0.16)";
      c.lineWidth = 0.003;
      c.stroke();
      c.restore();

      // 新细胞核：双层核膜、核仁、少量染色质（略偏，避免"煎蛋"式对称）
      const nr = 0.082;
      c.save();
      c.translate(-0.020, -0.012);
      const ng3 = c.createRadialGradient(-nr * 0.3, -nr * 0.35, 0.01, 0, 0, nr);
      ng3.addColorStop(0, "rgba(240,246,250,0.85)");
      ng3.addColorStop(1, "rgba(208,224,240,0.62)");
      c.fillStyle = ng3;
      c.beginPath(); c.arc(0, 0, nr, 0, TAU); c.fill();
      c.strokeStyle = "rgba(54,80,108,0.40)";
      c.lineWidth = 0.0055;
      c.stroke();
      c.strokeStyle = "rgba(54,80,108,0.18)";
      c.lineWidth = 0.003;
      c.beginPath(); c.arc(0, 0, nr * 0.90, 0, TAU); c.stroke();
      c.strokeStyle = "rgba(158,182,206,0.30)";
      c.lineWidth = 0.004;
      c.beginPath();
      c.moveTo(-nr * 0.35, nr * 0.10);
      c.quadraticCurveTo(0, -nr * 0.28, nr * 0.38, nr * 0.05);
      c.stroke();
      c.beginPath();
      c.moveTo(-nr * 0.22, -nr * 0.30);
      c.quadraticCurveTo(nr * 0.10, -nr * 0.05, nr * 0.24, nr * 0.28);
      c.stroke();
      c.fillStyle = "rgba(112,136,162,0.52)";
      c.beginPath(); c.arc(nr * 0.22, -nr * 0.18, nr * 0.28, 0, TAU); c.fill();
      c.restore();

      // 少量细胞器
      c.fillStyle = "rgba(196,212,228,0.52)";
      c.strokeStyle = "rgba(54,80,108,0.26)";
      c.lineWidth = 0.0035;
      for (const [x, y, rot] of [[-0.09, 0.13, 0.5], [0.10, -0.14, -0.3]]) {
        c.save();
        c.translate(x, y);
        c.rotate(rot);
        c.beginPath(); c.ellipse(0, 0, 0.045, 0.019, 0, 0, TAU);
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(-0.028, 0);
        c.quadraticCurveTo(-0.005, -0.009, 0.010, 0);
        c.stroke();
        c.restore();
      }
      // 高尔基体与内质网
      c.save();
      c.translate(0.108, 0.080);
      c.rotate(-0.35);
      c.strokeStyle = "rgba(150,172,194,0.30)";
      c.lineWidth = 0.0035;
      for (let k = 0; k < 3; k++) {
        c.beginPath();
        c.arc(0, 0, 0.024 + k * 0.006, 0.40, 1.70);
        c.stroke();
      }
      c.restore();
      c.strokeStyle = "rgba(150,172,194,0.28)";
      c.lineWidth = 0.0035;
      c.beginPath();
      c.moveTo(-0.155, 0.105);
      c.bezierCurveTo(-0.115, 0.150, -0.060, 0.080, -0.010, 0.130);
      c.stroke();

      c.fillStyle = "rgba(232,240,248,0.70)";
      for (const [x, y, r] of [[-0.11, -0.12, 0.010], [0.12, 0.12, 0.009], [0.14, 0.03, 0.006], [-0.05, 0.16, 0.006], [0.02, 0.17, 0.005], [0.15, -0.05, 0.007], [-0.14, 0.06, 0.008]]) {
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      }
      c.fillStyle = "rgba(150,172,194,0.16)";
      for (let i = 0; i < 10; i++) {
        const a = rnd(i * 4.1) * TAU;
        const rr = Math.sqrt(rnd(i * 6.7)) * 0.19;
        c.beginPath();
        c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0035, 0, TAU);
        c.fill();
      }

      c.restore();
    }
  }

  
  /* ---------- 丹顶鹤 ---------- */
  const bodyA  = smooth((b - 0.72) / 0.08);
  const neckA  = smooth((b - 0.78) / 0.08);
  const redCrownA = smooth((b - 0.85) / 0.06);
  const eyeA   = smooth((b - 0.91) / 0.05);
  const legA   = smooth((b - 0.76) / 0.10);
  if (bodyA > 0.02) {
    const g = 0.55 + 0.45 * smooth((b - 0.72) / 0.22);
    const fx = 0.225 * (1 - smooth((b - 0.75) / 0.20));
    const neckSway = Math.sin(t * 0.9) * 0.06;
    const bob = Math.sin(t * 1.5) * 0.012;

    c.save();
    c.globalAlpha = bodyA;
    c.translate(fx + Math.sin(t * 0.5) * 0.012, Math.cos(t * 0.7) * 0.010 + 0.015 * (1 - g) + bob);
    c.scale(g * 1.15, g * 1.15);
    c.rotate(Math.sin(t * 0.6) * 0.015);

    // 长腿（先画，在身体之后）
    if (legA > 0.02) {
      c.save();
      c.globalAlpha *= legA;
      c.strokeStyle = "rgba(120,92,70,0.90)";
      c.lineWidth = 0.005;
      c.lineCap = "round";
      for (const s of [-1, 1]) {
        c.beginPath();
        c.moveTo(-0.10, 0.10);
        c.lineTo(s * 0.012, 0.32);
        c.stroke();
        // 脚（三趾）
        c.strokeStyle = "rgba(100,74,52,0.90)";
        c.lineWidth = 0.004;
        c.beginPath();
        c.moveTo(s * 0.012, 0.32);
        c.lineTo(s * 0.022, 0.35);
        c.moveTo(s * 0.012, 0.32);
        c.lineTo(0, 0.35);
        c.moveTo(s * 0.012, 0.32);
        c.lineTo(s * 0.030, 0.35);
        c.stroke();
      }
      c.restore();
    }

    // 尾（短羽）
    c.beginPath();
    c.moveTo(-0.16, -0.02);
    c.quadraticCurveTo(-0.20, -0.08, -0.26, -0.06);
    c.quadraticCurveTo(-0.22, 0.02, -0.16, 0.02);
    c.closePath();
    c.fillStyle = "rgba(100,124,150,0.85)";
    c.fill();
    c.strokeStyle = "rgba(64,82,104,0.55)";
    c.lineWidth = 0.006; c.stroke();

    // 身体（洁白）
    c.beginPath();
    c.ellipse(-0.04, -0.02, 0.22, 0.13, -0.05, 0, TAU);
    const bg = c.createRadialGradient(-0.08, -0.06, 0.01, -0.04, -0.02, 0.24);
    bg.addColorStop(0, "rgba(250,252,252,0.97)");
    bg.addColorStop(0.65, "rgba(230,238,244,0.95)");
    bg.addColorStop(1, "rgba(176,192,210,0.90)");
    c.fillStyle = bg;
    c.fill();
    c.strokeStyle = "rgba(92,112,134,0.40)";
    c.lineWidth = 0.008;
    c.stroke();

    // 翅膀收束在身侧
    c.save();
    c.translate(-0.04, -0.02);
    c.beginPath();
    c.moveTo(-0.16, -0.06);
    c.quadraticCurveTo(0.04, -0.12, 0.18, -0.02);
    c.quadraticCurveTo(0.14, 0.06, -0.14, 0.04);
    c.closePath();
    const wg = c.createLinearGradient(0, -0.12, 0, 0.06);
    wg.addColorStop(0, "rgba(212,224,236,0.92)");
    wg.addColorStop(1, "rgba(124,146,170,0.88)");
    c.fillStyle = wg; c.fill();
    c.strokeStyle = "rgba(86,108,132,0.50)"; c.lineWidth = 0.006; c.stroke();
    // 翅上黑色飞羽尖端
    c.beginPath();
    c.moveTo(0.02, -0.09);
    c.quadraticCurveTo(0.12, -0.08, 0.18, -0.02);
    c.quadraticCurveTo(0.14, 0.02, 0.04, -0.05);
    c.closePath();
    c.fillStyle = "rgba(50,68,90,0.85)"; c.fill();
    c.restore();

    // 细长脖子 + 头（S 形曲线）
    if (neckA > 0.02) {
      c.save();
      c.globalAlpha *= neckA;
      // 脖子主体（用粗描边 + 填充）
      c.strokeStyle = "rgba(248,250,252,0.96)";
      c.lineWidth = 0.048;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(0.14, -0.04);
      c.bezierCurveTo(0.22, -0.10, 0.28, -0.24 + neckSway, 0.24, -0.34 + neckSway);
      c.stroke();
      // 脖子描边
      c.strokeStyle = "rgba(92,112,134,0.40)";
      c.lineWidth = 0.008;
      c.beginPath();
      c.moveTo(0.14, -0.04);
      c.bezierCurveTo(0.22, -0.10, 0.28, -0.24 + neckSway, 0.24, -0.34 + neckSway);
      c.stroke();
      c.restore();
    }

    // 头（圆）
    c.beginPath();
    c.arc(0.24, -0.38 + neckSway, 0.042, 0, TAU);
    const hg = c.createRadialGradient(0.22, -0.40 + neckSway, 0.004, 0.24, -0.38 + neckSway, 0.042);
    hg.addColorStop(0, "rgba(250,252,252,0.97)");
    hg.addColorStop(1, "rgba(216,226,236,0.92)");
    c.fillStyle = hg; c.fill();
    c.strokeStyle = "rgba(92,112,134,0.45)";
    c.lineWidth = 0.006; c.stroke();

    // 头顶红冠
    if (redCrownA > 0.02) {
      c.save();
      c.globalAlpha *= redCrownA;
      c.fillStyle = "rgba(196,50,58,0.95)";
      c.beginPath();
      c.arc(0.24, -0.41 + neckSway, 0.028, 0, TAU);
      c.fill();
      c.strokeStyle = "rgba(148,30,38,0.60)";
      c.lineWidth = 0.004; c.stroke();
      c.restore();
    }

    // 嘴（细长）
    const bx = 0.24, by = -0.37 + neckSway;
    c.beginPath();
    c.moveTo(bx + 0.038, by - 0.005);
    c.lineTo(bx + 0.110, by + 0.005);
    c.lineTo(bx + 0.038, by + 0.015);
    c.closePath();
    c.fillStyle = "rgba(220,180,120,0.92)"; c.fill();
    c.strokeStyle = "rgba(120,82,40,0.70)";
    c.lineWidth = 0.004; c.stroke();

    // 眼
    if (eyeA > 0.02) {
      c.save();
      c.globalAlpha *= eyeA;
      c.fillStyle = "rgba(20,28,40,0.95)";
      c.beginPath(); c.arc(0.245, -0.405 + neckSway, 0.009, 0, TAU); c.fill();
      c.fillStyle = "rgba(250,252,252,0.85)";
      c.beginPath(); c.arc(0.247, -0.407 + neckSway, 0.003, 0, TAU); c.fill();
      c.restore();
    }

    c.restore();
  }

}


/* =====================================================================
 * 四季氛围参数：春湿润浅粉 / 夏清透水光 / 秋金斜光 / 冬冷白薄雾
 * =================================================================== */
const LOOKS = [
  { // 春
    paperTop: [248, 242, 231], paperBot: [239, 228, 213],
    light: [255, 209, 197], lightA: 0.37, lightX: 0.30, lightY: 0.20, lightR: 0.82,
    mist: [255, 241, 235], mistA: 0.31, mistY: 0.62,
    waterA: 0, leafA: 0, beamA: 0, fogA: 0,
    accent: [170, 102, 104], textAccent: [143, 75, 71],
    particle: "pollen", partCol: [238, 170, 158], partA: 0.30,
    vignette: [84, 62, 50], vignetteA: 0.15, paperMul: 0.042, grain: 0.032,
  },
  { // 夏
    paperTop: [238, 244, 238], paperBot: [224, 235, 227],
    light: [204, 236, 224], lightA: 0.40, lightX: 0.70, lightY: 0.18, lightR: 0.80,
    mist: [232, 244, 239], mistA: 0.21, mistY: 0.58,
    waterA: 0.095, leafA: 0.095, beamA: 0, fogA: 0,
    accent: [62, 110, 99], textAccent: [57, 96, 86],
    particle: "spark", partCol: [176, 216, 204], partA: 0.28,
    vignette: [52, 70, 62], vignetteA: 0.16, paperMul: 0.038, grain: 0.030,
  },
  { // 秋
    paperTop: [247, 238, 219], paperBot: [235, 220, 192],
    light: [255, 211, 142], lightA: 0.41, lightX: 0.24, lightY: 0.16, lightR: 0.88,
    mist: [249, 233, 204], mistA: 0.25, mistY: 0.56,
    waterA: 0, leafA: 0, beamA: 0.092, fogA: 0,
    accent: [176, 126, 56], textAccent: [128, 84, 32],
    particle: "seed", partCol: [207, 151, 60], partA: 0.34,
    vignette: [80, 62, 36], vignetteA: 0.16, paperMul: 0.045, grain: 0.034,
  },
  { // 冬
    paperTop: [241, 244, 246], paperBot: [225, 232, 237],
    light: [226, 238, 247], lightA: 0.38, lightX: 0.72, lightY: 0.14, lightR: 0.85,
    mist: [242, 247, 251], mistA: 0.34, mistY: 0.46,
    waterA: 0, leafA: 0, beamA: 0, fogA: 0.18,
    accent: [120, 146, 164], textAccent: [64, 88, 104],
    particle: "snow", partCol: [138, 160, 176], partA: 0.34,
    vignette: [54, 66, 78], vignetteA: 0.20, paperMul: 0.035, grain: 0.030,
  },
];

function mixLook(a, b, k) {
  return {
    paperTop: mix3(a.paperTop, b.paperTop, k),
    paperBot: mix3(a.paperBot, b.paperBot, k),
    light: mix3(a.light, b.light, k), lightA: lerp(a.lightA, b.lightA, k),
    lightX: lerp(a.lightX, b.lightX, k), lightY: lerp(a.lightY, b.lightY, k),
    lightR: lerp(a.lightR, b.lightR, k),
    mist: mix3(a.mist, b.mist, k), mistA: lerp(a.mistA, b.mistA, k), mistY: lerp(a.mistY, b.mistY, k),
    waterA: lerp(a.waterA, b.waterA, k), leafA: lerp(a.leafA, b.leafA, k),
    beamA: lerp(a.beamA, b.beamA, k), fogA: lerp(a.fogA, b.fogA, k),
    accent: mix3(a.accent, b.accent, k), textAccent: mix3(a.textAccent, b.textAccent, k),
    particle: k < 0.5 ? a.particle : b.particle,
    partCol: mix3(a.partCol, b.partCol, k), partA: lerp(a.partA, b.partA, k),
    vignette: mix3(a.vignette, b.vignette, k), vignetteA: lerp(a.vignetteA, b.vignetteA, k),
    paperMul: lerp(a.paperMul, b.paperMul, k), grain: lerp(a.grain, b.grain, k),
  };
}

/* =====================================================================
 * 四季花单
 * =================================================================== */
const SEQ = n => Array.from({ length: 9 }, (_, i) => `assets/seq_norm/${n}_f${i}.png`);
/* 归一化帧约定（与 normalize_frames.py 一致）：
 * 1920×1920 画布，锚点=包围盒底边中点 (0.5, 1720/1920)，f0→f8 最大边占画布 0.55→0.76 */
const SEQ_ANCHOR_Y = 1720 / 1920;
const SEQ_BASE_OFF = 0.33;      // 锚点（花托）距画面中心向下的屏高比例 → 底座约 0.85H
const FLOWERS = [
  { season: "春", zh: "粉蝶", en: "Spring Butterfly", quote: "一点初生，翩然成蝶",
    images: [], procedural: true, draw: drawCellButterfly,
    burstCols: ["#f2b3b0", "#d78e8a", "#f7d9d4"], look: LOOKS[0] },
  { season: "夏", zh: "游鱼", en: "Little Fish", quote: "一点初生，倏尔成鱼",
    images: [], procedural: true, draw: drawCellFish,
    burstCols: ["#9fc6b6", "#d7eae0", "#5f9484"], look: LOOKS[1] },
  { season: "秋", zh: "麻雀", en: "Autumn Sparrow", quote: "一点初生，倏而成雀",
    images: [], procedural: true, draw: drawCellSparrow,
    burstCols: ["#d7b46f", "#b0803a", "#f3dfb3"], look: LOOKS[2] },
  { season: "冬", zh: "丹顶鹤", en: "Winter Crane", quote: "一点初生，忽而化鹤",
    images: [], procedural: true, draw: drawCellCrane,
    burstCols: ["#7b8fad", "#526884", "#d7dee8"], look: LOOKS[3] },
];

function loadTextures() {
  for (const f of FLOWERS) {
    f.tex = null; f.texState = "loading";
    const imgs = [];
    let done = 0, failed = false;
    f.images.forEach((src, i) => {
      const im = new Image();
      im.onload = () => {
        if (failed) return;
        imgs[i] = im;
        if (++done === f.images.length) { f.tex = imgs; f.texState = "ready"; }
      };
      im.onerror = () => {
        failed = true; f.tex = null; f.texState = "error";
        console.warn(`贴图加载失败，${f.zh} 使用程序化降级绘制：`, src);
      };
      im.src = src;
    });
  }
}
loadTextures();

if (lockFlower != null) state.flowerIndex = ((lockFlower % FLOWERS.length) + FLOWERS.length) % FLOWERS.length;
updateFlowerHUD();
prewarmParticles(FLOWERS[state.flowerIndex].look, 26);

/* =====================================================================
 * Web Audio：一条 48 秒丝竹循环，不随季节换曲
 * =================================================================== */
const audio = {
  ok: false, ctx: null, silent: false, source: null, buffer: null, gain: null, master: null,
  async init() {
    if (this.ctx) {
      this.ok = true;
      if (!this.source) this.load();
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const c = (this.ctx = new AC());
      this.master = c.createGain(); this.master.gain.value = 0.9;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(c.destination);
      this.gain = c.createGain(); this.gain.gain.value = 0;
      this.gain.connect(this.master);
      this.ok = true;
      await this.load();
      return true;
    } catch (e) {
      this.ok = false;
      console.warn("音频初始化失败：", e);
      return false;
    }
  },
  async load() {
    if (!this.ctx || this.source) return;
    try {
      const res = await fetch(CONFIG.music.url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arr);
      this.start();
    } catch (e) {
      // 音频是氛围，不是功能：失败不阻断画面，也不弹窗
      console.warn("背景音乐未加载：", e);
    }
  },
  start() {
    const c = this.ctx;
    if (!c || !this.buffer || this.source) return;
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.buffer.duration;
    src.connect(this.gain);
    src.start();
    this.source = src;
    if (this.silent) return;
    const t = c.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(0, t);
    this.gain.gain.linearRampToValueAtTime(CONFIG.music.gain, t + CONFIG.music.fadeIn);
  },
  setSilent(s) {
    this.silent = s;
    if (!this.ok) return;
    if (s) {
      if (this.ctx.state === "running") this.ctx.suspend();
    } else if (!document.hidden && this.ctx.state === "suspended") {
      this.ctx.resume();
      if (this.source) {
        this.gain.gain.setTargetAtTime(CONFIG.music.gain, this.ctx.currentTime, 1.4);
      }
    }
  },
  stopAll() { this.setSilent(true); },
  pageSuspend() {
    if (!this.ok) return;
    if (this.ctx.state === "running") this.ctx.suspend();
  },
  pageResume() {
    if (this.ok && !this.silent && !document.hidden && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  },
};

/* =====================================================================
 * 手势识别（MediaPipe HandLandmarker）—— 逻辑保持原样
 * =================================================================== */
let landmarker = null, camReady = false, lastDetect = 0, camStream = null;
let visionLib = null, visionFileset = null;

const HAND_LINKS = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[17,18],[18,19],[19,20], [0,17],
];

async function loadVisionLibrary() {
  const candidates = [CONFIG.mp.bundleAlt, CONFIG.mp.bundle].filter(Boolean);
  const problems = [];
  let lib = null;

  for (const raw of candidates) {
    // 加版本参数破缓存：某些浏览器会把旧的错误响应（如 text/plain）一直缓存着
    const url = raw + (raw.includes("?") ? "&" : "?") + "v=2";
    try {
      lib = await import(/* @vite-ignore */ url);
      break;
    } catch (e) {
      // 兜底：把脚本取成文本，再用 blob 模块导入，绕开 MIME 判定与浏览器缓存
      try {
        const txt = await fetch(url, { cache: "no-store" }).then(r => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        });
        const blobUrl = URL.createObjectURL(new Blob([txt], { type: "text/javascript" }));
        lib = await import(/* @vite-ignore */ blobUrl);
        break;
      } catch (e2) {
        const line = `import("${url}") → ${e.name}: ${e.message} ｜ blob 兜底 → ${e2.name}: ${e2.message}`;
        problems.push(line);
        console.warn("[手势库]", line);
      }
    }
  }

  // Patched vision_bundle 没有 export，类挂在全局 self 上
  // 如果动态 import 返回空对象，就从 self 上取
  if (lib && !lib.FilesetResolver && typeof self.FilesetResolver === "function") {
    lib = {
      FilesetResolver: self.FilesetResolver,
      HandLandmarker: self.HandLandmarker,
      // 导出的其他类按需扩展
    };
  }

  if (!lib) {
    visionLib = null; visionFileset = null;
    state.libraryError = problems.join(" ｜ ");
    showErrorDetail(state.libraryError);
    return false;
  }
  if (!lib.FilesetResolver) {
    visionLib = null; visionFileset = null;
    state.libraryError = `模块已加载，但缺少 FilesetResolver（vendor/mediapipe/vision_bundle.js 需要在全局导出 FilesetResolver）`;
    showErrorDetail(state.libraryError);
    return false;
  }

  visionLib = lib;
  try {
    visionFileset = await lib.FilesetResolver.forVisionTasks(CONFIG.mp.wasm);
  } catch (e) {
    visionLib = null; visionFileset = null;
    state.libraryError = `FilesetResolver.forVisionTasks("${CONFIG.mp.wasm}") → ${e.name}: ${e.message}`;
    console.error("[手势库 wasm]", state.libraryError, e);
    showErrorDetail(state.libraryError);
    return false;
  }

  state.libraryError = "";
  hideErrorDetail();
  return true;
}

async function loadHandModel() {
  try {
    if (!visionLib || !visionFileset) return false;
    landmarker = await visionLib.HandLandmarker.createFromOptions(visionFileset, {
      baseOptions: { modelAssetPath: CONFIG.mp.model, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    hideErrorDetail();
    return true;
  } catch (e) {
    const line = `HandLandmarker.createFromOptions("${CONFIG.mp.model}") → ${e.name}: ${e.message}`;
    state.libraryError = line;
    showErrorDetail(line);
    console.error("[模型]", line, e);
    landmarker = null;
    return false;
  }
}

async function initCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.camera.width, height: CONFIG.camera.height, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    camStream = stream;
    await video.play();
    camReady = true;
    el.camWrap.classList.remove("hidden");
    return "ok";
  } catch (e) {
    console.warn("摄像头不可用：", e);
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "denied";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "notfound";
    return "error";
  }
}

function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  video.srcObject = null;
  camReady = false;
  if (el.camWrap) el.camWrap.classList.add("hidden");
}

async function resumeCamera() {
  if (state.mode !== "camera" || camReady || document.hidden) return;
  showToast("正在重新请求摄像头…", 0);
  const r = await initCamera();
  if (r === "ok") showToast("把手伸进画面", 4200);
  else showToast(camFailMessage(r).text, 5200);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(false), ms))]);
}

const camFailMessage = reason => ({
  denied:      { text: "摄像头不可用/被拒绝", tip: "请在 Chrome 地址栏左侧的摄像头图标里改为「允许」，然后刷新页面。" },
  notfound:    { text: "摄像头不可用 · 未找到设备", tip: "请确认摄像头已连接且未被其他程序独占，然后重试。" },
  unsupported: { text: "摄像头不可用 · 当前环境不支持", tip: "请用 localhost 或 HTTPS 访问，并换用新版 Chrome。" },
  error:       { text: "摄像头不可用 · 取流失败", tip: "请关闭占用摄像头的其他程序后按 C 重新开启。" },
}[reason] || { text: "摄像头不可用", tip: "请检查设备与浏览器权限后重试。" });

function calcOpenness(lm) {
  const wrist = lm[0];
  const handSize = dist(lm[0], lm[9]) + 1e-6;
  const tips = [8, 12, 16, 20], mcps = [5, 9, 13, 17];
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += dist(lm[tips[k]], wrist) / dist(lm[mcps[k]], wrist);
  const o = clamp01((sum / 4 - CONFIG.open.min) / (CONFIG.open.max - CONFIG.open.min));
  const pinch = dist(lm[4], lm[8]) / handSize;
  const p = clamp01((pinch - CONFIG.pinch.closed) / (CONFIG.pinch.open - CONFIG.pinch.closed));
  return o * (0.55 + 0.45 * p);
}

const swipe = {
  points: [], cooldownUntil: 0,
  update(x, open, now, allowedDir) {
    if (now < this.cooldownUntil || open < CONFIG.swipe.minOpen) { this.points.length = 0; return false; }
    this.points.push({ x, t: now });
    while (this.points.length && now - this.points[0].t > CONFIG.swipe.windowMs) this.points.shift();
    if (this.points.length >= 3) {
      const dx = this.points[this.points.length - 1].x - this.points[0].x;
      if (Math.abs(dx) > CONFIG.swipe.dist && Math.sign(dx) === allowedDir) {
        this.cooldownUntil = now + CONFIG.swipe.cooldownMs;
        this.points.length = 0;
        return true;
      }
    }
    return false;
  },
};

function drawSkeleton(lm, color) {
  const w = skel.width, h = skel.height;
  skelCtx.strokeStyle = color; skelCtx.fillStyle = color;
  skelCtx.lineWidth = 4; skelCtx.lineCap = "round"; skelCtx.globalAlpha = 0.9;
  for (const [a, b] of HAND_LINKS) {
    skelCtx.beginPath();
    skelCtx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
    skelCtx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    skelCtx.stroke();
  }
  for (const p of lm) {
    skelCtx.beginPath();
    skelCtx.arc((1 - p.x) * w, p.y * h, 6, 0, TAU);
    skelCtx.fill();
  }
  skelCtx.globalAlpha = 1;
}

function detect(now) {
  if (!landmarker || !camReady || video.readyState < 2 || now - lastDetect < 16) return;
  lastDetect = now;
  let res;
  try { res = landmarker.detectForVideo(video, now); } catch (e) { return; }
  state.hands.right = null; state.hands.left = null;
  state.handCount = 0;
  skelCtx.clearRect(0, 0, skel.width, skel.height);
  const lms = res.landmarks || [], hds = res.handedness || [];
  const labelOf = i => {
    let l = hds[i] && hds[i][0] ? hds[i][0].categoryName : "Right";
    if (CONFIG.hands.swap) l = l === "Left" ? "Right" : "Left";
    return l;
  };
  let leftSX = null, rightSX = null;
  for (let i = 0; i < lms.length; i++) {
    if (labelOf(i) === "Left") leftSX = 1 - lms[i][0].x;
    else rightSX = 1 - lms[i][0].x;
  }
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    const label = labelOf(i);
    const open = calcOpenness(lm);
    const hand = { open, t: now };
    state.handCount++;
    if (label === "Left") {
      state.hands.left = hand;
      state.handSeen.left = now;
      const outward = rightSX != null ? (Math.sign(leftSX - rightSX) || -1) : -1;
      if (swipe.update(1 - lm[0].x, open, now, outward)) switchFlower(1);
      drawSkeleton(lm, "#7fb3a8");
    } else {
      state.hands.right = hand;
      state.handSeen.right = now;
      drawSkeleton(lm, "#c8552f");
    }
  }
}

/* =====================================================================
 * 换季：整幅画渡过去，不出现箭头、标签或闪字
 * =================================================================== */
function switchFlower(dir) {
  if (state.transition) return;
  const from = state.flowerIndex;
  state.flowerIndex = (state.flowerIndex + dir + FLOWERS.length) % FLOWERS.length;
  state.transition = { t: 0, from };
  spawnBurst(from);
  prewarmParticles(FLOWERS[state.flowerIndex].look, 20);
  updateFlowerHUD();
}

function updateFlowerHUD() {
  const f = FLOWERS[state.flowerIndex];
  el.season.textContent = f.season;
  el.nameZh.textContent = f.zh;
  el.quote.textContent = f.quote;
  document.documentElement.style.setProperty("--season-accent", rgba(f.look.textAccent, 0.92));
  for (const node of [el.season, el.nameZh, el.quote]) {
    if (node && node.animate) {
      node.animate(
        [{ opacity: 0.15 }, { opacity: 1 }],
        { duration: 900, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
      );
    }
  }
}

/* =====================================================================
 * 粒子：花粉 / 水光 / 桂子 / 雪粒；换季时少量花瓣随风散开
 * =================================================================== */
function spawnBurst(fi) {
  const f = FLOWERS[fi];
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * TAU, sp = 0.18 + Math.random() * 0.42;
    state.burst.push({
      x: 0, y: 0,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.06,
      rot: Math.random() * TAU, vr: (Math.random() * 2 - 1) * 2.4,
      s: 0.035 + Math.random() * 0.06,
      t: 0, life: 1.4 + Math.random() * 0.8,
      col: f.burstCols[(Math.random() * f.burstCols.length) | 0],
    });
  }
}

function spawnParticle(look) {
  const kind = look.particle;
  let x = 0, y = 0, vx = 0, vy = 0, r = 0.002, life = 8, sway = 0.004;
  if (kind === "pollen") {
    const a = Math.random() * TAU, d = Math.random() * 0.42;
    x = 0.5 + Math.cos(a) * d * (W / H > 1 ? 1.1 : 0.7);
    y = 0.52 + Math.sin(a) * d;
    vx = (Math.random() - 0.5) * 0.006;
    vy = -0.008 - Math.random() * 0.012;
    r = 0.0016 + Math.random() * 0.0022;
    life = 5 + Math.random() * 5;
    sway = 0.004;
  } else if (kind === "spark") {
    x = Math.random();
    y = 0.55 + Math.random() * 0.42;
    vx = (Math.random() - 0.5) * 0.008;
    vy = -0.003 - Math.random() * 0.004;
    r = 0.0010 + Math.random() * 0.0014;
    life = 3.5 + Math.random() * 4;
    sway = 0.002;
  } else if (kind === "seed") {
    x = Math.random();
    y = -0.03;
    vx = (Math.random() - 0.5) * 0.010;
    vy = 0.014 + Math.random() * 0.016;
    r = 0.0018 + Math.random() * 0.0018;
    life = 9 + Math.random() * 7;
    sway = 0.006;
  } else { // snow
    x = Math.random();
    y = -0.03;
    vx = (Math.random() - 0.5) * 0.005;
    vy = 0.010 + Math.random() * 0.014;
    r = 0.0015 + Math.random() * 0.0018;
    life = 10 + Math.random() * 8;
    sway = 0.003;
  }
  state.particles.push({
    kind, x, y, vx, vy, r, life, age: 0, sway,
    ph: Math.random() * TAU,
    rgb: look.partCol.map(v => Math.min(255, v * (0.9 + Math.random() * 0.2))),
    baseA: look.partA * (0.7 + Math.random() * 0.6),
  });
}

/* 预铺一层：换季刚落下时就能看见风向与雪/桂子，不必等它们从天顶慢慢飘下来 */
function prewarmParticles(look, count) {
  for (let i = 0; i < count && state.particles.length < 56; i++) {
    spawnParticle(look);
    const p = state.particles[state.particles.length - 1];
    if (p.kind === "seed" || p.kind === "snow") {
      p.y = Math.random() * 0.98;
      p.age = Math.random() * p.life * 0.55;
    } else if (p.kind === "spark") {
      p.y = 0.55 + Math.random() * 0.42;
      p.age = Math.random() * p.life * 0.4;
    } else {
      p.x = 0.5 + (Math.random() - 0.5) * 0.78;
      p.y = 0.52 + (Math.random() - 0.5) * 0.66;
      p.age = Math.random() * p.life * 0.4;
    }
  }
}

function updateParticles(dt, look) {
  const RATE = { pollen: 1.8, spark: 0.9, seed: 1.9, snow: 1.6 };
  const rate = RATE[look.particle] || 1;
  state.partAcc += dt * rate;
  while (state.partAcc >= 1) {
    state.partAcc -= 1;
    if (state.particles.length < 56) spawnParticle(look);
  }

  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.age += dt;
    p.x += (p.vx + Math.sin(state.time * 0.75 + p.ph) * p.sway) * dt;
    p.y += p.vy * dt;
    if (p.age > p.life || p.x < -0.08 || p.x > 1.08 || p.y < -0.08 || p.y > 1.08) {
      state.particles.splice(i, 1);
    }
  }

  for (let i = state.burst.length - 1; i >= 0; i--) {
    const p = state.burst[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 0.06 * dt;
    p.vx *= 0.995;
    p.rot += p.vr * dt;
    if (p.t > p.life) state.burst.splice(i, 1);
  }
}

/* =====================================================================
 * 纸纹与颗粒（一次生成，不每帧重算）
 * =================================================================== */
let grainPat = null, paperTex = null;
function makeNoiseTextures() {
  const g = document.createElement("canvas");
  g.width = g.height = 128;
  const gc = g.getContext("2d");
  const id = gc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 128 + (Math.random() * 70 - 35) | 0;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  gc.putImageData(id, 0, 0);
  grainPat = ctx.createPattern(g, "repeat");

  const p = document.createElement("canvas");
  p.width = p.height = 256;
  const pc = p.getContext("2d");
  pc.fillStyle = "#f2eee4"; pc.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 760; i++) {
    pc.fillStyle = `rgba(${180 + Math.random() * 40 | 0},${170 + Math.random() * 40 | 0},${150 + Math.random() * 40 | 0},0.045)`;
    pc.beginPath();
    pc.arc(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 7, 0, TAU);
    pc.fill();
  }
  pc.strokeStyle = "rgba(120,108,88,0.045)";
  pc.lineWidth = 0.8;
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const a = Math.random() * TAU, l = 4 + Math.random() * 14;
    pc.beginPath(); pc.moveTo(x, y); pc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); pc.stroke();
  }
  paperTex = p;
}
makeNoiseTextures();

/* =====================================================================
 * 背景：光、雾、水纹、斜光、纸纹
 * =================================================================== */
function softEllipse(cx, cy, rx, ry, color, alpha) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(Math.max(1, rx), Math.max(1, ry));
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.52, rgba(color, alpha * 0.38));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawBackground(look) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgba(look.paperTop, 1));
  g.addColorStop(1, rgba(look.paperBot, 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 主光：春从左上暖过来，夏从右上透，秋左上斜金，冬右上冷白
  const lx = W * look.lightX, ly = H * look.lightY;
  const lr = Math.max(W, H) * look.lightR;
  const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
  lg.addColorStop(0, rgba(look.light, look.lightA));
  lg.addColorStop(0.52, rgba(look.light, look.lightA * 0.32));
  lg.addColorStop(1, rgba(look.light, 0));
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, H);

  // 雾带：慢漂的三团湿气
  for (let i = 0; i < 3; i++) {
    const cx = W * (0.16 + i * 0.33 + Math.sin(state.time * 0.018 + i * 1.7) * 0.030);
    const cy = H * (look.mistY + i * 0.125) + Math.sin(state.time * 0.022 + i * 1.3) * H * 0.012;
    const rx = W * (0.34 + i * 0.10);
    const ry = H * (0.085 + i * 0.022);
    softEllipse(cx, cy, rx, ry, look.mist, look.mistA * (i === 1 ? 1 : 0.68));
  }

  // 画底：一层极淡的“地平”压住下缘，让花有落处
  softEllipse(W * 0.5, H * 1.03, W * 0.66, H * 0.16, look.vignette, 0.055);
  softEllipse(W * 0.5, H * 1.06, W * 0.34, H * 0.10, look.vignette, 0.045);

  // 夏：荷叶影 + 水纹
  if (look.leafA > 0.004) {
    softEllipse(W * 0.08, H * 0.93, W * 0.27, H * 0.10, [54, 78, 62], look.leafA);
    softEllipse(W * 0.95, H * 0.96, W * 0.30, H * 0.12, [54, 78, 62], look.leafA * 0.90);
    softEllipse(W * 0.76, H * 0.80, W * 0.17, H * 0.055, [60, 84, 68], look.leafA * 0.80);
  }
  if (look.waterA > 0.004) {
    ctx.save();
    for (let k = 0; k < 3; k++) {
      const baseY = H * (0.80 + k * 0.055);
      const amp = 4 + k * 3;
      const ph = state.time * (0.10 + k * 0.05);
      ctx.strokeStyle = rgba(look.accent, look.waterA * (1 - k * 0.24));
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 16) {
        const y = baseY + Math.sin(x / (150 + k * 40) + ph) * amp
                + Math.sin(x / (66 + k * 18) - ph * 1.4) * amp * 0.35;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // 秋：一片斜过来的金色光
  if (look.beamA > 0.004) {
    const bg = ctx.createLinearGradient(W * 0.02, 0, W * 0.86, H);
    bg.addColorStop(0, rgba([255, 218, 156], look.beamA));
    bg.addColorStop(0.52, rgba([255, 224, 170], look.beamA * 0.42));
    bg.addColorStop(1, rgba([255, 224, 170], 0));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(-W * 0.02, -H * 0.05);
    ctx.lineTo(W * 0.30, -H * 0.05);
    ctx.lineTo(W * 0.96, H * 1.05);
    ctx.lineTo(W * 0.57, H * 1.05);
    ctx.closePath();
    ctx.fill();
    softEllipse(W * 0.20, H * 0.18, W * 0.34, H * 0.22, [255, 216, 150], look.beamA * 0.9);
  }

  // 冬：额外两层薄雾，横着慢慢过
  if (look.fogA > 0.004) {
    softEllipse(W * (0.35 + Math.sin(state.time * 0.02) * 0.04), H * 0.42, W * 0.46, H * 0.045, look.mist, look.fogA);
    softEllipse(W * (0.70 + Math.cos(state.time * 0.017) * 0.05), H * 0.62, W * 0.52, H * 0.05, look.mist, look.fogA * 0.8);
  }
}

/* =====================================================================
 * 花朵 + 粒子 + 手影 + 纸面
 * =================================================================== */
function drawFlowerAt(cx, cy, S, fi, bloom, alpha, scale) {
  if (alpha <= 0.002) return;
  const f = FLOWERS[fi];
  ctx.save();
  ctx.translate(cx, cy);

  if (!f.procedural && f.texState === "ready") {
    const bb = clamp01(bloom);
    const n = f.tex.length;
    // 92% 即视为全开：让 f8 完整露出，避免两帧叠出“鬼影花瓣”
    const pos = clamp01(bb / 0.92) * (n - 1);
    const i0 = Math.min(n - 1, Math.floor(pos));
    const i1 = Math.min(n - 1, i0 + 1);
    // 只在帧间隙最后 35% 短混合；混合期不叠加整体缩放，尺寸只来自归一化帧本身
    const local = pos - i0;
    const w = i1 === i0 ? 0 : (local > 0.65 ? smooth((local - 0.65) / 0.35) : 0);
    const breathe = 1 + Math.sin(state.time * 0.9) * 0.008 + Math.sin(state.time * 0.53 + 1.7) * 0.005;
    const size = Math.min(W, H) * scale * breathe;
    const ay = H * SEQ_BASE_OFF;                    // 花托（锚点）相对 (cx,cy) 的位置

    // 季节色晕（很淡，只衬纸与花的接触）与落纸柔影
    const hcy = ay - size * 0.40;
    softEllipse(0, hcy, size * 0.46, size * 0.42, f.look.accent, alpha * (0.045 + bb * 0.035));
    softEllipse(0, ay + size * 0.015, size * 0.30, size * 0.05, [72, 60, 46], alpha * 0.085);

    ctx.translate(0, ay);                           // 绕花托轻微摇曳，底座不动
    ctx.rotate(Math.sin(state.time * 0.32) * 0.010);
    const dx = -size / 2, dy = -size * SEQ_ANCHOR_Y;
    if (w < 1) {
      ctx.globalAlpha = alpha * (1 - w);
      ctx.drawImage(f.tex[i0], dx, dy, size, size);
    }
    if (w > 0) {
      ctx.globalAlpha = alpha * w;
      ctx.drawImage(f.tex[i1], dx, dy, size, size);
    }
  } else if (f.procedural || f.texState === "error") {
    ctx.globalAlpha = alpha;
    ctx.scale(S * scale, S * scale);
    f.draw(ctx, bloom, state.time);
  }
  ctx.restore();
}

function drawParticles() {
  const m = Math.min(W, H);
  for (const p of state.particles) {
    const fadeIn = Math.min(1, p.age / 1.1);
    const fadeOut = Math.min(1, (p.life - p.age) / 1.4);
    const a = p.baseA * fadeIn * fadeOut;
    if (a <= 0.01) continue;
    const x = p.x * W, y = p.y * H;
    ctx.fillStyle = rgba(p.rgb, a);
    if (p.kind === "seed") {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(state.time * 0.7 + p.ph) * 0.5);
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.5, 3.4, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    } else {
      const radius = Math.max(p.kind === "snow" ? 1.0 : 0.7, p.r * m);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();
      if (p.kind === "snow" && radius > 1.4) {
        ctx.fillStyle = rgba(p.rgb, a * 0.28);
        ctx.beginPath();
        ctx.arc(x, y, radius * 2.4, 0, TAU);
        ctx.fill();
      }
    }
  }
}

function drawBurst(cx, cy, S) {
  for (const p of state.burst) {
    const a = Math.max(0, 1 - p.t / p.life);
    ctx.save();
    ctx.translate(cx + p.x * S, cy + p.y * S);
    ctx.rotate(p.rot);
    ctx.globalAlpha = a * 0.5;
    ctx.fillStyle = p.col;
    petalPath(ctx, p.s * S, p.s * S * 0.62, 0.2);
    ctx.fill();
    ctx.restore();
  }
}

function drawVignette(look) {
  const cx = W / 2, cy = H * 0.52;
  const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.36, cx, cy, Math.max(W, H) * 0.84);
  vg.addColorStop(0, rgba(look.vignette, 0));
  vg.addColorStop(0.72, rgba(look.vignette, look.vignetteA * 0.28));
  vg.addColorStop(1, rgba(look.vignette, look.vignetteA));
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function drawPaper(look) {
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = look.paperMul;
  ctx.drawImage(paperTex, 0, 0, W, H);
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = look.grain;
  const ox = (Math.random() * 128) | 0, oy = (Math.random() * 128) | 0;
  ctx.translate(-ox, -oy);
  ctx.fillStyle = grainPat;
  ctx.fillRect(0, 0, W + 128, H + 128);
  ctx.restore();
}

/* =====================================================================
 * 渲染主循环
 * =================================================================== */
function currentLook() {
  const tr = state.transition;
  if (tr) return mixLook(FLOWERS[tr.from].look, FLOWERS[state.flowerIndex].look, smooth(tr.t));
  return FLOWERS[state.flowerIndex].look;
}

function render(dt) {
  if (state.transition) {
    state.transition.t += dt / CONFIG.transitionDur;
    if (state.transition.t >= 1) state.transition = null;
  }

  const look = currentLook();
  updateParticles(dt, look);

  const cx = W * 0.52, cy = H * 0.52;
  const S = Math.min(W, H) * 0.315;

  drawBackground(look);

  const tr = state.transition;
  if (tr && tr.t < 0.52) {
    const k = smooth(tr.t / 0.52);
    drawFlowerAt(cx, cy - S * 0.06 * k, S, tr.from, state.bloom * (1 - 0.12 * k), 1 - k, 1 - 0.05 * k);
  }
  if (tr && tr.t > 0.42) {
    const k = smooth((tr.t - 0.42) / 0.58);
    drawFlowerAt(cx, cy + S * 0.06 * (1 - k), S, state.flowerIndex, state.bloom, k, 0.95 + 0.05 * k);
  } else if (!tr) {
    drawFlowerAt(cx, cy, S, state.flowerIndex, state.bloom, 1, 1);
  }

  drawParticles();
  drawBurst(cx, cy, S);
  drawVignette(look);
  drawPaper(look);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;

  detect(now);

  /* 左右手标签：检测到亮起，丢失后保持约 400ms 再变暗，防抖 */
  const HOLD = 400;
  if (el.tagLeft)  el.tagLeft.classList.toggle("on",  now - state.handSeen.left  < HOLD);
  if (el.tagRight) el.tagRight.classList.toggle("on", now - state.handSeen.right < HOLD);

  const rFresh = state.hands.right && now - state.hands.right.t < 400;
  let target;
  if (state.mode === "camera") {
    if (rFresh) {
      target = state.hands.right.open;
      state.noHandSince = 0;
    } else {
      if (!state.noHandSince) state.noHandSince = now;
      const gone = (now - state.noHandSince) / 1000;
      target = gone > CONFIG.handAway.holdMs / 1000
        ? (state.bloom > CONFIG.handAway.rest ? CONFIG.handAway.rest : state.bloom)
        : state.bloom;
    }
  } else {
    target = state.manualBloom;
  }

  if (lockBloom != null) {
    state.bloom = lockBloom;
    state.bloomVel = 0;
  } else {
    state.bloomVel += (target - state.bloom) * CONFIG.spring.k * dt;
    state.bloomVel *= Math.exp(-CONFIG.spring.d * dt);
    state.bloom = clamp01(state.bloom + state.bloomVel * dt);
    if (state.bloom <= 0 || state.bloom >= 1) state.bloomVel = 0;
  }

  render(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* =====================================================================
 * 提示 / 错误
 * =================================================================== */
let toastTimer = null;
function showToast(text, ms = 4200) {
  if (!el.toast || state.demo || state.still) return;
  el.toast.textContent = text;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
}

function showErrorDetail(txt) {
  if (!el.errDetail || !txt) return;
  el.errDetail.textContent = `[加载诊断] ${txt}`;
  el.errDetail.classList.remove("hidden");
}
function hideErrorDetail() {
  if (!el.errDetail) return;
  el.errDetail.classList.add("hidden");
  el.errDetail.textContent = "";
}

function enterFallback(msg, tip) {
  state.mode = "fallback";
  el.camWrap.classList.add("hidden");
  video.style.display = "none";
  skel.style.display = "none";
  showToast(msg || "手动模式 · 空格绽开，方向键换季", 7000);
  if (tip) showErrorDetail(tip);
}

/* =====================================================================
 * 降级输入：键盘 / 鼠标
 * =================================================================== */
window.addEventListener("keydown", e => {
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) state.manualBloom = 1; }
  else if (e.code === "ArrowRight") switchFlower(1);
  else if (e.code === "ArrowLeft") switchFlower(-1);
  else if (e.code === "KeyM") { syncSoundUI(!audio.silent); }
  else if (e.code === "KeyC") {
    if (camReady) { stopCamera(); showToast("摄像头已关闭 · 按 C 重新开启", 4200); }
    else resumeCamera();
  }
  else if (e.code === "KeyD") { setDemo(!state.demo); }
  else if (e.code === "Escape" && state.demo) { setDemo(false); }
});

/* ---------------- 演示模式：只留花、标题、季节花名、花语、印章 ---------------- */
let blackoutTimer = null;
function setDemo(on) {
  if (state.demo === on) return;
  el.blackout.classList.add("on");
  clearTimeout(blackoutTimer);
  blackoutTimer = setTimeout(() => {
    state.demo = on;
    document.body.classList.toggle("demo", on);
    el.blackout.classList.remove("on");
    if (on) {
      el.toast.classList.remove("show");
      hideErrorDetail();
    }
  }, 180);
}

/* ---------------- 开场揭幕：纸褪去 ---------------- */
function playReveal() {
  const rv = el.reveal;
  if (!rv) return;
  rv.classList.remove("hidden", "play", "fade");
  void rv.offsetWidth;
  rv.classList.add("play");
  setTimeout(() => rv.classList.add("fade"), 1100);
  setTimeout(() => { rv.classList.add("hidden"); rv.classList.remove("play", "fade"); }, 1500);
}

function syncSoundUI(silent) {
  audio.setSilent(silent);
  el.muteGlyph.textContent = silent ? "静" : "♪";
  el.soundBtn.classList.toggle("muted", silent);
}
el.soundBtn.addEventListener("click", () => syncSoundUI(!audio.silent));

/* ---------------- 回看小窗：拖动 + 记住位置 ---------------- */
skel.width = 1280; skel.height = 720;   // 与 getUserMedia 理想分辨率一致，避免骨架被拉伸发糊
(function setupCamDrag() {
  const w = el.camWrap;
  if (!w) return;
  try {
    const saved = JSON.parse(localStorage.getItem("camPos") || "null");
    if (saved && typeof saved.x === "number") {
      w.style.right = "auto"; w.style.bottom = "auto";
      w.style.left = (saved.x * 100) + "vw";
      w.style.top = (saved.y * 100) + "vh";
    }
  } catch (e) {}
  let dragging = false, ox = 0, oy = 0;
  const onDown = e => {
    dragging = true; w.classList.add("dragging");
    const r = w.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    e.preventDefault();
  };
  const onMove = e => {
    if (!dragging) return;
    w.style.right = "auto"; w.style.bottom = "auto";
    const nx = Math.max(0, Math.min(window.innerWidth - w.offsetWidth, e.clientX - ox));
    const ny = Math.max(0, Math.min(window.innerHeight - w.offsetHeight, e.clientY - oy));
    w.style.left = nx + "px"; w.style.top = ny + "px";
    try { localStorage.setItem("camPos", JSON.stringify({ x: nx / window.innerWidth, y: ny / window.innerHeight })); } catch (e) {}
  };
  const onUp = () => { dragging = false; w.classList.remove("dragging"); };
  w.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
})();

/* 音频与摄像头卫生：后台/失焦挂起，回前台恢复 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { audio.pageSuspend(); stopCamera(); }
  else { audio.pageResume(); resumeCamera(); }
});
window.addEventListener("blur",  () => { audio.pageSuspend(); stopCamera(); });
window.addEventListener("focus", () => { if (!document.hidden) { audio.pageResume(); resumeCamera(); } });
window.addEventListener("keyup", e => {
  if (e.code === "Space") state.manualBloom = 0;
});
let dragging = false;
window.addEventListener("mousedown", e => {
  if (e.target.closest("#gate") || e.target.closest("button")) return;
  dragging = true;
  state.manualBloom = clamp01(1 - e.clientY / window.innerHeight);
});
window.addEventListener("mousemove", e => {
  if (dragging) state.manualBloom = clamp01(1 - e.clientY / window.innerHeight);
});
window.addEventListener("mouseup", () => { dragging = false; });

/* ---------------- 入口：点击进入（解锁音频 + 启动摄像头/模型） ---------------- */
el.startBtn.addEventListener("click", async () => {
  el.gate.classList.add("hide");
  playReveal();
  audio.init();
  if (audio.ctx && !audio.silent && !document.hidden && audio.ctx.state === "suspended") {
    audio.ctx.resume();
  }

  showToast("正在加载手势库…", 0);
  if (!(await withTimeout(loadVisionLibrary(), 25000))) {
    enterFallback("手势库加载失败",
      state.libraryError || "加载超时（25 秒）：网络或电脑太慢，请刷新页面重试；建议用 Chrome / Edge 打开 http://localhost:8000/");
    return;
  }

  showToast("正在请求摄像头权限…", 0);
  const camRes = await withTimeout(initCamera(), 12000);
  if (camRes !== "ok") {
    const m = camFailMessage(camRes === false ? "error" : camRes);
    enterFallback(camRes === false ? "摄像头请求超时" : m.text,
      camRes === false ? "授权弹窗无响应，请在 Chrome 里允许摄像头后刷新页面。" : m.tip);
    return;
  }

  showToast("正在加载手势模型…", 0);
  if (!(await withTimeout(loadHandModel(), 25000))) {
    stopCamera();
    enterFallback("模型加载失败",
      "请确认 vendor/models/hand_landmarker.task 文件存在且未损坏（正常约 7.6 MB）。");
    return;
  }

  state.mode = "camera";
  hideErrorDetail();
  showToast("把手伸进画面", 4800);
});

/* ---------------- 截图/静态检查：?still=1&f=2&bloom=0.85&demo=1 ---------------- */
if (STILL) {
  el.gate.style.display = "none";
  if (params.get("showcam") !== "1") el.camWrap.classList.add("hidden");
  el.reveal.classList.add("hidden");
  state.mode = "fallback";
  state.manualBloom = lockBloom != null ? lockBloom : 0.8;
  if (DEMO_START) {
    state.demo = true;
    document.body.classList.add("demo");
  }
}
