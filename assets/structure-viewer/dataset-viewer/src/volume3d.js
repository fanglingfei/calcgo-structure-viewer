import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { assetUrl, fetchBinary } from "./api.js";

const PRESETS = {
  teal: { low: [0.02, 0.10, 0.15], mid: [0.12, 0.78, 0.73], high: [0.92, 1.0, 0.83], opacity: 0.42 },
  fire: { low: [0.08, 0.03, 0.12], mid: [0.88, 0.18, 0.05], high: [1.0, 0.94, 0.55], opacity: 0.48 },
  diverging: { low: [0.12, 0.32, 0.92], mid: [0.94, 0.95, 0.90], high: [0.96, 0.20, 0.11], opacity: 0.40 }
};

const ATOM_COLORS = {
  H: 0xf5f5f5, C: 0x3f4854, N: 0x4575f0, O: 0xff4c3f, F: 0x70d26d,
  S: 0xf3d43b, P: 0xf59b30, Cl: 0x4fd06a, Br: 0xa85b3d, I: 0x8a48bd,
  Li: 0xb879e8, Na: 0xf2b26d, K: 0x9c71e8, Mg: 0x8cdd79, Ca: 0x93d982,
  Ti: 0xa5a4a4, Fe: 0xe46a38, Co: 0x6d8cff, Ni: 0x8fc95c, Cu: 0xc47b43,
  Zn: 0x7a6fca, Pt: 0xd8e0e4, Pd: 0xaab8c3, Au: 0xf4c842, Ag: 0xc7d4dc
};

const VERTEX = `
out vec3 vPosition;
void main() {
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = `
precision highp float;
precision highp sampler3D;
in vec3 vPosition;
layout(location = 0) out vec4 outColor;
uniform sampler3D uVolume;
uniform vec3 uCameraLocal;
uniform vec3 uColorLow;
uniform vec3 uColorMid;
uniform vec3 uColorHigh;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform float uOpacity;
uniform float uLowCut;
uniform float uRangeMin;
uniform float uRangeMax;
uniform int uSteps;

vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float near = max(max(tmin.x, tmin.y), tmin.z);
  float far = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(near, far);
}

void main() {
  vec3 ro = uCameraLocal;
  vec3 rd = normalize(vPosition - ro);
  vec2 hit = boxHit(ro, rd, vec3(-0.5), vec3(0.5));
  if (hit.y <= max(0.0, hit.x)) discard;
  float start = max(0.0, hit.x);
  float span = max(0.0001, hit.y - start);
  vec4 accum = vec4(0.0);
  for (int i = 0; i < 256; i++) {
    if (i >= uSteps) break;
    float t = start + span * ((float(i) + 0.5) / float(uSteps));
    vec3 p = ro + rd * t;
    if (any(lessThan(p, uClipMin)) || any(greaterThan(p, uClipMax))) continue;
    float raw = texture(uVolume, p + 0.5).r;
    float v = clamp((raw - uRangeMin) / max(0.0001, uRangeMax - uRangeMin), 0.0, 1.0);
    float signal = smoothstep(uLowCut, 1.0, v);
    if (signal <= 0.001) continue;
    vec3 color = v < 0.5
      ? mix(uColorLow, uColorMid, v * 2.0)
      : mix(uColorMid, uColorHigh, (v - 0.5) * 2.0);
    float alpha = uOpacity * (0.025 + 0.38 * signal * signal);
    accum.rgb += (1.0 - accum.a) * color * alpha;
    accum.a += (1.0 - accum.a) * alpha;
    if (accum.a > 0.985) break;
  }
  if (accum.a < 0.004) discard;
  outColor = accum;
}`;

export class VolumeViewer {
  constructor(container, manifest) {
    this.container = container;
    this.manifest = manifest;
    this.volume = manifest.volume || {};
    this.preset = "teal";
    this.clipEnabled = false;
    this.clipFraction = 1;
    this.volumeMesh = null;
    this.isoMeshes = {};
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x071619);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.01, 10000);
    this.camera.position.set(1.7, 1.35, 2.2);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    const gl = this.renderer.domElement.getContext("webgl2");
    this.volumeSupported = Boolean(gl && Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 0) >= 64);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.resize = this.resize.bind(this);
    this.animate = this.animate.bind(this);
    window.addEventListener("resize", this.resize);
    this.resize();
    requestAnimationFrame(this.animate);
  }

  async load() {
    const buffer = await fetchBinary(assetUrl(this.manifest.assets.volume_bin));
    const encoded = new Uint16Array(buffer);
    const values = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) values[i] = encoded[i] >> 8;
    const [nx, ny, nz] = this.volume.dims;
    const texture = new THREE.Data3DTexture(values, nx, ny, nz);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.texture = texture;
    const preset = PRESETS[this.preset];
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uVolume: { value: texture },
        uCameraLocal: { value: new THREE.Vector3() },
        uColorLow: { value: new THREE.Vector3(...preset.low) },
        uColorMid: { value: new THREE.Vector3(...preset.mid) },
        uColorHigh: { value: new THREE.Vector3(...preset.high) },
        uOpacity: { value: preset.opacity },
        uLowCut: { value: 0.06 },
        uRangeMin: { value: 0.0 },
        uRangeMax: { value: 1.0 },
        uClipMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
        uClipMax: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        uSteps: { value: nx * ny * nz > 4_000_000 ? 96 : 160 }
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false
    });
    this.volumeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.volumeMesh.frustumCulled = false;
    const lattice = this.volume.lattice || [[1,0,0],[0,1,0],[0,0,1]];
    const a = new THREE.Vector3(...lattice[0]);
    const b = new THREE.Vector3(...lattice[1]);
    const c = new THREE.Vector3(...lattice[2]);
    this.volumeMesh.matrixAutoUpdate = false;
    this.volumeMesh.matrix.makeBasis(a, b, c);
    this.volumeMesh.matrixWorldNeedsUpdate = true;
    this.volumeMesh.updateMatrixWorld(true);
    this.scene.add(this.volumeMesh);
    this.buildAtomOverlay(lattice);
    this.fitView();
  }

  applyPreset(name) {
    this.preset = PRESETS[name] ? name : "teal";
    if (!this.material) return;
    const preset = PRESETS[this.preset];
    this.material.uniforms.uColorLow.value.set(...preset.low);
    this.material.uniforms.uColorMid.value.set(...preset.mid);
    this.material.uniforms.uColorHigh.value.set(...preset.high);
    this.material.uniforms.uOpacity.value = preset.opacity;
  }

  setVolumeVisible(visible) {
    if (this.volumeMesh) this.volumeMesh.visible = visible;
  }

  setScalarRange(low, high) {
    if (!this.material) return;
    const nLow = Math.max(0, Math.min(1, Number(low)));
    const nHigh = Math.max(nLow + 0.0001, Math.min(1, Number(high)));
    this.material.uniforms.uRangeMin.value = nLow;
    this.material.uniforms.uRangeMax.value = nHigh;
  }

  buildAtomOverlay(lattice) {
    const structure = this.manifest.structure || {};
    const positions = structure.positions || [];
    const elements = structure.elements || [];
    if (!positions.length || positions.length !== elements.length) return;
    try {
      const inverse = new THREE.Matrix3().set(
        lattice[0][0], lattice[1][0], lattice[2][0],
        lattice[0][1], lattice[1][1], lattice[2][1],
        lattice[0][2], lattice[1][2], lattice[2][2],
      ).invert();
      const scale = Math.max(...lattice.map((row) => Math.hypot(...row)));
      const geometry = new THREE.SphereGeometry(1, 10, 7);
      const byElement = new Map();
      elements.forEach((element, index) => {
        if (!byElement.has(element)) byElement.set(element, []);
        byElement.get(element).push(index);
      });
      const group = new THREE.Group();
      const matrix = new THREE.Matrix4();
      for (const [element, indices] of byElement) {
        const material = new THREE.MeshStandardMaterial({
          color: ATOM_COLORS[element] || 0x9bb5b8,
          roughness: 0.38,
          metalness: 0.08,
          emissive: new THREE.Color(ATOM_COLORS[element] || 0x9bb5b8).multiplyScalar(0.08)
        });
        const mesh = new THREE.InstancedMesh(geometry, material, indices.length);
        mesh.frustumCulled = false;
        indices.forEach((atomIndex, instance) => {
          const cart = new THREE.Vector3(...positions[atomIndex]).applyMatrix3(inverse);
          const radius = Math.max(0.006, Math.min(0.025, 1.15 / Math.max(scale, 1)));
          matrix.makeScale(radius, radius, radius);
          matrix.setPosition(cart.x - 0.5, cart.y - 0.5, cart.z - 0.5);
          mesh.setMatrixAt(instance, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
      }
      this.atomOverlay = group;
      this.volumeMesh.add(group);
    } catch (_) {
      this.atomOverlay = null;
    }
  }

  setAtomVisible(visible) {
    if (this.atomOverlay) this.atomOverlay.visible = Boolean(visible);
  }

  setCropping(enabled, fraction = 1) {
    this.clipEnabled = enabled;
    this.clipFraction = fraction;
    if (!this.material) return;
    const edge = enabled ? 0.5 - 0.5 * Math.max(0.08, Math.min(1, fraction)) : 0;
    this.material.uniforms.uClipMin.value.set(-0.5 + edge, -0.5 + edge, -0.5 + edge);
    this.material.uniforms.uClipMax.value.set(0.5 - edge, 0.5 - edge, 0.5 - edge);
    this.material.uniforms.uLowCut.value = enabled ? 0.04 : 0.06;
  }

  async showIso(name) {
    const asset = this.manifest.assets?.[name];
    if (!asset) throw new Error("没有预计算等值面");
    if (this.isoMeshes[name]) {
      this.isoMeshes[name].visible = true;
      return;
    }
    const text = await (await fetch(assetUrl(asset))).text();
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const pointNode = doc.querySelector("Piece > Points > DataArray");
    const polyNodes = doc.querySelectorAll("Piece > Polys > DataArray");
    if (!pointNode || !polyNodes.length) throw new Error("等值面格式无效");
    const points = pointNode.textContent.trim().split(/\s+/).map(Number);
    let connectivity = [];
    let offsets = [];
    for (const node of polyNodes) {
      const values = node.textContent.trim().split(/\s+/).map(Number);
      if (node.getAttribute("Name") === "connectivity") connectivity = values;
      if (node.getAttribute("Name") === "offsets") offsets = values;
    }
    if (!offsets.length) {
      throw new Error("等值面缺少 offsets");
    }
    const indices = [];
    let previous = 0;
    for (const offset of offsets) {
      const count = offset - previous;
      for (let i = 1; i + 1 < count; i++) {
        indices.push(connectivity[previous], connectivity[previous + i], connectivity[previous + i + 1]);
      }
      previous = offset;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: name.includes("negative") ? 0xe65333 : 0x4ed9c8,
      transparent: true, opacity: 0.46,
      side: THREE.DoubleSide, depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    this.isoMeshes[name] = mesh;
    this.scene.add(mesh);
  }

  hideIso(name) {
    if (this.isoMeshes[name]) this.isoMeshes[name].visible = false;
  }

  sliceValues(axis = 2, fraction = .5) {
    if (!this.texture) return null;
    const [nx, ny, nz] = this.volume.dims;
    const data = this.texture.image.data;
    const plane = Math.max(0, Math.min([nx, ny, nz][axis] - 1,
      Math.round(([nx, ny, nz][axis] - 1) * fraction)));
    let width = nx, height = ny;
    if (axis === 0) { width = nz; height = ny; }
    if (axis === 1) { width = nx; height = nz; }
    const values = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let ix = x, iy = y, iz = plane;
        if (axis === 0) { ix = plane; iz = x; }
        if (axis === 1) { iy = plane; iz = y; }
        values[y * width + x] = data[ix + nx * (iy + ny * iz)] || 0;
      }
    }
    return { width, height, values, max: 255 };
  }

  fitView() {
    if (!this.volumeMesh) return;
    this.volumeMesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.volumeMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(size.length() * 1.15, 2.5);
    this.camera.position.copy(center).add(new THREE.Vector3(1.4, 1.15, 1.8).normalize().multiplyScalar(distance));
    this.camera.near = Math.max(0.01, distance / 1000);
    this.camera.far = distance * 20;
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
    if (this.volumeMesh && this.material) {
      this.volumeMesh.updateMatrixWorld(true);
      const local = this.volumeMesh.worldToLocal(this.camera.position.clone());
      this.material.uniforms.uCameraLocal.value.copy(local);
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
