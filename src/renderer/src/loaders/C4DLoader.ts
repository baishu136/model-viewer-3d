import * as THREE from 'three'

/**
 * 纯 TypeScript 实现的 Cinema 4D (.c4d) 场景解析器。
 *
 * C4D 文件由文件头 "QC4DC4D6" + 一段 HyperFile 二进制流组成。该二进制流是自描述的
 * 标记流（token stream）：
 *   0x01 + uint32 块ID + uint32 层级  = 开始一个块
 *   0x02                              = 结束当前块
 *   其余标记为带类型的值（int32 / float64 / 向量 / 字符串 / 内存块 ...）
 * 块可以任意嵌套，形成对象树。多边形对象（Opolygon，ID 5100）内包含：
 *   Tpoint   (5600) 顶点坐标，3 个内存块或 1 个交错内存块
 *   Tpolygon (5604) 四边形索引，4 个内存块或 1 个交错内存块
 *   Tuvw     (5671) 每个多边形 4 角的 UV 坐标
 * 对象变换位于 0x1ade4 块中，依次为位置、缩放、HPB 欧拉角（弧度）。
 *
 * 本解析器直接读取这些真实几何数据，不依赖任何 C4D SDK，也不生成占位几何。
 */
export class C4DLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(buffer: ArrayBuffer): THREE.Group {
    const bytes = new Uint8Array(buffer)
    if (bytes.length < 32) {
      throw new Error('无效的 Cinema 4D 文件: 文件过小')
    }
    if (this.readAscii(bytes, 0, 8) !== 'QC4DC4D6') {
      throw new Error('无效的 Cinema 4D 文件: 缺少 QC4DC4D6 文件头')
    }

    const root = new THREE.Group()
    root.name = 'C4DRoot'

    // 文件头固定 13 字节：8 字节标识 + 4 字节版本 + 1 字节保留
    const streamStart = 13
    const document = this.parseHyperFile(bytes, streamStart)

    if (document) {
      const objects = this.collectObjects(document)
      let meshCount = 0

      for (const object of objects) {
        if (object.type !== 5100) continue // Opolygon
        const mesh = this.buildPolygonObject(bytes, object)
        if (!mesh) continue

        if (object.worldMatrix) {
          // 直接烘焙进几何，导出 OBJ/GLB 等格式时坐标才正确
          mesh.geometry.applyMatrix4(object.worldMatrix)
          mesh.geometry.computeVertexNormals()
          mesh.geometry.computeBoundingBox()
        }
        root.add(mesh)
        meshCount++
      }

      // 对象本身没有烘焙多边形（例如未塌陷的程序化基本体），明确报错而不是伪造几何
      if (meshCount === 0) {
        throw new Error(
          '该 Cinema 4D 文件未包含可读取的多边形网格。请在 C4D 中把程序化对象“转为可编辑对象”(C) 后保存，或导出为 FBX/OBJ/glTF。'
        )
      }
    } else {
      throw new Error('该 Cinema 4D 文件结构无法识别（HyperFile 解析失败）')
    }

    return root
  }

  // ---------------------------------------------------------------
  // HyperFile 标记流解析
  // ---------------------------------------------------------------

  private parseHyperFile(bytes: Uint8Array, start: number): HyperChunk | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const root: HyperChunk = {
      id: -1,
      level: 0,
      start,
      end: bytes.length,
      parent: null,
      children: [],
      ints: [],
      floats: [],
      vecs: [],
      strings: [],
      blobs: []
    }

    let current = root
    let pos = start
    let guard = 0
    const guardLimit = bytes.length * 4

    while (pos < bytes.length) {
      if (++guard > guardLimit) break

      const tag = bytes[pos++]

      try {
        if (tag === 0x01) {
          if (pos + 8 > bytes.length) break
          const id = view.getUint32(pos, false)
          const level = view.getUint32(pos + 4, false)
          pos += 8
          const chunk: HyperChunk = {
            id,
            level,
            start: pos - 9,
            end: bytes.length,
            parent: current,
            children: [],
            ints: [],
            floats: [],
            vecs: [],
            strings: [],
            blobs: []
          }
          current.children.push(chunk)
          current = chunk
        } else if (tag === 0x02) {
          if (current === root) break
          current.end = pos
          current = current.parent || root
        } else if (tag === 0x0c || tag === 0x15) {
          current.ints.push(bytes[pos])
          pos += 1
        } else if (tag === 0x0d || tag === 0x0e) {
          current.ints.push(view.getUint16(pos, false))
          pos += 2
        } else if (tag === 0x0f || tag === 0x10) {
          current.ints.push(view.getInt32(pos, false))
          pos += 4
        } else if (tag === 0x11 || tag === 0x12) {
          pos += 8
        } else if (tag === 0x13) {
          current.floats.push(view.getFloat64(pos, false))
          pos += 8
        } else if (tag === 0x14) {
          current.floats.push(view.getFloat32(pos, false))
          pos += 4
        } else if (tag === 0x16) {
          pos += 16
        } else if (tag === 0x17) {
          current.vecs.push([view.getFloat64(pos, false), view.getFloat64(pos + 8, false), view.getFloat64(pos + 16, false)])
          pos += 24
        } else if (tag === 0x18) {
          current.vecs.push([view.getFloat32(pos, false), view.getFloat32(pos + 4, false), view.getFloat32(pos + 8, false)])
          pos += 12
        } else if (tag === 0x19) {
          pos += 96
        } else if (tag === 0x1a) {
          pos += 48
        } else if ((tag & 0x80) !== 0) {
          // 0x80..0xff 均为 uint32(BE) 长度前缀 + 负载
          const length = view.getUint32(pos, false)
          pos += 4
          if (length < 0 || pos + length > bytes.length) break

          if (tag === 0x82 || tag === 0x83) {
            // UTF-16BE 字符串
            current.strings.push(this.readUtf16BE(view, pos, length))
          } else {
            current.blobs.push({ tag, offset: pos, length })
          }
          pos += length
        } else {
          // 未知标记，流已经不同步，保留已解析结果
          break
        }
      } catch {
        break
      }
    }

    return current === root && root.children.length === 0 ? null : root
  }

  // ---------------------------------------------------------------
  // 对象树
  // ---------------------------------------------------------------

  private collectObjects(root: HyperChunk): C4DObject[] {
    const objects: C4DObject[] = []

    const walk = (chunk: HyperChunk, parentObject: C4DObject | null): void => {
      let current = parentObject

      const header = chunk.children.find((c) => c.id === 0x1adf0)
      if (header && header.ints.length > 0) {
        const object: C4DObject = {
          type: header.ints[0],
          name: header.strings[0] || '',
          chunk,
          transform: this.readTransform(chunk),
          parent: parentObject,
          worldMatrix: null
        }
        objects.push(object)
        current = object
      }

      for (const child of chunk.children) {
        walk(child, current)
      }
    }

    walk(root, null)

    // 计算世界矩阵
    const resolve = (object: C4DObject, stack: Set<C4DObject>): THREE.Matrix4 => {
      if (object.worldMatrix) return object.worldMatrix
      if (stack.has(object)) {
        return new THREE.Matrix4()
      }
      stack.add(object)
      const local = this.toMatrix4(object.transform)
      const world = object.parent ? resolve(object.parent, stack).clone().multiply(local) : local
      stack.delete(object)
      object.worldMatrix = world
      return world
    }

    for (const object of objects) resolve(object, new Set())

    return objects
  }

  private readTransform(chunk: HyperChunk): C4DTransform {
    const transformChunk = chunk.children.find((c) => c.id === 0x1ade4)
    const identity: C4DTransform = {
      position: new THREE.Vector3(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
      rotation: new THREE.Vector3(0, 0, 0) // H, P, B（弧度）
    }
    if (!transformChunk || transformChunk.vecs.length < 3) return identity

    const [pos, scale, rot] = transformChunk.vecs
    return {
      position: new THREE.Vector3(pos[0], pos[1], pos[2]),
      scale: new THREE.Vector3(
        scale[0] === 0 ? 1 : scale[0],
        scale[1] === 0 ? 1 : scale[1],
        scale[2] === 0 ? 1 : scale[2]
      ),
      rotation: new THREE.Vector3(rot[0], rot[1], rot[2])
    }
  }

  /**
   * C4D 为左手坐标系，Three.js 为右手坐标系。设 C = diag(1, 1, -1) 为坐标轴翻转，
   * 则 world_rh = C · T · Ry(H) · Rx(P) · Rz(B) · S · p_lh 可化为
   *   M = Translate(C·T) · Rz(-B) · Rx(P) · Ry(H) · Scale · C
   * 该式已用真实文件（多边形对象 Pitch = -π/2）验证。
   */
  private toMatrix4(transform: C4DTransform): THREE.Matrix4 {
    const { position, scale, rotation } = transform
    const flip = new THREE.Matrix4().makeScale(1, 1, -1)

    const translation = new THREE.Matrix4().makeTranslation(position.x, position.y, -position.z)
    const rotH = new THREE.Matrix4().makeRotationY(rotation.x)
    const rotP = new THREE.Matrix4().makeRotationX(rotation.y)
    const rotB = new THREE.Matrix4().makeRotationZ(-rotation.z)
    const scaling = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z)

    const matrix = new THREE.Matrix4()
    matrix.multiplyMatrices(translation, rotB)
    matrix.multiply(rotP)
    matrix.multiply(rotH)
    matrix.multiply(scaling)
    matrix.multiply(flip)
    return matrix
  }

  // ---------------------------------------------------------------
  // 多边形对象
  // ---------------------------------------------------------------

  private buildPolygonObject(bytes: Uint8Array, object: C4DObject): THREE.Mesh | null {
    const pointChunk = this.findTensor(object.chunk, 0x15e0) // Tpoint
    const polygonChunk = this.findTensor(object.chunk, 0x15e4) // Tpolygon
    if (!pointChunk || !polygonChunk) return null

    const pointCount = pointChunk.ints[0] || 0
    const polygonCount = polygonChunk.ints[0] || 0
    if (pointCount < 3 || polygonCount < 1) return null

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const points = this.readPoints(view, pointChunk, pointCount)
    if (!points) return null

    const polygons = this.readPolygons(view, polygonChunk, polygonCount, pointCount)
    if (!polygons) return null

    const uvwChunk = this.findTensor(object.chunk, 0x1627) // Tuvw
    const uvs = uvwChunk && uvwChunk.blobs.length > 0 ? this.readUvws(view, uvwChunk, polygonCount) : null

    // (顶点索引, uv) 去重，保证同一顶点共享法线、UV 接缝处正确断开
    const positions: number[] = []
    const normalsUv: number[] = []
    const indices: number[] = []
    const lookup = new Map<string, number>()

    const pushVertex = (index: number, uvIndex: number): number => {
      const uv = uvs && uvs[uvIndex] ? uvs[uvIndex] : null
      const key = uv ? `${index}|${uv[0].toFixed(5)}|${uv[1].toFixed(5)}` : `${index}|-`
      const cached = lookup.get(key)
      if (cached !== undefined) return cached

      const next = positions.length / 3
      positions.push(points[index * 3], points[index * 3 + 1], points[index * 3 + 2])
      if (uv) normalsUv.push(uv[0], uv[1])
      lookup.set(key, next)
      return next
    }

    for (let i = 0; i < polygonCount; i++) {
      const base = i * 4
      const a = polygons[base]
      const b = polygons[base + 1]
      const c = polygons[base + 2]
      const d = polygons[base + 3]
      if (a >= pointCount || b >= pointCount || c >= pointCount || d >= pointCount) continue

      // C4D 左手坐标系经翻转变换后，三角形顺序 (a, b, c) 会反向，需交换得到外向法线
      const va = pushVertex(a, base)
      const vb = pushVertex(b, base + 1)
      const vc = pushVertex(c, base + 2)
      indices.push(va, vc, vb)

      if (d !== c) {
        const vd = pushVertex(d, base + 3)
        indices.push(va, vd, vc)
      }
    }

    if (indices.length < 3) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(normalsUv, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const mesh = new THREE.Mesh(geometry)
    mesh.name = object.name || `C4DPolygon_${object.chunk.start}`
    return mesh
  }

  /** 找到带数据负载的张量块（Tpoint / Tpolygon / Tuvw 都包在同名外层块中） */
  private findTensor(chunk: HyperChunk, id: number): HyperChunk | null {
    if (chunk.id === id && chunk.blobs.length > 0 && chunk.ints.length > 0) return chunk
    for (const child of chunk.children) {
      const found = this.findTensor(child, id)
      if (found) return found
    }
    return null
  }

  private readPoints(view: DataView, chunk: HyperChunk, count: number): Float64Array | null {
    const out = new Float64Array(count * 3)

    if (chunk.blobs.length >= 3) {
      // 分离式数组：X、Y、Z 三个内存块
      const axis = [] as Float64Array[]
      for (let i = 0; i < 3; i++) {
        const values = this.readFloatBlock(view, chunk.blobs[i], count)
        if (!values) return null
        axis.push(values)
      }
      for (let i = 0; i < count; i++) {
        out[i * 3] = axis[0][i]
        out[i * 3 + 1] = axis[1][i]
        out[i * 3 + 2] = axis[2][i]
      }
      return out
    }

    // 交错式数组：单个内存块，每点 12/24 字节
    const blob = chunk.blobs[0]
    const stride = (blob.length - 1) / count
    if (stride !== 12 && stride !== 24) return null

    for (let i = 0; i < count; i++) {
      const off = blob.offset + 1 + i * stride
      if (off + stride > blob.offset + blob.length) return null
      if (stride === 12) {
        out[i * 3] = view.getFloat32(off, false)
        out[i * 3 + 1] = view.getFloat32(off + 4, false)
        out[i * 3 + 2] = view.getFloat32(off + 8, false)
      } else {
        out[i * 3] = view.getFloat64(off, false)
        out[i * 3 + 1] = view.getFloat64(off + 8, false)
        out[i * 3 + 2] = view.getFloat64(off + 16, false)
      }
    }
    return out
  }

  private readPolygons(
    view: DataView,
    chunk: HyperChunk,
    count: number,
    pointCount: number
  ): Uint32Array | null {
    const out = new Uint32Array(count * 4)

    if (chunk.blobs.length >= 4) {
      const column = [] as Uint32Array[]
      for (let i = 0; i < 4; i++) {
        const values = this.readUintBlock(view, chunk.blobs[i], count)
        if (!values) return null
        column.push(values)
      }
      for (let i = 0; i < count; i++) {
        out[i * 4] = column[0][i]
        out[i * 4 + 1] = column[1][i]
        out[i * 4 + 2] = column[2][i]
        out[i * 4 + 3] = column[3][i]
      }
      return out
    }

    const blob = chunk.blobs[0]
    const stride = (blob.length - 1) / count
    if (stride !== 4 && stride !== 8 && stride !== 16) return null

    const perIndex = stride / 4
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        const off = blob.offset + 1 + i * stride + k * perIndex
        let value = 0
        if (perIndex === 1) value = view.getUint8(off)
        else if (perIndex === 2) value = view.getUint16(off, false)
        else value = view.getUint32(off, false)
        out[i * 4 + k] = value >= pointCount ? 0 : value
      }
    }
    return out
  }

  private readUvws(view: DataView, chunk: HyperChunk, count: number): Array<[number, number]> | null {
    const blob = chunk.blobs[0]
    const perPolygon = (blob.length - 1) / count
    if (perPolygon <= 0 || perPolygon % 4 !== 0) return null

    const perCorner = perPolygon / 4
    if (perCorner !== 8 && perCorner !== 12 && perCorner !== 16) return null

    const out: Array<[number, number]> = new Array(count * 4)
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        const off = blob.offset + 1 + i * perPolygon + k * perCorner
        if (off + perCorner > blob.offset + blob.length) return null
        const u = perCorner === 16 ? view.getFloat64(off, false) : view.getFloat32(off, false)
        const v = perCorner === 16 ? view.getFloat64(off + 8, false) : view.getFloat32(off + 4, false)
        out[i * 4 + k] = [u, v]
      }
    }
    return out
  }

  private readFloatBlock(view: DataView, blob: HyperBlob, count: number): Float64Array | null {
    if (count <= 0) return null
    const stride = (blob.length - 1) / count
    if (stride !== 4 && stride !== 8) return null
    if (blob.offset + blob.length > view.byteLength) return null

    const out = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      const off = blob.offset + 1 + i * stride
      out[i] = stride === 8 ? view.getFloat64(off, false) : view.getFloat32(off, false)
    }
    return out
  }

  private readUintBlock(view: DataView, blob: HyperBlob, count: number): Uint32Array | null {
    if (count <= 0) return null
    const stride = (blob.length - 1) / count
    if (stride !== 1 && stride !== 2 && stride !== 4) return null
    if (blob.offset + blob.length > view.byteLength) return null

    const out = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      const off = blob.offset + 1 + i * stride
      out[i] = stride === 4 ? view.getUint32(off, false) : stride === 2 ? view.getUint16(off, false) : view.getUint8(off)
    }
    return out
  }

  private readAscii(bytes: Uint8Array, start: number, length: number): string {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[start + i])
    return text
  }

  private readUtf16BE(view: DataView, start: number, length: number): string {
    let text = ''
    for (let i = 0; i + 1 < length; i += 2) {
      const code = view.getUint16(start + i, false)
      if (code === 0) break
      text += String.fromCharCode(code)
    }
    return text
  }
}

// ---------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------

interface HyperBlob {
  tag: number
  offset: number
  length: number
}

interface HyperChunk {
  id: number
  level: number
  start: number
  end: number
  parent: HyperChunk | null
  children: HyperChunk[]
  ints: number[]
  floats: number[]
  vecs: number[][]
  strings: string[]
  blobs: HyperBlob[]
}

interface C4DTransform {
  position: THREE.Vector3
  scale: THREE.Vector3
  /** H(偏航)、P(俯仰)、B(翻滚)，弧度 */
  rotation: THREE.Vector3
}

interface C4DObject {
  type: number
  name: string
  chunk: HyperChunk
  transform: C4DTransform
  parent: C4DObject | null
  worldMatrix: THREE.Matrix4 | null
}
