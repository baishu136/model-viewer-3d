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

  // 1. Minimal Maya ASCII fixture (.ma)
  const maContent = `//Maya ASCII 2024 scene
//Name: triangle.ma
currentUnit -l centimeter -a degree -t film;
createNode transform -n "pTriangle1";
createNode mesh -n "pTriangleShape1" -p "pTriangle1";
\tsetAttr -k off ".v";
\tsetAttr ".vir" yes;
\tsetAttr ".vif" yes;
\tsetAttr ".vt[0:2]" -type "float3" 0 0 0 10 0 0 0 10 0;
\tsetAttr ".fc[0]" -type "polyFaces" f 3 0 1 2;
`
  fs.writeFileSync(path.join(dir, 'triangle.ma'), maContent)

  // 2. Minimal Maya Binary fixture (.mb)
  const mbParts = []
  const appendIffChunk = (tag, data) => {
    const pad = data.length % 2 !== 0 ? Buffer.alloc(1) : Buffer.alloc(0)
    const header = Buffer.alloc(8)
    header.write(tag, 0, 4, 'ascii')
    header.writeUInt32BE(data.length, 4)
    mbParts.push(header, data, pad)
  }

  // CREA chunk: node type mesh and shape name
  appendIffChunk('CREA', Buffer.from('mesh\0pTriangleShape1\0', 'ascii'))

  // ATTR chunk: .vt
  appendIffChunk('ATTR', Buffer.from('.vt\0', 'ascii'))

  // DBLK chunk: 3 vertex coordinates (9 float32s = 36 bytes)
  const dblkData = Buffer.alloc(36)
  const verts = [0, 0, 0, 10, 0, 0, 0, 10, 0]
  for (let i = 0; i < 9; i++) dblkData.writeFloatBE(verts[i], i * 4)
  appendIffChunk('DBLK', dblkData)

  const mbPayload = Buffer.concat([Buffer.from('Maya', 'ascii'), ...mbParts])
  const mbRoot = Buffer.alloc(8)
  mbRoot.write('FOR4', 0, 4, 'ascii')
  mbRoot.writeUInt32BE(mbPayload.length, 4)
  fs.writeFileSync(path.join(dir, 'triangle.mb'), Buffer.concat([mbRoot, mbPayload]))

  // 3. Minimal Cinema 4D fixture (.c4d)：真实的 HyperFile 标记流结构
  const buildC4DFixture = () => {
    const parts = []
    const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b }
    const i32be = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b }
    const f64be = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b }
    const start = (id) => parts.push(Buffer.from([0x01]), u32be(id), u32be(0))
    const end = () => parts.push(Buffer.from([0x02]))
    const intToken = (v) => parts.push(Buffer.from([0x0f]), i32be(v))
    const vecToken = (x, y, z) => parts.push(Buffer.from([0x17]), f64be(x), f64be(y), f64be(z))
    const blockToken = (marker, data) => parts.push(Buffer.from([0x8c]), u32be(data.length + 1), Buffer.from([marker]), data)
    const points = [[0, 0, 0], [10, 0, 0], [0, 10, 0]]
    const name = 'Triangle'
    const nameBuf = Buffer.alloc(name.length * 2)
    for (let i = 0; i < name.length; i++) nameBuf.writeUInt16BE(name.charCodeAt(i), i * 2)

    start(0x1adeb) // 文档块
    start(0xf4683) // BaseObject
    start(0x1adf0) // 对象头：类型 5100 = Opolygon
    intToken(5100)
    intToken(0)
    parts.push(Buffer.from([0x82]), u32be(nameBuf.length), nameBuf)
    end()
    start(0x1ade4) // 变换：位置 / 缩放 / HPB
    vecToken(0, 0, 0)
    vecToken(1, 1, 1)
    vecToken(0, 0, 0)
    end()
    start(0x1ae14) // 对象数据
    start(0x15e0) // Tpoint
    start(0x15e0)
    intToken(points.length)
    for (let axis = 0; axis < 3; axis++) {
      const data = Buffer.alloc(points.length * 8)
      for (let i = 0; i < points.length; i++) data.writeDoubleBE(points[i][axis], i * 8)
      blockToken(0x06, data)
    }
    end()
    end()
    start(0x15e4) // Tpolygon
    start(0x15e4)
    intToken(1)
    for (const corner of [0, 1, 2, 2]) blockToken(0x03, u32be(corner))
    end()
    end()
    end()
    end()
    end()

    const header = Buffer.concat([Buffer.from('QC4DC4D6', 'ascii'), u32be(0x00004a50), Buffer.from([0x00])])
    fs.writeFileSync(path.join(dir, 'triangle.c4d'), Buffer.concat([header, ...parts]))
  }
  buildC4DFixture()

  // 3c. Legacy FBX 6.x fixture：three.js FBXLoader 不支持，需要 Fbx6Loader
  const buildLegacyFbxFixture = () => {
    // EndOffset 是文件内的绝对偏移，因此需要带着当前写入位置递归构造
    const writeNode = (name, props, base, children = []) => {
      const nameBuf = Buffer.from(name, 'latin1')
      const propBuf = Buffer.concat(props)
      const headerSize = 13 + nameBuf.length + propBuf.length
      const built = []
      let cursor = base + headerSize
      for (const builder of children) {
        const buffer = builder(cursor)
        built.push(buffer)
        cursor += buffer.length
      }
      const end = cursor + 13 // EndOffset 指向结束的空记录之后
      const header = Buffer.alloc(13)
      header.writeUInt32LE(end, 0)
      header.writeUInt32LE(props.length, 4)
      header.writeUInt32LE(propBuf.length, 8)
      header.writeUInt8(nameBuf.length, 12)
      return Buffer.concat([header, nameBuf, propBuf, ...built, Buffer.alloc(13)])
    }
    const double = (v) => {
      const b = Buffer.alloc(9)
      b.write('D', 0, 'latin1')
      b.writeDoubleLE(v, 1)
      return b
    }
    const int = (v) => {
      const b = Buffer.alloc(5)
      b.write('I', 0, 'latin1')
      b.writeInt32LE(v, 1)
      return b
    }
    const string = (v) => {
      const data = Buffer.from(v, 'latin1')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(data.length, 0)
      return Buffer.concat([Buffer.from('S', 'latin1'), len, data])
    }

    const body = writeNode(
      'Objects',
      [],
      27,
      [
        (modelBase) =>
          writeNode(
            'Model',
            [string('Tri Model'), string('Mesh')],
            modelBase,
            [
              (base) =>
                writeNode('Properties60', [], base, [
                  (propertyBase) =>
                    writeNode(
                      'Property',
                      [string('Lcl Translation'), string('Vector3D'), string(''), double(0), double(0), double(0)],
                      propertyBase
                    )
                ]),
              (base) =>
                writeNode(
                  'Vertices',
                  [double(0), double(0), double(0), double(10), double(0), double(0), double(0), double(10), double(0)],
                  base
                ),
              (base) => writeNode('PolygonVertexIndex', [int(0), int(1), int(2)], base)
            ]
          ),
        (connectBase) =>
          writeNode(
            'Connect',
            [string('OO'), string('Tri Model'), string('Scene Model')],
            connectBase
          )
      ]
    )

    const header = Buffer.from('Kaydara FBX Binary    ', 'latin1')
    const version = Buffer.alloc(4)
    version.writeUInt32LE(6100, 0)
    fs.writeFileSync(path.join(dir, 'triangle-legacy.fbx'), Buffer.concat([header, version, body, Buffer.alloc(64)]))
  }
  buildLegacyFbxFixture()

  // 3b. Minimal 3ds Max fixture (.max)：真实 OLE 复合文档 + Scene 块结构
  const buildMaxFixture = () => {
    const CFB = createRequire(import.meta.url)('cfb')
    const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0); return b }
    const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
    const f32le = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b }
    const container = (id, payload) => Buffer.concat([u16le(id), u32le(0x80000000 | (payload.length + 6)), payload])
    const chunk = (id, payload) => Buffer.concat([u16le(id), u32le(payload.length + 6), payload])

    const vertexTable = Buffer.concat([u32le(3), f32le(0), f32le(0), f32le(0), f32le(10), f32le(0), f32le(0), f32le(0), f32le(10), f32le(0)])
    const faceTable = Buffer.concat([u32le(1), u32le(0), u32le(1), u32le(2), u32le(1), u32le(7)])
    const scene = container(0x2027, container(0x08fe, Buffer.concat([chunk(0x0914, vertexTable), chunk(0x0912, faceTable)])))

    const cfb = CFB.utils.cfb_new()
    CFB.utils.cfb_add(cfb, '/Scene', scene)
    fs.writeFileSync(path.join(dir, 'triangle.max'), Buffer.from(CFB.write(cfb, { type: 'buffer' })))
  }
  buildMaxFixture()

  // 4. Minimal Blender fixture (.blend)
  const buildBlendFixture = () => {
    const header = Buffer.from('BLENDER-v300', 'ascii')
    // SDNA definition
    const names = ['*next', '*prev', '*data', 'type', 'totvert', 'totpoly', 'totloop', '*mvert', '*mpoly', '*mloop', 'co[3]', 'loopstart', 'v', 'obmat[4][4]']
    const types = ['char', 'short', 'int', 'float', 'MVert', 'MPoly', 'MLoop', 'Mesh', 'Object']
    const tlens = [1, 2, 4, 4, 16, 16, 12, 64, 128]
    const structs = [
      // MVert (type=4, 1 field: co[3] (type=3, name=10))
      { type: 4, fields: [[3, 10]] },
      // MPoly (type=5, 2 fields: loopstart (type=2, name=11), totloop (type=2, name=6))
      { type: 5, fields: [[2, 11], [2, 6]] },
      // MLoop (type=6, 1 field: v (type=2, name=12))
      { type: 6, fields: [[2, 12]] },
      // Mesh (type=7, 6 fields: totvert (type=2, name=4), totpoly (type=2, name=5), totloop (type=2, name=6), *mvert (type=4, name=7), *mpoly (type=5, name=8), *mloop (type=6, name=9))
      { type: 7, fields: [[2, 4], [2, 5], [2, 6], [4, 7], [5, 8], [6, 9]] },
      // Object (type=8, 3 fields: type (type=1, name=3), *data (type=7, name=2), obmat[4][4] (type=3, name=13))
      { type: 8, fields: [[1, 3], [7, 2], [3, 13]] }
    ]

    const sdnaParts = [Buffer.from('SDNANAME', 'ascii')]
    const nameCountBuf = Buffer.alloc(4)
    nameCountBuf.writeUInt32LE(names.length, 0)
    sdnaParts.push(nameCountBuf)
    for (const n of names) sdnaParts.push(Buffer.from(n + '\0', 'ascii'))
    while (Buffer.concat(sdnaParts).length % 4 !== 0) sdnaParts.push(Buffer.from([0]))

    sdnaParts.push(Buffer.from('TYPE', 'ascii'))
    const typeCountBuf = Buffer.alloc(4)
    typeCountBuf.writeUInt32LE(types.length, 0)
    sdnaParts.push(typeCountBuf)
    for (const t of types) sdnaParts.push(Buffer.from(t + '\0', 'ascii'))
    while (Buffer.concat(sdnaParts).length % 4 !== 0) sdnaParts.push(Buffer.from([0]))

    sdnaParts.push(Buffer.from('TLEN', 'ascii'))
    const tlenBuf = Buffer.alloc(tlens.length * 2)
    for (let i = 0; i < tlens.length; i++) tlenBuf.writeUInt16LE(tlens[i], i * 2)
    sdnaParts.push(tlenBuf)
    while (Buffer.concat(sdnaParts).length % 4 !== 0) sdnaParts.push(Buffer.from([0]))

    sdnaParts.push(Buffer.from('STRC', 'ascii'))
    const structCountBuf = Buffer.alloc(4)
    structCountBuf.writeUInt32LE(structs.length, 0)
    sdnaParts.push(structCountBuf)
    for (const s of structs) {
      const sHdr = Buffer.alloc(4)
      sHdr.writeUInt16LE(s.type, 0)
      sHdr.writeUInt16LE(s.fields.length, 2)
      sdnaParts.push(sHdr)
      const fBuf = Buffer.alloc(s.fields.length * 4)
      for (let f = 0; f < s.fields.length; f++) {
        fBuf.writeUInt16LE(s.fields[f][0], f * 4)
        fBuf.writeUInt16LE(s.fields[f][1], f * 4 + 2)
      }
      sdnaParts.push(fBuf)
    }

    const dnaPayload = Buffer.concat(sdnaParts)

    // Helper to format a 64-bit BHead (24 bytes)
    const writeBHead = (code, size, oldAddr, sdnaIdx, count) => {
      const bhead = Buffer.alloc(24)
      bhead.write(code.padEnd(4, '\0'), 0, 4, 'ascii')
      bhead.writeUInt32LE(size, 4)
      bhead.writeBigUInt64LE(BigInt(oldAddr), 8)
      bhead.writeUInt32LE(sdnaIdx, 16)
      bhead.writeUInt32LE(count, 20)
      return bhead
    }

    const blendBlocks = []

    // 1. MVert data (3 vertices = 48 bytes)
    const mvertData = Buffer.alloc(48)
    for (let i = 0; i < 3; i++) {
      mvertData.writeFloatLE(positions[i * 3], i * 16)
      mvertData.writeFloatLE(positions[i * 3 + 1], i * 16 + 4)
      mvertData.writeFloatLE(positions[i * 3 + 2], i * 16 + 8)
    }
    blendBlocks.push(writeBHead('ME', 48, 0x1000, 0, 3), mvertData)

    // 2. MPoly data (1 poly = 16 bytes: loopstart=0, totloop=3)
    const mpolyData = Buffer.alloc(16)
    mpolyData.writeInt32LE(0, 0)
    mpolyData.writeInt32LE(3, 4)
    blendBlocks.push(writeBHead('ME', 16, 0x2000, 1, 1), mpolyData)

    // 3. MLoop data (3 loops = 36 bytes: v=0, v=1, v=2)
    const mloopData = Buffer.alloc(36)
    mloopData.writeInt32LE(0, 0)
    mloopData.writeInt32LE(1, 12)
    mloopData.writeInt32LE(2, 24)
    blendBlocks.push(writeBHead('ME', 36, 0x3000, 2, 3), mloopData)

    // 4. Mesh data (64 bytes)
    // Fields: totvert=3 (0), totpoly=1 (4), totloop=3 (8), *mvert=0x1000 (12), *mpoly=0x2000 (20), *mloop=0x3000 (28)
    const meshData = Buffer.alloc(64)
    meshData.writeInt32LE(3, 0)
    meshData.writeInt32LE(1, 4)
    meshData.writeInt32LE(3, 8)
    meshData.writeBigUInt64LE(0x1000n, 12)
    meshData.writeBigUInt64LE(0x2000n, 20)
    meshData.writeBigUInt64LE(0x3000n, 28)
    blendBlocks.push(writeBHead('ME', 64, 0x4000, 3, 1), meshData)

    // 5. Object data (128 bytes)
    // Fields: type=1 (0), *data=0x4000 (2), obmat (10)
    const objData = Buffer.alloc(128)
    objData.writeInt16LE(1, 0) // OB_MESH
    objData.writeBigUInt64LE(0x4000n, 2)
    // Identity matrix
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        objData.writeFloatLE(row === col ? 1.0 : 0.0, 10 + (row * 4 + col) * 4)
      }
    }
    blendBlocks.push(writeBHead('OB', 128, 0x5000, 4, 1), objData)

    // 6. DNA1 block
    blendBlocks.push(writeBHead('DNA1', dnaPayload.length, 0x9000, 0, 1), dnaPayload)

    // 7. ENDB block
    blendBlocks.push(writeBHead('ENDB', 0, 0, 0, 0))

    return Buffer.concat([header, ...blendBlocks])
  }
  fs.writeFileSync(path.join(dir, 'triangle.blend'), buildBlendFixture())

  return dir
}
