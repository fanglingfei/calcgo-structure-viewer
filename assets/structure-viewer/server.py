"""3D 结构查看器 · 独立解析服务

用法：
    python server.py [--port 8090] [--host 127.0.0.1] [--no-browser]

提供：
    POST /api/parse   上传 POSCAR/CIF（multipart file，可选 index），
                      返回原子坐标 + 预计算的周期键候选段
    GET  /            前端页面

说明：
    - 键的“最终呈现”由前端负责：本服务只解析一次并下发候选段，
      键长容差、元素对过滤、样式等均在浏览器内实时完成。
    - 候选段按“几何去重”后下发：同一条空间线段只出现一次，
      同时保留同一对位点通过不同周期镜像形成的多条真实键。
"""

from __future__ import annotations

import io
import json
import math
import re
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pymatgen.core import Element, Structure
from pymatgen.io.cif import CifParser

STATIC_DIR = Path(__file__).resolve().parent / "static"

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_ATOMS = 15000
MAX_SEGMENTS = 500_000

app = FastAPI(title="3D 结构查看器")


# ---------------------------------------------------------------------------
# 原子半径（优先共价半径，缺失回退原子半径）
#
# **半径覆盖表**：这版 pymatgen 没有 covalent_radius（只有 atomic_radius），而 H 的原子半径
# （0.25 Å）明显小于它"半个键长"（H₂ 0.74 Å → 0.37 Å）。用它判键会漏掉 H–H：
# 0.7506 > (0.25+0.25)×1.15 = 0.575 → 报告里的 H₂ 参考分子成了两颗**孤球**
# （2026-10-15 客户指着报告图问"为啥有的原子没有正常的成键"）。
# 只覆盖 H 就够：O/C/N/Si/Fe/Au 用原子半径判键都正常——
# O–H 0.96 < (0.60+0.37)×1.15 = 1.12 ✓；Si–O 1.81 < (1.10+0.60)×1.15 = 1.96 ✓；
# Au–Au 2.88 < 3.13 ✓ 而第二壳层 4.08 不会被连上 ✓；
# Si–Si 在斯石英里 2.667 Å（不是键，是八面体共棱）> (1.10+1.10)×1.15 = 2.53 ✓ 不会被连上。
# ---------------------------------------------------------------------------
_RADIUS_OVERRIDE = {"H": 0.37}


def _radius(symbol: str) -> float:
    if symbol in _RADIUS_OVERRIDE:
        return float(_RADIUS_OVERRIDE[symbol])
    try:
        el = Element(symbol)
    except Exception:
        return 1.0
    r = getattr(el, "covalent_radius", None)
    if r is None or (isinstance(r, float) and math.isnan(r)):
        r = getattr(el, "atomic_radius", None)
    if r is None or (isinstance(r, float) and math.isnan(r)):
        r = 1.0
    return float(r)


def _element_symbol(site) -> str:
    """取位点的元素符号；对混合占位位点退回首个元素。"""
    try:
        ss = str(site.species_string)
        if ss and all(ch.isalpha() for ch in ss):
            return ss
    except Exception:
        pass
    try:
        els = site.species.elements
        if els:
            return str(els[0].symbol)
    except Exception:
        pass
    return "X"


# ---------------------------------------------------------------------------
# 结构解析
# ---------------------------------------------------------------------------


def parse_structure(
    content: bytes, filename: str = "", index: int = 0
) -> tuple[Structure, list[dict], int]:
    """返回 (选中的结构, 全部 data block 摘要, block 数量)。"""
    text = content.decode("utf-8", errors="replace")
    stripped = text.lstrip()
    is_cif = filename.lower().endswith(".cif") or stripped.startswith(
        ("data_", "loop_", "_cell_")
    )
    try:
        if is_cif:
            if hasattr(CifParser, "from_str"):
                parser = CifParser.from_str(text)
            else:  # 兼容旧版 pymatgen
                parser = CifParser(io.StringIO(text))
            structures = parser.parse_structures(primitive=False)
            if not structures:
                raise ValueError("CIF 中未解析到结构")
            if index < 0 or index >= len(structures):
                raise ValueError(
                    f"CIF 包含 {len(structures)} 个结构，所选序号 {index + 1} 超出范围"
                )
            blocks = [
                {
                    "formula": st.composition.formula,
                    "reduced": st.composition.reduced_formula,
                    "n_atoms": len(st),
                }
                for st in structures
            ]
            return structures[index], blocks, len(structures)
        return Structure.from_str(text, fmt="poscar"), [], 1
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"结构解析失败:{e}") from e


# ---------------------------------------------------------------------------
# 周期键候选段（一次算好，浏览器端按容差实时过滤）
# ---------------------------------------------------------------------------


# 判键的**加性余量**（Å）。浏览器端用的是同一份口径（app.js 里的同一个数），
# 两边必须一致，否则就成了"服务端给了候选、前端又筛掉"。
#
# 为什么需要它（2026-10-15 实测）：这版 pymatgen **没有** covalent_radius 属性
# （只有 atomic_radius，H = 0.25 Å），于是判键用的是原子半径。氢分子 H–H = 0.7506 Å，
# 而 (0.25+0.25)×1.15 = 0.575 → **一根键都判不出来**，报告里的 H₂ 参考分子就是两颗孤球；
# 加 0.30 Å 余量后 0.875 > 0.7506 ✓。金属不会因此糊：Au–Au 3.13+0.3 = 3.43，
# 离第二壳层 4.08 Å 还远；Cu 3.13+0.3 = 3.43 < 3.61；Fe 3.34 < 3.51。
BOND_SLACK = 0.30


def compute_segments(
    structure: Structure, tol_max: float = 1.4
) -> dict[str, list]:
    """返回按空间线段去重后的候选键段。

    每个键段为紧凑数组字段：
        i / j      线段两端位点序号（j 一端可能是周期镜像）
        d          镜像距离
        dx/dy/dz   从位点 i 指向该镜像的笛卡尔位移
    浏览器端再做：容差过滤、元素对过滤、PBC 镜像球补齐。
    """
    symbols = [_element_symbol(site) for site in structure]
    radii = [_radius(sym) for sym in symbols]
    rmax = max(radii) if radii else 1.0
    cutoff = 2 * rmax * tol_max + BOND_SLACK + 1e-9

    segments: dict[str, list] = {
        "i": [],
        "j": [],
        "d": [],
        "dx": [],
        "dy": [],
        "dz": [],
    }
    seen: set = set()

    neighbor_lists = structure.get_all_neighbors(cutoff, include_index=True)
    for i, site in enumerate(structure):
        xi, yi, zi = (float(v) for v in site.coords)
        ri = radii[i]
        for nb in neighbor_lists[i]:
            j = int(getattr(nb, "index", i))
            d = float(getattr(nb, "nn_distance", 0.0))
            if d > (ri + radii[j]) * tol_max + BOND_SLACK + 1e-9:
                continue
            px, py, pz = (float(v) for v in nb.coords)
            # 同一条空间线段（两端都在胞内时双向各出现一次）只保留一条
            ka = (round(xi, 4), round(yi, 4), round(zi, 4))
            kb = (round(px, 4), round(py, 4), round(pz, 4))
            if ka > kb:
                ka, kb = kb, ka
            key = (ka, kb)
            if key in seen:
                continue
            seen.add(key)
            segments["i"].append(i)
            segments["j"].append(j)
            segments["d"].append(round(d, 4))
            segments["dx"].append(round(px - xi, 6))
            segments["dy"].append(round(py - yi, 6))
            segments["dz"].append(round(pz - zi, 6))
            if len(segments["i"]) > MAX_SEGMENTS:
                raise ValueError(
                    f"键候选段超过 {MAX_SEGMENTS} 条，结构过大；请改用较小的超胞"
                )
    return segments


def viewer_json(structure: Structure, blocks: list[dict], n_blocks: int) -> dict:
    atoms = {"el": [], "x": [], "y": [], "z": [], "r": []}
    for site in structure:
        sym = _element_symbol(site)
        atoms["el"].append(sym)
        atoms["x"].append(round(float(site.coords[0]), 6))
        atoms["y"].append(round(float(site.coords[1]), 6))
        atoms["z"].append(round(float(site.coords[2]), 6))
        atoms["r"].append(round(_radius(sym), 4))

    return {
        "atoms": atoms,
        "cell": structure.lattice.matrix.tolist(),
        "formula": structure.composition.formula,
        "reduced_formula": structure.composition.reduced_formula,
        "n_atoms": len(structure),
        "volume": round(float(structure.volume), 3),
        "density": round(float(structure.density), 4),
        "segments": compute_segments(structure),
        "blocks": blocks,
        "n_blocks": n_blocks,
    }


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@app.post("/api/parse")
def parse_file(file: UploadFile = File(...), index: int = Form(0)):
    try:
        # 同步端点内直接读底层文件对象，避免把 CPU 密集的解析留在事件循环
        content = file.file.read(MAX_FILE_BYTES + 1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"读取文件失败:{e}") from e
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)} MB，请拆分后上传",
        )
    try:
        structure, blocks, n_blocks = parse_structure(
            content, file.filename or "", index
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if len(structure) > MAX_ATOMS:
        raise HTTPException(
            status_code=413,
            detail=f"原子数 {len(structure)} 超过浏览器查看上限 {MAX_ATOMS}，请改用较小的超胞",
        )
    try:
        data = viewer_json(structure, blocks, n_blocks)
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"成键计算失败:{e}") from e
    return {"name": file.filename or "structure", **data}


# ---------------------------------------------------------------------------
# 离线 HTML 导出（单文件内嵌 3Dmol/样式/数据，客户双击即可查看）
# ---------------------------------------------------------------------------


def _safe_download_name(name: str) -> str:
    base = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name).strip() or "structure"
    return base[:80]


def _inline_script(text: str) -> str:
    """内嵌 <script> 时避免出现会提前闭合标签的字符串。"""
    return re.sub(r"</script", r"<\\/script", text, flags=re.IGNORECASE)


def _build_offline_html(data: dict, name: str, view: dict | None = None,
                        frames: list[dict] | None = None) -> str:
    index = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    css = (STATIC_DIR / "style.css").read_text(encoding="utf-8")
    appjs = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    config = json.dumps(
        {
            "offline": True,
            "name": name or "structure",
            "data": data,
            "frames": frames or None,
            "view": view if isinstance(view, dict) else None,
        },
        ensure_ascii=False,
    ).replace("</", r"<\/")

    html = index.replace(
        '<link rel="stylesheet" href="/static/style.css" />',
        "<style>\n" + css + "\n</style>",
    )
    # 渲染引擎（three.js + 本地 addons + viewer3d.js）全部内嵌，保证离线单文件可用
    for rel in (
        "vendor/three.min.js",
        "vendor/three-addons/math/ConvexHull.js",
        "vendor/three-addons/geometries/ConvexGeometry.js",
        "vendor/three-addons/environments/RoomEnvironment.js",
        "vendor/three-addons/shaders/CopyShader.js",
        "vendor/three-addons/shaders/LuminosityHighPassShader.js",
        "vendor/three-addons/postprocessing/EffectComposer.js",
        "vendor/three-addons/postprocessing/MaskPass.js",
        "vendor/three-addons/postprocessing/RenderPass.js",
        "vendor/three-addons/postprocessing/ShaderPass.js",
        "vendor/three-addons/postprocessing/UnrealBloomPass.js",
        "viewer3d.js",
    ):
        code = (STATIC_DIR / rel).read_text(encoding="utf-8")
        html = html.replace(
            f'<script src="/static/{rel}"></script>',
            "<script>\n" + _inline_script(code) + "\n</script>",
        )
    html = html.replace(
        '<script src="/static/app.js"></script>',
        "<script>\nwindow.__EXPORT__ = " + config + ";\n</script>\n"
        + "<script>\n" + _inline_script(appjs) + "\n</script>",
    )
    return html


@app.post("/api/export")
def export_offline_html(payload: dict = Body(...)):
    data = payload.get("data")
    if not isinstance(data, dict) or "atoms" not in data:
        raise HTTPException(status_code=400, detail="缺少可导出的结构数据，请先加载结构")
    name = str(payload.get("name") or data.get("name") or "structure")
    try:
        html = _build_offline_html(data, name, payload.get("view"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导出失败:{e}") from e
    base = _safe_download_name(name) + ".html"
    disposition = f"attachment; filename={quote(base)}; filename*=UTF-8''{quote(base)}"
    return HTMLResponse(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": disposition},
    )


@app.post("/api/export_trajectory")
def export_trajectory_html(payload: dict = Body(...)):
    """把逐图像结构（NEB / MD）导出成带播放器的单文件 HTML。

    body: {"name": "...", "frames": [{"label": "00", "energy": 0.0, "poscar": "..."}]}
    能量只用于显示相对能量，不参与任何计算；缺能量的帧标成 "—"。
    """
    raw = payload.get("frames")
    if not isinstance(raw, list) or len(raw) < 2:
        raise HTTPException(status_code=400, detail="至少需要 2 帧结构才能做路径回放")
    frames: list[dict] = []
    first_data: dict | None = None
    name = str(payload.get("name") or "反应路径")
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        text = str(item.get("poscar") or "")
        label = str(item.get("label") or f"{i:02d}")
        if not text.strip():
            continue
        try:
            structure, _blocks, _n = parse_structure(text.encode("utf-8"), f"{label}.vasp")
            data = viewer_json(structure, [], 1)
        except Exception as exc:
            raise HTTPException(status_code=400,
                                detail=f"第 {i + 1} 帧（{label}）解析失败：{exc}") from exc
        data["name"] = f"{name} · {label}"
        first_data = first_data or data
        energy = item.get("energy")
        try:
            energy = None if energy is None else float(energy)
        except Exception:
            energy = None
        frames.append({"label": label, "energy": energy, "data": data})
    if first_data is None or len(frames) < 2:
        raise HTTPException(status_code=400, detail="没有可用的结构帧")
    html = _build_offline_html(first_data, name, frames=frames)
    base = _safe_download_name(name) + "-trajectory.html"
    disposition = f"attachment; filename={quote(base)}; filename*=UTF-8''{quote(base)}"
    return HTMLResponse(content=html, media_type="text/html; charset=utf-8",
                        headers={"Content-Disposition": disposition})


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# 启动入口：端口回退 + 自动打开浏览器
# ---------------------------------------------------------------------------


def _free_port(start: int) -> int:
    import socket

    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"端口 {start}~{start + 19} 均被占用")


if __name__ == "__main__":
    args = sys.argv[1:]
    host = "127.0.0.1"
    port = 8090
    open_browser = True
    i = 0
    while i < len(args):
        if args[i] == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        elif args[i] == "--host" and i + 1 < len(args):
            host = args[i + 1]
            i += 2
        elif args[i] == "--no-browser":
            open_browser = False
            i += 1
        else:
            i += 1

    try:
        port = _free_port(port)
    except RuntimeError as e:
        print(f"[3D 结构查看器] {e}")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"
    print("=" * 46)
    print("  3D 结构查看器启动中...")
    print(f"  请在浏览器打开  {url}")
    print("  关闭本窗口即停止服务")
    print("=" * 46)

    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=host, port=port)
