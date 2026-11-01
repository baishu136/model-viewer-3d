import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

// Real assets are read in place. Keep their provenance and the audit result out of source fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const modelRoot = process.argv[2]
assert.ok(modelRoot, 'Usage: node scripts/tests/format-audit.mjs <models-directory> [installed-exe]')
const installed = process.argv[3]
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
  ? walk(path.join(dir, entry.name)) : [{ file: path.join(dir, entry.name), size: fs.statSync(path.join(dir, entry.name)).size }])
const grouped = new Map()
for (const item of walk(modelRoot)) {
  const ext = path.extname(item.file).toLowerCase()
  if (!['.fbx', '.vrm', '.pmx', '.pmd', '.obj', '.stl', '.ply', '.glb', '.gltf', '.ma', '.mb', '.blend', '.blender', '.c4d', '.max'].includes(ext)) continue
  if (item.size > 64 * 1024 * 1024 || item.size === 0 || path.basename(item.file).startsWith('._')) continue
  if (!grouped.has(ext)) grouped.set(ext, [])
  grouped.get(ext).push(item)
}
const selected = [...grouped.values()].flatMap((items) => {
  items.sort((a, b) => a.size - b.size)
  return [...new Set([items[0], items[Math.floor(items.length / 2)], items[items.length - 1]])]
})
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_EXEC_PATH
const app = await electron.launch({ executablePath: installed || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [...(installed ? [] : [path.join(root, 'out/main/index.js')]), '--user-data-dir=' + path.join(root, '.tmp-format-audit-profile')], cwd: root, env })
const results = []
try {
  const win = await app.firstWindow(), errors = [], textureRequests = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  win.on('request', (r) => { if (/\.(png|jpe?g|bmp|tga|webp|dds)(\?|$)/i.test(r.url()) && !r.url().startsWith('data:')) textureRequests.push(r.url()) })
  win.on('dialog', (d) => { errors.push(d.message()); void d.dismiss() })
  await win.waitForFunction(() => !!window.__test)
  for (const { file, size } of selected) {
    const result = await win.evaluate(async (file) => {
      const { loadModelFile, viewer, ui } = window.__test
      try {
        const { root, unit, animations } = await loadModelFile(file)
        viewer.setModel(root, file.split(/[\\/]/).pop(), animations, { mm: 1, cm: 10, m: 1000 }[unit]); ui.setUnit(unit)
        let meshes = 0, vertices = 0, faces = 0, skins = 0
        root.traverse((m) => {
          if (!m.isMesh && !m.isPoints && !m.isLine) return
          const p = m.geometry.attributes.position
          vertices += p?.count || 0
          if (m.isMesh) { meshes++; faces += (m.geometry.index?.count || p.count) / 3 }
          if (m.isSkinnedMesh) skins++
        })
        const stats = viewer.getStats ? viewer.getStats() : null
        return { ok: vertices > 0 && Number.isFinite(viewer.camera.position.length()), meshes, vertices, faces, skins, unit, vrmVersion: root.userData.vrmVersion, stats }
      } catch (e) { return { ok: false, error: String(e.message || e) } }
    }, file)
    result.file = path.relative(modelRoot, file); result.bytes = size
    results.push(result)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.file}: ${result.error || `${result.meshes} meshes, ${result.faces} faces, ${result.skins} skins`}`)
    if (result.ok) {
      await win.click('[data-mode="wire"]'); await win.waitForTimeout(100)
      await win.click('[data-mode="solid"]'); await win.waitForTimeout(100)
      if (path.extname(file).toLowerCase() === '.vrm') await win.screenshot({ path: path.join(root, 'screenshots', `vrm-${result.vrmVersion === '0' ? '0' : '1'}-${installed ? 'installed' : 'source'}.png`) })
    }
  }
  fs.mkdirSync(path.join(root, 'testdata/format-audit'), { recursive: true })
  fs.writeFileSync(path.join(root, 'testdata/format-audit/real-models.json'), JSON.stringify({ results, errors, textureRequests }, null, 2))
  assert.deepEqual(errors, [], 'No renderer errors')
  assert.deepEqual(textureRequests, [], 'Geometry-only loading must not request source textures')
  console.log(`Real asset audit: ${results.filter((r) => r.ok).length}/${results.length} opened; report: testdata/format-audit/real-models.json`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
} finally { await app.close() }
