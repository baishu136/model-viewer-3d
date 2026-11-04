import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { compileBlendLoader, cleanupBlendTest } from './blend-test-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const temp = fs.mkdtempSync(path.join(root, '.tmp-blend-test-'))
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const floats = (v) => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeFloatLE(n, i * 4)); return b }
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)])
const cstr = (s) => Buffer.from(s + '\0')
const schema = {
  ID: [['char', 'name[66]']],
  Object: [['ID', 'id'], ['short', 'type'], ['short', 'rotmode'], ['void', '*data'], ['Object', '*parent'],
    ['float', 'loc[3]'], ['float', 'rot[3]'], ['float', 'size[3]'], ['float', 'parentinv[4][4]']],
  Mesh: [['ID', 'id'], ['int', 'totvert'], ['int', 'totpoly'], ['int', 'totloop'], ['int', '*poly_offset_indices'], ['AttributeStorage', 'attribute_storage']],
  AttributeStorage: [['Attribute', '*dna_attributes'], ['int', 'dna_attributes_num']],
  Attribute: [['char', '*name'], ['short', 'data_type'], ['char', 'domain'], ['char', 'storage_type'], ['char', '_pad[4]'], ['void', '*data']],
  AttributeArray: [['void', '*data'], ['void', '*sharing_info'], ['int64_t', 'size']],
  raw_data: [['char', 'value']]
}
function fixture({ legacy = false, invalidOffsets = false } = {}) {
  const structs = { ...schema }
  if (legacy) structs.Object = [['ID', 'id'], ['short', 'type'], ['void', '*data'], ['Object', '*parent'], ['float', 'obmat[4][4]']]
  const types = ['char', 'short', 'int', 'int64_t', 'float', 'void', ...Object.keys(structs)]
  const sizes = { char: 1, short: 2, int: 4, int64_t: 8, float: 4, void: 0 }, names = [], fields = {}
  function size(type) {
    if (sizes[type] !== undefined) return sizes[type]
    let offset = 0; fields[type] = {}
    for (const [t, n] of structs[type]) {
      if (!names.includes(n)) names.push(n)
      const count = [...n.matchAll(/\[(\d+)\]/g)].reduce((a, m) => a * Number(m[1]), 1)
      fields[type][n] = { offset, size: (n.startsWith('*') ? 8 : size(t)) * count }
      offset += fields[type][n].size
    }
    return sizes[type] = offset
  }
  Object.keys(structs).forEach(size)
  const record = (type, values) => {
    const b = Buffer.alloc(sizes[type])
    for (const [name, value] of Object.entries(values)) value.copy(b, fields[type][name].offset)
    return b
  }
  const id = (name) => record('ID', { 'name[66]': cstr(name) })
  const chunks = []
  const block = (code, address, type, data, count = 1) => chunks.push(Buffer.concat([
    Buffer.from(code.padEnd(4, '\0')), u32(data.length), u64(address), u32(Object.keys(structs).indexOf(type)), u32(count), data
  ]))
  const firstMesh = 1000n, secondMesh = 2000n, firstObject = 3000n, secondObject = 4000n
  for (const [mesh, x] of [[firstMesh, 0], [secondMesh, 100]]) {
    // Reused pointer tokens in separate Mesh IDs, beyond Number.MAX_SAFE_INTEGER.
    const attributes = 2n ** 60n + 1n, positionValue = attributes + 1n, cornerValue = attributes + 2n
    const namePosition = mesh + 10n, nameCorner = mesh + 11n, positions = mesh + 12n, corners = mesh + 13n, offsets = mesh + 14n
    block('ME', mesh, 'Mesh', record('Mesh', { id: id('ME' + x), totvert: u32(4), totpoly: u32(1), totloop: u32(4), '*poly_offset_indices': u64(offsets),
      attribute_storage: record('AttributeStorage', { '*dna_attributes': u64(attributes), dna_attributes_num: u32(2) }) }))
    block('DATA', mesh + 15n, 'raw_data', floats(Array(12).fill(0.5))) // convincing position decoy
    block('DATA', mesh + 16n, 'raw_data', Buffer.concat([0, 1, 0, 1].map(u32))) // valid-range corner-edge decoy
    block('DATA', namePosition, 'raw_data', cstr('position')); block('DATA', nameCorner, 'raw_data', cstr('.corner_vert'))
    block('DATA', attributes, 'Attribute', Buffer.concat([
      record('Attribute', { '*name': u64(namePosition), data_type: u16(7), '*data': u64(positionValue) }),
      record('Attribute', { '*name': u64(nameCorner), data_type: u16(3), '*data': u64(cornerValue) })
    ]), 2)
    block('DATA', positionValue, 'AttributeArray', record('AttributeArray', { '*data': u64(positions), size: u64(4) }))
    block('DATA', cornerValue, 'AttributeArray', record('AttributeArray', { '*data': u64(corners), size: u64(4) }))
    block('DATA', positions, 'raw_data', floats([x, 0, 0, x + 2, 0, 0, x + 2, 3, 0, x, 3, 0]))
    block('DATA', corners, 'raw_data', Buffer.concat([0, 1, 2, 3].map(u32)))
    block('DATA', offsets, 'raw_data', Buffer.concat([0, invalidOffsets ? 3 : 4].map(u32)))
  }
  const object = (address, mesh, name, parent, location, scale, parentInverse) => {
    const matrix = new THREE.Matrix4().makeTranslation(...location)
    block('OB', address, 'Object', record('Object', legacy ? {
      id: id(name), type: u16(1), '*data': u64(mesh), '*parent': u64(parent), 'obmat[4][4]': floats(matrix.elements)
    } : {
      id: id(name), type: u16(1), rotmode: u16(1), '*data': u64(mesh), '*parent': u64(parent),
      'loc[3]': floats(location), 'rot[3]': floats([0, 0, Math.PI / 2]), 'size[3]': floats(scale), 'parentinv[4][4]': floats(parentInverse.elements)
    }))
  }
  object(firstObject, firstMesh, 'OB父对象', 0n, [10, 20, 30], [2, 3, 1], new THREE.Matrix4())
  object(secondObject, secondMesh, 'OBChild', firstObject, [0, 0, 5], [1, 1, 0], new THREE.Matrix4().makeTranslation(-2, 0, 0))
  const dna = Buffer.concat([Buffer.from('SDNANAME'), u32(names.length), pad4(Buffer.concat(names.map(cstr))),
    Buffer.from('TYPE'), u32(types.length), pad4(Buffer.concat(types.map(cstr))), Buffer.from('TLEN'), pad4(Buffer.concat(types.map((t) => u16(sizes[t])))),
    Buffer.from('STRC'), u32(Object.keys(structs).length), ...Object.entries(structs).map(([type, fields]) => Buffer.concat([
      u16(types.indexOf(type)), u16(fields.length), ...fields.flatMap(([t, n]) => [u16(types.indexOf(t)), u16(names.indexOf(n))])
    ]))])
  block('DNA1', 99999n, 'raw_data', dna)
  const data = Buffer.concat([Buffer.from('BLENDER-v500'), ...chunks, Buffer.from('ENDB')])
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log('PASS', name) }
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${a} != ${b}`))
try {
  const { BlendLoader } = await compileBlendLoader(root, temp)
  const model = new BlendLoader().parse(fixture())
  check('scopes reused high pointer tokens to each Mesh ID and ignores attribute decoys', () => {
    const first = model.getObjectByName('OB父对象').children[0].geometry, second = model.getObjectByName('OBChild').children[0].geometry
    near([...first.attributes.position.array], [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0])
    assert.equal(second.attributes.position.getX(0), 100)
    assert.equal(first.index.count, 6); assert.equal(second.index.count, 6)
  })
  check('restores local translation, rotation, nonuniform and zero scale, plus parent inverse', () => {
    const a = model.getObjectByName('OB父对象'), child = model.getObjectByName('OBChild')
    near(a.position.toArray(), [10, 20, 30]); near(child.scale.toArray(), [1, 1, 0])
    near(child.getWorldPosition(new THREE.Vector3()).toArray(), [10, 35, -16])
  })
  check('reads legacy saved matrix columns without transposing translation away', () => {
    const legacy = new BlendLoader().parse(fixture({ legacy: true }))
    near(legacy.getObjectByName('OB父对象').getWorldPosition(new THREE.Vector3()).toArray(), [10, 30, -20])
  })
  check('rejects inconsistent face offsets instead of inventing sequential triangles', () => {
    const invalid = new BlendLoader().parse(fixture({ invalidOffsets: true }))
    let meshes = 0; invalid.traverse((m) => { if (m.isMesh) meshes++ })
    assert.equal(meshes, 0)
  })
  const { wireframeMesh, subdivideMesh, polygonGeometry } = await import(new URL('blend-modifiers.mjs', 'file:///' + temp.replaceAll('\\', '/') + '/'))
  check('wireframe opens a polygon centre and subdivision retains finite indexed surfaces', () => {
    const source = { positions: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], faces: [[0, 1, 2, 3]] }
    const wire = wireframeMesh(source, .1, 0, true, true)
    const geometry = polygonGeometry(wire), p = geometry.attributes.position
    for (let i = 0; i < geometry.index.count; i += 3) {
      const v = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, geometry.index.getX(i + k)))
      const center = v[0].add(v[1]).add(v[2]).divideScalar(3)
      assert.ok(!(center.x > .1 && center.x < 1.9 && center.y > .1 && center.y < 1.9), 'solid triangle fills wireframe opening')
    }
    const subdivided = subdivideMesh(wire)
    assert.ok(subdivided.positions.every(Number.isFinite)); assert.equal(subdivided.faces.length, wire.faces.reduce((s, f) => s + f.length, 0))
  })
  console.log(`${passed} Blender loader regression checks passed`)
} finally { cleanupBlendTest(root, temp) }
