import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { createModelFixtures } from './model-fixtures.mjs'
import { createExtendedModelFixtures } from './extended-model-fixtures.mjs'
import { spawn, execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), dir = await createModelFixtures(root)
createExtendedModelFixtures(dir)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_EXEC_PATH
const installed = process.argv[2]
const app = await electron.launch({ executablePath: installed || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [...(installed ? [] : [path.join(root, 'out/main/index.js')]), path.join(dir, 'avatar-0.vrm'), '--user-data-dir=' + path.join(root, '.tmp-format-regression-profile')], cwd: root, env })
let passed = 0
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${++passed}: ${name}`) }
try {
  const win = await app.firstWindow(), errors = [], textureRequests = []
  win.on('pageerror', (e) => errors.push(e.message)); win.on('dialog', (d) => { errors.push(d.message()); void d.dismiss() })
  win.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  win.on('request', (r) => { if (/missing\.png|textures\.invalid/.test(r.url())) textureRequests.push(r.url()) })
  await win.waitForFunction(() => window.__test?.viewer.hasModel())
  check('VRM opens through command-line/file-association dispatch', (await win.textContent('#hud-file')).endsWith('avatar-0.vrm'))
  const open = (file) => win.evaluate((file) => window.__test.openModel(file), path.join(dir, file))
  const inspect = () => win.evaluate(() => {
    const v = window.__test.viewer, root = v.getModel(), meshes = []
    root.traverse((m) => { if (m.isMesh) meshes.push({ skin: !!m.isSkinnedMesh, morph: m.morphTargetInfluences?.length || 0, texture: !!m.material.map }) })
    return { version: root.userData.vrmVersion, rotation: root.quaternion.toArray(), clips: v.getAnimationState().clips.length, meshes }
  })
  for (const [file, version] of [['avatar-0.vrm', '0'], ['avatar-1.vrm', '1.0']]) {
    await open(file)
    let info = await inspect()
    check(`${file}: version, skin and morph targets retained`, info.version === version && info.meshes.some((m) => m.skin && m.morph > 0))
    check(`${file}: metre units and embedded animation retained`, await win.inputValue('#unit-select') === 'm' && info.clips === 2)
    await win.locator('#animation-time').fill('1')
    info = await inspect()
    check(`${file}: version-specific forward correction survives animation`, Math.abs(Math.abs(info.rotation[version === '0' ? 1 : 3]) - 1) < 1e-6)
    await win.click('[data-mode="wire"]'); await win.click('[data-mode="solid"]')
  }
  for (const [file, message] of [['not-an-avatar.vrm', 'VRM'], ['unsupported.vrm', '版本'], ['empty.obj', '几何']]) {
    const error = await win.evaluate(async (file) => { try { await window.__test.loadModelFile(file); return '' } catch (e) { return e.message } }, path.join(dir, file))
    check(`${file}: explicit failure instead of a blank successful scene`, error.includes(message))
  }
  await open('shared-vertices.vrm')
  const shared = await win.evaluate(() => {
    let result
    window.__test.viewer.getModel().traverse((m) => { if (m.isMesh) result = {
      vertices: m.geometry.attributes.position.count, morphVertices: m.geometry.morphAttributes.position[0].count,
      weight: m.geometry.attributes.skinWeight.getX(0), skinVertices: m.geometry.attributes.skinIndex.count,
      influence: m.morphTargetInfluences[0], morphedZ: m.getVertexPosition(0, m.position.clone()).z
    } })
    return result
  })
  check('VRM shared buffers discard unused vertices and retain normalised skin weights/morphs', shared.vertices === 3 && shared.morphVertices === 3 && shared.skinVertices === 3 && shared.weight === 1)
  check('static VRM models retain the saved expression pose without animation clips', shared.influence === 1 && Math.abs(shared.morphedZ - 0.25) < 0.001)
  await open('hierarchy-concave.ma')
  const maya = await win.evaluate(() => {
    const m = window.__test.viewer.getModel().getObjectByName('Shape'), p = m.geometry.attributes.position
    m.updateWorldMatrix(true, false)
    const vertex = m.position.clone().fromBufferAttribute(p, 0).applyMatrix4(m.matrix)
    return { triangles: m.geometry.index.count / 3, vertex: vertex.toArray() }
  })
  check('Maya reconstructs oriented edge topology and concave faces', maya.triangles === 6)
  check('Maya preserves parent rotation and child translation', maya.vertex.every((v, i) => Math.abs(v - [100, 10, 0][i]) < 0.001))
  check('Maya honours currentUnit millimeter', await win.inputValue('#unit-select') === 'mm')
  const nested = await win.evaluate(async (file) => {
    const { root } = await window.__test.loadModelFile(file)
    const p = root.children[0].geometry.attributes.position
    const z = p.getZ(0)
    root.traverse((m) => { m.geometry?.dispose(); m.material?.dispose() })
    return z
  }, path.join(dir, 'nested.c4d'))
  check('C4D applies handedness once across nested parent/child transforms', Math.abs(nested + 25) < 0.001)
  for (const file of ['triangle.blender', 'triangle.pmd', 'document.md']) {
    await open(file); check(`${file}: model/card displays`, await win.evaluate(() => window.__test.viewer.hasModel()))
  }
  // Export a viewer model (whose world coordinates are mm) and reload every supported target.
  await win.evaluate((file) => window.__test.openModel(file), path.join(root, 'testdata/cube.obj'))
  const roundtrip = await win.evaluate(async (dir) => {
    const { viewer, serializeModel, loadModelFile } = window.__test
    const stats = []
    for (const format of ['obj', 'stl', 'fbx', 'glb', 'gltf', 'ply', 'pmx']) {
      const result = await serializeModel(format, viewer.getModel(), 'roundtrip')
      const file = dir + '/roundtrip.' + format
      await window.api.writeFile(file, result.data)
      const loaded = await loadModelFile(file)
      loaded.root.updateMatrixWorld(true)
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = loaded.root.position.clone()
      let faces = 0
      loaded.root.traverse((m) => {
        if (!m.isMesh) return
        const p = m.geometry.attributes.position
        faces += (m.geometry.index?.count || p.count) / 3
        for (let i = 0; i < p.count; i++) {
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
          v.toArray().forEach((c, axis) => { min[axis] = Math.min(min[axis], c); max[axis] = Math.max(max[axis], c) })
        }
      })
      const scale = { mm: 1, cm: 10, m: 1000 }[loaded.unit]
      stats.push({ format, faces, size: min.map((c, i) => (max[i] - c) * scale) })
      loaded.root.traverse((m) => { m.geometry?.dispose(); m.skeleton?.dispose(); if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose()); else m.material?.dispose() })
    }
    return stats
  }, dir.replace(/\\/g, '/'))
  for (const item of roundtrip) check(`${item.format}: export/reload preserves 12 faces and 10×20×30 mm`, item.faces === 12 && item.size.every((v, i) => Math.abs(v - [10, 20, 30][i]) < 0.01))
  fs.copyFileSync(path.join(dir, 'roundtrip.pmx'), path.join(dir, 'model-alias.md'))
  await open('model-alias.md')
  check('PMX with .md extension is recognised as an MMD model', (await inspect()).meshes.some((m) => m.skin))
  if (installed) {
    const association = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\.vrm', '/ve'], { encoding: 'utf8' })
    check('installed program registers the VRM file association', association.includes('3D模型查看器.Model'))
    const second = spawn(installed, [path.join(dir, 'avatar-1.vrm'), '--user-data-dir=' + path.join(root, '.tmp-format-regression-profile')], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    const exited = new Promise((resolve, reject) => { second.once('exit', resolve); second.once('error', reject) })
    await win.waitForFunction(() => document.querySelector('#hud-file')?.textContent.endsWith('avatar-1.vrm'))
    check('opening VRM in a second process forwards it to the existing window', await exited === 0)
  }
  check('PMX/PMD/VRM never request original textures', textureRequests.length === 0)
  check('no renderer errors or loading dialogs', errors.length === 0)
  console.log(`Extended format regression: ${passed} passed`)
} finally { await app.close() }
