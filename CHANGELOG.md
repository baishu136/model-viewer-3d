# 更新日志

## v0.3.0 — 2026-10-31

- 新增 Blender 原生格式 (`.blend`) 支持，通过内置轻量 SDNA 解析器直接解包几何多边形网格，支持 Blender 2.80+ 及 4.x/5.x。
- 新增 Maya ASCII (`.ma`) 与 Maya Binary (`.mb`) 支持，内置纯 TypeScript 流式 MEL 分词器与 IFF Chunk 解析器，毫秒级提取几何体。
- 新增 Cinema 4D (`.c4d`) 支持，直接提取文件内部烘焙的 PolygonObject 点面缓存。
- 零外部软件依赖：无需在 Windows 上安装 Blender、Maya 或 Cinema 4D，加载速度与 OBJ/FBX/STL 保持同等毫秒级响应。
- 新增 Windows 文件关联注册支持：`.blend`、`.c4d`、`.ma`、`.mb`。
- 新增 4 种新格式自动化回归与兼容性测试套件（兼容性检查项增至 34 项全部通过）。

## v0.2.0 — 2026-10-31

- 新增 GLB/glTF 模型输入，支持外置 `.bin`、内嵌数据，以及离线 Draco、Meshopt 解码。
- 新增 PLY 网格和点云查看，支持 ASCII、二进制小端及大端编码。
- 新增 FBX、GLB/glTF 动画预览，支持骨骼蒙皮、形态动画和物体变换。
- 新增动画片段选择、播放/暂停、时间轴、倍速、循环及空格快捷键。
- FBX、GLB/glTF 使用统一白模，跳过原材质、贴图、灯光和相机；布线跟随动画。
- 修正 glTF 米制单位换算、二进制 FBX 单位识别和骨骼模型首次取景。
- 修正包含中文、空格和转义字符的本地 glTF 附属文件路径；避免并发加载串用资源目录。
- 更新 Windows 文件关联，支持 `.fbx/.glb/.gltf/.obj/.stl/.ply`，保留 PMX/PMD 输入。
- 现有 OBJ/STL/FBX 导出按当前显示姿态烘焙为静态网格，不导出动画；点云和曲线不能导出为三角网格。

### 验证

- TypeScript 类型检查与生产构建通过。
- 原有端到端回归：18 项通过。
- 格式和动画兼容性：30 项通过，覆盖 Windows 打包程序的实际启动和加载。

### 范围

无需安装或调用 Blender、3ds Max、Maya、Cinema 4D、ZBrush。播放文件内已有的动画数据；原软件的 IK、约束、修改器或物理模拟需要先烘焙。不支持直接打开这些软件的原生工程文件。

## v0.1.0

- 首个公开版本：FBX、STL、OBJ、PMX/PMD 模型查看，OBJ/STL/FBX 导出，实体布线与透明度控制。
