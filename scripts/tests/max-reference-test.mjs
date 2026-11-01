import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

// npm run test:max:reference -- model.max reference.fbx [installed.exe]
// Reference assets stay outside the repository and are never modified.
const [maxFile, fbxFile, installedExe] = process.argv.slice(2).map((p) => path.resolve(p))
assert.ok(maxFile && fbxFile, 'Supply a MAX file and its exported FBX reference')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_EXEC_PATH
const app = await electron.launch({
  executablePath: installedExe || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [...(installedExe ? [] : [path.join(root, 'out/main/index.js')]), maxFile,
    '--user-data-dir=' + path.join(root, '.tmp-max-reference-profile')], cwd: root, env
})
try {
  const win = await app.firstWindow(), errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('dialog', (dialog) => { errors.push(dialog.message()); void dialog.dismiss() })
  await win.waitForFunction(() => window.__test?.viewer.hasModel(), undefined, { timeout: 60000 })
  const comparison = await win.evaluate(async ({ maxFile, fbxFile }) => {
    const { loadModelFile } = window.__test
    const summarize = (root) => {
      root.updateMatrixWorld(true)
      const meshes = []
      root.traverse((m) => {
        if (!m.isMesh) return
        const p = m.geometry.attributes.position, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
        const v = m.position.clone()
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
          v.toArray().forEach((c, axis) => { min[axis] = Math.min(min[axis], c); max[axis] = Math.max(max[axis], c) })
        }
        meshes.push({ name: m.name, center: min.map((c, i) => (c + max[i]) / 2), size: min.map((c, i) => max[i] - c),
          faces: (m.geometry.index?.count ?? p.count) / 3 })
      })
      return meshes
    }
    const max = await loadModelFile(maxFile), fbx = await loadModelFile(fbxFile)
    const result = { max: summarize(max.root), fbx: summarize(fbx.root) }
    for (const model of [max.root, fbx.root]) model.traverse((m) => {
      m.geometry?.dispose(); if (Array.isArray(m.material)) m.material.forEach((s) => s.dispose()); else m.material?.dispose()
    })
    return result
  }, { maxFile, fbxFile })
  assert.equal(comparison.max.length, comparison.fbx.length, 'Every reference mesh must have a MAX counterpart')
  // Prefer the broad base mesh: source item order can differ between material variants,
  // and reconstructed spline caps do not have their FBX extrusion thickness.
  const anchor = [...comparison.max].sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2])[0]
  const referenceAnchor = comparison.fbx.find((m) => m.name === anchor.name)
  assert.ok(referenceAnchor, 'Common anchor mesh')
  const offset = referenceAnchor.center.map((v, i) => v - anchor.center[i])
  const sceneSpan = Math.max(...comparison.fbx.flatMap((m) => m.size),
    ...[0, 1, 2].map((axis) => Math.max(...comparison.fbx.map((m) => m.center[axis])) - Math.min(...comparison.fbx.map((m) => m.center[axis]))))
  const remaining = [...comparison.fbx], deltas = []
  for (const mesh of comparison.max) {
    const candidates = remaining.map((ref, i) => ({ ref, i,
      delta: Math.hypot(...ref.center.map((v, axis) => v - mesh.center[axis] - offset[axis]))
    })).filter(({ ref }) => ref.name === mesh.name).sort((a, b) => a.delta - b.delta)
    assert.ok(candidates.length, `Missing reference for ${mesh.name}`)
    const matched = candidates[0]
    assert.ok(matched.delta < sceneSpan * 0.01, `${mesh.name} is displaced by ${matched.delta}`)
    assert.ok(mesh.size.every((v, i) => Math.abs(v - matched.ref.size[i]) < sceneSpan * 0.03), `${mesh.name} has exploded bounds`)
    deltas.push(matched.delta); remaining.splice(matched.i, 1)
  }
  console.log(`PASS ${comparison.max.length} mesh placements and bounds match FBX within tolerance; largest center difference ${Math.max(...deltas).toFixed(3)} source units`)
  console.log('Global translation between source and reference:', offset.map((v) => +v.toFixed(3)))
  // Check the actual displayed scene and save front views in solid/wire modes.
  await win.evaluate(() => {
    const v = window.__test.viewer
    const distance = v.camera.position.length()
    v.controls.enableDamping = false
    v.camera.position.set(0, 0, -distance)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
  })
  fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true })
  for (const mode of ['solid', 'wire']) {
    await win.click(`[data-mode="${mode}"]`)
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(root, 'screenshots', `max-${installedExe ? 'installed' : 'fixed'}-${mode}.png`) })
  }
  assert.deepEqual(errors, [], 'No renderer errors')
  console.log('PASS real Electron startup, MAX loading, solid/wire rendering')
} finally { await app.close() }
