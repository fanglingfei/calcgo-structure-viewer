import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkFullScreenRenderWindow from "@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import { assetUrl, fetchBinary } from "./api.js";

export class CaeViewer {
  constructor(container, manifest) {
    this.container = container;
    this.manifest = manifest;
    this.full = vtkFullScreenRenderWindow.newInstance({
      rootContainer: container,
      containerStyle: { position: "absolute", inset: "0", width: "100%", height: "100%" },
      background: [0.027, 0.086, 0.098]
    });
    this.renderer = this.full.getRenderer();
    this.renderWindow = this.full.getRenderWindow();
    this.polydata = null;
    this.mapper = null;
    this.actor = null;
    this.plane = null;
  }

  async load() {
    const buffer = await fetchBinary(assetUrl(this.manifest.assets.mesh_vtp));
    const reader = vtkXMLPolyDataReader.newInstance();
    reader.parseAsArrayBuffer(buffer);
    this.polydata = reader.getOutputData(0);
    this.mapper = vtkMapper.newInstance();
    this.mapper.setInputData(this.polydata);
    this.actor = vtkActor.newInstance();
    this.actor.setMapper(this.mapper);
    this.renderer.addActor(this.actor);
    this.setField(this.manifest.mesh?.fields?.[0]?.name || "");
    this.renderer.resetCamera();
    this.render();
  }

  fieldNames() {
    return (this.manifest.mesh?.fields || []).map((field) => field.name);
  }

  setField(name) {
    if (!this.mapper) return;
    if (!name) {
      this.mapper.setScalarVisibility(false);
      this.actor.getProperty().setColor(.35, .75, .78);
      this.render();
      return;
    }
    const field = (this.manifest.mesh?.fields || []).find((item) => item.name === name);
    if (!field || field.components !== 1) {
      this.mapper.setScalarVisibility(false);
      this.actor.getProperty().setColor(.4, .72, .86);
      this.render();
      return;
    }
    const low = Number(field.min ?? 0);
    const high = Number(field.max ?? 1);
    const ctf = vtkColorTransferFunction.newInstance();
    const colors = [
      [0.04, 0.15, 0.27], [0.08, 0.47, 0.58], [0.32, 0.83, 0.68],
      [0.96, 0.77, 0.28], [0.93, 0.30, 0.19]
    ];
    colors.forEach((rgb, index) => ctf.addRGBPoint(low + (high - low) * index / (colors.length - 1), ...rgb));
    this.mapper.setLookupTable(ctf);
    this.mapper.setScalarModeToUsePointFieldData();
    this.mapper.setColorByArrayName(name);
    this.mapper.setScalarRange(low, high);
    this.mapper.setScalarVisibility(true);
    this.render();
  }

  setWireframe(enabled) {
    if (!this.actor) return;
    this.actor.getProperty().setRepresentation(enabled ? 1 : 2);
    this.render();
  }

  setOpacity(value) {
    if (!this.actor) return;
    this.actor.getProperty().setOpacity(Number(value));
    this.render();
  }

  setClip(enabled, fraction = .5, axis = 0) {
    if (!this.mapper) return;
    if (!enabled) {
      try { this.mapper.removeAllClippingPlanes?.(); } catch (_) {}
      this.render();
      return;
    }
    const bounds = this.polydata.getBounds();
    const mins = [bounds[0], bounds[2], bounds[4]];
    const maxs = [bounds[1], bounds[3], bounds[5]];
    const normal = [0, 0, 0];
    normal[axis] = 1;
    const origin = [...mins];
    origin[axis] = mins[axis] + (maxs[axis] - mins[axis]) * fraction;
    this.plane = vtkPlane.newInstance({ normal, origin });
    try { this.mapper.removeAllClippingPlanes?.(); } catch (_) {}
    this.mapper.addClippingPlane(this.plane);
    this.render();
  }

  render() { this.renderWindow?.render(); }
}
