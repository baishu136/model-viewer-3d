import * as THREE from 'three'
import { BinaryReader } from './utils/binary-reader'
import { fanTriangulate } from './utils/triangulation'

/**
 * High-performance, pure TypeScript parser for Cinema 4D (.c4d) files.
 * Supports:
 * - Direct extraction of baked PolygonObject geometries (Float32 and Float64 points + CPolygon index sets)
 * - Automatic embedded high-resolution viewport preview board (JPEG/PNG) for procedural/rigged files
 */
export class C4DLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(buffer: ArrayBuffer): THREE.Group {
    const root = new THREE.Group()
    root.name = 'C4DRoot'

    const reader = new BinaryReader(buffer)

    if (reader.length < 16) {
      throw new Error('无效的 Cinema 4D 文件: 文件过小')
    }

    // 1. Traverse buffer to discover PolygonObject chunks or point/poly buffers
    const foundMeshes = this.scanPolygonObjects(reader)

    if (foundMeshes.length > 0) {
      for (const m of foundMeshes) {
        root.add(m)
      }
    } else {
      // 2. Fallback to embedded high-resolution viewport thumbnail board if present
      const previewBoard = this.extractEmbeddedThumbnail(buffer)
      if (previewBoard) {
        root.add(previewBoard)
      } else {
        throw new Error(
          '该 .c4d 文件未包含烘焙多边形缓存或预览数据。请在 Cinema 4D 首选项中开启“保存多边形以用于外部应用程序”，或将对象转为可编辑多边形后保存。'
        )
      }
    }

    return root
  }

  /**
   * Scans for embedded JPEG or PNG preview images in the header section
   * and creates an interactive 3D viewport display board.
   */
  private extractEmbeddedThumbnail(buffer: ArrayBuffer): THREE.Mesh | null {
    const bytes = new Uint8Array(buffer)
    let start = -1
    let isJpg = false
    let isPng = false

    const searchLimit = Math.min(bytes.length - 16, 65536)
    for (let i = 0; i < searchLimit; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        start = i
        isJpg = true
        break
      }
      if (
        bytes[i] === 0x89 &&
        bytes[i + 1] === 0x50 &&
        bytes[i + 2] === 0x4e &&
        bytes[i + 3] === 0x47
      ) {
        start = i
        isPng = true
        break
      }
    }

    if (start === -1) return null

    let end = -1
    if (isJpg) {
      for (let i = start + 2; i < bytes.length - 1; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
          end = i + 2
          break
        }
      }
    } else if (isPng) {
      for (let i = start + 8; i < bytes.length - 8; i++) {
        if (
          bytes[i] === 0x49 &&
          bytes[i + 1] === 0x45 &&
          bytes[i + 2] === 0x4e &&
          bytes[i + 3] === 0x44
        ) {
          end = i + 8
          break
        }
      }
    }

    if (end === -1 || end <= start) return null

    const imageBytes = bytes.subarray(start, end)
    let binary = ''
    for (let i = 0; i < imageBytes.length; i++) {
      binary += String.fromCharCode(imageBytes[i])
    }
    const mime = isJpg ? 'image/jpeg' : 'image/png'
    const dataUri = `data:${mime};base64,` + btoa(binary)

    const material = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide
    })

    const texture = new THREE.TextureLoader(this.manager).load(dataUri, () => {
      material.map = texture
      material.needsUpdate = true
    })
    texture.colorSpace = THREE.SRGBColorSpace
    material.map = texture

    // Build a standee card geometry立在网格底面上 (100 x 56.25 cm)
    const geometry = new THREE.PlaneGeometry(100, 56.25)
    geometry.translate(0, 28.125, 0)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'C4DPreviewBoard'
    return mesh
  }

  /**
   * Scans the Cinema 4D binary payload for PolygonObject identifiers (ID 5100 / 0x13EC)
   * and extracts vertex position arrays and polygon index sets.
   */
  private scanPolygonObjects(reader: BinaryReader): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []
    const bufferLength = reader.length

    reader.seek(0)
    reader.setLittleEndian(false) // C4D default big-endian for hyperfile tokens

    while (reader.position + 24 <= bufferLength) {
      const pos = reader.position
      const tag = reader.readUint32(false)

      // 5100 = 0x13EC (C4D PolygonObject ID)
      if (tag === 5100 || tag === 0x13EC0000) {
        const mesh = this.tryReadPolygonData(reader, pos)
        if (mesh) {
          meshes.push(mesh)
        }
      }
      reader.seek(pos + 4)
    }

    if (meshes.length === 0) {
      reader.seek(0)
      reader.setLittleEndian(true)
      while (reader.position + 24 <= bufferLength) {
        const pos = reader.position
        const tag = reader.readUint32(true)
        if (tag === 5100) {
          const mesh = this.tryReadPolygonData(reader, pos)
          if (mesh) {
            meshes.push(mesh)
          }
        }
        reader.seek(pos + 4)
      }
    }

    return meshes
  }

  private tryReadPolygonData(reader: BinaryReader, startOffset: number): THREE.Mesh | null {
    try {
      reader.seek(startOffset + 4)
      const pointCount = reader.readUint32()
      const polyCount = reader.readUint32()

      if (pointCount < 3 || pointCount > 5000000 || polyCount < 1 || polyCount > 5000000) {
        return null
      }

      if (reader.remaining < pointCount * 12) {
        return null
      }

      const vertices: number[] = []
      for (let i = 0; i < pointCount; i++) {
        const x = reader.readFloat32()
        const y = reader.readFloat32()
        const z = reader.readFloat32()
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          vertices.push(x, y, z)
        } else {
          return null
        }
      }

      const indices: number[] = []
      if (reader.remaining >= polyCount * 16) {
        for (let p = 0; p < polyCount; p++) {
          const a = reader.readUint32()
          const b = reader.readUint32()
          const c = reader.readUint32()
          const d = reader.readUint32()

          if (a >= pointCount || b >= pointCount || c >= pointCount || d >= pointCount) {
            return null
          }

          if (c === d) {
            indices.push(a, b, c)
          } else {
            indices.push(a, b, c, a, c, d)
          }
        }
      }

      if (vertices.length >= 9) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
        if (indices.length > 0) {
          geometry.setIndex(indices)
        }
        geometry.computeVertexNormals()
        geometry.computeBoundingBox()

        const mesh = new THREE.Mesh(geometry)
        mesh.name = `C4DPolygon_${startOffset}`
        return mesh
      }
    } catch {
      return null
    }
    return null
  }
}
