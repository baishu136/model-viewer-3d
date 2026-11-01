import * as THREE from 'three'

/** VRM 0 primitives often share a full-avatar accessor but reference only a small vertex subset. */
export function compactSceneGeometry(root: THREE.Object3D): void {
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const source = mesh.geometry
    const cached = geometries.get(source)
    if (cached) { mesh.geometry = cached; return }
    const index = source.getIndex(), position = source.getAttribute('position')
    if (!index || !position) return
    const remap = new Map<number, number>(), packedIndices: number[] = []
    for (let i = 0; i < index.count; i++) {
      const oldIndex = index.getX(i)
      if (oldIndex >= position.count || oldIndex < 0) throw new Error('VRM 面索引超出顶点范围。')
      if (!remap.has(oldIndex)) remap.set(oldIndex, remap.size)
      packedIndices.push(remap.get(oldIndex)!)
    }
    if (remap.size === position.count) { geometries.set(source, source); return }
    const compact = source.clone()
    const pack = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute => {
      const ArrayType = attribute.array.constructor as new (length: number) => THREE.TypedArray
      const target = new THREE.BufferAttribute(new ArrayType(remap.size * attribute.itemSize), attribute.itemSize, attribute.normalized)
      for (const [from, to] of remap) for (let c = 0; c < attribute.itemSize; c++) target.setComponent(to, c, attribute.getComponent(from, c))
      return target
    }
    for (const [name, attribute] of Object.entries(source.attributes)) compact.setAttribute(name, pack(attribute))
    for (const [name, attributes] of Object.entries(source.morphAttributes)) compact.morphAttributes[name] = attributes.map(pack)
    compact.setIndex(packedIndices)
    compact.boundingBox = null; compact.boundingSphere = null
    geometries.set(source, compact)
    mesh.geometry = compact
  })
  for (const [source, compact] of geometries) if (source !== compact) source.dispose()
}
