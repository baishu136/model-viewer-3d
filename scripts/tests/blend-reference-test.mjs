import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as THREE from 'three'
import { compileBlendLoader, cleanupBlendTest } from './blend-test-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!source) throw new Error('Usage: npm run test:blend:reference -- model.blend --blender=C:/path/blender.exe')
const blender = process.argv.find((a) => a.startsWith('--blender='))?.slice(10) || 'blender'
const temp = fs.mkdtempSync(path.join(root, '.tmp-blend-test-'))
try {
  const { BlendLoader } = await compileBlendLoader(root, temp)
  const oracle = path.join(temp, 'reference.json')
  console.log(execFileSync(blender, ['-b', '--factory-startup', '--python', path.join(root, 'scripts/tests/blend-reference.py'), '--', path.resolve(source), oracle], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024
  }).trim())
  const reference = JSON.parse(fs.readFileSync(oracle, 'utf8'))
  const bytes = fs.readFileSync(source), data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const loader = new BlendLoader()
  // Isolate saved topology from modifier preview; the runtime model is checked separately.
  loader.applyPreviewModifiers = () => {}
  const model = loader.parse(data), meshes = []
  model.traverse((m) => { if (m.isMesh) meshes.push(m) })
  assert.equal(meshes.length, Object.keys(reference.objects).length)
  let maxVertexError = 0, maxAreaError = 0
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (const mesh of meshes) {
    const expected = reference.objects[mesh.parent.name]
    assert.ok(expected, mesh.parent.name)
    const p = mesh.geometry.attributes.position, index = mesh.geometry.index
    assert.equal(p.count, expected.vertices.length)
    for (let i = 0; i < p.count; i++) for (let axis = 0; axis < 3; axis++) {
      maxVertexError = Math.max(maxVertexError, Math.abs(p.array[i * 3 + axis] - expected.vertices[i][axis]))
    }
    let area = 0
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(p, index.getX(i)); b.fromBufferAttribute(p, index.getX(i + 1)); c.fromBufferAttribute(p, index.getX(i + 2))
      area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2
    }
    const areaError = Math.abs(area - expected.area) / Math.max(expected.area, 1e-6)
    maxAreaError = Math.max(maxAreaError, areaError)
    // Blender and ear clipping may choose different diagonals on nearly planar glyphs.
    assert.ok(areaError < 1e-3, `${mesh.parent.name}: polygon area differs from Blender (${areaError})`)
  }
  assert.equal(maxVertexError, 0)
  console.log(`PASS ${meshes.length} saved meshes: all vertex coordinates exact; maximum relative surface-area error ${maxAreaError}`)
  const mixer = new THREE.AnimationMixer(model), clip = model.userData.animations?.[0]
  assert.ok(clip, 'reference scene has object animation')
  mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true
  for (const [frame, objects] of Object.entries(reference.frames).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    mixer.setTime((Number(frame) - reference.start) / reference.fps)
    model.updateMatrixWorld(true)
    let maxError = 0
    for (const [name, matrix] of Object.entries(objects)) {
      const object = model.getObjectByName(name)
      assert.ok(object, name)
      const expected = new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(new THREE.Matrix4().set(...matrix.flat()))
      const error = Math.max(...expected.elements.map((v, i) => Math.abs(v - object.matrixWorld.elements[i])))
      maxError = Math.max(maxError, error)
      assert.ok(error < .005, `${name} frame ${frame}: world matrix error ${error}`)
    }
    console.log(`PASS frame ${frame}: ${Object.keys(objects).length} mesh world transforms; maximum error ${maxError}`)
  }
  const preview = new BlendLoader().parse(data), applied = []
  preview.traverse((m) => {
    if (!m.isMesh) return
    assert.ok([...m.geometry.attributes.position.array].every(Number.isFinite))
    for (const value of m.geometry.index.array) assert.ok(value < m.geometry.attributes.position.count)
    if (m.userData.blendModifiers?.applied.length) applied.push([m.name, m.userData.blendModifiers.applied])
  })
  console.log('PASS finite modifier preview and valid topology:', JSON.stringify(applied))
  console.log('Blender reference regression passed')
} finally { cleanupBlendTest(root, temp) }
