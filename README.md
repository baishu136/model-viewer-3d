# 3D 模型查看器

一款 Windows 桌面 3D 模型查看器与格式转换工具，支持查看 FBX、STL、OBJ、PMX 和 PMD 模型，并导出 OBJ、STL 或 FBX。

## 功能特性

### 简洁易用的界面
- **纯白 3D 场景**：启动即为干净的白底场景，含坐标轴（红X/绿Y/蓝Z）与自适应网格
- **左上角 HUD**：实时显示当前模型的面数、顶点数、尺寸(mm) 及文件名
- **两种查看模式**：白模，以及在实体表面叠加正面三角布线
- **模型透明度滑块**：在右侧功能区实时调整模型透明度，方便查看内部结构
- **单位切换**：mm / cm / m 下拉切换，尺寸显示与网格自适应联动

### 便捷的操作方式
- **直接打开 3D 文件**：安装后双击 `.fbx / .stl / .obj / .pmx / .pmd` 文件即可用本软件打开
- **拖放加载**：将模型文件拖入窗口即可查看
- **单模型场景**：加载第二个文件时**立即卸载第一个**，场景永远只有一个模型，内存不泄漏
- **单实例聚焦**：软件已运行时再次双击文件 → 聚焦现有窗口并切换为新模型
- **自适应取景**：模型自动居中并适配相机视角
- **快捷键**：`1` 白模、`2` 布线、`F` 适配视图

### 格式转换
- **输入**：OBJ / FBX / STL（二进制与 ASCII）/ PMX / PMD
- **输出**：OBJ / STL（二进制）/ FBX（二进制，兼容 Unity/Unreal/Blender/Maya）
- 转换通过界面"导出…"入口完成，骨骼模型导出前自动烘焙为静态网格

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

从 [GitHub Releases](https://github.com/baishu136/model-viewer-3d/releases) 下载 Windows 便携版 ZIP。解压后运行 `3D模型查看器.exe`；请保留压缩包中的全部文件和文件夹。

> 注：Windows 下 npm 子进程可能继承 `ELECTRON_RUN_AS_NODE` 导致 electron 以 Node 模式运行，
> 因此 dev 脚本通过 `scripts/dev-clean.mjs` 启动，确保环境干净。

### 测试

```bash
npm run test              # 核心功能端到端测试（模型加载/HUD/查看模式/单位/导出/单模型替换）
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
- **单位约定**：STL 视为 mm；OBJ/FBX/PMX 默认按 mm 计（FBX 自动识别 UnitScaleFactor），可通过界面切换 cm/m。
