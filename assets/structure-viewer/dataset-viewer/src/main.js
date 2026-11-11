import "./styles.css";
import { assetUrl, datasetId, fetchJSON, loadDataset, runAnalysis } from "./api.js";
import { AtomisticViewer } from "./atomistic.js";
import { CaeViewer } from "./cae.js";
import { VolumeViewer } from "./volume3d.js";
import { drawHeatmap, drawLine, drawScatter, drawSpectrum } from "./charts.js";

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const fmtBytes = (value) => {
  const size = Number(value || 0);
  if (size > 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size > 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
};

let manifest = null;
let renderer = null;
let playing = false;
let playTimer = null;
let currentFrame = 0;
let sourceUrl = "";

function setStatus(text, bad = false) {
  const element = $("#vd-status");
  element.textContent = text;
  element.classList.toggle("vd-error", bad);
}

function showDetails(data) {
  manifest = data;
  $("#vd-main").hidden = false;
  $("#vd-empty").hidden = true;
  $("#vd-title").textContent = data.name || "数据集";
  const kindLabel = {
    trajectory: "轨迹与动画", volume: "电子体数据", mesh: "CAE 网格"
  }[data.kind] || "数据";
  $("#vd-kind").textContent = kindLabel;
  const structure = data.structure || {};
  const timeline = data.timeline || {};
  const details = [
    ["类型", data.kind],
    ["引擎", data.source?.engine || data.source?.format || "—"],
    ["原子", structure.n_atoms ?? "—"],
    ["帧数", timeline.n_frames ?? "—"],
    ["状态", data.status]
  ];
  $("#vd-meta").innerHTML = details.map(([key, value]) =>
    `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("");
  const warnings = data.warnings || [];
  $("#vd-overlay").innerHTML = warnings.map((text) =>
    `<div class="vd-note">${esc(text)}</div>`).join("");
  const assetSource = (data.source?.asset_files || []).find(Boolean);
  sourceUrl = assetSource
    ? `/api/viewer/datasets/${encodeURIComponent(datasetId)}/assets/${assetSource.split("/").map(encodeURIComponent).join("/")}`
    : "";
  const link = $("#vd-download-source");
  if (sourceUrl) {
    link.href = sourceUrl;
    link.textContent = "原始文件";
  } else {
    link.hidden = true;
  }
}

function clearRenderer() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  playing = false;
  if (renderer?.dispose) renderer.dispose();
  renderer = null;
  $("#vd-view").innerHTML = "";
  $("#vd-controls").innerHTML = "";
  $("#vd-analysis").hidden = true;
}

function controlRow(label, controlHtml, valueId = "", valueText = "") {
  return `<label class="vd-control-row"><span>${esc(label)}</span>
    <span>${controlHtml}${valueId ? `<output id="${valueId}">${esc(valueText)}</output>` : ""}</span></label>`;
}

function setupTrajectory() {
  renderer = new AtomisticViewer($("#vd-view"), manifest);
  window.__calcgoViewer = renderer;
  $("#vd-timeline").hidden = false;
  const frames = Number(manifest.timeline?.n_frames || 1);
  $("#vd-frame").max = String(Math.max(0, frames - 1));
  $("#vd-frame").value = "0";
  $("#vd-controls").innerHTML = `
    <div class="vd-panel-head"><div><span class="vd-kicker">PLAYBACK</span><h2>显示控制</h2></div></div>
    <div class="vd-control-grid">
      <button id="vd-fit" class="vd-btn" type="button">适应视图</button>
      <button id="vd-first" class="vd-btn compact" type="button">首帧</button>
      <button id="vd-last" class="vd-btn compact" type="button">末帧</button>
      <button id="vd-keyframe" class="vd-btn compact" type="button">关键帧</button>
      ${manifest.timeline?.normal_modes ? `
      ${controlRow("振动模式", `<select id="vd-mode" class="vd-select"><option value="-1">关闭</option>
        ${manifest.timeline.normal_modes.frequencies_cm1.map((freq, index) =>
          `<option value="${index}">#${index + 1} · ${Number(freq).toFixed(1)} cm⁻¹</option>`).join("")}
      </select>`)}` : ""}
    </div>
    ${(manifest.timeline?.normal_modes || manifest.timeline?.spectra_asset) ? `
      <div class="vd-control-row"><span>谱图</span><span>
        <select id="vd-spectrum-mode" class="vd-select">
          ${manifest.timeline?.normal_modes ? '<option value="ir">IR</option>' : ""}
          ${manifest.timeline?.spectra_asset ? '<option value="uvvis">UV-Vis</option>' : ""}
        </select>
      </span></div>
      <canvas id="vd-spectrum-chart" height="150"></canvas>` : ""}
    <p class="vd-small">大体系默认关闭键检测；轨迹切换保持相机视角。原始帧可按需请求。</p>`;
  $("#vd-fit").onclick = () => renderer.fitView();
  const mode = $("#vd-mode");
  if (mode) mode.onchange = () => renderer.setNormalMode(Number(mode.value), 0);
  const energies = manifest.timeline?.energies || [];
  const labels = manifest.timeline?.frame_labels || [];
  const keyframes = (() => {
    if (frames < 3) return [0, frames - 1];
    const found = [0, frames - 1];
    for (let index = 1; index < frames - 1; index++) {
      const left = Number(energies[index - 1]);
      const center = Number(energies[index]);
      const right = Number(energies[index + 1]);
      if ([left, center, right].every(Number.isFinite)
          && ((center - left) * (right - center) <= 0)) {
        found.push(index);
      }
    }
    return [...new Set(found)].sort((a, b) => a - b);
  })();
  const updateFrame = (index) => {
    currentFrame = Math.max(0, Math.min(frames - 1, Number(index)));
    renderer.setFrame(currentFrame);
    $("#vd-frame").value = String(currentFrame);
    const energy = Number(energies[currentFrame]);
    const label = labels[currentFrame] ?? currentFrame;
    $("#vd-frame-label").textContent = `帧 ${label} · ${currentFrame + 1}/${frames}${Number.isFinite(energy) ? ` · E ${energy.toFixed(5)}` : ""}`;
    const chart = $("#vd-timeline-chart");
    if (Number.isFinite(energy)) {
      drawLine(chart, [{ y: energies.map((item) => Number(item)) }], { height: 56 });
    } else {
      const ctx = chart.getContext("2d");
      ctx.clearRect(0, 0, chart.width, chart.height);
    }
  };
  $("#vd-frame").oninput = (event) => { stopPlayback(); updateFrame(event.target.value); };
  $("#vd-prev").onclick = () => updateFrame(currentFrame - 1);
  $("#vd-next").onclick = () => updateFrame(currentFrame + 1);
  $("#vd-first").onclick = () => updateFrame(0);
  $("#vd-last").onclick = () => updateFrame(frames - 1);
  $("#vd-keyframe").onclick = () => {
    const nextIndex = keyframes.findIndex((index) => index > currentFrame);
    updateFrame(keyframes[nextIndex >= 0 ? nextIndex : 0]);
  };
  $("#vd-play").onclick = () => playing ? stopPlayback() : startPlayback();
  $("#vd-speed").onchange = () => {
    if (playing) { stopPlayback(); startPlayback(); }
  };
  window.addEventListener("keydown", (event) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName)) return;
    if (event.key === "ArrowLeft") updateFrame(currentFrame - 1);
    if (event.key === "ArrowRight") updateFrame(currentFrame + 1);
    if (event.key === "Home") updateFrame(0);
    if (event.key === "End") updateFrame(frames - 1);
    if (event.key === " ") { event.preventDefault(); playing ? stopPlayback() : startPlayback(); }
  });
  const spectrumMode = $("#vd-spectrum-mode");
  let uvvis = null;
  const drawSelectedSpectrum = async () => {
    const canvas = $("#vd-spectrum-chart");
    if (!canvas || !spectrumMode) return;
    if (spectrumMode.value === "ir") {
      const modes = manifest.timeline?.normal_modes || {};
      drawSpectrum(canvas, modes.frequencies_cm1 || [], modes.ir_intensities || [],
        { color: "#52decb" });
      return;
    }
    if (!uvvis && manifest.timeline?.spectra_asset) {
      uvvis = await (await fetch(assetUrl(manifest.timeline.spectra_asset))).json();
    }
    drawSpectrum(canvas, uvvis?.energies_cm1 || [],
      uvvis?.oscillator_strengths || [], { color: "#73a6ff" });
  };
  if (spectrumMode) {
    spectrumMode.onchange = () => drawSelectedSpectrum().catch(fail);
  }
  renderer.load().then(() => {
    updateFrame(0);
    if (spectrumMode) drawSelectedSpectrum().catch(fail);
    setStatus("已就绪");
    setupAnalysis();
  }).catch((error) => fail(error));
  function startPlayback() {
    playing = true;
    $("#vd-play").textContent = "暂停";
    playTimer = setInterval(() => {
      updateFrame(currentFrame + 1);
      if (currentFrame >= frames - 1) stopPlayback();
    }, Number($("#vd-speed").value));
  }
  function stopPlayback() {
    playing = false;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    $("#vd-play").textContent = "播放";
  }
}

function setupVolume() {
  $("#vd-timeline").hidden = true;
  renderer = new VolumeViewer($("#vd-view"), manifest);
  window.__calcgoViewer = renderer;
  $("#vd-controls").innerHTML = `
    <div class="vd-panel-head"><div><span class="vd-kicker">VOLUME</span><h2>体渲染</h2></div></div>
    <div class="vd-control-grid">
      ${controlRow("配色", `<select id="vd-preset" class="vd-select">
        <option value="teal">青蓝密度</option><option value="fire">暖色密度</option>
        <option value="diverging">正负发散</option></select>`)}
      ${manifest.assets?.iso_positive || manifest.assets?.iso_negative ? controlRow("等值面", `
        <button id="vd-iso-pos" class="vd-btn compact" type="button">+ 等值面</button>
        <button id="vd-iso-neg" class="vd-btn compact" type="button">− 等值面</button>`) : ""}
      ${controlRow("裁剪", `<input id="vd-crop-on" type="checkbox"> <input id="vd-crop" type="range" min="0.1" max="1" step="0.02" value="1">`)}
      ${controlRow("切片轴", `<select id="vd-slice-axis" class="vd-select">
        <option value="2">c / z</option><option value="1">b / y</option><option value="0">a / x</option></select>`)}
      ${controlRow("切片位置", `<input id="vd-slice" type="range" min="0" max="1" step="0.01" value="0.5">`)}
      ${controlRow("标量上限", `<input id="vd-range-high" type="range" min="0.01" max="1" step="0.01" value="1">`,
        "vd-range-high-value", Number(manifest.volume?.scalar_max ?? 1).toPrecision(4))}
      ${controlRow("标量下限", `<input id="vd-range-low" type="range" min="0" max="0.99" step="0.01" value="0">`,
        "vd-range-low-value", Number(manifest.volume?.scalar_min ?? 0).toPrecision(4))}
      ${manifest.structure?.positions?.length ? controlRow("原子叠加", `<input id="vd-atoms-on" type="checkbox" checked>`) : ""}
      <canvas id="vd-volume-slice" height="180"></canvas>
    </div>
    <p class="vd-small">${esc(manifest.volume?.quantity || "体数据")} · ${esc(manifest.volume?.unit || "")} ·
      ${manifest.volume?.dims?.join(" × ")}</p>`;
  const drawSlice = () => {
    const axis = Number($("#vd-slice-axis").value);
    const fraction = Number($("#vd-slice").value);
    const slice = renderer.sliceValues(axis, fraction);
    const canvas = $("#vd-volume-slice");
    const ctx = canvas.getContext("2d");
    const width = canvas.clientWidth || 260;
    canvas.width = width;
    canvas.height = 180;
    if (!slice) return;
    const image = ctx.createImageData(slice.width, slice.height);
    slice.values.forEach((value, index) => {
      const t = value / (slice.max || 255);
      image.data[index * 4] = Math.round(15 + 240 * Math.pow(t, .7));
      image.data[index * 4 + 1] = Math.round(45 + 195 * Math.pow(t, .45));
      image.data[index * 4 + 2] = Math.round(65 + 155 * Math.pow(t, .8));
      image.data[index * 4 + 3] = 255;
    });
    const temp = document.createElement("canvas");
    temp.width = slice.width; temp.height = slice.height;
    temp.getContext("2d").putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, 0, 0, width, 180);
  };
  $("#vd-preset").onchange = (event) => renderer.applyPreset(event.target.value);
  $("#vd-iso-pos")?.addEventListener("click", () => renderer.showIso("iso_positive").catch(fail));
  $("#vd-iso-neg")?.addEventListener("click", () => renderer.showIso("iso_negative").catch(fail));
  $("#vd-crop-on").onchange = () => renderer.setCropping($("#vd-crop-on").checked, Number($("#vd-crop").value));
  $("#vd-crop").oninput = () => renderer.setCropping($("#vd-crop-on").checked, Number($("#vd-crop").value));
  $("#vd-slice-axis").onchange = drawSlice;
  $("#vd-slice").oninput = drawSlice;
  const updateRange = () => {
    let low = Number($("#vd-range-low").value);
    let high = Number($("#vd-range-high").value);
    if (low >= high) {
      low = Math.max(0, high - 0.01);
      $("#vd-range-low").value = String(low);
    }
    renderer.setScalarRange(low, high);
    const scalarMin = Number(manifest.volume?.scalar_min ?? 0);
    const scalarMax = Number(manifest.volume?.scalar_max ?? 1);
    $("#vd-range-low-value").textContent =
      (scalarMin + (scalarMax - scalarMin) * low).toPrecision(4);
    $("#vd-range-high-value").textContent =
      (scalarMin + (scalarMax - scalarMin) * high).toPrecision(4);
    drawSlice();
  };
  $("#vd-range-low").oninput = updateRange;
  $("#vd-range-high").oninput = updateRange;
  $("#vd-atoms-on")?.addEventListener("change", (event) =>
    renderer.setAtomVisible(event.target.checked));
  renderer.load().then(() => {
    if (!renderer.volumeSupported) {
      return Promise.all([
        renderer.showIso("iso_negative").catch(() => null),
        renderer.showIso("iso_positive").catch(() => null)
      ]).then(() => {
        const hasIso = manifest.assets?.iso_positive || manifest.assets?.iso_negative;
        setStatus(hasIso ? "当前显卡已回退到等值面" : "体渲染不可用；切片仍可使用");
      });
    }
    setStatus("体渲染就绪");
    drawSlice();
  }).catch(async (error) => {
    try {
      await renderer.showIso("iso_negative");
      await renderer.showIso("iso_positive");
      setStatus("体渲染失败，已回退到等值面");
    } catch (_) {
      fail(error);
    }
  });
}

function setupCae() {
  $("#vd-timeline").hidden = true;
  renderer = new CaeViewer($("#vd-view"), manifest);
  window.__calcgoViewer = renderer;
  const fields = renderer.fieldNames();
  $("#vd-controls").innerHTML = `
    <div class="vd-panel-head"><div><span class="vd-kicker">CAE</span><h2>网格与场</h2></div></div>
    <div class="vd-control-grid">
      ${controlRow("着色场", `<select id="vd-field" class="vd-select"><option value="">几何</option>
        ${fields.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select>`)}
      ${controlRow("透明度", `<input id="vd-opacity" type="range" min="0.1" max="1" step="0.05" value="1">`)}
      ${controlRow("线框", `<input id="vd-wire" type="checkbox">`)}
      ${controlRow("裁剪", `<input id="vd-clip-on" type="checkbox">
        <input id="vd-clip" type="range" min="0" max="1" step="0.01" value="0.5">`)}
      ${controlRow("裁剪轴", `<select id="vd-clip-axis" class="vd-select">
        <option value="0">x</option><option value="1">y</option><option value="2">z</option></select>`)}
    </div>
    <p class="vd-small">${manifest.mesh?.n_points || 0} 点 · ${manifest.mesh?.n_triangles || 0} 三角形</p>`;
  $("#vd-field").onchange = (event) => renderer.setField(event.target.value);
  $("#vd-opacity").oninput = (event) => renderer.setOpacity(event.target.value);
  $("#vd-wire").onchange = (event) => renderer.setWireframe(event.target.checked);
  const clip = () => renderer.setClip(
    $("#vd-clip-on").checked,
    Number($("#vd-clip").value),
    Number($("#vd-clip-axis").value)
  );
  $("#vd-clip-on").onchange = clip;
  $("#vd-clip").oninput = clip;
  $("#vd-clip-axis").onchange = clip;
  renderer.load().then(() => {
    setStatus("CAE 网格就绪");
    if (fields.length) {
      $("#vd-field").value = fields[0];
      renderer.setField(fields[0]);
    }
  }).catch(fail);
}

function setupAnalysis() {
  const elements = [...new Set(manifest.structure?.elements || [])];
  const first = elements[0] || "";
  const second = elements[1] || first;
  const nAtoms = Number(manifest.structure?.n_atoms || 0);
  const firstFour = Array.from({ length: Math.min(4, nAtoms) }, (_, index) =>
    String(index)).join(",");
  const options = elements.map((element) => `<option>${esc(element)}</option>`).join("");
  $("#vd-analysis").hidden = false;
  $("#vd-analysis").innerHTML = `
    <div class="vd-panel-head"><div><span class="vd-kicker">ANALYSIS</span><h2>MD 分析</h2></div></div>
    <div class="vd-tabs">
      <button class="vd-tab on" data-tab="rdf">RDF</button>
      <button class="vd-tab" data-tab="dynamics">动力学</button>
      <button class="vd-tab" data-tab="density">密度</button>
      <button class="vd-tab" data-tab="hbonds">氢键</button>
      <button class="vd-tab" data-tab="clustering">聚类</button>
    </div>
    <div id="vd-analysis-body" class="vd-analysis-body"></div>`;
  const body = $("#vd-analysis-body");
  let active = "rdf";
  const renderTab = () => {
    document.querySelectorAll(".vd-tab").forEach((button) =>
      button.classList.toggle("on", button.dataset.tab === active));
    if (active === "rdf") {
      body.innerHTML = `
        <div class="vd-control-row"><span>元素对</span><span><select id="vd-rdf-1" class="vd-select">${options}</select>
          <select id="vd-rdf-2" class="vd-select">${options}</select></span></div>
        ${controlRow("r 范围", `<input id="vd-rdf-max" class="vd-input" type="number" value="10" step="1">`)}
        <button id="vd-rdf-run" class="vd-btn primary" type="button">计算 RDF</button>
        <canvas id="vd-rdf-chart" height="150"></canvas>`;
      $("#vd-rdf-1").value = first; $("#vd-rdf-2").value = second;
      $("#vd-rdf-run").onclick = async () => {
        setStatus("计算 RDF…");
        try {
          const result = await runAnalysis("rdf", {
            selection_1: { elements: [$("#vd-rdf-1").value] },
            selection_2: { elements: [$("#vd-rdf-2").value] },
            r_max: Number($("#vd-rdf-max").value)
          });
          drawLine($("#vd-rdf-chart"), [
            { y: result.g_r, color: "#52decb" },
            { y: result.coordination_number, color: "#f0b35a" }
          ], { height: 150 });
          setStatus(`RDF 完成 · ${result.n_frames} 帧`);
        } catch (error) { fail(error); }
      };
    } else if (active === "dynamics") {
      body.innerHTML = `
        <button id="vd-rmsd" class="vd-btn" type="button">RMSD</button>
        <button id="vd-rmsf" class="vd-btn" type="button">RMSF</button>
        <button id="vd-msd" class="vd-btn" type="button">MSD</button>
        ${controlRow("原子对", `<input id="vd-pair" class="vd-input" value="${nAtoms > 1 ? "0,1" : "0,0"}">`)}
        <button id="vd-distance" class="vd-btn" type="button">原子对距离</button>
        ${controlRow("四原子", `<input id="vd-quartet" class="vd-input" value="${firstFour}">`)}
        <button id="vd-dihedral" class="vd-btn" type="button">二面角</button>
        <button id="vd-com" class="vd-btn" type="button">质心轨迹</button>
        <canvas id="vd-dyn-chart" height="160"></canvas>
        <div class="vd-small">RMSD 使用最小二乘叠合；距离和二面角按周期边界最小像处理。</div>`;
      $("#vd-rmsd").onclick = async () => {
        try {
          const result = await runAnalysis("rmsd", {});
          drawLine($("#vd-dyn-chart"), [{ y: result.rmsd_angstroms }], { height: 160 });
          setStatus("RMSD 完成");
        } catch (error) { fail(error); }
      };
      $("#vd-rmsf").onclick = async () => {
        try {
          const result = await runAnalysis("rmsf", {});
          drawLine($("#vd-dyn-chart"), [{ y: result.rmsf_angstroms, color: "#f0b35a" }], { height: 160 });
          setStatus("RMSF 完成");
        } catch (error) { fail(error); }
      };
      $("#vd-msd").onclick = async () => {
        try {
          const result = await runAnalysis("msd", {});
          drawLine($("#vd-dyn-chart"), [{ y: result.msd_angstrom2 }], { height: 160 });
          setStatus("MSD 完成");
        } catch (error) { fail(error); }
      };
      $("#vd-distance").onclick = async () => {
        try {
          const pair = $("#vd-pair").value.split(",").map(Number);
          if (pair.length !== 2 || pair.some((value) => !Number.isInteger(value))) {
            throw new Error("原子对请输入两个整数索引");
          }
          const result = await runAnalysis("distances", { pairs: [pair] });
          drawLine($("#vd-dyn-chart"), [
            { y: result.distances.map((row) => row[0]) }
          ], { height: 160 });
          setStatus("原子对距离完成");
        } catch (error) { fail(error); }
      };
      $("#vd-dihedral").onclick = async () => {
        try {
          const quartet = $("#vd-quartet").value.split(",").map(Number);
          if (quartet.length !== 4 || quartet.some((value) => !Number.isInteger(value))) {
            throw new Error("二面角请输入四个整数索引");
          }
          const result = await runAnalysis("dihedrals", { quartets: [quartet] });
          drawLine($("#vd-dyn-chart"), [
            { y: result.dihedrals_deg.map((row) => row[0]), color: "#73a6ff" }
          ], { height: 160 });
          setStatus("二面角完成");
        } catch (error) { fail(error); }
      };
      $("#vd-com").onclick = async () => {
        try {
          const result = await runAnalysis("com", {});
          drawLine($("#vd-dyn-chart"), [
            { y: result.positions.map((point) => point[0]), color: "#52decb" },
            { y: result.positions.map((point) => point[1]), color: "#f0b35a" },
            { y: result.positions.map((point) => point[2]), color: "#73a6ff" }
          ], { height: 160 });
          setStatus("质心轨迹完成");
        } catch (error) { fail(error); }
      };
    } else if (active === "density") {
      body.innerHTML = `
        <select id="vd-density-plane" class="vd-select"><option value="xy">xy</option><option value="xz">xz</option><option value="yz">yz</option></select>
        <button id="vd-density-run" class="vd-btn primary" type="button">生成二维密度</button>
        <canvas id="vd-density-chart" height="180"></canvas>`;
      $("#vd-density-run").onclick = async () => {
        try {
          const result = await runAnalysis("density", { plane: $("#vd-density-plane").value });
          drawHeatmap($("#vd-density-chart"), result.histogram);
          setStatus("二维密度完成");
        } catch (error) { fail(error); }
      };
    } else if (active === "hbonds") {
      body.innerHTML = `<button id="vd-hb-run" class="vd-btn primary" type="button">检测 D–H 距离氢键</button>
        <canvas id="vd-hb-chart" height="150"></canvas><p id="vd-hb-note" class="vd-small"></p>`;
      $("#vd-hb-run").onclick = async () => {
        try {
          const result = await runAnalysis("hbonds", {});
          drawLine($("#vd-hb-chart"), [{ y: result.counts, color: "#73a6ff" }], { height: 150, min: 0 });
          $("#vd-hb-note").textContent = result.criterion;
          setStatus("氢键检测完成");
        } catch (error) { fail(error); }
      };
    } else if (active === "clustering") {
      body.innerHTML = `<button id="vd-cluster-run" class="vd-btn primary" type="button">RMSD 聚类与 PCA</button>
        <canvas id="vd-cluster-chart" height="190"></canvas><p id="vd-cluster-note" class="vd-small"></p>`;
      $("#vd-cluster-run").onclick = async () => {
        try {
          const result = await runAnalysis("clustering", { method: "kmeans", n_clusters: 3 });
          drawScatter($("#vd-cluster-chart"), result.pca_2d, result.labels);
          $("#vd-cluster-note").textContent = `发现 ${result.n_clusters_found} 类`;
          setStatus("聚类完成");
        } catch (error) { fail(error); }
      };
    }
  };
  document.querySelectorAll(".vd-tab").forEach((button) => {
    button.onclick = () => { active = button.dataset.tab; renderTab(); };
  });
  renderTab();
}

function fail(error) {
  console.error(error);
  setStatus(error?.message || String(error), true);
  $("#vd-overlay").insertAdjacentHTML("beforeend",
    `<div class="vd-note vd-error">${esc(error?.message || error)}</div>`);
}

async function boot() {
  $("#vd-help").onclick = () => $("#vd-help-dialog").showModal();
  $("#vd-help-close").onclick = () => $("#vd-help-dialog").close();
  if (!datasetId) {
    $("#vd-empty-message").textContent = "也可以从任务结果页直接打开已生成的数据集。";
    const form = $("#vd-upload-form");
    form.hidden = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const files = $("#vd-upload-files").files;
      if (!files.length) return;
      const name = $("#vd-upload-name").value || "上传数据集";
      setStatus("正在初始化分块上传…");
      try {
        const init = await fetchJSON("/api/viewer/uploads/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            engine: "",
            files: [...files].map((file) => ({ name: file.name, size: file.size }))
          })
        });
        const upload = init.upload;
        for (const file of files) {
          const chunks = Math.max(1, Math.ceil(file.size / upload.chunk_size));
          for (let index = 0; index < chunks; index++) {
            const start = index * upload.chunk_size;
            const end = Math.min(file.size, start + upload.chunk_size);
            setStatus(`上传 ${file.name} · ${index + 1}/${chunks}`);
            await fetchJSON(
              `/api/viewer/uploads/${encodeURIComponent(upload.upload_id)}/chunks/${index}`
                + `?file_name=${encodeURIComponent(file.name)}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: file.slice(start, end)
              }
            );
          }
        }
        setStatus("正在标准化数据…");
        const result = await fetchJSON(
          `/api/viewer/uploads/${encodeURIComponent(upload.upload_id)}/complete`,
          { method: "POST" }
        );
        location.href = `/api/viewer/datasets/${result.dataset.dataset_id}/page`;
      } catch (error) { fail(error); }
    };
    return;
  }
  setStatus("读取数据集…");
  try {
    const data = await loadDataset();
    showDetails(data);
    if (data.kind === "trajectory") setupTrajectory();
    else if (data.kind === "volume") setupVolume();
    else if (data.kind === "mesh") setupCae();
    else throw new Error(`暂不支持 ${data.kind}`);
  } catch (error) { fail(error); }
}

window.addEventListener("beforeunload", clearRenderer);
boot();
