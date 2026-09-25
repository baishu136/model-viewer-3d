import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

const exe = path.join(ROOT, 'release', 'win-unpacked', '3D模型查看器.exe')
const testObj = path.join(ROOT, 'testdata', 'cube.obj')

console.log('测试打包版可执行文件:', exe)

const app = await electron.launch({
  executablePath: exe,
  args: [testObj],
  cwd: ROOT,
  env: process.env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await new Promise((r) => setTimeout(r, 3500))

const faces = (await win.textContent('#hud-faces'))?.trim()
const file = (await win.textContent('#hud-file'))?.trim()
console.log('打包版 HUD → 面数:', faces, '| 文件:', file)
console.log(faces === '12' && file?.includes('cube.obj') ? '✅ 打包版加载正常' : '❌ 打包版加载异常')

await app.close()
console.log('打包版测试完成')
