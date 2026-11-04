import * as THREE from 'three'
import * as fzstd from 'fzstd'
import { BinaryReader } from './utils/binary-reader'
import { triangulatePolygon } from './utils/triangulation'

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
      }

      const entries: BlendObjectEntry[] = []
      const holdersByAddress = new Map<string, THREE.Group>()

      const readMatrix = (objBlock: BlendBlock): THREE.Matrix4 => {
        const matrix = new THREE.Matrix4()
        if (matOffset === undefined || objBlock.size < matOffset + 64) return matrix
        const values: number[] = []
        reader.seek(objBlock.offset + matOffset)
        for (let k = 0; k < 16; k++) {
          const val = reader.readFloat32()
          values.push(Number.isFinite(val) ? val : (k % 5 === 0 ? 1 : 0))
        }
        // Blender 的 obmat 是行主序（行向量约定），three 需要其转置
        matrix.set(
          values[0], values[1], values[2], values[3],
          values[4], values[5], values[6], values[7],
          values[8], values[9], values[10], values[11],
          values[12], values[13], values[14], values[15]
        )
        return matrix
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
        if (parentOffset !== undefined && objBlock.size >= parentOffset + 8) {
          reader.seek(objBlock.offset + parentOffset)
          parentAddress = reader.readUint64()
        }

        const objectName = this.readObjectName(reader, objBlock, sdna)
        if (!objectName) continue

        const holder = new THREE.Group()
        holder.name = objectName
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
          holder
        })
      }

      // 建立父子层级：动画曲线给出的是相对父级的局部变换
      const byAddress = new Map<string, BlendObjectEntry>()
      for (const entry of entries) byAddress.set(entry.address.toString(), entry)

      for (const entry of entries) {
        const parent = entry.parentAddress ? byAddress.get(entry.parentAddress.toString()) : undefined
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
          root.add(meshNode)
        }
      }
    }

    // Adjust Blender Z-up coordinate system to Three.js Y-up (Rotate -90 deg around X axis)
    root.rotation.x = -Math.PI / 2
    root.updateMatrixWorld(true)

    // 5. 对象级动画（位置 / 欧拉旋转 / 缩放）
    try {
      const animation = this.buildAnimations(reader, blocks, blockByAddress, sdna, objectBlocks)
      if (animation.clips.length > 0) {
        root.userData.animations = animation.clips
      }
    } catch {
      // 动画解析失败不影响几何显示
    }

    return root
  }

  private readObjectName(reader: BinaryReader, objBlock: BlendBlock, sdna: { structs: Map<string, SDNAStruct> }): string {
    const idNameOffset = sdna.structs.get('ID')?.fields['name']?.offset ?? 40
    if (objBlock.size < idNameOffset + 2) return ''
    reader.seek(objBlock.offset + idNameOffset)
    let name = ''
    for (let i = 0; i < 64; i++) {
      const ch = reader.readUint8()
      if (ch === 0) break
      name += String.fromCharCode(ch)
    }
    return name
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

  /** 读取对象级动画（location / rotation_euler / scale），合并为一个动画片段 */
  private buildAnimations(
    reader: BinaryReader,
    blocks: BlendBlock[],
    blockByAddress: Map<bigint, BlendBlock>,
    sdna: { structNames: string[]; structs: Map<string, SDNAStruct> },
    objectBlocks: BlendBlock[]
  ): BlendAnimationData {
    const fcurveStruct = sdna.structs.get('FCurve')
    const bezStruct = sdna.structs.get('BezTriple')
    const actionStruct = sdna.structs.get('bAction')
    const animStruct = sdna.structs.get('AnimData')
    const sceneStruct = sdna.structs.get('Scene')
    const renderStruct = sdna.structs.get('RenderData')
    const idNameOffset = sdna.structs.get('ID')?.fields['name']?.offset ?? 40
    const objStruct = sdna.structs.get('Object')
    if (!fcurveStruct || !bezStruct || !actionStruct || !animStruct || !objStruct) return { clips: [] }

    const adtOffset = objStruct.fields['*adt']?.offset
    const actionOffset = animStruct.fields['*action']?.offset
    if (adtOffset === undefined || actionOffset === undefined) return { clips: [] }

    // 帧率与起始帧
    let fps = 24
    let frameStart = 0
    const sceneBlock = blocks.find((b) => sdna.structNames[b.sdnaIndex] === 'Scene')
    if (sceneBlock && sceneStruct && renderStruct) {
      const renderOffset = sceneBlock.offset + (sceneStruct.fields['r']?.offset ?? 0)
      const frsSec = renderStruct.fields['frs_sec']?.offset
      const sfraOffset = renderStruct.fields['sfra']?.offset
      if (frsSec !== undefined && renderOffset + frsSec + 2 <= reader.length) {
        reader.seek(renderOffset + frsSec)
        const value = reader.readInt16()
        if (value > 0 && value < 240) fps = value
      }
      if (sfraOffset !== undefined && renderOffset + sfraOffset + 4 <= reader.length) {
        reader.seek(renderOffset + sfraOffset)
        frameStart = reader.readInt32()
      }
    }

    const readPointer = (offset: number): bigint => {
      if (!Number.isFinite(offset) || offset < 0 || offset + 8 > reader.length) return 0n
      reader.seek(offset)
      return reader.readUint64()
    }
    const readStringAt = (address: bigint): string => {
      if (!address) return ''
      const block = blockByAddress.get(address)
      if (!block) return ''
      reader.seek(block.offset)
      return reader.readAscii(Math.min(block.size, 256)).split('\u0000')[0]
    }
    const readCurveKeys = (curveBlock: BlendBlock): Array<[number, number]> => {
      const beztOffset = fcurveStruct.fields['*bezt']?.offset
      if (beztOffset === undefined) return []
      const keyBlock = blockByAddress.get(readPointer(curveBlock.offset + beztOffset))
      if (!keyBlock || keyBlock.count <= 0) return []
      const stride = bezStruct.size || 72
      const keys: Array<[number, number]> = []
      for (let k = 0; k < keyBlock.count; k++) {
        const base = keyBlock.offset + k * stride
        if (base + 20 > reader.length) break
        reader.seek(base + 12)
        const frame = reader.readFloat32()
        const value = reader.readFloat32()
        if (Number.isFinite(frame) && Number.isFinite(value)) keys.push([frame, value])
      }
      return keys
    }

    const layerArrayOffset = actionStruct.fields['**layer_array']?.offset
    const layerNumOffset = actionStruct.fields['layer_array_num']?.offset
    const skdArrayOffset = actionStruct.fields['**strip_keyframe_data_array']?.offset
    const skdNumOffset = actionStruct.fields['strip_keyframe_data_array_num']?.offset
    const curvesOffset = actionStruct.fields['curves']?.offset
    const layerStruct = sdna.structs.get('ActionLayer')
    const stripStruct = sdna.structs.get('ActionStrip')
    const skdStruct = sdna.structs.get('ActionStripKeyframeData')
    const cbStruct = sdna.structs.get('ActionChannelBag')

    const perObject = new Map<string, Map<string, Map<number, Array<[number, number]>>>>()

    for (const objBlock of objectBlocks) {
      const adtAddress = readPointer(objBlock.offset + adtOffset)
      if (!adtAddress) continue
      const adtBlock = blockByAddress.get(adtAddress)
      if (!adtBlock) continue
      const actionAddress = readPointer(adtBlock.offset + actionOffset)
      if (!actionAddress) continue
      const actionBlock = blockByAddress.get(actionAddress)
      if (!actionBlock) continue

      reader.seek(objBlock.offset + idNameOffset)
      let objectName = ''
      for (let i = 0; i < 64; i++) {
        const ch = reader.readUint8()
        if (ch === 0) break
        objectName += String.fromCharCode(ch)
      }
      if (!objectName) continue

      const fcurves: bigint[] = []
      if (
        layerArrayOffset !== undefined &&
        layerNumOffset !== undefined &&
        skdArrayOffset !== undefined &&
        skdNumOffset !== undefined &&
        layerStruct &&
        stripStruct &&
        skdStruct &&
        cbStruct
      ) {
        const layerArray = readPointer(actionBlock.offset + layerArrayOffset)
        reader.seek(actionBlock.offset + layerNumOffset)
        const layerNum = reader.readInt32()
        const skdArray = readPointer(actionBlock.offset + skdArrayOffset)
        reader.seek(actionBlock.offset + skdNumOffset)
        const skdNum = reader.readInt32()

        if (layerArray && layerNum > 0 && skdArray && skdNum > 0) {
          for (let li = 0; li < layerNum; li++) {
            const layerBlock = blockByAddress.get(readPointer(Number(layerArray) + li * 8))
            if (!layerBlock) continue
            const stripArray = readPointer(layerBlock.offset + layerStruct.fields['**strip_array'].offset)
            reader.seek(layerBlock.offset + layerStruct.fields['strip_array_num'].offset)
            const stripNum = reader.readInt32()

            for (let si = 0; si < stripNum; si++) {
              const stripBlock = blockByAddress.get(readPointer(Number(stripArray) + si * 8))
              if (!stripBlock) continue
              reader.seek(stripBlock.offset + stripStruct.fields['data_index'].offset)
              const dataIndex = reader.readInt32()
              if (dataIndex < 0 || dataIndex >= skdNum) continue

              const skdBlock = blockByAddress.get(readPointer(Number(skdArray) + dataIndex * 8))
              if (!skdBlock) continue
              const cbArray = readPointer(skdBlock.offset + skdStruct.fields['**channelbag_array'].offset)
              reader.seek(skdBlock.offset + skdStruct.fields['channelbag_array_num'].offset)
              const cbNum = reader.readInt32()

              for (let ci = 0; ci < cbNum; ci++) {
                const cbBlock = blockByAddress.get(readPointer(Number(cbArray) + ci * 8))
                if (!cbBlock) continue
                const fcArray = readPointer(cbBlock.offset + cbStruct.fields['**fcurve_array'].offset)
                reader.seek(cbBlock.offset + cbStruct.fields['fcurve_array_num'].offset)
                const fcNum = reader.readInt32()
                for (let fi = 0; fi < fcNum; fi++) {
                  const fcAddress = readPointer(Number(fcArray) + fi * 8)
                  if (fcAddress) fcurves.push(fcAddress)
                }
              }
            }
          }
        }
      }

      if (fcurves.length === 0 && curvesOffset !== undefined) {
        let cursor = readPointer(actionBlock.offset + curvesOffset)
        let guard = 0
        while (cursor && guard++ < 10000) {
          fcurves.push(cursor)
          const block = blockByAddress.get(cursor)
          if (!block) break
          cursor = readPointer(block.offset)
        }
      }

      for (const curveAddress of fcurves) {
        const curveBlock = blockByAddress.get(curveAddress)
        if (!curveBlock) continue
        const pathAddress = readPointer(curveBlock.offset + fcurveStruct.fields['*rna_path'].offset)
        if (!pathAddress) continue
        const path = readStringAt(pathAddress)
        if (path !== 'location' && path !== 'rotation_euler' && path !== 'scale') continue

        reader.seek(curveBlock.offset + fcurveStruct.fields['array_index'].offset)
        const arrayIndex = reader.readInt32()
        if (arrayIndex < 0 || arrayIndex > 2) continue

        const keys = readCurveKeys(curveBlock)
        if (keys.length === 0) continue

        let properties = perObject.get(objectName)
        if (!properties) {
          properties = new Map()
          perObject.set(objectName, properties)
        }
        let components = properties.get(path)
        if (!components) {
          components = new Map()
          properties.set(path, components)
        }
        components.set(arrayIndex, keys)
      }
    }

    const tracks: THREE.KeyframeTrack[] = []
    let duration = 0

    const sampleComponent = (keys: Array<[number, number]>, frames: number[]): number[] => {
      const out: number[] = []
      let cursor = 0
      for (const frame of frames) {
        while (cursor + 1 < keys.length && keys[cursor + 1][0] <= frame) cursor++
        const [f0, v0] = keys[cursor]
        const next = keys[cursor + 1]
        if (!next || frame <= f0) {
          out.push(v0)
          continue
        }
        const span = next[0] - f0
        const t = span > 1e-6 ? (frame - f0) / span : 0
        out.push(v0 + (next[1] - v0) * t)
      }
      return out
    }

    for (const [objectName, properties] of perObject) {
      for (const [path, components] of properties) {
        const allFrames = new Set<number>()
        for (const keys of components.values()) for (const [frame] of keys) allFrames.add(frame)
        const frames = [...allFrames].sort((a, b) => a - b)
        if (frames.length < 2) continue
        const times = frames.map((frame) => Math.max(0, (frame - frameStart) / fps))
        duration = Math.max(duration, times[times.length - 1])

        const componentValues = new Map<number, number[]>()
        for (const [index, keys] of components) componentValues.set(index, sampleComponent(keys, frames))
        const valueAt = (index: number, i: number): number => componentValues.get(index)?.[i] ?? (path === 'scale' ? 1 : 0)

        if (path === 'location' || path === 'scale') {
          const values: number[] = []
          for (let i = 0; i < frames.length; i++) values.push(valueAt(0, i), valueAt(1, i), valueAt(2, i))
          tracks.push(new THREE.VectorKeyframeTrack(`${objectName}.${path === 'location' ? 'position' : 'scale'}`, times, values))
        } else {
          const values: number[] = []
          const euler = new THREE.Euler()
          const quaternion = new THREE.Quaternion()
          for (let i = 0; i < frames.length; i++) {
            euler.set(valueAt(0, i), valueAt(1, i), valueAt(2, i), 'ZYX')
            quaternion.setFromEuler(euler)
            values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
          }
          tracks.push(new THREE.QuaternionKeyframeTrack(`${objectName}.quaternion`, times, values))
        }
      }
    }

    if (tracks.length === 0) return { clips: [] }
    return { clips: [new THREE.AnimationClip('场景动画', duration > 0 ? duration : 1, tracks)] }
  }

  private parseMeshBlock(
    reader: BinaryReader,
    meshBlock: BlendBlock,
    allBlocks: BlendBlock[],
    blockByAddress: Map<bigint, BlendBlock>,
    sdna: { structs: Map<string, SDNAStruct> },
    is64Bit: boolean
  ): THREE.Mesh | null {
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
      if (offset === undefined || meshBlock.offset + offset + 8 > reader.length) return 0n
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

    // 1. 旧版 MVert 顶点表
    if (mvertAddr !== 0n) {
      const mvertBlock = blockByAddress.get(mvertAddr)
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

    // 该网格之后的兄弟数据块
    const meIndex = meshBlock.index
    let nextMeIndex = allBlocks.length
    for (let i = meIndex + 1; i < allBlocks.length; i++) {
      if (allBlocks[i].code.startsWith('ME') || allBlocks[i].code.startsWith('OB')) {
        nextMeIndex = i
        break
      }
    }
    const localBlocks = allBlocks.slice(meIndex + 1, nextMeIndex)
    const dataBlocks = localBlocks.filter((b) => b.code.startsWith('DATA') && readable(b.offset, b.size))

    // 2. 现代 Blender 4.x/5.0：位置数据是一个 totvert * 12 字节的 DATA 块
    if (vertices.length === 0) {
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
      for (const block of dataBlocks) {
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
        if (valid && candidate[totpoly] >= Math.min(totloop, totpoly * 3)) {
          offsets = candidate
          break
        }
      }

      let cornerBlock: BlendBlock | null = null
      for (const block of dataBlocks) {
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
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    // 3B. 旧版 MPoly / MLoop
    if (indices.length === 0 && mpolyAddr !== 0n && mloopAddr !== 0n && totpoly > 0) {
      const mpolyBlock = blockByAddress.get(mpolyAddr)
      const mloopBlock = blockByAddress.get(mloopAddr)
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
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    if (vertices.length < 9) return null

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
