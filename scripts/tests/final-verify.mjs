/**
 * 最终回归验证：针对打包后的 win-unpacked 可执行文件
 * 覆盖：加载、HUD、查看模式切换、单位切换、导出序列化、单模型替换
 */
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const exe = path.join(ROOT, 'release', 'win-unpacked', '3D模型查看器.exe')
const obj = path.join(ROOT, 'testdata', 'cube.obj')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`) }

const app = await electron.launch({ executablePath: exe, args: [obj], cwd: ROOT, env: process.env })
const win = await app.firstWindow()
await new Promise((r) => setTimeout(r, 3500))

const faces = (await win.textContent('#hud-faces'))?.trim()
const size = (await win.textContent('#hud-size'))?.trim()
check('加载 OBJ', faces === '12', `面数:${faces}`)
check('尺寸 mm', /10\.00 × 20\.00 × 30\.00 mm/.test(size ?? ''), size)

// 查看模式切换循环（多次切换验证材质缓存无泄漏/无崩溃）
for (const mode of ['wire', 'solid', 'wire', 'solid']) {
  await win.click(`[data-mode="${mode}"]`)
  await new Promise((r) => setTimeout(r, 300))
}
const activeMode = await win.$eval('.mode-btn.active', (el) => el.dataset.mode)
check('查看模式切换循环正常', activeMode === 'solid', `当前:${activeMode}`)

// 单位切换
await win.selectOption('#unit-select', 'cm')
const sizeCm = (await win.textContent('#hud-size'))?.trim()
check('单位 cm', /1\.000 × 2\.000 × 3\.000 cm/.test(sizeCm ?? ''), sizeCm)
await win.selectOption('#unit-select', 'mm')

// 导出序列化（通过测试钩子）
const exp = await win.evaluate(async (p) => {
  const { loadModelFile, serializeModel } = window.__test
  const { root } = await loadModelFile(p.replace(/\\/g, '/'))
  const out = {}
  for (const fmt of ['obj', 'stl', 'fbx']) {
    try { const { data } = await serializeModel(fmt, root, 'cube'); out[fmt] = data.length }
    catch (e) { out[fmt] = 'ERR:' + String(e) }
  }
  return out
}, obj)
check('导出 OBJ/STL/FBX 序列化', exp?.obj > 100 && exp?.stl > 100 && exp?.fbx > 100, JSON.stringify(exp))

// 单模型替换
await app.evaluate(({ BrowserWindow }, stl) => {
  BrowserWindow.getAllWindows()[0].webContents.send('open-file', stl)
}, path.join(ROOT, 'testdata', 'cube.stl'))
await new Promise((r) => setTimeout(r, 1500))
const file = (await win.textContent('#hud-file'))?.trim()
check('单模型替换', file?.includes('cube.stl') === true, file)

await win.screenshot({ path: path.join(ROOT, 'screenshots', 'final.png') })
await app.close()

const pass = results.filter((r) => r.ok).length
console.log(`\n=== 最终回归: ${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
