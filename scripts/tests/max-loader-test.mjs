import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { transformSync } from '@swc/core'
import * as THREE from 'three'

const CFB = createRequire(import.meta.url)('cfb')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const temp = fs.mkdtempSync(path.join(root, '.tmp-max-tests-'))
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const floats = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b }
const chunk = (id, data) => Buffer.concat([u16(id), u32(data.length + 6), data])
const container = (id, children) => Buffer.concat([u16(id), u32((children.length + 6) | 0x80000000), children])
const pack = (items) => {
  const file = CFB.utils.cfb_new()
  CFB.utils.cfb_add(file, '/Scene', container(0x2027, Buffer.concat(items)))
  const bytes = Buffer.from(CFB.write(file, { type: 'buffer' }))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
const triangle = [[0, 0, 0], [2, 0, 0], [0, 2, 0]]
const mesh = (points = triangle) => container(0x100, container(0x08fe, Buffer.concat([
  chunk(0x0914, Buffer.concat([u32(points.length), floats(points.flat())])),
  chunk(0x0912, Buffer.concat([u32(1), ...[0, 1, 2, 0, 7].map(u32)]))
])))
const poly = (points, faces) => container(0x100, container(0x08fe, Buffer.concat([
  chunk(0x0100, Buffer.concat([u32(points.length), ...points.map((p) => p ? Buffer.concat([u32(0), floats(p)]) : u32(2))])),
  chunk(0x011a, Buffer.concat([u32(faces.length), ...faces.map((f) => Buffer.concat([
    u32(f.vertices.length), ...f.vertices.map(u32), u16(1), u32(f.dead ? 2 : 0)
  ]))]))
])))
function sceneBuilder() {
  const items = []
  const add = (item) => items.push(item) - 1
  const value = (v) => add(container(0x100, chunk(0x2505, floats(v))))
  const node = (name, object, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], parent = -1,
    offset = [0, 0, 0], offsetRotation = [0, 0, 0, 1], offsetScale = [1, 1, 1, 0, 0, 0, 1] } = {}) => {
    const refs = [value(position), value(rotation), value(scale)]
    const prs = add(container(0x100, chunk(0x2034, Buffer.concat(refs.map(u32)))))
    return add(container(0x100, Buffer.concat([
      chunk(0x0962, Buffer.from(name + '\0', 'utf16le')),
      chunk(0x0960, Buffer.concat([u32(parent), u32(0)])),
      chunk(0x2035, Buffer.concat([u32(2), u32(0), u32(prs), u32(1), u32(object)])),
      chunk(0x096a, floats(offset)), chunk(0x096b, floats(offsetRotation)), chunk(0x096c, floats(offsetScale))
    ])))
  }
  return { items, add, node }
}
const near = (actual, expected, message = '') => {
  assert.equal(actual.length, expected.length)
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-4, `${message}: ${actual} != ${expected}`))
}
const firstPoint = (mesh) => Array.from(mesh.geometry.attributes.position.array).slice(0, 3)
let passed = 0
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`) }

try {
  const loaderDir = path.join(root, 'src/renderer/src/loaders')
  for (const [source, output] of [['utils/compound-file.ts', 'compound-file.mjs'], ['MaxLoader.ts', 'MaxLoader.mjs']]) {
    const code = fs.readFileSync(path.join(loaderDir, source), 'utf8').replace("'./utils/compound-file'", "'./compound-file.mjs'")
    fs.writeFileSync(path.join(temp, output), transformSync(code, { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'es6' } }).code)
  }
  const { MaxLoader } = await import(pathToFileURL(path.join(temp, 'MaxLoader.mjs')).href)
  const loader = new MaxLoader()
  check('preserves explicit placement even when node transforms spread objects apart', () => {
    const s = sceneBuilder(), a = s.add(mesh()), b = s.add(mesh(triangle.map(([x, y, z]) => [x + 100, y, z])))
    s.node('A', a, { position: [1000, 0, 0] }); s.node('B', b, { position: [2000, 0, 0] })
    const model = loader.parse(pack(s.items))
    near(firstPoint(model.children[0]), [1000, 0, 0]); near(firstPoint(model.children[1]), [2100, 0, 0])
  })
  check('retains all shared-mesh instances without accumulating transforms', () => {
    const s = sceneBuilder(), shared = s.add(mesh())
    s.node('A', shared, { position: [10, 20, 30] }); s.node('B', shared, { position: [-10, -20, -30] })
    const model = loader.parse(pack(s.items))
    assert.equal(model.children.length, 2)
    near(firstPoint(model.children[0]), [10, 30, -20]); near(firstPoint(model.children[1]), [-10, -30, 20])
  })
  check('applies object pivot offsets without inheriting them into child nodes', () => {
    const s = sceneBuilder(), shared = s.add(mesh())
    const parent = s.node('Parent', shared, { position: [100, 0, 0], offset: [50, 0, 0] })
    s.node('Child', shared, { parent, position: [5, 0, 0] })
    const model = loader.parse(pack(s.items))
    near(firstPoint(model.children[0]), [150, 0, 0]); near(firstPoint(model.children[1]), [105, 0, 0])
  })
  check('rotates a pivot offset in the node coordinate system', () => {
    const s = sceneBuilder(), shared = s.add(mesh())
    s.node('Rotated', shared, { position: [10, 0, 0], rotation: [0, 0, Math.PI / 2], offset: [3, 0, 0] })
    near(firstPoint(loader.parse(pack(s.items)).children[0]), [10, 0, -3])
  })
  check('supports quaternion rotation controllers and oriented scale values', () => {
    const s = sceneBuilder(), shared = s.add(mesh([[1, 0, 0], [2, 0, 0], [1, 1, 0]])), q = Math.SQRT1_2
    s.node('Quaternion', shared, { rotation: [0, 0, -q, q] })
    s.node('ScaleAxis', shared, { scale: [2, 1, 1, 0, 0, -Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] })
    const model = loader.parse(pack(s.items))
    near(firstPoint(model.children[0]), [0, 0, -1]); near(firstPoint(model.children[1]), [1.5, 0, -0.5])
  })
  check('preserves actual zero scales and outward normals of mirrored instances', () => {
    const s = sceneBuilder(), shared = s.add(mesh())
    s.node('Zero', shared, { scale: [0, 1, 1] }); s.node('Mirrored', shared, { scale: [-1, 1, 1] })
    const model = loader.parse(pack(s.items))
    assert.equal(model.children[0].geometry.boundingBox.max.x, 0)
    const normals = model.children[1].geometry.attributes.normal
    for (let i = 0; i < normals.count; i++) near([normals.getX(i), normals.getY(i), normals.getZ(i)], [0, 1, 0])
  })
  check('triangulates a concave polygon without filling its cutout, in both windings', () => {
    const points = [[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [2, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]]
    for (const reverse of [false, true]) {
      const vertices = points.map((_, i) => i); if (reverse) vertices.reverse()
      const model = loader.parse(pack([poly(points, [{ vertices }])]))
      const g = model.children[0].geometry, p = g.attributes.position
      let area = 0
      for (let i = 0; i < g.index.count; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, g.index.getX(i + k)))
        const cross = b.clone().sub(a).cross(c.clone().sub(a))
        assert.ok(reverse ? cross.y < 0 : cross.y > 0)
        area += cross.length() / 2
        const center = a.clone().add(b).add(c).divideScalar(3)
        assert.ok(!(center.x > 1 && center.x < 2 && -center.z > 1), 'triangle enters cutout')
      }
      near([area], [7])
    }
  })
  check('ignores deleted faces, dead vertices and unused outlier vertices', () => {
    const model = loader.parse(pack([poly([[10, 10, 10], [12, 10, 10], [10, 12, 10], null, [1e9, 1e9, 1e9]], [
      { vertices: [0, 1, 2] }, { vertices: [0, 1, 4], dead: true }, { vertices: [0, 1, 3] }
    ])]))
    const g = model.children[0].geometry
    assert.equal(g.index.count, 3); assert.equal(g.attributes.position.count, 3)
    near(g.boundingBox.min.toArray(), [10, 10, -12]); near(g.boundingBox.max.toArray(), [12, 10, -10])
  })
  check('stops traversing references at the mesh and omits detached cached meshes', () => {
    const s = sceneBuilder(), detached = s.add(mesh())
    const live = s.add(container(0x100, Buffer.concat([chunk(0x2034, u32(detached)), mesh()])))
    s.node('Live', live)
    const model = loader.parse(pack(s.items))
    assert.equal(model.children.length, 1)
  })
  console.log(`${passed} MAX loader regression checks passed`)
} finally {
  // Only remove the temporary directory this test created within this repository.
  if (path.dirname(temp) !== root || !path.basename(temp).startsWith('.tmp-max-tests-')) throw new Error('Unsafe test cleanup path')
  fs.rmSync(temp, { recursive: true, force: true })
}
