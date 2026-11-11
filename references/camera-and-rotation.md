# 结构展示：默认视角与鼠标旋转机制说明

日期：2026-11-09

适用范围：CalcGO 结构展示子系统，包括独立 3D 结构查看器和主应用内的单结构/轨迹数据查看器。

## 1. 结论摘要

1. 结构导入后会执行一次自动取景，不存在单独暴露给用户的 `default_view_angle`、`initial_camera_position` 或类似配置项。
2. 自动取景以原子几何包围盒中心作为观察焦点，并优先根据晶胞的 `a/b/c` 轴选择默认朝向。
3. 鼠标左键旋转围绕当前观察焦点 `camTarget` 进行，不围绕鼠标点击位置，也不自动围绕被点击的原子。
4. 鼠标右键平移会同时移动相机和观察焦点；平移后，再旋转时围绕的是新的焦点。
5. 滚轮只改变相机与焦点之间的距离，不改变焦点位置。
6. 单击原子不会重新设置旋转中心。普通模式下单击只显示原子信息，测量模式下单击只记录测量点。
7. 多类型轨迹查看器使用 Three.js `OrbitControls`，交互语义与上面的描述一致。

## 2. 涉及代码

| 文件 | 职责 |
|---|---|
| `structure-viewer/static/app.js` | 导入结构、刷新显示、调用默认取景、处理视角预设和点击原子 |
| `structure-viewer/static/viewer3d.js` | Three.js 场景、相机、观察焦点、自动取景和自定义鼠标旋转 |
| `structure-viewer/dataset-viewer/src/atomistic.js` | 多类型查看器中的原子/轨迹场景和 `OrbitControls` |
| `structure-viewer/server.py` | 解析结构、生成离线 HTML；离线配置中保存显示参数 |

## 3. 从“导入结构”到“出现默认视角”的调用链

单结构查看器的主流程如下：

```text
用户选择/拖入 POSCAR、CIF
  -> uploadText()
  -> POST /api/parse
  -> renderStructure(data)
  -> refreshData()
  -> viewer.setDisplay(display, cell)
  -> viewer3d.rebuild()
  -> viewer3d.centerAndFrame()
  -> app.renderStructure() 再明确调用 viewer.resetView()
  -> 显示自动计算后的默认视角
```

关键入口在 `structure-viewer/static/app.js:487`。结构数据赋值后，`refreshData()` 把几何和晶胞交给查看器；只要不是轨迹逐帧保留视角的场景，就会调用 `resetView()`：

```javascript
const display = refreshData();
if (state.viewer && !o.keepView) state.viewer.resetView();
```

完整调用如下：

```text
renderStructure(data)
  -> refreshData()
  -> v.setStyle()
  -> v.setDisplay(display, cell)
  -> resetView()
```

其中 `refreshData()` 位于 `structure-viewer/static/app.js:458`，`setDisplay()` 位于 `structure-viewer/static/viewer3d.js:965`。

## 4. 默认展示视角的计算方法

### 4.1 观察焦点：原子包围盒中心

`resetView()` 首先创建包围盒：

```javascript
var box = new THREE.Box3().setFromObject(atomGroup);
if (box.isEmpty()) box.setFromObject(content);
```

对应的代码在 `structure-viewer/static/viewer3d.js:715`。

包围盒中心随后被复制给 `camTarget`：

```javascript
var center = box.getCenter(new THREE.Vector3());
camTarget.copy(center);
```

对应位置是 `structure-viewer/static/viewer3d.js:719` 和 `structure-viewer/static/viewer3d.js:727`。

这里有两个重要含义：

- 旋转焦点是“原子的几何中心”，不是晶胞框的几何中心。
- 对表面 slab 而言，晶胞 `c` 方向通常包含大面积真空层。如果直接用整个晶胞框取景，原子层会被压缩在画面中央的一小块区域，因此当前实现故意只用原子内容的包围盒决定相机中心和距离。

晶胞框仍然会被绘制，只是不参与默认相机的距离计算。

### 4.2 有晶胞时的默认朝向

有晶胞时，默认朝向与晶胞坐标轴绑定。

先从晶胞取三根轴：

```text
a = CELL[0]
b = CELL[1]
c = CELL[2]
```

屏幕上方首先设置为晶胞 `c` 轴：

```javascript
camUp.copy(cAxis);
```

然后计算一个位于垂直于 `c` 平面内的方向：

```text
inPlane = 0.85 * a + 0.55 * b
inPlane = inPlane - c * dot(inPlane, c)
```

代码先把 `a/b` 组合成偏向 `a` 的平面方向，再减去它在 `c` 上的投影，使其严格垂直于 `c`。对应代码位于 `structure-viewer/static/viewer3d.js:735` 至 `structure-viewer/static/viewer3d.js:743`。

得到平面内方向后，再沿 `c` 轴加一个倾斜量：

```javascript
camDir.addScaledVector(cAxis, 0.45).normalize();
```

对应代码位于 `structure-viewer/static/viewer3d.js:744` 至 `structure-viewer/static/viewer3d.js:746`。

可以把它理解为：

- 从斜上方观察晶胞。
- `c` 轴在画面中大致朝上。
- 水平方向略偏向晶胞 `a` 轴。
- 相比正俯视，视线向表面方向俯下约二十多度，因此原子层既有俯视层次，也不完全失去侧向厚度。

### 4.3 没有晶胞时的默认朝向

孤立分子或没有有效晶胞的模型使用固定初始方向：

```javascript
var camDir = new THREE.Vector3(0.78, 0.62, 0.95).normalize();
camUp.set(0, 1, 0);
```

对应代码是 `structure-viewer/static/viewer3d.js:728` 和 `structure-viewer/static/viewer3d.js:729`。

最终方向是：

```text
normalize(0.78, 0.62, 0.95)
```

这表示从世界坐标的右前上方观察，世界 `+Y` 方向作为屏幕上方。

### 4.4 相机距离与留白

默认相机距离不是常数，而是按原子尺寸、相机竖直视场、画面宽高比和留白系数计算：

```text
verticalDistance   = radius / sin(verticalHalfFov)
horizontalDistance = radius / sin(horizontalHalfFov)
distance = max(verticalDistance, horizontalDistance) * 1.12 * frameScale
```

对应代码位于 `structure-viewer/static/viewer3d.js:723` 至 `structure-viewer/static/viewer3d.js:726`。

其中：

- `radius` 来自原子包围盒尺寸。
- 宽高比越窄，水平视场越小，相机就需要退得更远，避免左右两边被裁掉。
- `1.12` 是基础留白。
- `frameScale` 默认为 `1.0`，可通过 `setFrameScale(k)` 调大，使结构在画面中更小，适合单独分子或报告插图。

相机的最近裁剪面和最远裁剪面也会随距离更新：

```javascript
camera.near = Math.max(0.05, dist / 100);
camera.far = Math.max(1000, dist * 100);
```

对应位置是 `structure-viewer/static/viewer3d.js:750`。

### 4.5 自动重新取景与用户操作

查看器内部有一个 `userAdjusted` 标记。

- 初始导入后，`userAdjusted = false`。
- 用户拖动或滚轮操作后，`userAdjusted = true`。
- 如果用户还没有操作，窗口或面板尺寸变化时会重新计算默认取景，避免旧宽高下的相机距离导致结构被裁切。
- 用户已经操作后，面板尺寸变化只重绘，不覆盖用户当前视角。

对应代码：

```javascript
if (framed && !userAdjusted) resetView();
else render();
```

位于 `structure-viewer/static/viewer3d.js:761` 至 `structure-viewer/static/viewer3d.js:766`。

## 5. 是否存在“单独的默认视角设置”

### 5.1 当前状态

当前没有一个独立的、持久化到结构文件或任务元数据中的默认视角配置。

具体表现是：

- 导入结构后总是执行自动取景。
- 默认方向由晶胞轴和原子包围盒动态决定。
- 没有 `initial_position`、`initial_target`、`default_view_angle` 这类输入字段。
- “重置视角”和“适应视图”都复用同一个 `resetView()`。

从功能角度看，默认视角是“随结构自动计算的结果”，不是“每个结构单独保存的相机状态”。

### 5.2 现有可单独控制的部分

虽然完整相机姿态没有独立配置，但以下参数可以在代码层控制：

| 能力 | 接口 | 作用 |
|---|---|---|
| 留白 | `setFrameScale(k)` | 改变默认取景的远近，`k > 1` 时相机后退 |
| 指定观察方向 | `viewAlong(dir, up)` | 沿任意世界方向观察，并指定屏幕上方 |
| 读取相机状态 | `getView()` | 返回当前位置、焦点、上方向和视线方向 |
| 重置 | `resetView()` | 回到当前结构的自动默认视角 |
| 晶轴视角 | `+a/-a/+b/-b/+c/-c` | 沿晶轴观察，但这是用户主动选择的预设 |

`setFrameScale()` 和 `viewAlong()` 的接口定义位于 `structure-viewer/static/viewer3d.js:1040` 和 `structure-viewer/static/viewer3d.js:1044`。

### 5.3 离线 HTML 是否保存当前视角

离线 HTML 当前保存的是显示配置，不是相机的精确位置和旋转角。

`exportViewState()` 包含：

- 风格预设。
- 周期镜像开关。
- 晶胞开关。
- 成键开关。
- 显示模式。
- 配色方案。
- 原子大小和键粗细。
- 键长容差。
- 导出倍率。
- 光影参数。

对应代码位于 `structure-viewer/static/app.js:1768` 至 `structure-viewer/static/app.js:1781`。

这份配置中没有 `camera.position`、`camTarget` 或 `camera.up`。因此，即使用户在导出前旋转过结构，离线 HTML 打开时仍会重新执行结构的默认自动取景。

## 6. 鼠标旋转的工作方式

### 6.1 左键旋转

单结构查看器没有直接使用 `OrbitControls`，而是使用自定义轨道旋转。

每次旋转前，先计算相机相对观察焦点的偏移：

```javascript
var off = camera.position.clone().sub(camTarget);
```

随后围绕当前屏幕上方旋转这个偏移，并围绕当前屏幕右方旋转这个偏移：

```javascript
var qy = new THREE.Quaternion().setFromAxisAngle(up, -dx * 0.006);
off.applyQuaternion(qy);

var fwd = off.clone().negate().normalize();
var right = new THREE.Vector3().crossVectors(fwd, up);
var qp = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.006);
off.applyQuaternion(qp);
```

最后用同一个焦点重新放置相机：

```javascript
camera.position.copy(camTarget).add(off);
```

完整实现位于 `structure-viewer/static/viewer3d.js:800` 至 `structure-viewer/static/viewer3d.js:819`。

等价地写：

```text
新相机位置 = 焦点 + 旋转后的相机偏移
```

因为焦点本身没有变化，所以左键旋转就是标准的“围绕焦点做轨道旋转”。

### 6.2 为什么不是围绕鼠标点击位置

`orbitDrag()` 只接收鼠标位移 `dx/dy`，没有接收点击位置的射线交点，也没有修改 `camTarget`。

因此：

- 鼠标按在哪个原子上，不会决定旋转轴的位置。
- 鼠标在画面中心还是边缘按下，旋转焦点仍然是当前 `camTarget`。
- 点击原子不会自动把该原子设置成新的旋转中心。

单击检测位于 `structure-viewer/static/viewer3d.js:921` 至 `structure-viewer/static/viewer3d.js:929`。如果移动距离小于 5 像素，会被判定为点击，并调用 `onClick(a)`。

`onAtomClick()` 的实际行为只有两种：

1. 测量模式：记录原子坐标作为测距或测角点。
2. 普通模式：显示原子信息提示。

代码位于 `structure-viewer/static/app.js:1099` 至 `structure-viewer/static/app.js:1110`，没有修改 `camTarget`。

### 6.3 右键平移

右键拖动会移动观察焦点和相机：

```javascript
camTarget.add(delta);
camera.position.add(delta);
```

对应代码位于 `structure-viewer/static/viewer3d.js:821` 至 `structure-viewer/static/viewer3d.js:829`。

因此右键平移不只是“移动模型”，而是在移动整个观察坐标系。平移后：

- 新的焦点是平移后的 `camTarget`。
- 再次左键旋转时，围绕这个新焦点旋转。
- 此时旋转中心已经不再严格等于原子初始包围盒中心。

画布禁用了右键菜单，因此右键拖动不会弹出浏览器上下文菜单，见 `structure-viewer/static/viewer3d.js:936`。

### 6.4 滚轮缩放

滚轮只改变相机到焦点的距离：

```javascript
var dir = camera.position.clone().sub(camTarget);
dir.setLength(d);
camera.position.copy(camTarget).add(dir);
```

对应代码位于 `structure-viewer/static/viewer3d.js:831` 至 `structure-viewer/static/viewer3d.js:837`。

滚轮不会平移焦点，因此缩放后继续左键旋转，仍然围绕原来的焦点。

如果希望“缩放后仍以屏幕中心为目标”，当前行为符合这一目标；它不是“以鼠标悬停原子为中心缩放”。

### 6.5 操作后的自动取景状态

鼠标拖动超过 1 像素后，`userAdjusted` 会被设置为 `true`：

```javascript
if (drag.moved > 1) userAdjusted = true;
```

滚轮操作也会设置：

```javascript
userAdjusted = true;
```

对应位置是 `structure-viewer/static/viewer3d.js:913` 和 `structure-viewer/static/viewer3d.js:939`。

所以用户操作后，面板尺寸变化不会自动把视角重置回默认状态。

## 7. 操作行为一览

| 操作 | 相机位置 | 观察焦点 `camTarget` | 之后旋转围绕什么点 |
|---|---|---|---|
| 导入结构 | 自动计算 | 原子包围盒中心 | 原子包围盒中心 |
| 左键拖动 | 围绕焦点移动 | 不变 | 当前焦点 |
| 右键拖动 | 随焦点平移 | 同步平移 | 平移后的新焦点 |
| 滚轮 | 沿焦点视线前后移动 | 不变 | 当前焦点 |
| 点击原子 | 不变 | 不变 | 当前焦点 |
| 点击“重置视角” | 重新计算 | 原子包围盒中心 | 原子包围盒中心 |
| 点击 `+a/-a/+b/-b/+c/-c` | 改为沿晶轴观察 | 不变 | 当前焦点 |
| 轨迹切换帧 | 不变 | 不变 | 当前焦点 |

最直观的理解是：

> 模型不是围绕“它自己的原点”旋转，而是相机围绕一个可以平移的观察焦点旋转。

## 8. 多类型轨迹查看器的差异

`structure-viewer/dataset-viewer/src/atomistic.js` 使用 Three.js `OrbitControls`。

创建控制器后，初始目标设为原点：

```javascript
this.controls = new OrbitControls(this.camera, this.renderer.domElement);
this.controls.target.set(0, 0, 0);
```

对应代码在 `structure-viewer/dataset-viewer/src/atomistic.js:45` 至 `structure-viewer/dataset-viewer/src/atomistic.js:48`。

加载完成后调用 `fitView()`，再把目标设为结构包围盒中心：

```javascript
this.controls.target.copy(center);
this.controls.update();
```

对应代码在 `structure-viewer/dataset-viewer/src/atomistic.js:208` 至 `structure-viewer/dataset-viewer/src/atomistic.js:226`。

`OrbitControls` 的默认鼠标映射是：

- 左键：旋转。
- 右键：平移。
- 滚轮：缩放。

这些默认行为定义在本地 Three.js 依赖的 `OrbitControls` 中。其核心语义与单结构查看器相同：

- 旋转围绕 `controls.target`。
- 平移会移动 `controls.target` 和相机。
- 缩放改变相机与 `controls.target` 的距离。

轨迹切换帧时只更新原子实例矩阵、键和晶胞，不会重新设置 `controls.target`，因此逐帧播放会保持用户当前观察中心。

## 9. 现有“视角预设”的行为

界面上的晶轴预设由 `applyViewPreset()` 处理，代码在 `structure-viewer/static/app.js:1571`。

预设规则：

- `+c/-c`：沿晶胞 `c` 轴观察，屏幕内使用 `b` 的投影作为上方。
- `+a/-a/+b/-b`：视线在垂直于 `c` 的平面内，屏幕上方保持 `c`。
- `reset`：重新调用 `resetView()`。

这里有一个实现细节：

- `viewAlong()` 只修改相机位置和 `camera.up`，不修改 `camTarget`。
- `viewAlong()` 当前不会把 `userAdjusted` 设置为 `true`。

因此，如果用户只点击了轴向预设而没有拖动或滚轮操作，随后触发面板尺寸变化，`resizeViewport()` 仍可能重新调用自动取景。若要保证预设视角在尺寸变化后保持，需要在 `viewAlong()` 中同步设置 `userAdjusted = true`，或增加独立的“用户已选择视角”状态。

## 10. 如果要把“默认视角”做成独立设置

建议不要直接把固定的相机世界坐标写死。更稳妥的配置应同时描述方向和焦点策略。

### 10.1 建议配置结构

```json
{
  "default_view": {
    "mode": "auto",
    "direction": [0.78, 0.62, 0.95],
    "up": [0, 0, 1],
    "target": "atom_bbox_center",
    "margin": 1.12,
    "tilt": 0.45
  }
}
```

建议支持以下模式：

| `mode` | 含义 |
|---|---|
| `auto` | 保持当前根据晶胞和原子包围盒自动计算 |
| `axis` | 按 `+a/-a/+b/-b/+c/-c` 选择默认晶轴 |
| `direction` | 使用显式方向和上方向 |
| `matrix` | 使用完整相机姿态，适合复现历史截图 |

### 10.2 焦点策略

建议把 `target` 做成策略字段：

```text
atom_bbox_center   原子包围盒中心，推荐默认
cell_center        晶胞中心，适合完整周期结构
origin             世界原点，适合自定义模型
atom:<index>       某个原子，适合局部位点分析
explicit:[x,y,z]   显式坐标
```

对表面和吸附体系，`atom_bbox_center` 通常比 `cell_center` 更合适，因为晶胞真空层不应影响画面取景。

### 10.3 接入 `resetView()`

建议在 `resetView()` 内部先读取 `VIEW_OPTIONS`：

```text
如果 direction 已提供：
  使用配置方向替代 0.78/0.62/0.95 或 a/b/c 自动方向

如果 up 已提供：
  使用配置上方向，并投影到垂直于视线方向

如果 target 已提供：
  按策略计算 camTarget

否则：
  保持当前自动行为
```

不要只在 `renderStructure()` 后调用一次 `viewAlong()`，否则“重置视角”和面板尺寸变化仍会回到自动取景。

### 10.4 持久化建议

默认视角可以在三个层级保存：

1. 应用全局默认：所有新结构使用同一方向。
2. 任务/项目级默认：同一项目中的结构使用统一观察方向。
3. 单个结构级覆盖：某个结构单独保存焦点和朝向。

推荐优先级：

```text
单个结构覆盖 > 任务/项目默认 > 应用全局默认 > 自动计算
```

### 10.5 离线导出

如果要求离线 HTML “打开就是导出前的精确视角”，需要额外保存：

```json
{
  "camera": {
    "position": [0, 0, 0],
    "target": [0, 0, 0],
    "up": [0, 1, 0],
    "fov": 32
  }
}
```

打开离线 HTML 后应在结构渲染完成时恢复该相机状态，而不是再次执行自动 `resetView()`。

## 11. 调试与验收方法

### 11.1 读取当前相机状态

浏览器控制台可以执行：

```javascript
state.viewer.getView()
```

返回结构类似：

```javascript
{
  position: [x, y, z],
  target: [x, y, z],
  up: [x, y, z],
  dir: [x, y, z],
  cell: [[...], [...], [...]]
}
```

接口定义在 `structure-viewer/static/viewer3d.js:1006`。

### 11.2 验证左键旋转不改变焦点

步骤：

1. 加载一个样例结构。
2. 在控制台执行 `state.viewer.getView().target`，记录结果。
3. 在画布上左键拖动。
4. 再次执行 `state.viewer.getView().target`。
5. 预期 `target` 基本不变，`position` 和 `dir` 改变。

### 11.3 验证右键平移会改变焦点

步骤：

1. 记录当前 `target`。
2. 在画布上右键拖动。
3. 再次读取 `target`。
4. 预期 `target` 随平移方向发生变化。

### 11.4 验证重置回到默认焦点

步骤：

1. 右键平移后记录 `target`。
2. 点击“重置视角”或执行 `state.viewer.resetView()`。
3. 再次读取 `target`。
4. 预期焦点回到当前原子几何包围盒中心。

### 11.5 验证轨迹播放保持视角

步骤：

1. 打开多帧轨迹数据集。
2. 手动旋转到一个非默认角度。
3. 切换若干帧。
4. 观察相机位置和旋转角是否保持。

当前轨迹帧更新不调用 `fitView()`，因此应保持用户视角和 `controls.target`。

## 12. 已知限制与注意事项

1. 默认视角没有持久化配置，重新导入结构会重新执行自动取景。
2. 默认焦点是原子包围盒中心，不是晶胞中心，也不是某个指定原子。
3. 点击原子不会改旋转中心；如果产品希望“点击原子后围绕该原子旋转”，需要新增明确的焦点设置动作。
4. 离线 HTML 不保存当前相机姿态，只保存视觉参数。
5. 视角预设 `viewAlong()` 当前不设置 `userAdjusted`，面板尺寸变化时可能回到自动取景。
6. 平移后焦点已经离开原子初始几何中心；界面目前没有显示“当前焦点”的标记，用户可能较难判断旋转中心。
7. 多类型查看器的 `OrbitControls` 与单结构自定义轨道实现不是同一段代码，但交互语义一致；以后修改其中一套时需要分别回归。

## 13. 源码索引

| 行为 | 文件与位置 |
|---|---|
| 导入后触发重置视角 | `structure-viewer/static/app.js:487`、`structure-viewer/static/app.js:520` |
| 原子包围盒中心作为焦点 | `structure-viewer/static/viewer3d.js:715`、`structure-viewer/static/viewer3d.js:727` |
| 有晶胞时的默认方向 | `structure-viewer/static/viewer3d.js:730` 至 `structure-viewer/static/viewer3d.js:747` |
| 无晶胞时的固定方向 | `structure-viewer/static/viewer3d.js:728` 至 `structure-viewer/static/viewer3d.js:729` |
| 相机距离和裁剪面 | `structure-viewer/static/viewer3d.js:723` 至 `structure-viewer/static/viewer3d.js:755` |
| 左键轨道旋转 | `structure-viewer/static/viewer3d.js:800` 至 `structure-viewer/static/viewer3d.js:819` |
| 右键平移 | `structure-viewer/static/viewer3d.js:821` 至 `structure-viewer/static/viewer3d.js:829` |
| 滚轮缩放 | `structure-viewer/static/viewer3d.js:831` 至 `structure-viewer/static/viewer3d.js:837` |
| 单击原子 | `structure-viewer/static/viewer3d.js:921` 至 `structure-viewer/static/viewer3d.js:929` |
| 原子点击业务行为 | `structure-viewer/static/app.js:1099` 至 `structure-viewer/static/app.js:1110` |
| 视角预设 | `structure-viewer/static/app.js:1571` 至 `structure-viewer/static/app.js:1610` |
| 离线导出保存的配置 | `structure-viewer/static/app.js:1768` 至 `structure-viewer/static/app.js:1781` |
| 多类型查看器控制器 | `structure-viewer/dataset-viewer/src/atomistic.js:45`、`structure-viewer/dataset-viewer/src/atomistic.js:208` |
