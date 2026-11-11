/* 3D 结构查看器 · 前端逻辑
 *
 * 设计要点：
 *  - WebGL viewer 只创建一次，切换样式/过滤/容差不重建场景、不重置相机；
 *  - 服务端一次性下发“周期键候选段”，容差、元素对过滤全部在浏览器内实时完成；
 *  - PBC 开关负责补齐/隐藏晶胞外的镜像原子，保证跨边界键两端都有球可接。
 */

window.CALCGO_VIEWER_VERSION = "2026-10-30.2";

/* ------------------------- 元素数据 ------------------------- */

/* Jmol 的完整 CPK 元素色。此前只列了约一半元素，Pd、Ru、Rh、Ir 等都会落到
   同一个 #cccccc 兜底色，和浅色 Pt 一起时几乎无法区分。 */
const ELEMENT_COLORS = {
  H: "#ffffff", He: "#d9ffff", Li: "#cc80ff", Be: "#c2ff00", B: "#ffb5b5",
  C: "#909090", N: "#3050f8", O: "#ff0d0d", F: "#90e050", Ne: "#b3e3f5",
  Na: "#ab5cf2", Mg: "#8aff00", Al: "#bfa6a6", Si: "#f0c8a0", P: "#ff8000",
  S: "#ffff30", Cl: "#1ff01f", Ar: "#80d1e3", K: "#8f40d4", Ca: "#3dff00",
  Sc: "#e6e6e6", Ti: "#bfc2c7", V: "#a6a6ab", Cr: "#8a99c7", Mn: "#9c7ac7",
  Fe: "#e06633", Co: "#f090a0", Ni: "#50d050", Cu: "#c88033", Zn: "#7d80b0",
  Ga: "#c28f8f", Ge: "#668f8f", As: "#bd80e3", Se: "#ffa100", Br: "#a62929",
  Kr: "#5cb8d1", Rb: "#702eb0", Sr: "#00ff00", Y: "#94ffff", Zr: "#94e0e0",
  Nb: "#73c2c9", Mo: "#54b5b5", Tc: "#00a1a1", Ru: "#248f8f", Rh: "#0a7d8c",
  Pd: "#006985", Ag: "#c0c0c0", Cd: "#ffd98f", In: "#a67573", Sn: "#668080",
  Sb: "#9e63b5", Te: "#d47a00", I: "#940094", Xe: "#429eb0", Cs: "#57178f",
  Ba: "#00c900", La: "#70d4ff", Ce: "#ffffc7", Pr: "#d9ffc7", Nd: "#c7ffc7",
  Pm: "#a3ffc7", Sm: "#8fffc7", Eu: "#61ffc7", Gd: "#45ffc7", Tb: "#30ffc7",
  Dy: "#1fffc7", Ho: "#00ff9c", Er: "#00e675", Tm: "#00d452", Yb: "#00bf38",
  Lu: "#00ab24", Hf: "#4dc2ff", Ta: "#4da6ff", W: "#2194d6", Re: "#267dab",
  Os: "#266696", Ir: "#175487", Pt: "#d0d0e0", Au: "#ffd123", Hg: "#b8b8d0",
  Tl: "#a6544d", Pb: "#575961", Bi: "#9e4fb5", Po: "#ab5c00", At: "#754f45",
  Rn: "#428296", Fr: "#420066", Ra: "#007d00", Ac: "#70abfa", Th: "#00baff",
  Pa: "#00a1ff", U: "#008fff", Np: "#0080ff", Pu: "#006bff", Am: "#545cf2",
  Cm: "#785fe2", Bk: "#8a4fe2", Cf: "#a136d4", Es: "#b31fd4", Fm: "#b31fba",
  Md: "#b30da6", No: "#bd0d87", Lr: "#c70066", Rf: "#cc0059", Db: "#d1004f",
  Sg: "#d90045", Bh: "#e00038", Hs: "#e6002e", Mt: "#eb0026", Ds: "#eb0026",
  Rg: "#eb0026", Cn: "#eb0026", Nh: "#eb0026", Fl: "#eb0026", Mc: "#eb0026",
  Lv: "#eb0026", Ts: "#eb0026", Og: "#eb0026",
};

const PASTEL = [
  "#7aa2ff", "#ff8fa3", "#5fd4b8", "#ffc46b", "#c49bff", "#63c6ea",
  "#f28fc8", "#a9d26e", "#e28f6e", "#86a8e7", "#b7b8d8", "#8fe0a8",
];

const ELECTRONEGATIVITY = {
  H: 2.2, He: 0, Li: 0.98, Be: 1.57, B: 2.04, C: 2.55, N: 3.04, O: 3.44,
  F: 3.98, Ne: 0, Na: 0.93, Mg: 1.31, Al: 1.61, Si: 1.9, P: 2.19, S: 2.58,
  Cl: 3.16, Ar: 0, K: 0.82, Ca: 1.0, Sc: 1.36, Ti: 1.54, V: 1.63, Cr: 1.66,
  Mn: 1.55, Fe: 1.83, Co: 1.88, Ni: 1.91, Cu: 1.9, Zn: 1.65, Ga: 1.81,
  Ge: 2.01, As: 2.18, Se: 2.55, Br: 2.96, Kr: 3.0, Rb: 0.82, Sr: 0.95,
  Y: 1.22, Zr: 1.33, Nb: 1.6, Mo: 2.16, Tc: 1.9, Ru: 2.2, Rh: 2.28,
  Pd: 2.2, Ag: 1.93, Cd: 1.69, In: 1.78, Sn: 1.96, Sb: 2.05, Te: 2.1,
  I: 2.66, Xe: 2.6, Cs: 0.79, Ba: 0.89, La: 1.1, Hf: 1.3, Ta: 1.5,
  W: 2.36, Re: 1.9, Os: 2.2, Ir: 2.2, Pt: 2.28, Au: 2.54, Hg: 2.0,
  Tl: 1.62, Pb: 2.33, Bi: 2.02, U: 1.38,
};

function hashPick(el, arr) {
  let h = 0;
  for (let i = 0; i < el.length; i++) h = (h * 31 + el.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

function baseColor(el) {
  return ELEMENT_COLORS[el] || hashPick(el, PASTEL);
}

function schemeColor(el, scheme) {
  const c = baseColor(el);
  if (scheme === "soft") return mixHex(c, "#ffffff", 0.42);
  if (scheme === "mono") return "#8b99b3";
  return c;
}

function mixHex(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function canonPair(e1, e2) {
  if (e1 === e2) return e1 + "-" + e2;
  const x1 = ELECTRONEGATIVITY[e1] ?? -1;
  const x2 = ELECTRONEGATIVITY[e2] ?? -1;
  if (x1 === x2) return [e1, e2].sort().join("-");
  return x1 < x2 ? `${e1}-${e2}` : `${e2}-${e1}`;
}

/* ------------------------- 内置样例（几何已校正） ------------------------- */

const SAMPLES = {
  si: `Si
1.0
5.43 0.0 0.0
0.0 5.43 0.0
0.0 0.0 5.43
Si
8
Direct
0.000 0.000 0.000
0.000 0.500 0.500
0.500 0.000 0.500
0.500 0.500 0.000
0.250 0.250 0.250
0.750 0.750 0.250
0.750 0.250 0.750
0.250 0.750 0.750`,
  h2o: `H2O
1.0
10.0 0.0 0.0
0.0 10.0 0.0
0.0 0.0 10.0
O H
1 2
Direct
0.5000 0.5000 0.5000
0.5758 0.4414 0.5000
0.4242 0.4414 0.5000`,
  tio2: `TiO2
1.0
4.5937 0.0 0.0
0.0 4.5937 0.0
0.0 0.0 2.9581
Ti O
2 4
Direct
0.0 0.0 0.0
0.5 0.5 0.5
0.3048 0.3048 0.0
0.6952 0.6952 0.0
0.1952 0.8048 0.5
0.8048 0.1952 0.5`,
  zro2: `ZrO2
1.0
5.08 0.0 0.0
0.0 5.08 0.0
0.0 0.0 5.08
Zr O
4 8
Direct
0.0 0.0 0.0
0.0 0.5 0.5
0.5 0.0 0.5
0.5 0.5 0.0
0.25 0.25 0.25
0.75 0.75 0.25
0.75 0.25 0.75
0.25 0.75 0.75
0.75 0.75 0.75
0.25 0.25 0.75
0.25 0.75 0.25
0.75 0.25 0.25`,
};

/* ------------------------- 状态 ------------------------- */

const state = {
  data: null,
  rawText: null,
  fileName: "",
  cifIndex: 0,
  viewer: null,
  showBonds: true,
  tolerance: 1.15,
  pairFilters: new Set(),
  scheme: "cpk",
  mode: "ballstick",
  preset: "studio",
  theme: "light",
  outlineColor: "#31486f",
  cellColor: "#93a6cc",
  atomScale: 1.0,
  bondScale: 1.0,
  exportScale: 1,
  showCell: true,
  showPbc: false,          /* 周期镜像默认关：只看晶胞内的原子，避免镜像球把模型糊成一片 */
  ghostPts: [],
  basePts: [],
  warnedLarge: false,
  pbcWarned: false,
  measureMode: "",
  measurePicks: [],
  /* three.js 渲染引擎的视觉参数（见 viewer3d.js 的 DEFAULT_FX） */
  fx: {
    quality: "std",
    poly: "off",
    outline: 0.35,
    bloom: 0,
    vignette: 0.22,
    fog: 0,
    envRefl: 0.45,
    envPower: 1,
    lightPower: 1,
    exposure: 0.92,
    roughness: 0.34,
    metalness: 0.05,
    bgMode: "grad",
    bgTop: "#ffffff",
    bgBottom: "#e6edf8",
  },
};

/* 少量"半径和 × 容差"会低估的化学键。O–O 过氧键通常约 1.40–1.50 Å，
   而当前原子半径口径只给到 1.38 Å，导致 OOH* 的 O–O 候选被前端二次筛掉。
   只对该元素对使用化学上限，不放开其他可能被误连的次近邻。 */
const PAIR_MAX_BOND = {
  "O-O": 1.55,
};

/* 离线导出模式：页面由“导出离线 HTML”生成，结构数据已内嵌，无需后端 */
const OFFLINE_EXPORT = !!(window.__EXPORT__ && window.__EXPORT__.offline && window.__EXPORT__.data);

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SUB = "₀₁₂₃₄₅₆₇₈₉";
function subDigits(n) {
  return String(n).split("").map((d) => SUB[+d]).join("");
}

function prettyFormula(reduced) {
  if (!reduced) return "—";
  return reduced.replace(/(\d+)/g, (m) => subDigits(m));
}

function fmtNum(v, digits = 3) {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), 3200);
}

function loading(on) {
  $("loading").className = on ? "show" : "";
}

/* ------------------------- 线性代数 ------------------------- */

function inv3(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const D = c * h - b * i, E = a * i - c * g, F = b * g - a * h;
  const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

function vecSub(a, b) { return a.map((v, i) => v - b[i]); }
function vecLen(v) { return Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2); }
function vecDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/* 笛卡尔坐标 -> 分数坐标（cell 为行向量矩阵） */
function cartToFrac(p, cell) {
  if (cell !== state._cell) {
    state._cell = cell;
    state.cellInv = cell && cell.length === 3 ? inv3(cell) : null;
  }
  const inv = state.cellInv;
  if (!inv) return null;
  // p = f * cell  =>  f = p * cell^{-1}（对每列做点乘）
  return [
    p[0] * inv[0][0] + p[1] * inv[1][0] + p[2] * inv[2][0],
    p[0] * inv[0][1] + p[1] * inv[1][1] + p[2] * inv[2][1],
    p[0] * inv[0][2] + p[1] * inv[1][2] + p[2] * inv[2][2],
  ];
}

function insideCell(p, cell) {
  if (!cell) return true;
  const f = cartToFrac(p, cell);
  if (!f) return true;
  // 边界取闭区间：恰好在 0 或 1 面上的原子/键端都算“晶胞内”
  return f.every((v) => v >= -1e-3 && v < 1 + 1e-3);
}

function cellParams(cell) {
  const a = vecLen(cell[0]), b = vecLen(cell[1]), c = vecLen(cell[2]);
  const alpha = Math.acos(clamp(vecDot(cell[1], cell[2]) / (b * c || 1), -1, 1)) * 180 / Math.PI;
  const beta = Math.acos(clamp(vecDot(cell[0], cell[2]) / (a * c || 1), -1, 1)) * 180 / Math.PI;
  const gamma = Math.acos(clamp(vecDot(cell[0], cell[1]) / (a * b || 1), -1, 1)) * 180 / Math.PI;
  return { a, b, c, alpha, beta, gamma };
}

/* ------------------------- 上传 / 解析 ------------------------- */

const dz = $("dropzone");
const fileInput = $("fileInput");

dz.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
);
dz.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

/* 整页拖放 */
["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
  })
);
document.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && !e.target.closest("#dropzone")) loadFile(f);
});

/* 粘贴结构文本/文件 */
document.addEventListener("paste", (e) => {
  const target = e.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
  const cd = e.clipboardData;
  if (!cd) return;
  const f = cd.files && cd.files[0];
  if (f) {
    loadFile(f);
    return;
  }
  const text = (cd.getData("text/plain") || "").trim();
  if (text) uploadText(text, sniffName(text));
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = "";
});

document.querySelectorAll(".sample-btn").forEach((b) =>
  b.addEventListener("click", () => uploadText(SAMPLES[b.dataset.sample], b.dataset.sample + ".POSCAR"))
);

$("btnReplace").addEventListener("click", () => fileInput.click());
$("btnClear").addEventListener("click", clearAll);

function sniffName(text) {
  const s = text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  return /^(data_|loop_|_cell_)/.test(s) ? "pasted.cif" : "pasted.POSCAR";
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => uploadText(String(reader.result), file.name);
  reader.readAsText(file);
}

async function uploadText(text, name, index = 0) {
  if (OFFLINE_EXPORT) {
    toast("这是离线演示文件，请用生成它的工具导入新结构", true);
    return;
  }
  loading(true);
  try {
    const fd = new FormData();
    fd.append("file", new Blob([text], { type: "text/plain" }), name);
    fd.append("index", String(index));
    const resp = await fetch("/api/parse", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "解析失败");
    state.rawText = text;
    state.fileName = name || "structure";
    state.cifIndex = index;
    renderStructure(data);
  } catch (e) {
    toast(e.message, true);
  } finally {
    loading(false);
  }
}

function clearAll() {
  state.data = null;
  state.rawText = null;
  state.fileName = "";
  state.pairFilters.clear();
  state.warnedLarge = false;
  state.pbcWarned = false;
  if (state.viewer) {
    try {
      state.viewer.setDisplay(null, null);
    } catch (_) { /* 空查看器 */ }
  }
  $("emptyTip").classList.remove("hidden");
  $("fileMeta").classList.add("hidden");
  $("cifWrap").classList.add("hidden");
  $("legend").innerHTML = "";
  $("viewerMeta").classList.add("hidden");
  $("pairChips").innerHTML = '<span class="chip-none">—</span>';
  $("bondCount").classList.add("hidden");
  $("formula").textContent = "—";
  $("nAtoms").textContent = "—";
  $("volume").textContent = "—";
  $("density").textContent = "—";
  $("cellInfo").classList.add("hidden");
  $("hoverTip").classList.add("hidden");
  $("btnExportOffline").disabled = true;
}

/* ------------------------- 结构渲染 ------------------------- */

function getViewer() {
  if (!state.viewer) {
    state.viewer = window.SVViewer.create($("viewer"), {
      onHover: onAtomHover,
      onLeave: () => $("hoverTip").classList.add("hidden"),
      onClick: onAtomClick,
    });
  }
  return state.viewer;
}

/* 描边颜色跟着主题走 */
function outlineColor() {
  return state.outlineColor || (state.theme === "dark" ? "#030710" : "#31486f");
}

/* 引擎样式：颜色、半径、显隐都在这里决定；引擎只负责画 */
function viewerStyle() {
  return {
    colorOf: (el) => schemeColor(el, state.scheme),
    radiusOf: (el, rCov) => sphereRadius(el, rCov == null ? 0.7 : rCov),
    bondRadius: () => bondRadius(),
    cellRadius: () => cellRodRadius(),
    cellColor: cellLineColor(),
    showBonds: state.showBonds && state.mode !== "spacefill",
    showCell: state.showCell,
    schemeKey: state.scheme,
    outlineColor: outlineColor(),
  };
}

/* 结构 / 成键集合变化：重建几何 */
function refreshData() {
  if (!state.data) return null;
  const display = buildDisplay(visibleSegments());
  if (display.degraded && !state.pbcWarned) {
    state.pbcWarned = true;
    setTimeout(() => toast("结构较大，周期镜像已按轻量模式补全（最外层原子连接可能不完整）"), 300);
  }
  // 引擎按共价半径决定球的相对大小，这里把每个原子的半径补进显示数据
  const R = state.data.atoms.r;
  display.atoms.forEach((a) => { if (R && R[a.i] != null) a.r = R[a.i]; });
  const v = getViewer();
  v.setStyle(viewerStyle());
  v.setDisplay(display, state.data.cell);
  updateBondMeta(display.bonds.length);
  return display;
}

/* 只改样式：颜色 / 大小 / 显隐 */
function refreshStyle() {
  if (!state.data) return;
  getViewer().setStyle(viewerStyle());
}

/* 只改渲染效果（光照 / 反射 / 辉光 / 描边 / 多面体…） */
function refreshFx() {
  if (!state.viewer) return;
  state.viewer.setFx(state.fx);
}

function renderStructure(data, opts) {
  const o = opts || {};
  state.data = data;
  if (!o.keepView && state.measurePicks.length) {
    // 换了一个结构：上一组的测量点不属于新结构，清掉（测量模式本身保留）
    state.measurePicks = [];
    const mOut = document.getElementById("vMeasureOut");
    if (mOut) mOut.textContent = state.measureMode === "angle" ? "依次点 3 个原子" : "依次点 2 个原子";
  }
  state.pairFilters.clear(); // 换结构时清掉旧筛选，避免“旧筛选在新结构里静默失效”
  state.pbcWarned = false;
  state.fileName = data.name || state.fileName || "structure";
  state.cellInv = data.cell && data.cell.length === 3 ? inv3(data.cell) : null;
  $("emptyTip").classList.add("hidden");
  $("fileMeta").classList.remove("hidden");
  $("fileName").textContent = data.name;
  $("fileName").title = data.name;
  $("formula").textContent = prettyFormula(data.reduced_formula);
  $("nAtoms").textContent = data.n_atoms;
  $("volume").textContent = data.volume ? data.volume + " Å³" : "—";
  $("density").textContent = data.density ? data.density + " g/cm³" : "—";
  updateCellInfo(data);
  updateCifSelect(data);
  updateLegend(data);

  if (data.n_atoms > 4000 && !state.warnedLarge) {
    state.warnedLarge = true;
    setTimeout(() => toast(`结构较大（${data.n_atoms} 原子），浏览器交互可能变慢，建议拆小超胞后查看`), 500);
  }

  getViewer();
  refreshFx();
  const display = refreshData();
  if (state.viewer && !o.keepView) state.viewer.resetView();
  updatePairChips();
  const n = display ? display.bonds.length : 0;
  $("btnExportOffline").disabled = OFFLINE_EXPORT;
  if (!o.silent) {
    toast(`已加载 ${data.reduced_formula || data.formula}（${data.n_atoms} 原子，当前显示 ${n} 条键）`);
  }
}

function updateCellInfo(data) {
  const box = $("cellInfo");
  const cell = data.cell;
  if (!cell || cell.length !== 3) {
    box.textContent = "分子体系（无周期性晶胞）";
    box.classList.remove("hidden");
    return;
  }
  const p = cellParams(cell);
  box.innerHTML =
    `a=${fmtNum(p.a)} b=${fmtNum(p.b)} c=${fmtNum(p.c)} Å　` +
    `α=${fmtNum(p.alpha, 2)}° β=${fmtNum(p.beta, 2)}° γ=${fmtNum(p.gamma, 2)}°`;
  box.classList.remove("hidden");
}

function updateCifSelect(data) {
  const wrap = $("cifWrap");
  const sel = $("cifSelect");
  if (!data.blocks || data.blocks.length < 2) {
    wrap.classList.add("hidden");
    return;
  }
  sel.innerHTML = "";
  data.blocks.forEach((b, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `${i + 1}. ${b.reduced || b.formula}（${b.n_atoms} 原子）`;
    opt.selected = i === state.cifIndex;
    sel.appendChild(opt);
  });
  wrap.classList.remove("hidden");
}

$("cifSelect").addEventListener("change", (e) => {
  if (state.rawText) uploadText(state.rawText, state.fileName, +e.target.value);
});

function updateLegend(data) {
  const counts = new Map();
  data.atoms.el.forEach((el) => counts.set(el, (counts.get(el) || 0) + 1));
  const box = $("legend");
  box.innerHTML = "";
  counts.forEach((count, el) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML =
      `<span class="legend-dot" style="background:${schemeColor(el, state.scheme)}"></span>` +
      `<b>${el}</b><span style="opacity:.72">×${count}</span>`;
    box.appendChild(item);
  });
}

/* ---------- 导出元素图例（PNG） ----------
   报告里"结构图 + 元素色标"必须成对出现，而图例原来只在页面上能看到、导不出来
   （要用的时候只能另外画一张，颜色还容易对不上）。这里按**当前配色方案**把图例画到
   画布上导出：颜色直接取 schemeColor()，与 3D 视图完全一致；文字用黑色，方便直接贴进报告。
   自动化（出报告）可以直接调 window.SVViewerExportLegend(scale) 拿 dataURL。 */
function legendEntries() {
  if (!state.data || !state.data.atoms) return [];
  const counts = new Map();
  (state.data.atoms.el || []).forEach((el) => counts.set(el, (counts.get(el) || 0) + 1));
  return Array.from(counts.entries()).map(([el, count]) => ({
    el, count, color: schemeColor(el, state.scheme),
  }));
}

function sphereDot(ctx, cx, cy, r, color) {
  /* 把图例里的圆点画成**有立体感的球**：报告里的结构图是 3D 球棍，图例要是平面圆点，
     两者看着像两套东西、颜色也对不上。这里用径向渐变 + 高光 + 描边模拟同一套观感。 */
  const g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.12, cx, cy, r * 1.05);
  g.addColorStop(0, mixHex(color, "#ffffff", 0.65));
  g.addColorStop(0.45, color);
  g.addColorStop(1, mixHex(color, "#0b1220", 0.35));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.strokeStyle = "rgba(30,41,59,.7)";
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.34, cy - r * 0.40, r * 0.26, r * 0.17, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.fill();
}

function exportLegendPng(scale) {
  const items = legendEntries();
  if (!items.length) return null;
  const k = Math.max(1, Math.min(Number(scale) || 3, 4));   // 超采样倍率
  const cell = 88, pad = 18, gap = 30, font = '600 44px system-ui, "Microsoft YaHei", sans-serif',
        smallFont = '400 32px system-ui, "Microsoft YaHei", sans-serif';
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  let width = pad;
  items.forEach((it) => {
    probe.font = font;
    const wLabel = probe.measureText(it.el).width;
    probe.font = smallFont;
    width += cell + 12 + wLabel + 8 + probe.measureText("×" + it.count).width + gap;
  });
  width += pad - gap;
  const height = pad * 2 + cell;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  const ctx = canvas.getContext("2d");
  ctx.scale(k, k);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.textBaseline = "middle";
  let x = pad;
  items.forEach((it) => {
    const r = cell / 2, cy = height / 2;
    sphereDot(ctx, x + r, cy, r, it.color);
    ctx.font = font;
    ctx.fillStyle = "#000000";
    ctx.fillText(it.el, x + cell + 12, cy + 1);
    const wLabel = ctx.measureText(it.el).width;
    ctx.font = smallFont;
    ctx.fillStyle = "#000000";                     // 报告里字色统一黑：计数只用小一号字号区分主次
    ctx.fillText("×" + it.count, x + cell + 12 + wLabel + 8, cy + 2);
    x += cell + 12 + wLabel + 8 + ctx.measureText("×" + it.count).width + gap;
  });
  return canvas.toDataURL("image/png");
}

if ($("btnExportLegend")) {
  $("btnExportLegend").addEventListener("click", () => {
    const url = exportLegendPng(3);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = ((state.fileName || "structure").replace(/\.[^.]+$/, "") || "structure") + "-legend.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
/* 给自动化（出报告流程）用：返回 PNG 的 dataURL */
window.SVViewerExportLegend = exportLegendPng;

/* ---------- 键段过滤 ---------- */

function visibleSegments() {
  if (!state.data) return [];
  const d = state.data;
  const segs = d.segments || { i: [], j: [], d: [], dx: [], dy: [], dz: [] };
  const n = segs.i.length;
  const R = d.atoms.r;
  const out = [];
  const filterSet = state.pairFilters;
  for (let k = 0; k < n; k++) {
    const i = segs.i[k], j = segs.j[k];
    /* 判键：半径和 × 容差。氢的半径由服务端按"半个键长"覆盖成 0.37 Å
       （见 server.py 的 _RADIUS_OVERRIDE）——原来用原子半径 0.25 会把 H₂ 的
       H–H（0.7506 Å）判成不成键，报告图里就是两颗孤球。这里不要再加"绝对余量"：
       加了会把斯石英里 2.667 Å 的 Si–Si（共棱，不是键）也连上（2026-10-15 实测）。 */
    const ei = d.atoms.el[i], ej = d.atoms.el[j];
    const pair = canonPair(ei, ej);
    const maxBond = PAIR_MAX_BOND[pair] ?? (R[i] + R[j]) * state.tolerance;
    if (segs.d[k] > maxBond + 1e-9) continue;
    if (filterSet.size && !filterSet.has(pair)) continue;
    const x0 = d.atoms.x[i], y0 = d.atoms.y[i], z0 = d.atoms.z[i];
    const x1 = x0 + segs.dx[k], y1 = y0 + segs.dy[k], z1 = z0 + segs.dz[k];
    out.push({ i, j, ei, ej, d: segs.d[k], x0, y0, z0, x1, y1, z1 });
  }
  return out;
}

function candidatePairSet() {
  const prevPbc = state.showPbc;
  state.showPbc = true; // 元素对候选不考虑 PBC 开关
  const segs = visibleSegments();
  state.showPbc = prevPbc;
  const set = new Set();
  segs.forEach((s) => set.add(canonPair(s.ei, s.ej)));
  return set;
}

/* ---------- 周期补全显示 ----------
 *
 * 打开“周期镜像”后不再只画“半个”边界原子：
 *  - 晶胞内原子全部显示；
 *  - 同时显示与晶胞相距在键长范围内的镜像原子（按晶格平移复制）；
 *  - 键也按同样的平移规则在原子副本之间完整生成，
 *    因此晶胞边缘的原子和它们伸出去的键两端都有完整的球。
 * 结构特别大时自动降级为“仅补键端”，避免渲染卡死。
 */

const MAX_PBC_ATOMS = 3500;

function matVecRow(f, L) {
  return [
    f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0],
    f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
    f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2],
  ];
}

function cellAabb(cell) {
  const pts = [];
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      for (let k = 0; k < 2; k++)
        pts.push(matVecRow([i, j, k], cell));
  const box = {
    minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
    minZ: Math.min(...pts.map((p) => p[2])), maxZ: Math.max(...pts.map((p) => p[2])),
  };
  return box;
}

function distToAabb(p, box) {
  const dx = Math.max(box.minX - p[0], 0, p[0] - box.maxX);
  const dy = Math.max(box.minY - p[1], 0, p[1] - box.maxY);
  const dz = Math.max(box.minZ - p[2], 0, p[2] - box.maxZ);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function shiftKey(s) {
  return s[0] + "," + s[1] + "," + s[2];
}

/* 晶胞范围（PBC 关）：只有晶胞内原子，跨边界键不显示 */
function buildSingleCell(segs) {
  const d = state.data;
  const atoms = [];
  state.basePts = [];
  state.ghostPts = [];
  for (let i = 0; i < d.atoms.el.length; i++) {
    atoms.push({
      kind: "base", i, el: d.atoms.el[i],
      x: d.atoms.x[i], y: d.atoms.y[i], z: d.atoms.z[i],
      shift: [0, 0, 0],
    });
    state.basePts.push({ i, el: d.atoms.el[i], x: d.atoms.x[i], y: d.atoms.y[i], z: d.atoms.z[i] });
  }
  const bonds = segs.map((s) => ({
    i: s.i, j: s.j, ei: s.ei, ej: s.ej, d: s.d,
    x0: s.x0, y0: s.y0, z0: s.z0, x1: s.x1, y1: s.y1, z1: s.z1,
  }));
  return { atoms, bonds, degraded: false };
}

/* 轻量降级：仅把“键的另一端”的镜像球补上（旧行为，原子连接不完整） */
function buildSparse(segs) {
  const d = state.data;
  const atoms = [];
  state.basePts = [];
  state.ghostPts = [];
  const seen = new Set();
  const bonds = [];
  for (let i = 0; i < d.atoms.el.length; i++) {
    atoms.push({
      kind: "base", i, el: d.atoms.el[i],
      x: d.atoms.x[i], y: d.atoms.y[i], z: d.atoms.z[i],
      shift: [0, 0, 0],
    });
    state.basePts.push({ i, el: d.atoms.el[i], x: d.atoms.x[i], y: d.atoms.y[i], z: d.atoms.z[i] });
  }
  segs.forEach((s) => {
    bonds.push({
      i: s.i, j: s.j, ei: s.ei, ej: s.ej, d: s.d,
      x0: s.x0, y0: s.y0, z0: s.z0, x1: s.x1, y1: s.y1, z1: s.z1,
    });
    if (!insideCell([s.x1, s.y1, s.z1], d.cell)) {
      const key = posKey(s.x1, s.y1, s.z1);
      if (!seen.has(key)) {
        seen.add(key);
        atoms.push({
          kind: "mirror", i: s.j, el: s.ej,
          x: s.x1, y: s.y1, z: s.z1,
          shift: [0, 0, 0],
        });
        state.ghostPts.push({ i: s.j, el: s.ej, x: s.x1, y: s.y1, z: s.z1 });
      }
    }
  });
  return { atoms, bonds, degraded: true };
}

/* 完整补全：边界附近镜像原子 + 原子副本间的全部键 */
function buildFullPeriodic(segs) {
  const d = state.data;
  const L = d.cell;
  const fracs = [];
  for (let i = 0; i < d.atoms.el.length; i++) {
    fracs.push(cartToFrac([d.atoms.x[i], d.atoms.y[i], d.atoms.z[i]], L));
  }
  const box = cellAabb(L);
  let maxD = 0;
  segs.forEach((s) => { if (s.d > maxD) maxD = s.d; });
  const halo = maxD > 0 ? Math.min(2 * maxD + 0.2, 12) : 1.2;

  const atoms = [];
  const copiesOf = [];
  state.basePts = [];
  state.ghostPts = [];
  const copyMap = new Map();
  let degraded = false;

  const addCopy = (i, s, pos, kind) => {
    const entry = {
      kind, i, el: d.atoms.el[i],
      x: pos[0], y: pos[1], z: pos[2],
      shift: s,
    };
    const key = i + "|" + shiftKey(s);
    atoms.push(entry);
    copiesOf[i].push({ s, x: pos[0], y: pos[1], z: pos[2] });
    copyMap.set(key, entry);
    if (kind === "base") state.basePts.push(entry);
    else state.ghostPts.push(entry);
  };

  for (let i = 0; i < d.atoms.el.length; i++) {
    copiesOf.push([]);
    addCopy(i, [0, 0, 0], [d.atoms.x[i], d.atoms.y[i], d.atoms.z[i]], "base");
  }

  if (!degraded) {
    outer:
    for (let i = 0; i < d.atoms.el.length; i++) {
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          for (let c = -1; c <= 1; c++) {
            if (a === 0 && b === 0 && c === 0) continue;
            const s = [a, b, c];
            const pos = matVecRow(
              [fracs[i][0] + a, fracs[i][1] + b, fracs[i][2] + c],
              L
            );
            if (distToAabb(pos, box) > halo) continue;
            addCopy(i, s, pos, "mirror");
            if (atoms.length > MAX_PBC_ATOMS) {
              degraded = true;
              break outer;
            }
          }
        }
      }
    }
  }

  if (degraded) {
    return buildSparse(segs);
  }

  const bonds = [];
  const seen = new Set();
  const keyOf = (a, b) => {
    const ka = posKey(a[0], a[1], a[2]);
    const kb = posKey(b[0], b[1], b[2]);
    return ka < kb ? ka + "|" + kb : kb + "|" + ka;
  };

  segs.forEach((s) => {
    const fe = cartToFrac([s.x1, s.y1, s.z1], L);
    // 镜像序号 w 应满足 endpoint = base_j + w·L，即 w = round(frac(endpoint) - frac(j))
    const w = [
      Math.round(fe[0] - fracs[s.j][0]),
      Math.round(fe[1] - fracs[s.j][1]),
      Math.round(fe[2] - fracs[s.j][2]),
    ];
    const srcCopies = copiesOf[s.i] || [];
    for (const c of srcCopies) {
      const t = [c.s[0] + w[0], c.s[1] + w[1], c.s[2] + w[2]];
      const target = copyMap.get(s.j + "|" + shiftKey(t));
      if (!target) continue;
      const p0 = [c.x, c.y, c.z];
      const p1 = [target.x, target.y, target.z];
      const key = keyOf(p0, p1);
      if (seen.has(key)) continue;
      seen.add(key);
      bonds.push({
        i: s.i, j: s.j, ei: s.ei, ej: s.ej, d: s.d,
        x0: c.x, y0: c.y, z0: c.z, x1: target.x, y1: target.y, z1: target.z,
      });
    }
  });
  return { atoms, bonds, degraded: false };
}

/* 闭合晶胞：不画邻胞镜像，但把“正好落在边界上”的原子
 * 按闭合晶胞补齐到其它边界位置（角原子 8 个位置、棱原子 4 个、面原子 2 个），
 * 并把它们跨边界的键一并接上，避免边界原子看起来只剩一部分。 */
function buildClosedCell(segs) {
  const d = state.data;
  const L = d.cell;
  const fracs = [];
  for (let i = 0; i < d.atoms.el.length; i++) {
    fracs.push(cartToFrac([d.atoms.x[i], d.atoms.y[i], d.atoms.z[i]], L));
  }
  const EPS = 1e-3;

  const atoms = [];
  const copiesOf = [];
  state.basePts = [];
  state.ghostPts = [];
  const copyMap = new Map();

  const addCopy = (i, s, kind) => {
    // 闭合晶胞：补出来的位置就在边界上（分量只会是 0 或 1），不做取模回绕
    const pos = matVecRow(
      [fracs[i][0] + s[0], fracs[i][1] + s[1], fracs[i][2] + s[2]],
      L
    );
    const entry = {
      kind, i, el: d.atoms.el[i],
      x: pos[0], y: pos[1], z: pos[2],
      shift: s,
    };
    const key = i + "|" + shiftKey(s);
    atoms.push(entry);
    copiesOf[i].push({ s, x: pos[0], y: pos[1], z: pos[2] });
    copyMap.set(key, entry);
    if (kind === "base") state.basePts.push(entry);
    else state.ghostPts.push(entry);
  };

  for (let i = 0; i < d.atoms.el.length; i++) {
    copiesOf.push([]);
    addCopy(i, [0, 0, 0], "base");
  }

  // 边界分量：0 -> 补到对面 1；1 -> 补到对面 0
  for (let i = 0; i < d.atoms.el.length; i++) {
    const opts = [0, 1, 2].map((axis) => {
      const f = fracs[i][axis];
      if (f < EPS) return [0, 1];
      if (f > 1 - EPS) return [0, -1];
      return [0];
    });
    for (const a of opts[0]) {
      for (const b of opts[1]) {
        for (const c of opts[2]) {
          const s = [a, b, c];
          if (s[0] === 0 && s[1] === 0 && s[2] === 0) continue;
          addCopy(i, s, "mirror");
        }
      }
    }
  }

  const bonds = [];
  const seen = new Set();
  const keyOf = (a, b) => {
    const ka = posKey(a[0], a[1], a[2]);
    const kb = posKey(b[0], b[1], b[2]);
    return ka < kb ? ka + "|" + kb : kb + "|" + ka;
  };

  segs.forEach((s) => {
    const fe = cartToFrac([s.x1, s.y1, s.z1], L);
    const w = [
      Math.round(fe[0] - fracs[s.j][0]),
      Math.round(fe[1] - fracs[s.j][1]),
      Math.round(fe[2] - fracs[s.j][2]),
    ];
    const srcCopies = copiesOf[s.i] || [];
    for (const c of srcCopies) {
      const t = [c.s[0] + w[0], c.s[1] + w[1], c.s[2] + w[2]];
      const target = copyMap.get(s.j + "|" + shiftKey(t));
      if (!target) continue;
      const p0 = [c.x, c.y, c.z];
      const p1 = [target.x, target.y, target.z];
      const key = keyOf(p0, p1);
      if (seen.has(key)) continue;
      seen.add(key);
      bonds.push({
        i: s.i, j: s.j, ei: s.ei, ej: s.ej, d: s.d,
        x0: c.x, y0: c.y, z0: c.z, x1: target.x, y1: target.y, z1: target.z,
      });
    }
  });
  return { atoms, bonds, degraded: false };
}

function buildDisplay(segs) {
  const hasCell = state.data && state.data.cell && state.data.cell.length === 3;
  if (!hasCell) return buildSingleCell(segs);
  if (!state.showPbc) return buildClosedCell(segs);
  return buildFullPeriodic(segs);
}

/* ---------- 球体（PDB model） ---------- */

function sphereRadius(el, rCov) {
  const base = clamp(rCov * 0.45, 0.28, 0.75);
  let f = 1;
  if (state.mode === "stick") f = 0.32;
  if (state.mode === "spacefill") f = 1.85;
  return clamp(base * f * state.atomScale, 0.06, 2.4);
}

function posKey(x, y, z) {
  return [Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)].join(",");
}

/* ---------- 键与晶胞（自定义几何，双色半键） ---------- */

function bondRadius() {
  let base = 0.09;
  if (state.mode === "stick") base *= 1.45;
  return Math.max(0.02, base * state.bondScale);
}

function cellLineColor() {
  return state.cellColor || (state.theme === "dark" ? "#5e739b" : "#93a6cc");
}

/* 晶胞框的粗细（跟着键粗细走，但更细） */
function cellRodRadius() {
  return Math.max(0.012, 0.028 * state.bondScale * 0.75);
}

function updateBondMeta(count) {
  const tag = $("bondCount");
  if (state.data && state.showBonds) {
    tag.textContent = `${count} 条键`;
    tag.classList.remove("hidden");
  } else {
    tag.classList.add("hidden");
  }
  const meta = $("viewerMeta");
  if (state.data) {
    const info = [state.fileName, `${state.data.n_atoms} 原子`];
    if (state.showBonds) info.push(`${count} 条键`);
    meta.innerHTML = info.map((x, idx) => (idx === 0 ? `<b>${x}</b>` : x)).join(" · ");
    meta.classList.remove("hidden");
  }
}

/* ---------- 原子拾取 / 悬停 ---------- */

function lookupAtom(atom) {
  let best = null;
  let bestD = 0.03;
  const probe = (pt, kind) => {
    if (!pt) return;
    const dx = pt.x - atom.x, dy = pt.y - atom.y, dz = pt.z - atom.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestD) {
      bestD = d;
      best = { kind, i: pt.i, el: pt.el || atom.el || atom.elem };
    }
  };
  state.basePts.forEach((p) => probe(p, "atom"));
  state.ghostPts.forEach((p) => probe(p, "ghost"));
  if (!best) best = { kind: "atom", i: null, el: atom.el || atom.elem };
  return best;
}

function atomText(info, atom) {
  const pos = `(${fmtNum(atom.x)}，${fmtNum(atom.y)}，${fmtNum(atom.z)}) Å`;
  if (info.kind === "ghost") return `${info.el}（周期镜像） @ ${pos}`;
  const label = info.i == null ? info.el : `${info.el} #${info.i + 1}`;
  return `${label} @ ${pos}`;
}

function onAtomHover(atom) {
  if (!atom || !state.data) return;
  const info = lookupAtom(atom);
  $("hoverTip").innerHTML = atomText(info, atom);
  $("hoverTip").classList.remove("hidden");
}

function onAtomClick(atom) {
  if (!atom || !state.data) return;
  const info = lookupAtom(atom);
  if (state.measureMode) {
    const limit = state.measureMode === "dist" ? 2 : 3;
    if (state.measurePicks.length >= limit) state.measurePicks.length = 0;
    state.measurePicks.push({ x: atom.x, y: atom.y, z: atom.z,
                              el: atom.el || atom.elem, i: info.i });
    paintMeasure();
    return;
  }
  toast(atomText(info, atom));
}

/* ------------------------- 测量工具 / 路径回放 ------------------------- */
/* 这两个工具浮在画布上（结构面板嵌入主应用时左侧栏是收起的，按钮必须独立可见）。 */
function ensureViewerToolsCss() {
  if (document.getElementById("calcgo-viewer-tools-css")) return;
  const st = document.createElement("style");
  st.id = "calcgo-viewer-tools-css";
  st.textContent = `
    .v-tools{position:absolute;left:12px;right:12px;bottom:44px;z-index:25;display:flex;gap:6px;
      align-items:center;flex-wrap:wrap;max-width:calc(100% - 24px);}
    .v-tools button{font-size:12px;padding:5px 9px;border:1px solid #cfdde5;border-radius:7px;
      background:rgba(255,255,255,.92);color:#33465a;cursor:pointer;box-shadow:0 2px 8px rgba(16,42,67,.08);}
    .v-tools button.on{background:#00697a;border-color:#00697a;color:#fff;}
    .v-tools button:focus-visible,.v-traj button:focus-visible,
    .v-traj input:focus-visible{outline:2px solid #00697a;outline-offset:2px;}
    .v-quick{position:absolute;right:12px;top:12px;z-index:26;display:flex;gap:5px;
      align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100% - 24px);
      padding:5px;border:1px solid rgba(207,221,229,.92);border-radius:10px;
      background:rgba(255,255,255,.92);box-shadow:0 5px 18px rgba(16,42,67,.10);
      backdrop-filter:blur(6px);}
    .v-quick button{font-size:11.5px;padding:4px 7px;border:1px solid transparent;
      border-radius:6px;background:transparent;color:#33465a;cursor:pointer;white-space:nowrap;}
    .v-quick button:hover{background:#eef7f8;color:#00697a;}
    .v-quick button.on{background:#e4f4f6;border-color:#9bdde7;color:#00697a;font-weight:600;}
    .v-quick button:focus-visible{outline:2px solid #00697a;outline-offset:1px;}
    .v-measure-out{font-size:12px;color:#33465a;background:rgba(255,255,255,.94);
      border:1px solid #d8e4ec;border-radius:7px;padding:5px 9px;white-space:nowrap;
      font-variant-numeric:tabular-nums;}
    .v-traj{position:absolute;left:12px;right:12px;bottom:12px;z-index:24;
      background:rgba(255,255,255,.95);border:1px solid #d8e4ec;border-radius:10px;
      box-shadow:0 6px 22px rgba(16,42,67,.12);padding:8px 10px;display:flex;gap:10px;
      align-items:center;flex-wrap:wrap;}
    .v-traj button{font-size:12px;padding:5px 9px;border:1px solid #cfdde5;border-radius:7px;
      background:#fff;color:#33465a;cursor:pointer;}
    .v-traj button.p{background:#00697a;border-color:#00697a;color:#fff;}
    .v-traj input[type=range]{flex:1;min-width:120px;accent-color:#00697a;}
    .v-traj .lab{font-size:12px;color:#33465a;font-variant-numeric:tabular-nums;white-space:nowrap;}
    .v-traj canvas{border:0;border-radius:6px;background:#f7fbfd;}
  `;
  document.head.appendChild(st);
}

function measurePointText(p) {
  return p.i == null ? `${p.el}` : `${p.el} #${p.i + 1}`;
}

function paintMeasure() {
  const out = document.getElementById("vMeasureOut");
  const picks = state.measurePicks;
  if (state.viewer) state.viewer.setGuide(picks.map((p) => [p.x, p.y, p.z]));
  if (!out) return;
  if (!picks.length) {
    out.textContent = state.measureMode === "angle" ? "依次点 3 个原子" : "依次点 2 个原子";
    return;
  }
  const names = picks.map(measurePointText).join(" → ");
  if (picks.length >= 2) {
    const d = vecLen(vecSub([picks[1].x, picks[1].y, picks[1].z],
                            [picks[0].x, picks[0].y, picks[0].z]));
    if (state.measureMode === "angle" && picks.length >= 3) {
      const u = vecSub([picks[0].x, picks[0].y, picks[0].z],
                       [picks[1].x, picks[1].y, picks[1].z]);
      const v = vecSub([picks[2].x, picks[2].y, picks[2].z],
                       [picks[1].x, picks[1].y, picks[1].z]);
      const cos = vecDot(u, v) / Math.max(1e-9, vecLen(u) * vecLen(v));
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      out.innerHTML = `${names} · 键长 <b>${d.toFixed(3)} Å</b> · 键角 <b>${ang.toFixed(1)}°</b>`;
    } else {
      out.innerHTML = `${names} · 距离 <b>${d.toFixed(3)} Å</b>`;
    }
  } else {
    out.textContent = `${names} · 再选 1 个原子`;
  }
}

function setMeasureMode(mode) {
  state.measureMode = state.measureMode === mode ? "" : mode;
  state.measurePicks = [];
  document.querySelectorAll("#vTools [data-measure]").forEach((b) => {
    b.classList.toggle("on", b.dataset.measure === state.measureMode);
    b.setAttribute("aria-pressed", String(b.dataset.measure === state.measureMode));
  });
  paintMeasure();
}

function setupMeasureUI() {
  ensureViewerToolsCss();
  const wrap = document.querySelector(".viewer-wrap");
  if (!wrap || document.getElementById("vTools")) return;
  const box = document.createElement("div");
  box.className = "v-tools";
  box.id = "vTools";
  box.innerHTML = `
    <button type="button" data-measure="dist" title="点两个原子，读键长">测距</button>
    <button type="button" data-measure="angle" title="点三个原子，中间那个是顶点">测角</button>
    <button type="button" id="vMeasureClear" title="清除测量">清除</button>
    <button type="button" id="vMeasureCopy" title="复制当前测量结果">复制</button>
    <span class="v-measure-out" id="vMeasureOut" role="status">测距 / 测角：先点按钮，再点原子</span>`;
  wrap.appendChild(box);
  box.querySelectorAll("[data-measure]").forEach((b) => {
    b.setAttribute("aria-pressed", "false");
    b.onclick = (e) => { e.stopPropagation(); setMeasureMode(b.dataset.measure); };
  });
  box.querySelector("#vMeasureClear").onclick = (e) => {
    e.stopPropagation();
    state.measureMode = "";
    state.measurePicks = [];
    box.querySelectorAll("[data-measure]").forEach((b) => b.classList.remove("on"));
    box.querySelectorAll("[data-measure]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    paintMeasure();
  };
  box.querySelector("#vMeasureCopy").onclick = async (e) => {
    e.stopPropagation();
    const out = document.getElementById("vMeasureOut");
    const text = out ? out.textContent.trim() : "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("测量结果已复制");
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      toast("测量结果已复制");
    }
  };
}

/* 嵌入主应用时左侧栏被收起，视角与导出动作也必须能在画布内直接点到。
   独立查看器已经有完整的左侧控制面板，这里只在 iframe 中创建，避免重复。 */
function setupQuickViewUI() {
  const embedded = (() => {
    try { return window.self !== window.top; } catch (_) { return true; }
  })();
  if (!embedded) return;
  ensureViewerToolsCss();
  const wrap = document.querySelector(".viewer-wrap");
  if (!wrap || document.getElementById("vQuick")) return;
  const box = document.createElement("div");
  box.className = "v-quick";
  box.id = "vQuick";
  box.setAttribute("aria-label", "视角与导出");
  box.innerHTML = `
    <button type="button" data-quick-view="reset" title="按原子内容重新取景">适应</button>
    <button type="button" data-quick-view="top" title="沿 c 轴俯视表面">俯视</button>
    <button type="button" data-quick-view="front" title="沿 b 轴正视表面">正视</button>
    <button type="button" data-quick-view="side" title="沿 a 轴侧视表面">侧视</button>
    <button type="button" id="vQuickCell" class="${state.showCell ? "on" : ""}"
      aria-pressed="${state.showCell}" title="显示或隐藏晶胞框">晶胞</button>
    <button type="button" id="vQuickShot" title="导出当前画面 PNG">截图</button>`;
  wrap.appendChild(box);
  const activate = (el) => {
    box.querySelectorAll("[data-quick-view]").forEach((b) =>
      b.classList.toggle("on", b === el && b.dataset.quickView === "reset"));
  };
  box.querySelectorAll("[data-quick-view]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      activate(b);
      const key = b.dataset.quickView;
      if (key === "reset") applyViewPreset("reset");
      else if (key === "top") applyViewPreset("+c");
      else if (key === "front") applyViewPreset("+b");
      else if (key === "side") applyViewPreset("+a");
      if (key !== "reset") setTimeout(() => activate(null), 900);
    };
  });
  const cellBtn = box.querySelector("#vQuickCell");
  cellBtn.onclick = (e) => {
    e.stopPropagation();
    state.showCell = !state.showCell;
    cellBtn.classList.toggle("on", state.showCell);
    cellBtn.setAttribute("aria-pressed", String(state.showCell));
    const toggle = document.getElementById("cellToggle");
    if (toggle) toggle.checked = state.showCell;
    if (state.data) refreshStyle();
  };
  box.querySelector("#vQuickShot").onclick = (e) => {
    e.stopPropagation();
    exportPng();
  };
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
}

function setupTrajectoryUI(frames) {
  ensureViewerToolsCss();
  const wrap = document.querySelector(".viewer-wrap");
  if (!wrap || !frames || frames.length < 2 || document.getElementById("vTraj")) return;
  const bar = document.createElement("div");
  bar.className = "v-traj";
  bar.id = "vTraj";
  const tools = document.getElementById("vTools");
  if (tools) tools.style.bottom = "92px";
  bar.innerHTML = `
    <button type="button" class="p" id="vTrajPlay">▶ 播放</button>
    <input type="range" id="vTrajRange" min="0" max="${frames.length - 1}" step="1" value="0">
    <span class="lab" id="vTrajLab"></span>
    <canvas id="vTrajPlot" width="300" height="54"></canvas>`;
  wrap.appendChild(bar);
  const range = bar.querySelector("#vTrajRange");
  const lab = bar.querySelector("#vTrajLab");
  const play = bar.querySelector("#vTrajPlay");
  const plot = bar.querySelector("#vTrajPlot");
  let idx = 0, timer = null;
  const energies = frames.map((f) => (Number.isFinite(Number(f.energy)) ? Number(f.energy) : null));
  const e0 = energies.find((v) => v != null) ?? 0;

  function drawPlot() {
    const ctx = plot.getContext("2d");
    const W = plot.width, H = plot.height, pad = 5;
    ctx.clearRect(0, 0, W, H);
    const vals = energies.map((v) => (v == null ? null : v - e0));
    const known = vals.filter((v) => v != null);
    if (known.length < 2) return;
    const lo = Math.min(...known), hi = Math.max(...known);
    const span = Math.max(1e-6, hi - lo);
    const X = (i) => pad + (W - 2 * pad) * (i / Math.max(1, vals.length - 1));
    const Y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / span);
    ctx.strokeStyle = "#c9d8e2"; ctx.beginPath();
    ctx.moveTo(pad, Y(0)); ctx.lineTo(W - pad, Y(0)); ctx.stroke();
    ctx.strokeStyle = "#00697a"; ctx.lineWidth = 1.6; ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo(X(i), Y(v)); started = true; }
      else ctx.lineTo(X(i), Y(v));
    });
    ctx.stroke();
    ctx.fillStyle = "#c0392b";
    ctx.beginPath(); ctx.arc(X(idx), Y(vals[idx] ?? 0), 3.4, 0, Math.PI * 2); ctx.fill();
  }

  function show(i) {
    idx = Math.max(0, Math.min(frames.length - 1, i));
    range.value = idx;
    const f = frames[idx];
    renderStructure(f.data, { keepView: idx > 0, silent: true });
    if (state.measurePicks.length) {
      // 换了帧，上一帧的测量点已经不是当前构型上的位置了，清掉避免误读
      state.measurePicks = [];
      const mOut = document.getElementById("vMeasureOut");
      if (mOut) mOut.textContent = "测距 / 测角：先点按钮，再点原子";
      if (state.viewer) state.viewer.setGuide([]);
    }
    const rel = energies[idx] == null ? "—" : (energies[idx] - e0).toFixed(3) + " eV";
    lab.innerHTML = `图像 <b>${f.label}</b> · ${idx + 1}/${frames.length} · ΔE <b>${rel}</b>`;
    drawPlot();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    play.textContent = "▶ 播放";
    play.classList.add("p");
  }

  play.onclick = (e) => {
    e.stopPropagation();
    if (timer) { stop(); return; }
    if (idx >= frames.length - 1) show(0);
    play.textContent = "⏸ 暂停";
    play.classList.remove("p");
    timer = setInterval(() => {
      if (idx >= frames.length - 1) { stop(); return; }
      show(idx + 1);
    }, 650);
  };
  range.oninput = () => { stop(); show(Number(range.value)); };
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") { stop(); show(idx - 1); }
    if (e.key === "ArrowRight") { stop(); show(idx + 1); }
  });
  show(0);
}

/* ------------------------- 节流 ------------------------- */

const timers = {};
function debounce(key, ms, fn) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

/* ------------------------- 风格预设 ------------------------- */

/* 一个预设 = 界面主题 + 背景 + 材质光照 + 描边色 + 多面体，一键切换整套观感 */
const PRESETS = {
  studio: {
    theme: "light",
    outline: "#31486f", cell: "#93a6cc",
    fx: {
      bgMode: "grad", bgTop: "#ffffff", bgBottom: "#e6edf8",
      exposure: 0.92, roughness: 0.34, metalness: 0.05,
      lightPower: 1.0, envPower: 1.0, envRefl: 0.45,
      outline: 0.35, bloom: 0, vignette: 0.22, fog: 0, poly: "off",
    },
  },
  dark: {
    theme: "dark",
    outline: "#030710", cell: "#5e739b",
    fx: {
      bgMode: "grad", bgTop: "#12203a", bgBottom: "#04070e",
      exposure: 0.95, roughness: 0.24, metalness: 0.15,
      lightPower: 1.0, envPower: 1.0, envRefl: 0.35,
      outline: 0.5, bloom: 0, vignette: 0.38, fog: 0, poly: "off",
    },
  },
  paper: {
    theme: "light",
    outline: "#2b2b2b", cell: "#9a9a9a",
    fx: {
      bgMode: "solid", bgTop: "#ffffff", bgBottom: "#ffffff",
      exposure: 1.12, roughness: 0.78, metalness: 0,
      lightPower: 1.0, envPower: 1.0, envRefl: 0.2,
      outline: 0.45, bloom: 0, vignette: 0, fog: 0, poly: "off",
    },
  },
  metal: {
    theme: "dark",
    outline: "#070b14", cell: "#7f90b5",
    fx: {
      bgMode: "grad", bgTop: "#1b2333", bgBottom: "#0b0f18",
      exposure: 0.85, roughness: 0.34, metalness: 0.9,
      lightPower: 1.0, envPower: 1.0, envRefl: 1.1,
      outline: 0.4, bloom: 0, vignette: 0.32, fog: 0, poly: "off",
    },
  },
  figure: {
    theme: "light",
    outline: "#242424", cell: "#8d8d8d",
    fx: {
      bgMode: "solid", bgTop: "#ffffff", bgBottom: "#ffffff",
      exposure: 1.08, roughness: 0.85, metalness: 0,
      lightPower: 0.95, envPower: 1.0, envRefl: 0.2,
      outline: 0.5, bloom: 0, vignette: 0.1, fog: 0, poly: "metal",
    },
  },
  /* 球面报告：给"导出到报告/PPT"用的一套观感——哑光偏亮、高光收得紧、深色描边，
     跟图例球（导出图例画的那种球）以及报告里的结构图保持一致。 */
  ball: {
    theme: "light",
    outline: "#2a3446", cell: "#dbe3ec",
    fx: {
      bgMode: "solid", bgTop: "#ffffff", bgBottom: "#ffffff",
      exposure: 1.0, roughness: 0.30, metalness: 0, lightPower: 1.25, envPower: 1.0,
      envRefl: 0.10, outline: 0.70, bloom: 0, vignette: 0, fog: 0, poly: "off",
    },
  },
  poster: {
    theme: "dark",
    outline: "#03060c", cell: "#6f86b3",
    fx: {
      bgMode: "grad", bgTop: "#16274a", bgBottom: "#03060c",
      exposure: 0.98, roughness: 0.22, metalness: 0.25,
      lightPower: 1.05, envPower: 1.0, envRefl: 0.45,
      outline: 0.5, bloom: 0.6, vignette: 0.38, fog: 0.2, poly: "metal",
    },
  },
};

/* 嵌入 CalcGO 时，主的四套主题通过 postMessage 同步到这里。
   只覆盖画布底色、描边和晶胞色，不锁死用户随后在查看器里选择的材质预设。 */
function applyHostTheme(payload) {
  const embedded = (() => {
    try { return window.self !== window.top; } catch (_) { return true; }
  })();
  if (!embedded || !payload || payload.type !== "calcgo-viewer-theme") return;
  const dark = payload.mode === "dark";
  state.theme = dark ? "dark" : "light";
  state.hostTheme = String(payload.theme || "");
  state.outlineColor = String(payload.outline || (dark ? "#030710" : "#31486f"));
  state.cellColor = String(payload.cell || (dark ? "#5e739b" : "#93a6cc"));
  state.fx.bgMode = "grad";
  state.fx.bgTop = String(payload.bgTop || (dark ? "#12203a" : "#ffffff"));
  state.fx.bgBottom = String(payload.bgBottom || (dark ? "#04070e" : "#e6edf8"));
  document.body.dataset.theme = state.theme;
  const viewerEl = document.getElementById("viewer");
  if (viewerEl) {
    viewerEl.dataset.hostTheme = state.hostTheme;
    viewerEl.dataset.canvasTop = state.fx.bgTop;
    viewerEl.dataset.canvasBottom = state.fx.bgBottom;
  }
  refreshFx();
  if (state.data) refreshStyle();
}

function hostThemeFromQuery() {
  const q = new URLSearchParams(window.location.search);
  const theme = q.get("hostTheme");
  if (!theme) return null;
  const fallback = theme === "ocean" ? {
    bgTop: "#ffffff", bgBottom: "#e6edf8", outline: "#31486f", cell: "#93a6cc",
  } : {
    bgTop: "#12203a", bgBottom: "#04070e", outline: "#030710", cell: "#5e739b",
  };
  return {
    type: "calcgo-viewer-theme",
    theme,
    mode: q.get("hostMode") || (theme === "ocean" ? "light" : "dark"),
    bgTop: q.get("hostBgTop") || fallback.bgTop,
    bgBottom: q.get("hostBgBottom") || fallback.bgBottom,
    outline: q.get("hostOutline") || fallback.outline,
    cell: q.get("hostCell") || fallback.cell,
  };
}

function notifyHostViewerReady() {
  const embedded = (() => {
    try { return window.self !== window.top; } catch (_) { return false; }
  })();
  if (!embedded) return;
  try {
    window.parent.postMessage({type: "calcgo-viewer-ready"}, "*");
  } catch (_) { /* 父页面尚未就绪时，load 后还会再次通知 */ }
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  state.preset = key;
  state.theme = p.theme;
  state.outlineColor = p.outline;
  state.cellColor = p.cell;
  Object.assign(state.fx, p.fx);
  document.body.dataset.theme = p.theme;
  document.querySelectorAll("#presetSeg button").forEach((b) =>
    b.classList.toggle("on", b.dataset.preset === key)
  );
  syncFxInputs();
  refreshFx();
  if (state.data) refreshStyle();
}

document.querySelectorAll("#presetSeg button").forEach((b) =>
  b.addEventListener("click", () => applyPreset(b.dataset.preset))
);

window.addEventListener("message", (event) => {
  try {
    if (event.source === window.parent) applyHostTheme(event.data);
  } catch (_) { /* 非主题消息忽略 */ }
});

document.querySelectorAll("#modeSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#modeSeg button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    state.mode = b.dataset.modeValue;
    if (state.data) debounce("scene", 20, refreshStyle);
  })
);

/* ---------- VESTA 式视角预设（沿晶轴观察 / 复位） ---------- */

function applyViewPreset(key) {
  const v = state.viewer;
  if (!v) return;
  if (key === "reset") {
    if (state.data) v.resetView();
    return;
  }
  // 分子体系无晶胞时退回世界坐标轴
  const cell =
    state.data && state.data.cell && state.data.cell.length === 3
      ? state.data.cell
      : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const axisIdx = { "+a": 0, "-a": 0, "+b": 1, "-b": 1, "+c": 2, "-c": 2 }[key];
  if (axisIdx == null) return;
  const sign = key[0] === "-" ? -1 : 1;
  const axis = cell[axisIdx];
  const c = cell[2];
  const dot = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const norm = (u) => {
    const n = Math.hypot(u[0], u[1], u[2]) || 1;
    return [u[0] / n, u[1] / n, u[2] / n];
  };
  const cUnit = norm(c);
  // 让视线垂直于 c：取晶轴在"垂直于 c 的平面"上的投影。
  // 这样正/侧视图里 c 一定平行于屏幕，且作为屏幕竖直方向（客户 2026-10-18 口径）。
  const perpToC = (u) => {
    const k = dot(u, cUnit);
    return norm([u[0] - cUnit[0] * k, u[1] - cUnit[1] * k, u[2] - cUnit[2] * k]);
  };
  let dir, up;
  if (axisIdx === 2) {
    // 俯视：沿 c 看，屏幕内用 b（投影到 ab 面）当"上"
    dir = cUnit;
    up = perpToC(cell[1]);
  } else {
    // 正视（沿 b）/ 侧视（沿 a）：c 平行屏幕并竖直
    dir = perpToC(axis);
    up = cUnit;
  }
  v.viewAlong([dir[0] * sign, dir[1] * sign, dir[2] * sign], up);
}

document.querySelectorAll("#viewSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#viewSeg button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    applyViewPreset(b.dataset.view);
  })
);

$("schemeSel").addEventListener("change", (e) => {
  state.scheme = e.target.value;
  if (state.data) {
    updateLegend(state.data);
    debounce("scene", 20, refreshStyle);
  }
});

$("atomScale").addEventListener("input", (e) => {
  state.atomScale = +e.target.value;
  $("atomScaleVal").textContent = state.atomScale.toFixed(2) + "×";
  if (state.data) debounce("atoms", 25, refreshStyle);
});

$("bondScale").addEventListener("input", (e) => {
  state.bondScale = +e.target.value;
  $("bondScaleVal").textContent = state.bondScale.toFixed(2) + "×";
  if (state.data) debounce("scene", 25, refreshStyle);
});

$("bondToggle").addEventListener("change", (e) => {
  state.showBonds = e.target.checked;
  if (state.data) debounce("scene", 20, refreshStyle);
});

$("cellToggle").addEventListener("change", (e) => {
  state.showCell = e.target.checked;
  // 只影响晶胞框是否绘制，不参与成键计算，键的显示不受影响
  if (state.data) debounce("scene", 20, refreshStyle);
});

$("pbcToggle").addEventListener("change", (e) => {
  state.showPbc = e.target.checked;
  if (state.data) debounce("pbc", 30, refreshData); // 镜像原子集合变化，需重建几何
});

$("tolerance").addEventListener("input", (e) => {
  state.tolerance = +e.target.value;
  $("toleranceVal").textContent = state.tolerance.toFixed(2);
  if (state.data) debounce("tol", 30, () => {
    pruneStaleFilters();
    updatePairChips();
    refreshData();
  });
});

/* ---------- 光影 / 材质 / 多面体 / 背景 / 精度 ---------- */

const fxRanges = Array.from(document.querySelectorAll("input.fx-range"));

function syncSeg(id, attr, val) {
  document.querySelectorAll("#" + id + " button").forEach((b) =>
    b.classList.toggle("on", b.dataset[attr] === val)
  );
}

function syncFxInputs() {
  fxRanges.forEach((r) => {
    const k = r.dataset.fx;
    if (state.fx[k] == null) return;
    r.value = state.fx[k];
    const tag = $(r.id + "Val");
    if (tag) tag.textContent = (+state.fx[k]).toFixed(2);
  });
  syncSeg("polySeg", "poly", state.fx.poly);
  syncSeg("bgSeg", "bg", state.fx.bgMode);
  syncSeg("qualSeg", "q", state.fx.quality);
}

fxRanges.forEach((r) =>
  r.addEventListener("input", () => {
    state.fx[r.dataset.fx] = +r.value;
    const tag = $(r.id + "Val");
    if (tag) tag.textContent = (+r.value).toFixed(2);
    refreshFx();
  })
);

document.querySelectorAll("#polySeg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.fx.poly = b.dataset.poly;
    syncSeg("polySeg", "poly", state.fx.poly);
    refreshFx();
  })
);

document.querySelectorAll("#bgSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.fx.bgMode = b.dataset.bg;
    syncSeg("bgSeg", "bg", state.fx.bgMode);
    refreshFx();
  })
);

document.querySelectorAll("#qualSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.fx.quality = b.dataset.q;
    syncSeg("qualSeg", "q", state.fx.quality);
    refreshFx();
  })
);

$("btnResetView").addEventListener("click", () => {
  if (state.viewer && state.data) {
    state.viewer.resetView();
    toast("视角已重置");
  }
});

$("btnExportPng").addEventListener("click", exportPng);

document.querySelectorAll("#exportScaleSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#exportScaleSeg button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    state.exportScale = +b.dataset.scale || 1;
  })
);

async function exportPng() {
  const v = state.viewer;
  if (!v || !state.data) {
    toast("请先加载结构再导出", true);
    return;
  }
  const scale = state.exportScale || 1;
  loading(true);
  try {
    const uri = v.exportPng(scale); // 超采样渲染，所见即所得
    if (!uri) throw new Error("no png uri");
    const a = document.createElement("a");
    a.href = uri;
    a.download = (state.fileName || "structure").replace(/[^\w.\-]+/g, "_") + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(scale > 1 ? `PNG 已导出（${scale}× 高清）` : "PNG 已导出");
  } catch (_) {
    toast("导出失败：当前浏览器不支持，可改用页面截图", true);
  } finally {
    loading(false);
  }
}

$("btnExportOffline").addEventListener("click", exportOfflineHtml);

/* 导出时把当前的显示设置一并带上，客户打开离线 HTML 看到的就是你现在的样子 */
function exportViewState() {
  return {
    preset: state.preset,
    showPbc: state.showPbc,
    showCell: state.showCell,
    showBonds: state.showBonds,
    mode: state.mode,
    scheme: state.scheme,
    atomScale: state.atomScale,
    bondScale: state.bondScale,
    tolerance: state.tolerance,
    exportScale: state.exportScale,
    fx: state.fx,
  };
}

/* 离线 HTML 打开时恢复导出时的显示设置 */
function applyExportView(view) {
  if (!view) return;
  if (view.preset && PRESETS[view.preset]) applyPreset(view.preset);
  if (view.fx) Object.assign(state.fx, view.fx);
  if (view.mode) {
    state.mode = view.mode;
    document.querySelectorAll("#modeSeg button").forEach((b) =>
      b.classList.toggle("on", b.dataset.modeValue === view.mode)
    );
  }
  if (view.scheme) {
    state.scheme = view.scheme;
    $("schemeSel").value = view.scheme;
  }
  if (typeof view.showPbc === "boolean") {
    state.showPbc = view.showPbc;
    $("pbcToggle").checked = view.showPbc;
  }
  if (typeof view.showCell === "boolean") {
    state.showCell = view.showCell;
    $("cellToggle").checked = view.showCell;
  }
  if (typeof view.showBonds === "boolean") {
    state.showBonds = view.showBonds;
    $("bondToggle").checked = view.showBonds;
  }
  if (view.atomScale) {
    state.atomScale = view.atomScale;
    $("atomScale").value = view.atomScale;
    $("atomScaleVal").textContent = (+view.atomScale).toFixed(2) + "×";
  }
  if (view.bondScale) {
    state.bondScale = view.bondScale;
    $("bondScale").value = view.bondScale;
    $("bondScaleVal").textContent = (+view.bondScale).toFixed(2) + "×";
  }
  if (view.tolerance) {
    state.tolerance = view.tolerance;
    $("tolerance").value = view.tolerance;
    $("toleranceVal").textContent = (+view.tolerance).toFixed(2);
  }
  if (view.exportScale) {
    state.exportScale = view.exportScale;
    document.querySelectorAll("#exportScaleSeg button").forEach((b) =>
      b.classList.toggle("on", +b.dataset.scale === +view.exportScale)
    );
  }
  syncFxInputs();
}

async function exportOfflineHtml() {
  const data = state.data;
  if (!data) {
    toast("请先加载一个结构，再导出离线 HTML", true);
    return;
  }
  loading(true);
  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.fileName || "structure",
        data,
        view: exportViewState(),
      }),
    });
    if (!resp.ok) {
      let msg = "导出失败";
      try { msg = (await resp.json()).detail || msg; } catch (_) { /* 忽略 */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.fileName || "structure").replace(/[^\w.\-]+/g, "_") + ".html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("已导出离线 HTML，客户双击文件即可本地查看");
  } catch (e) {
    toast("导出失败：" + e.message, true);
  } finally {
    loading(false);
  }
}

/* ---------- 只看键 chips ---------- */

function updatePairChips() {
  const box = $("pairChips");
  const pairs = candidatePairSet();
  box.innerHTML = "";
  if (!pairs.size) {
    box.innerHTML = '<span class="chip-none">当前容差内无成键</span>';
    return;
  }
  Array.from(pairs).sort().forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (state.pairFilters.has(p) ? " on" : "");
    chip.textContent = p;
    chip.dataset.pair = p;
    chip.addEventListener("click", () => {
      if (state.pairFilters.has(p)) state.pairFilters.delete(p);
      else state.pairFilters.add(p);
      chip.classList.toggle("on", state.pairFilters.has(p));
      refreshData();
    });
    box.appendChild(chip);
  });
}

function pruneStaleFilters() {
  const pairs = candidatePairSet();
  [...state.pairFilters].forEach((p) => {
    if (!pairs.has(p)) state.pairFilters.delete(p);
  });
}

/* ------------------------- 启动 ------------------------- */

window.addEventListener("resize", () => {
  if (state.viewer) debounce("resize", 120, () => state.viewer.resize());
});

document.addEventListener("DOMContentLoaded", () => {
  clearAll();
  applyPreset(state.preset);
  applyHostTheme(hostThemeFromQuery());
  notifyHostViewerReady();
  setupMeasureUI();
  setupQuickViewUI();
});

if (document.readyState === "complete" || document.readyState === "interactive") {
  clearAll();
  applyPreset(state.preset);
  applyHostTheme(hostThemeFromQuery());
  notifyHostViewerReady();
  setupMeasureUI();
  setupQuickViewUI();
}

/* 离线导出模式：直接加载内嵌结构，隐藏“加载结构”面板 */
if (OFFLINE_EXPORT) {
  const cardLoad = $("cardLoad");
  if (cardLoad) cardLoad.classList.add("hidden");
  document.querySelector(".head-text .sub").textContent =
    "离线结构演示 · 双击打开即可查看，无需安装服务";
  applyExportView(window.__EXPORT__.view);
  window.__exportData = window.__EXPORT__.data;
  setTimeout(() => {
    const frames = window.__EXPORT__.frames;
    if (Array.isArray(frames) && frames.length >= 2) setupTrajectoryUI(frames);
    else renderStructure(window.__EXPORT__.data);
  }, 30);
}
