"""3D 结构查看器 · Playwright 冒烟/回归测试

用法：
    1) 先启动服务：python server.py            （默认 8090 端口）
    2) 再运行本测试：python test_ui.py

覆盖：样例加载、容差实时变化、风格切换不重建画布、只看键筛选、
PBC 开关、多结构 CIF 切换、页面无横向溢出。
"""

import asyncio
import io
import os
import struct
import sys
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright
from PIL import Image, ImageStat

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.environ.get("SV_URL", "http://127.0.0.1:8090")


async def main() -> int:
    errors: list[str] = []
    failures: list[str] = []

    def check(name: str, ok: bool, extra: str = "") -> None:
        print(("PASS  " if ok else "FAIL  ") + name + (f"  |  {extra}" if extra else ""))
        if not ok:
            failures.append(name)

    async with async_playwright() as p:
        # three.js 需要 WebGL；软件光栅化保证无显卡环境也能跑
        browser = await p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader"])
        context = await browser.new_context(accept_downloads=True, viewport={"width": 1500, "height": 950})
        page = await context.new_page()
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text[:300]}"))
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        page.on("response", lambda r: errors.append(f"[http {r.status}] {r.url}") if r.status >= 400 else None)

        await page.goto(BASE + "/", timeout=20000, wait_until="networkidle")
        await page.wait_for_timeout(800)

        # 1) 金刚石 Si 样例
        await page.click("button[data-sample='si']")
        await page.wait_for_function(
            "() => document.getElementById('formula').textContent === 'Si' "
            "&& document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length === 1",
            timeout=30000,
        )
        await page.wait_for_timeout(350)
        formula = await page.evaluate("document.getElementById('formula').textContent")
        canvas = await page.evaluate(
            "document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length"
        )
        chips = await page.evaluate(
            "Array.from(document.querySelectorAll('#pairChips .chip')).map(c => c.textContent).join(',')"
        )
        check("样例加载", formula == "Si" and chips == "Si-Si", f"formula={formula} chips={chips}")
        check("画布只创建一次", canvas == 1, f"canvas={canvas}")
        axis = await page.evaluate(
            """
            () => {
              const viewer = document.getElementById('viewer');
              const gizmo = document.querySelector('#viewer .axis-gizmo');
              const vr = viewer.getBoundingClientRect();
              const gr = gizmo ? gizmo.getBoundingClientRect() : null;
              return {
                exists: !!gizmo,
                aria: gizmo ? gizmo.getAttribute('aria-label') : '',
                left: gr ? Math.round(gr.left - vr.left) : -1,
                bottom: gr ? Math.round(vr.bottom - gr.bottom) : -1,
                before: gizmo ? gizmo.toDataURL() : '',
              };
            }
            """
        )
        check(
            "XYZ 坐标轴位于左下角",
            axis["exists"]
            and axis["aria"] == "世界坐标轴 X Y Z"
            and axis["left"] <= 18
            and axis["bottom"] <= 18,
            f"left={axis['left']} bottom={axis['bottom']} aria={axis['aria']}",
        )
        await page.click("#viewSeg button[data-view='+c']")
        await page.wait_for_timeout(350)
        axis_after = await page.evaluate(
            "document.querySelector('#viewer .axis-gizmo').toDataURL()"
        )
        check("坐标轴随视角旋转", axis_after != axis["before"])
        await page.click("#viewSeg button[data-view='reset']")
        await page.wait_for_timeout(350)
        # 1.1) 未手动操作时，视口缩窄必须重新适配相机距离；否则只更新 aspect，
        # 水平 FOV 变窄后左右边缘会被裁掉。
        view_before = await page.evaluate("() => state.viewer.getView()")
        dist_before = sum((a - b) ** 2 for a, b in zip(
            view_before["position"], view_before["target"])) ** 0.5
        # 720 宽时画布仍由竖直 FOV 限制，相机距离本来就不必变化；用 480 宽
        # 制造真实窄横比，才能验证“宽度变窄 → 相机后退”。
        await page.set_viewport_size({"width": 480, "height": 950})
        await page.wait_for_timeout(550)
        view_after = await page.evaluate("() => state.viewer.getView()")
        dist_after = sum((a - b) ** 2 for a, b in zip(
            view_after["position"], view_after["target"])) ** 0.5
        check("缩窄视口自动重新取景", dist_after > dist_before * 1.02,
              f"distance {dist_before:.2f} -> {dist_after:.2f}")
        await page.set_viewport_size({"width": 1500, "height": 950})
        await page.wait_for_timeout(450)

        # 鼠标轨道轴必须跟屏幕坐标一致：横拖绕屏幕上方，竖拖绕屏幕右方。
        canvas_box = await page.locator("#viewer canvas:not(.axis-gizmo)").bounding_box()
        assert canvas_box is not None
        cx = canvas_box["x"] + canvas_box["width"] / 2
        cy = canvas_box["y"] + canvas_box["height"] / 2
        await page.click("#viewSeg button[data-view='reset']")
        await page.wait_for_timeout(300)
        canvas_locator = page.locator("#viewer canvas:not(.axis-gizmo)")
        bg_before = Image.open(io.BytesIO(await canvas_locator.screenshot())).convert("RGB")
        await page.evaluate("window.__dragBefore = state.viewer.getView()")
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx + 90, cy, steps=4)
        await page.wait_for_timeout(180)
        bg_during = Image.open(io.BytesIO(await canvas_locator.screenshot())).convert("RGB")
        drag_quality = await page.evaluate("() => state.viewer.getRenderStats()")
        check(
            "拖动中保持完整画质",
            drag_quality["pixel_ratio"] >= 1
            and drag_quality["antialias_samples"] >= 4
            and drag_quality["outline_visible"]
            and drag_quality["bonds_visible"]
            and drag_quality["cell_visible"],
            f"pixel_ratio={drag_quality['pixel_ratio']} "
            f"samples={drag_quality['antialias_samples']} "
            f"outline={drag_quality['outline_visible']} "
            f"bonds={drag_quality['bonds_visible']} "
            f"cell={drag_quality['cell_visible']}",
        )
        await page.mouse.up()
        await page.wait_for_timeout(250)
        bg_after = Image.open(io.BytesIO(await canvas_locator.screenshot())).convert("RGB")
        patch = (8, 8, 56, 56)
        mean_before = ImageStat.Stat(bg_before.crop(patch)).mean
        mean_during = ImageStat.Stat(bg_during.crop(patch)).mean
        mean_after = ImageStat.Stat(bg_after.crop(patch)).mean
        bg_delta = max(
            max(abs(a - b) for a, b in zip(mean_before, mean_during)),
            max(abs(a - b) for a, b in zip(mean_before, mean_after)),
        )
        check("拖动中与松手后背景颜色一致", bg_delta < 3.0, f"ΔRGB={bg_delta:.2f}")
        horizontal_axis = await page.evaluate(
            """
            () => {
              const a = window.__dragBefore, b = state.viewer.getView();
              const oa = a.position.map((v, i) => v - a.target[i]);
              const ob = b.position.map((v, i) => v - b.target[i]);
              const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
              const len = Math.hypot(...oa);
              return Math.abs(dot(oa, a.up) - dot(ob, a.up)) / len;
            }
            """
        )
        check("横向拖动保持屏幕上方轴不变", horizontal_axis < 0.02,
              f"screenUp漂移={horizontal_axis:.4f}")
        await page.click("#viewSeg button[data-view='reset']")
        await page.wait_for_timeout(300)
        await page.evaluate("window.__dragBefore = state.viewer.getView()")
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx, cy - 85, steps=4)
        await page.mouse.up()
        await page.wait_for_timeout(250)
        vertical_axis = await page.evaluate(
            """
            () => {
              const a = window.__dragBefore, b = state.viewer.getView();
              const oa = a.position.map((v, i) => v - a.target[i]);
              const cross = [
                a.up[1] * b.up[2] - a.up[2] * b.up[1],
                a.up[2] * b.up[0] - a.up[0] * b.up[2],
                a.up[0] * b.up[1] - a.up[1] * b.up[0],
              ];
              const f = oa.map(v => -v);
              const right = [
                f[1] * a.up[2] - f[2] * a.up[1],
                f[2] * a.up[0] - f[0] * a.up[2],
                f[0] * a.up[1] - f[1] * a.up[0],
              ];
              const mag = Math.hypot(...cross), rm = Math.hypot(...right);
              const u = mag ? cross.map(v => v / mag) : [0, 0, 0];
              const r = rm ? right.map(v => v / rm) : [0, 0, 0];
              return Math.abs(u.reduce((s, v, i) => s + v * r[i], 0));
            }
            """
        )
        check("纵向拖动绕屏幕右方轴旋转", vertical_axis > 0.98,
              f"axis·screenRight={vertical_axis:.4f}")
        await page.click("#viewSeg button[data-view='reset']")
        await page.wait_for_timeout(300)

        # 1.5) 导出离线 HTML 并本地打开验证
        # 先改一下显示设置，验证“导出会带上当前风格与视角”
        await page.click("button[data-preset='dark']")
        await page.evaluate("document.getElementById('pbcToggle').click()")
        await page.wait_for_timeout(700)
        tmp_html = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
        tmp_html.close()
        async with page.expect_download(timeout=20000) as dl:
            await page.click("#btnExportOffline")
        download = await dl.value
        await download.save_as(tmp_html.name)
        off_page = await context.new_page()
        off_errors: list[str] = []
        off_page.on("pageerror", lambda e: off_errors.append(str(e)))
        await off_page.goto("file:///" + tmp_html.name.replace("\\", "/"), wait_until="load")
        await off_page.wait_for_timeout(2400)
        await off_page.evaluate(
            """
            () => {
              const s = document.getElementById('fxOutline');
              s.value = '0.6';
              s.dispatchEvent(new Event('input', { bubbles: true }));
            }
            """
        )
        await off_page.wait_for_timeout(400)
        off_info = await off_page.evaluate(
            """
            () => ({
              formula: document.getElementById('formula').textContent,
              canvas: document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length,
              hiddenLoadCard: document.getElementById('cardLoad').classList.contains('hidden'),
              theme: document.body.dataset.theme,
              pbc: state.showPbc,
            })
            """
        )
        check(
            "离线 HTML 本地可查看并保留显示设置",
            off_info["formula"] == "Si"
            and off_info["canvas"] == 1
            and off_info["hiddenLoadCard"]
            and off_info["theme"] == "dark"
            # 离线页应**保留导出时的显示设置**（上面刚把周期镜像打开）
            and off_info["pbc"] is True
            and len([e for e in off_errors if "ReadPixels" not in e]) == 0,
            f"{off_info}",
        )
        await off_page.close()
        os.unlink(tmp_html.name)
        await page.click("button[data-preset='studio']")
        await page.evaluate("document.getElementById('pbcToggle').click()")
        await page.wait_for_timeout(1200)

        # 2) 容差实时变化（1.0 时 Si 键消失，≥1.13 恢复）
        counts = []
        for val in ["1.0", "1.2"]:
            await page.evaluate(
                "(v) => { const t = document.getElementById('tolerance'); t.value = v; t.dispatchEvent(new Event('input', {bubbles:true})); }",
                val,
            )
            await page.wait_for_timeout(800)
            counts.append(await page.evaluate("document.getElementById('bondCount').textContent"))
        check("容差实时预览", counts[0].startswith("0 条") and counts[1] != counts[0], " / ".join(counts))

        # 3) 旋转相机 + 换主题/模式：画布仍只有 1 个，页面无错误
        vp = page.viewport_size
        await page.mouse.move(vp["width"] * 0.62, vp["height"] * 0.55)
        await page.mouse.down()
        for _ in range(5):
            await page.mouse.move(vp["width"] * 0.62 + 25, vp["height"] * 0.55 - 10, steps=2)
            await page.wait_for_timeout(25)
        await page.mouse.up()
        await page.click("button[data-preset='dark']")
        await page.click("button[data-mode-value='spacefill']")
        await page.select_option("#schemeSel", "soft")
        await page.wait_for_timeout(700)
        canvas2 = await page.evaluate(
            "document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length"
        )
        theme = await page.evaluate("document.body.dataset.theme")
        check("风格切换后画布不重建", canvas2 == 1 and theme == "dark", f"canvas={canvas2} theme={theme}")

        # 4) ZrO2 + 只看键筛选
        await page.click("button[data-sample='zro2']")
        await page.wait_for_timeout(1800)
        await page.click("button[data-preset='studio']")
        await page.click("button[data-mode-value='ballstick']")
        await page.select_option("#schemeSel", "cpk")
        zr_chips = await page.evaluate(
            "Array.from(document.querySelectorAll('#pairChips .chip')).map(c => c.textContent).join(',')"
        )
        bond_all = await page.evaluate("document.getElementById('bondCount').textContent")
        ok = await page.evaluate(
            """
            () => {
              const c = Array.from(document.querySelectorAll('#pairChips .chip')).find(x => x.textContent === 'Zr-O');
              if (c) { c.click(); return true; }
              return false;
            }
            """
        )
        await page.wait_for_timeout(500)
        bond_tag = await page.evaluate("document.getElementById('bondCount').textContent")
        check(
            "只看键筛选",
            ok and "条键" in bond_tag and not bond_tag.startswith("0 条键") and bond_tag != bond_all,
            f"chips={zr_chips} {bond_all} -> {bond_tag}",
        )

        # 5) PBC 开关
        await page.evaluate("document.getElementById('pbcToggle').click()")
        await page.wait_for_timeout(400)
        await page.evaluate("document.getElementById('pbcToggle').click()")
        await page.wait_for_timeout(400)
        canvas3 = await page.evaluate(
            "document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length"
        )
        check("PBC 开关不重建画布", canvas3 == 1)

        # 6) PBC 关：晶胞内原子全部保留（含边界原子）；晶胞框开关不影响成键
        await page.evaluate("document.getElementById('pbcToggle').click()")  # 关
        await page.wait_for_timeout(600)
        atom_meta = await page.evaluate(
            """
            () => {
              const d = state.data;
              const shown = state.basePts.concat(state.ghostPts);
              let found = 0;
              for (let i = 0; i < d.n_atoms; i++) {
                const hit = shown.some(
                  (a) => a.i === i
                    && Math.abs(a.x - d.atoms.x[i]) < 0.01
                    && Math.abs(a.y - d.atoms.y[i]) < 0.01
                    && Math.abs(a.z - d.atoms.z[i]) < 0.01
                );
                if (hit) found++;
              }
              return { shownAtoms: shown.length, baseAtoms: d.n_atoms, foundBase: found };
            }
            """
        )
        bond_before = await page.evaluate("document.getElementById('bondCount').textContent")
        await page.evaluate("document.getElementById('cellToggle').click()")  # 关晶胞框
        await page.wait_for_timeout(500)
        bond_after = await page.evaluate("document.getElementById('bondCount').textContent")
        check(
            "PBC 关后原子不丢失、晶胞开关不影响成键",
            atom_meta["foundBase"] == atom_meta["baseAtoms"]
            and atom_meta["shownAtoms"] >= atom_meta["baseAtoms"]
            and bond_before == bond_after,
            f"atoms={atom_meta} bonds {bond_before} -> {bond_after}",
        )

        # 7) VESTA 式视角预设
        for view_key in ["+a", "-c", "reset"]:
            await page.click(f"#viewSeg button[data-view='{view_key}']")
            await page.wait_for_timeout(250)
        canvas4 = await page.evaluate(
            "document.querySelectorAll('#viewer canvas:not(.axis-gizmo)').length"
        )
        check("视角预设可用", canvas4 == 1)

        # 8) 高清导出 + 描边光影（用滑块控制）
        await page.click("#exportScaleSeg button[data-scale='3']")
        await page.evaluate(
            """
            () => {
              const s = document.getElementById('fxOutline');
              s.value = '0.7';
              s.dispatchEvent(new Event('input', { bubbles: true }));
            }
            """
        )
        png_path = os.path.join(tempfile.gettempdir(), "export_check.png")
        async with page.expect_download(timeout=20000) as dl:
            await page.click("#btnExportPng")
        png_download = await dl.value
        await png_download.save_as(png_path)
        with open(png_path, "rb") as f:
            head = f.read(26)
        png_w, png_h = struct.unpack(">II", head[16:24])
        os.unlink(png_path)
        check("高清导出与描边无报错", png_w > 2000 and png_h > 1500, f"png={png_w}x{png_h}")
        await page.click("#exportScaleSeg button[data-scale='1']")

        # 9) 多结构 CIF
        tmp = tempfile.NamedTemporaryFile("w", suffix=".cif", delete=False, encoding="utf-8")
        tmp.write(
            """data_si
_cell_length_a 5.43
_cell_length_b 5.43
_cell_length_c 5.43
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P1'
loop_
_space_group_symop_operation_xyz
'x, y, z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Si1 Si 0.0 0.0 0.0
Si2 Si 0.5 0.5 0.0

data_water
_cell_length_a 8.0
_cell_length_b 8.0
_cell_length_c 8.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P1'
loop_
_space_group_symop_operation_xyz
'x, y, z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
O1 O 0.5 0.5 0.5
H1 H 0.557 0.555 0.5
H2 H 0.443 0.555 0.5
"""
        )
        tmp.close()
        try:
            await page.set_input_files("#fileInput", tmp.name)
            await page.wait_for_function(
                "() => document.querySelectorAll('#cifSelect option').length === 2",
                timeout=30000,
            )
            n_opts = await page.evaluate("document.querySelectorAll('#cifSelect option').length")
            await page.select_option("#cifSelect", "1")
            await page.wait_for_function(
                "() => document.getElementById('formula').textContent === 'H₂O'",
                timeout=30000,
            )
            formula2 = await page.evaluate("document.getElementById('formula').textContent")
            check("多结构 CIF 切换", n_opts == 2 and formula2 == "H₂O", f"options={n_opts} formula={formula2}")
        finally:
            os.unlink(tmp.name)

        # 10) 多元素颜色：图例与实际 3D 材质共用 schemeColor，常见过渡金属不得
        # 再落到同一个兜底灰色。固定截图留作前端真实入口证据。
        mixed = Path(__file__).resolve().parents[1] / (
            "artifacts/3d-element-colors-20261030/mixed-elements.vasp"
        )
        await page.set_input_files("#fileInput", str(mixed))
        await page.wait_for_function(
            "() => document.getElementById('nAtoms').textContent === '8'",
            timeout=30000,
        )
        await page.click("button[data-preset='studio']")
        await page.click("button[data-mode-value='ballstick']")
        await page.select_option("#schemeSel", "cpk")
        await page.wait_for_timeout(700)
        color_meta = await page.evaluate(
            """
            () => {
              const elements = ['Pd', 'Pt', 'Ru', 'Rh', 'Ir', 'Os', 'Re', 'Au'];
              const legend = Array.from(document.querySelectorAll('#legend .legend-item')).map((item) => ({
                el: item.querySelector('b').textContent,
                color: getComputedStyle(item.querySelector('.legend-dot')).backgroundColor,
              }));
              const sphereColors = Object.fromEntries(
                elements.map((el) => [el, viewerStyle().colorOf(el)])
              );
              return { legend, sphereColors };
            }
            """
        )
        legend_colors = [item["color"] for item in color_meta["legend"]]
        sphere_colors = list(color_meta["sphereColors"].values())
        shot = mixed.parent / "mixed-elements-green.png"
        await page.locator("#viewer").screenshot(path=str(shot))
        check(
            "多元素球体与图例颜色彼此不同",
            len(legend_colors) == 8
            and len(set(legend_colors)) == 8
            and len(set(sphere_colors)) == 8
            and color_meta["sphereColors"]["Pd"] != color_meta["sphereColors"]["Pt"]
            and "rgb(204, 204, 204)" not in legend_colors,
            f"legend={color_meta['legend']} spheres={color_meta['sphereColors']} shot={shot}",
        )

        # 11) 页面无横向溢出
        geo = await page.evaluate(
            "() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth })"
        )
        check("无横向溢出", geo["overflow"] <= 0, f"overflow={geo['overflow']}px")

        # 12) 页面错误
        real_errors = [
            e
            for e in errors
            if "GPU stall due to ReadPixels" not in e
            and "favicon" not in e.lower()
        ]
        check("无页面/请求错误", len(real_errors) == 0, f"{len(real_errors)} errors")
        for e in real_errors[:6]:
            print("   ", e)
        await browser.close()

    if failures:
        print(f"\n{len(failures)} 项未通过: {failures}")
        return 1
    print("\n全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
