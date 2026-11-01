import * as THREE from 'three'
import { unzlibSync } from 'three/examples/jsm/libs/fflate.module.js'
import { triangulatePolygon } from './utils/triangulation'

/**
 * 纯 TypeScript 实现的旧版 FBX（二进制 6.x，FileVersion < 7000）网格解析器。
 *
 * three.js 自带的 FBXLoader 只接受 FileVersion >= 6400 且要求顶点/面以“数组属性”保存，
 * 而 3ds Max / Maya 早期导出的 6.x 文件里每个分量都是一个独立属性（'D' 双精度、'I' 整数），
 * 因此这里单独实现：读取节点树、取出 Model 的顶点与多边形、按连接关系还原层级与变换。
 *
 * 支持内容：
 * - Objects > Model（Mesh 类型）中的 Vertices / PolygonVertexIndex / LayerElementUV
 * - Properties60 中的 Lcl Translation / Lcl Rotation / Lcl Scaling
 * - 顶层 Connect 节点的 "OO" 父子关系
 * 不支持：材质贴图、骨骼蒙皮与动画（这些格式仅用于查看几何）。
 */
export class Fbx6Loader {
  private bytes!: Uint8Array
  private view!: DataView

  parse(buffer: ArrayBuffer): THREE.Group {
    this.bytes = new Uint8Array(buffer)
    this.view = new DataView(buffer)

    const root = new THREE.Group()
    root.name = 'Fbx6Root'

    if (this.bytes.length < 32) {
      throw new Error('无效的 FBX 文件: 文件过小')
    }

    const header = this.readAscii(0, 20)
    if (header !== 'Kaydara FBX Binary  ') {
      throw new Error('无效的 FBX 6.x 文件: 缺少 Kaydara 文件头')
    }

    const nodes = this.readRootNodes()

    const models: Fbx6Model[] = []
    const parents = new Map<string, string>()

    for (const node of nodes) {
      if (node.name === 'Objects') {
        for (const child of node.children) {
          if (child.name === 'Model') {
            const model = this.readModel(child)
            if (model) models.push(model)
          }
        }
      } else if (node.name === 'Connect' || node.name === 'Connections') {
        this.readConnections(node, parents)
      }
    }

    // 坐标系：FBX 6.x 由 3ds Max 导出时常见 UpAxis=Y 但几何仍是 Z 轴向上，
    // 以 OriginalUpAxis 为准（2 = Z 轴向上），需要转成 three.js 的 Y 轴向上。
    const axisMatrix = this.readAxisMatrix(nodes)

    const byKey = new Map<string, Fbx6Model>()
    for (const model of models) byKey.set(model.key, model)

    const worldMatrices = new Map<string, THREE.Matrix4>()
    const resolveWorld = (model: Fbx6Model, stack: Set<string>): THREE.Matrix4 => {
      const cached = worldMatrices.get(model.key)
      if (cached) return cached
      if (stack.has(model.key)) return new THREE.Matrix4()
      stack.add(model.key)

      const parentKey = parents.get(model.key)
      const parent = parentKey ? byKey.get(parentKey) : undefined
      const parentMatrix = parent ? resolveWorld(parent, stack) : new THREE.Matrix4()
      stack.delete(model.key)

      const world = parentMatrix.clone().multiply(model.localMatrix)
      worldMatrices.set(model.key, world)
      return world
    }

    let meshCount = 0
    for (const model of models) {
      if (!model.vertices || !model.polygons) continue
      const mesh = this.buildMesh(model)
      if (!mesh) continue

      const world = axisMatrix.clone().multiply(resolveWorld(model, new Set()))
      // 直接烘焙进几何，导出 OBJ/GLB 时坐标才正确（Object3D.applyMatrix4 只改节点矩阵）
      mesh.geometry.applyMatrix4(world)
      mesh.geometry.computeVertexNormals()
      mesh.geometry.computeBoundingBox()
      root.add(mesh)
      meshCount++
    }

    if (meshCount === 0) {
      throw new Error('该 FBX 文件未包含可读取的网格数据')
    }

    return root
  }

  /** 读取全局坐标系设置：Z 轴向上的文件转换为 three.js 的 Y 轴向上 */
  private readAxisMatrix(nodes: Fbx6Node[]): THREE.Matrix4 {
    const identity = new THREE.Matrix4()
    const settings = this.findNode(nodes, 'GlobalSettings')
    if (!settings) return identity

    let upAxis = 1
    let originalUpAxis = 1

    for (const child of settings.children) {
      if (child.name !== 'Properties60') continue
      for (const propertyNode of child.children) {
        if (propertyNode.name !== 'Property') continue
        const values = this.readProperties(propertyNode)
        const name = typeof values[0] === 'string' ? (values[0] as string) : ''
        const value = values[3]
        if (typeof value !== 'number') continue
        if (name === 'UpAxis') upAxis = value
        else if (name === 'OriginalUpAxis') originalUpAxis = value
      }
    }

    // 2 = Z 轴向上。原始轴信息优先（记录导出前 DCC 的真实朝向）
    const isZUp = originalUpAxis === 2 || (originalUpAxis === 1 && upAxis === 2)
    if (!isZUp) return identity

    return new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)
  }

  private findNode(nodes: Fbx6Node[], name: string): Fbx6Node | null {
    for (const node of nodes) {
      if (node.name === name) return node
      const found = this.findNode(node.children, name)
      if (found) return found
    }
    return null
  }

  // ---------------------------------------------------------------
  // 节点树
  // ---------------------------------------------------------------

  private readRootNodes(): Fbx6Node[] {
    const nodes: Fbx6Node[] = []
    let offset = 27

    while (offset + 13 <= this.bytes.length) {
      const node = this.readNode(offset, this.bytes.length)
      if (!node) break
      nodes.push(node)
      offset = node.end
    }
    return nodes
  }

  private readNode(start: number, limit: number): Fbx6Node | null {
    if (start + 13 > limit) return null

    const end = this.view.getUint32(start, true)
    const numProps = this.view.getUint32(start + 4, true)
    const propLength = this.view.getUint32(start + 8, true)
    const nameLength = this.view.getUint8(start + 12)

    if (end === 0 && nameLength === 0) return null
    if (end <= start || end > limit) return null

    const nameStart = start + 13
    const name = this.readAscii(nameStart, nameLength)
    const propStart = nameStart + nameLength
    const propEnd = propStart + propLength
    if (propEnd > end) return null

    const node: Fbx6Node = { name, start, propStart, numProps, propEnd, end, children: [] }

    let cursor = propEnd
    while (cursor + 13 <= end) {
      const child = this.readNode(cursor, end)
      if (!child) break
      node.children.push(child)
      cursor = child.end
    }

    return node
  }

  // ---------------------------------------------------------------
  // 属性
  // ---------------------------------------------------------------

  private readProperties(node: Fbx6Node): unknown[] {
    const values: unknown[] = []
    let offset = node.propStart

    for (let i = 0; i < node.numProps; i++) {
      if (offset >= node.propEnd) break
      const result = this.readProperty(offset)
      if (!result) break
      values.push(result.value)
      offset = result.next
    }
    return values
  }

  private readProperty(offset: number): { value: unknown; next: number } | null {
    if (offset >= this.bytes.length) return null
    const type = String.fromCharCode(this.bytes[offset])
    let p = offset + 1

    switch (type) {
      case 'C':
        return { value: this.bytes[p] !== 0, next: p + 1 }
      case 'Y':
        return { value: this.view.getInt16(p, true), next: p + 2 }
      case 'I':
        return { value: this.view.getInt32(p, true), next: p + 4 }
      case 'F':
        return { value: this.view.getFloat32(p, true), next: p + 4 }
      case 'D':
        return { value: this.view.getFloat64(p, true), next: p + 8 }
      case 'L':
        return { value: Number(this.view.getBigInt64(p, true)), next: p + 8 }
      case 'S':
      case 'R': {
        const length = this.view.getUint32(p, true)
        p += 4
        const value = type === 'S' ? this.readAscii(p, length) : new Uint8Array(this.bytes.subarray(p, p + length))
        return { value, next: p + length }
      }
      default: {
        // 数组属性：长度、编码方式、压缩后长度
        const count = this.view.getUint32(p, true)
        const encoding = this.view.getUint32(p + 4, true)
        const compressedLength = this.view.getUint32(p + 8, true)
        const itemSize = type === 'b' || type === 'c' ? 1 : type === 'y' ? 2 : type === 'i' || type === 'f' ? 4 : 8
        p += 12
        const dataLength = encoding === 1 ? compressedLength : count * itemSize
        return { value: { type, count, offset: p, length: dataLength, encoding }, next: p + dataLength }
      }
    }
  }

  /** 把数组属性（或 6.x 的逐分量属性）读成 Float32Array / Int32Array */
  private readNumericArray(node: Fbx6Node, kind: 'float'): Float32Array | null
  private readNumericArray(node: Fbx6Node, kind: 'int'): Int32Array | null
  private readNumericArray(node: Fbx6Node, kind: 'float' | 'int'): Float32Array | Int32Array | null {
    const values: number[] = []
    let offset = node.propStart

    for (let i = 0; i < node.numProps; i++) {
      if (offset >= node.propEnd) break
      const result = this.readProperty(offset)
      if (!result) break
      offset = result.next

      if (typeof result.value === 'number') {
        values.push(result.value)
      } else if (result.value && typeof result.value === 'object' && 'type' in (result.value as object)) {
        const array = this.decodeArray(result.value as Fbx6Array)
        for (let k = 0; k < array.length; k++) values.push(array[k])
      }
    }

    if (values.length === 0) return null
    return kind === 'float' ? Float32Array.from(values) : Int32Array.from(values)
  }

  private decodeArray(array: Fbx6Array): number[] {
    const raw = this.bytes.subarray(array.offset, array.offset + array.length)
    let data = raw
    if (array.encoding === 1) {
      try {
        data = unzlibSync(raw)
      } catch {
        return []
      }
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const out: number[] = new Array(array.count)
    for (let i = 0; i < array.count; i++) {
      switch (array.type) {
        case 'b':
        case 'c':
          out[i] = view.getUint8(i)
          break
        case 'y':
          out[i] = view.getInt16(i * 2, true)
          break
        case 'i':
          out[i] = view.getInt32(i * 4, true)
          break
        case 'f':
          out[i] = view.getFloat32(i * 4, true)
          break
        default:
          out[i] = view.getFloat64(i * 8, true)
      }
    }
    return out
  }

  // ---------------------------------------------------------------
  // 模型与连接
  // ---------------------------------------------------------------

  private readModel(node: Fbx6Node): Fbx6Model | null {
    const props = this.readProperties(node)
    const first = typeof props[0] === 'string' ? (props[0] as string) : ''
    const second = typeof props[1] === 'string' ? (props[1] as string) : ''

    const key = first
    const name = first.split('\u0000')[0] || 'Model'
    const type = second || first.split('\u0000')[1] || ''

    let vertices: Float32Array | null = null
    let polygons: Int32Array | null = null
    let uvs: Float32Array | null = null
    let uvIndices: Int32Array | null = null
    let translation: THREE.Vector3 | null = null
    let rotation: THREE.Vector3 | null = null
    let scaling: THREE.Vector3 | null = null

    const visit = (child: Fbx6Node): void => {
      switch (child.name) {
        case 'Vertices':
          vertices = this.readNumericArray(child, 'float')
          return
        case 'PolygonVertexIndex':
          polygons = this.readNumericArray(child, 'int')
          return
        case 'UV':
          uvs = this.readNumericArray(child, 'float')
          return
        case 'UVIndex':
          uvIndices = this.readNumericArray(child, 'int')
          return
        case 'Properties60':
          for (const propertyNode of child.children) {
            if (propertyNode.name !== 'Property') continue
            const values = this.readProperties(propertyNode)
            const propertyName = typeof values[0] === 'string' ? (values[0] as string) : ''
            const numbers = values.slice(2).filter((value): value is number => typeof value === 'number')
            if (numbers.length < 3) continue
            const vector = new THREE.Vector3(numbers[0], numbers[1], numbers[2])
            if (propertyName === 'Lcl Translation') translation = vector
            else if (propertyName === 'Lcl Rotation') rotation = vector
            else if (propertyName === 'Lcl Scaling') scaling = vector
          }
          return
        default:
          return
      }
    }

    for (const child of node.children) visit(child)
    // 6.x 中 UV 也可能包在 LayerElementUV 里
    for (const child of node.children) {
      if (child.name !== 'LayerElementUV') continue
      for (const uvChild of child.children) visit(uvChild)
    }

    const localMatrix = new THREE.Matrix4()
    if (translation || rotation || scaling) {
      const t = translation ?? new THREE.Vector3()
      const r = rotation ?? new THREE.Vector3()
      const s = scaling ?? new THREE.Vector3(1, 1, 1)
      const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(r.x),
        THREE.MathUtils.degToRad(r.y),
        THREE.MathUtils.degToRad(r.z),
        'XYZ'
      )
      localMatrix.compose(t, new THREE.Quaternion().setFromEuler(euler), s)
    }

    return {
      key,
      name,
      type,
      vertices,
      polygons,
      uvs,
      uvIndices,
      localMatrix
    }
  }

  private readConnections(node: Fbx6Node, parents: Map<string, string>): void {
    for (const child of node.children) {
      if (child.name === 'C' || child.name === 'Connect') {
        const values = this.readProperties(child)
        if (values[0] !== 'OO') continue
        const childKey = typeof values[1] === 'string' ? (values[1] as string) : ''
        const parentKey = typeof values[2] === 'string' ? (values[2] as string) : ''
        if (childKey && parentKey) parents.set(childKey, parentKey)
      }
    }
  }

  // ---------------------------------------------------------------
  // 网格构建
  // ---------------------------------------------------------------

  private buildMesh(model: Fbx6Model): THREE.Mesh | null {
    const vertices = model.vertices
    const polygons = model.polygons
    if (!vertices || !polygons) return null

    const vertexCount = Math.floor(vertices.length / 3)
    if (vertexCount < 3 || polygons.length < 3) return null

    // 3ds Max 导出的 FBX 为 Y 轴向上的右手坐标系，与 three.js 一致，无需换轴
    const positions = new Float32Array(vertexCount * 3)
    positions.set(vertices.subarray(0, vertexCount * 3))

    const indices: number[] = []
    const uvArray: number[] = []
    const useUv = model.uvs !== null && model.uvIndices !== null

    let polygon: number[] = []
    let polygonUv: number[] = []
    let uvCursor = 0

    const flushPolygon = (): void => {
      if (polygon.length < 3) {
        polygon = []
        polygonUv = []
        return
      }
      const triangles: number[] = []
      triangulatePolygon(polygon, positions, triangles)
      indices.push(...triangles)
      for (const index of triangles) {
        if (useUv) {
          const corner = polygon.indexOf(index)
          uvArray.push(polygonUv[corner * 2], polygonUv[corner * 2 + 1])
        }
      }
      polygon = []
      polygonUv = []
    }

    for (let i = 0; i < polygons.length; i++) {
      const raw = polygons[i]
      const isLast = raw < 0
      const index = isLast ? ~raw : raw
      if (index >= 0 && index < vertexCount) {
        polygon.push(index)
        if (useUv && model.uvIndices && uvCursor < model.uvIndices.length) {
          const uvIndex = model.uvIndices[uvCursor]
          const u = model.uvs![uvIndex * 2]
          const v = model.uvs![uvIndex * 2 + 1]
          polygonUv.push(Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0)
        }
      }
      uvCursor++
      if (isLast) flushPolygon()
    }
    flushPolygon()

    if (indices.length < 3) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    if (useUv && uvArray.length === indices.length * 2) {
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2))
    }
    geometry.setIndex(indices)

    const mesh = new THREE.Mesh(geometry)
    mesh.name = model.name || 'FbxMesh'
    return mesh
  }

  private readAscii(start: number, length: number): string {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(this.bytes[start + i])
    return text
  }
}

interface Fbx6Node {
  name: string
  start: number
  propStart: number
  numProps: number
  propEnd: number
  end: number
  children: Fbx6Node[]
}

interface Fbx6Array {
  type: string
  count: number
  offset: number
  length: number
  encoding: number
}

interface Fbx6Model {
  key: string
  name: string
  type: string
  vertices: Float32Array | null
  polygons: Int32Array | null
  uvs: Float32Array | null
  uvIndices: Int32Array | null
  localMatrix: THREE.Matrix4
}
