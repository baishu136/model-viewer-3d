import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'

export const SUPPORTED_EXTENSIONS = ['obj', 'fbx', 'stl', 'pmx', 'pmd']
export const EXPORT_FORMATS = ['obj', 'stl', 'fbx']

// ---------------------------------------------------------------
// model:// 本地文件协议桥接
// ---------------------------------------------------------------

/** 当前正在加载的模型所在目录（Windows 绝对路径），用于解析相对纹理/MTL 路径 */
let currentModelDir = ''

/** 将 Windows 绝对路径编码为 model:// URL（协议处理器在主进程按此 URL 读取文件） */
export function toModelUrl(absPath: string): string {
  return 'model:///' + encodeURIComponent(absPath)
}

/** 目录 URL（末尾保留分隔符，便于 three 拼接相对路径） */
function toDirUrl(dir: string): string {
  const d = dir.replace(/[\\/]+$/, '') + '\\'
  return 'model:///' + encodeURIComponent(d)
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
function resolveModelUrl(url: string): string {
  if (url.startsWith('model://') || url.startsWith('data:') || url.startsWith('blob:')) return url
  if (/^[A-Za-z]:[\\/]/.test(url)) return toModelUrl(url)
  if (currentModelDir) {
    const joined = joinWindows(currentModelDir, url)
    return toModelUrl(joined)
  }
  return url
}

// 用默认加载管理器，统一拦截所有纹理/MTL/FBX 附属资源的相对路径
const manager = THREE.DefaultLoadingManager
manager.setURLModifier(resolveModelUrl)

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
  const text = new TextDecoder('latin1').decode(buffer)
  const m = text.match(/UnitScaleFactor[^\d\-+.]*([\d.]+)/)
  if (!m) return null
  const factor = parseFloat(m[1])
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
  return 'mm'
}

// ---------------------------------------------------------------
// 加载
// ---------------------------------------------------------------

export interface LoadResult {
  root: THREE.Object3D
  unit: UnitKind
}

function makeMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 })
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
  const unit = await detectUnit(filePath, buffer)

  // 计算模型所在目录，供相对资源解析
  const norm = filePath.replace(/\\/g, '/')
  const dir = norm.includes('/') ? norm.substring(0, norm.lastIndexOf('/')) : ''
  currentModelDir = dir

  const ext = (filePath.toLowerCase().split('.').pop() || '').toLowerCase()
  let root: THREE.Object3D

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
      break
    }
    case 'stl': {
      const loader = new STLLoader(manager)
      const geo = loader.parse(buffer)
      root = new THREE.Mesh(geo, makeMaterial())
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
    default:
      throw new Error(`不支持的格式: .${ext}`)
  }

  return { root, unit }
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
  modelRoot.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const geo = (mesh.geometry as THREE.BufferGeometry).clone()
    const m = mesh.matrixWorld.clone()
    // 世界变换烘焙进几何，导出时 newMesh 位于世界原点，避免坐标错位
    geo.applyMatrix4(m)
    const orig = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const newMesh = new THREE.Mesh(geo, orig ?? makeMaterial())
    work.add(newMesh)
  })

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
      const bytes = exporter.parseSync(work)
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
