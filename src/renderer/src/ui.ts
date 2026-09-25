import type { ModelStats, ViewMode } from './viewer'
import { UNIT_TO_MM, type UnitKind } from './formats'

/** UI 交互层：HUD 更新、查看模式按钮、单位切换、拖放与导出入口 */
export class UI {
  private elFile: HTMLElement
  private elFaces: HTMLElement
  private elVertices: HTMLElement
  private elSize: HTMLElement
  private unitSelect: HTMLSelectElement
  private exportBtn: HTMLButtonElement
  private fitViewBtn: HTMLButtonElement
  private opacitySlider: HTMLInputElement
  private opacityValue: HTMLOutputElement
  private modeButtons: NodeListOf<HTMLButtonElement>
  private dropOverlay: HTMLElement

  private currentStats: ModelStats | null = null
  private unit: UnitKind = 'mm'

  constructor() {
    this.elFile = document.getElementById('hud-file')!
    this.elFaces = document.getElementById('hud-faces')!
    this.elVertices = document.getElementById('hud-vertices')!
    this.elSize = document.getElementById('hud-size')!
    this.unitSelect = document.getElementById('unit-select') as HTMLSelectElement
    this.exportBtn = document.getElementById('export-btn') as HTMLButtonElement
    this.fitViewBtn = document.getElementById('fit-view-btn') as HTMLButtonElement
    this.opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement
    this.opacityValue = document.getElementById('opacity-value') as HTMLOutputElement
    this.modeButtons = document.querySelectorAll('.mode-btn') as NodeListOf<HTMLButtonElement>
    this.dropOverlay = document.getElementById('drop-overlay')!

    // 查看模式点击
    this.modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as ViewMode
        this.setViewMode(mode)
      })
    })

    // 单位切换
    this.unitSelect.addEventListener('change', () => {
      this.unit = this.unitSelect.value as UnitKind
      this.renderStats()
    })

    this.opacitySlider.addEventListener('input', () => {
      const opacity = Number(this.opacitySlider.value) / 100
      this.opacityValue.value = `${this.opacitySlider.value}%`
      this.opacityValue.textContent = this.opacityValue.value
      this.onModelOpacityChanged?.(opacity)
    })

    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLSelectElement) return
      const mode = ({ '1': 'solid', '2': 'wire' } as Record<string, ViewMode | undefined>)[event.key]
      if (mode) {
        event.preventDefault()
        this.setViewMode(mode)
      } else if (event.key.toLowerCase() === 'f' && !this.fitViewBtn.disabled) {
        event.preventDefault()
        this.onFitView?.()
      }
    })
  }

  /** 设置查看模式切换回调 */
  onViewModeChanged?: (mode: ViewMode) => void

  /** 设置导出回调 */
  onExport?: () => void
  onFitView?: () => void
  onModelOpacityChanged?: (opacity: number) => void

  setViewMode(mode: ViewMode): void {
    this.modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode)
    })
    this.onViewModeChanged?.(mode)
  }

  /** 更新 HUD 统计信息 */
  updateStats(stats: ModelStats): void {
    this.currentStats = stats
    this.elFile.textContent = stats.fileName ? stats.fileName : '未加载模型'
    this.exportBtn.disabled = !stats.hasModel
    this.fitViewBtn.disabled = !stats.hasModel
    this.opacitySlider.disabled = !stats.hasModel
    this.renderStats()
  }

  /** 根据当前单位换算并渲染统计 */
  private renderStats(): void {
    const stats = this.currentStats
    if (!stats || !stats.hasModel) {
      this.elFaces.textContent = '0'
      this.elVertices.textContent = '0'
      this.elSize.textContent = '0 × 0 × 0 mm'
      return
    }
    const factor = 1 / UNIT_TO_MM[this.unit] // mm → 当前单位
    const w = stats.size.x * factor
    const h = stats.size.y * factor
    const d = stats.size.z * factor
    const fmt = (v: number): string => (v >= 100 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(3))
    this.elFaces.textContent = stats.faces.toLocaleString('zh-CN')
    this.elVertices.textContent = stats.vertices.toLocaleString('zh-CN')
    this.elSize.textContent = `${fmt(w)} × ${fmt(h)} × ${fmt(d)} ${this.unit}`
  }

  /** 自动选择单位（格式自动识别后调用） */
  setUnit(unit: UnitKind): void {
    this.unit = unit
    this.unitSelect.value = unit
    this.renderStats()
  }

  /** 绑定导出按钮 */
  bindExport(handler: () => void): void {
    this.onExport = handler
    this.exportBtn.addEventListener('click', () => handler())
  }

  bindFitView(handler: () => void): void {
    this.onFitView = handler
    this.fitViewBtn.addEventListener('click', handler)
  }

  // ---------- 拖放 ----------

  /** 绑定拖放事件 */
  bindDrop(onFile: (filePath: string) => void): void {
    let dragDepth = 0

    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !this.hasModelFiles(e.dataTransfer)) return
      e.preventDefault()
      dragDepth++
      this.dropOverlay.classList.add('visible')
    })

    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy'
    })

    window.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) this.dropOverlay.classList.remove('visible')
    })

    window.addEventListener('drop', (e) => {
      e.preventDefault()
      dragDepth = 0
      this.dropOverlay.classList.remove('visible')
      if (!e.dataTransfer) return
      const file = Array.from(e.dataTransfer.files).find((f) => this.isSupported(f.name))
      if (!file) return
      const filePath = window.api.getPathForFile(file)
      onFile(filePath)
    })
  }

  private hasModelFiles(dt: DataTransfer): boolean {
    return Array.from(dt.files).some((f) => this.isSupported(f.name))
  }

  private isSupported(name: string): boolean {
    return /\.(fbx|stl|obj|pmx|pmd)$/i.test(name)
  }
}
