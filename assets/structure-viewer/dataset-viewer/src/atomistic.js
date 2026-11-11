import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { assetUrl, fetchBinary } from "./api.js";

const COLORS = {
  H: "#f5f5f5", C: "#3f4854", N: "#4575f0", O: "#ff4c3f", F: "#70d26d",
  S: "#f3d43b", P: "#f59b30", Cl: "#4fd06a", Br: "#a85b3d", I: "#8a48bd",
  Li: "#b879e8", Na: "#f2b26d", K: "#9c71e8", Mg: "#8cdd79", Ca: "#93d982",
  Ti: "#a5a4a4", Fe: "#e46a38", Co: "#6d8cff", Ni: "#8fc95c", Cu: "#c47b43",
  Zn: "#7a6fca", Pt: "#d8e0e4", Pd: "#aab8c3", Au: "#f4c842", Ag: "#c7d4dc"
};

const RADII = {
  H: .32, C: .7, N: .65, O: .6, F: .55, S: 1.0, P: 1.0, Li: 1.3, Na: 1.6,
  K: 2.0, Mg: 1.4, Ca: 1.8, Ti: 1.5, Fe: 1.3, Co: 1.3, Ni: 1.25, Cu: 1.25,
  Zn: 1.3, Pt: 1.35, Pd: 1.4, Au: 1.4, Ag: 1.45
};

export class AtomisticViewer {
  constructor(container, manifest) {
    this.container = container;
    this.manifest = manifest;
    this.structure = manifest.structure || {};
    this.elements = this.structure.elements || [];
    this.nAtoms = Number(this.structure.n_atoms || this.elements.length);
    this.timeline = manifest.timeline || {};
    this.frameCount = Number(this.timeline.n_frames || 1);
    this.frame = 0;
    this.phase = 0;
    this.modeIndex = -1;
    this.positions = null;
    this.cells = null;
    this.modes = null;
    this.atoms = [];
    this.cellLines = null;
    this.bondLines = null;
    this.bonds = [];
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x071619);
    this.camera = new THREE.PerspectiveCamera(36, 1, .05, 10000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .08;
    this.controls.target.set(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight(0xbff5ec, 0x0a2327, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(8, 10, 9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x51d9d0, .85);
    rim.position.set(-8, -3, -7);
    this.scene.add(rim);
    this.resize = this.resize.bind(this);
    this.animate = this.animate.bind(this);
    window.addEventListener("resize", this.resize);
    this.resize();
    requestAnimationFrame(this.animate);
  }

  async load() {
    const [positionsBuffer, cellsBuffer] = await Promise.all([
      fetchBinary(assetUrl(this.manifest.assets.positions_bin)),
      fetchBinary(assetUrl(this.manifest.assets.cells_bin))
    ]);
    const positions = new Float32Array(positionsBuffer);
    const cells = new Float32Array(cellsBuffer);
    this.positions = new Float32Array(positions.length);
    positions.forEach((value, index) => {
      this.positions[index] = Math.fround(value);
    });
    this.cells = cells;
    if (this.manifest.assets.normal_modes_bin) {
      const buffer = await fetchBinary(assetUrl(this.manifest.assets.normal_modes_bin));
      this.modes = new Float32Array(buffer);
    }
    this.buildAtoms();
    this.buildBonds();
    this.setFrame(0);
    this.fitView();
  }

  buildAtoms() {
    const radiusBase = this.nAtoms > 50000 ? .22 : this.nAtoms > 12000 ? .28 : .36;
    for (const atom of this.atoms) this.scene.remove(atom);
    this.atoms = [];
    const segments = this.nAtoms > 30000 ? 6 : this.nAtoms > 8000 ? 10 : 16;
    const geometry = new THREE.SphereGeometry(1, segments, Math.max(5, segments / 2));
    const byElement = new Map();
    this.elements.forEach((element) => {
      if (!byElement.has(element)) byElement.set(element, []);
      byElement.get(element).push(byElement.get(element).length);
    });
    this.elementMeshes = {};
    let globalIndex = 0;
    for (const [element, localIndices] of byElement) {
      const indices = [];
      this.elements.forEach((el, index) => { if (el === element) indices.push(index); });
      const material = new THREE.MeshStandardMaterial({
        color: COLORS[element] || "#9bb5b8", roughness: .36, metalness: .08
      });
      const mesh = new THREE.InstancedMesh(geometry, material, indices.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.userData.indices = indices;
      mesh.userData.radius = (RADII[element] || .9) * radiusBase;
      this.scene.add(mesh);
      this.elementMeshes[element] = mesh;
      this.atoms.push(mesh);
    }
  }

  buildBonds() {
    if (this.bondLines) this.scene.remove(this.bondLines);
    this.bonds = [];
    if (this.nAtoms > 3000 || !this.positions) return;
    const pos0 = this.positions.slice(0, this.nAtoms * 3);
    for (let i = 0; i < this.nAtoms; i++) {
      for (let j = i + 1; j < this.nAtoms; j++) {
        const dx = pos0[i * 3] - pos0[j * 3];
        const dy = pos0[i * 3 + 1] - pos0[j * 3 + 1];
        const dz = pos0[i * 3 + 2] - pos0[j * 3 + 2];
        const distance = Math.hypot(dx, dy, dz);
        const limit = ((RADII[this.elements[i]] || .9) + (RADII[this.elements[j]] || .9)) * .68;
        if (distance > .25 && distance <= limit) this.bonds.push([i, j]);
      }
    }
    if (!this.bonds.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.bonds.length * 6), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xb8d4d2, transparent: true, opacity: .55 });
    this.bondLines = new THREE.LineSegments(geometry, material);
    this.bondLines.frustumCulled = false;
    this.scene.add(this.bondLines);
  }

  framePositions(index) {
    const baseOffset = index * this.nAtoms * 3;
    const data = new Float32Array(this.nAtoms * 3);
    for (let i = 0; i < this.nAtoms * 3; i++) data[i] = this.positions[baseOffset + i];
    if (this.modes && this.modeIndex >= 0 && this.modeIndex < this.timeline.normal_modes.count) {
      const modeOffset = this.modeIndex * this.nAtoms * 3;
      const amplitude = Math.sin(this.phase) * .85;
      for (let i = 0; i < this.nAtoms * 3; i++) {
        data[i] += this.modes[modeOffset + i] * amplitude;
      }
    }
    return data;
  }

  setFrame(index) {
    if (!this.positions) return;
    this.frame = Math.max(0, Math.min(this.frameCount - 1, index));
    const data = this.framePositions(this.frame);
    const matrix = new THREE.Matrix4();
    for (const mesh of this.atoms) {
      const indices = mesh.userData.indices;
      const radius = mesh.userData.radius;
      indices.forEach((atomIndex, localIndex) => {
        matrix.makeScale(radius, radius, radius);
        matrix.setPosition(data[atomIndex * 3], data[atomIndex * 3 + 1], data[atomIndex * 3 + 2]);
        mesh.setMatrixAt(localIndex, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.bondLines && this.bonds.length) {
      const array = this.bondLines.geometry.attributes.position.array;
      this.bonds.forEach(([i, j], index) => {
        array[index * 6] = data[i * 3]; array[index * 6 + 1] = data[i * 3 + 1]; array[index * 6 + 2] = data[i * 3 + 2];
        array[index * 6 + 3] = data[j * 3]; array[index * 6 + 4] = data[j * 3 + 1]; array[index * 6 + 5] = data[j * 3 + 2];
      });
      this.bondLines.geometry.attributes.position.needsUpdate = true;
    }
    this.updateCell(this.frame);
  }

  updateCell(frame) {
    if (this.cellLines) this.scene.remove(this.cellLines);
    const cell = this.cells.slice(frame * 9, frame * 9 + 9);
    if (!cell.some((value) => Math.abs(value) > 1e-8)) return;
    const vectors = [0, 1, 2].map((i) => new THREE.Vector3(cell[i * 3], cell[i * 3 + 1], cell[i * 3 + 2]));
    const origin = new THREE.Vector3();
    const points = [];
    const corners = [
      origin,
      vectors[0], vectors[1], vectors[2],
      vectors[0].clone().add(vectors[1]),
      vectors[0].clone().add(vectors[2]),
      vectors[1].clone().add(vectors[2]),
      vectors[0].clone().add(vectors[1]).add(vectors[2])
    ];
    [[0,1],[0,2],[0,3],[1,4],[1,5],[2,4],[2,6],[3,5],[3,6],[4,7],[5,7],[6,7]]
      .forEach(([a,b]) => { points.push(corners[a], corners[b]); });
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.cellLines = new THREE.LineSegments(geometry,
      new THREE.LineBasicMaterial({ color: 0x79cbbf, transparent: true, opacity: .34 }));
    this.scene.add(this.cellLines);
  }

  setNormalMode(index, phase = 0) {
    this.modeIndex = Number(index);
    this.phase = phase;
    this.setFrame(this.frame);
  }

  fitView() {
    if (!this.positions) return;
    const data = this.positions.slice(0, this.nAtoms * 3);
    const box = new THREE.Box3();
    for (let i = 0; i < this.nAtoms; i++) {
      box.expandByPoint(new THREE.Vector3(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]));
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * .62, 3);
    const distance = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.18;
    const direction = new THREE.Vector3(.72, .58, 1).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(.03, distance / 300);
    this.camera.far = Math.max(1000, distance * 30);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    requestAnimationFrame(this.animate);
    if (this.modes && this.modeIndex >= 0) {
      this.phase += .045;
      this.setFrame(this.frame);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    this.container.innerHTML = "";
  }
}
