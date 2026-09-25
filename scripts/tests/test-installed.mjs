/**
 * 验证已安装应用的文件关联与单实例行为：
 * 1. 双击 .obj → 应用启动并加载
 * 2. 应用运行时双击另一个 .obj → 单实例聚焦，替换模型
 */
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'model-viewer-3d', '3D模型查看器.exe')
const obj1 = path.join(ROOT, 'testdata', 'cube.obj')
const obj2 = path.join(ROOT, 'testdata', 'cube.stl')

console.log('已安装 exe:', exe)
console.log('存在:', fs.existsSync(exe))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- 1. 双击打开（启动时带模型路径） ----
console.log('\n=== 测试1: 双击 .obj 打开 ===')
const app = await electron.launch({
  executablePath: exe,
  args: [obj1],
  cwd: ROOT,
  env: process.env
})
const win = await app.firstWindow()
await new Promise((r) => setTimeout(r, 3500))
const faces = (await win.textContent('#hud-faces'))?.trim()
const file = (await win.textContent('#hud-file'))?.trim()
console.log(`  双击打开 → 面数:${faces} 文件:${file}`)
check('文件关联: 双击 .obj 加载模型', faces === '12' && file?.includes('cube.obj') === true, `面数:${faces} 文件:${file}`)

// ---- 2. 单实例：应用运行时，再次启动加载 cube.stl ----
console.log('\n=== 测试2: 单实例聚焦 + 模型替换 ===')
// 通过 electronApp 的主进程，模拟 second-instance 路径：
// 真实场景是再次双击文件，会触发 requestSingleInstanceLock 失败→second-instance 事件。
// 这里用 electronApp.evaluate 直接调用 BrowserWindow 发送 open-file（等效于 second-instance 后 sendOpenFile）
await app.evaluate(({ BrowserWindow }, stlPath) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.webContents.send('open-file', stlPath)
}, obj2)
await new Promise((r) => setTimeout(r, 1500))
const fileAfter = (await win.textContent('#hud-file'))?.trim()
const facesAfter = (await win.textContent('#hud-faces'))?.trim()
console.log(`  第二次打开 → 文件:${fileAfter} 面数:${facesAfter}`)
check('单实例: 模型替换为 cube.stl', fileAfter?.includes('cube.stl') === true, `当前: ${fileAfter}`)
check('单实例: 面数仍正确', facesAfter === '12', `当前: ${facesAfter}`)

await app.close()

const pass = results.filter((r) => r.ok).length
console.log(`\n=== 已安装版测试: ${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
