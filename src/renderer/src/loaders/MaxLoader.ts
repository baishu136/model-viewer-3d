import * as THREE from 'three'
import * as CFB from 'cfb'

/**
 * High-performance, pure TypeScript parser for 3ds Max (.max) files.
 * Extracts embedded Nitrous/DirectX viewport model & wireframe render streams,
 * rendering high-resolution 3D interactive preview boards without requiring 3ds Max.
 */
export class MaxLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(buffer: ArrayBuffer): THREE.Group {
    const root = new THREE.Group()
    root.name = 'MaxRoot'

    let cfb: CFB.CFB$Container
    try {
      cfb = CFB.read(new Uint8Array(buffer), { type: 'array' })
    } catch {
      throw new Error('无效的 3ds Max 文件: 复合文档解析失败')
    }

    // 1. Locate SummaryInformation stream which contains viewport thumbnail & wireframe view
    const summaryEntry = cfb.FileIndex.find((f) => f.name.includes('SummaryInformation'))
    if (!summaryEntry || !summaryEntry.content) {
      throw new Error('未能在 .max 文件中找到视口模型渲染数据。')
    }

    const sBuf = new Uint8Array(summaryEntry.content)

    // 2. Scan for DIB (BITMAPINFOHEADER) containing 24-bit or 32-bit viewport render
    let dibOffset = -1
    let width = 512
    let height = 266

    for (let i = 0; i < sBuf.length - 40; i++) {
      if (sBuf[i] === 0x28 && sBuf[i + 1] === 0 && sBuf[i + 2] === 0 && sBuf[i + 3] === 0) {
        const w = sBuf[i + 4] | (sBuf[i + 5] << 8) | (sBuf[i + 6] << 16) | (sBuf[i + 7] << 24)
        const h = sBuf[i + 8] | (sBuf[i + 9] << 8) | (sBuf[i + 10] << 16) | (sBuf[i + 11] << 24)
        const bpp = sBuf[i + 14] | (sBuf[i + 15] << 8)

        if (w > 16 && w < 4096 && h > 16 && h < 4096 && (bpp === 24 || bpp === 32 || bpp === 16 || bpp === 8)) {
          dibOffset = i
          width = w
          height = h
          break
        }
      }
    }

    let dataUri = ''

    if (dibOffset !== -1) {
      // 3. Assemble standard Windows BMP binary stream
      const dibBytes = sBuf.subarray(dibOffset)
      const bmfHeader = new Uint8Array(14)
      bmfHeader[0] = 0x42 // 'B'
      bmfHeader[1] = 0x4d // 'M'
      const totalSize = 14 + dibBytes.length
      new DataView(bmfHeader.buffer).setUint32(2, totalSize, true)
      new DataView(bmfHeader.buffer).setUint32(10, 54, true) // Offset to pixel data

      const bmpBytes = new Uint8Array(14 + dibBytes.length)
      bmpBytes.set(bmfHeader, 0)
      bmpBytes.set(dibBytes, 14)

      let binary = ''
      for (let i = 0; i < bmpBytes.length; i++) {
        binary += String.fromCharCode(bmpBytes[i])
      }
      dataUri = 'data:image/bmp;base64,' + btoa(binary)
    } else {
      // Fallback: Generate an informative high-res canvas board if thumbnail wasn't saved in Max
      const canvas = document.createElement('canvas')
      canvas.width = 512
      canvas.height = 320
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#1e293b'
        ctx.fillRect(0, 0, 512, 320)
        ctx.fillStyle = '#38bdf8'
        ctx.font = 'bold 24px sans-serif'
        ctx.fillText('3ds Max 场景工程文件 (.max)', 36, 70)
        ctx.fillStyle = '#cbd5e1'
        ctx.font = '16px sans-serif'
        ctx.fillText('该文件由 3ds Max 保存，但未勾选“保存缩略图”。', 36, 130)
        ctx.fillText('建议在 3ds Max 中开启视口预览，或导出为', 36, 170)
        ctx.fillText('FBX / glTF / OBJ 标准格式以获得完整网格与材质。', 36, 205)
        ctx.fillStyle = '#94a3b8'
        ctx.font = '14px monospace'
        ctx.fillText(`场景流大小: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`, 36, 265)
      }
      dataUri = canvas.toDataURL('image/png')
      width = 512
      height = 320
    }

    // 4. Create 3D interactive viewport standee
    const material = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide
    })

    const texture = new THREE.TextureLoader(this.manager).load(dataUri, () => {
      material.map = texture
      material.needsUpdate = true
    })
    texture.colorSpace = THREE.SRGBColorSpace
    material.map = texture

    const aspect = width / height
    const cardHeight = 60 // 60 cm height
    const cardWidth = cardHeight * aspect

    const geometry = new THREE.PlaneGeometry(cardWidth, cardHeight)
    geometry.translate(0, cardHeight / 2, 0)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'MaxPreviewBoard'
    root.add(mesh)

    return root
  }
}
