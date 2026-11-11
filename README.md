# CalcGO Structure Viewer — Agent Skill

> Render, inspect, screenshot, and export a scientifically faithful 3D crystal / molecule viewer for **POSCAR, CONTCAR, and CIF** files.

This repository packages CalcGO's structure viewer as a portable **Agent Skill** (Claude / WorkBuddy / OpenAI-style skills). The viewer itself is a self-contained **FastAPI + Three.js** application — it runs offline, needs no external CDN, and can export a single-file interactive HTML that you can email to a colleague.

The point of the skill is *visual consistency*: atom radii, bond detection, CPK colors, default camera framing, themes, and export behavior are all fixed by a written display contract, so an agent reproduces the same image every time instead of improvising a matplotlib scatter plot.

---

## What's inside

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Skill manifest + workflow the agent follows. |
| `agents/openai.yaml` | Interface metadata (display name, brand color, default prompt). |
| `scripts/render_structure.py` | Parse one structure → offline HTML, optionally PNG. |
| `scripts/launch_viewer.py` | Start the interactive viewer on a local port. |
| `assets/structure-viewer/` | The standalone FastAPI + Three.js app (`server.py`, `static/`). |
| `assets/structure-viewer/dataset-viewer/` | Optional Vite source for the multi-type trajectory / volume / CAE viewer. |
| `assets/examples/simple.vasp` | Diamond Si sample to try the pipeline immediately. |
| `references/display-contract.md` | Exact defaults, CPK table, presets, embedding parameters, display formulas. |
| `references/camera-and-rotation.md` | Camera, focus, orbit, pan, zoom, offline-view behavior. |

## Features

- **Structure input** — POSCAR / CONTCAR / CIF, including multi-block CIF (pick the block index).
- **Rendering** — ball-and-stick / space-fill / stick modes; bond detection from covalent radii with periodic images; bond-length tolerance tuning; element-pair bond filtering.
- **Appearance** — CPK / soft / mono color schemes, seven visual presets (`studio`, `dark`, `paper`, `metal`, `figure`, `ball`, `poster`), adjustable atom and bond scale.
- **Camera** — automatic framing from the atom bounding box and canvas aspect ratio; orbit / pan / zoom; axis-aligned views.
- **Export** — self-contained offline HTML (~0.8 MB, Three.js inlined) and high-resolution PNG (scale 1×–3×) via Playwright.
- **No network at runtime** — Three.js and its addons are vendored under `assets/structure-viewer/static/vendor/`.

## Quick start

```bash
git clone https://github.com/fanglingfei/calcgo-structure-viewer.git
cd calcgo-structure-viewer

python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r assets/structure-viewer/requirements.txt

# interactive viewer
python scripts/launch_viewer.py --port 8090 --no-browser
# open http://127.0.0.1:8090

# headless render
python scripts/render_structure.py assets/examples/simple.vasp \
  --output result/structure.html \
  --png result/structure.png
```

PNG export additionally needs Playwright:

```bash
pip install playwright
python -m playwright install chromium
```

On Windows you can double-click `assets/structure-viewer/run.bat` to launch the viewer.

## CLI reference

`render_structure.py <input> [options]`

```text
--output PATH            output HTML path
--png PATH               optional PNG output path
--full-page              capture the full page instead of the viewport
--preset studio|dark|paper|metal|figure|ball|poster
--scheme cpk|soft|mono
--mode ballstick|spacefill|stick
--show-cell / --hide-cell
--show-pbc / --hide-pbc
--show-bonds / --hide-bonds
--tolerance FLOAT        bond-length tolerance (default 1.15)
--atom-scale FLOAT
--bond-scale FLOAT
--export-scale 1|2|3
--viewport 1500x950
--view-json PATH         deep-merged partial view override
--metadata-json PATH     write render metadata
--name TEXT              structure name shown in the viewer
--cif-index INT          CIF block index (default 0)
--wait-ms INT            wait before screenshot (default 900)
```

### Defaults

`studio` preset · `ballstick` mode · CPK colors · bonds on with tolerance `1.15` · cell visible · periodic images off · automatic atom-bounding-box framing.

## Using it as an Agent Skill

Copy (or symlink) this directory into your skills folder, then ask the agent to use it:

```bash
# WorkBuddy / Claude-style user-level skills
cp -R calcgo-structure-viewer ~/.workbuddy/skills/
```

```
Use $calcgo-structure-viewer to open this POSCAR and export an offline HTML plus a PNG.
```

The skill deliberately tells the agent **not** to rebuild slab / monolayer / adsorption cells and **not** to hand-roll geometry — the model cell is authoritative, and the parser's per-element radii drive both sphere size and bond detection.

## Known limits

- Offline `view` settings do not preserve an exact camera pose, nor host-theme outline / cell colors. If you need an exact reopened angle, the current format cannot store it.
- Matching a screenshot exactly requires matching the panel aspect ratio too — CalcGO's default right dock is 420 px wide.
- `dataset-viewer/` is build source only; it needs `pnpm install && pnpm exec vite build` and targets the main CalcGO app, not this standalone viewer.

---

## 中文说明

把 CalcGO 的三维结构查看器打包成一个可移植的 **Agent Skill**：给它一个 POSCAR / CONTCAR / CIF，就能按统一视觉规范渲染、交互查看、截图，并导出**单文件离线 HTML**（约 0.8 MB，可内嵌 Three.js，发给客户双击即可旋转查看）。

核心价值是**视觉一致性**：原子半径、成键判定、CPK 配色、默认相机、主题与导出行为全部写进 `references/display-contract.md`，agent 每次都产出一致的结果，而不是临时用 matplotlib 画散点。

```bash
pip install -r assets/structure-viewer/requirements.txt

# 交互查看器
python scripts/launch_viewer.py --port 8090 --no-browser

# 无头渲染
python scripts/render_structure.py assets/examples/simple.vasp \
  --output result/structure.html --png result/structure.png
```

- 界面支持：POSCAR/CIF 上传与拖放、粘贴结构文本、多块 CIF 选择、7 种视觉预设、3 种配色方案、3 种显示模式、键长容差实时预览、元素对键过滤、坐标轴视图、截图与离线 HTML 导出。
- 依赖：`pymatgen`、`fastapi`、`uvicorn`、`python-multipart`；导出 PNG 另需 `playwright` + `chromium`。
- 无网络依赖：Three.js 与 addons 已内置在 `assets/structure-viewer/static/vendor/`。

## License

MIT — see [LICENSE](LICENSE).
