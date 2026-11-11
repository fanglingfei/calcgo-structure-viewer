---
name: calcgo-structure-viewer
description: Render, inspect, screenshot, or export CalcGO's interactive 3D crystal and molecule viewer for POSCAR, CONTCAR, and CIF structures. Use when a task needs a scientifically faithful structure image, an offline interactive HTML viewer, consistent element colors, or camera/display troubleshooting; do not use it for structure generation or electronic-structure analysis.
metadata:
  short-description: Render and export CalcGO 3D structures
---

# CalcGO Structure Viewer

Use the bundled viewer instead of recreating atom rendering with ad hoc plotting. It preserves CalcGO's atom radii, bond logic, CPK colors, default camera, themes, and offline HTML export.

## Resources

- `assets/structure-viewer/`: self-contained FastAPI + Three.js viewer.
- `assets/structure-viewer/dataset-viewer/`: optional source for the multi-type trajectory, volume, and CAE viewer; the normal POSCAR/CIF workflow uses the standalone viewer above.
- `scripts/render_structure.py`: parse one structure and export HTML, optionally PNG.
- `scripts/launch_viewer.py`: launch the interactive viewer on a local port.
- `references/display-contract.md`: exact defaults, colors, presets, embedding parameters, and display formulas. Read this when matching another CalcGO screen or changing visual settings.
- `references/camera-and-rotation.md`: detailed camera, focus, orbit, pan, zoom, and offline-view behavior. Read this for view-control questions.

## Standard workflow

1. Confirm the input structure path and whether the requested result is interactive viewing, a PNG, an offline HTML, or several of these.
2. Use `scripts/render_structure.py` for deterministic output. Do not manually reproduce the geometry or colors.
3. For an interactive request, run `scripts/launch_viewer.py --port 8090 --no-browser`, then report the actual URL printed by the server.
4. When a visual match matters, keep the default view contract unless the user explicitly requests changes.
5. Report the output paths, formula, atom count, visible bond count, color scheme, display mode, and any requested visual overrides.

Install Python dependencies once:

```powershell
python -m pip install -r <skill-root>\assets\structure-viewer\requirements.txt
```

For PNG export, also install Playwright:

```powershell
python -m pip install playwright
python -m playwright install chromium
```

## Render one structure

```powershell
python <skill-root>\scripts\render_structure.py input.vasp `
  --output result\structure.html `
  --png result\structure.png
```

Default output is:

- `studio` preset.
- `ballstick` mode.
- CPK element colors.
- bonds enabled, tolerance `1.15`.
- cell enabled.
- periodic images disabled.
- automatic atom-bounding-box framing.

Useful overrides:

```text
--preset studio|dark|paper|metal|figure|ball|poster
--scheme cpk|soft|mono
--mode ballstick|spacefill|stick
--hide-cell / --show-pbc / --hide-bonds
--atom-scale 1.0 --bond-scale 1.0
--view-json overrides.json
--viewport 1500x950
--include-ui  (keep toolbars/legend in the PNG; default is a clean 3D image)
```

`--view-json` is deep-merged over the default export view. Use it for advanced `fx` settings. The full schema and defaults are in `references/display-contract.md`.

## Interactive viewer

```powershell
python <skill-root>\scripts\launch_viewer.py --port 8090 --no-browser
```

The viewer supports POSCAR/CIF upload, CPK/soft/mono colors, seven visual presets, ball-stick/space-fill/stick modes, PBC completion, bond filtering, axis views, screenshots, and self-contained HTML export.

## Display invariants

- Treat the current model cell as authoritative. Do not conventionally rebuild slab, monolayer, or adsorption cells; doing so can remove vacuum or change surface termination.
- Use the parser's `atoms.r` values. They drive both sphere size and bond detection.
- Let the viewer compute default camera direction and distance from the structure and canvas aspect ratio.
- The default rotation focus is the atom-bounding-box center, not a clicked atom. Left drag orbits; right drag pans the focus; wheel changes distance.
- Embedded CalcGO viewers force bonds on and automatically enable periodic images when the closed cell has zero visible bonds.
- Offline `view` settings do not store exact camera pose or host-theme outline/cell colors. If the user requires an exact reopened angle, state that the current format cannot preserve it.
- Matching a screenshot requires matching the panel aspect ratio as well as the view settings. CalcGO's default right dock is 420 px wide.

## Delivery

Return clickable paths to generated artifacts. Include the exact command and exit code used for verification. If PNG creation was requested but Playwright or a browser is unavailable, deliver the HTML and mark the PNG as unverified rather than claiming success.
