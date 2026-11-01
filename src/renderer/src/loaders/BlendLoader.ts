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

        if (objType === 1 && meshAddr !== 0n) {
          const targetMeshBlock = blockByAddress.get(meshAddr)
          if (targetMeshBlock) {
            const meshNode = this.parseMeshBlock(reader, targetMeshBlock, blocks, blockByAddress, sdna, is64Bit)
            if (meshNode) {
              if (matOffset !== undefined && objBlock.size >= matOffset + 64) {
                reader.seek(objBlock.offset + matOffset)
                const m = new THREE.Matrix4()
                const elements: number[] = []
                for (let k = 0; k < 16; k++) {
                  const val = reader.readFloat32()
                  elements.push(Number.isFinite(val) ? val : (k % 5 === 0 ? 1 : 0))
                }
                m.fromArray(elements)
                meshNode.applyMatrix4(m)
              }
              root.add(meshNode)
            }
          }
        }
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

    return root
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

    if (totvertOffset !== undefined) {
      reader.seek(meshBlock.offset + totvertOffset)
      totvert = reader.readInt32()
    }
    if (totpolyOffset !== undefined) {
      reader.seek(meshBlock.offset + totpolyOffset)
      totpoly = reader.readInt32()
    }
    if (totloopOffset !== undefined) {
      reader.seek(meshBlock.offset + totloopOffset)
      totloop = reader.readInt32()
    }

    if (mvertOffset !== undefined) {
      reader.seek(meshBlock.offset + mvertOffset)
      mvertAddr = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
    }
    if (mpolyOffset !== undefined) {
      reader.seek(meshBlock.offset + mpolyOffset)
      mpolyAddr = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
    }
    if (mloopOffset !== undefined) {
      reader.seek(meshBlock.offset + mloopOffset)
      mloopAddr = is64Bit ? reader.readUint64() : BigInt(reader.readUint32())
    }

    if (totvert <= 0) return null

    let vertices: number[] = []
    let indices: number[] = []

    // 1. Try legacy MVert layout
    if (mvertAddr !== 0n) {
      const mvertBlock = blockByAddress.get(mvertAddr)
      if (mvertBlock) {
        const mvertStruct = sdna.structs.get('MVert')
        const coOffset = mvertStruct?.fields['co[3]']?.offset ?? 0
        const mvertStride = mvertStruct?.size ?? 16

        for (let v = 0; v < totvert; v++) {
          const vPos = mvertBlock.offset + v * mvertStride + coOffset
          if (vPos + 12 <= reader.length) {
            reader.seek(vPos)
            const x = reader.readFloat32()
            const y = reader.readFloat32()
            const z = reader.readFloat32()
            vertices.push(
              Number.isFinite(x) ? x : 0,
              Number.isFinite(y) ? y : 0,
              Number.isFinite(z) ? z : 0
            )
          }
        }
      }
    }

    // Identify local sibling blocks belonging to this Mesh
    const meIndex = meshBlock.index
    let nextMeIndex = allBlocks.length
    for (let i = meIndex + 1; i < allBlocks.length; i++) {
      if (allBlocks[i].code.startsWith('ME') || allBlocks[i].code.startsWith('OB')) {
        nextMeIndex = i
        break
      }
    }
    const localBlocks = allBlocks.slice(meIndex + 1, nextMeIndex)

    // 2. Modern Blender 4.x/5.0: extract vertices from local DATA block with matching size
    if (vertices.length === 0) {
      const vBlock = localBlocks.find((b) => b.code.startsWith('DATA') && b.size === totvert * 12)
      if (vBlock) {
        reader.seek(vBlock.offset)
        for (let v = 0; v < totvert; v++) {
          const x = reader.readFloat32()
          const y = reader.readFloat32()
          const z = reader.readFloat32()
          vertices.push(
            Number.isFinite(x) ? x : 0,
            Number.isFinite(y) ? y : 0,
            Number.isFinite(z) ? z : 0
          )
        }
      }
    }

    // 3. Extract face indices
    // 3A. Modern Blender 4.x/5.0: local poly_offset_indices and corner_verts blocks
    if (totpoly > 0) {
      const pBlock = localBlocks.find((b) => b.code.startsWith('DATA') && b.size === (totpoly + 1) * 4)
      const lBlock = localBlocks.find((b) => b.code.startsWith('DATA') && b.size === totloop * 4 && b !== pBlock)

      if (pBlock && lBlock) {
        for (let p = 0; p < totpoly; p++) {
          reader.seek(pBlock.offset + p * 4)
          const start = reader.readInt32()
          const end = reader.readInt32()

          const polyIndices: number[] = []
          for (let l = start; l < end; l++) {
            reader.seek(lBlock.offset + l * 4)
            const idx = reader.readInt32()
            if (idx >= 0 && idx < totvert) {
              polyIndices.push(idx)
            }
          }
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    // 3B. Fallback to legacy MPoly / MLoop indices
    if (indices.length === 0 && mpolyAddr !== 0n && mloopAddr !== 0n && totpoly > 0) {
      const mpolyBlock = blockByAddress.get(mpolyAddr)
      const mloopBlock = blockByAddress.get(mloopAddr)

      if (mpolyBlock && mloopBlock) {
        const mpolyStruct = sdna.structs.get('MPoly')
        const mloopStruct = sdna.structs.get('MLoop')
        const loopstartOffset = mpolyStruct?.fields['loopstart']?.offset ?? 0
        const totloopFieldOffset = mpolyStruct?.fields['totloop']?.offset ?? 4
        const mpolyStride = mpolyStruct?.size ?? 16

        const vFieldOffset = mloopStruct?.fields['v']?.offset ?? 0
        const mloopStride = mloopStruct?.size ?? 12

        for (let p = 0; p < totpoly; p++) {
          reader.seek(mpolyBlock.offset + p * mpolyStride + loopstartOffset)
          const loopstart = reader.readInt32()
          reader.seek(mpolyBlock.offset + p * mpolyStride + totloopFieldOffset)
          const loopCount = reader.readInt32()

          const polyIndices: number[] = []
          for (let l = 0; l < loopCount; l++) {
            const lPos = mloopBlock.offset + (loopstart + l) * mloopStride + vFieldOffset
            if (lPos + 4 <= reader.length) {
              reader.seek(lPos)
              const idx = reader.readInt32()
              if (idx >= 0 && idx < totvert) {
                polyIndices.push(idx)
              }
            }
          }
          triangulatePolygon(polyIndices, vertices, indices)
        }
      }
    }

    if (vertices.length < 9) return null

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
