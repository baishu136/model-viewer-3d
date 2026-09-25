/**
 * 真实单实例测试：
 * 1. 启动应用加载 cube.obj
 * 2. 用独立进程启动第二个实例加载 cube.stl（模拟双击第二个文件）
 * 3. 第二个进程应因 requestSingleInstanceLock 退出，并把文件路径传给第一个实例
 * 4. 验证第一个实例的窗口加载了 cube.stl
 */
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'model-viewer-3d', '3D模型查看器.exe')
const obj1 = path.join(ROOT, 'testdata', 'cube.obj')
const obj2 = path.join(ROOT, 'testdata', 'cube.stl')

console.log('=== 真实单实例测试 ===')

// 1. 启动第一个实例
const app = await electron.launch({
  executablePath: exe,
  args: [obj1],
  cwd: ROOT,
  env: process.env
})
const win = await app.firstWindow()
await new Promise((r) => setTimeout(r, 3000))
console.log('实例1 加载:', await win.textContent('#hud-file'))

// 2. 启动第二个进程（真实独立进程，非 Playwright 管理）
const second = spawn(exe, [obj2], { stdio: 'ignore', cwd: ROOT })
console.log('实例2 已启动, pid:', second.pid)

// 3. 等待单实例机制转发文件
await new Promise((r) => setTimeout(r, 3000))

// 4. 检查第一个实例是否加载了 cube.stl
const file1 = (await win.textContent('#hud-file'))?.trim()
const faces1 = (await win.textContent('#hud-faces'))?.trim()
console.log('实例1 当前文件:', file1, '| 面数:', faces1)

// 5. 检查第二个进程是否退出（Electron quit 异步，延长等待）
const secondExited = new Promise((resolve) => second.on('exit', (code) => resolve(code)))
const secondCode = await Promise.race([secondExited, new Promise((r) => setTimeout(() => r('still-running'), 8000))])
console.log('实例2 状态:', secondCode === 'still-running' ? '仍在运行' : `已退出 (code=${secondCode})`)

// 核心验证：实例1 成功加载了实例2 传入的文件（单实例转发生效）
const ok = file1?.includes('cube.stl') === true && faces1 === '12'
console.log(ok ? '✅ 单实例转发验证通过（文件已切换至 cube.stl）' : '❌ 单实例转发验证失败')

await app.close()
process.exit(ok ? 0 : 1)
