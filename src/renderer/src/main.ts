import './style.css'
import { Viewer, type ViewMode } from './viewer'
import { UI } from './ui'
import { loadModelFile, exportModel, serializeModel, UNIT_TO_MM } from './formats'

const viewport = document.getElementById('viewport')!
const viewer = new Viewer(viewport)
const ui = new UI()

let currentFileName = ''

// 统计信息 → HUD
viewer.setStatsCallback((stats) => {
  ui.updateStats(stats)
})

// 查看模式切换
ui.onViewModeChanged = (mode: ViewMode) => {
  viewer.setMode(mode)
}

ui.bindFitView(() => viewer.fitView())
ui.onModelOpacityChanged = (opacity) => viewer.setModelOpacity(opacity)
viewer.setAnimationCallback((state) => ui.updateAnimation(state))
ui.onAnimationSelected = (index) => viewer.selectAnimation(index)
ui.onPlaybackToggle = () => viewer.togglePlayback()
ui.onAnimationSeek = (time) => viewer.seekAnimation(time)
ui.onAnimationSpeed = (speed) => viewer.setAnimationSpeed(speed)
ui.onAnimationLoop = (loop) => viewer.setAnimationLoop(loop)

// 导出
ui.bindExport(async () => {
  const model = viewer.getModel()
  if (!model) return
  try {
    const format = await promptExportFormat()
    if (!format) return
    const ok = await exportModel(format, model, currentFileName)
    if (ok) {
      console.log(`已导出为 ${format}`)
    }
  } catch (err) {
    console.error('导出失败:', err)
  }
})

/** 简易导出格式选择（后续可替换为菜单） */
function promptExportFormat(): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement('div')
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center; z-index: 200;
    `
    const box = document.createElement('div')
    box.style.cssText = `
      background: #fff; border-radius: 12px; padding: 24px; width: 260px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.2);
    `
    const title = document.createElement('div')
    title.textContent = '导出当前姿态（静态模型）'
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px;'
    box.appendChild(title)

    const items = [
      { label: 'Wavefront OBJ (.obj)', value: 'obj' },
      { label: 'glTF 2.0 二进制 (.glb)', value: 'glb' },
      { label: 'glTF 2.0 文本 (.gltf)', value: 'gltf' },
      { label: 'Autodesk FBX (.fbx)', value: 'fbx' },
      { label: 'STL 二进制 (.stl)', value: 'stl' },
      { label: 'PLY 几何网格 (.ply)', value: 'ply' },
      { label: 'MMD 模型文件 (.pmx)', value: 'pmx' }
    ]
    items.forEach((item) => {
      const btn = document.createElement('button')
      btn.textContent = item.label
      btn.style.cssText = `
        display:block; width:100%; margin-bottom:8px; padding:10px; border-radius:8px;
        border:1px solid #e5e7eb; background:#fff; font-size:14px; cursor:pointer; text-align:left;
      `
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = '#3b82f6'
        btn.style.color = '#3b82f6'
      })
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = '#e5e7eb'
        btn.style.color = 'inherit'
      })
      btn.addEventListener('click', () => {
        modal.remove()
        resolve(item.value)
      })
      box.appendChild(btn)
    })

    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.style.cssText = `
      display:block; width:100%; padding:10px; border-radius:8px;
      border:none; background:#f3f4f6; font-size:14px; cursor:pointer;
    `
    cancel.addEventListener('click', () => {
      modal.remove()
      resolve(null)
    })
    box.appendChild(cancel)

    modal.appendChild(box)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove()
        resolve(null)
      }
    })
    document.body.appendChild(modal)
  })
}

/** 加载模型文件（自动替换场景中已有模型） */
let openRequest = 0
async function openModel(filePath: string): Promise<void> {
  const request = ++openRequest
  try {
    const { root, unit, animations } = await loadModelFile(filePath)
    if (request !== openRequest) {
      // A slower previous request must not replace the latest model or leak its resources.
      const materials = new Set<import('three').Material>()
      root.traverse((obj) => {
        const mesh = obj as import('three').Mesh
        mesh.geometry?.dispose()
        if ((mesh as import('three').SkinnedMesh).isSkinnedMesh) (mesh as import('three').SkinnedMesh).skeleton.dispose()
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        list.filter(Boolean).forEach((material) => materials.add(material))
      })
      materials.forEach((material) => material.dispose())
      return
    }
    currentFileName = filePath.split(/[\\/]/).pop() || filePath
    viewer.setModel(root, currentFileName, animations, UNIT_TO_MM[unit])
    ui.setUnit(unit)
  } catch (err) {
    if (request !== openRequest) return
    console.error('加载模型失败:', err)
    // 简单提示
    alert(`无法加载模型: ${filePath}\n${err instanceof Error ? err.message : String(err)}`)
  }
}

// 拖放加载
ui.bindDrop((filePath) => {
  void openModel(filePath)
})

// 文件关联 / 第二实例打开
window.api.onOpenFile((filePath) => {
  void openModel(filePath)
})

// ---- 测试钩子（供 e2e 自动化验证使用，不影响正常功能） ----
;(window as unknown as Record<string, unknown>).__test = {
  openModel,
  loadModelFile,
  exportModel,
  serializeModel,
  viewer,
  ui
}
