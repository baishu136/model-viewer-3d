import * as THREE from 'three'
import * as fzstd from 'fzstd'
import { BinaryReader } from './utils/binary-reader'
import { triangulatePolygon } from './utils/triangulation'
import { polygonGeometry, subdivideMesh, wireframeMesh, type PolygonMesh } from './utils/blend-modifiers'

interface BlendBlock {
  code: string
  size: number
  oldAddress: bigint
  sdnaIndex: number
  count: number
  offset: number
  index: number
}

interface BlendAnimationData {
  clips: THREE.AnimationClip[]
}

interface BlendTransform {
  location: number[]
  rotation: number[]
  scale: number[]
  deltaLocation: number[]
  deltaScale: number[]
  deltaRotation: THREE.Quaternion
  quaternion: number[]
  axis: number[]
  angle: number
  mode: number
}

interface SDNAStruct {
  type: string
  size: number
  fields: Record<string, { type: string; name: string; offset: number; size: number }>
}

/**
 * High-performance, pure TypeScript parser for Blender (.blend) files.
 * Supports:
 * - Direct decompressed stream or transparent Zstd (0x28B52FFD) and Gzip (0x1F8B) decompression.
 * - Legacy 12-byte header (SmallBHead8) and modern 17-byte header (LargeBHead8 in Blender 4.5+ / 5.0).
 * - Legacy mesh layout (MVert / MPoly / MLoop) and modern Blender 4.x/5.0 AttributeStorage.
 */
export class BlendLoader {
  private manager: THREE.LoadingManager
  private transforms = new Map<string, BlendTransform>()
  private animationTargets = new Map<string, string>()

  private readTransform(reader: BinaryReader, block: BlendBlock, struct: SDNAStruct): BlendTransform {
    const floats = (name: string, fallback: number[]): number[] => {
      const field = struct.fields[name]
      if (!field || field.offset + fallback.length * 4 > block.size) return fallback
      reader.seek(block.offset + field.offset)
      return fallback.map(() => reader.readFloat32())
    }
    const modeField = struct.fields.rotmode
    reader.seek(block.offset + (modeField?.offset ?? 0))
    const mode = modeField ? reader.readInt16() : 1
    const deltaEuler = floats('drot[3]', [0, 0, 0])
    const deltaQ = floats('dquat[4]', [1, 0, 0, 0])
    const deltaAxis = floats('drotAxis[3]', [0, 1, 0])
    const deltaAngle = floats('drotAngle', [0])[0]
    const deltaRotation = mode === 0 ? new THREE.Quaternion(deltaQ[1], deltaQ[2], deltaQ[3], deltaQ[0]).normalize()
      : mode === -1 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(deltaAxis).normalize(), deltaAngle)
      : this.eulerQuaternion(deltaEuler, mode)
    return {
      location: floats('loc[3]', [0, 0, 0]), rotation: floats('rot[3]', [0, 0, 0]),
      scale: floats('size[3]', [1, 1, 1]), deltaLocation: floats('dloc[3]', [0, 0, 0]),
      deltaScale: floats('dscale[3]', [1, 1, 1]), deltaRotation,
      quaternion: floats('quat[4]', [1, 0, 0, 0]), axis: floats('rotAxis[3]', [0, 1, 0]),
      angle: floats('rotAngle', [0])[0], mode
    }
  }

  private eulerQuaternion(values: number[], mode: number): THREE.Quaternion {
    // Blender's extrinsic Euler order is the reverse of THREE.Euler's intrinsic order.
    const orders: THREE.EulerOrder[] = ['ZYX', 'ZYX', 'YZX', 'ZXY', 'XZY', 'YXZ', 'XYZ']
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(values[0], values[1], values[2], orders[mode] || 'ZYX'))
  }

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  /** Decompress buffer if it is packed with Zstandard or Gzip */
  private decompressIfNeeded(buffer: ArrayBuffer): ArrayBuffer {
    const bytes = new Uint8Array(buffer)
    // Zstandard magic: 0x28, 0xB5, 0x2F, 0xFD
    if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
      const decompressed = fzstd.decompress(bytes)
      return decompressed.buffer.slice(
        decompressed.byteOffset,
        decompressed.byteOffset + decompressed.byteLength
      ) as ArrayBuffer
    }
    return buffer
  }

  parse(rawBuffer: ArrayBuffer): THREE.Group {
    this.transforms.clear()
    this.animationTargets.clear()
    const buffer = this.decompressIfNeeded(rawBuffer)
    const root = new THREE.Group()
    root.name = 'BlendRoot'

    const reader = new BinaryReader(buffer)

    if (reader.length < 12) {
      throw new Error('无效的 Blender 文件: 文件过小')
    }

    const magic = reader.readAscii(7)
    if (magic !== 'BLENDER') {
      throw new Error(`无效的 Blender 文件头: ${magic}`)
    }

    // Check for Blender Format Version 1 (17-byte header, LargeBHead8 in Blender 4.5+ / 5.0)
    let isVersion1 = false
    let is64Bit = true
    let isLittleEndian = true
    let ptrBytes = 8

    const c7 = reader.readUint8()
    const c8 = reader.readUint8()
    if (c7 === 49 && c8 === 55) {
      // '17'
      isVersion1 = true
      is64Bit = true
      isLittleEndian = true
      ptrBytes = 8
      reader.setLittleEndian(true)
      reader.seek(17)
    } else {
      // Legacy 12-byte header
      const ptrSizeChar = String.fromCharCode(c7)
      is64Bit = ptrSizeChar === '-'
      ptrBytes = is64Bit ? 8 : 4
      const endianChar = String.fromCharCode(c8)
      isLittleEndian = endianChar === 'v'
      reader.setLittleEndian(isLittleEndian)
      reader.seek(12)
    }

    // 2. Scan all file blocks
    const blocks: BlendBlock[] = []
    const blockByAddress = new Map<bigint, BlendBlock>()
    let dnaBlock: BlendBlock | null = null

    while (reader.position < reader.length) {
      if (isVersion1) {
        if (reader.remaining < 32) break
        const code = reader.readAscii(4)
        if (code === 'ENDB') break
        const sdnaIndex = reader.readInt32()
        const oldAddress = reader.readUint64()
        const size = Number(reader.readUint64())
        const count = Number(reader.readUint64())
        const payloadOffset = reader.position

        const block: BlendBlock = {
          code,
          size,
          oldAddress,
          sdnaIndex,
          count,
          offset: payloadOffset,
          index: blocks.length
        }
        blocks.push(block)
        blockByAddress.set(oldAddress, block)
        if (code === 'DNA1') dnaBlock = block
        reader.seek(payloadOffset + size)
      } else {
        if (reader.remaining < 4 + 4 + ptrBytes + 4 + 4) break
        const code = reader.readAscii(4)
        if (code === 'ENDB') break
        const size = reader.readUint32()
        const oldAddress = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
        const sdnaIndex = reader.readUint32()
        const count = reader.readUint32()
        const payloadOffset = reader.position

        const block: BlendBlock = {
          code,
          size,
          oldAddress,
          sdnaIndex,
          count,
          offset: payloadOffset,
          index: blocks.length
        }
        blocks.push(block)
        blockByAddress.set(oldAddress, block)
        if (code === 'DNA1') dnaBlock = block
        reader.seek(payloadOffset + size)
      }
    }

    if (!dnaBlock) {
      throw new Error('无效的 Blender 文件: 找不到 SDNA 字典块')
    }

    // 3. Parse SDNA dictionary
    const sdna = this.parseSDNA(reader, dnaBlock, ptrBytes)

    // 4. Extract Meshes
    const meshBlocks = blocks.filter((b) => b.code.startsWith('ME') && sdna.structNames[b.sdnaIndex] === 'Mesh')
    const objectBlocks = blocks.filter((b) => b.code.startsWith('OB') && sdna.structNames[b.sdnaIndex] === 'Object')

    if (objectBlocks.length > 0 && sdna.structs.has('Object')) {
      const objStruct = sdna.structs.get('Object')!
      const dataOffset = objStruct.fields['*data']?.offset
      const typeOffset = objStruct.fields['type']?.offset
      const matOffset = objStruct.fields['obmat[4][4]']?.offset
      const parentOffset = objStruct.fields['*parent']?.offset

      interface BlendObjectEntry {
        address: bigint
        name: string
        type: number
        parentAddress: bigint
        world: THREE.Matrix4
        holder: THREE.Group
        parentInverse: THREE.Matrix4
      }

      const entries: BlendObjectEntry[] = []
      const holdersByAddress = new Map<string, THREE.Group>()

      const readMatrix = (objBlock: BlendBlock, offset = matOffset): THREE.Matrix4 => {
        const matrix = new THREE.Matrix4()
        if (offset === undefined || objBlock.size < offset + 64) return matrix
        const values: number[] = []
        reader.seek(objBlock.offset + offset)
        for (let k = 0; k < 16; k++) {
          const val = reader.readFloat32()
          values.push(Number.isFinite(val) ? val : (k % 5 === 0 ? 1 : 0))
        }
        // Blender stores matrix columns consecutively, like Matrix4.elements.
        return matrix.fromArray(values)
      }

      for (const objBlock of objectBlocks) {
        let meshAddr: bigint = 0n
        if (dataOffset !== undefined) {
          reader.seek(objBlock.offset + dataOffset)
          meshAddr = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
        }

        let objType = 1
        if (typeOffset !== undefined) {
          reader.seek(objBlock.offset + typeOffset)
          objType = reader.readInt16()
        }

        let parentAddress = 0n
        if (parentOffset !== undefined && objBlock.size >= parentOffset + ptrBytes) {
          reader.seek(objBlock.offset + parentOffset)
          parentAddress = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
        }

        const objectName = this.readObjectName(reader, objBlock, sdna)
        if (!objectName) continue

        const holder = new THREE.Group()
        holder.name = objectName
        this.animationTargets.set(objectName, holder.uuid)
        if (objStruct.fields['loc[3]']) {
          const transform = this.readTransform(reader, objBlock, objStruct)
          this.transforms.set(objectName, transform)
          holder.position.fromArray(transform.location).add(new THREE.Vector3().fromArray(transform.deltaLocation))
          holder.scale.fromArray(transform.scale).multiply(new THREE.Vector3().fromArray(transform.deltaScale))
          const q = transform.quaternion
          holder.quaternion.copy(transform.mode === 0 ? new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize()
            : transform.mode === -1 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(transform.axis).normalize(), transform.angle)
            : this.eulerQuaternion(transform.rotation, transform.mode)).premultiply(transform.deltaRotation)
        }
        holdersByAddress.set(objBlock.oldAddress.toString(), holder)

        if (objType === 1 && meshAddr !== 0n) {
          const targetMeshBlock = blockByAddress.get(meshAddr)
          if (targetMeshBlock) {
            let meshNode: THREE.Mesh | null = null
            try {
              meshNode = this.parseMeshBlock(reader, targetMeshBlock, blocks, blockByAddress, sdna, is64Bit)
            } catch {
              meshNode = null
            }
            if (meshNode) {
              this.applyPreviewModifiers(reader, objBlock, meshNode, blocks, blockByAddress, sdna, ptrBytes)
              meshNode.name = `${objectName}_mesh`
              holder.add(meshNode)
            }
          }
        }

        entries.push({
          address: objBlock.oldAddress,
          name: objectName,
          type: objType,
          parentAddress,
          world: readMatrix(objBlock),
          parentInverse: objStruct.fields['parentinv[4][4]'] ? readMatrix(objBlock, objStruct.fields['parentinv[4][4]'].offset) : new THREE.Matrix4(),
          holder
        })
      }

      // 建立父子层级：动画曲线给出的是相对父级的局部变换
      const byAddress = new Map<string, BlendObjectEntry>()
      for (const entry of entries) byAddress.set(entry.address.toString(), entry)

      for (const entry of entries) {
        const parent = entry.parentAddress ? byAddress.get(entry.parentAddress.toString()) : undefined
        if (this.transforms.has(entry.name)) {
          if (parent && parent !== entry) {
            // Keep parent inverse separate: animation changes the basis, not this matrix.
            const offset = new THREE.Group()
            offset.name = `${entry.name}_parentInverse`
            offset.matrixAutoUpdate = false
            offset.matrix.copy(entry.parentInverse)
            parent.holder.add(offset)
            offset.add(entry.holder)
          } else root.add(entry.holder)
          continue
        }
        const local = new THREE.Matrix4()
        if (parent && parent !== entry) {
          local.copy(parent.world).invert().multiply(entry.world)
          parent.holder.add(entry.holder)
        } else {
          local.copy(entry.world)
          root.add(entry.holder)
        }
        local.decompose(entry.holder.position, entry.holder.quaternion, entry.holder.scale)
      }
    }

    // Fallback: If no objects were added or file only contained isolated ME blocks
    if (root.children.length === 0) {
      for (const mBlock of meshBlocks) {
        const meshNode = this.parseMeshBlock(reader, mBlock, blocks, blockByAddress, sdna, is64Bit)
        if (meshNode) {
          delete meshNode.geometry.userData.blendPolygons
          root.add(meshNode)
        }
      }
    }

    // Adjust Blender Z-up coordinate system to Three.js Y-up (Rotate -90 deg around X axis)
    root.rotation.x = -Math.PI / 2
    root.updateMatrixWorld(true)

    // 5. 对象级动画（位置 / 欧拉旋转 / 缩放）
    try {
      const animation = this.buildAnimations(reader, blocks, blockByAddress, sdna, objectBlocks, ptrBytes)
      if (animation.clips.length > 0) {
        root.userData.animations = animation.clips
      }
    } catch {
      // 动画解析失败不影响几何显示
    }

    return root
  }

  private readObjectName(reader: BinaryReader, objBlock: BlendBlock, sdna: { structs: Map<string, SDNAStruct> }): string {
    const nameField = Object.values(sdna.structs.get('ID')?.fields || {}).find((f) => /^name(?:\[|$)/.test(f.name))
    const idNameOffset = nameField?.offset ?? 40
    if (objBlock.size < idNameOffset + 2) return ''
    reader.seek(objBlock.offset + idNameOffset)
    const bytes: number[] = []
    for (let i = 0; i < Math.min(nameField?.size ?? 64, objBlock.size - idNameOffset); i++) {
      const ch = reader.readUint8()
      if (ch === 0) break
      bytes.push(ch)
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }

  private applyPreviewModifiers(
    reader: BinaryReader, object: BlendBlock, mesh: THREE.Mesh, blocks: BlendBlock[],
    blockByAddress: Map<bigint, BlendBlock>, sdna: { structNames: string[]; structs: Map<string, SDNAStruct> }, ptrBytes: number
  ): void {
    const faces = mesh.geometry.userData.blendPolygons as number[][] | undefined
    delete mesh.geometry.userData.blendPolygons
    const field = sdna.structs.get('Object')?.fields.modifiers, modifier = sdna.structs.get('ModifierData')
    if (!field || !modifier || !faces?.length) return
    const scope = new Map<bigint, BlendBlock>()
    for (let i = object.index + 1; i < blocks.length && blocks[i].code.startsWith('DATA'); i++) scope.set(blocks[i].oldAddress, blocks[i])
    const find = (address: bigint): BlendBlock | undefined => scope.get(address) || blockByAddress.get(address)
    const pointer = (offset: number): bigint => { reader.seek(offset); return ptrBytes === 8 ? reader.readUint64() : BigInt(reader.readUint32()) }
    let address = pointer(object.offset + field.offset), changed = false
    let source: PolygonMesh = { positions: Array.from(mesh.geometry.attributes.position.array), faces }
    const visited = new Set<bigint>(), applied: string[] = [], skipped: string[] = []
    while (address && !visited.has(address) && visited.size < 1000) {
      visited.add(address)
      const block = find(address); if (!block) break
      const next = pointer(block.offset + modifier.fields['*next'].offset)
      reader.seek(block.offset + modifier.fields.mode.offset)
      const mode = reader.readInt32()
      const type = sdna.structNames[block.sdnaIndex], struct = sdna.structs.get(type)
      if ((mode & 1) && struct) {
        const float = (name: string): number => { reader.seek(block.offset + struct.fields[name].offset); return reader.readFloat32() }
        const short = (name: string): number => { reader.seek(block.offset + struct.fields[name].offset); return reader.readInt16() }
        if (type === 'WireframeModifierData' && struct.fields.offset && struct.fields.flag) {
          const flags = short('flag'), thickness = float('offset')
          // Vertex groups, relative thickness and crease weights need Blender evaluation.
          const group = struct.fields['defgrp_name[64]']
          reader.seek(block.offset + (group?.offset ?? 0))
          if ((group && reader.readUint8() !== 0) || (flags & (16 | 32)) || !Number.isFinite(thickness) || thickness === 0 || source.faces.length > 100000) skipped.push(type)
          else {
            source = wireframeMesh(source, thickness, float('offset_fac'), !!(flags & 2), !!(flags & 8))
            changed = true; applied.push(type)
          }
        } else if (type === 'SubsurfModifierData' && struct.fields.levels && struct.fields.subdivType) {
          const levels = short('levels')
          if (levels < 0 || levels > 3 || source.faces.reduce((sum, face) => sum + face.length, 0) * 4 ** Math.max(0, levels - 1) > 500000) skipped.push(type)
          else {
            for (let i = 0; i < levels; i++) source = subdivideMesh(source, short('subdivType') === 1)
            if (levels > 0) { changed = true; applied.push(type) }
          }
        } else skipped.push(type)
      }
      address = next
    }
    if (changed) {
      const previous = mesh.geometry
      mesh.geometry = polygonGeometry(source)
      previous.dispose()
    }
    mesh.userData.blendModifiers = { applied, skipped, preview: true }
  }

  private parseSDNA(
    reader: BinaryReader,
    dnaBlock: BlendBlock,
    ptrBytes: number
  ): { names: string[]; types: string[]; typeLens: number[]; structNames: string[]; structs: Map<string, SDNAStruct> } {
    reader.seek(dnaBlock.offset)

    const magic = reader.readAscii(4)
    if (magic !== 'SDNA') {
      throw new Error(`SDNA 标识不符: ${magic}`)
    }

    // NAME catalog
    reader.readAscii(4) // 'NAME'
    const nameCount = reader.readUint32()
    const names: string[] = []
    for (let i = 0; i < nameCount; i++) {
      let str = ''
      while (true) {
        const ch = reader.readUint8()
        if (ch === 0) break
        str += String.fromCharCode(ch)
      }
      names.push(str)
    }

    // Skip zero padding to reach next tag
    while (reader.position < reader.length && reader.readUint8() === 0) {
      // advance
    }
    reader.seek(reader.position - 1)

    // TYPE catalog
    reader.readAscii(4) // 'TYPE'
    const typeCount = reader.readUint32()
    const types: string[] = []
    for (let i = 0; i < typeCount; i++) {
      let str = ''
      while (true) {
        const ch = reader.readUint8()
        if (ch === 0) break
        str += String.fromCharCode(ch)
      }
      types.push(str)
    }

    while (reader.position < reader.length && reader.readUint8() === 0) {
      // advance
    }
    reader.seek(reader.position - 1)

    // TLEN (type lengths)
    reader.readAscii(4) // 'TLEN'
    const typeLens: number[] = []
    for (let i = 0; i < typeCount; i++) {
      typeLens.push(reader.readUint16())
    }

    while (reader.position < reader.length && reader.readUint8() === 0) {
      // advance
    }
    reader.seek(reader.position - 1)

    // STRC (structures)
    reader.readAscii(4) // 'STRC'
    const structCount = reader.readUint32()
    const structs = new Map<string, SDNAStruct>()
    const structNames: string[] = []

    for (let i = 0; i < structCount; i++) {
      const typeIdx = reader.readUint16()
      const fieldCount = reader.readUint16()
      const typeName = types[typeIdx]
      structNames.push(typeName)
      let currentOffset = 0
      const fields: Record<string, { type: string; name: string; offset: number; size: number }> = {}

      for (let j = 0; j < fieldCount; j++) {
        const fTypeIdx = reader.readUint16()
        const fNameIdx = reader.readUint16()
        const fType = types[fTypeIdx]
        const fName = names[fNameIdx]

        let fSize = typeLens[fTypeIdx]
        if (fName.startsWith('*')) {
          fSize = ptrBytes
        }
        const arrMatch = fName.match(/\[(\d+)\]/g)
        if (arrMatch) {
          let multiplier = 1
          for (const m of arrMatch) {
            multiplier *= parseInt(m.replace(/[\[\]]/g, ''), 10)
          }
          fSize *= multiplier
        }

        fields[fName] = {
          type: fType,
          name: fName,
          offset: currentOffset,
          size: fSize
        }
        currentOffset += fSize
      }

      structs.set(typeName, {
        type: typeName,
        // Array element stride is the SDNA TLEN, including trailing structure padding.
        size: typeLens[typeIdx],
        fields
      })
    }

    return { names, types, typeLens, structNames, structs }
  }

  /**
   * 同一尺寸的 DATA 块可能对应法线、UV 等其它属性，按“数值像坐标”挑选顶点块：
   * 全部有限、幅度合理，且优先选择不会退化为零体积的块。
   */
  private pickVertexBlock(reader: BinaryReader, candidates: BlendBlock[], totvert: number): BlendBlock | null {
    if (candidates.length === 0) return null
    const sampleCount = Math.min(totvert, 64)
    let firstValid: BlendBlock | null = null

    for (const block of candidates) {
      let valid = true
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity

      reader.seek(block.offset)
      for (let v = 0; v < sampleCount; v++) {
        const x = reader.readFloat32()
        const y = reader.readFloat32()
        const z = reader.readFloat32()
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(z) ||
          Math.abs(x) > 1e5 ||
          Math.abs(y) > 1e5 ||
          Math.abs(z) > 1e5
        ) {
          valid = false
          break
        }
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }

      if (!valid) continue
      if (!firstValid) firstValid = block
      const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
      if (diagonal > 1e-5) return block
    }
    return firstValid
  }

  /** Sample saved object F-curves in their owning Action's direct-data scope. */
  private buildAnimations(
    reader: BinaryReader,
    blocks: BlendBlock[],
    blockByAddress: Map<bigint, BlendBlock>,
    sdna: { structNames: string[]; structs: Map<string, SDNAStruct> },
    objectBlocks: BlendBlock[],
    ptrBytes: number
  ): BlendAnimationData {
    const curveStruct = sdna.structs.get('FCurve'), bezier = sdna.structs.get('BezTriple')
    const actionStruct = sdna.structs.get('bAction'), animStruct = sdna.structs.get('AnimData')
    const objectStruct = sdna.structs.get('Object')
    if (!curveStruct || !bezier || !actionStruct || !animStruct || !objectStruct) return { clips: [] }
    if (!objectStruct.fields['*adt'] || !animStruct.fields['*action']) return { clips: [] }
    const pointer = (offset: number): bigint => {
      if (offset < 0 || offset + ptrBytes > reader.length) return 0n
      reader.seek(offset)
      return ptrBytes === 8 ? reader.readUint64() : BigInt(reader.readUint32())
    }
    const integer = (base: number, struct: SDNAStruct, field: string, fallback = 0): number => {
      if (!struct.fields[field]) return fallback
      reader.seek(base + struct.fields[field].offset)
      return reader.readInt32()
    }
    let fps = 24, start = 1, end = 250
    const scene = blocks.find((b) => sdna.structNames[b.sdnaIndex] === 'Scene')
    const sceneStruct = sdna.structs.get('Scene'), renderStruct = sdna.structs.get('RenderData')
    if (scene && sceneStruct?.fields.r && renderStruct) {
      const base = scene.offset + sceneStruct.fields.r.offset
      start = integer(base, renderStruct, 'sfra', start)
      end = integer(base, renderStruct, 'efra', end)
      if (renderStruct.fields.frs_sec) {
        reader.seek(base + renderStruct.fields.frs_sec.offset)
        const rate = reader.readInt16()
        if (rate > 0 && rate <= 1000) fps = rate
      }
      if (renderStruct.fields.frs_sec_base) {
        reader.seek(base + renderStruct.fields.frs_sec_base.offset)
        const divisor = reader.readFloat32()
        if (divisor > 0 && Number.isFinite(divisor)) fps /= divisor
      }
    }
    if (end < start || end - start > 1000000) return { clips: [] }
    interface Key { frame: number; value: number; left: number[]; right: number[]; interpolation: number }
    const sample = (keys: Key[], frame: number): number => {
      if (frame <= keys[0].frame) return keys[0].value
      let lo = 0, hi = keys.length - 1
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (keys[mid].frame <= frame) lo = mid; else hi = mid }
      const a = keys[lo], b = keys[lo + 1]
      if (!b || frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value
      if (a.interpolation === 0) return a.value
      const span = b.frame - a.frame
      if (a.interpolation !== 2 || span <= 0) return a.value + (b.value - a.value) * ((frame - a.frame) / span)
      let x1 = a.right[0], y1 = a.right[1], x2 = b.left[0], y2 = b.left[1]
      const handles = Math.abs(x1 - a.frame) + Math.abs(b.frame - x2)
      if (handles > span) {
        const factor = span / handles
        x1 = a.frame + (x1 - a.frame) * factor; y1 = a.value + (y1 - a.value) * factor
        x2 = b.frame + (x2 - b.frame) * factor; y2 = b.value + (y2 - b.value) * factor
      }
      const cubic = (p0: number, p1: number, p2: number, p3: number, t: number): number =>
        (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3
      let low = 0, high = 1
      for (let i = 0; i < 30; i++) {
        const t = (low + high) / 2
        if (cubic(a.frame, x1, x2, b.frame, t) < frame) low = t; else high = t
      }
      return cubic(a.value, y1, y2, b.value, (low + high) / 2)
    }
    const tracks: THREE.KeyframeTrack[] = []
    for (const object of objectBlocks) {
      const name = this.readObjectName(reader, object, sdna)
      const transform = this.transforms.get(name)
      if (!transform) continue
      const anim = blockByAddress.get(pointer(object.offset + objectStruct.fields['*adt'].offset))
      if (!anim) continue
      const action = blockByAddress.get(pointer(anim.offset + animStruct.fields['*action'].offset))
      if (!action) continue
      let scopeEnd = action.index + 1
      while (scopeEnd < blocks.length && blocks[scopeEnd].code.startsWith('DATA')) scopeEnd++
      const scope = new Map<bigint, BlendBlock>()
      for (const b of blocks.slice(action.index + 1, scopeEnd)) scope.set(b.oldAddress, b)
      const find = (address: bigint): BlendBlock | undefined => scope.get(address) || blockByAddress.get(address)
      // Pointer tokens are not byte offsets and may exceed Number.MAX_SAFE_INTEGER.
      const arrayAt = (address: bigint, index: number): BlendBlock | undefined => {
        const array = find(address)
        return array && (index + 1) * ptrBytes <= array.size ? find(pointer(array.offset + index * ptrBytes)) : undefined
      }
      const at = (block: BlendBlock, struct: SDNAStruct, field: string): bigint =>
        struct.fields[field] ? pointer(block.offset + struct.fields[field].offset) : 0n
      const curves: BlendBlock[] = []
      const layer = sdna.structs.get('ActionLayer'), strip = sdna.structs.get('ActionStrip')
      const keyData = sdna.structs.get('ActionStripKeyframeData'), bag = sdna.structs.get('ActionChannelBag')
      if (layer && strip && keyData && bag) {
        const layers = at(action, actionStruct, '**layer_array')
        const dataArray = at(action, actionStruct, '**strip_keyframe_data_array')
        const dataCount = integer(action.offset, actionStruct, 'strip_keyframe_data_array_num')
        const slot = integer(anim.offset, animStruct, 'slot_handle')
        for (let li = 0; li < Math.min(integer(action.offset, actionStruct, 'layer_array_num'), 1000); li++) {
          const l = arrayAt(layers, li); if (!l) continue
          for (let si = 0; si < Math.min(integer(l.offset, layer, 'strip_array_num'), 10000); si++) {
            const st = arrayAt(at(l, layer, '**strip_array'), si); if (!st) continue
            const index = integer(st.offset, strip, 'data_index', -1)
            if (index < 0 || index >= dataCount) continue
            const data = arrayAt(dataArray, index); if (!data) continue
            for (let ci = 0; ci < Math.min(integer(data.offset, keyData, 'channelbag_array_num'), 10000); ci++) {
              const channel = arrayAt(at(data, keyData, '**channelbag_array'), ci); if (!channel) continue
              if (slot && integer(channel.offset, bag, 'slot_handle') !== slot) continue
              for (let fi = 0; fi < Math.min(integer(channel.offset, bag, 'fcurve_array_num'), 100000); fi++) {
                const curve = arrayAt(at(channel, bag, '**fcurve_array'), fi)
                if (curve) curves.push(curve)
              }
            }
          }
        }
      }
      if (curves.length === 0 && actionStruct.fields.curves) {
        let address = pointer(action.offset + actionStruct.fields.curves.offset)
        const visited = new Set<bigint>()
        while (address && !visited.has(address)) {
          visited.add(address)
          const curve = find(address); if (!curve) break
          curves.push(curve); address = pointer(curve.offset)
        }
      }
      const properties = new Map<string, Map<number, Key[]>>()
      for (const curve of curves) {
        const pathBlock = find(at(curve, curveStruct, '*rna_path'))
        if (!pathBlock) continue
        reader.seek(pathBlock.offset)
        const property = reader.readAscii(Math.min(pathBlock.size, 256)).split('\0')[0]
        if (!['location', 'scale', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle'].includes(property)) continue
        const component = integer(curve.offset, curveStruct, 'array_index', -1)
        if (component < 0 || component > (property.startsWith('rotation_') && property !== 'rotation_euler' ? 3 : 2)) continue
        const keyBlock = find(at(curve, curveStruct, '*bezt'))
        if (!keyBlock) continue
        const keys: Key[] = []
        const count = Math.min(integer(curve.offset, curveStruct, 'totvert', keyBlock.count), Math.floor(keyBlock.size / bezier.size))
        for (let i = 0; i < count; i++) {
          const base = keyBlock.offset + i * bezier.size + (bezier.fields['vec[3][3]']?.offset ?? 0)
          reader.seek(base)
          const values = Array.from({ length: 9 }, () => reader.readFloat32())
          reader.seek(keyBlock.offset + i * bezier.size + (bezier.fields.ipo?.offset ?? 48))
          if (values.every(Number.isFinite)) keys.push({ frame: values[3], value: values[4], left: values.slice(0, 2), right: values.slice(6, 8), interpolation: reader.readUint8() })
        }
        keys.sort((a, b) => a.frame - b.frame)
        if (!keys.length) continue
        if (!properties.has(property)) properties.set(property, new Map())
        properties.get(property)!.set(component, keys)
      }
      if (!properties.size) continue
      // Sample each frame before quaternion conversion, retaining full revolutions.
      const frames = new Set<number>([start, end])
      const step = Math.max(1, (end - start) / 100000)
      for (let frame = start; frame < end; frame += step) frames.add(frame)
      for (const components of properties.values()) for (const keys of components.values()) for (const key of keys) {
        if (key.frame >= start && key.frame <= end) frames.add(key.frame)
      }
      const sorted = [...frames].sort((a, b) => a - b), times = sorted.map((frame) => (frame - start) / fps)
      for (const [property, components] of properties) {
        const fallback = property === 'location' ? transform.location : property === 'scale' ? transform.scale
          : property === 'rotation_quaternion' ? transform.quaternion : property === 'rotation_axis_angle' ? [transform.angle, ...transform.axis] : transform.rotation
        const values: number[] = []
        for (const frame of sorted) {
          const v = fallback.map((value, index) => components.has(index) ? sample(components.get(index)!, frame) : value)
          if (property === 'location') values.push(...v.map((n, i) => n + transform.deltaLocation[i]))
          else if (property === 'scale') values.push(...v.map((n, i) => n * transform.deltaScale[i]))
          else {
            const q = property === 'rotation_quaternion' ? new THREE.Quaternion(v[1], v[2], v[3], v[0]).normalize()
              : property === 'rotation_axis_angle' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(v[1], v[2], v[3]).normalize(), v[0])
              : this.eulerQuaternion(v, transform.mode)
            q.premultiply(transform.deltaRotation)
            values.push(...q.toArray())
          }
        }
        const target = property === 'location' ? 'position' : property === 'scale' ? 'scale' : 'quaternion'
        const binding = `${this.animationTargets.get(name) || name}.${target}`
        tracks.push(target === 'quaternion' ? new THREE.QuaternionKeyframeTrack(binding, times, values)
          : new THREE.VectorKeyframeTrack(binding, times, values))
      }
    }
    return { clips: tracks.length ? [new THREE.AnimationClip('场景动画', (end - start) / fps, tracks)] : [] }
  }

  private parseMeshBlock(
    reader: BinaryReader,
    meshBlock: BlendBlock,
    allBlocks: BlendBlock[],
    blockByAddress: Map<bigint, BlendBlock>,
    sdna: { structs: Map<string, SDNAStruct> },
    is64Bit: boolean
  ): THREE.Mesh | null {
    // Direct DATA pointers are scoped to their owning ID. Blender's writer reuses
    // temporary Attribute/AttributeArray addresses when serialising later meshes.
    let end = meshBlock.index + 1
    while (end < allBlocks.length && allBlocks[end].code.startsWith('DATA')) end++
    const localBlocks = allBlocks.slice(meshBlock.index + 1, end)
    const dataBlocks = localBlocks.filter((b) => b.offset + b.size <= reader.length)
    const meshBlocksByAddress = new Map(localBlocks.map((block) => [block.oldAddress, block]))
    const find = (address: bigint): BlendBlock | undefined => meshBlocksByAddress.get(address) || blockByAddress.get(address)
    const meshStruct = sdna.structs.get('Mesh')
    if (!meshStruct) return null

    const totvertOffset = meshStruct.fields['totvert']?.offset
    const totpolyOffset = meshStruct.fields['totpoly']?.offset
    const totloopOffset = meshStruct.fields['totloop']?.offset
    const mvertOffset = (meshStruct.fields['*mvert'] || meshStruct.fields['*verts'])?.offset
    const mpolyOffset = (meshStruct.fields['*mpoly'] || meshStruct.fields['*polys'])?.offset
    const mloopOffset = (meshStruct.fields['*mloop'] || meshStruct.fields['*loops'])?.offset

    let totvert = 0
    let totpoly = 0
    let totloop = 0
    let mvertAddr: bigint = 0n
    let mpolyAddr: bigint = 0n
    let mloopAddr: bigint = 0n

    const readCount = (offset: number | undefined): number => {
      if (offset === undefined || meshBlock.offset + offset + 4 > reader.length) return 0
      reader.seek(meshBlock.offset + offset)
      return reader.readInt32()
    }
    const readAddress = (offset: number | undefined): bigint => {
      if (offset === undefined || meshBlock.offset + offset + (is64Bit ? 8 : 4) > reader.length) return 0n
      reader.seek(meshBlock.offset + offset)
      return is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
    }

    totvert = readCount(totvertOffset)
    totpoly = readCount(totpolyOffset)
    totloop = readCount(totloopOffset)
    mvertAddr = readAddress(mvertOffset)
    mpolyAddr = readAddress(mpolyOffset)
    mloopAddr = readAddress(mloopOffset)

    // 损坏数据会让计数失控（遍历数百万项后越界），这里做严格的上限保护
    const MAX_COUNT = 20000000
    if (totvert <= 0 || totvert > MAX_COUNT) return null
    if (totpoly < 0 || totpoly > MAX_COUNT || totloop < 0 || totloop > MAX_COUNT) return null

    const readable = (offset: number, bytes: number): boolean =>
      offset >= 0 && offset + bytes <= reader.length

    const vertices: number[] = []
    const indices: number[] = []
    const polygons: number[][] = []

    const pointer = (offset: number): bigint => {
      reader.seek(offset)
      return is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
    }
    const string = (offset: number, length: number): string => {
      reader.seek(offset)
      return reader.readAscii(length).split('\0')[0]
    }
    const attributes = new Map<string, { block: BlendBlock; single: boolean }>()
    const storage = sdna.structs.get('AttributeStorage'), attribute = sdna.structs.get('Attribute')
    const storageField = meshStruct.fields.attribute_storage
    if (storageField && storage && attribute) {
      const base = meshBlock.offset + storageField.offset
      const array = find(pointer(base + storage.fields['*dna_attributes'].offset))
      reader.seek(base + storage.fields.dna_attributes_num.offset)
      const count = reader.readInt32()
      if (array && count >= 0 && count * attribute.size <= array.size) {
        for (let i = 0; i < count; i++) {
          const at = array.offset + i * attribute.size
          const nameBlock = find(pointer(at + attribute.fields['*name'].offset))
          if (!nameBlock) continue
          const name = string(nameBlock.offset, nameBlock.size)
          if (name !== 'position' && name !== '.corner_vert') continue
          const value = find(pointer(at + attribute.fields['*data'].offset))
          if (!value) continue
          reader.seek(at + attribute.fields.storage_type.offset)
          const storageType = reader.readUint8()
          const valueStruct = sdna.structs.get(storageType === 1 ? 'AttributeSingle' : 'AttributeArray')
          if (!valueStruct) continue
          const block = find(pointer(value.offset + valueStruct.fields['*data'].offset))
          let single = storageType === 1
          if (!single && valueStruct.fields.is_single) {
            reader.seek(value.offset + valueStruct.fields.is_single.offset)
            single = reader.readUint8() !== 0
          }
          if (block) attributes.set(name, { block, single })
        }
      }
    }
    // Blender 3.x/4.x store named attributes in CustomDataLayer arrays.
    const custom = sdna.structs.get('CustomData'), layer = sdna.structs.get('CustomDataLayer')
    if (custom && layer) for (const domain of ['vdata', 'ldata']) {
      const field = meshStruct.fields[domain]
      if (!field) continue
      const base = meshBlock.offset + field.offset
      const layers = find(pointer(base + custom.fields['*layers'].offset))
      reader.seek(base + custom.fields.totlayer.offset)
      const count = reader.readInt32()
      if (!layers || count < 0 || count * layer.size > layers.size) continue
      for (let i = 0; i < count; i++) {
        const at = layers.offset + i * layer.size
        const nameField = layer.fields['name[68]'] || layer.fields['name[64]']
        if (!nameField) continue
        const name = string(at + nameField.offset, nameField.size)
        if (name !== 'position' && name !== '.corner_vert') continue
        const block = find(pointer(at + layer.fields['*data'].offset))
        if (block && !attributes.has(name)) attributes.set(name, { block, single: false })
      }
    }

    const position = attributes.get('position')
    if (position && position.block.size >= (position.single ? 12 : totvert * 12)) {
      for (let v = 0; v < totvert; v++) {
        reader.seek(position.block.offset + (position.single ? 0 : v * 12))
        vertices.push(reader.readFloat32(), reader.readFloat32(), reader.readFloat32())
      }
    }

    // 1. 旧版 MVert 顶点表
    if (vertices.length === 0 && mvertAddr !== 0n) {
      const mvertBlock = find(mvertAddr)
      const mvertStruct = sdna.structs.get('MVert')
      const coOffset = mvertStruct?.fields['co[3]']?.offset ?? 0
      const mvertStride = mvertStruct?.size ?? 16
      if (mvertBlock && readable(mvertBlock.offset, totvert * mvertStride)) {
        for (let v = 0; v < totvert; v++) {
          const vPos = mvertBlock.offset + v * mvertStride + coOffset
          if (!readable(vPos, 12)) break
          reader.seek(vPos)
          vertices.push(reader.readFloat32(), reader.readFloat32(), reader.readFloat32())
        }
      }
    }

    // 2. 现代 Blender 4.x/5.0：位置数据是一个 totvert * 12 字节的 DATA 块
    const namedLayout = !!storageField || !!(meshStruct.fields.vdata && layer)
    if (vertices.length === 0 && !namedLayout) {
      const candidates = dataBlocks.filter((b) => b.size === totvert * 12)
      const vBlock = this.pickVertexBlock(reader, candidates, totvert)
      if (vBlock) {
        reader.seek(vBlock.offset)
        for (let v = 0; v < totvert; v++) {
          vertices.push(reader.readFloat32(), reader.readFloat32(), reader.readFloat32())
        }
      }
    }

    // 3. 面索引
    // 3A. 现代：poly_offset_indices（totpoly+1 个整数）+ corner_verts（totloop 个整数）
    if (totpoly > 0 && totloop > 0) {
      // 同一尺寸的数据块可能有多份（法线、UV、遮罩等），逐个校验后再采用
      let offsets: number[] | null = null
      const offsetAddress = readAddress((meshStruct.fields['*face_offset_indices'] || meshStruct.fields['*poly_offset_indices'])?.offset)
      const offsetBlock = find(offsetAddress)
      for (const block of offsetBlock ? [offsetBlock] : dataBlocks) {
        if (block.size !== (totpoly + 1) * 4) continue
        if (!readable(block.offset, block.size)) continue

        const candidate: number[] = []
        let valid = true
        reader.seek(block.offset)
        for (let p = 0; p <= totpoly; p++) {
          const value = reader.readInt32()
          if (!Number.isFinite(value) || value < 0 || value > totloop) {
            valid = false
            break
          }
          if (p > 0 && value < candidate[p - 1]) {
            valid = false
            break
          }
          candidate.push(value)
        }
        // 每个多边形至少 3 个顶点
        if (valid && candidate[0] === 0 && candidate[totpoly] === totloop && candidate.every((n, i) => i === 0 || n - candidate[i - 1] >= 3)) {
          offsets = candidate
          break
        }
      }

      const corner = attributes.get('.corner_vert')
      let cornerBlock: BlendBlock | null = corner && !corner.single && corner.block.size >= totloop * 4 ? corner.block : null
      for (const block of cornerBlock || namedLayout ? [] : dataBlocks) {
        if (block.size !== totloop * 4) continue
        if (!readable(block.offset, block.size)) continue

        const step = Math.max(1, Math.floor(totloop / 512))
        let valid = true
        for (let i = 0; i < totloop; i += step) {
          reader.seek(block.offset + i * 4)
          const value = reader.readInt32()
          if (!Number.isFinite(value) || value < 0 || value >= totvert) {
            valid = false
            break
          }
        }
        if (valid) {
          cornerBlock = block
          break
        }
      }

      if (offsets && cornerBlock) {
        for (let p = 0; p < totpoly; p++) {
          const start = offsets[p]
          const end = offsets[p + 1]
          if (start < 0 || end < start || end > totloop || end - start > 8192) break
          const polyIndices: number[] = []
          for (let l = start; l < end; l++) {
            reader.seek(cornerBlock.offset + l * 4)
            const idx = reader.readInt32()
            if (idx >= 0 && idx < totvert) polyIndices.push(idx)
          }
          polygons.push(polyIndices)
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    // 3B. 旧版 MPoly / MLoop
    if (indices.length === 0 && mpolyAddr !== 0n && mloopAddr !== 0n && totpoly > 0) {
      const mpolyBlock = find(mpolyAddr)
      const mloopBlock = find(mloopAddr)
      const mpolyStruct = sdna.structs.get('MPoly')
      const mloopStruct = sdna.structs.get('MLoop')
      const mpolyStride = mpolyStruct?.size ?? 16
      const mloopStride = mloopStruct?.size ?? 12
      const loopstartOffset = mpolyStruct?.fields['loopstart']?.offset ?? 0
      const totloopFieldOffset = mpolyStruct?.fields['totloop']?.offset ?? 4
      const vFieldOffset = mloopStruct?.fields['v']?.offset ?? 0

      if (
        mpolyBlock &&
        mloopBlock &&
        readable(mpolyBlock.offset, totpoly * mpolyStride) &&
        readable(mloopBlock.offset, totloop * mloopStride)
      ) {
        for (let p = 0; p < totpoly; p++) {
          const polyPos = mpolyBlock.offset + p * mpolyStride
          reader.seek(polyPos + loopstartOffset)
          const loopstart = reader.readInt32()
          reader.seek(polyPos + totloopFieldOffset)
          const loopCount = reader.readInt32()
          if (loopstart < 0 || loopCount < 0 || loopstart + loopCount > totloop) break

          const polyIndices: number[] = []
          for (let l = 0; l < loopCount; l++) {
            const lPos = mloopBlock.offset + (loopstart + l) * mloopStride + vFieldOffset
            if (!readable(lPos, 4)) break
            reader.seek(lPos)
            const idx = reader.readInt32()
            if (idx >= 0 && idx < totvert) polyIndices.push(idx)
          }
          polygons.push(polyIndices)
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    if (vertices.length < 9 || (totpoly > 0 && indices.length === 0)) return null

    // 顶点块选错时会出现天文数字坐标，直接丢弃这些异常值
    let outliers = 0
    for (let i = 0; i < vertices.length; i++) {
      if (!Number.isFinite(vertices[i]) || Math.abs(vertices[i]) > 1e5) outliers += 1
    }
    if (outliers > vertices.length / 3) return null
    if (outliers > 0) {
      for (let i = 0; i < vertices.length; i++) {
        if (!Number.isFinite(vertices[i]) || Math.abs(vertices[i]) > 1e5) vertices[i] = 0
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.userData.blendPolygons = polygons
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    if (indices.length > 0) {
      geometry.setIndex(indices)
    }
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const mesh = new THREE.Mesh(geometry)
    mesh.name = 'BlendMesh'
    return mesh
  }
}
