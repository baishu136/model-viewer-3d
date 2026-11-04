import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!source) throw new Error('Usage: node scripts/tests/blend-viewer-test.mjs model.blend [--exe=viewer.exe]')
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_EXEC_PATH
const app = await electron.launch({ executablePath: exe || path.join(root, 'node_modules/electron/dist/electron.exe'), cwd: root, env,
  args: [...(exe ? [] : [path.join(root, 'out/main/index.js')]), path.resolve(source), '--user-data-dir=' + path.join(root, '.tmp-blend-test-ui')] })
try {
  const win = await app.firstWindow(), errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  win.on('dialog', (d) => { errors.push(d.message()); void d.dismiss() })
  await win.waitForFunction(() => window.__test?.viewer.hasModel())
  assert.equal((await win.textContent('#hud-file')).trim(), path.basename(source))
  const info = await win.evaluate(() => {
    const viewer = window.__test.viewer, model = viewer.getModel(), names = [], modifiers = []
    model.traverse((m) => { if (m.isMesh) { names.push(m.name); if (m.userData.blendModifiers?.applied.length) modifiers.push(m.userData.blendModifiers.applied) } })
    return { names, modifiers, animation: viewer.getAnimationState() }
  })
  assert.ok(info.names.length > 0)
  console.log('PASS real Blender scene displays', info.names.length, 'meshes;', (await win.textContent('#hud-faces')).trim(), 'faces')
  fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true })
  await win.screenshot({ path: path.join(root, 'screenshots/blend-scene-fixed-solid.png') })
  await win.click('[data-mode="wire"]')
  await win.screenshot({ path: path.join(root, 'screenshots/blend-scene-fixed-wire.png') })
  await win.click('[data-mode="solid"]')
  if (info.animation.clips.length) {
    const time = Math.round(info.animation.duration * 500) / 1000
    await win.locator('#animation-time').fill(String(time))
    const state = await win.evaluate(() => window.__test.viewer.getAnimationState())
    assert.ok(Math.abs(state.time - time) < .01)
    await win.screenshot({ path: path.join(root, 'screenshots/blend-scene-fixed-animation.png') })
    await win.click('#animation-play')
    await win.waitForFunction((t) => window.__test.viewer.getAnimationState().time > t + .1, time)
    await win.click('#animation-play')
    console.log('PASS scrubbing, playback and wireframe render without errors')
  }
  assert.deepEqual(errors, [])
  console.log('PASS no renderer/shader errors or loading dialogs')
} finally { await app.close() }
