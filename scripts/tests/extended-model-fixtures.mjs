import fs from 'node:fs'
import path from 'node:path'

/** Small adversarial assets for formats previously missing from the compatibility suite. */
export function createExtendedModelFixtures(dir) {
  const base = fs.readFileSync(path.join(dir, 'animated.glb'))
  const jsonLength = base.readUInt32LE(12), json = JSON.parse(base.subarray(20, 20 + jsonLength).toString())
  const binary = base.subarray(20 + jsonLength)
  const writeVrm = (name, version) => {
    const asset = structuredClone(json)
    asset.extensions = version === '0' ? { VRM: { specVersion: '0.0', meta: { title: 'Test avatar' }, humanoid: { humanBones: [] } } }
      : { VRMC_vrm: { specVersion: version, meta: { name: 'Test avatar', authors: ['Test'] }, humanoid: { humanBones: {} } } }
    asset.extensionsUsed = version === '0' ? ['VRM'] : ['VRMC_vrm']
    const payload = Buffer.from(JSON.stringify(asset)), padded = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 32)])
    const header = Buffer.alloc(20)
    header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + binary.length, 8)
    header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
    fs.writeFileSync(path.join(dir, name), Buffer.concat([header, padded, binary]))
  }
  writeVrm('avatar-0.vrm', '0'); writeVrm('avatar-1.vrm', '1.0'); writeVrm('unsupported.vrm', '2.0')
  // Shared accessor contains an unused outlier, normalised skin weights and a morph target.
  const sharedData = Buffer.alloc(136)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0, 1e6, 1e6, 1e6].forEach((v, i) => sharedData.writeFloatLE(v, i * 4))
  ;[0, 1, 2].forEach((v, i) => sharedData.writeUInt16LE(v, 48 + i * 2))
  for (let i = 0; i < 4; i++) sharedData[72 + i * 4] = 255
  sharedData.writeFloatLE(0.25, 96)
  const sharedJson = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0, skin: 0 }, { name: 'RootBone' }],
    skins: [{ joints: [1] }], meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1, targets: [{ POSITION: 4 }] }], weights: [1] }],
    buffers: [{ byteLength: 136 }], bufferViews: [[0, 48], [48, 6], [56, 16], [72, 16], [88, 48]].map(([byteOffset, byteLength]) => ({ buffer: 0, byteOffset, byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1e6, 1e6, 1e6] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5121, count: 4, type: 'VEC4' },
      { bufferView: 3, componentType: 5121, count: 4, type: 'VEC4', normalized: true },
      { bufferView: 4, componentType: 5126, count: 4, type: 'VEC3' }
    ], extensionsUsed: ['VRM'], extensions: { VRM: { specVersion: '0.0' } }
  }
  const sharedText = Buffer.from(JSON.stringify(sharedJson)), sharedPadded = Buffer.concat([sharedText, Buffer.alloc((4 - sharedText.length % 4) % 4, 32)])
  const sharedHeader = Buffer.alloc(20), binHeader = Buffer.alloc(8)
  sharedHeader.writeUInt32LE(0x46546c67); sharedHeader.writeUInt32LE(2, 4); sharedHeader.writeUInt32LE(28 + sharedPadded.length + sharedData.length, 8)
  sharedHeader.writeUInt32LE(sharedPadded.length, 12); sharedHeader.writeUInt32LE(0x4e4f534a, 16)
  binHeader.writeUInt32LE(sharedData.length); binHeader.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(path.join(dir, 'shared-vertices.vrm'), Buffer.concat([sharedHeader, sharedPadded, binHeader, sharedData]))
  fs.copyFileSync(path.join(dir, 'animated.glb'), path.join(dir, 'not-an-avatar.vrm'))
  fs.copyFileSync(path.join(dir, 'triangle.blend'), path.join(dir, 'triangle.blender'))
  fs.writeFileSync(path.join(dir, 'document.md'), '# Test document\n3D model viewer')
  fs.writeFileSync(path.join(dir, 'empty.obj'), '# This document contains no geometry\n')

  const u8 = (v) => Buffer.from([v]), u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
  const f32 = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b }
  const str = (text, size) => { const b = Buffer.alloc(size); b.write(text); return b }
  const pmd = [Buffer.from('Pmd'), f32([1]), str('Triangle', 20), str('Regression fixture', 256), u32(3)]
  for (const p of [[0, 0, 0], [10, 0, 0], [0, 10, 0]]) pmd.push(f32([...p, 0, 0, 1, 0, 0]), u16(0), u16(0), u8(100), u8(0))
  pmd.push(u32(3), u16(0), u16(1), u16(2), u32(1), f32([1, 1, 1, 1, 0, 0, 0, 0, 0.5, 0.5, 0.5]), u8(255), u8(0), u32(3), str('missing.png', 20))
  pmd.push(u16(1), str('Root', 20), u16(65535), u16(0), u8(0), u16(0), f32([0, 0, 0]))
  pmd.push(u16(0), u16(0), u8(0), u8(0), u32(0), u8(0), Buffer.alloc(1000), u32(0), u32(0))
  fs.writeFileSync(path.join(dir, 'triangle.pmd'), Buffer.concat(pmd))

  // Nested C4D transforms: the child is at Z=5 below a parent at Z=20.
  const c4d = Buffer.from(fs.readFileSync(path.join(dir, 'triangle.c4d')))
  const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b }
  const be64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b }
  const begin = (id) => Buffer.concat([u8(1), be32(id), be32(0)])
  const vector = (x, y, z) => Buffer.concat([u8(0x17), be64(x), be64(y), be64(z)])
  const location = c4d.indexOf(vector(0, 0, 0))
  c4d.writeDoubleBE(5, location + 17)
  const parent = Buffer.concat([begin(0xf4683), begin(0x1adf0), u8(0x0f), be32(5140), u8(2),
    begin(0x1ade4), vector(0, 0, 20), vector(1, 1, 1), vector(0, 0, 0), u8(2)])
  fs.writeFileSync(path.join(dir, 'nested.c4d'), Buffer.concat([c4d.subarray(0, 22), parent, c4d.subarray(22, -1), u8(2), u8(2)]))

  const points = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [2, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]]
  // Edges deliberately differ from vertex order and include reverse-oriented edges.
  const edges = [[2, 1], [3, 4], [0, 1], [5, 4], [2, 3], [6, 7], [6, 5], [0, 7]]
  fs.writeFileSync(path.join(dir, 'hierarchy-concave.ma'), `// Maya ASCII fixture\ncurrentUnit -linear millimeter -angle degree;
createNode transform -name "Parent";
setAttr ".translate" -type "double3" 100 0 0;
setAttr ".rotate" -type "double3" 0 0 90;
createNode transform -name "Child" -parent "Parent";
setAttr ".translate" -type "double3" 10 0 0;
createNode mesh -name "Shape" -parent "Child";
setAttr ".vrts[4:7]" ${points.slice(4).flat().join(' ')};
setAttr ".vrts[0:3]" ${points.slice(0, 4).flat().join(' ')};
setAttr ".edge[0:7]" ${edges.map((e) => [...e, 1]).flat().join(' ')};
setAttr ".face[0]" -type "polyFaces" f 8 2 -1 4 1 -4 -7 5 -8;
createNode transform -name "Unrelated";
setAttr ".translate" -type "double3" 99999 0 0;
`)
}
