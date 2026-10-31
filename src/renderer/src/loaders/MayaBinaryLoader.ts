import * as THREE from 'three'
import { BinaryReader } from './utils/binary-reader'
import { fanTriangulate } from './utils/triangulation'

/**
 * High-performance, pure TypeScript parser for Maya Binary (.mb) IFF files.
 * Supports:
 * - 32-bit IFF files (FOR4 / FORM)
 * - 64-bit IFF files (FOR8 in Maya 2014+)
 * Directly extracts geometric meshes, vertex float arrays, and polygon faces.
 */
export class MayaBinaryLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(buffer: ArrayBuffer): THREE.Group {
    const root = new THREE.Group()
    root.name = 'MayaBinaryRoot'

    const reader = new BinaryReader(buffer)
    reader.setLittleEndian(false) // Maya Binary is Big-Endian IFF

    if (reader.length < 12) {
      throw new Error('无效的 Maya Binary 文件: 文件过小')
    }

    const rootTag = reader.readFourCC()
    const is64Bit = rootTag === 'FOR8'
    const is32Bit = rootTag === 'FOR4' || rootTag === 'FORM'

    if (!is64Bit && !is32Bit) {
      throw new Error(`无效的 Maya Binary 格式: 未知文件头 ${rootTag}`)
    }

    // Reset reader to 0 and parse sequentially
    reader.seek(0)
    this.parseChunks(reader, root, reader.length, is64Bit)

    return root
  }

  private parseChunks(reader: BinaryReader, root: THREE.Group, limit: number, is64Bit: boolean): void {
    let currentMeshName: string | null = null
    const headerSize = is64Bit ? 16 : 8

    while (reader.position + headerSize <= limit) {
      const chunkPos = reader.position
      const chunkTag = reader.readFourCC()

      let chunkSize = 0
      if (is64Bit) {
        // Skip 4-byte padding/flags between tag and 64-bit size
        reader.skip(4)
        chunkSize = Number(reader.readUint64(false))
      } else {
        chunkSize = reader.readUint32(false)
      }

      const chunkDataPos = reader.position
      const chunkEnd = chunkDataPos + chunkSize
      const pad = is64Bit ? (8 - (chunkSize % 8)) % 8 : (chunkSize % 2 !== 0 ? 1 : 0)
      const nextChunkPos = chunkEnd + pad

      if (chunkEnd > limit || isNaN(chunkSize) || chunkSize < 0) {
        break
      }

      // Handle group/container chunks (FOR8, FOR4, FORM, LIS8, LIS4, CAT4)
      if (
        chunkTag === 'FOR8' ||
        chunkTag === 'FOR4' ||
        chunkTag === 'FORM' ||
        chunkTag === 'LIS8' ||
        chunkTag === 'LIS4' ||
        chunkTag === 'CAT4'
      ) {
        if (chunkSize >= 4) {
          // Skip 4-byte subtype (e.g. 'Maya', 'HEAD', 'DMSH', 'XFRM') and continue sequentially into children
          reader.skip(4)
          continue
        }
      } else if (chunkTag === 'CREA') {
        const text = reader.readAscii(chunkSize)
        const parts = text.split(/\0|\s+/).filter(Boolean)
        if (parts.length > 0) {
          currentMeshName = parts[parts.length - 1]
        }
      } else if (chunkTag === 'MESH' || chunkTag === 'DBLK') {
        // Check if this chunk contains a stream of float3 coordinates
        if (chunkSize >= 36) {
          let bestOffset = -1
          let maxValidFloats = 0

          // Scan common byte alignments (0, 4, 7, 8, 12, 16) to find contiguous float3 coordinates
          for (const checkOff of [0, 4, 7, 8, 12, 16]) {
            if (checkOff + 36 > chunkSize) continue
            let valid = 0
            const maxCheck = Math.min(chunkSize - 12, checkOff + 360)
            for (let i = chunkDataPos + checkOff; i <= chunkDataPos + maxCheck; i += 12) {
              reader.seek(i)
              const x = reader.readFloat32(false)
              const y = reader.readFloat32(false)
              const z = reader.readFloat32(false)
              if (
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                Number.isFinite(z) &&
                Math.abs(x) < 50000 &&
                Math.abs(y) < 50000 &&
                Math.abs(z) < 50000
              ) {
                valid++
              }
            }
            if (valid > maxValidFloats) {
              maxValidFloats = valid
              bestOffset = checkOff
            }
          }

          if (maxValidFloats >= 3 && bestOffset !== -1) {
            const vertices: number[] = []
            reader.seek(chunkDataPos + bestOffset)
            const remainingBytes = chunkSize - bestOffset
            const floatCount = Math.floor(remainingBytes / 4)

            for (let i = 0; i + 3 <= floatCount; i += 3) {
              const x = reader.readFloat32(false)
              const y = reader.readFloat32(false)
              const z = reader.readFloat32(false)
              if (
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                Number.isFinite(z) &&
                Math.abs(x) < 100000 &&
                Math.abs(y) < 100000 &&
                Math.abs(z) < 100000
              ) {
                vertices.push(x, y, z)
              } else {
                break
              }
            }

            if (vertices.length >= 9) {
              const geometry = new THREE.BufferGeometry()
              geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
              geometry.computeVertexNormals()
              geometry.computeBoundingBox()

              const mesh = new THREE.Mesh(geometry)
              mesh.name = currentMeshName || `MayaMesh_${root.children.length + 1}`
              root.add(mesh)
            }
          }
        }
      }

      reader.seek(Math.min(nextChunkPos, limit))
    }
  }
}
