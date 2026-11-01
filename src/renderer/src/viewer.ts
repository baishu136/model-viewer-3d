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

export interface AnimationState {
  clips: Array<{ name: string; duration: number }>
  selected: number
  time: number
  duration: number
  playing: boolean
  speed: number
  loop: boolean
}

interface NodeRestPose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
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
  private hemiLight: THREE.HemisphereLight
  private keyLight: THREE.DirectionalLight
  private fillLight: THREE.DirectionalLight

  /** 当前场景中唯一的模型根节点 */
  private modelRoot: THREE.Object3D | null = null
  private modelContainer = new THREE.Group()
  /** 线框叠加层（wire 模式） */
  private wireLayer: THREE.Object3D | null = null
  private sourceMaterials = new Set<THREE.Material>()
  private wireMeshes: Array<{ source: THREE.Mesh; wire: THREE.Mesh }> = []
  private pointMaterial = new THREE.PointsMaterial({ color: 0x555555, size: 2, sizeAttenuation: false })
  private mixer: THREE.AnimationMixer | null = null
  private clips: THREE.AnimationClip[] = []
  private clipInfo: AnimationState['clips'] = []
  private action: THREE.AnimationAction | null = null
  private selectedClip = -1
  private playing = false
  private isAnimated = false
  private wireNeedsSync = false
  private restPoses = new Map<THREE.Object3D, NodeRestPose>()
  private restMorphInfluences = new Map<THREE.Mesh, number[]>()
  private speed = 1
  private loop = true
  private clock = new THREE.Clock()
  private lastAnimationUpdate = 0
  private onAnimation?: (state: AnimationState) => void

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

    // 演播室级 3 点光照系统 + 视点跟随补光：塑造自然明暗转折与微高光，彻底解决白模死黑与二次元脸部黑斑
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.75)
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.60)
    this.keyLight.position.set(1.5, 2.2, 1.8)
    this.fillLight = new THREE.DirectionalLight(0xf1f5f9, 0.45)
    this.fillLight.position.set(-1.8, 0.8, -1.2)

    // 相机跟随灯：直射视点中心，软化风格化/二次元角色眼窝与下巴阴影
    const headLight = new THREE.DirectionalLight(0xffffff, 0.35)
    this.camera.add(headLight)
    this.scene.add(this.camera)
    this.scene.add(this.hemiLight, this.keyLight, this.fillLight)

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

  setAnimationCallback(cb: (state: AnimationState) => void): void {
    this.onAnimation = cb
    this.emitAnimationState()
  }

  getAnimationState(): AnimationState {
    return {
      clips: this.clipInfo, selected: this.selectedClip,
      time: this.action?.time ?? 0, duration: this.action?.getClip().duration ?? 0,
      playing: this.playing, speed: this.speed, loop: this.loop
    }
  }

  private emitAnimationState(): void {
    this.onAnimation?.(this.getAnimationState())
  }

  private resetToRestPose(): void {
    if (!this.modelRoot) return
    for (const [node, rest] of this.restPoses) {
      node.position.copy(rest.position)
      node.quaternion.copy(rest.quaternion)
      node.scale.copy(rest.scale)
    }
    this.modelRoot.traverse((obj) => {
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = obj as THREE.SkinnedMesh
        skinned.skeleton?.update()
      }
    })
    for (const [mesh, morphs] of this.restMorphInfluences) {
      if (mesh.morphTargetInfluences) {
        for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
          mesh.morphTargetInfluences[i] = morphs[i] ?? 0
        }
      }
    }
    this.modelRoot.updateMatrixWorld(true)
  }

  selectAnimation(index: number): void {
    if (!this.mixer || !this.clips[index]) return
    this.mixer.stopAllAction()
    this.resetToRestPose()
    this.selectedClip = index
    this.action = this.mixer.clipAction(this.clips[index]).reset()
    this.action.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, this.loop ? Infinity : 1)
    this.action.clampWhenFinished = true
    this.action.play()
    this.action.paused = true
    this.playing = false
    this.mixer.update(0)
    this.wireNeedsSync = true
    this.emitAnimationState()
  }

  togglePlayback(): void {
    if (!this.action) return
    if (!this.playing && this.action.time >= this.action.getClip().duration) this.action.reset().play()
    this.playing = !this.playing
    this.action.paused = !this.playing
    this.wireNeedsSync = true
    this.emitAnimationState()
  }

  seekAnimation(time: number): void {
    if (!this.action || !this.mixer) return
    this.playing = false
    this.action.enabled = true
    this.action.paused = true
    this.action.time = THREE.MathUtils.clamp(time, 0, this.action.getClip().duration)
    this.mixer.update(0)
    this.wireNeedsSync = true
    this.emitAnimationState()
  }

  setAnimationSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return
    this.speed = speed
    this.emitAnimationState()
  }

  setAnimationLoop(loop: boolean): void {
    this.loop = loop
    this.action?.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    this.emitAnimationState()
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
    const delta = Math.min(this.clock.getDelta(), 0.05)
    if (this.isAnimated && this.mixer && this.playing) {
      this.mixer.update(delta * this.speed)
      this.wireNeedsSync = true
      if (performance.now() - this.lastAnimationUpdate > 100) {
        this.lastAnimationUpdate = performance.now()
        this.emitAnimationState()
      }
    }
    // 动静分治：仅在动画播放或视角/形态发生变化时同步线框，静态模型每帧 0 矩阵运算开销
    if (this.wireNeedsSync) {
      this.syncWireMeshes()
      this.wireNeedsSync = false
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * 替换场景中的模型：释放旧模型的所有资源，再添加新模型。
   * 确保场景永远只有一个模型。
   */
  setModel(root: THREE.Object3D, fileName: string, clips: THREE.AnimationClip[] = [], scaleToMm = 1): void {
    this.removeModel()
    this.modelRoot = root
    // Centre/scale a separate parent so animation tracks never overwrite viewer transforms.
    this.modelContainer = new THREE.Group()
    this.modelContainer.scale.setScalar(scaleToMm)
    this.modelContainer.add(root)
    this.clips = clips.filter((clip) => clip.duration > 0 && clip.tracks.length > 0)
    this.clipInfo = this.clips.map((clip, i) => ({ name: clip.name || `动画 ${i + 1}`, duration: clip.duration }))
    this.isAnimated = this.clips.length > 0

    // 缓存初始 Rest Pose
    this.restPoses.clear()
    this.restMorphInfluences.clear()

    root.traverse((obj) => {
      this.restPoses.set(obj, {
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      })
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh
        if (m.morphTargetInfluences) {
          this.restMorphInfluences.set(m, [...m.morphTargetInfluences])
        }
      }

      obj.castShadow = false
      obj.receiveShadow = false
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh && !(obj as THREE.Points).isPoints && !(obj as THREE.Line).isLine) return

      // Fix: If mesh has morphAttributes but no active morph tracks in clips,
      // clear morphAttributes to avoid Three.js shader crash ('MORPHTARGETS_COUNT' undeclared)
      if (mesh.geometry?.morphAttributes && (!this.clips.length || !mesh.morphTargetInfluences?.length)) {
        mesh.geometry.morphAttributes = {}
        mesh.morphTargetInfluences = undefined
        mesh.morphTargetDictionary = undefined
      }

      // Ensure SkinnedMesh skeleton matrices are updated
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = mesh as THREE.SkinnedMesh
        skinned.skeleton?.update()
      }

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.filter((material): material is THREE.Material => Boolean(material)).forEach((material) => {
        this.sourceMaterials.add(material)
      })
    })
    this.scene.add(this.modelContainer)
    if (this.clips.length) {
      this.mixer = new THREE.AnimationMixer(root)
      this.mixer.addEventListener('finished', () => {
        this.playing = false
        this.emitAnimationState()
      })
      this.selectAnimation(0)
    } else {
      this.emitAnimationState()
    }
    this.fitCameraToModel()
    this.applyViewMode()
    this.updateStats(fileName)
    this.wireNeedsSync = true
  }

  /** 移除模型并释放 GPU/内存资源 */
  removeModel(): void {
    this.removeWireLayer()
    this.mixer?.stopAllAction()
    if (this.modelRoot) this.mixer?.uncacheRoot(this.modelRoot)
    this.mixer = null
    this.action = null
    this.clips = []
    this.clipInfo = []
    this.selectedClip = -1
    this.playing = false
    this.isAnimated = false
    this.wireNeedsSync = false
    this.restPoses.clear()
    this.restMorphInfluences.clear()
    if (this.modelRoot) {
      this.disposeObject(this.modelRoot)
      this.sourceMaterials.forEach((material) => this.disposeMaterial(material))
      this.sourceMaterials.clear()
      this.scene.remove(this.modelContainer)
      this.modelContainer.remove(this.modelRoot)
      this.modelRoot = null
    }
    this.emitAnimationState()
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
    const geometries = new Set<THREE.BufferGeometry>()
    const skeletons = new Set<THREE.Skeleton>()
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.geometry) geometries.add(mesh.geometry)
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((mesh as THREE.SkinnedMesh).skeleton)
    })
    geometries.forEach((geo) => geo.dispose())
    skeletons.forEach((skeleton) => skeleton.dispose())
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
    this.modelContainer.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(this.modelContainer, true)
    if (box.isEmpty()) return

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)

    // 把模型中心平移到原点
    const offset = center.clone()
    this.modelContainer.position.sub(offset)
    this.modelContainer.updateMatrixWorld(true)

    // 智能视口与展板自适应
    const isStandee =
      !!this.modelRoot.getObjectByName('MarkdownPreviewCard') ||
      size.z <= 0.005 * Math.max(size.x, size.y)

    const fovV = (this.camera.fov * Math.PI) / 180
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect)

    let distance: number
    if (isStandee) {
      // 3D 视口立体展台：赋予优雅微透视立体角（X: 0.25, Y: 0.18, Z: 1.0），直观展现 3D 厚度与空间立体层次
      const radius = Math.max(size.length() / 2, 0.01)
      const distV = radius / Math.tan(fovV / 2)
      const distH = radius / Math.tan(fovH / 2)
      distance = Math.max(distV, distH, 1) * 1.15
      const dir = new THREE.Vector3(0.25, 0.18, 1.0).normalize()
      this.camera.position.copy(dir.multiplyScalar(distance))
    } else {
      // 3D 立体模型：黄金等轴测斜视角
      const radius = Math.max(size.length() / 2, 0.01)
      const distV = radius / Math.tan(fovV / 2)
      const distH = radius / Math.tan(fovH / 2)
      distance = Math.max(distV, distH, 1) * 1.18
      const dir = new THREE.Vector3(0.7, 0.55, 1.0).normalize()
      this.camera.position.copy(dir.multiplyScalar(distance))
    }

    // 全动态近远裁剪面保护：维持最佳 1:5000 深度缓冲精度，杜绝微小模型 Z-fighting 与大建筑近切穿模
    this.camera.near = Math.max(distance * 0.005, 0.005)
    this.camera.far = Math.max(distance * 50, 200)
    this.camera.updateProjectionMatrix()

    this.controls.target.set(0, 0, 0)
    this.controls.minDistance = Math.max(distance * 0.02, 0.01)
    this.controls.maxDistance = distance * 10
    this.controls.update()

    this.updateGrid(maxDim, size.y)
  }

  /** 网格与坐标轴随模型尺寸自适应 */
  private updateGrid(maxDim: number, modelHeight = 0): void {
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    const materials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]
    materials.forEach((material) => material.dispose())
    const safeDim = Math.max(maxDim, 0.01)
    const exponent = Math.ceil(Math.log10(safeDim))
    const gridStep = Math.pow(10, exponent)
    const gridSize = gridStep * 1.5
    const divisions = 10
    this.grid = new THREE.GridHelper(gridSize, divisions, 0xd1d5db, 0xe5e7eb)
    if (modelHeight > 0) {
      this.grid.position.y = -modelHeight / 2 // 网格贴合模型底部接触面，产生真实着地感
    } else {
      this.grid.position.y = 0
    }
    this.scene.add(this.grid)
    this.axes.scale.setScalar(Math.max(safeDim * 0.35, 1))
  }

  /** 查看模式专用材质缓存，切换模式时复用，避免反复分配 */
  private solidMaterial: THREE.MeshStandardMaterial | null = null
  private frontWireMaterial: THREE.MeshBasicMaterial | null = null

  /** 应用查看模式：白模 / 实体叠加正面布线 */
  private applyViewMode(): void {
    if (!this.modelRoot) return
    this.removeWireLayer()

    // 白模实体材质：首次创建后缓存复用，采用双面渲染与柔和微漫反射，彻底消除风格化/二次元黑斑与裙摆破面
    if (!this.solidMaterial) {
      this.solidMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.90,
        metalness: 0.02,
        side: THREE.DoubleSide
      })
    }
    const isWireMode = this.mode === 'wire'
    this.solidMaterial.transparent = this.modelOpacity < 1
    this.solidMaterial.opacity = this.modelOpacity
    this.solidMaterial.depthWrite = this.modelOpacity === 1
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if ((child as THREE.Points).isPoints) {
        (child as THREE.Points).material = this.pointMaterial
        this.pointMaterial.opacity = this.modelOpacity
        this.pointMaterial.transparent = this.modelOpacity < 1
        return
      }
      if (!mesh.isMesh) return
      if (mesh.name === 'MarkdownPreviewCard') {
        mesh.renderOrder = 1
        mesh.visible = true
        return
      }
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
      let wire: THREE.Mesh
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const source = mesh as THREE.SkinnedMesh
        const skinned = new THREE.SkinnedMesh(mesh.geometry, this.frontWireMaterial!)
        skinned.bindMode = source.bindMode
        skinned.skeleton = source.skeleton
        skinned.bindMatrix.copy(source.bindMatrix)
        skinned.bindMatrixInverse.copy(source.bindMatrixInverse)
        wire = skinned
      } else {
        wire = new THREE.Mesh(mesh.geometry, this.frontWireMaterial!)
      }
      wire.morphTargetInfluences = mesh.morphTargetInfluences
      wire.morphTargetDictionary = mesh.morphTargetDictionary
      wire.matrixAutoUpdate = false
      wire.matrix.copy(mesh.matrixWorld)
      wire.renderOrder = 3
      wire.frustumCulled = false
      wireGroup.add(wire)
      this.wireMeshes.push({ source: mesh, wire })
    })
    this.scene.add(wireGroup)
    this.wireLayer = wireGroup
  }

  private removeWireLayer(): void {
    this.wireMeshes = []
    if (this.wireLayer) {
      this.scene.remove(this.wireLayer)
      this.wireLayer = null
    }
  }

  /** Wire overlays share the current skeleton/morph pose and follow animated object transforms. */
  private syncWireMeshes(): void {
    if (!this.wireLayer || !this.modelRoot) return
    this.modelRoot.updateWorldMatrix(false, true)
    for (const { source, wire } of this.wireMeshes) {
      wire.matrix.copy(source.matrixWorld)
      wire.matrixWorldNeedsUpdate = true
      wire.morphTargetInfluences = source.morphTargetInfluences
      if ((wire as THREE.SkinnedMesh).isSkinnedMesh) {
        (wire as THREE.SkinnedMesh).bindMatrixInverse.copy((source as THREE.SkinnedMesh).bindMatrixInverse)
      }
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
      if (!mesh.isMesh && !(child as THREE.Points).isPoints) return
      const geo = mesh.geometry
      if (geo) {
        if (mesh.isMesh) {
          if (geo.index) faces += geo.index.count / 3
          else if (geo.attributes.position) faces += geo.attributes.position.count / 3
        }
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
    this.pointMaterial.dispose()
    this.keyLight.dispose()
    this.fillLight.dispose()
    this.hemiLight.dispose()
    this.renderer.dispose()
  }

  fitView(): void {
    this.fitCameraToModel()
  }
}
