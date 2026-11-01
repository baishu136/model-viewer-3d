import * as THREE from 'three'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { Parser } from 'three/examples/jsm/libs/mmdparser.module.js'

export function isMmdModel(buffer: ArrayBuffer): boolean {
  const signature = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)))
  return signature.startsWith('Pmd') || signature === 'PMX '
}

/** Use the bundled MMD parser/builder, retaining skin/morph data without loading source textures. */
export function parseMmdModel(buffer: ArrayBuffer, manager: THREE.LoadingManager, makeMaterial: () => THREE.Material): THREE.SkinnedMesh {
  if (!isMmdModel(buffer)) throw new Error('无效的 PMX/PMD 文件：文件头无法识别。')
  const parser = new Parser()
  const isPmd = new Uint8Array(buffer)[0] === 0x50 && new Uint8Array(buffer)[1] === 0x6d
  const data = isPmd ? parser.parsePmd(buffer, true) : parser.parsePmx(buffer, true)
  // The builder is exposed by the pinned Three.js MMDLoader. Fail explicitly if its API changes.
  const builder = new MMDLoader(manager).meshBuilder as {
    materialBuilder: { build: (data: { materials: unknown[] }) => THREE.Material[] }
    build: (data: unknown, resourcePath: string) => THREE.SkinnedMesh
  }
  if (!builder.materialBuilder || typeof builder.build !== 'function') throw new Error('MMD 加载器版本不兼容，请检查适配器。')
  builder.materialBuilder.build = (model) => model.materials.map(() => makeMaterial())
  return builder.build(data, '')
}
