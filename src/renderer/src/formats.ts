import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { MODEL_EXTENSIONS } from '../../shared/model-formats'
import { BlendLoader } from './loaders/BlendLoader'
import { MayaAsciiLoader } from './loaders/MayaAsciiLoader'
import { MayaBinaryLoader } from './loaders/MayaBinaryLoader'
import { C4DLoader } from './loaders/C4DLoader'

export const SUPPORTED_EXTENSIONS = MODEL_EXTENSIONS
export const EXPORT_FORMATS = ['obj', 'stl', 'fbx']

// ---------------------------------------------------------------
// model:// 本地文件协议桥接
// ---------------------------------------------------------------

/** 将 Windows 绝对路径编码为 model:// URL（协议处理器在主进程按此 URL 读取文件） */
export function toModelUrl(absPath: string): string {
  return 'model://local/' + encodeURIComponent(absPath)
}

/** 目录 URL（末尾保留分隔符，便于 three 拼接相对路径） */
function toDirUrl(dir: string): string {
  const d = dir.replace(/[\\/]+$/, '') + '\\'
  return 'model://local/' + encodeURIComponent(d)
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
  if (ext === 'blend') return 'm'
  if (ext === 'ma' || ext === 'mb' || ext === 'c4d') return 'cm'
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
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 })
}

function applyWhiteMaterial(object: THREE.Object3D): void {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      if (mesh.name === 'C4DPreviewBoard') return
      mesh.material = makeMaterial()
      if (!mesh.geometry.getAttribute('normal')) {
        mesh.geometry.computeVertexNormals()
      }
    }
  })
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
      break
    }
    case 'fbx': {
      const loader = new FBXLoader(manager)
      root = loader.parse(buffer, dir)
      animations = root.animations
      break
    }
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(manager)
      loader.setDRACOLoader(dracoLoader)
      loader.setMeshoptDecoder(MeshoptDecoder)
      loader.register((parser) => ({
        name: 'VIEWER_geometry_only',
        beforeRoot: () => {
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
      const loader = new MMDLoader(manager)
      // MMDLoader 0.171 无公开 parse，必须走 URL 加载；model:// 协议在渲染进程可 fetch。
      // 相对纹理路径由 resourcePath（模型目录 URL）拼接。
      loader.setResourcePath(toDirUrl(dir))
      const mesh = await new Promise<THREE.SkinnedMesh>((resolve, reject) => {
        const url = toModelUrl(filePath)
        loader.load(url, (m) => resolve(m), undefined, (err) => reject(err))
      })
      root = mesh
      break
    }
    case 'blend': {
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
      applyWhiteMaterial(root)
      unit = 'cm'
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
    default:
      throw new Error(`不支持的格式: .${ext}`)
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
  }
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
    const m = mesh.matrixWorld.clone()
    // 世界变换烘焙进几何，导出时 newMesh 位于世界原点，避免坐标错位
    geo.applyMatrix4(m)
    const orig = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const newMesh = new THREE.Mesh(geo, orig ?? makeMaterial())
    work.add(newMesh)
  })

  if (!work.children.length) throw new Error('当前文件只有点或线，无法导出为三角网格。')

  let data: Uint8Array
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
    default:
      throw new Error(`不支持的导出格式: ${format}`)
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
