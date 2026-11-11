# 结构展示组件：同事智能体接入与同屏一致性说明

日期：2026-11-10

适用代码：CalcGO 当前工作区中的 3D 结构展示组件，入口为 `structure-viewer/`。

目标：让其他同事的智能体在调用同一结构展示组件时，尽量得到与当前 CalcGO 右侧“结构展示”面板一致的：

- 结构胞选择。
- 默认观察方向、焦点和取景距离。
- 原子/键/晶胞显示方式。
- 原子颜色、描边颜色和背景。
- 成键判定和周期镜像策略。
- 光影、材质、球体精度和导出设置。

## 1. 先给结论

要做到“打开后和我显示一样”，不能只传一个 POSCAR 文件。至少需要同时满足以下六项：

1. 使用同一份经过显示胞处理的结构数据：块体优先显示惯用胞，slab/单层/吸附结构保留原胞。
2. 使用完整结构查看器页面，而不是只调用 Three.js 自己重画。
3. 传入同一组初始 `view` 参数；默认是 `studio + ballstick + cpk + 关闭 PBC`。
4. 嵌入时传入同一组宿主主题参数，或者直接沿用 `/api/viewer/{sid}?embed=1&...`。
5. 保持相同的面板宽高比。默认右侧 dock 宽度是 `420px`，可拖动到 `320px` 至视口宽度 `55%`。
6. 保留嵌入模式下的自动行为：强制开启成键；如果晶胞内没有任何键，自动打开周期镜像。

如果这六项一致，结构内容、默认朝向、颜色和大部分视觉观感会一致。绝对像素级一致还取决于窗口尺寸、浏览器、`devicePixelRatio` 和 WebGL 实现。

## 2. 组件版本与真实入口

当前前端版本：

```javascript
window.CALCGO_VIEWER_VERSION = "2026-10-30.2";
```

见 `structure-viewer/static/app.js:9`。

主应用查看器缓存版本：

```python
VIEWER_CACHE_VERSION = "34"
```

见 `calcgo/workspace.py:233`，iframe URL 中对应 `rv=34`。

推荐的真实入口：

```text
GET /api/viewer/{structure_id}
```

主应用右侧面板使用嵌入模式：

```text
GET /api/viewer/{structure_id}?embed=1&rv=34&hostTheme=...&hostMode=...
```

该入口返回完整 HTML，内部已经包含解析后的结构、Three.js、查看器前端、CSS 和默认显示逻辑。

不建议同事的智能体只复制一个 POSCAR，再自行用 Three.js 重画。自行重画很容易缺失：

- 化合键候选段。
- 周期边界闭合原子。
- 元素 CPK 配色。
- 自动观察方向。
- 原子半径和球体尺寸口径。
- 嵌入主题和自动 PBC 行为。

## 3. 当前主应用调用链

### 3.1 结构卡生成查看器 URL

主应用结构卡返回：

```python
"viewer_url": f"/api/viewer/{rec['id']}"
```

见 `calcgo/workspace.py:220`。

### 3.2 主应用把 URL 嵌入右侧 panel

主应用读取 `card.viewer_url`，见 `calcgo/web/app.js:2341`，随后调用 `swapDockFrame(url)` 和 `embedViewerFrame(...)`。

嵌入时会自动添加以下 query 参数，见 `calcgo/web/app.js:2100` 至 `calcgo/web/app.js:2119`：

| 参数 | 当前值/来源 | 作用 |
|---|---|---|
| `embed` | `1` | 使用嵌入式页面，隐藏页头、侧栏和多数工具条 |
| `rv` | `34` | 缓存版本号，避免 iframe 复用旧查看器 |
| `hostTheme` | 当前宿主主题 | 主题名称 |
| `hostMode` | `light` 或 `dark` | 画布明暗模式 |
| `hostBgTop` | CSS token `--viewer-canvas-top` | 渐变顶部色 |
| `hostBgBottom` | CSS token `--viewer-canvas-bottom` | 渐变底部色 |
| `hostOutline` | CSS token `--viewer-outline` | 原子描边色 |
| `hostCell` | CSS token `--viewer-cell` | 晶胞线色 |

示例 URL：

```text
/api/viewer/struct_xxxxxxxx?
embed=1&
rv=34&
hostTheme=ocean&
hostMode=light&
hostBgTop=%23ffffff&
hostBgBottom=%23e6edf8&
hostOutline=%2331486f&
hostCell=%2393a6cc
```

实际使用时由 `URLSearchParams` 自动编码 `#`。

### 3.3 后端生成嵌入页

`/api/viewer/{sid}` 的路由定义在 `calcgo/app.py:3414`。

当 `embed=true` 时：

- 拆出公共渲染脚本，减少切换结构时重复下载。
- 启动前隐藏页头、左侧控制栏、元素图例、工具栏和加载层。
- 将查看器容器扩展到 iframe 的 `100vh`。
- 页面加载后强制 `bondToggle = true`。
- 如果 `bondCount` 仍以 `0 条键` 开头，则自动打开 `pbcToggle`。
- 多次派发 `resize`，确保按右侧 panel 的实际宽高重新取景。

对应代码在 `calcgo/app.py:3437` 至 `calcgo/app.py:3491`。

这部分是“同为嵌入模式”的关键。独立打开 `/api/viewer/{sid}` 即使其他显示参数相同，也可能因为：

- 左侧控制栏占位导致画布宽高不同。
- 嵌入模式自动开启周期镜像。

所以画面不同。

## 4. 初始结构数据传参

### 4.1 `/api/parse` 返回的数据

查看器使用的数据格式由 `viewer_json()` 生成，见 `structure-viewer/server.py:210`。

最小结构：

```json
{
  "name": "structure.vasp",
  "atoms": {
    "el": ["Si", "Si"],
    "x": [0.0, 1.3575],
    "y": [0.0, 1.3575],
    "z": [0.0, 1.3575],
    "r": [1.1, 1.1]
  },
  "cell": [
    [5.43, 0.0, 0.0],
    [0.0, 5.43, 0.0],
    [0.0, 0.0, 5.43]
  ],
  "formula": "Si2",
  "reduced_formula": "Si",
  "n_atoms": 2,
  "volume": 160.103,
  "density": 0.5826,
  "segments": {
    "i": [0],
    "j": [1],
    "d": [2.3513],
    "dx": [1.3575],
    "dy": [1.3575],
    "dz": [1.3575]
  },
  "blocks": [],
  "n_blocks": 1
}
```

字段含义：

| 字段 | 必须 | 含义 |
|---|---|---|
| `name` | 推荐 | 文件名或结构名 |
| `atoms.el` | 是 | 原子元素符号，顺序必须与坐标一致 |
| `atoms.x/y/z` | 是 | 笛卡尔坐标，单位 Å |
| `atoms.r` | 是 | 服务端判键和球体尺寸使用的半径 |
| `cell` | 是 | 3x3 晶胞行向量矩阵 |
| `segments.i/j` | 是 | 候选键两端原子索引；`j` 可能对应周期镜像 |
| `segments.d` | 是 | 键端间距 |
| `segments.dx/dy/dz` | 是 | 从 `i` 指向镜像端 `j` 的位移 |
| `formula` | 推荐 | 完整化学式 |
| `reduced_formula` | 推荐 | 约化化学式，页面显示使用 |
| `n_atoms` | 是 | 原子数 |
| `volume` | 推荐 | 晶胞体积 |
| `density` | 推荐 | 密度 |
| `blocks/n_blocks` | CIF 推荐 | 多结构 CIF 的数据块摘要 |

不要自行改 `atoms.r`。该值来自服务端的元素半径口径，会同时影响：

- 原子球体大小。
- 键长判断。
- 不同元素之间的视觉比例。

### 4.2 显示胞必须与主应用一致

主应用不是总直接显示计算用的初原胞。`workspace.display_cell()` 会对非 slab 的立方体系尝试转换为惯用胞。

规则：

- slab、表面、单层、吸附模型：保留原结构胞。
- 非层状、对称分析得到的惯用胞为立方：继续检查原子数。
- 只有惯用胞原子数与原结构不同，且不超过 `max(200, 原原子数 × 8)` 时，才采用惯用胞。
- 计算和 POTCAR 仍使用原结构，只有 3D 显示切换为惯用胞。

实现见 `calcgo/workspace.py:22` 至 `calcgo/workspace.py:48`。

例如 fcc Pt 或 NaCl 的初原胞如果直接显示，会是 60° 的菱方盒；主应用会优先显示立方惯用胞。

因此，同事的智能体如果直接把原始初原胞交给查看器，形状可能不同。要复现主应用画面，应显示 `display_cell()` 的结果。

## 5. 初始 `view` 参数

### 5.1 当前 CalcGO 默认值

当前查看器完整默认显示配置如下：

```json
{
  "preset": "studio",
  "showPbc": false,
  "showCell": true,
  "showBonds": true,
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
    "bgBottom": "#e6edf8"
  }
}
```

这些值来自 `structure-viewer/static/app.js:160` 至 `structure-viewer/static/app.js:203`，并在启动时执行 `applyPreset("studio")`，见 `structure-viewer/static/app.js:1912`。

对于 molecule/cluster，主应用路由会把 `showCell` 改为 `false`，见 `calcgo/app.py:3423`。其他结构默认 `showCell=true`。

### 5.2 直接调用 `/api/export`

如果同事的智能体通过 `/api/export` 生成单文件 HTML，应传：

```json
{
  "name": "structure",
  "data": { "...": "POST /api/parse 的完整返回" },
  "view": { "...": "上面的完整默认 view 对象" }
}
```

`/api/export` 会把 `view` 写入离线配置，见 `structure-viewer/server.py:335`。

如果省略 `view`，查看器仍使用前端默认值，但显式传入更适合同一套智能体稳定复现。

### 5.3 主应用当前只显式传 `showCell`

主应用 `workspace.viewer_html()` 当前创建：

```python
view = {"showCell": bool(show_cell)}
```

见 `calcgo/workspace.py:332`。

其余参数由前端默认 `state` 和 `applyPreset("studio")` 补齐。

所以，若同事直接复用主应用路径，只需要保证结构数据和宿主主题相同；若自建调用层，建议把完整 `view` 显式写死，避免以后默认值变更造成显示漂移。

## 6. 风格预设

默认预设为 `studio`，对应“专业白底”。

预设会整体覆盖：

- `theme`
- `outlineColor`
- `cellColor`
- 背景模式及颜色
- 曝光
- 粗糙度
- 金属感
- 光照和环境反射
- 原子描边
- 辉光
- 暗角
- 雾
- 配位多面体模式

预设不会覆盖：

- 显示模式 `ballstick/spacefill/stick`
- 配色方案 `cpk/soft/mono`
- 原子大小
- 键粗细
- 周期镜像开关
- 晶胞开关

完整预设表：

| ID | 界面名称 | 主题 | 背景 | 背景上/下 | 原子描边 | 晶胞色 | 曝光 | 粗糙度 | 金属感 | 光强 | 环境亮度 | 环境反射 | 描边强度 | 辉光 | 暗角 | 雾 | 多面体 |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| `studio` | 专业白底 | light | grad | `#ffffff/#e6edf8` | `#31486f` | `#93a6cc` | 0.92 | 0.34 | 0.05 | 1.0 | 1.0 | 0.45 | 0.35 | 0 | 0.22 | 0 | off |
| `dark` | 深色科技 | dark | grad | `#12203a/#04070e` | `#030710` | `#5e739b` | 0.95 | 0.24 | 0.15 | 1.0 | 1.0 | 0.35 | 0.5 | 0 | 0.38 | 0 | off |
| `paper` | 期刊哑光 | light | solid | `#ffffff/#ffffff` | `#2b2b2b` | `#9a9a9a` | 1.12 | 0.78 | 0 | 1.0 | 1.0 | 0.2 | 0.45 | 0 | 0 | 0 | off |
| `metal` | 金属质感 | dark | grad | `#1b2333/#0b0f18` | `#070b14` | `#7f90b5` | 0.85 | 0.34 | 0.9 | 1.0 | 1.0 | 1.1 | 0.4 | 0 | 0.32 | 0 | off |
| `figure` | 论文插图 | light | solid | `#ffffff/#ffffff` | `#242424` | `#8d8d8d` | 1.08 | 0.85 | 0 | 0.95 | 1.0 | 0.2 | 0.5 | 0 | 0.1 | 0 | metal |
| `ball` | 球面报告 | light | solid | `#ffffff/#ffffff` | `#2a3446` | `#dbe3ec` | 1.0 | 0.30 | 0 | 1.25 | 1.0 | 0.10 | 0.70 | 0 | 0 | 0 | off |
| `poster` | 演示大片 | dark | grad | `#16274a/#03060c` | `#03060c` | `#6f86b3` | 0.98 | 0.22 | 0.25 | 1.05 | 1.0 | 0.45 | 0.5 | 0.6 | 0.38 | 0.2 | metal |

源码位置：`structure-viewer/static/app.js:1403` 至 `structure-viewer/static/app.js:1475`。

## 7. 嵌入宿主主题

### 7.1 主应用当前主题

主应用默认 `ocean`，可切换 `graphite`。初始化允许值见 `calcgo/web/index.html:9` 至 `calcgo/web/index.html:19`。

当前主题对查看器画布的覆盖值：

| 主题 | 画布顶部 | 画布底部 | 原子描边 | 晶胞 |
|---|---|---|---|---|
| `ocean` | `#ffffff` | `#e6edf8` | `#31486f` | `#93a6cc` |
| `graphite` | `#1d2327` | `#0c0f11` | `#060809` | `#6d8b89` |

CSS token 见 `calcgo/web/style.css:2289` 和 `calcgo/web/style.css:2373`。

### 7.2 主题消息

主应用发送的消息格式：

```json
{
  "type": "calcgo-viewer-theme",
  "theme": "ocean",
  "mode": "light",
  "bgTop": "#ffffff",
  "bgBottom": "#e6edf8",
  "outline": "#31486f",
  "cell": "#93a6cc"
}
```

生成逻辑见 `calcgo/web/app.js:2054`。

查看器收到消息后只覆盖：

- `state.theme`
- `state.hostTheme`
- `state.outlineColor`
- `state.cellColor`
- `state.fx.bgMode = "grad"`
- `state.fx.bgTop`
- `state.fx.bgBottom`

对应代码在 `structure-viewer/static/app.js:1479` 至 `structure-viewer/static/app.js:1501`。

主题不会改变：

- 原子元素配色。
- 当前显示模式。
- 原子大小和键粗细。
- 成键容差。
- PBC 开关。

### 7.3 通信时序

1. 查看器加载。
2. 查看器向父页面发送 `{"type":"calcgo-viewer-ready"}`。
3. 父页面找到对应 iframe。
4. 父页面发送 `calcgo-viewer-theme`。
5. 查看器应用主题并重绘。

父页面监听见 `calcgo/web/app.js:2091`，查看器发送 ready 见 `structure-viewer/static/app.js:1523`。

## 8. 原子配色

### 8.1 三种配色方案

当前界面只提供三种方案：

| `scheme` | 界面名称 | 算法 |
|---|---|---|
| `cpk` | 标准 CPK（元素色） | 使用完整 Jmol CPK 元素色表 |
| `soft` | 柔和（粉彩） | 将 CPK 色与白色按 42% 混合 |
| `mono` | 单色（论文图） | 所有元素统一为 `#8b99b3` |

核心代码：

```javascript
function schemeColor(el, scheme) {
  const c = baseColor(el);
  if (scheme === "soft") return mixHex(c, "#ffffff", 0.42);
  if (scheme === "mono") return "#8b99b3";
  return c;
}
```

见 `structure-viewer/static/app.js:70`。

默认 `scheme = "cpk"`，见 `structure-viewer/static/app.js:169`。

### 8.2 未收录元素的兜底色

如果元素不在 CPK 表中，按元素符号做稳定哈希，从 12 个柔和颜色中选择：

```text
#7aa2ff #ff8fa3 #5fd4b8 #ffc46b #c49bff #63c6ea
#f28fc8 #a9d26e #e28f6e #86a8e7 #b7b8d8 #8fe0a8
```

算法见 `structure-viewer/static/app.js:42` 至 `structure-viewer/static/app.js:68`。

正常元素应使用标准 CPK 表，不建议让智能体自行生成颜色。

### 8.3 完整 CPK 元素色表

| 元素 | CPK | 元素 | CPK | 元素 | CPK | 元素 | CPK |
|---|---|---|---|---|---|---|---|
| H | #ffffff | He | #d9ffff | Li | #cc80ff | Be | #c2ff00 |
| B | #ffb5b5 | C | #909090 | N | #3050f8 | O | #ff0d0d |
| F | #90e050 | Ne | #b3e3f5 | Na | #ab5cf2 | Mg | #8aff00 |
| Al | #bfa6a6 | Si | #f0c8a0 | P | #ff8000 | S | #ffff30 |
| Cl | #1ff01f | Ar | #80d1e3 | K | #8f40d4 | Ca | #3dff00 |
| Sc | #e6e6e6 | Ti | #bfc2c7 | V | #a6a6ab | Cr | #8a99c7 |
| Mn | #9c7ac7 | Fe | #e06633 | Co | #f090a0 | Ni | #50d050 |
| Cu | #c88033 | Zn | #7d80b0 | Ga | #c28f8f | Ge | #668f8f |
| As | #bd80e3 | Se | #ffa100 | Br | #a62929 | Kr | #5cb8d1 |
| Rb | #702eb0 | Sr | #00ff00 | Y | #94ffff | Zr | #94e0e0 |
| Nb | #73c2c9 | Mo | #54b5b5 | Tc | #00a1a1 | Ru | #248f8f |
| Rh | #0a7d8c | Pd | #006985 | Ag | #c0c0c0 | Cd | #ffd98f |
| In | #a67573 | Sn | #668080 | Sb | #9e63b5 | Te | #d47a00 |
| I | #940094 | Xe | #429eb0 | Cs | #57178f | Ba | #00c900 |
| La | #70d4ff | Ce | #ffffc7 | Pr | #d9ffc7 | Nd | #c7ffc7 |
| Pm | #a3ffc7 | Sm | #8fffc7 | Eu | #61ffc7 | Gd | #45ffc7 |
| Tb | #30ffc7 | Dy | #1fffc7 | Ho | #00ff9c | Er | #00e675 |
| Tm | #00d452 | Yb | #00bf38 | Lu | #00ab24 | Hf | #4dc2ff |
| Ta | #4da6ff | W | #2194d6 | Re | #267dab | Os | #266696 |
| Ir | #175487 | Pt | #d0d0e0 | Au | #ffd123 | Hg | #b8b8d0 |
| Tl | #a6544d | Pb | #575961 | Bi | #9e4fb5 | Po | #ab5c00 |
| At | #754f45 | Rn | #428296 | Fr | #420066 | Ra | #007d00 |
| Ac | #70abfa | Th | #00baff | Pa | #00a1ff | U | #008fff |
| Np | #0080ff | Pu | #006bff | Am | #545cf2 | Cm | #785fe2 |
| Bk | #8a4fe2 | Cf | #a136d4 | Es | #b31fd4 | Fm | #b31fba |
| Md | #b30da6 | No | #bd0d87 | Lr | #c70066 | Rf | #cc0059 |
| Db | #d1004f | Sg | #d90045 | Bh | #e00038 | Hs | #e6002e |
| Mt | #eb0026 | Ds | #eb0026 | Rg | #eb0026 | Cn | #eb0026 |
| Nh | #eb0026 | Fl | #eb0026 | Mc | #eb0026 | Lv | #eb0026 |
| Ts | #eb0026 | Og | #eb0026 |  |  |  |  |

源码位置：`structure-viewer/static/app.js:15` 至 `structure-viewer/static/app.js:40`。

### 8.4 颜色实际用于哪些元素

| 对象 | 使用颜色 |
|---|---|
| 原子球 | `schemeColor(element, scheme)` |
| 键的两半 | 左半用 `ei` 元素色，右半用 `ej` 元素色 |
| 配位多面体 | 中心元素色乘 0.76，并设为半透明 |
| 元素图例 | 与原子球使用同一个 `schemeColor()` |
| 原子描边 | 使用风格预设或宿主主题的统一描边色，不是元素色 |
| 晶胞线 | 使用风格预设或宿主主题的统一晶胞色 |

双色半键实现见 `structure-viewer/static/viewer3d.js:422` 至 `structure-viewer/static/viewer3d.js:430`。

### 8.5 当前默认颜色检查值

在默认 `cpk` 下，运行时读取到：

```text
Si = #f0c8a0
Fe = #e06633
O  = #ff0d0d
Pd = #006985
Pt = #d0d0e0
```

这组检查值可以用来确认同事端没有套错兜底色或旧版查表。

## 9. 原子、键和晶胞的尺寸

### 9.1 原子半径

服务端为每个元素生成 `atoms.r`：

- H 固定覆盖为 `0.37 Å`。
- 其他元素优先使用共价半径。
- 无共价半径时使用原子半径。

服务端见 `structure-viewer/server.py:43` 至 `structure-viewer/server.py:75`。

前端球体尺寸：

```text
base = clamp(r * 0.45, 0.28, 0.75)
modeFactor:
  ballstick = 1.0
  stick = 0.32
  spacefill = 1.85
radius = clamp(base * modeFactor * atomScale, 0.06, 2.4)
```

见 `structure-viewer/static/app.js:1019`。

### 9.2 显示模式

| `mode` | 界面名称 | 原子倍率 | 键显示 |
|---|---|---:|---|
| `ballstick` | 球棍 | 1.0 | 显示 |
| `spacefill` | 空间填充 | 1.85 | 强制隐藏 |
| `stick` | 棍状 | 0.32 | 显示，且键更粗 |

`spacefill` 隐藏键来自 `viewerStyle()` 中的：

```javascript
showBonds: state.showBonds && state.mode !== "spacefill"
```

见 `structure-viewer/static/app.js:450`。

### 9.3 键粗细

```text
base = 0.09
if mode == "stick": base *= 1.45
radius = max(0.02, base * bondScale)
```

见 `structure-viewer/static/app.js:1033`。

默认 `bondScale = 1.0`。

界面可调范围：

| 参数 | 默认值 | 范围 | 步长 |
|---|---:|---:|---:|
| `atomScale` | 1.00 | 0.60–2.00 | 0.05 |
| `bondScale` | 1.00 | 0.40–2.60 | 0.05 |

控件定义见 `structure-viewer/static/index.html:113` 和 `structure-viewer/static/index.html:117`。

### 9.4 晶胞线粗细

```text
cellRadius = max(0.012, 0.028 * bondScale * 0.75)
```

见 `structure-viewer/static/app.js:1044`。

## 10. 成键判定和周期显示

### 10.1 默认成键

默认：

```text
showBonds = true
tolerance = 1.15
pairFilters = 空集合
```

服务端预计算候选键段，前端按当前 tolerance 和元素对实时过滤。

普通元素对：

```text
maxBond = (r_i + r_j) * tolerance
```

O-O 过氧键有额外上限：

```text
O-O maximum = 1.55 Å
```

见 `structure-viewer/static/app.js:209` 和 `structure-viewer/static/app.js:674`。

### 10.2 键长容差

| 项 | 默认值 | 范围 | 步长 |
|---|---:|---:|---:|
| `tolerance` | 1.15 | 1.00–1.40 | 0.01 |

拖动容差只在前端重新过滤候选段，不重新请求解析接口。

### 10.3 元素对筛选

初始没有筛选，所有候选元素对都显示。

点击某个元素对后，只显示选中的元素对；再次点击取消。换结构时会自动清空旧筛选。

### 10.4 周期镜像

默认 `showPbc = false`。

注意，“周期镜像关闭”不等于“完全没有边界补位”：

- `showPbc=false` 使用 `buildClosedCell()`。
- 晶胞内原子全部显示。
- 恰好落在面、棱、角上的原子，会补到其它边界位置。
- 补齐其跨边界键，避免边缘只有半个球。
- 不显示完整邻胞 halo。

`showPbc=true` 使用 `buildFullPeriodic()`：

- 显示晶胞内原子。
- 补齐晶胞边界外的镜像原子，范围为 `min(2 × 当前最大候选键长 + 0.2 Å, 12 Å)`。
- 同时补齐镜像原子之间的跨边界键。
- 超过 `MAX_PBC_ATOMS=3500` 时降级为 `buildSparse()`，只补键端原子。

实现见 `structure-viewer/static/app.js:710` 至 `structure-viewer/static/app.js:1015`。

### 10.5 嵌入模式的额外行为

主应用 iframe 加载后会：

1. 强制 `showBonds=true`。
2. 如果页面显示的键数是 `0`，自动打开周期镜像。

后端 boot JS 和父页面 `embedViewerFrame` 都有这一逻辑，见：

- `calcgo/app.py:3464`
- `calcgo/web/app.js:2177`

如果同事的智能体只是打开查看器、不经过 embedding，必须自己执行相同的规则，否则边界结构可能少一组镜像键。

## 11. 默认相机与视角

### 11.1 默认焦点

结构导入后执行 `resetView()`，焦点设为原子包围盒中心：

```javascript
camTarget.copy(box.getCenter(...))
```

见 `structure-viewer/static/viewer3d.js:710`。

焦点不是晶胞框中心，也不是某个指定原子。这样 slab 的真空层不会把原子层压成画面中心的一小团。

### 11.2 有晶胞时的默认方向

`c` 轴作为屏幕上方。视线方向先由：

```text
0.85 * a + 0.55 * b
```

投影到垂直于 `c` 的平面，再叠加：

```text
+ 0.45 * c
```

最后归一化。

见 `structure-viewer/static/viewer3d.js:730` 至 `structure-viewer/static/viewer3d.js:747`。

### 11.3 无晶胞时的默认方向

固定方向：

```text
normalize(0.78, 0.62, 0.95)
```

屏幕上方：

```text
(0, 1, 0)
```

### 11.4 默认相机距离

```text
distance = max(
  radius / sin(verticalFov / 2),
  radius / sin(horizontalFov / 2)
) * 1.12 * frameScale
```

相机 FOV 为 32°，`frameScale` 默认 1.0。

见 `structure-viewer/static/viewer3d.js:98` 和 `structure-viewer/static/viewer3d.js:723`。

### 11.5 视角预设

| 控件 | 方向/行为 |
|---|---|
| 适应/重置 | 重新使用原子包围盒中心和自动方向 |
| `+a/-a` | 沿晶胞 a 轴观察，c 作为屏幕上方 |
| `+b/-b` | 沿晶胞 b 轴观察，c 作为屏幕上方 |
| `+c/-c` | 沿晶胞 c 轴观察，b 的投影作为屏幕上方 |

预设实现见 `structure-viewer/static/app.js:1571`。

### 11.6 鼠标旋转

- 左键围绕当前 `camTarget` 旋转。
- 右键平移相机和 `camTarget`。
- 滚轮改变相机到焦点距离。
- 单击原子只显示信息或记录测量点，不改变旋转中心。

自定义旋转见 `structure-viewer/static/viewer3d.js:800` 至 `structure-viewer/static/viewer3d.js:837`。

### 11.7 面板尺寸会影响取景

在用户尚未拖动或缩放时，查看器在 resize 后会重新执行 `resetView()`。因此同样的结构：

- 420px 宽右侧 panel。
- 1012px 宽独立画布。

可能得到不同的相机距离和留白，这是正常的宽高比适配。

要视觉尽量一致，建议同事端使用与当前右侧 panel 相同的宽度和高度关系。当前默认宽度为 `420px`，见 `calcgo/web/style.css:388`。

## 12. 光影、背景、材质和精度

### 12.1 默认高级参数

| 参数 | 默认 | 可调范围 | 步长 |
|---|---:|---:|---:|
| `lightPower` | 1.0 | 0.3–3.0 | 0.05 |
| `exposure` | 0.92 | 0.35–1.8 | 0.02 |
| `roughness` | 0.34 | 0.05–1.0 | 0.01 |
| `metalness` | 0.05 | 0–1 | 0.01 |
| `envRefl` | 0.45 | 0–2 | 0.05 |
| `envPower` | 1.0 | 0–2 | 0.05 |
| `outline` | 0.35 | 0–1 | 0.05 |
| `bloom` | 0 | 0–1.5 | 0.05 |
| `vignette` | 0.22 | 0–1 | 0.05 |
| `fog` | 0 | 0–1 | 0.05 |

### 12.2 背景

| `bgMode` | 效果 |
|---|---|
| `grad` | 上/下双色渐变，默认 |
| `solid` | 纯色 |
| `none` | 透明背景，导出 PNG 时保留 alpha |

默认上色 `#ffffff`，下色 `#e6edf8`。

### 12.3 配位多面体

| `poly` | 效果 |
|---|---|
| `off` | 关闭，默认 |
| `metal` | 只为金属中心画多面体 |
| `all` | 为所有具备至少 4 个配位邻居的原子画多面体 |

多面体颜色是中心原子色乘 0.76，透明度 0.30。

### 12.4 球体精度

| `quality` | 球体/键/晶胞几何分段 |
|---|---|
| `fast` | `24/16/10` |
| `std` | `48/32/18`，默认 |
| `fine` | `72/48/28` |

见 `structure-viewer/static/viewer3d.js:14`。

## 13. PNG、图例和离线导出

### 13.1 PNG

默认导出倍率 `exportScale=1`，可选：

- `1`：当前。
- `2`：2× 高清。
- `3`：3× 超清。

实际像素倍率：

```text
min(max(devicePixelRatio, 2) * exportScale, 4)
```

见 `structure-viewer/static/viewer3d.js:944`。

### 13.2 元素图例

图例球和 3D 原子共用 `schemeColor()`，因此：

- CPK 模式下图例是 CPK 色。
- soft 模式下图例是混合后的柔和色。
- mono 模式下图例全部是 `#8b99b3`。

图例导出接口：

```javascript
window.SVViewerExportLegend(scale)
```

### 13.3 离线 HTML

当前 `view` 保存视觉配置，但不保存精确相机姿态。

导出字段包括：

```text
preset, showPbc, showCell, showBonds, mode, scheme,
atomScale, bondScale, tolerance, exportScale, fx
```

对应代码在 `structure-viewer/static/app.js:1768` 至 `structure-viewer/static/app.js:1781`。

它不包含：

- `outlineColor`
- `cellColor`
- `theme`
- `hostTheme`
- 相机 `position/target/up`

所以从嵌入主题导出离线 HTML 时：

- 背景色在 `fx.bgTop/bgBottom` 中，可以保留。
- 原子描边与晶胞线不会保留宿主主题颜色；重新应用 `studio` 预设后会回到 `#31486f` 和 `#93a6cc`。
- 相机姿态不会保留，打开文件后会重新自动取景。

如果同事要求“打开就是导出前完全相同的旋转角度和嵌入主题”，需要额外扩展 `view`，保存相机姿态以及宿主描边/晶胞色；现有版本没有这些字段。

## 14. 推荐接入方式

### 14.1 最稳妥：复用完整查看器 iframe

如果同事的系统已经有 CalcGO API：

```javascript
const frame = document.querySelector("#structure-viewer");
const url = new URL(`/api/viewer/${structureId}`, location.origin);
url.searchParams.set("embed", "1");
url.searchParams.set("rv", "34");
url.searchParams.set("hostTheme", "ocean");
url.searchParams.set("hostMode", "light");
url.searchParams.set("hostBgTop", "#ffffff");
url.searchParams.set("hostBgBottom", "#e6edf8");
url.searchParams.set("hostOutline", "#31486f");
url.searchParams.set("hostCell", "#93a6cc");
frame.src = url.href;
```

这是最推荐的方式，因为默认风格、原子颜色、相机和自动 PBC 都由同一套前端控制。

### 14.2 需要自定义宿主时

必须保留以下行为：

1. `/api/viewer/{sid}` 返回的 HTML 不拆改。
2. `embed=1` 时保留后端 boot CSS/JS。
3. iframe 尺寸与默认 dock 相同。
4. 主题消息格式不变。
5. 不覆盖查看器内部的 `schemeColor()`。
6. 不自行重算元素颜色和球体半径。

### 14.3 只使用底层 `SVViewer` 引擎时

调用顺序建议：

```javascript
const viewer = window.SVViewer.create(container, {
  onHover,
  onLeave,
  onClick,
});

viewer.setStyle({
  colorOf: (el) => schemeColor(el, "cpk"),
  radiusOf: (el, r) => sphereRadius(el, r),
  bondRadius: () => bondRadius(),
  cellRadius: () => cellRodRadius(),
  cellColor: "#93a6cc",
  showBonds: true,
  showCell: true,
  schemeKey: "cpk",
  outlineColor: "#31486f",
});

viewer.setFx({
  quality: "std",
  poly: "off",
  outline: 0.35,
  bloom: 0,
  vignette: 0.22,
  fog: 0,
  envRefl: 0.45,
  envPower: 1,
  lightPower: 1,
  exposure: 0.92,
  roughness: 0.34,
  metalness: 0.05,
  bgMode: "grad",
  bgTop: "#ffffff",
  bgBottom: "#e6edf8",
});

viewer.setDisplay(display, data.cell);
viewer.setFrameScale(1.0);
viewer.resetView();
```

这里的 `display` 必须由完整结构的 `buildDisplay()` 生成，包含：

- base/mirror 原子。
- 边界补齐。
- 双色键。
- 原子 `r` 值。

不能只把 `atoms.x/y/z` 转成一个自定义球体数组。

## 15. 运行时自查

在独立查看器控制台执行：

```javascript
({
  version: window.CALCGO_VIEWER_VERSION,
  scheme: state.scheme,
  mode: state.mode,
  preset: state.preset,
  showBonds: state.showBonds,
  showCell: state.showCell,
  showPbc: state.showPbc,
  tolerance: state.tolerance,
  atomScale: state.atomScale,
  bondScale: state.bondScale,
  fx: state.fx,
  view: state.viewer.getView(),
  colors: {
    Si: schemeColor("Si", state.scheme),
    Fe: schemeColor("Fe", state.scheme),
    O: schemeColor("O", state.scheme),
    Pd: schemeColor("Pd", state.scheme),
    Pt: schemeColor("Pt", state.scheme)
  }
})
```

当前默认实际运行快照：

```json
{
  "version": "2026-10-30.2",
  "scheme": "cpk",
  "mode": "ballstick",
  "preset": "studio",
  "showBonds": true,
  "showCell": true,
  "showPbc": false,
  "tolerance": 1.15,
  "atomScale": 1,
  "bondScale": 1,
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
    "bgBottom": "#e6edf8"
  },
  "colors": {
    "Si": "#f0c8a0",
    "Fe": "#e06633",
    "O": "#ff0d0d",
    "Pd": "#006985",
    "Pt": "#d0d0e0"
  }
}
```

## 16. 同屏一致性验收清单

### 16.1 服务与版本

```text
GET /api/meta
viewer.mode = embedded
viewer.alive = true
```

```text
GET /api/viewer/{sid}
HTTP 200
```

```text
window.CALCGO_VIEWER_VERSION = "2026-10-30.2"
iframe URL rv = 34
```

### 16.2 默认显示值

同事端页面的 `state` 应与第 5 节完全一致。

### 16.3 颜色

至少在 CPK 模式下检查：

```text
Si #f0c8a0
Fe #e06633
O  #ff0d0d
Pd #006985
Pt #d0d0e0
```

### 16.4 相机

调用：

```javascript
state.viewer.getView()
```

对比：

- `position`。
- `target`。
- `up`。
- `dir`。

如果结构相同、画布宽高比相同、显示模式相同，这些值应非常接近。

### 16.5 嵌入行为

验证：

- iframe 页头已隐藏。
- 左侧控制栏已隐藏。
- 成键开关为开。
- 对无键边界结构，`pbcToggle` 自动打开。
- 窗口或 panel resize 后画布没有上下留白。

## 17. 已知差异和限制

1. 主应用右侧 dock 默认宽 420px，独立查看器通常是整页宽度；默认相机距离会因宽高比不同而变化。
2. 主应用嵌入模式会自动开启成键，必要时开启 PBC；独立模式不自动替用户打开 PBC。
3. 主应用可能把立方初原胞显示成惯用胞；直接传原始 POSCAR 可能显示为斜盒。
4. `studio` 是当前默认材质预设；切换宿主主题只改背景、描边和晶胞色，不改原子元素色。
5. 当前没有自定义元素色输入接口，只有 `cpk/soft/mono` 三种稳定方案。
6. 当前没有保存精确相机姿态的配置；离线 HTML 会重新自动取景。
7. 不同浏览器、显卡和 `devicePixelRatio` 会造成抗锯齿、锐度和像素细节差异。
8. 当前上传文件上限为 20 MB，原子数上限为 15000，候选键段上限为 500000。
9. PBC 完整补全超过 3500 原子时会降级为稀疏补键。
10. 离线 HTML 不保存宿主主题的描边色和晶胞色，也不保存当前相机姿态。

## 18. 源码索引

| 内容 | 位置 |
|---|---|
| 前端版本号 | `structure-viewer/static/app.js:9` |
| 完整 CPK 色表 | `structure-viewer/static/app.js:15` |
| soft/mono 配色算法 | `structure-viewer/static/app.js:70` |
| 默认 `state` | `structure-viewer/static/app.js:160` |
| 默认预设启动 | `structure-viewer/static/app.js:1912` |
| 风格预设表 | `structure-viewer/static/app.js:1403` |
| 宿主主题 | `structure-viewer/static/app.js:1479` |
| 显示模式与样式参数 | `structure-viewer/static/app.js:442` |
| 原子半径 | `structure-viewer/static/app.js:1019` |
| 键和晶胞粗细 | `structure-viewer/static/app.js:1033` |
| 成键过滤 | `structure-viewer/static/app.js:674` |
| 周期镜像/闭合晶胞 | `structure-viewer/static/app.js:710` |
| 默认相机取景 | `structure-viewer/static/viewer3d.js:710` |
| 左键旋转/右键平移/缩放 | `structure-viewer/static/viewer3d.js:800` |
| 双色半键 | `structure-viewer/static/viewer3d.js:422` |
| 解析返回数据 | `structure-viewer/server.py:210` |
| 离线导出入口 | `structure-viewer/server.py:335` |
| 显示胞处理 | `calcgo/workspace.py:22` |
| 主应用查看器 URL | `calcgo/workspace.py:220` |
| 主应用单端口生成 | `calcgo/workspace.py:311` |
| iframe query 参数 | `calcgo/web/app.js:2100` |
| iframe 主题消息 | `calcgo/web/app.js:2054` |
| iframe 自动成键/PBC | `calcgo/web/app.js:2177` |
| 后端 embed CSS/JS | `calcgo/app.py:3437` |
| 主应用主题 token | `calcgo/web/style.css:2269` |
