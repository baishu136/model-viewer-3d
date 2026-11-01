import * as THREE from 'three'

/**
 * Pure TypeScript PMX 2.0 Exporter for static triangle meshes.
 * Generates standard compliant binary PMX 2.0 files compatible with MMD, PMXEditor, Blender, and Three.js MMDLoader.
 */
export class PMXExporter {
  parse(object: THREE.Object3D): Uint8Array {
    // 1. Collect all geometry meshes and extract baked vertices and triangle faces
    const positions: number[] = []
    const normals: number[] = []
    const uvs: number[] = []
    const indices: number[] = []

    object.updateWorldMatrix(true, true)
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      const geo = mesh.geometry as THREE.BufferGeometry
      const posAttr = geo.getAttribute('position')
      if (!posAttr) return

      const normAttr = geo.getAttribute('normal')
      const uvAttr = geo.getAttribute('uv')
      const indexAttr = geo.getIndex()

      const baseVertex = positions.length / 3

      // Extract vertices
      const v = new THREE.Vector3()
      const n = new THREE.Vector3()

      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i)
        v.applyMatrix4(mesh.matrixWorld)
        // MMD is left-handed (Z inverted)
        positions.push(v.x, v.y, -v.z)

        if (normAttr) {
          n.fromBufferAttribute(normAttr, i)
          n.transformDirection(mesh.matrixWorld)
          normals.push(n.x, n.y, -n.z)
        } else {
          normals.push(0, 1, 0)
        }

        if (uvAttr) {
          uvs.push(uvAttr.getX(i), uvAttr.getY(i))
        } else {
          uvs.push(0, 0)
        }
      }

      // Extract faces (triangles with inverted winding for left-handed coordinate system)
      if (indexAttr) {
        for (let i = 0; i < indexAttr.count; i += 3) {
          const a = baseVertex + indexAttr.getX(i)
          const b = baseVertex + indexAttr.getX(i + 1)
          const c = baseVertex + indexAttr.getX(i + 2)
          indices.push(a, c, b)
        }
      } else {
        for (let i = 0; i < posAttr.count; i += 3) {
          const a = baseVertex + i
          const b = baseVertex + i + 1
          const c = baseVertex + i + 2
          indices.push(a, c, b)
        }
      }
    })

    const vertexCount = positions.length / 3
    const indexCount = indices.length
    if (vertexCount === 0 || indexCount === 0) {
      throw new Error('当前模型没有有效的多边形网格可导出为 PMX。')
    }

    // Determine vertex index byte size (1, 2, or 4)
    const vertexIndexSize = vertexCount <= 255 ? 1 : vertexCount <= 65535 ? 2 : 4

    // Dynamic buffer sizing
    // Header (4+4+1+8 = 17) + Strings + Vertices + Faces + Material + Tables
    const encoder = new TextEncoder()
    const nameBytes = encoder.encode('ModelViewerExport')
    const commentBytes = encoder.encode('Exported from 3D Model Viewer')

    // Estimate capacity
    const estimatedSize =
      128 +
      nameBytes.length * 2 +
      commentBytes.length * 2 +
      vertexCount * (12 + 12 + 8 + 1 + 1 + 4) + // pos, norm, uv, deform, bone, edge
      indexCount * vertexIndexSize +
      256

    const buffer = new ArrayBuffer(estimatedSize + 1024)
    const view = new DataView(buffer)
    const u8 = new Uint8Array(buffer)
    let offset = 0

    // Magic: "PMX "
    u8[offset++] = 0x50 // P
    u8[offset++] = 0x4d // M
    u8[offset++] = 0x58 // X
    u8[offset++] = 0x20 // ' '

    // Version: 2.0 (float32)
    view.setFloat32(offset, 2.0, true)
    offset += 4

    // Globals count: 8
    u8[offset++] = 8

    // Globals:
    u8[offset++] = 1 // 0: Encode (1 = UTF-8)
    u8[offset++] = 0 // 1: Additional Vec4 count
    u8[offset++] = vertexIndexSize // 2: Vertex index size
    u8[offset++] = 1 // 3: Texture index size
    u8[offset++] = 1 // 4: Material index size
    u8[offset++] = 1 // 5: Bone index size
    u8[offset++] = 1 // 6: Morph index size
    u8[offset++] = 1 // 7: RigidBody index size

    // Helper to write text (int32 length + UTF-8 bytes)
    const writeText = (textBytes: Uint8Array) => {
      view.setInt32(offset, textBytes.length, true)
      offset += 4
      u8.set(textBytes, offset)
      offset += textBytes.length
    }

    // Model names & comments (Japanese & Universal)
    writeText(nameBytes)
    writeText(nameBytes)
    writeText(commentBytes)
    writeText(commentBytes)

    // Vertices
    view.setInt32(offset, vertexCount, true)
    offset += 4

    for (let i = 0; i < vertexCount; i++) {
      // Position
      view.setFloat32(offset, positions[i * 3], true)
      view.setFloat32(offset + 4, positions[i * 3 + 1], true)
      view.setFloat32(offset + 8, positions[i * 3 + 2], true)
      offset += 12

      // Normal
      view.setFloat32(offset, normals[i * 3], true)
      view.setFloat32(offset + 4, normals[i * 3 + 1], true)
      view.setFloat32(offset + 8, normals[i * 3 + 2], true)
      offset += 12

      // UV
      view.setFloat32(offset, uvs[i * 2], true)
      view.setFloat32(offset + 4, uvs[i * 2 + 1], true)
      offset += 8

      // Deform Type: 0 = BDEF1
      u8[offset++] = 0
      // Bone index (size 1) = 0
      u8[offset++] = 0
      // Edge scale = 1.0 (float32)
      view.setFloat32(offset, 1.0, true)
      offset += 4
    }

    // Faces (Indices)
    view.setInt32(offset, indexCount, true)
    offset += 4

    if (vertexIndexSize === 1) {
      for (let i = 0; i < indexCount; i++) {
        u8[offset++] = indices[i]
      }
    } else if (vertexIndexSize === 2) {
      for (let i = 0; i < indexCount; i++) {
        view.setUint16(offset, indices[i], true)
        offset += 2
      }
    } else {
      for (let i = 0; i < indexCount; i++) {
        view.setUint32(offset, indices[i], true)
        offset += 4
      }
    }

    // Textures: 0
    view.setInt32(offset, 0, true)
    offset += 4

    // Materials: 1 standard white material
    view.setInt32(offset, 1, true)
    offset += 4

    const matName = encoder.encode('WhiteMaterial')
    writeText(matName)
    writeText(matName)

    // Diffuse RGBA (float4)
    view.setFloat32(offset, 1.0, true)
    view.setFloat32(offset + 4, 1.0, true)
    view.setFloat32(offset + 8, 1.0, true)
    view.setFloat32(offset + 12, 1.0, true)
    offset += 16

    // Specular RGB (float3)
    view.setFloat32(offset, 0.1, true)
    view.setFloat32(offset + 4, 0.1, true)
    view.setFloat32(offset + 8, 0.1, true)
    offset += 12

    // Specular Power (float)
    view.setFloat32(offset, 5.0, true)
    offset += 4

    // Ambient RGB (float3)
    view.setFloat32(offset, 0.5, true)
    view.setFloat32(offset + 4, 0.5, true)
    view.setFloat32(offset + 8, 0.5, true)
    offset += 12

    // BitFlag (1 byte): 0x01 = DoubleSide rendering
    u8[offset++] = 0x01

    // Edge Color RGBA (float4)
    view.setFloat32(offset, 0.0, true)
    view.setFloat32(offset + 4, 0.0, true)
    view.setFloat32(offset + 8, 0.0, true)
    view.setFloat32(offset + 12, 1.0, true)
    offset += 16

    // Edge Size (float)
    view.setFloat32(offset, 1.0, true)
    offset += 4

    // Texture Index (1 byte) = -1
    u8[offset++] = 0xff
    // Sphere Texture Index (1 byte) = -1
    u8[offset++] = 0xff
    // Sphere Mode (1 byte) = 0
    u8[offset++] = 0
    // Shared Toon Flag (1 byte) = 1
    u8[offset++] = 1
    // Toon Index (1 byte) = 0
    u8[offset++] = 0

    // Memo text
    writeText(commentBytes)

    // Face count for this material (all faces)
    view.setInt32(offset, indexCount, true)
    offset += 4

    // BDEF1 vertices reference bone 0, so a real root bone must exist for skinning.
    view.setInt32(offset, 1, true)
    offset += 4
    const rootName = encoder.encode('Root')
    writeText(rootName)
    writeText(rootName)
    for (let i = 0; i < 3; i++) { view.setFloat32(offset, 0, true); offset += 4 }
    u8[offset++] = 0xff // parent = -1
    view.setInt32(offset, 0, true); offset += 4 // transform layer
    view.setUint16(offset, 0x001a, true); offset += 2 // rotatable, visible, enabled; offset tail
    for (const value of [0, 1, 0]) { view.setFloat32(offset, value, true); offset += 4 }

    // Morphs: 0
    view.setInt32(offset, 0, true)
    offset += 4

    // Display Frames: 0
    view.setInt32(offset, 0, true)
    offset += 4

    // Rigid Bodies: 0
    view.setInt32(offset, 0, true)
    offset += 4

    // Joints: 0
    view.setInt32(offset, 0, true)
    offset += 4

    return u8.subarray(0, offset)
  }
}
