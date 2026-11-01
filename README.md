# 3D 模型查看器

一款独立运行的 Windows 桌面模型与动画查看器，支持 FBX、GLB/glTF、VRM 0.x/1.0、OBJ、STL、PLY，以及 Blender (.blend/.blender)、Maya (.ma/.mb)、Cinema 4D (.c4d)、3ds Max (.max) 与 PMX/PMD 输入。无需安装大型 DCC 软件，支持将当前姿态导出为 OBJ、STL、FBX、GLB、glTF、PLY、PMX 或静态 VRM。原生工程格式读取已保存的几何数据，具体测试范围和限制见 [格式兼容性说明](docs/format-compatibility.md)。

## 功能特性

### 简洁易用的界面
- **纯白 3D 场景**：启动即为干净的白底场景，含坐标轴（红X/绿Y/蓝Z）与自适应网格
- **左上角 HUD**：实时显示当前模型的面数、顶点数、尺寸(mm) 及文件名
- **两种查看模式**：白模，以及在实体表面叠加正面三角布线
- **模型透明度滑块**：在右侧功能区实时调整模型透明度，方便查看内部结构
- **模型与动画预览**：FBX、GLB/glTF 的骨骼、形态（Morph）及物体变换动画；支持片段选择、播放/暂停、时间轴、倍速和循环。加载后停在首帧，点击播放开始。
- **白模加载**：FBX、GLB/glTF 跳过原材质和贴图加载，不导入原场景灯光或相机；使用查看器自己的光照。布线与动画同步。
- **VRM 人物**：直接打开 VRM 0.x / 1.0，统一人物朝向，以米为单位显示；保留蒙皮、默认形态及文件内已有的 glTF 动画。白模与布线不加载原始贴图，不执行弹簧骨、IK、视线或表情控制器。
- **MMD 几何加载**：PMX/PMD 保留骨骼、蒙皮和默认形态，跳过贴图及 Toon 资源，支持 PMX UTF-8 / UTF-16LE 文本。
- **GLB/glTF 压缩模型**：内置离线 Draco 解码器及 Meshopt 解码器，不依赖在线 CDN。
- **PLY 网格与点云**：支持 ASCII、二进制小端和大端 PLY，点云按点显示，面数为零。
- **单位切换**：mm / cm / m 下拉切换，尺寸显示与网格自适应联动

### 便捷的操作方式
- **直接打开 3D 文件**：安装后双击 `.fbx / .glb / .gltf / .vrm / .obj / .stl / .ply / .pmx / .pmd / .blend / .blender / .c4d / .ma / .mb / .max / .md` 文件即可用本软件打开
- **拖放加载**：将模型文件拖入窗口即可查看
- **单模型场景**：加载第二个文件时**立即卸载第一个**，场景永远只有一个模型，内存不泄漏
- **单实例聚焦**：软件已运行时再次双击文件 → 聚焦现有窗口并切换为新模型
- **自适应取景**：模型自动居中并适配相机视角
- **快捷键**：`1` 白模、`2` 布线、`F` 适配视图、`空格` 播放/暂停（焦点位于查看区域时）

### 格式转换
- **输入**：FBX / GLB / glTF / VRM / OBJ / STL（二进制与 ASCII）/ PLY / PMX / PMD / BLEND / BLENDER / C4D / MA / MB / MAX / MD
- **输出**：OBJ / STL（二进制）/ FBX（二进制，兼容 Unity/Unreal/Blender/Maya）/ GLB / glTF / PLY / PMX（MMD）/ VRM 1.0（静态基础骨架）
- 转换通过界面"导出…"入口完成，支持将当前加载的模型（包括 Blender、Maya、Cinema 4D 等原生工程）烘焙为任意上述标准三维格式；骨骼及形态动画按当前显示姿态烘焙为静态网格。仅含点或线的模型不能导出为三角网格。
- `.max / .c4d / .md / .blender` 共享全部导出目标。二进制 MMD `.md` 导出模型网格；普通 Markdown `.md` 导出当前预览平面。VRM 添加完整必需的人形参考骨架，保持当前外形，不自动蒙皮，也不成为可驱动的人物；详见 [原生格式导出说明](docs/native-export.md)。

## 技术栈

- **Electron** + electron-vite 5（TypeScript）
- **Three.js**（渲染、各格式加载/导出）
- **@comfyorg/fbx-exporter-three**（FBX 二进制导出）
- **electron-builder**（打包 + 文件关联注册）
- 原生 TS + DOM 实现 UI（无额外框架，减小体积、加快启动）

## 开发

### 环境要求
- Node.js ≥ 20.19（推荐 LTS）
- Windows 10/11

### 安装与运行

```bash
npm install
npm run dev        # 开发模式（自动清理 ELECTRON_RUN_AS_NODE 环境变量污染）
npm run build      # 仅构建 out/ 产物
npm run package    # 打包 NSIS 安装包 + zip 便携版（输出到 release/）
```

## 下载

从 [GitHub Releases](https://github.com/baishu136/model-viewer-3d/releases/latest) 下载 Windows 便携版 ZIP。解压后运行 `3D模型查看器.exe`；请保留压缩包中的全部文件和文件夹。

当前版本 **v0.5.0** 新增静态 VRM 1.0 导出及原生格式导出矩阵验证，完整变化见 [更新日志](CHANGELOG.md)。

> 注：Windows 下 npm 子进程可能继承 `ELECTRON_RUN_AS_NODE` 导致 electron 以 Node 模式运行，
> 因此 dev 脚本通过 `scripts/dev-clean.mjs` 启动，确保环境干净。

### 测试

```bash
npm run test              # 核心功能端到端测试（模型加载/HUD/查看模式/单位/导出/单模型替换）
npm run test:compatibility # 格式兼容、骨骼/形态/变换动画、压缩GLB、PLY及无贴图加载验证
npm run test:formats       # VRM/MMD/Maya/C4D、无贴图渲染及7种导出格式尺寸往返检查
npm run test:exports:native # MAX/C4D/MD/BLENDER → 8种目标的往返及官方VRM导入器验证
npm run test:formats:real -- "真实模型目录" # 按格式抽取真实模型，在白模/布线下检查并输出审计报告
npm run typecheck          # 完整 TypeScript 检查
npm run test:max           # MAX 节点层级、轴心偏移、实例、镜像及凹多边形回归测试
npm run test:max:reference -- "模型.max" "参考.fbx" # 用同场景 FBX 核对部件位置，并保存白模/布线截图
npm run test:packaged     # 打包版回归验证
npm run test:installed    # 已安装应用的文件关联与单实例测试
npm run test:portable     # zip 便携版验证（解压即用 + 自动注册文件关联）
npm run test:single       # 真实单实例进程测试
npm run test:models       # 重新生成测试模型（testdata/）
```

## 项目结构

```
src/
├── main/index.ts        # 主进程：单实例、文件关联、model:// 协议、IPC
├── preload/index.ts     # contextBridge 安全桥接
└── renderer/
    ├── index.html       # 页面骨架（HUD / 工具栏 / 查看模式 / 拖放遮罩）
    └── src/
        ├── main.ts      # 渲染进程入口，串联各模块
        ├── viewer.ts    # Three.js 场景、相机、查看模式、单模型释放、统计
        ├── formats.ts   # 各格式加载 / 导出 / 单位识别
        ├── ui.ts        # HUD、查看模式、透明度、单位切换、拖放
        └── style.css    # 极简白底 UI 样式
scripts/
├── dev-clean.mjs        # 干净 dev 启动器（清除 ELECTRON_RUN_AS_NODE）
├── gen_icon.py          # 生成应用图标
├── gen_test_models.py   # 生成测试模型
└── tests/               # 端到端 / 打包版 / 便携版等测试脚本
testdata/                # 测试用模型（cube.obj / cube.stl）
resources/               # 应用图标
release/                 # 本地打包产物（不提交到 Git）
```

## 说明

- **PMX / PMD**：均支持静态查看，PMX 另支持静态网格导出，导出文件含有效根骨骼；不运行 MMD 物理、IK 或动作文件。
- **单位约定**：GLB/glTF/VRM 使用米，载入后转换为内部毫米；FBX 按 UnitScaleFactor，MA 按 currentUnit 的 mm/cm/m 识别。OBJ/STL/PLY 默认毫米，PMX/PMD 默认厘米，BLEND 默认米，MAX/C4D/MB 默认厘米。部分原生工程的自定义单位尚未读取，尺寸应以原软件核对。单位下拉框只切换显示单位；GLB/glTF 导出转换回米，PMX 导出转换回厘米。
- **DCC 软件格式原生兼容**：内置轻量原生几何体解析器，直接读取 `.blend` (SDNA 数据块)、`.ma` (MEL 语句)、`.mb` (IFF 数据块)、`.c4d` (HyperFile 标记流中的 PolygonObject 顶点/多边形/UV) 以及 `.max` (Scene 流中的 TriObject 与可编辑多边形 MNMesh)，无需安装任何外部 3D 软件，毫秒级快速提取真实网格与拓扑布线。
- **动画范围**：播放文件内已有的关键帧、骨骼蒙皮和形态动画；原软件的 IK、约束、修改器或物理模拟需要先烘焙。OBJ/STL/PLY/BLEND/C4D/MA/MB/MAX 为静态网格输入。
- **FBX 版本**：同时支持现代化的二进制/ASCII FBX（FileVersion ≥ 7000）与 3ds Max、Maya 早期导出的旧版二进制 FBX 6.x（FileVersion < 7000，three.js 官方加载器不支持该版本）。
- **C4D / MAX 读取范围**：`.c4d` 读取已保存的多边形对象（未塌陷的程序化基本体需在 C4D 中“转为可编辑对象”）；`.max` 读取 TriObject / Editable Poly 网格、父子节点变换、对象轴心偏移、带方向的缩放及共享网格实例，凹多边形按轮廓进行三角化。没有烘焙网格的闭合样条可恢复轮廓面，但不完整计算挤出、细分等修改器效果；材质与贴图不参与解析。压缩（gzip/zlib）保存的 Scene 流会自动解压。
- **glTF 附属文件**：`.gltf` 引用的 `.bin` 几何/动画数据必须保留相对目录；材质和贴图不需要。GLB 通常将数据打包在单个文件内。

## 赞助与支持

如果您觉得这个项目对您有所帮助，欢迎赞助支持作者！您的支持是项目持续维护与带来更多新特性的最大动力。

| 微信支付 (WeChat Pay) | 支付宝 (Alipay) |
| :---: | :---: |
| <img src="resources/sponsor_wechat.jpg" width="260" alt="微信支付" /> | <img src="resources/sponsor_alipay.jpg" width="260" alt="支付宝" /> |

