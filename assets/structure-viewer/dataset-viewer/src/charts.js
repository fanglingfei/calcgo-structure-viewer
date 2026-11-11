function setup(canvas, width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export function drawLine(canvas, series, options = {}) {
  const width = canvas.clientWidth || options.width || 280;
  const height = options.height || 84;
  const { ctx } = setup(canvas, width, height);
  const pad = { l: 34, r: 10, t: 8, b: 20 };
  const all = series.flatMap((item) => item.y).filter(Number.isFinite);
  if (!all.length) return;
  const min = options.min ?? Math.min(...all);
  const max = options.max ?? Math.max(...all);
  const span = Math.max(1e-9, max - min);
  ctx.strokeStyle = "rgba(147,205,203,.14)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + ((height - pad.t - pad.b) * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
  }
  const colors = ["#52decb", "#f0b35a", "#73a6ff", "#ff7d6e", "#b9e36c"];
  series.forEach((item, seriesIndex) => {
    const n = item.y.length;
    ctx.beginPath();
    ctx.strokeStyle = item.color || colors[seriesIndex % colors.length];
    ctx.lineWidth = 1.7;
    item.y.forEach((value, i) => {
      if (!Number.isFinite(value)) return;
      const x = pad.l + (width - pad.l - pad.r) * (i / Math.max(1, n - 1));
      const y = pad.t + (height - pad.t - pad.b) * (1 - (value - min) / span);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.fillStyle = "#88a7a8";
  ctx.font = "10px Space Grotesk, sans-serif";
  ctx.fillText(String(min.toPrecision(4)), 2, height - 8);
  ctx.fillText(String(max.toPrecision(4)), 2, 12);
}

export function drawHeatmap(canvas, histogram) {
  const width = canvas.clientWidth || 280;
  const height = 170;
  const { ctx } = setup(canvas, width, height);
  const rows = histogram.length;
  const cols = histogram[0]?.length || 0;
  const max = Math.max(...histogram.flat());
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = Math.pow((histogram[y][x] || 0) / Math.max(max, 1e-9), 0.42);
      ctx.fillStyle = `rgba(${Math.round(20 + 35 * t)}, ${Math.round(55 + 185 * t)}, ${Math.round(65 + 130 * t)}, ${0.15 + 0.85 * t})`;
      ctx.fillRect((x / cols) * width, height - ((y + 1) / rows) * height,
        width / cols + 1, height / rows + 1);
    }
  }
}

export function drawScatter(canvas, points, labels) {
  const width = canvas.clientWidth || 280;
  const height = 190;
  const { ctx } = setup(canvas, width, height);
  if (!points.length) return;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const colors = ["#52decb", "#f0b35a", "#ff7d6e", "#73a6ff", "#b9e36c", "#d79cff"];
  points.forEach((point, i) => {
    const x = 16 + (width - 32) * ((point[0] - minX) / spanX);
    const y = 12 + (height - 28) * (1 - (point[1] - minY) / spanY);
    ctx.fillStyle = colors[Math.abs(labels[i] || 0) % colors.length];
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
  });
}

export function drawSpectrum(canvas, xValues, yValues, options = {}) {
  const width = canvas.clientWidth || options.width || 280;
  const height = options.height || 150;
  const { ctx } = setup(canvas, width, height);
  const points = xValues
    .map((x, index) => [Number(x), Number(yValues[index])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!points.length) return;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(0, ...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  ctx.strokeStyle = "rgba(147,205,203,.16)";
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + ((height - pad.t - pad.b) * i) / 3;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
  }
  ctx.strokeStyle = options.color || "#f0b35a";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    const px = pad.l + (width - pad.l - pad.r) * ((x - minX) / spanX);
    const py = pad.t + (height - pad.t - pad.b) * (1 - (y - minY) / spanY);
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = "#88a7a8";
  ctx.font = "10px Space Grotesk, sans-serif";
  ctx.fillText(minX.toPrecision(4), 2, height - 6);
  ctx.fillText(maxX.toPrecision(4), Math.max(2, width - 54), height - 6);
  ctx.fillText(maxY.toPrecision(3), 2, 12);
}
