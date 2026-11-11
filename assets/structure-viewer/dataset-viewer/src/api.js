const datasetId = window.CALCGO_DATASET_ID || "";
let csrfPromise = null;

async function csrfToken() {
  if (window.__CALCGO_CSRF__) return window.__CALCGO_CSRF__;
  if (!csrfPromise) {
    csrfPromise = fetch("/api/auth/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        window.__CALCGO_CSRF__ = data.csrf_token || "";
        return window.__CALCGO_CSRF__;
      })
      .catch(() => "");
  }
  return csrfPromise;
}

export function assetUrl(name) {
  return `/api/viewer/datasets/${encodeURIComponent(datasetId)}/assets/${name
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function fetchJSON(url, options) {
  const request = { ...(options || {}) };
  const method = String(request.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)
      && !String(url).startsWith("/api/auth/")) {
    const token = await csrfToken();
    if (token) {
      request.headers = { ...(request.headers || {}), "X-CSRF-Token": token };
    }
  }
  const res = await fetch(url, request);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

export async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`资源读取失败: ${url}`);
  return res.arrayBuffer();
}

export async function loadDataset() {
  const data = await fetchJSON(`/api/viewer/datasets/${encodeURIComponent(datasetId)}`);
  return data.dataset;
}

export async function runAnalysis(kind, payload = {}) {
  const data = await fetchJSON(
    `/api/viewer/datasets/${encodeURIComponent(datasetId)}/analysis/${encodeURIComponent(kind)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  return data.result;
}

export { datasetId };
