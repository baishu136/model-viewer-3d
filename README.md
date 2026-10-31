# 3D 模型查看器

一款独立运行的 Windows 桌面模型与动画查看器，支持 FBX、GLB/glTF、OBJ、STL、PLY，以及原生 Blender (.blend)、Maya (.ma/.mb)、Cinema 4D (.c4d) 与 PMX/PMD 输入。无需安装或依赖任何大型 DCC 软件，毫秒级轻量加载。支持将当前姿态导出为静态 OBJ、STL 或 FBX。

## 功能特性

### 简洁易用的界面
- **纯白 3D 场景**：启动即为干净的白底场景，含坐标轴（红X/绿Y/蓝Z）与自适应网格
- **左上角 HUD**：实时显示当前模型的面数、顶点数、尺寸(mm) 及文件名
- **两种查看模式**：白模，以及在实体表面叠加正面三角布线
- **模型透明度滑块**：在右侧功能区实时调整模型透明度，方便查看内部结构
- **模型与动画预览**：FBX、GLB/glTF 的骨骼、形态（Morph）及物体变换动画；支持片段选择、播放/暂停、时间轴、倍速和循环。加载后停在首帧，点击播放开始。
- **白模加载**：FBX、GLB/glTF 跳过原材质和贴图加载，不导入原场景灯光或相机；使用查看器自己的光照。布线与动画同步。
- **GLB/glTF 压缩模型**：内置离线 Draco 解码器及 Meshopt 解码器，不依赖在线 CDN。
- **PLY 网格与点云**：支持 ASCII、二进制小端和大端 PLY，点云按点显示，面数为零。
- **单位切换**：mm / cm / m 下拉切换，尺寸显示与网格自适应联动

### 便捷的操作方式
- **直接打开 3D 文件**：安装后双击 `.fbx / .glb / .gltf / .obj / .stl / .ply / .pmx / .pmd / .blend / .c4d / .ma / .mb` 文件即可用本软件打开
- **拖放加载**：将模型文件拖入窗口即可查看
- **单模型场景**：加载第二个文件时**立即卸载第一个**，场景永远只有一个模型，内存不泄漏
- **单实例聚焦**：软件已运行时再次双击文件 → 聚焦现有窗口并切换为新模型
- **自适应取景**：模型自动居中并适配相机视角
- **快捷键**：`1` 白模、`2` 布线、`F` 适配视图、`空格` 播放/暂停（焦点位于查看区域时）

### 格式转换
- **输入**：FBX / GLB / glTF / OBJ / STL（二进制与 ASCII）/ PLY / PMX / PMD / BLEND / C4D / MA / MB
- **输出**：OBJ / STL（二进制）/ FBX（二进制，兼容 Unity/Unreal/Blender/Maya）
- 转换通过界面"导出…"入口完成，骨骼及形态动画按当前显示姿态烘焙为静态网格；此入口不导出动画。仅含点或线的模型不能导出为三角网格。

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

当前版本 **v0.2.0** 新增 GLB/glTF、PLY 和 FBX/GLB/glTF 动画播放，完整变化见 [更新日志](CHANGELOG.md)。

> 注：Windows 下 npm 子进程可能继承 `ELECTRON_RUN_AS_NODE` 导致 electron 以 Node 模式运行，
> 因此 dev 脚本通过 `scripts/dev-clean.mjs` 启动，确保环境干净。

### 测试

```bash
npm run test              # 核心功能端到端测试（模型加载/HUD/查看模式/单位/导出/单模型替换）
npm run test:compatibility # 格式兼容、骨骼/形态/变换动画、压缩GLB、PLY及无贴图加载验证
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

- **PMX 仅作输入**：PMX/PMD 为 MMD 私有格式，开源生态无可靠写入器，故仅支持加载查看；导出目标为 OBJ/STL/FBX。
- **单位约定**：GLB/glTF 按标准使用米，载入后转换为内部毫米；FBX 按识别到的 UnitScaleFactor 转换。OBJ/STL/PLY/PMX/PMD 无可识别单位时默认按毫米解释。单位下拉框只切换显示单位。
- **DCC 软件格式原生兼容**：内置轻量原生几何体解析器，直接解析 `.blend` (SDNA)、`.ma` (MEL 语句)、`.mb` (IFF 数据块) 以及 `.c4d` (PolygonObject 烘焙缓存)，无需安装任何外部软件，毫秒级快速提取多边形网格渲染。因面数过高或闭源限制，暂不支持 3ds Max (.max) 与 ZBrush (.ztl/.zpr)。
- **动画范围**：播放文件内已有的关键帧、骨骼蒙皮和形态动画；原软件的 IK、约束、修改器或物理模拟需要先烘焙。OBJ/STL/PLY/BLEND/C4D/MA/MB 为静态网格输入。
- **glTF 附属文件**：`.gltf` 引用的 `.bin` 几何/动画数据必须保留相对目录；材质和贴图不需要。GLB 通常将数据打包在单个文件内。
