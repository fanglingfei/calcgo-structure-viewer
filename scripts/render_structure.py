"""Render a POSCAR/CIF structure with the bundled CalcGO viewer."""

from __future__ import annotations

import argparse
import asyncio
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = SKILL_ROOT / "assets" / "structure-viewer"
SERVER_PATH = VIEWER_DIR / "server.py"

DEFAULT_VIEW: dict[str, Any] = {
    "preset": "studio",
    "showPbc": False,
    "showCell": True,
    "showBonds": True,
    "mode": "ballstick",
    "scheme": "cpk",
    "atomScale": 1.0,
    "bondScale": 1.0,
    "tolerance": 1.15,
    "exportScale": 1,
    "fx": {
        "quality": "std",
        "poly": "off",
        "outline": 0.35,
        "bloom": 0,
        "vignette": 0.22,
        "fog": 0,
        "envRefl": 0.45,
        "envPower": 1,
        "lightPower": 1,
        "exposure": 0.92,
        "roughness": 0.34,
        "metalness": 0.05,
        "bgMode": "grad",
        "bgTop": "#ffffff",
        "bgBottom": "#e6edf8",
    },
}


def _load_viewer_server() -> ModuleType:
    if not SERVER_PATH.is_file():
        raise FileNotFoundError(f"Bundled viewer server is missing: {SERVER_PATH}")
    spec = importlib.util.spec_from_file_location(
        "calcgo_skill_structure_viewer_server", SERVER_PATH
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load viewer server: {SERVER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _deep_update(target: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _parse_viewport(raw: str) -> tuple[int, int]:
    try:
        width_text, height_text = raw.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except Exception as exc:
        raise argparse.ArgumentTypeError(
            "viewport must use WIDTHxHEIGHT, for example 1500x950"
        ) from exc
    if width < 320 or height < 240:
        raise argparse.ArgumentTypeError("viewport must be at least 320x240")
    return width, height


def _build_view(args: argparse.Namespace) -> dict[str, Any]:
    if args.preset and args.preset != "studio":
        # The offline page applies the named preset first. Omitting the studio
        # material block lets that preset supply its own lighting values.
        view: dict[str, Any] = {"preset": args.preset}
    else:
        view = copy.deepcopy(DEFAULT_VIEW)

    if args.view_json:
        payload = json.loads(
            Path(args.view_json).read_text(encoding="utf-8-sig")
        )
        if not isinstance(payload, dict):
            raise ValueError("--view-json must contain a JSON object")
        requested_preset = str(payload.get("preset") or "")
        if requested_preset and requested_preset != "studio" and "fx" not in payload:
            view.pop("fx", None)
        _deep_update(view, payload)

    scalar_flags = {
        "show_cell": "showCell",
        "show_pbc": "showPbc",
        "show_bonds": "showBonds",
        "scheme": "scheme",
        "mode": "mode",
        "atom_scale": "atomScale",
        "bond_scale": "bondScale",
        "tolerance": "tolerance",
        "export_scale": "exportScale",
    }
    for attr, key in scalar_flags.items():
        value = getattr(args, attr, None)
        if value is not None:
            view[key] = value
    return view


async def _capture_png(
    html_path: Path,
    png_path: Path,
    viewport: tuple[int, int],
    full_page: bool,
    include_ui: bool,
    wait_ms: int,
) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError(
            "PNG export needs Playwright. Run: python -m pip install playwright "
            "and python -m playwright install chromium"
        ) from exc

    errors: list[str] = []
    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(
                headless=True, args=["--enable-unsafe-swiftshader"]
            )
        except Exception as exc:
            raise RuntimeError(
                "Chromium is unavailable. Run: python -m playwright install chromium"
            ) from exc
        page = await browser.new_page(
            viewport={"width": viewport[0], "height": viewport[1]}
        )
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on(
            "console",
            lambda msg: errors.append(f"{msg.type}: {msg.text}")
            if msg.type == "error"
            else None,
        )
        await page.goto(html_path.as_uri(), wait_until="load", timeout=30000)
        await page.wait_for_function(
            "() => document.getElementById('formula')"
            " && document.getElementById('formula').textContent !== '—'"
            " && state && state.viewer"
            " && document.querySelector('#viewer canvas:not(.axis-gizmo)')",
            timeout=30000,
        )
        await page.wait_for_timeout(wait_ms)
        if not include_ui:
            await page.add_style_tag(
                content="""
                  #toast, .toast, .v-tools, #legend, #vQuick, #hoverTip,
                  .hover-tip, #viewerMeta, #headTip {
                    display: none !important;
                  }
                """
            )
        state = await page.evaluate(
            """() => ({
              formula: document.getElementById('formula').textContent,
              atoms: document.getElementById('nAtoms').textContent,
              bonds: document.getElementById('bondCount').textContent,
              scheme: state.scheme,
              mode: state.mode,
              preset: state.preset,
              showPbc: state.showPbc,
              view: state.viewer.getView(),
              canvas: (() => {
                const canvas = document.querySelector(
                  '#viewer canvas:not(.axis-gizmo)'
                );
                return canvas ? {width: canvas.width, height: canvas.height} : null;
              })()
            })"""
        )
        png_path.parent.mkdir(parents=True, exist_ok=True)
        if full_page:
            await page.screenshot(path=str(png_path), full_page=True)
        else:
            await page.locator("#viewer").screenshot(path=str(png_path))
        await browser.close()
    state["page_errors"] = errors
    return state


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="Render a structure with the bundled CalcGO 3D viewer."
    )
    parser.add_argument("input", type=Path, help="POSCAR/CONTCAR/CIF input file")
    parser.add_argument("--output", type=Path, help="output HTML path")
    parser.add_argument("--png", type=Path, help="optional PNG output path")
    parser.add_argument("--full-page", action="store_true", help="capture full page")
    parser.add_argument(
        "--include-ui",
        action="store_true",
        help="keep viewer toolbars, legend, and toast in the PNG",
    )
    parser.add_argument("--metadata-json", type=Path, help="write render metadata JSON")
    parser.add_argument("--name", help="structure name shown in the viewer")
    parser.add_argument("--cif-index", type=int, default=0, help="CIF block index")
    parser.add_argument("--view-json", type=Path, help="partial view override JSON")
    parser.add_argument(
        "--preset",
        choices=["studio", "dark", "paper", "metal", "figure", "ball", "poster"],
    )
    parser.add_argument("--scheme", choices=["cpk", "soft", "mono"])
    parser.add_argument("--mode", choices=["ballstick", "spacefill", "stick"])
    parser.add_argument("--show-cell", dest="show_cell", action="store_true", default=None)
    parser.add_argument("--hide-cell", dest="show_cell", action="store_false")
    parser.add_argument("--show-pbc", dest="show_pbc", action="store_true", default=None)
    parser.add_argument("--hide-pbc", dest="show_pbc", action="store_false")
    parser.add_argument("--show-bonds", dest="show_bonds", action="store_true", default=None)
    parser.add_argument("--hide-bonds", dest="show_bonds", action="store_false")
    parser.add_argument("--atom-scale", type=float)
    parser.add_argument("--bond-scale", type=float)
    parser.add_argument("--tolerance", type=float)
    parser.add_argument("--export-scale", type=int, choices=[1, 2, 3])
    parser.add_argument("--viewport", type=_parse_viewport, default=(1500, 950))
    parser.add_argument("--wait-ms", type=int, default=900)
    args = parser.parse_args()

    source = args.input.expanduser().resolve()
    if not source.is_file():
        parser.error(f"input file does not exist: {source}")
    output = (
        args.output.expanduser().resolve()
        if args.output
        else source.with_suffix(".viewer.html")
    )
    png = args.png.expanduser().resolve() if args.png else None
    name = args.name or source.name

    try:
        server = _load_viewer_server()
        content = source.read_bytes()
        if len(content) > int(server.MAX_FILE_BYTES):
            raise ValueError(
                f"input exceeds viewer limit of "
                f"{server.MAX_FILE_BYTES // (1024 * 1024)} MB"
            )
        structure, blocks, n_blocks = server.parse_structure(
            content, source.name, args.cif_index
        )
        if len(structure) > int(server.MAX_ATOMS):
            raise ValueError(
                f"structure has {len(structure)} atoms; viewer limit is "
                f"{server.MAX_ATOMS}"
            )
        data = {
            "name": name,
            **server.viewer_json(structure, blocks, n_blocks),
        }
        view = _build_view(args)
        html = server._build_offline_html(data, name, view=view)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(html, encoding="utf-8")

        metadata: dict[str, Any] = {
            "input": str(source),
            "html": str(output),
            "formula": data.get("formula"),
            "reduced_formula": data.get("reduced_formula"),
            "n_atoms": data.get("n_atoms"),
            "n_bonds": len((data.get("segments") or {}).get("i", [])),
            "blocks": data.get("n_blocks"),
            "view": view,
        }
        if png:
            runtime = asyncio.run(
                _capture_png(
                    output,
                    png,
                    args.viewport,
                    args.full_page,
                    args.include_ui,
                    max(0, args.wait_ms),
                )
            )
            metadata["png"] = str(png)
            metadata["runtime"] = runtime
            if runtime.get("page_errors"):
                raise RuntimeError(
                    "viewer reported page errors: "
                    + "; ".join(map(str, runtime["page_errors"]))
                )

        if args.metadata_json:
            meta_path = args.metadata_json.expanduser().resolve()
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
