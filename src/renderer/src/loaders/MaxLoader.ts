import * as THREE from 'three'
import * as CFB from 'cfb'
import { CompoundFile } from './utils/compound-file'
import { gunzipSync, unzlibSync } from 'three/examples/jsm/libs/fflate.module.js'

/**
 * 纯 TypeScript 实现的 3ds Max (.max) 场景解析器。
 *
 * .max 是 OLE 复合文档（CFB），真实几何位于 "Scene" 流中：
 *   - 块头：uint16 块ID + uint32 长度（最高位表示容器）；长度为 0 时改用
 *     uint64 长度（偏移 +6，最高位表示容器），块头变为 14 字节。
 *   - 新版 Scene 流可能是 gzip / zlib 压缩的，需要先解压。
 *   - 三角网格（TriObject）：0x0914 顶点表 + 0x0912 面表。
 *   - 可编辑多边形（MNMesh）：0x0100 顶点表（含 MN_DEAD 标记）+ 0x011A 面表
 *     （可变元数，ioFlags 决定是否附带材质号、平滑组和三角化对角线）。
 *
 * 顶点数据由节点引用（INode 的 0x2035 槽位 1）指向，节点变换由
 * 0x2035 槽位 0 → PRS 控制器 → 0x2034 子引用 → 0x2501/0x2505 静态值解析。
 */
export class MaxLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(buffer: ArrayBuffer): THREE.Group {
    const root = new THREE.Group()
    root.name = 'MaxRoot'

    const raw = this.readSceneStream(new Uint8Array(buffer))
    if (!raw) {
      throw new Error('无效的 3ds Max 文件: 缺少 Scene 数据流')
    }

    const sceneBytes = this.decompress(raw)
    if (sceneBytes.length < 16) {
      throw new Error('无效的 3ds Max 文件: Scene 数据流过小')
    }

    const view = new DataView(sceneBytes.buffer, sceneBytes.byteOffset, sceneBytes.byteLength)
    const sceneRoot = this.readHeader(view, 0, sceneBytes.length)
    if (!sceneRoot || !sceneRoot.container) {
      throw new Error('无效的 3ds Max 文件: Scene 数据流结构无法识别')
    }

    const items = this.readChildren(view, sceneRoot)
    if (items.length === 0) {
      throw new Error('无效的 3ds Max 文件: Scene 数据流为空')
    }

    // 1. 收集所有网格块（0x08FE），并记录其所属的顶层条目
    const meshes: MaxMeshEntry[] = []
    for (let i = 0; i < items.length; i++) {
      this.collectMeshes(view, items[i], i, meshes)
    }

    if (meshes.length === 0) {
      throw new Error(
        '该 3ds Max 文件未包含可读取的网格数据（可能只有未塌陷的程序化对象或修改器堆栈）。请在 3ds Max 中“转换为可编辑网格/多边形”后保存，或导出为 FBX/OBJ/glTF。'
      )
    }

    // 2. 解析节点变换
    const nodeInfo = this.buildNodeMatrices(view, items, new Set(meshes.map((m) => m.ownerItem)))

    // 3. 组装场景
    const axisMatrix = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)

    const meshesByOwner = new Map<number, MaxMeshEntry[]>()
    for (const entry of meshes) {
      const entries = meshesByOwner.get(entry.ownerItem) || []
      entries.push(entry)
      meshesByOwner.set(entry.ownerItem, entries)
    }
    const addMesh = (entry: MaxMeshEntry, matrix: THREE.Matrix4, name: string): void => {
      const transform = axisMatrix.clone().multiply(matrix)
      const geometry = this.buildGeometry(entry.positions, entry.indices)
      geometry.applyMatrix4(transform)
      // 镜像节点烘焙到顶点后，需要同时翻转绕序，保留外向法线。
      if (transform.determinant() < 0) this.reverseWinding(geometry)
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
      const mesh = new THREE.Mesh(geometry)
      mesh.name = name
      root.add(mesh)
    }

    // 按节点实例化，而非按共享网格只摆放一次。ObjectTM = NodeWorldTM * ObjectOffsetTM；
    // 不再按网格中心的疏密猜测是否丢弃变换，轴心偏移也不会传给子节点。
    for (const node of nodeInfo.nodes) {
      const entries = [...node.targets].flatMap((target) => meshesByOwner.get(target) || [])
      for (const entry of entries) {
        addMesh(entry, node.matrix, node.name || `MaxMesh_${root.children.length}`)
      }
      if (entries.length > 0) continue

      // 未保存烘焙网格的闭合样条，仍可重建其轮廓面。
      const spline = this.buildSplineMesh(view, items, node.targets)
      if (!spline) continue
      const transform = axisMatrix.clone().multiply(node.matrix)
      spline.applyMatrix4(transform)
      if (transform.determinant() < 0) this.reverseWinding(spline)
      spline.computeVertexNormals()
      spline.computeBoundingBox()

      const mesh = new THREE.Mesh(spline)
      mesh.name = node.name || 'MaxSpline'
      root.add(mesh)
    }

    // 兼容只保存网格、没有 INode 的旧文件；有节点时不显示已脱离场景的缓存网格。
    if (nodeInfo.nodes.length === 0) {
      meshes.forEach((entry, i) => addMesh(entry, new THREE.Matrix4(), entry.name || `MaxMesh_${i}`))
    }

    return root
  }

  /**
   * 从修改器的样条数据（0x2900 数量 + 0x290a 控制点）重建填充面片。
   * 每个节点 52 字节：入切线 / 节点 / 出切线，各为 (x, y, 0)。
   */
  private buildSplineMesh(
    view: DataView,
    items: MaxChunkRef[],
    targets: Set<number>
  ): THREE.BufferGeometry | null {
    let knotChunk: MaxChunkRef | null = null
    let countChunk: MaxChunkRef | null = null

    for (const target of targets) {
      const item = items[target]
      if (!item || !item.container) continue
      const knots = this.findFirstChunk(view, item, 0x290a)
      const count = this.findFirstChunk(view, item, 0x2900)
      if (knots && count) {
        knotChunk = knots
        countChunk = count
        break
      }
    }
    if (!knotChunk || !countChunk) return null

    const count = view.getUint32(this.payloadStart(countChunk), true)
    if (count < 3 || count > 20000) return null

    const dataLength = this.payloadLength(knotChunk) / 4
    const stride = Math.round(dataLength / count)
    if (stride < 11 || stride > 16) return null

    const start = this.payloadStart(knotChunk)
    const knotAt = (index: number): { in: THREE.Vector2; point: THREE.Vector2; out: THREE.Vector2 } => {
      const base = start + index * stride * 4
      return {
        in: new THREE.Vector2(view.getFloat32(base + 12, true), view.getFloat32(base + 16, true)),
        point: new THREE.Vector2(view.getFloat32(base + 24, true), view.getFloat32(base + 28, true)),
        out: new THREE.Vector2(view.getFloat32(base + 36, true), view.getFloat32(base + 40, true))
      }
    }

    const knots = []
    for (let i = 0; i < count; i++) knots.push(knotAt(i))

    // 判断是否闭合：最后一段的出切线应与首段的入切线重合
    const closingGap = knots[count - 1].out.distanceTo(knots[0].in)
    const span = new THREE.Box2()
    for (const knot of knots) span.expandByPoint(knot.point)
    const diagonal = span.getSize(new THREE.Vector2()).length()
    if (diagonal <= 1e-6) return null
    const closed = closingGap < diagonal * 0.05
    if (!closed) return null

    // 直接用节点位置构成轮廓：Max 的样条节点在拐角处非常密集，
    // 用节点连线足以表达板件轮廓，且不会因采样自交导致三角化破洞。
    const outline: THREE.Vector2[] = []
    for (let i = 0; i < count; i++) {
      const point = knots[i].point
      const previous = outline[outline.length - 1]
      if (previous && previous.distanceTo(point) < diagonal * 1e-4) continue
      outline.push(point.clone())
    }
    while (outline.length > 1 && outline[0].distanceTo(outline[outline.length - 1]) < diagonal * 1e-4) {
      outline.pop()
    }

    if (outline.length < 3) return null

    let faces: number[][] | null = null
    try {
      faces = THREE.ShapeUtils.triangulateShape(outline, [])
    } catch {
      return null
    }
    if (!faces || faces.length === 0) return null

    const positions = new Float32Array(outline.length * 3)
    for (let i = 0; i < outline.length; i++) {
      positions[i * 3] = outline[i].x
      positions[i * 3 + 1] = outline[i].y
      positions[i * 3 + 2] = 0
    }
    const indices: number[] = []
    for (const face of faces) indices.push(face[0], face[1], face[2])

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    return geometry
  }

  // ---------------------------------------------------------------
  // 解压
  // ---------------------------------------------------------------
  /**
   * 读取复合文档中的 Scene 流。优先使用内置的快速读取器（直接拼接扇区），
   * 遇到无法解析的容器时回退到 cfb 库。
   */
  private readSceneStream(bytes: Uint8Array): Uint8Array | null {
    try {
      const stream = new CompoundFile(bytes).readStream('Scene')
      if (stream && stream.length > 0) return stream
    } catch {
      // 交给 cfb 回退
    }

    try {
      const cfb = CFB.read(bytes, { type: 'array' })
      const entry = cfb.FileIndex.find((f) => f.name === 'Scene')
      if (entry && entry.content) return new Uint8Array(entry.content)
    } catch {
      return null
    }
    return null
  }


  private decompress(bytes: Uint8Array): Uint8Array {
    try {
      if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return gunzipSync(bytes)
      }
      if (
        bytes.length > 2 &&
        bytes[0] === 0x78 &&
        (bytes[1] === 0x01 || bytes[1] === 0x5e || bytes[1] === 0x9c || bytes[1] === 0xda)
      ) {
        return unzlibSync(bytes)
      }
    } catch {
      // 解压失败时按未压缩处理
    }
    return bytes
  }

  // ---------------------------------------------------------------
  // 块结构
  // ---------------------------------------------------------------

  private readHeader(view: DataView, offset: number, limit: number): MaxChunkRef | null {
    if (offset + 6 > limit) return null

    const id = view.getUint16(offset, true)
    const raw32 = view.getUint32(offset + 2, true)

    if (raw32 !== 0) {
      const container = (raw32 & 0x80000000) !== 0
      const length = raw32 & 0x7fffffff
      if (length < 6 || offset + length > limit) return null
      return { id, start: offset, end: offset + length, headerSize: 6, container }
    }

    if (offset + 14 > limit) return null
    const low = view.getUint32(offset + 6, true)
    const high = view.getUint32(offset + 10, true)
    const container = (high & 0x80000000) !== 0
    const length = (high & 0x7fffffff) * 4294967296 + low
    if (length < 14 || offset + length > limit) return null
    return { id, start: offset, end: offset + length, headerSize: 14, container }
  }

  private readChildren(view: DataView, container: MaxChunkRef): MaxChunkRef[] {
    const out: MaxChunkRef[] = []
    let offset = container.start + container.headerSize
    while (offset < container.end) {
      const child = this.readHeader(view, offset, container.end)
      if (!child) break
      out.push(child)
      offset = child.end
    }
    return out
  }

  private payloadStart(ref: MaxChunkRef): number {
    return ref.start + ref.headerSize
  }

  private payloadLength(ref: MaxChunkRef): number {
    return ref.end - ref.start - ref.headerSize
  }

  // ---------------------------------------------------------------
  // 网格
  // ---------------------------------------------------------------

  private collectMeshes(
    view: DataView,
    ref: MaxChunkRef,
    ownerItem: number,
    out: MaxMeshEntry[]
  ): void {
    if (!ref.container) return

    if (ref.id === 0x08fe) {
      const entry = this.parseMesh(view, ref, ownerItem)
      if (entry) out.push(entry)
      return
    }

    for (const child of this.readChildren(view, ref)) {
      this.collectMeshes(view, child, ownerItem, out)
    }
  }

  private parseMesh(view: DataView, ref: MaxChunkRef, ownerItem: number): MaxMeshEntry | null {
    let mverts: MaxChunkRef | null = null
    let mfaces: MaxChunkRef | null = null
    let tverts: MaxChunkRef | null = null
    let tfaces: MaxChunkRef | null = null

    for (const child of this.readChildren(view, ref)) {
      if (child.container) continue
      if (child.id === 0x0100) mverts = child
      else if (child.id === 0x011a) mfaces = child
      else if (child.id === 0x0914) tverts = child
      else if (child.id === 0x0912) tfaces = child
    }

    if (mverts && mfaces) {
      return this.parseEditablePoly(view, mverts, mfaces, ownerItem)
    }
    if (tverts && tfaces) {
      return this.parseTriObject(view, tverts, tfaces, ownerItem)
    }
    return null
  }

  /** TriObject / Mesh：0x0914 顶点表 + 0x0912 面表 */
  private parseTriObject(
    view: DataView,
    verts: MaxChunkRef,
    faces: MaxChunkRef,
    ownerItem: number
  ): MaxMeshEntry | null {
    const vStart = this.payloadStart(verts)
    const fStart = this.payloadStart(faces)
    if (vStart + 4 > verts.end || fStart + 4 > faces.end) return null

    const vCount = view.getUint32(vStart, true)
    const fCount = view.getUint32(fStart, true)
    if (vCount < 3 || vCount > 4000000 || fCount < 1 || fCount > 8000000) return null

    const vBytes = verts.end - (vStart + 4)
    if (vBytes < vCount * 12) return null

    const fBytes = faces.end - (fStart + 4)
    const fStride = Math.round(fBytes / fCount)
    if (Math.abs(fStride * fCount - fBytes) > 3) return null
    if (fStride !== 12 && fStride !== 20) return null

    const positions = new Float32Array(vCount * 3)
    for (let i = 0; i < vCount; i++) {
      const off = vStart + 4 + i * 12
      positions[i * 3] = view.getFloat32(off, true)
      positions[i * 3 + 1] = view.getFloat32(off + 4, true)
      positions[i * 3 + 2] = view.getFloat32(off + 8, true)
    }

    const indices: number[] = []
    const wide = fStride === 20
    for (let i = 0; i < fCount; i++) {
      const off = fStart + 4 + i * fStride
      let a: number
      let b: number
      let c: number
      if (wide) {
        a = view.getUint32(off, true)
        b = view.getUint32(off + 4, true)
        c = view.getUint32(off + 8, true)
      } else {
        a = view.getUint16(off, true)
        b = view.getUint16(off + 2, true)
        c = view.getUint16(off + 4, true)
      }
      if (a < vCount && b < vCount && c < vCount && a !== b && b !== c && a !== c) {
        indices.push(a, b, c)
      }
    }

    if (indices.length < 3) return null
    return { positions, indices, ownerItem, name: '' }
  }

  /** Editable Poly / MNMesh：0x0100 顶点表（MNVert）+ 0x011A 面表（MNFace） */
  private parseEditablePoly(
    view: DataView,
    verts: MaxChunkRef,
    faces: MaxChunkRef,
    ownerItem: number
  ): MaxMeshEntry | null {
    const vStart = this.payloadStart(verts)
    const fStart = this.payloadStart(faces)
    if (vStart + 4 > verts.end || fStart + 4 > faces.end) return null

    const vCount = view.getUint32(vStart, true)
    const fCount = view.getUint32(fStart, true)
    if (vCount < 3 || vCount > 4000000 || fCount < 1 || fCount > 8000000) return null

    // MNVert：uint32 标记；未标记 MN_DEAD(0x2) 时跟随 3 个 float32 坐标
    const MN_DEAD = 0x2
    const positions = new Float32Array(vCount * 3)
    const deadVertices = new Set<number>()
    let cursor = vStart + 4
    for (let i = 0; i < vCount; i++) {
      if (cursor + 4 > verts.end) return null
      const flags = view.getUint32(cursor, true)
      cursor += 4
      if ((flags & MN_DEAD) !== 0) {
        deadVertices.add(i)
        continue
      }
      if (cursor + 12 > verts.end) return null
      positions[i * 3] = view.getFloat32(cursor, true)
      positions[i * 3 + 1] = view.getFloat32(cursor + 4, true)
      positions[i * 3 + 2] = view.getFloat32(cursor + 8, true)
      cursor += 12
    }

    // MNFace：int32 度数 + 度数个 uint32 顶点索引 + uint16 ioFlags + 可变字段
    const FACE_FLAGS = 0x0001
    const MAT_ID = 0x0008
    const SMOOTH_GROUP = 0x0010
    const DIAG = 0x0020

    const indices: number[] = []
    let faceCursor = fStart + 4

    for (let i = 0; i < fCount; i++) {
      if (faceCursor + 4 > faces.end) break
      const degree = view.getInt32(faceCursor, true)
      faceCursor += 4

      if (degree === 0) {
        // 已删除的面：仍带有 ioFlags 及其标识的附加字段
        if (faceCursor + 2 > faces.end) break
        const io = view.getUint16(faceCursor, true)
        faceCursor += 2
        if (io & FACE_FLAGS) faceCursor += 4
        if (io & MAT_ID) faceCursor += 2
        if (io & SMOOTH_GROUP) faceCursor += 4
        continue
      }

      if (degree < 3 || degree > 4096 || faceCursor + degree * 4 + 2 > faces.end) break

      const faceVertices: number[] = new Array(degree)
      for (let k = 0; k < degree; k++) {
        faceVertices[k] = view.getUint32(faceCursor + k * 4, true)
      }
      faceCursor += degree * 4

      const io = view.getUint16(faceCursor, true)
      faceCursor += 2

      let flags = 0
      if (io & FACE_FLAGS) {
        if (faceCursor + 4 > faces.end) break
        flags = view.getUint32(faceCursor, true)
        faceCursor += 4
      }
      if (io & MAT_ID) faceCursor += 2
      if (io & SMOOTH_GROUP) faceCursor += 4

      if (io & DIAG && degree > 3) {
        const count = (degree - 3) * 2
        if (faceCursor + count * 4 > faces.end) break
        faceCursor += count * 4
      }
      if (faceCursor > faces.end || (flags & MN_DEAD) !== 0) continue

      let valid = true
      for (let k = 0; k < degree; k++) {
        if (faceVertices[k] >= vCount || deadVertices.has(faceVertices[k]) ||
          !Number.isFinite(positions[faceVertices[k] * 3]) ||
          !Number.isFinite(positions[faceVertices[k] * 3 + 1]) ||
          !Number.isFinite(positions[faceVertices[k] * 3 + 2])) {
          valid = false
          break
        }
      }
      if (!valid) continue

      this.triangulatePolygon(positions, faceVertices, indices)
    }

    if (indices.length < 3) return null
    return { positions, indices, ownerItem, name: '' }
  }

  private buildGeometry(positions: Float32Array, indices: number[]): THREE.BufferGeometry {
    // 3ds Max 为右手 Z 轴向上，坐标轴转换 (x, z, -y) 是纯旋转（行列式 +1），
    // 因此面索引顺序保持不变即可得到外向法线（已用真实文件的有符号体积验证）。
    const geometry = new THREE.BufferGeometry()
    // 仅保留实际被面使用的顶点；MN_DEAD / 孤立顶点不能把包围盒拉到原点。
    // 每个实例独立复制，烘焙一个节点不会改变另一个实例的源数据。
    const remap = new Map<number, number>()
    const packed: number[] = []
    const packedIndices = indices.map((index) => {
      let mapped = remap.get(index)
      if (mapped === undefined) {
        mapped = remap.size
        remap.set(index, mapped)
        packed.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2])
      }
      return mapped
    })
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(packed, 3))
    geometry.setIndex(packedIndices)
    return geometry
  }

  private reverseWinding(geometry: THREE.BufferGeometry): void {
    const index = geometry.getIndex()!
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1)
      index.setX(i + 1, index.getX(i + 2))
      index.setX(i + 2, b)
    }
  }

  /** Newell 法线确定投影平面，再耳切三角化，避免凹面扇形拆分时跨越轮廓。 */
  private triangulatePolygon(positions: Float32Array, vertices: number[], indices: number[]): void {
    if (vertices.length === 3) {
      indices.push(...vertices)
      return
    }
    const points = vertices.map((v) => new THREE.Vector3().fromArray(positions, v * 3))
    const normal = new THREE.Vector3()
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length]
      normal.x += (a.y - b.y) * (a.z + b.z)
      normal.y += (a.z - b.z) * (a.x + b.x)
      normal.z += (a.x - b.x) * (a.y + b.y)
    }
    if (normal.lengthSq() === 0) return
    const axis = Math.abs(normal.x) > Math.abs(normal.y)
      ? (Math.abs(normal.x) > Math.abs(normal.z) ? 0 : 2)
      : (Math.abs(normal.y) > Math.abs(normal.z) ? 1 : 2)
    const outline = points.map((p) => axis === 0 ? new THREE.Vector2(p.y, p.z)
      : axis === 1 ? new THREE.Vector2(p.z, p.x) : new THREE.Vector2(p.x, p.y))
    const ab = new THREE.Vector3(), ac = new THREE.Vector3()
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outline, [])) {
      const direction = ab.subVectors(points[b], points[a]).cross(ac.subVectors(points[c], points[a])).dot(normal)
      if (direction === 0) continue
      indices.push(vertices[a], vertices[direction > 0 ? b : c], vertices[direction > 0 ? c : b])
    }
  }

  // ---------------------------------------------------------------
  // 节点变换（INode → PRS 静态值）
  // ---------------------------------------------------------------

  private buildNodeMatrices(
    view: DataView,
    items: MaxChunkRef[],
    meshOwners: Set<number>
  ): {
    nodes: { index: number; name: string; targets: Set<number>; matrix: THREE.Matrix4 }[]
  } {
    interface NodeInfo {
      name: string
      parent: number
      objectRef: number
      tmRef: number
      local?: THREE.Matrix4
    }

    const nodes = new Map<number, NodeInfo>()

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item.container) continue

      const children = this.readChildren(view, item)
      const nameChunk = children.find((c) => c.id === 0x0962 && !c.container)
      if (!nameChunk) continue

      let parent = -1
      let tmRef = -1
      let objectRef = -1

      for (const child of children) {
        if (child.container) continue
        if (child.id === 0x0960) {
          const start = this.payloadStart(child)
          if (start + 4 <= child.end) parent = view.getUint32(start, true)
        } else if (child.id === 0x2035) {
          const start = this.payloadStart(child)
          for (let p = start + 4; p + 8 <= child.end; p += 8) {
            const slot = view.getInt32(p, true)
            const target = view.getInt32(p + 4, true)
            if (slot === 0) tmRef = target
            else if (slot === 1) objectRef = target
          }
        }
      }

      nodes.set(i, { name: this.readNodeName(view, nameChunk), parent, objectRef, tmRef })
    }

    // 引用可能指向派生对象（修改器堆栈结果）甚至多层包装，沿引用链向下展开，
    // 一旦到达网格块就停止，避免把无关对象误绑到同一节点。
    const targetsOf = (info: NodeInfo): Set<number> => {
      const targets = new Set<number>()
      if (info.objectRef < 0 || info.objectRef >= items.length) return targets

      const queue = [info.objectRef]
      let guard = 0
      while (queue.length > 0 && guard++ < 256) {
        const index = queue.shift()!
        if (index < 0 || index >= items.length || targets.has(index)) continue
        targets.add(index)

        const item = items[index]
        if (!item.container || meshOwners.has(index)) continue

        for (const child of this.readChildren(view, item)) {
          if (child.container) continue
          if (child.id === 0x2034) {
            const start = this.payloadStart(child)
            for (let p = start; p + 4 <= child.end; p += 4) queue.push(view.getInt32(p, true))
          } else if (child.id === 0x2035) {
            const start = this.payloadStart(child)
            for (let p = start + 4; p + 8 <= child.end; p += 8) {
              if (view.getInt32(p, true) === 1) queue.push(view.getInt32(p + 4, true))
            }
          }
        }
      }
      return targets
    }

    // 只有真正绑定到网格的节点及其祖先才需要解析变换，超大场景可省去大量无用解析
    const relevant: { index: number; info: NodeInfo; targets: Set<number> }[] = []
    for (const [index, info] of nodes) {
      const targets = targetsOf(info)
      let bindsMesh = false
      for (const target of targets) {
        if (meshOwners.has(target)) {
          bindsMesh = true
          break
        }
      }
      // 没有网格的节点也可能是“闭合样条 + 挤出”等修改器对象
      if (!bindsMesh && !this.targetsHaveSpline(view, items, targets)) continue

      relevant.push({ index, info, targets })
    }

    const world = new Map<number, THREE.Matrix4>()
    const localOf = (index: number): THREE.Matrix4 => {
      const info = nodes.get(index)!
      if (!info.local) {
        info.local = this.resolveTransform(view, items, info.tmRef)
      }
      return info.local
    }
    const resolve = (index: number, stack: Set<number>): THREE.Matrix4 => {
      const cached = world.get(index)
      if (cached) return cached
      const info = nodes.get(index)
      if (!info || stack.has(index)) return new THREE.Matrix4()
      stack.add(index)
      const parentMatrix = info.parent >= 0 && nodes.has(info.parent) ? resolve(info.parent, stack) : new THREE.Matrix4()
      stack.delete(index)
      const result = parentMatrix.clone().multiply(localOf(index))
      world.set(index, result)
      return result
    }

    const nodeList: { index: number; name: string; targets: Set<number>; matrix: THREE.Matrix4 }[] = []

    for (const { index, info, targets } of relevant) {
      const matrix = resolve(index, new Set()).clone().multiply(this.readObjectOffset(view, items[index]))
      const safeName = info.name.replace(/[^\p{L}\p{N}_\-. ]/gu, '')
      nodeList.push({ index, name: safeName, targets, matrix })
    }

    return { nodes: nodeList }
  }

  /** 节点的引用链中是否带有样条控制点数据（0x290a） */
  private targetsHaveSpline(view: DataView, items: MaxChunkRef[], targets: Set<number>): boolean {
    for (const target of targets) {
      const item = items[target]
      if (!item || !item.container) continue
      if (this.findFirstChunk(view, item, 0x290a)) return true
    }
    return false
  }

  private readNodeName(view: DataView, chunk: MaxChunkRef): string {
    const start = this.payloadStart(chunk)
    let name = ''
    for (let i = start; i + 1 < chunk.end; i += 2) {
      const code = view.getUint16(i, true)
      if (code === 0) break
      name += String.fromCharCode(code)
    }
    return name
  }

  private resolveTransform(view: DataView, items: MaxChunkRef[], tmRef: number): THREE.Matrix4 {
    const identity = new THREE.Matrix4()
    if (tmRef < 0 || tmRef >= items.length) return identity

    const tmItem = items[tmRef]
    if (!tmItem.container) return identity

    const refs = this.collectDenseRefs(view, tmItem)
    if (refs.length < 3) return identity

    const position = this.readControllerVector(view, items, refs[0]) || [0, 0, 0]
    const translation = new THREE.Matrix4().makeTranslation(position[0], position[1], position[2])
    // 3ds Max 以行向量约定按 X→Y→Z 依次旋转（R = Rz·Ry·Rx），
    // 等价于 three.js 的 'ZYX' 顺序（已用 3ds Max 导出的 FBX 逐物体核对）
    const rotationItem = items[refs[1]]
    const quaternion = rotationItem && this.findFirstChunk(view, rotationItem, 0x2505)
    const rotation = this.readControllerVector(view, items, refs[1]) || [0, 0, 0]
    const rotationMatrix = quaternion && this.payloadLength(quaternion) === 16
      ? new THREE.Matrix4().makeRotationFromQuaternion(this.readQuaternion(view, quaternion))
      : new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation, 'ZYX'))
    const scaleItem = items[refs[2]]
    const scaleValue = scaleItem && this.findFirstChunk(view, scaleItem, 0x2505)
    const scale = this.readControllerVector(view, items, refs[2]) || [1, 1, 1]
    const scaleMatrix = scaleValue && this.payloadLength(scaleValue) === 28
      ? this.readScaleValue(view, scaleValue)
      : new THREE.Matrix4().makeScale(...scale)

    return translation.multiply(rotationMatrix).multiply(scaleMatrix)
  }

  /** INode 的对象偏移独立于 PRS，不能参与父子节点继承。 */
  private readObjectOffset(view: DataView, item: MaxChunkRef): THREE.Matrix4 {
    const children = this.readChildren(view, item)
    const position = children.find((c) => c.id === 0x096a && !c.container)
    const rotation = children.find((c) => c.id === 0x096b && !c.container)
    const scale = children.find((c) => c.id === 0x096c && !c.container)
    const matrix = new THREE.Matrix4()
    if (position && this.payloadLength(position) === 12) {
      const start = this.payloadStart(position)
      matrix.makeTranslation(view.getFloat32(start, true), view.getFloat32(start + 4, true), view.getFloat32(start + 8, true))
    }
    if (rotation && this.payloadLength(rotation) === 16) {
      matrix.multiply(new THREE.Matrix4().makeRotationFromQuaternion(this.readQuaternion(view, rotation)))
    }
    if (scale && this.payloadLength(scale) === 28) matrix.multiply(this.readScaleValue(view, scale))
    return matrix
  }

  private readQuaternion(view: DataView, chunk: MaxChunkRef, offset = 0): THREE.Quaternion {
    const start = this.payloadStart(chunk) + offset
    const q = new THREE.Quaternion(view.getFloat32(start, true), view.getFloat32(start + 4, true),
      view.getFloat32(start + 8, true), view.getFloat32(start + 12, true))
    return q.normalize().conjugate() // Max 的行向量四元数转为 three.js 列向量约定
  }

  /** ScaleValue = 三轴缩放 + 缩放轴方向四元数，不能丢弃后 16 字节。 */
  private readScaleValue(view: DataView, chunk: MaxChunkRef): THREE.Matrix4 {
    const start = this.payloadStart(chunk)
    const scale = new THREE.Matrix4().makeScale(view.getFloat32(start, true),
      view.getFloat32(start + 4, true), view.getFloat32(start + 8, true))
    const axis = new THREE.Matrix4().makeRotationFromQuaternion(this.readQuaternion(view, chunk, 12))
    return axis.clone().multiply(scale).multiply(axis.clone().transpose())
  }

  /** 读取一个三通道控制器（位置/旋转/缩放）的静态值 */
  private readControllerVector(
    view: DataView,
    items: MaxChunkRef[],
    index: number
  ): [number, number, number] | null {
    if (index < 0 || index >= items.length) return null
    const item = items[index]
    if (!item.container) return null

    const refs = this.collectDenseRefs(view, item)
    if (refs.length >= 3) {
      const values: number[] = []
      for (let i = 0; i < 3; i++) {
        const child = refs[i] >= 0 && refs[i] < items.length ? items[refs[i]] : null
        values.push(child ? this.findFirstFloat(view, child, 0x2501) ?? 0 : 0)
      }
      return [values[0], values[1], values[2]]
    }

    const seven = this.findFirstChunk(view, item, 0x2505)
    if (seven && this.payloadLength(seven) >= 12) {
      const start = this.payloadStart(seven)
      return [view.getFloat32(start, true), view.getFloat32(start + 4, true), view.getFloat32(start + 8, true)]
    }

    const single = this.findFirstFloat(view, item, 0x2501)
    if (single !== null) return [single, single, single]

    return null
  }

  private collectDenseRefs(view: DataView, item: MaxChunkRef): number[] {
    const chunk = this.findFirstChunk(view, item, 0x2034)
    if (!chunk) return []
    const out: number[] = []
    const start = this.payloadStart(chunk)
    for (let p = start; p + 4 <= chunk.end; p += 4) {
      out.push(view.getInt32(p, true))
    }
    return out
  }

  private findFirstChunk(view: DataView, item: MaxChunkRef, id: number): MaxChunkRef | null {
    if (!item.container) return null
    for (const child of this.readChildren(view, item)) {
      if (child.id === id && !child.container) return child
      if (child.container) {
        const found = this.findFirstChunk(view, child, id)
        if (found) return found
      }
    }
    return null
  }

  private findFirstFloat(view: DataView, item: MaxChunkRef, id: number): number | null {
    const chunk = this.findFirstChunk(view, item, id)
    if (!chunk) return null
    const start = this.payloadStart(chunk)
    if (start + 4 > chunk.end) return null
    const value = view.getFloat32(start, true)
    return Number.isFinite(value) ? value : null
  }
}

// ---------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------

interface MaxChunkRef {
  id: number
  start: number
  end: number
  headerSize: number
  container: boolean
}

interface MaxMeshEntry {
  positions: Float32Array
  indices: number[]
  ownerItem: number
  name: string
}
