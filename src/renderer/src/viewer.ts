import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type ViewMode = 'solid' | 'wire'

export interface ModelStats {
  fileName: string
  faces: number
  vertices: number
  /** 包围盒尺寸（模型单位） */
  size: THREE.Vector3
  /** 是否已加载模型 */
  hasModel: boolean
}

/**
 * 3D 查看器核心：管理场景、相机、网格/坐标轴、模型加载、自适应取景、
 * 单模型释放与查看模式切换。
 */
export class Viewer {
  readonly scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private grid: THREE.GridHelper
  private axes: THREE.AxesHelper
  private light: THREE.DirectionalLight
  private ambient: THREE.AmbientLight

  /** 当前场景中唯一的模型根节点 */
  private modelRoot: THREE.Object3D | null = null
  /** 线框叠加层（wire 模式） */
  private wireLayer: THREE.Object3D | null = null
  private sourceMaterials = new Set<THREE.Material>()

  private mode: ViewMode = 'solid'
  private modelOpacity = 1
  private animationId = 0
  private resizeObserver: ResizeObserver
  private container: HTMLElement

  private onStats?: (stats: ModelStats) => void

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.setClearColor(0xffffff, 1)
    container.appendChild(this.renderer.domElement)

    // 相机：默认方向，Y 轴向上
    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      100000
    )
    this.camera.position.set(200, 160, 260)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 0, 0)

    // 光照：柔和白光，避免默认阴影
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5)
    this.light = new THREE.DirectionalLight(0xffffff, 1.0)
    this.light.position.set(1, 1.5, 1)
    this.scene.add(this.ambient, this.light)

    // 网格与坐标轴
    this.grid = new THREE.GridHelper(1000, 10, 0xd1d5db, 0xe5e7eb)
    this.axes = new THREE.AxesHelper(50)
    this.scene.add(this.grid, this.axes)

    // 自适应窗口尺寸
    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(container)

    this.animate()
  }

  /** 设置统计信息更新回调 */
  setStatsCallback(cb: (stats: ModelStats) => void): void {
    this.onStats = cb
  }

  /** 设置查看模式 */
  setMode(mode: ViewMode): void {
    this.mode = mode
    if (!this.modelRoot) return
    this.applyViewMode()
  }

  /** 设置实体不透明度（用于布线叠加时检查内部结构）。 */
  setModelOpacity(opacity: number): void {
    this.modelOpacity = THREE.MathUtils.clamp(opacity, 0.05, 1)
    this.applyViewMode()
  }

  private onResize(): void {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  private animate(): void {
    this.animationId = requestAnimationFrame(() => this.animate())
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * 替换场景中的模型：释放旧模型的所有资源，再添加新模型。
   * 确保场景永远只有一个模型。
   */
  setModel(root: THREE.Object3D, fileName: string): void {
    this.removeModel()
    this.modelRoot = root
    root.traverse((obj) => {
      obj.castShadow = false
      obj.receiveShadow = false
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.filter((material): material is THREE.Material => Boolean(material)).forEach((material) => {
        this.sourceMaterials.add(material)
      })
    })
    this.scene.add(root)
    this.fitCameraToModel()
    this.applyViewMode()
    this.updateStats(fileName)
  }

  /** 移除模型并释放 GPU/内存资源 */
  removeModel(): void {
    if (this.modelRoot) {
      this.disposeObject(this.modelRoot)
      this.sourceMaterials.forEach((material) => this.disposeMaterial(material))
      this.sourceMaterials.clear()
      this.scene.remove(this.modelRoot)
      this.modelRoot = null
    }
    this.removeWireLayer()
    if (this.onStats) {
      this.onStats({ fileName: '', faces: 0, vertices: 0, size: new THREE.Vector3(), hasModel: false })
    }
  }

  /** 当前是否有模型 */
  hasModel(): boolean {
    return this.modelRoot !== null
  }

  /** 当前模型根节点 */
  getModel(): THREE.Object3D | null {
    return this.modelRoot
  }

  /** 递归释放几何、材质、纹理（跳过共享的查看模式缓存材质） */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()

      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const mat of materials) {
        if (!mat) continue
        if (mat === this.solidMaterial) continue
        this.disposeMaterial(mat)
      }
    })
  }

  private disposeMaterial(material: THREE.Material): void {
    for (const key of Object.keys(material) as Array<keyof typeof material>) {
      const value = material[key] as unknown
      if (value instanceof THREE.Texture) value.dispose()
    }
    material.dispose()
  }

  /** 相机自动适配模型包围盒，模型居中到原点 */
  private fitCameraToModel(): void {
    if (!this.modelRoot) return
    const box = new THREE.Box3().setFromObject(this.modelRoot)
    if (box.isEmpty()) return

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    // 把模型中心平移到原点
    const offset = center.clone()
    this.modelRoot.position.sub(offset)

    // 根据包围球直径确定相机距离
    const radius = Math.max(size.length() / 2, 1)
    const fov = (this.camera.fov * Math.PI) / 180
    const distance = (radius / Math.tan(fov / 2)) * 1.15
    this.camera.position.set(distance * 0.7, distance * 0.55, distance)
    this.camera.near = Math.max(distance / 1000, 0.01)
    this.camera.far = Math.max(distance * 100, 100000)
    this.camera.updateProjectionMatrix()
    this.controls.target.set(0, 0, 0)
    this.controls.update()

    this.updateGrid(maxDim)
  }

  /** 网格与坐标轴随模型尺寸自适应 */
  private updateGrid(maxDim: number): void {
    this.scene.remove(this.grid)
    const gridSize = Math.max(100, Math.pow(10, Math.ceil(Math.log10(maxDim)))) * 1.5
    const divisions = 10
    this.grid = new THREE.GridHelper(gridSize, divisions, 0x9ca3af, 0xd1d5db)
    this.grid.position.y = 0
    this.scene.add(this.grid)
  }

  /** 查看模式专用材质缓存，切换模式时复用，避免反复分配 */
  private solidMaterial: THREE.MeshStandardMaterial | null = null
  private frontWireMaterial: THREE.MeshBasicMaterial | null = null

  /** 应用查看模式：白模 / 实体叠加正面布线 */
  private applyViewMode(): void {
    if (!this.modelRoot) return
    this.removeWireLayer()

    // 白模实体材质：首次创建后缓存复用
    if (!this.solidMaterial) {
      this.solidMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0.05
      })
    }
    const isWireMode = this.mode === 'wire'
    this.solidMaterial.transparent = this.modelOpacity < 1
    this.solidMaterial.opacity = this.modelOpacity
    this.solidMaterial.depthWrite = this.modelOpacity === 1
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.material = this.solidMaterial!
      mesh.renderOrder = 1
      mesh.visible = true
    })

    if (!isWireMode) return
    if (!this.frontWireMaterial) {
      this.frontWireMaterial = new THREE.MeshBasicMaterial({
        color: 0x172033, wireframe: true, transparent: true, opacity: 0.92,
        side: THREE.FrontSide, depthWrite: false
      })
    }
    // Mesh wireframe 保留全部三角面；仅绘制正面，避免背面线干扰拓扑判断。
    const wireGroup = new THREE.Group()
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.updateWorldMatrix(true, false)
      const wire = new THREE.Mesh(mesh.geometry, this.frontWireMaterial)
      wire.matrixAutoUpdate = false
      wire.matrix.copy(mesh.matrixWorld)
      wire.renderOrder = 3
      wireGroup.add(wire)
    })
    this.scene.add(wireGroup)
    this.wireLayer = wireGroup
  }

  private removeWireLayer(): void {
    if (this.wireLayer) {
      this.scene.remove(this.wireLayer)
      this.wireLayer = null
    }
  }

  /** 更新 HUD 统计 */
  private updateStats(fileName: string): void {
    if (!this.onStats) return
    if (!this.modelRoot) return

    let faces = 0
    let vertices = 0
    const box = new THREE.Box3()

    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const geo = mesh.geometry
      if (geo) {
        if (geo.index) faces += geo.index.count / 3
        else if (geo.attributes.position) faces += geo.attributes.position.count / 3
        if (geo.attributes.position) vertices += geo.attributes.position.count
        mesh.updateWorldMatrix(true, false)
        box.union(new THREE.Box3().setFromObject(mesh))
      }
    })

    const size = box.getSize(new THREE.Vector3())
    this.onStats({
      fileName,
      faces: Math.round(faces),
      vertices,
      size,
      hasModel: true
    })
  }

  /** 释放渲染循环与观察器（窗口关闭时调用） */
  dispose(): void {
    cancelAnimationFrame(this.animationId)
    this.resizeObserver.disconnect()
    this.removeModel()
    this.solidMaterial?.dispose()
    this.frontWireMaterial?.dispose()
    this.renderer.dispose()
  }

  fitView(): void {
    this.fitCameraToModel()
  }
}
