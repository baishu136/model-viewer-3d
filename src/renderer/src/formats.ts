import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { MODEL_EXTENSIONS } from '../../shared/model-formats'
import { BlendLoader } from './loaders/BlendLoader'
import { MayaAsciiLoader } from './loaders/MayaAsciiLoader'
import { MayaBinaryLoader } from './loaders/MayaBinaryLoader'
import { C4DLoader } from './loaders/C4DLoader'
import { MaxLoader } from './loaders/MaxLoader'
import { Fbx6Loader } from './loaders/Fbx6Loader'
import { PMXExporter } from './loaders/utils/PMXExporter'
import { isMmdModel, parseMmdModel } from './loaders/MmdModelLoader'
import { compactSceneGeometry } from './loaders/utils/compact-geometry'
import { StaticVRMExporter } from './loaders/utils/StaticVRMExporter'

export const SUPPORTED_EXTENSIONS = MODEL_EXTENSIONS
export const EXPORT_FORMATS = ['obj', 'stl', 'fbx', 'glb', 'gltf', 'ply', 'pmx', 'vrm']

// ---------------------------------------------------------------
// model:// 本地文件协议桥接
// ---------------------------------------------------------------

/** 将 Windows 绝对路径编码为合法标准 model:// URL（严格规范化为正斜杠，盘符与各路径段独立转义，防止 Chromium Request 异常） */
export function toModelUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  const match = normalized.match(/^([A-Za-z]:)(\/.*)$/)
  if (match) {
    const drive = match[1]
    const rest = match[2]
    const encodedRest = rest.split('/').map((seg) => (seg ? encodeURIComponent(seg) : '')).join('/')
    return `model://local/${drive}${encodedRest}`
  }
  const encoded = normalized.split('/').map((seg) => (seg ? encodeURIComponent(seg) : '')).join('/')
  return `model://local/${encoded}`
}

/** 目录 URL（末尾保留分隔符，便于 three 拼接相对路径） */
function toDirUrl(dir: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  return toModelUrl(d) + '/'
}

/** 简易 Windows 路径拼接（渲染进程无法使用 node:path） */
function joinWindows(dir: string, rel: string): string {
  let base = dir.replace(/[\\/]+$/, '')
  const parts = rel.split(/[\\/]+/)
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      base = base.replace(/[^\\/]+$/, '').replace(/[\\/]+$/, '')
    } else {
      base += '\\' + part
    }
  }
  return base
}

/** URL 修饰器：把加载器请求的相对/绝对资源路径统一转成 model:// URL */
function resolveModelUrl(url: string, dir: string): string {
  if (url.startsWith('model://') || url.startsWith('data:') || url.startsWith('blob:')) return url
  if (/^[A-Za-z]:[\\/]/.test(url)) return toModelUrl(url)
  if (dir) {
    const joined = joinWindows(dir, decodeURIComponent(url))
    return toModelUrl(joined)
  }
  return url
}

const decoderUrl = new URL('./draco/', window.location.href)
const decoderPath = decoderUrl.protocol === 'file:'
  ? toDirUrl(decodeURIComponent(decoderUrl.pathname).replace(/^\/(?=[A-Za-z]:)/, ''))
  : decoderUrl.href
const dracoLoader = new DRACOLoader()
  .setDecoderPath(decoderPath)
  .setDecoderConfig({ type: 'wasm' })

// ---------------------------------------------------------------
// 单位自动识别
// ---------------------------------------------------------------

export type UnitKind = 'mm' | 'cm' | 'm'

/** 模型单位 → mm 的换算系数 */
export const UNIT_TO_MM: Record<UnitKind, number> = { mm: 1, cm: 10, m: 1000 }

/**
 * FBX 读取 UnitScaleFactor（相对 cm）：1=cm，0.1=mm，100=m。
 * 在二进制 FBX 中属性名以 ASCII 存于文件内，因此可直接在 buffer 中检索文本。
 */
function detectFbxUnit(buffer: ArrayBuffer): UnitKind | null {
  const bytes = new Uint8Array(buffer)
  let factor: number | null = null
  if (new TextDecoder().decode(bytes.subarray(0, 18)).startsWith('Kaydara FBX Binary')) {
    const name = new TextEncoder().encode('UnitScaleFactor')
    const view = new DataView(buffer)
    // Binary FBX Properties70 stores the name as a string, followed by three
    // string descriptors and a typed double. Reading it as ASCII cannot find the value.
    for (let start = bytes.indexOf(name[0], 4); start >= 0; start = bytes.indexOf(name[0], start + 1)) {
      if (view.getUint32(start - 4, true) !== name.length || !name.every((byte, i) => bytes[start + i] === byte)) continue
      let cursor = start + name.length
      while (cursor + 5 <= bytes.length && bytes[cursor] === 83) {
        cursor += 5 + view.getUint32(cursor + 1, true)
      }
      if (cursor + 9 <= bytes.length && bytes[cursor] === 68) {
        factor = view.getFloat64(cursor + 1, true)
        break
      }
    }
  } else {
    const text = new TextDecoder().decode(buffer)
    const m = text.match(/\bUnitScaleFactor[^\d\-+.]*([\d.]+)/)
    if (m) factor = parseFloat(m[1])
  }
  if (factor === null) return null
  if (Math.abs(factor - 0.1) < 1e-6) return 'mm'
  if (Math.abs(factor - 1) < 1e-6) return 'cm'
  if (Math.abs(factor - 100) < 1e-6) return 'm'
  return null
}

/** 根据文件格式与内容自动推断默认单位 */
export async function detectUnit(filePath: string, buffer: ArrayBuffer): Promise<UnitKind> {
  const ext = filePath.toLowerCase().split('.').pop() || ''
  if (ext === 'fbx') {
    const u = detectFbxUnit(buffer)
    if (u) return u
  }
  if (ext === 'blend' || ext === 'blender' || ext === 'glb' || ext === 'gltf' || ext === 'vrm') return 'm'
  if (ext === 'ma' || ext === 'mb' || ext === 'c4d' || ext === 'max' || ext === 'pmx' || ext === 'pmd' || ext === 'md') return 'cm'
  return 'mm'
}

// ---------------------------------------------------------------
// 加载
// ---------------------------------------------------------------

export interface LoadResult {
  root: THREE.Object3D
  unit: UnitKind
  animations: THREE.AnimationClip[]
}

function makeMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.90,
    metalness: 0.02,
    side: THREE.DoubleSide
  })
}

function applyWhiteMaterial(object: THREE.Object3D): void {
  const oldMaterials = new Set<THREE.Material>()
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      if (mesh.name === 'MarkdownPreviewCard') return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) oldMaterials.add(material)
      mesh.material = makeMaterial()
      if (!mesh.geometry.getAttribute('normal')) {
        mesh.geometry.computeVertexNormals()
      }
    }
  })
  oldMaterials.forEach((material) => material.dispose())
}

/** Reject empty/invalid parses instead of displaying a blank or exploding model as a successful load. */
function validateModel(root: THREE.Object3D): void {
  let vertices = 0
  root.updateMatrixWorld(true)
  root.traverse((object) => {
    if (!object.matrixWorld.elements.every(Number.isFinite)) throw new Error(`模型节点 ${object.name || ''} 含无效变换。`)
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh && !(object as THREE.Points).isPoints && !(object as THREE.Line).isLine) return
    const position = mesh.geometry?.getAttribute('position')
    if (!position) return
    vertices += position.count
    for (let i = 0; i < position.count; i++) {
      if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) {
        throw new Error(`模型 ${object.name || ''} 含无效顶点坐标，无法正常显示。`)
      }
    }
    const indices = mesh.geometry.getIndex()
    if (indices) for (let i = 0; i < indices.count; i++) {
      if (indices.getX(i) >= position.count || indices.getX(i) < 0) throw new Error('模型面索引超出顶点范围，文件可能损坏或包含尚未支持的数据。')
    }
    if (mesh.isMesh && !mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
  })
  if (vertices === 0) throw new Error('该文件未解析到可显示的几何数据。原生工程可能需要先烘焙修改器或导出为 FBX/GLB。')
}

/** 判断是否为 three.js FBXLoader 无法处理的旧版二进制 FBX（FileVersion < 7000） */
function isLegacyFbxBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 27) return false
  const bytes = new Uint8Array(buffer, 0, 27)
  const header = String.fromCharCode(...bytes.subarray(0, 18))
  if (header !== 'Kaydara FBX Binary') return false
  const view = new DataView(buffer, 0, 27)
  const version = view.getUint32(23, true)
  return version > 0 && version < 7000
}

async function readBuffer(filePath: string): Promise<ArrayBuffer> {
  // contextBridge 序列化可能返回 Uint8Array/SharedArrayBuffer，
  // 显式复制为干净的新 ArrayBuffer，避免 STLLoader 等解析出错
  const raw = await window.api.readFile(filePath)
  const u8 = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBufferLike)
  const copy = new ArrayBuffer(u8.byteLength)
  new Uint8Array(copy).set(u8)
  return copy
}

/** 加载任意受支持的 3D 文件到场景 */
export async function loadModelFile(filePath: string): Promise<LoadResult> {
  const buffer = await readBuffer(filePath)
  let unit = await detectUnit(filePath, buffer)

  // 计算模型所在目录，供相对资源解析
  const norm = filePath.replace(/\\/g, '/')
  const dir = norm.includes('/') ? norm.substring(0, norm.lastIndexOf('/')) : ''
  // A manager per load avoids resolving concurrent .gltf buffers against another model's directory.
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => resolveModelUrl(url, dir))

  const ext = (filePath.toLowerCase().split('.').pop() || '').toLowerCase()
  let root: THREE.Object3D
  let animations: THREE.AnimationClip[] = []

  switch (ext) {
    case 'obj': {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer))
      const loader = new OBJLoader(manager)
      root = loader.parse(text)
      applyWhiteMaterial(root)
      break
    }
    case 'fbx': {
      if (isLegacyFbxBinary(buffer)) {
        // three.js 的 FBXLoader 只支持 FileVersion >= 6400 的布局，
        // 早期 3ds Max/Maya 导出的 6.x 二进制需要专用解析器。
        const loader = new Fbx6Loader()
        root = loader.parse(buffer)
      } else {
        const loader = new FBXLoader(manager)
        root = loader.parse(buffer, dir)
        animations = root.animations
      }
      applyWhiteMaterial(root)
      break
    }
    case 'glb':
    case 'gltf':
    case 'vrm': {
      const loader = new GLTFLoader(manager)
      let vrmVersion: string | null = null
      loader.setDRACOLoader(dracoLoader)
      loader.setMeshoptDecoder(MeshoptDecoder)
      loader.register((parser) => ({
        name: 'VIEWER_geometry_only',
        beforeRoot: () => {
          const extensions = parser.json.extensions ?? {}
          if (extensions.VRMC_vrm) {
            vrmVersion = extensions.VRMC_vrm.specVersion
            if (!vrmVersion?.startsWith('1.0')) throw new Error(`暂不支持 VRM 版本：${vrmVersion}`)
          } else if (extensions.VRM) vrmVersion = '0'
          else if (ext === 'vrm') throw new Error('该 .vrm 文件未包含 VRM 0.x / 1.0 扩展信息。')
          // Retain the nodes and their transforms, but never instantiate file cameras/lights.
          for (const node of parser.json.nodes ?? []) {
            delete node.camera
            if (node.extensions) delete node.extensions.KHR_lights_punctual
          }
          parser.json.cameras = []
          return null
        },
        // Replacing the material dependency also bypasses all texture/image decoding.
        loadMaterial: () => Promise.resolve(makeMaterial())
      }))
      const gltf = await loader.parseAsync(buffer, '')
      root = gltf.scene
      if (vrmVersion) {
        compactSceneGeometry(root)
        // VRM 0 faces -Z; VRM 1 faces +Z. Rotate a wrapper so animated root tracks cannot undo it.
        const avatar = new THREE.Group()
        avatar.name = 'VrmRoot'
        avatar.userData.vrmVersion = vrmVersion
        avatar.rotation.y = vrmVersion === '0' ? Math.PI : 0
        avatar.add(root)
        root = avatar
      }
      animations = gltf.animations
      unit = 'm' // glTF coordinates are in metres.
      break
    }
    case 'stl': {
      const loader = new STLLoader(manager)
      const geo = loader.parse(buffer)
      root = new THREE.Mesh(geo, makeMaterial())
      break
    }
    case 'ply': {
      const geo = new PLYLoader(manager).parse(buffer)
      const header = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536))).split('end_header')[0]
      const hasFaces = /element\s+face\s+[1-9]\d*/.test(header)
      if (hasFaces && !geo.getAttribute('normal')) geo.computeVertexNormals()
      // PLY files without faces are point clouds, not triangle soups.
      root = hasFaces
        ? new THREE.Mesh(geo, makeMaterial())
        : new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x555555, size: 2, sizeAttenuation: false }))
      break
    }
    case 'pmx':
    case 'pmd': {
      root = parseMmdModel(buffer, manager, makeMaterial)
      break
    }
    case 'blend':
    case 'blender': {
      const loader = new BlendLoader(manager)
      root = loader.parse(buffer)
      applyWhiteMaterial(root)
      unit = 'm'
      break
    }
    case 'ma': {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer))
      const loader = new MayaAsciiLoader(manager)
      root = loader.parse(text)
      compactSceneGeometry(root)
      applyWhiteMaterial(root)
      unit = loader.unit
      break
    }
    case 'mb': {
      const loader = new MayaBinaryLoader(manager)
      root = loader.parse(buffer)
      applyWhiteMaterial(root)
      unit = 'cm'
      break
    }
    case 'c4d': {
      const loader = new C4DLoader(manager)
      root = loader.parse(buffer)
      applyWhiteMaterial(root)
      unit = 'cm'
      break
    }
    case 'max': {
      const loader = new MaxLoader(manager)
      root = loader.parse(buffer)
      applyWhiteMaterial(root)
      unit = 'cm'
      break
    }
    case 'md': {
      const bytes = new Uint8Array(buffer)
      // Check if it is a PMD/PMX model mistakenly named .md
      if (isMmdModel(buffer)) {
        root = parseMmdModel(buffer, manager, makeMaterial)
        unit = 'cm'
        break
      }
      // Otherwise render an elegant Markdown document preview card in 3D scene
      const text = new TextDecoder('utf-8').decode(bytes)
      const lines = text.split('\n').slice(0, 10).map((l) => l.trim()).filter(Boolean)
      const canvas = document.createElement('canvas')
      canvas.width = 512
      canvas.height = 340
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#1e293b'
        ctx.fillRect(0, 0, 512, 340)
        ctx.fillStyle = '#38bdf8'
        ctx.font = 'bold 22px sans-serif'
        ctx.fillText('Markdown 文档 (.md)', 30, 50)
        ctx.fillStyle = '#cbd5e1'
        ctx.font = '15px sans-serif'
        let y = 90
        for (const line of lines.slice(0, 7)) {
          ctx.fillText(line.substring(0, 40), 30, y)
          y += 28
        }
        ctx.fillStyle = '#94a3b8'
        ctx.font = '13px monospace'
        ctx.fillText('提示: 请选择同目录下的 3D 模型文件查看', 30, 310)
      }
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
      const geometry = new THREE.PlaneGeometry(100, 66.4)
      geometry.translate(0, 33.2, 0)
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
      const cardMesh = new THREE.Mesh(geometry, material)
      cardMesh.name = 'MarkdownPreviewCard' // 文档预览卡：viewer 中保持原材质
      root = new THREE.Group()
      root.name = 'MarkdownRoot'
      root.add(cardMesh)
      unit = 'cm'
      break
    }
    default:
      throw new Error(`不支持的格式: .${ext}`)
  }

  try { validateModel(root) } catch (error) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material?.dispose()
    })
    throw error
  }
  return { root, unit, animations }
}

// ---------------------------------------------------------------
// 导出
// ---------------------------------------------------------------

export interface ExportFormatInfo {
  ext: string
  name: string
  filters: Array<{ name: string; extensions: string[] }>
  defaultName: string
}

const FORMAT_INFO: Record<string, ExportFormatInfo> = {
  obj: {
    ext: 'obj',
    name: 'Wavefront OBJ',
    filters: [{ name: 'Wavefront OBJ (*.obj)', extensions: ['obj'] }],
    defaultName: 'model.obj'
  },
  stl: {
    ext: 'stl',
    name: 'STL (二进制)',
    filters: [{ name: 'STL 文件 (*.stl)', extensions: ['stl'] }],
    defaultName: 'model.stl'
  },
  fbx: {
    ext: 'fbx',
    name: 'Autodesk FBX (二进制)',
    filters: [{ name: 'Autodesk FBX (*.fbx)', extensions: ['fbx'] }],
    defaultName: 'model.fbx'
  },
  glb: {
    ext: 'glb',
    name: 'glTF 2.0 二进制 (.glb)',
    filters: [{ name: 'glTF 二进制模型 (*.glb)', extensions: ['glb'] }],
    defaultName: 'model.glb'
  },
  gltf: {
    ext: 'gltf',
    name: 'glTF 2.0 文本 (.gltf)',
    filters: [{ name: 'glTF 文本模型 (*.gltf)', extensions: ['gltf'] }],
    defaultName: 'model.gltf'
  },
  ply: {
    ext: 'ply',
    name: 'PLY 几何体文件 (.ply)',
    filters: [{ name: 'PLY 几何体文件 (*.ply)', extensions: ['ply'] }],
    defaultName: 'model.ply'
  },
  pmx: {
    ext: 'pmx',
    name: 'MMD 模型文件 (.pmx)',
    filters: [{ name: 'MMD 模型 (*.pmx)', extensions: ['pmx'] }],
    defaultName: 'model.pmx'
  },
  vrm: {
    ext: 'vrm',
    name: 'VRM 1.0 静态模型（基础骨架）',
    filters: [{ name: 'VRM 静态模型 (*.vrm)', extensions: ['vrm'] }],
    defaultName: 'model.vrm'
  }
}

export function getExportFormats(): ExportFormatInfo[] {
  return EXPORT_FORMATS.map((format) => FORMAT_INFO[format])
}

/** 序列化导出数据（blob 字节），不写盘 */
export async function serializeModel(
  format: string,
  modelRoot: THREE.Object3D,
  baseName: string
): Promise<{ data: Uint8Array; info: ExportFormatInfo }> {
  const info = FORMAT_INFO[format]
  if (!info) throw new Error(`不支持的导出格式: ${format}`)

  // 导出前把各 mesh 世界变换烘焙进几何，避免居中偏移导致的错位
  const work = new THREE.Group()
  modelRoot.updateWorldMatrix(true, true)
  modelRoot.updateMatrixWorld(true)
  modelRoot.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const geo = (mesh.geometry as THREE.BufferGeometry).clone()
    // Existing exports remain static: bake the displayed skin/morph pose into the mesh.
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.morphTargetInfluences?.length) {
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) (mesh as THREE.SkinnedMesh).skeleton.update()
      const positions = geo.getAttribute('position')
      const vertex = new THREE.Vector3()
      for (let i = 0; i < positions.count; i++) {
        mesh.getVertexPosition(i, vertex)
        positions.setXYZ(i, vertex.x, vertex.y, vertex.z)
      }
      geo.morphAttributes = {}
      geo.computeVertexNormals()
    }
    // Static snapshots have already baked the pose; do not emit skin attributes without a skin.
    geo.deleteAttribute('skinIndex')
    geo.deleteAttribute('skinWeight')
    geo.morphAttributes = {}
    const m = mesh.matrixWorld.clone()
    // 世界变换烘焙进几何，导出时 newMesh 位于世界原点，避免坐标错位
    geo.applyMatrix4(m)
    if (m.determinant() < 0) {
      if (!geo.index) geo.setIndex(Array.from({ length: geo.getAttribute('position').count }, (_, i) => i))
      for (let i = 0; i < geo.index!.count; i += 3) {
        const b = geo.index!.getX(i + 1)
        geo.index!.setX(i + 1, geo.index!.getX(i + 2)); geo.index!.setX(i + 2, b)
      }
    }
    // glTF uses metres; MMD uses the viewer's centimetre convention. All other snapshot formats use mm.
    if (format === 'glb' || format === 'gltf' || format === 'vrm') geo.scale(0.001, 0.001, 0.001)
    else if (format === 'pmx') geo.scale(0.1, 0.1, 0.1)
    const orig = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const newMesh = new THREE.Mesh(geo, orig ?? makeMaterial())
    newMesh.name = mesh.name || `Mesh_${work.children.length + 1}`
    work.add(newMesh)
  })

  if (!work.children.length) throw new Error('当前文件只有点或线，无法导出为三角网格。')

  let data: Uint8Array
  try {
    switch (format) {
    case 'obj': {
      const text = new OBJExporter().parse(work)
      data = new TextEncoder().encode(text)
      break
    }
    case 'stl': {
      const exporter = new STLExporter()
      const result = exporter.parse(work, { binary: true })
      data = result instanceof DataView ? new Uint8Array(result.buffer) : new TextEncoder().encode(result as string)
      break
    }
    case 'fbx': {
      const exporter = new FBXExporter()
      // Internal/viewer coordinates and the baked snapshot are in millimetres.
      const bytes = exporter.parseSync(work, { unitScale: 0.1, includeAnimations: false })
      data = bytes
      break
    }
    case 'glb': {
      const exporter = new GLTFExporter()
      const result = await exporter.parseAsync(work, { binary: true })
      data = new Uint8Array(result as ArrayBuffer)
      break
    }
    case 'gltf': {
      const exporter = new GLTFExporter()
      const result = await exporter.parseAsync(work, { binary: false })
      data = new TextEncoder().encode(JSON.stringify(result, null, 2))
      break
    }
    case 'ply': {
      const exporter = new PLYExporter()
      const result = exporter.parse(work, () => {}, { binary: true, littleEndian: true })
      if (!result) throw new Error('PLY 导出失败：没有可导出的顶点。')
      data = new Uint8Array(result)
      break
    }
    case 'pmx': {
      const exporter = new PMXExporter()
      data = exporter.parse(work)
      break
    }
    case 'vrm': {
      data = await new StaticVRMExporter().parse(work, baseName.replace(/\.[^.]+$/, ''))
      break
    }
    default:
      throw new Error(`不支持的导出格式: ${format}`)
    }
  } finally {
    work.traverse((object) => { (object as THREE.Mesh).geometry?.dispose() })
  }

  const extName = baseName.replace(/\.[^.]+$/, '')
  return { data, info: { ...info, defaultName: `${extName || 'model'}.${info.ext}` } }
}

/** 导出当前模型，弹出保存对话框并写入文件 */
export async function exportModel(format: string, modelRoot: THREE.Object3D, baseName: string): Promise<boolean> {
  const { data, info } = await serializeModel(format, modelRoot, baseName)
  const res = await window.api.saveFileDialog({
    defaultName: info.defaultName,
    filters: info.filters
  })
  if (res.canceled || !res.filePath) return false
  await window.api.writeFile(res.filePath, data)
  return true
}
