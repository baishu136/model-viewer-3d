import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshBasicMaterial } from 'three'
import { VRMCoreLoaderPlugin } from '@pixiv/three-vrm-core'
import { createModelFixtures } from './model-fixtures.mjs'
import { createExtendedModelFixtures } from './extended-model-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = await createModelFixtures(root)
createExtendedModelFixtures(fixtures)
const output = path.join(root, 'testdata/native-export')
fs.mkdirSync(output, { recursive: true })
const exe = process.argv.find((arg) => arg.startsWith('--exe='))?.slice(6)
const realMax = process.argv.find((arg) => arg.startsWith('--real-max='))?.slice(11)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_EXEC_PATH
const app = await electron.launch({ executablePath: exe || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [...(exe ? [] : [path.join(root, 'out/main/index.js')]), path.join(fixtures, 'triangle.max'),
    '--user-data-dir=' + path.join(root, '.tmp-native-export-profile')], cwd: root, env })
const formats = ['obj', 'fbx', 'pmx', 'stl', 'gltf', 'ply', 'vrm', 'glb']
const results = []
const requiredBones = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']

async function verifyVrm(file) {
  const data = fs.readFileSync(file), textLength = data.readUInt32LE(12)
  assert.equal(data.readUInt32LE(0), 0x46546c67)
  assert.equal(data.readUInt32LE(8), data.length)
  const json = JSON.parse(data.subarray(20, 20 + textLength).toString())
  const extension = json.extensions.VRMC_vrm
  assert.equal(extension.specVersion, '1.0')
  assert.ok(extension.meta.name && extension.meta.authors.length && extension.meta.licenseUrl)
  const mapping = extension.humanoid.humanBones
  assert.ok(requiredBones.every((bone) => json.nodes[mapping[bone]?.node]))
  assert.equal(new Set(Object.values(mapping).map((bone) => bone.node)).size, Object.keys(mapping).length)
  assert.equal(extension.extras.automaticSkinning, false)
  assert.equal(json.skins?.length || 0, 0, 'static VRM must not pretend to have skin weights')
  for (const m of json.meshes) for (const p of m.primitives) {
    assert.equal(p.attributes.JOINTS_0, undefined); assert.equal(p.attributes.WEIGHTS_0, undefined)
  }
  // Independent official three-vrm importer, not only the viewer's geometry-only VRM path.
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMCoreLoaderPlugin(parser))
  loader.register(() => ({ name: 'STATIC_TEST_MATERIAL', loadMaterial: () => Promise.resolve(new MeshBasicMaterial()) }))
  const parsed = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '')
  assert.ok(parsed.userData.vrmCore?.humanoid, 'official VRMCore importer must construct the humanoid')
  parsed.scene.traverse((m) => { m.geometry?.dispose(); if (Array.isArray(m.material)) m.material.forEach((s) => s.dispose()); else m.material?.dispose() })
}

try {
  const win = await app.firstWindow(), errors = []
  win.setDefaultTimeout(120000)
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  win.on('dialog', (d) => { errors.push(d.message()); void d.dismiss() })
  await win.waitForFunction(() => window.__test?.viewer.hasModel())
  // Produce a genuine MMD model under the requested .md alias.
  await win.evaluate(async ({ source, target }) => {
    const { loadModelFile, viewer, serializeModel } = window.__test
    const loaded = await loadModelFile(source)
    viewer.setModel(loaded.root, 'cube.obj', loaded.animations, 1)
    const result = await serializeModel('pmx', viewer.getModel(), 'alias')
    await window.api.writeFile(target, result.data)
  }, { source: path.join(root, 'testdata/cube.obj'), target: path.join(fixtures, 'export-model.md') })
  const inputs = ['triangle.max', 'nested.c4d', 'export-model.md', 'document.md', 'triangle.blender'].map((file) => path.join(fixtures, file))
  if (realMax) inputs.push(realMax)
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const input = inputs[inputIndex]
    await win.evaluate((file) => window.__test.openModel(file), input)
    await win.click('#export-btn')
    assert.equal(await win.locator('[data-export-format]').count(), 8)
    await win.locator('[data-export-format="vrm"]').waitFor({ state: 'visible' })
    await win.getByRole('button', { name: '取消', exact: true }).click()
    for (const format of formats) {
      const target = path.join(output, `input-${inputIndex}.${format}`)
      const stats = await win.evaluate(async ({ format, target }) => {
        const { viewer, serializeModel, loadModelFile } = window.__test
        const inspect = (root, scale) => {
          root.updateWorldMatrix(true, true)
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = root.position.clone()
          let faces = 0
          root.traverse((m) => {
            if (!m.isMesh) return
            const p = m.geometry.attributes.position
            faces += (m.geometry.index?.count || p.count) / 3
            for (let i = 0; i < p.count; i++) {
              m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld)
              v.toArray().forEach((n, axis) => { min[axis] = Math.min(min[axis], n * scale); max[axis] = Math.max(max[axis], n * scale) })
            }
          })
          return { faces, size: min.map((n, axis) => max[axis] - n) }
        }
        const source = inspect(viewer.getModel(), 1)
        const result = await serializeModel(format, viewer.getModel(), 'converted')
        await window.api.writeFile(target, result.data)
        const model = await loadModelFile(target)
        const reloaded = inspect(model.root, { mm: 1, cm: 10, m: 1000 }[model.unit])
        model.root.traverse((m) => { m.geometry?.dispose(); m.skeleton?.dispose(); if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose()); else m.material?.dispose() })
        return { source, reloaded, bytes: result.data.byteLength }
      }, { format, target })
      assert.equal(stats.reloaded.faces, stats.source.faces, `${input} → ${format}: face count`)
      if (input.endsWith('.blender')) assert.ok(stats.source.size.every((n, axis) => Math.abs(n - [1000, 0, 1000][axis]) < 0.01), 'Blender SDNA vertex/loop strides preserve the source triangle')
      assert.ok(stats.reloaded.size.every((n, axis) => Math.abs(n - stats.source.size[axis]) < Math.max(0.01, stats.source.size[axis] * 0.0001)), `${input} → ${format}: dimensions ${JSON.stringify(stats)}`)
      if (format === 'vrm') await verifyVrm(target)
      results.push({ source: path.basename(input), format, ...stats })
      console.log(`PASS ${path.basename(input)} → ${format}: ${stats.reloaded.faces} faces, ${stats.bytes} bytes`)
    }
  }
  // Exercise the actual export button, save-dialog response and IPC file write.
  const uiFile = path.join(output, 'ui-export.vrm')
  if (fs.existsSync(uiFile)) fs.unlinkSync(uiFile)
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, uiFile)
  await win.click('#export-btn')
  await win.screenshot({ path: path.join(root, 'screenshots/native-export-menu.png') })
  const saved = win.waitForEvent('console', { predicate: (message) => message.text() === '已导出为 vrm', timeout: 120000 })
  await win.locator('[data-export-format="vrm"]').click()
  await saved // Completion is logged only after the real IPC file write resolves.
  await verifyVrm(uiFile)
  assert.deepEqual(errors, [], 'No renderer/export errors')
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, uiExport: true, errors }, null, 2))
  console.log(`Native export checks: ${results.length} format roundtrips plus UI save workflow passed`)
} finally { await app.close() }
