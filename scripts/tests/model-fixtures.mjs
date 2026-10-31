import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

/** Tiny, reproducible fixtures; no downloaded models or DCC software required. */
export async function createModelFixtures(root) {
  const dir = path.join(root, 'testdata', 'compatibility')
  fs.mkdirSync(dir, { recursive: true })
  const views = [], accessors = [], chunks = []
  let offset = 0
  const add = (values, type, componentType = 5126, min, max) => {
    const array = componentType === 5123 ? new Uint16Array(values) : new Float32Array(values)
    const bytes = Buffer.from(array.buffer)
    const view = views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1
    chunks.push(bytes)
    const padding = (4 - bytes.length % 4) % 4
    if (padding) chunks.push(Buffer.alloc(padding))
    offset += bytes.length + padding
    const count = values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type])
    return accessors.push({ bufferView: view, componentType, count, type, ...(min ? { min, max } : {}) }) - 1
  }
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  const pos = add(positions, 'VEC3', 5126, [0, 0, 0], [1, 1, 0])
  const indices = add([0, 1, 2], 'SCALAR', 5123)
  const joints = add(new Array(12).fill(0), 'VEC4', 5123)
  const weights = add([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 'VEC4')
  const inverse = add([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'MAT4')
  const times = add([0, 2], 'SCALAR', 5126, [0], [2])
  const translation = add([0, 0, 0, 2, 0, 0], 'VEC3')
  const scale = add([1, 1, 1, 2, 2, 2], 'VEC3')
  const rotation = add([0, 0, 0, 1, 0, 0, 1, 0], 'VEC4')
  const morph = add([0, 0, 0, 0, 0, 0, 0, 1, 0], 'VEC3', 5126, [0, 0, 0], [0, 1, 0])
  const morphWeights = add([0, 1], 'SCALAR')
  const bin = Buffer.concat(chunks)
  const json = {
    asset: { version: '2.0', generator: 'model-viewer-3d regression fixture' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'FixtureRoot', translation: [3, 0, 0], children: [1, 2, 3, 4] },
      { name: 'AnimatedMesh', mesh: 0, skin: 0 },
      { name: 'AnimatedBone' },
      { name: 'IgnoredLight', extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: 'IgnoredCamera', camera: 0 }
    ],
    meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: pos, JOINTS_0: joints, WEIGHTS_0: weights }, indices, material: 0, targets: [{ POSITION: morph }] }] }],
    skins: [{ joints: [2], skeleton: 2, inverseBindMatrices: inverse }],
    animations: [
      { name: '骨骼与形态', samplers: [{ input: times, output: translation }, { input: times, output: morphWeights }], channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }, { sampler: 1, target: { node: 1, path: 'weights' } }] },
      { name: '旋转与缩放', samplers: [{ input: times, output: scale }, { input: times, output: rotation }], channels: [{ sampler: 0, target: { node: 0, path: 'scale' } }, { sampler: 1, target: { node: 0, path: 'rotation' } }] }
    ],
    // Missing files and invalid external URLs must never be requested by a white-model viewer.
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0, 0, 0.2] } }],
    textures: [{ source: 0 }], images: [{ uri: 'https://textures.invalid/do-not-load.png' }],
    cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.01 } }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: 9999 }] } },
    buffers: [{ byteLength: bin.length }], bufferViews: views, accessors
  }
  const writeGlb = (name, asset, binary) => {
    const jsonBytes = Buffer.from(JSON.stringify(asset))
    const jsonPad = Buffer.alloc((4 - jsonBytes.length % 4) % 4, 32)
    const body = Buffer.concat([jsonBytes, jsonPad])
    const binBody = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)])
    const header = Buffer.alloc(20)
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
    header.writeUInt32LE(28 + body.length + binBody.length, 8)
    header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binBody.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
    fs.writeFileSync(path.join(dir, name), Buffer.concat([header, body, binHeader, binBody]))
  }
  writeGlb('animated.glb', json, bin)
  // Check relative paths, escaped characters, Chinese filenames and parent-directory buffers.
  const nested = path.join(dir, '模型 空格 %')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(dir, '动画 数据.bin'), bin)
  const external = structuredClone(json)
  external.buffers[0].uri = '../' + encodeURIComponent('动画 数据.bin')
  fs.writeFileSync(path.join(nested, 'animated.gltf'), JSON.stringify(external))
  const embedded = structuredClone(json)
  embedded.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`
  fs.writeFileSync(path.join(dir, 'embedded.gltf'), JSON.stringify(embedded))

  const plyHeader = (format, faces = true) => `ply\nformat ${format} 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n${faces ? 'element face 1\nproperty list uchar int vertex_indices\n' : ''}end_header\n`
  fs.writeFileSync(path.join(dir, 'triangle.ply'), plyHeader('ascii') + '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')
  fs.writeFileSync(path.join(dir, 'points.ply'), plyHeader('ascii', false) + '0 0 0\n1 0 0\n0 1 0\n')
  for (const little of [true, false]) {
    const vertexBytes = Buffer.alloc(36), faceBytes = Buffer.alloc(13)
    positions.forEach((value, i) => little ? vertexBytes.writeFloatLE(value, i * 4) : vertexBytes.writeFloatBE(value, i * 4))
    faceBytes[0] = 3
    for (let i = 0; i < 3; i++) little ? faceBytes.writeInt32LE(i, 1 + i * 4) : faceBytes.writeInt32BE(i, 1 + i * 4)
    fs.writeFileSync(path.join(dir, `triangle-${little ? 'le' : 'be'}.ply`), Buffer.concat([Buffer.from(plyHeader(`binary_${little ? 'little' : 'big'}_endian`)), vertexBytes, faceBytes]))
  }
  fs.writeFileSync(path.join(dir, 'triangle-face-uv.ply'), plyHeader('ascii').replace('end_header', 'property list uchar float texcoord\nend_header') + '0 0 0\n1 0 0\n0 1 0\n3 0 1 2 6 0 0 1 0 0 1\n')

  const fbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tProperties70:  {
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::MovingTriangle", "Mesh" {
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t}
\tModel: 3, "Model::IgnoredLight", "Light" {
\t}
\tMaterial: 4, "Material::Ignored", "" {
\t\tShadingModel: "phong"
\t}
\tTexture: 5, "Texture::Ignored", "" {
\t\tFileName: "https://textures.invalid/never.png"
\t\tRelativeFilename: "missing.png"
\t}
\tAnimationCurveNode: 10, "AnimCurveNode::T", "" {
\t}
\tAnimationCurve: 11, "AnimCurve::X", "" {
\t\tKeyTime: *2 {
\t\t\ta: 0,92372316000
\t\t}
\t\tKeyValueFloat: *2 {
\t\t\ta: 0,2
\t\t}
\t}
\tAnimationLayer: 12, "AnimLayer::Base", "" {
\t}
\tAnimationStack: 13, "AnimStack::Move", "" {
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",2,0
\tC: "OO",3,0
\tC: "OO",4,2
\tC: "OP",5,4,"DiffuseColor"
\tC: "OP",10,2,"Lcl Translation"
\tC: "OP",11,10,"d|X"
\tC: "OO",10,12
\tC: "OO",12,13
}
`
  fs.writeFileSync(path.join(dir, 'animated.fbx'), fbx)

  // Encode a compressed GLB using Three.js's bundled encoder, only when running tests.
  const encoderPath = path.join(root, 'node_modules/three/examples/jsm/libs/draco/gltf/draco_encoder.js')
  const encoderModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(encoderPath, 'utf8'), {
    module: encoderModule, exports: encoderModule.exports, require: createRequire(import.meta.url),
    __dirname: path.dirname(encoderPath), process: { ...process, on: () => {} }, console, Buffer, WebAssembly, setTimeout, clearTimeout
  }, { filename: encoderPath })
  // Older Emscripten modules are thenables that resolve to themselves. Wrap the module.
  const { draco } = await new Promise((resolve) => {
    encoderModule.exports({ onModuleLoaded: (draco) => resolve({ draco }) })
  })
  const mesh = new draco.Mesh(), builder = new draco.MeshBuilder(), encoder = new draco.Encoder()
  const attributeId = builder.AddFloatAttributeToMesh(mesh, draco.POSITION, 3, 3, new Float32Array(positions))
  builder.AddFacesToMesh(mesh, 1, new Uint32Array([0, 1, 2]))
  const encoded = new draco.DracoInt8Array()
  const length = encoder.EncodeMeshToDracoBuffer(mesh, encoded)
  const compressed = Buffer.alloc(length)
  for (let i = 0; i < length; i++) compressed[i] = encoded.GetValue(i)
  const compressedJson = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: attributeId } } } }] }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { componentType: 5123, count: 3, type: 'SCALAR' }],
    buffers: [{ byteLength: compressed.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: compressed.length }],
    extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression']
  }
  writeGlb('compressed.glb', compressedJson, compressed)
  for (const obj of [encoded, encoder, builder, mesh]) draco.destroy(obj)
  return dir
}
