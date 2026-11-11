/* ============================================================
 * 3D 结构查看器 · three.js 渲染引擎（v2）
 * 由 structure-viewer-pro 的渲染管线抽取而来：
 *   PBR 材质 + 程序化环境反射(PMREM) + ACES 色调映射 + 4×MSAA
 *   + 辉光/暗角/雾气 + 原子描边 + 配位多面体 + 球体精度 + 背景模式
 *   实时画面与导出 PNG 走同一条输出合成通道（所见即所得）
 * 依赖（全部本地，无需联网）：three.min.js r128、three-addons/*
 * 对外接口见文件末尾 window.SVViewer.create()
 * ============================================================ */
(function () {
  "use strict";

  /* 球体/圆柱精度：快速 / 标准 / 精细 */
  var QUAL = { fast: [24, 16, 10], std: [48, 32, 18], fine: [72, 48, 28] };

  /* 配位多面体默认只画金属中心；其余元素用“全部元素”模式 */
  var METALS = {
    Li: 1, Be: 1, Na: 1, Mg: 1, Al: 1, K: 1, Ca: 1, Sc: 1, Ti: 1, V: 1, Cr: 1,
    Mn: 1, Fe: 1, Co: 1, Ni: 1, Cu: 1, Zn: 1, Ga: 1, Rb: 1, Sr: 1, Y: 1, Zr: 1,
    Nb: 1, Mo: 1, Tc: 1, Ru: 1, Rh: 1, Pd: 1, Ag: 1, Cd: 1, In: 1, Sn: 1, Cs: 1,
    Ba: 1, La: 1, Ce: 1, Pr: 1, Nd: 1, Sm: 1, Eu: 1, Gd: 1, Tb: 1, Dy: 1, Ho: 1,
    Er: 1, Tm: 1, Yb: 1, Lu: 1, Hf: 1, Ta: 1, W: 1, Re: 1, Os: 1, Ir: 1, Pt: 1,
    Au: 1, Hg: 1, Tl: 1, Pb: 1, Bi: 1, Th: 1, U: 1,
  };

  function srgbToLin(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  /* 把“显示色”转成线性色（材质/背景/描边都用它，避免颜色发白） */
  function dispColor(h) {
    var c = new THREE.Color(h);
    return new THREE.Color(srgbToLin(c.r), srgbToLin(c.g), srgbToLin(c.b));
  }
  function posKey(x, y, z) {
    return Math.round(x * 1000) + "," + Math.round(y * 1000) + "," + Math.round(z * 1000);
  }

  var DEFAULT_STYLE = {
    colorOf: function () { return "#c8ccd4"; },
    radiusOf: function (el, rCov) { return Math.max(0.12, (rCov || 0.7) * 0.45); },
    bondRadius: function () { return 0.09; },
    cellRadius: function () { return 0.045; },
    cellColor: "#ffffff",
    showBonds: true,
    showCell: true,
    schemeKey: "cpk",
  };

  var DEFAULT_FX = {
    quality: "std",
    poly: "off",            // off / metal / all
    outline: 0.35,          // 0 = 关闭
    bloom: 0,               // 0 = 关闭
    vignette: 0.22,
    fog: 0,
    envRefl: 0.45,
    envPower: 1,
    lightPower: 1,
    exposure: 1,
    roughness: 0.34,
    metalness: 0.05,
    bgMode: "grad",         // grad / solid / none(透明)
    bgTop: "#ffffff",
    bgBottom: "#eef2f8",
  };

  function create(container, opts) {
    opts = opts || {};
    var onHover = opts.onHover || function () {};
    var onLeave = opts.onLeave || function () {};
    var onClick = opts.onClick || function () {};

    /* ---------------- 渲染器 / 场景 / 相机 ---------------- */
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    var canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);
    if (window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    /* 左下角坐标轴指示器：X/Y/Z 三色轴随视角旋转。
       用世界坐标轴而不是晶胞轴，避免 a/b/c 与屏幕方向混淆。
       使用 HTML canvas 叠加，不参与场景拾取。 */
    var gizmo = document.createElement("canvas");
    gizmo.className = "axis-gizmo";
    gizmo.setAttribute("aria-label", "世界坐标轴 X Y Z");
    gizmo.style.cssText = "position:absolute;left:14px;bottom:14px;width:72px;height:72px;"
      + "z-index:18;pointer-events:none;opacity:.94;";
    container.appendChild(gizmo);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
    camera.position.set(28, 20, 34);
    var camTarget = new THREE.Vector3(0, 0, 0);
    var camUp = new THREE.Vector3(0, 1, 0);
    var camDist = 60;
    var frameScale = 1.0;      // 取景留白系数（1 = 贴紧内容；报告出图给孤立分子放大留白）
    var framed = false;
    // 用户真正拖动或缩放后才暂停自动取景；否则面板布局变化（侧栏展开/收起、
    // 浏览器缩放）可能沿用旧宽高下的相机距离，把结构左右边缘裁掉。
    var userAdjusted = false;
    var sceneRadius = 10;

    var root = new THREE.Group();
    scene.add(root);

    /* ---------------- 灯光（主光/补光/轮廓光挂在相机上，旋转视角时光影稳定） ---------------- */
    var hemi = new THREE.HemisphereLight(0xffffff, 0x8899bb, 0.25);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xffffff, 1.3);
    var fill = new THREE.DirectionalLight(0x9db8ff, 0.32);
    var rim = new THREE.DirectionalLight(0x59c4ff, 0.28);
    scene.add(camera);
    var keyTarget = new THREE.Object3D();
    camera.add(keyTarget);
    key.target = keyTarget;
    camera.add(key, fill, rim);

    /* ---------------- 背景板（挂在相机上，永远铺满画面，不参与色调映射） ---------------- */
    var bgMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(1, 1, 1) },
        uBottom: { value: new THREE.Color(1, 1, 1) },
        uGrad: { value: 1.0 },
      },
      vertexShader:
        "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform vec3 uTop; uniform vec3 uBottom; uniform float uGrad; varying vec2 vUv;" +
        "void main(){ vec3 c = mix(uBottom, uTop, vUv.y * uGrad + (1.0 - uGrad) * 0.5); gl_FragColor = vec4(c, 1.0); }",
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    var bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
    bgMesh.scale.set(60, 60, 1);
    bgMesh.position.set(0, 0, -50);
    bgMesh.frustumCulled = false;
    bgMesh.renderOrder = -1000;
    camera.add(bgMesh);

    /* ---------------- 环境贴图（程序化摄影棚）与雾气 ---------------- */
    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var envRT = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();
    scene.fog = new THREE.FogExp2(0xffffff, 0.000001);

    /* ---------------- 输出合成通道：MSAA + 辉光 + 暗角 + sRGB ---------------- */
    var composer = null, bloomPass = null, finalPass = null;
    var OutputShader = {
      uniforms: { tDiffuse: { value: null }, uVig: { value: 0.22 }, uAlpha: { value: 0.0 } },
      vertexShader:
        "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform sampler2D tDiffuse; uniform float uVig; uniform float uAlpha; varying vec2 vUv;" +
        "vec3 lin2srgb(vec3 c){ return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }" +
        "void main(){" +
        " vec4 s = texture2D(tDiffuse, vUv);" +
        " vec3 c = lin2srgb(clamp(s.rgb, 0.0, 1.0));" +
        " float r = clamp(distance(vUv, vec2(0.5)) * 1.41421, 0.0, 1.0);" +
        " c *= 1.0 - uVig * pow(r, 2.2);" +
        " float a = mix(1.0, clamp(s.a, 0.0, 1.0), uAlpha);" +
        " gl_FragColor = vec4(c * a, a);" +
        "}",
    };
    function ensureComposer() {
      if (composer) return;
      var w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
      var o = {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, stencilBuffer: false, type: THREE.HalfFloatType,
      };
      var rt;
      if (renderer.capabilities.isWebGL2) {
        o.samples = 4;
        rt = new THREE.WebGLMultisampleRenderTarget(w, h, o);
      } else {
        rt = new THREE.WebGLRenderTarget(w, h, o);
      }
      composer = new THREE.EffectComposer(renderer, rt);
      composer.setSize(w, h);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0, 0.7, 0.75);
      /* 纯加色 + 保留原有 alpha：辉光只增亮结构，不会把透明背景点亮 */
      bloomPass.materialCopy.blending = THREE.CustomBlending;
      bloomPass.materialCopy.blendEquation = THREE.AddEquation;
      bloomPass.materialCopy.blendSrc = THREE.OneFactor;
      bloomPass.materialCopy.blendDst = THREE.OneFactor;
      bloomPass.materialCopy.blendSrcAlpha = THREE.ZeroFactor;
      bloomPass.materialCopy.blendDstAlpha = THREE.OneFactor;
      bloomPass.enabled = false;
      composer.addPass(bloomPass);
      finalPass = new THREE.ShaderPass(OutputShader);
      finalPass.renderToScreen = true;
      composer.addPass(finalPass);
    }
    /* ---------------- 几何容器 ---------------- */
    var content = new THREE.Group();
    var polyGroup = new THREE.Group();
    var outlineGroup = new THREE.Group();
    var atomGroup = new THREE.Group();
    /* 镜像/补位球（kind = "mirror" / "image"）：为了让跨边界键两端都有球可接，
       app.js 会在晶胞外补一层原子。它们**不是晶胞里的原子**，所以单独放一组、
       画小一圈 + 半透明——原来和真原子一起画成实心球，看起来就是"原子多了一倍、
       还两两叠在一起"（2026-10-15 客户指着 SiO₂ 报告图问"原子显示好像有点问题"）。 */
    var ghostGroup = new THREE.Group();
    var bondGroup = new THREE.Group();
    var cellGroup = new THREE.Group();
    var cellShadowGroup = new THREE.Group();
    var guideGroup = new THREE.Group();
    content.add(polyGroup, outlineGroup, ghostGroup, atomGroup, bondGroup, cellShadowGroup, cellGroup, guideGroup);
    var guidePoints = [];
    var guideMat = new THREE.LineDashedMaterial({
      color: 0x00697a, dashSize: 0.26, gapSize: 0.18,
      transparent: true, opacity: 0.95, depthTest: false,
    });
    var guideDotMat = new THREE.MeshBasicMaterial({ color: 0x00697a, depthTest: false });

    function clearGroup(group) {
      while (group.children.length) {
        var child = group.children[0];
        group.remove(child);
        // 辅助线的 BufferGeometry 每次测量都会新建；球体用的是共享 geoSphere，不能释放
        if (child.geometry && child.geometry !== geoSphere) child.geometry.dispose();
      }
    }

    function drawGuide() {
      clearGroup(guideGroup);
      if (!guidePoints || guidePoints.length < 2) return;
      var geo = new THREE.BufferGeometry().setFromPoints(guidePoints);
      var line = new THREE.Line(geo, guideMat);
      line.computeLineDistances();
      line.renderOrder = 40;
      guideGroup.add(line);
      guidePoints.forEach(function (p) {
        var dot = new THREE.Mesh(geoSphere, guideDotMat);
        dot.position.copy(p);
        dot.scale.setScalar(0.075);
        dot.renderOrder = 41;
        guideGroup.add(dot);
      });
    }
    root.add(content);

    var materials = [];
    var atomMat = {};
    var polyMats = {}, polyMatList = [];
    var geoSphere = null, geoCyl = null;
    var qualKey = DEFAULT_FX.quality;

    function rebuildGeo() {
      var q = QUAL[qualKey] || QUAL.std;
      if (geoSphere) geoSphere.dispose();
      if (geoCyl) geoCyl.dispose();
      geoSphere = new THREE.SphereGeometry(1, q[0], q[1]);
      geoCyl = new THREE.CylinderGeometry(1, 1, 1, q[2], 1, false);
    }
    rebuildGeo();

    /* 描边：放大一圈的背面球 + 边缘菲涅尔，做出 VESTA 风格的清晰轮廓 */
    var outlineMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: dispColor(0x2b3d63) }, uStrength: { value: 0.85 } },
      vertexShader:
        "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);" +
        " vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
      fragmentShader:
        "uniform vec3 uColor; uniform float uStrength; varying vec3 vN; varying vec3 vV;" +
        "void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); f = smoothstep(0.30, 0.95, f);" +
        " gl_FragColor = vec4(uColor, f * uStrength); }",
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });

    var STYLE = Object.assign({}, DEFAULT_STYLE);
    var FX = Object.assign({}, DEFAULT_FX);
    var D = null;             // { atoms:[{x,y,z,el,kind,i}], bonds:[{x0..z1,ei,ej}] }
    var CELL = null;

    function stdMat(color) {
      var m = new THREE.MeshStandardMaterial({
        color: dispColor(color), roughness: FX.roughness, metalness: FX.metalness,
      });
      m.envMapIntensity = FX.envRefl;
      materials.push(m);
      return m;
    }
    /* 补位球的材质：同色但半透明（一眼能看出"这不是晶胞里的原子"），不参与描边 */
    var ghostMats = {};
    /* 晶格框：白色半透明虚线 + 一层极淡的中性阴影，保证在浅色/白色报告底上也看得见。 */
    var cellDashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.88, depthWrite: false,
      toneMapped: false,
    });
    var cellShadowMat = new THREE.MeshBasicMaterial({
      color: 0x7b8fa3, transparent: true, opacity: 0.06, depthWrite: false,
    });
    function ghostMat(color) {
      if (!ghostMats[color]) {
        var m = new THREE.MeshStandardMaterial({
          color: dispColor(color), roughness: FX.roughness, metalness: FX.metalness,
          transparent: true, opacity: 0.38, depthWrite: false,
        });
        m.envMapIntensity = FX.envRefl * 0.5;
        /* 不进 materials：那一组每帧会被 applyFxFlags 按主口径改写（含 envMapIntensity），
           补位球要保持"更暗更透"的观感 */
        ghostMats[color] = m;
        return m;
      }
      return ghostMats[color];
    }
    function polyMatFor(colorHex) {
      if (!polyMats[colorHex]) {
        /* 比原子色略深 + 平面着色，半透明多面体的棱面才看得出来 */
        var m = new THREE.MeshPhysicalMaterial({
          color: dispColor(colorHex).multiplyScalar(0.76), roughness: 0.6, metalness: 0.0,
          transparent: true, opacity: 0.3, side: THREE.DoubleSide,
          depthWrite: false, flatShading: true,
          clearcoat: 0.2, clearcoatRoughness: 0.6,
        });
        m.envMapIntensity = FX.envRefl * 0.7;
        polyMats[colorHex] = m;
        polyMatList.push(m);
      }
      return polyMats[colorHex];
    }
    function rod(a, b, mat) {
      var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-6) return null;
      var mesh = new THREE.Mesh(geoCyl, mat);
      mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx, dy, dz).normalize()
      );
      mesh.scale.set(1, len, 1);
      return mesh;
    }

    /* ---------------- 组装结构 ---------------- */
    function buildPolyhedra() {
      polyGroup.clear();
      polyMatList = [];
      polyMats = {};
      if (!D || FX.poly === "off") return 0;
      var atoms = D.atoms, bonds = D.bonds || [];
      var idxOf = new Map();
      atoms.forEach(function (a, k) { idxOf.set(posKey(a.x, a.y, a.z), k); });
      var adj = new Array(atoms.length);
      bonds.forEach(function (b) {
        var ia = idxOf.get(posKey(b.x0, b.y0, b.z0));
        var ib = idxOf.get(posKey(b.x1, b.y1, b.z1));
        if (ia == null || ib == null) return;
        (adj[ia] || (adj[ia] = [])).push(ib);
        (adj[ib] || (adj[ib] = [])).push(ia);
      });
      var made = 0;
      for (var i = 0; i < atoms.length; i++) {
        var a = atoms[i];
        if (a.kind && a.kind !== "base") continue;   // 只画晶胞内的中心原子，避免镜像堆叠糊成一团
        if (FX.poly === "metal" && !METALS[a.el]) continue;
        var nb = adj[i];
        if (!nb || nb.length < 4) continue;
        var pts = [], seen = {};
        for (var k = 0; k < nb.length; k++) {
          var j = nb[k];
          if (seen[j]) continue;
          seen[j] = 1;
          pts.push(new THREE.Vector3(atoms[j].x, atoms[j].y, atoms[j].z));
        }
        if (pts.length < 4) continue;
        var geo = null;
        try { geo = new THREE.ConvexGeometry(pts); } catch (e) { geo = null; }
        if (!geo || !geo.attributes.position || geo.attributes.position.count < 6) continue;
        polyGroup.add(new THREE.Mesh(geo, polyMatFor(STYLE.colorOf(a.el))));
        made++;
      }
      return made;
    }

    function rebuild() {
      atomGroup.clear(); bondGroup.clear(); cellGroup.clear(); cellShadowGroup.clear();
      outlineGroup.clear(); polyGroup.clear(); ghostGroup.clear();
      atomMat = {}; materials = []; polyMats = {}; polyMatList = []; ghostMats = {};
      if (!D) { render(); return; }

      /* 原子 + 描边壳；镜像/补位球单独画（小一圈 + 半透明，不描边） */
      D.atoms.forEach(function (a) {
        var color = STYLE.colorOf(a.el);
        if (a.kind && a.kind !== "base") {
          var gm = new THREE.Mesh(geoSphere, atomMat[color] || (atomMat[color] = stdMat(color)));
          gm.position.set(a.x, a.y, a.z);
          gm.userData.atom = a;
          gm.userData.rCov = a.r;
          gm.userData.ghost = true;
          atomGroup.add(gm);
          var go = new THREE.Mesh(geoSphere, outlineMat);
          go.position.set(a.x, a.y, a.z);
          outlineGroup.add(go);
          return;
        }
        var mesh = new THREE.Mesh(geoSphere, atomMat[color] || (atomMat[color] = stdMat(color)));
        mesh.position.set(a.x, a.y, a.z);
        mesh.userData.atom = a;
        mesh.userData.rCov = a.r;
        atomGroup.add(mesh);
        var om = new THREE.Mesh(geoSphere, outlineMat);
        om.position.set(a.x, a.y, a.z);
        outlineGroup.add(om);
      });

      /* 键：两端各半、各用自己的元素颜色 */
      if (STYLE.showBonds) {
        (D.bonds || []).forEach(function (s) {
          var c1 = STYLE.colorOf(s.ei), c2 = STYLE.colorOf(s.ej);
          var mid = [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, (s.z0 + s.z1) / 2];
          var m1 = rod([s.x0, s.y0, s.z0], mid, atomMat[c1] || (atomMat[c1] = stdMat(c1)));
          var m2 = rod(mid, [s.x1, s.y1, s.z1], atomMat[c2] || (atomMat[c2] = stdMat(c2)));
          if (m1) bondGroup.add(m1);
          if (m2) bondGroup.add(m2);
        });
      }

      /* 晶胞框 */
      if (STYLE.showCell && CELL) {
        var corners = [];
        for (var ci = 0; ci < 2; ci++)
          for (var cj = 0; cj < 2; cj++)
            for (var ck = 0; ck < 2; ck++)
              corners.push([
                ci * CELL[0][0] + cj * CELL[1][0] + ck * CELL[2][0],
                ci * CELL[0][1] + cj * CELL[1][1] + ck * CELL[2][1],
                ci * CELL[0][2] + cj * CELL[1][2] + ck * CELL[2][2],
              ]);
        var edges = [
          [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
          [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
        ];
        var avgLen = 0;
        edges.forEach(function (e) {
          var A = corners[e[0]], B = corners[e[1]];
          avgLen += Math.sqrt(Math.pow(B[0] - A[0], 2) + Math.pow(B[1] - A[1], 2)
            + Math.pow(B[2] - A[2], 2));
        });
        avgLen /= Math.max(1, edges.length);
        var dashLen = Math.max(0.26, Math.min(0.95, avgLen * 0.055));
        var gapLen = dashLen * 0.72;
        edges.forEach(function (e) {
          var A = corners[e[0]], B = corners[e[1]];
          var dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
          var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-6) return;
          var slot = dashLen + gapLen;
          var n = Math.max(2, Math.round(len / slot));
          var step = len / n;
          var on = Math.min(dashLen, step * 0.66);
          for (var k = 0; k < n; k++) {
            var t0 = (k * step) / len;
            var t1 = (k * step + on) / len;
            var a = [A[0] + dx * t0, A[1] + dy * t0, A[2] + dz * t0];
            var b = [A[0] + dx * t1, A[1] + dy * t1, A[2] + dz * t1];
            var sh = rod(a, b, cellShadowMat);
            if (sh) {
              sh.userData.isCell = true;
              sh.userData.isCellShadow = true;
              sh.renderOrder = 3;
              cellShadowGroup.add(sh);
            }
            var m = rod(a, b, cellDashMat);
            if (m) {
              m.userData.isCell = true;
              m.userData.isCellDash = true;
              m.renderOrder = 4;
              cellGroup.add(m);
            }
          }
        });
      }

      buildPolyhedra();
      drawGuide();
      centerAndFrame();
      applyStyle();
      applyFxFlags();
      render();
    }

    function centerAndFrame() {
      var box = new THREE.Box3().setFromObject(content);
      if (box.isEmpty()) return;
      var center = box.getCenter(new THREE.Vector3());
      root.position.sub(center);
      box.setFromObject(content);
      var radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1);
      sceneRadius = radius;
      key.position.set(radius * 0.7, radius * 1.15, radius * 1.75);
      fill.position.set(-radius * 1.25, -radius * 0.25, -radius * 0.7);
      rim.position.set(-radius * 0.55, radius * 1.3, -radius * 1.85);
      keyTarget.position.set(0, 0, 0);
      keyTarget.updateMatrixWorld();
      /* 相机未取景过时自动取景；之后保留用户视角，仅调整参数范围 */
      if (!framed) resetView();
      else {
        camera.near = Math.max(0.05, camDist / 100);
        camera.far = Math.max(1000, camDist * 100);
        camera.updateProjectionMatrix();
      }
    }

    /* ---------------- 样式（颜色 / 尺寸 / 显隐） ---------------- */
    function applyStyle() {
      var rOf = STYLE.radiusOf || DEFAULT_STYLE.radiusOf;
      var off = 1 + 0.015 + 0.085 * FX.outline;
      var showOutline = FX.outline > 0.01;
      outlineGroup.visible = showOutline;
      for (var i = 0; i < atomGroup.children.length; i++) {
        var m = atomGroup.children[i];
        var a = m.userData.atom;
        m.scale.setScalar(rOf(a.el, m.userData.rCov));
      }
      /* 补位球：**半径与真原子同一口径**（客户口径 2026-10-15："原子不论边缘还是内部都一样大就行"），
         只用半透明区分"这是邻胞的原子"，不再缩小——缩了会看起来"边缘原子小一号"。 */
      for (var g = 0; g < ghostGroup.children.length; g++) {
        var gmesh = ghostGroup.children[g];
        gmesh.scale.setScalar(rOf(gmesh.userData.atom.el, gmesh.userData.rCov));
      }
      if (showOutline) {
        for (var k = 0; k < outlineGroup.children.length; k++) {
          var om = outlineGroup.children[k];
          var ao = atomGroup.children[k];
          om.scale.setScalar(ao.scale.x * off);
        }
        outlineMat.uniforms.uStrength.value = 0.4 + 0.6 * Math.min(1, FX.outline * 1.6);
      }
      var br = STYLE.bondRadius ? STYLE.bondRadius() : DEFAULT_STYLE.bondRadius();
      for (var b = 0; b < bondGroup.children.length; b++) {
        bondGroup.children[b].scale.x = br;
        bondGroup.children[b].scale.z = br;
      }
      var cr = STYLE.cellRadius ? STYLE.cellRadius() : DEFAULT_STYLE.cellRadius();
      for (var c = 0; c < cellGroup.children.length; c++) {
        cellGroup.children[c].scale.x = cr;
        cellGroup.children[c].scale.z = cr;
      }
      for (var cs = 0; cs < cellShadowGroup.children.length; cs++) {
        cellShadowGroup.children[cs].scale.x = cr * 1.45;
        cellShadowGroup.children[cs].scale.z = cr * 1.45;
      }
      bondGroup.visible = !!STYLE.showBonds;
      cellGroup.visible = !!STYLE.showCell;
      /* 白色虚线本体已经足够；阴影层只保留代码兼容，不参与显示。 */
      cellShadowGroup.visible = false;
      render();
    }

    /* ---------------- 特效与材质参数 ---------------- */
    function applyFxFlags() {
      ensureComposer();
      renderer.toneMappingExposure = FX.exposure;
      hemi.intensity = 0.25 * FX.envPower;
      key.intensity = 1.3 * FX.lightPower;
      fill.intensity = 0.32 * FX.lightPower;
      rim.intensity = 0.28 * FX.lightPower;
      materials.forEach(function (m) {
        m.roughness = FX.roughness;
        m.metalness = FX.metalness;
        m.envMapIntensity = FX.envRefl;
        m.needsUpdate = true;
      });
      polyMatList.forEach(function (m) { m.envMapIntensity = FX.envRefl * 0.7; });
      /* 背景 */
      var transparent = FX.bgMode === "none";
      bgMesh.visible = !transparent;
      if (!transparent) {
        bgMat.uniforms.uGrad.value = FX.bgMode === "grad" ? 1.0 : 0.0;
        bgMat.uniforms.uTop.value.copy(dispColor(FX.bgTop));
        bgMat.uniforms.uBottom.value.copy(dispColor(FX.bgBottom));
        scene.fog.color.copy(dispColor(FX.bgMode === "grad" ? FX.bgBottom : FX.bgTop));
      }
      scene.fog.density = FX.fog * 0.4 / Math.max(sceneRadius, 1);
      /* 辉光 / 暗角 */
      if (bloomPass) {
        bloomPass.enabled = FX.bloom > 0.01;
        bloomPass.strength = FX.bloom;
      }
      if (finalPass) {
        finalPass.uniforms.uVig.value = transparent ? 0.0 : FX.vignette;
        finalPass.uniforms.uAlpha.value = transparent ? 1.0 : 0.0;
      }
      outlineMat.uniforms.uColor.value.copy(dispColor(STYLE.outlineColor || "#2b3d63"));
    }

    function render() {
      ensureComposer();
      /* 拖动和静止帧都走同一套 MSAA + 色调映射合成链路。交互只做
         指针事件合并，不再降分辨率或隐藏描边/键/晶胞。 */
      composer.render(0);
      drawAxisGizmo();
    }

    /* ---------------- 世界坐标轴指示器 ---------------- */
    function drawAxisGizmo() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var size = 72;
      if (gizmo.width !== Math.round(size * dpr)) {
        gizmo.width = Math.round(size * dpr);
        gizmo.height = Math.round(size * dpr);
      }
      var ctx = gizmo.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.fill();
      ctx.strokeStyle = "rgba(120,148,170,.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
      var axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      var labels = ["X", "Y", "Z"];
      var colors = ["#d64545", "#2f9e44", "#2b6cb0"];
      var inv = camera.quaternion.clone().invert();
      var cx = size / 2, cy = size / 2 + 2, R = 23;
      axes.forEach(function (ax, i) {
        var v = new THREE.Vector3(ax[0], ax[1], ax[2]);
        if (v.lengthSq() < 1e-10) return;
        v.normalize().applyQuaternion(inv);
        var x = v.x, y = v.y, z = v.z;
        var len = Math.hypot(x, y);
        /* 正对屏幕的晶轴投影长度接近 0。以前这里只往中心画一个点，完全被另外两根轴
           盖住，客户在俯视图里看不到 c 轴（2026-10-18 反馈："3D 要把坐标轴显示出来"）。
           现在把"垂直屏幕"的轴画成圆环：实心点 = 指向观察者，叉号 = 指向屏幕里，
            并在圆环旁标 X/Y/Z，俯视/正视都能一眼读出哪根轴朝外。 */
        var depthAxis = len < 0.16;
        if (!depthAxis) {
          x /= len; y /= len;
        }
        var alpha = 0.52 + 0.48 * Math.max(0, Math.min(1, (z + 1) / 2));
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colors[i];
        ctx.fillStyle = colors[i];
        ctx.lineWidth = 2.2;
        if (depthAxis) {
          ctx.beginPath();
          ctx.arc(cx, cy, 5.2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          if (z >= 0) {
            ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.moveTo(cx - 3.2, cy - 3.2); ctx.lineTo(cx + 3.2, cy + 3.2);
            ctx.moveTo(cx + 3.2, cy - 3.2); ctx.lineTo(cx - 3.2, cy + 3.2);
            ctx.stroke();
          }
        } else {
          var ex = cx + x * R, ey = cy - y * R;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.font = "bold 10px 'Segoe UI', 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = colors[i];
        if (depthAxis) {
          ctx.fillText(labels[i], cx + 12, cy - 12);
        } else {
          ctx.fillText(labels[i], cx + x * (R + 8), cy - y * (R + 8));
        }
      });
      ctx.globalAlpha = 1;
    }

    function updateCameraAspect() {
      var w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PERF_RATIO));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (composer) {
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(w, h);
      }
    }

    /* 大体系自动降载：原子多时降低实时分辨率，导出仍按全分辨率 */
    var PERF_RATIO = 2;
    function perfRatioFor(n) {
      return n > 4000 ? 1.0 : n > 1500 ? 1.5 : 2.0;
    }

    /* ---------------- 视角 ---------------- */
    function resetView() {
      /* 取景只按**原子内容**算包围盒。
         slab 的晶胞 c 轴通常有 15~25 Å 真空层，若把整个晶胞框也算进去，
         一堆 3~5 Å 厚的原子会被压成画面中央的一小团（2026-10-17 实机截图）。
         晶胞框仍会照常绘制，只是不再决定相机距离。 */
      var box = new THREE.Box3().setFromObject(atomGroup);
      if (box.isEmpty()) box.setFromObject(content);
      if (box.isEmpty()) return;
      var radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1);
      var center = box.getCenter(new THREE.Vector3());
      /* frameScale：取景留白系数。默认 1 = 贴紧内容边界；
         报告出图时给"孤立小分子"用大一点的留白，免得一个小分子铺满整幅图
         （客户口径 2026-10-15：分子图的观感要和吸附体系一致，别突兀）。 */
      var vFov = THREE.MathUtils.degToRad(camera.fov || 35);
      var hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.2, camera.aspect || 1));
      var dist = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2))
        * 1.12 * frameScale;
      camTarget.copy(center);
      var camDir = new THREE.Vector3(0.78, 0.62, 0.95).normalize();
      camUp.set(0, 1, 0);
      if (CELL && CELL.length === 3) {
        var cAxis = new THREE.Vector3(CELL[2][0], CELL[2][1], CELL[2][2]);
        if (cAxis.lengthSq() > 1e-10) {
          cAxis.normalize();
          camUp.copy(cAxis);
          var aAxis = new THREE.Vector3(CELL[0][0], CELL[0][1], CELL[0][2]);
          var bAxis = new THREE.Vector3(CELL[1][0], CELL[1][1], CELL[1][2]);
          var inPlane = aAxis.multiplyScalar(0.85).addScaledVector(bAxis, 0.55);
          inPlane.addScaledVector(cAxis, -inPlane.dot(cAxis));
          if (inPlane.lengthSq() < 1e-8) {
            inPlane = new THREE.Vector3(CELL[0][0], CELL[0][1], CELL[0][2]);
            inPlane.addScaledVector(cAxis, -inPlane.dot(cAxis));
          }
          if (inPlane.lengthSq() > 1e-8) camDir.copy(inPlane.normalize());
          /* 2026-10-19: tilt the camera down toward the surface (~24 degrees)
             while keeping c as screen-up. Report iso shots use the same resetView. */
          camDir.addScaledVector(cAxis, 0.45).normalize();
        }
      }
      camDist = dist;
      camera.near = Math.max(0.05, dist / 100);
      camera.far = Math.max(1000, dist * 100);
      camera.position.copy(center).addScaledVector(camDir, dist);
      camera.up.copy(camUp);
      camera.lookAt(camTarget);
      camera.updateProjectionMatrix();
      framed = true;
      userAdjusted = false;
      render();
    }

    function resizeViewport() {
      updateCameraAspect();
      // 初次布局和窗口/侧栏尺寸变化时重新按新宽高取景。用户在图上拖动或滚轮
      // 调整过视角后，不再强行覆盖他的操作。
      if (framed && !userAdjusted) resetView();
      else render();
    }

    function viewAlong(v, upVec) {
      if (!v) return;
      var dir = new THREE.Vector3(v[0], v[1], v[2]);
      if (dir.lengthSq() < 1e-12) return;
      dir.normalize();
      var up;
      if (upVec && upVec.length === 3) {
        up = new THREE.Vector3(upVec[0], upVec[1], upVec[2]);
        if (up.lengthSq() > 1e-12) up.normalize();
        // 上方向不能与视线平行，否则 lookAt 会退化：投影到视线的垂直平面。
        var dot = up.dot(dir);
        up.addScaledVector(dir, -dot);
        if (up.lengthSq() < 1e-8) up = null;
        else up.normalize();
      }
      if (!up) {
        up = Math.abs(dir.y) > 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      }
      camUp.copy(up);
      camera.up.copy(up);
      camera.position.copy(camTarget).addScaledVector(dir, camDist);
      camera.lookAt(camTarget);
      render();
    }

    /* ---------------- 自由视角交互（无头顶/脚底死区） ---------------- */
    function camLook() {
      camera.up.copy(camUp);
      camera.lookAt(camTarget);
      render();
    }
    function orbitDrag(dx, dy) {
      var off = camera.position.clone().sub(camTarget);
      var up = camUp.clone().normalize();
      /* Horizontal drag must orbit around the screen's current up direction.
         Using world +Y here is wrong for slabs: their screen-up is usually c,
         so a left/right gesture previously changed the model along an unrelated
         world axis and felt disconnected from the pointer. */
      var qy = new THREE.Quaternion().setFromAxisAngle(up, -dx * 0.006);
      off.applyQuaternion(qy);
      up.applyQuaternion(qy);
      var fwd = off.clone().negate().normalize();
      var right = new THREE.Vector3().crossVectors(fwd, up);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      else right.normalize();
      var qp = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.006);
      off.applyQuaternion(qp);
      up.applyQuaternion(qp);
      camUp.copy(up);
      camera.position.copy(camTarget).add(off);
      camLook();
    }
    function panDrag(dx, dy) {
      var fwd = camTarget.clone().sub(camera.position).normalize();
      var right = new THREE.Vector3().crossVectors(fwd, camUp).normalize();
      var up2 = new THREE.Vector3().crossVectors(right, fwd).normalize();
      var k = camDist * 0.0015;
      var delta = right.multiplyScalar(-dx * k).add(up2.multiplyScalar(dy * k));
      camTarget.add(delta);
      camera.position.add(delta);
      camLook();
    }
    function zoomBy(deltaY) {
      var dir = camera.position.clone().sub(camTarget);
      var d = Math.max(0.2, Math.min(camDist * 400, dir.length() * Math.exp(deltaY * 0.0011)));
      dir.setLength(d);
      camera.position.copy(camTarget).add(dir);
      camDist = d;
      camLook();
    }

    /* ---------------- 原子拾取 ---------------- */
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    var hoverPending = false, lastPointer = null, hoverAtom = null;
    function pickAt(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      var hits = raycaster.intersectObjects(atomGroup.children, false);
      if (!hits.length) return null;
      return hits[0].object.userData.atom || null;
    }
    function scheduleHover() {
      if (hoverPending || !lastPointer) return;
      hoverPending = true;
      requestAnimationFrame(function () {
        hoverPending = false;
        var a = lastPointer ? pickAt(lastPointer[0], lastPointer[1]) : null;
        if (a !== hoverAtom) {
          hoverAtom = a;
          if (a) onHover(a);
          else onLeave();
        } else if (a) {
          onHover(a);
        }
      });
    }

    /* ---------------- 事件 ---------------- */
    var drag = null;
    var dragDx = 0, dragDy = 0, dragFrame = 0;
    function flushDrag() {
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      if (!drag || (!dragDx && !dragDy)) return;
      var dx = dragDx, dy = dragDy;
      dragDx = dragDy = 0;
      if (drag.mode === "rot") orbitDrag(dx, dy);
      else panDrag(dx, dy);
    }
    function queueDrag(dx, dy) {
      dragDx += dx;
      dragDy += dy;
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(function () {
        dragFrame = 0;
        if (!drag || (!dragDx && !dragDy)) return;
        var qx = dragDx, qy = dragDy;
        dragDx = dragDy = 0;
        if (drag.mode === "rot") orbitDrag(qx, qy);
        else panDrag(qx, qy);
      });
    }
    canvas.addEventListener("pointerdown", function (e) {
      if (e.button === 0 || e.button === 2) {
        drag = { mode: e.button === 2 ? "pan" : "rot", x: e.clientX, y: e.clientY, moved: 0 };
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        hoverAtom = null;
        onLeave();
      }
    });
    window.addEventListener("pointermove", function (e) {
      if (drag) {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.moved > 1) userAdjusted = true;
        queueDrag(dx, dy);
        return;
      }
      if (e.target !== canvas) return;
      lastPointer = [e.clientX, e.clientY];
      scheduleHover();
    });
    window.addEventListener("pointerup", function (e) {
      if (!drag) return;
      var wasClick = drag.mode === "rot" && drag.moved < 5;
      flushDrag();
      drag = null;
      if (wasClick && e.target === canvas) {
        var a = pickAt(e.clientX, e.clientY);
        if (a) onClick(a);
      }
    });
    canvas.addEventListener("pointerleave", function () {
      lastPointer = null;
      hoverAtom = null;
      onLeave();
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      userAdjusted = true;
      zoomBy(e.deltaY);
    }, { passive: false });
    window.addEventListener("resize", resizeViewport);

    /* ---------------- 导出 PNG（超采样，所见即所得） ---------------- */
    function exportPng(scale) {
      var w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
      var base = renderer.getPixelRatio();
      /* 导出至少 2× 像素密度：普通屏导出也足够清晰 */
      var target = Math.min(Math.max(window.devicePixelRatio || 1, 2) * (scale || 1), 4);
      renderer.setPixelRatio(target);
      if (composer) { composer.setPixelRatio(target); composer.setSize(w, h); }
      render();
      var uri = canvas.toDataURL("image/png");
      renderer.setPixelRatio(base);
      if (composer) { composer.setPixelRatio(base); composer.setSize(w, h); }
      render();
      return uri;
    }

    updateCameraAspect();
    render();

    return {
      /* 结构数据（display.atoms / display.bonds / cell） */
      setDisplay: function (display, cell) {
        D = display;
        CELL = cell && cell.length === 3 ? cell : null;
        guidePoints = [];
        clearGroup(guideGroup);
        PERF_RATIO = perfRatioFor((display && display.atoms ? display.atoms.length : 0));
        updateCameraAspect();
        rebuild();
      },
      /* 测量辅助线：points 为原始笛卡尔坐标数组（与 content 同一坐标系） */
      setGuide: function (points) {
        guidePoints = (points || []).map(function (p) {
          return new THREE.Vector3(p[0], p[1], p[2]);
        });
        drawGuide();
        render();
      },
      setStyle: function (patch) {
        var needRebuild = false;
        if (patch.schemeKey !== undefined && patch.schemeKey !== STYLE.schemeKey) needRebuild = true;
        var wasBonds = STYLE.showBonds, wasCell = STYLE.showCell;
        Object.assign(STYLE, patch);
        if (STYLE.showBonds !== wasBonds || STYLE.showCell !== wasCell) needRebuild = true;
        if (needRebuild) rebuild();
        else { applyStyle(); applyFxFlags(); render(); }
      },
      setFx: function (patch) {
        var needRebuild = false;
        if (patch.quality !== undefined && patch.quality !== FX.quality) {
          FX.quality = patch.quality;
          qualKey = patch.quality;
          rebuildGeo();
          needRebuild = true;
        }
        if (patch.poly !== undefined && patch.poly !== FX.poly) needRebuild = true;
        Object.assign(FX, patch);
        if (needRebuild) rebuild();
        else { applyStyle(); applyFxFlags(); render(); }
      },
      getFx: function () { return Object.assign({}, FX); },
      /* 自检/报告出图用：返回当前相机与晶胞，便于核对"俯视沿 c、正视 c 平行屏幕"。 */
      getView: function () {
        return {
          position: camera.position.toArray(),
          target: camTarget.toArray(),
          up: camUp.toArray(),
          dir: camera.position.clone().sub(camTarget).normalize().toArray(),
          cell: CELL ? CELL.map(function (v) { return v.slice(0, 3); }) : null,
        };
      },
      /* 自检：边缘/镜像原子是否已经按正常不透明材质绘制。 */
      getRenderStats: function () {
        var ghosts = 0, opaque = true;
        atomGroup.children.forEach(function (m) {
          if (!m.userData || !m.userData.ghost) return;
          ghosts += 1;
          if (!m.material || m.material.transparent || m.material.opacity < 0.999) opaque = false;
        });
        return {ghost_atoms: ghosts, ghost_opaque: opaque,
                ghost_group_children: ghostGroup.children.length,
                cell_dash_children: cellGroup.children.length,
                cell_shadow_children: cellShadowGroup.children.length,
                cell_dash_color: cellGroup.children[0]
                  ? cellGroup.children[0].material.color.getHexString() : "",
                cell_dash_opacity: cellGroup.children[0]
                  ? cellGroup.children[0].material.opacity : null,
                pixel_ratio: renderer.getPixelRatio(),
                antialias_samples: composer && composer.renderTarget1
                  ? composer.renderTarget1.samples || 0 : 0,
                outline_visible: outlineGroup.visible,
                bonds_visible: bondGroup.visible,
                cell_visible: cellGroup.visible};
      },
      resetView: resetView,
      /* 取景留白：k>1 时相机后退，内容在画面里更小（孤立分子出图用） */
      setFrameScale: function (k) {
        frameScale = Math.max(1.0, Number(k) || 1.0);
        resetView();
      },
      viewAlong: viewAlong,
      resize: resizeViewport,
      render: render,
      exportPng: exportPng,
      pickAt: pickAt,
    };
  }

  window.SVViewer = { create: create };
})();
