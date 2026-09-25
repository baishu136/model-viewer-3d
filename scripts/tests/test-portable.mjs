/**
 * 验证 zip 便携版：
 * 1. 解压版 exe 能启动并加载模型
 * 2. 运行时自动注册文件关联（reg.exe 写 HKCU）
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const portableDir = '/tmp/portable-test'
const exe = path.join(portableDir, '3D模型查看器.exe')
const obj = path.join(ROOT, 'testdata', 'cube.obj')

console.log('便携版 exe:', exe, '| 存在:', fs.existsSync(exe))
const results = []
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`) }

// 先清除已注册的文件关联（确保测的是本应用的注册）
try {
  for (const ext of ['.obj', '.fbx', '.stl', '.pmx', '.pmd']) {
    execFileSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${ext}`, '/f'], { stdio: 'ignore' })
  }
  console.log('（已清除旧文件关联，便于验证）')
} catch { /* 已不存在则忽略 */ }

// 启动便携版
const app = await electron.launch({ executablePath: exe, args: [obj], cwd: portableDir, env: process.env })
const win = await app.firstWindow()
await new Promise((r) => setTimeout(r, 3500))

const faces = (await win.textContent('#hud-faces'))?.trim()
const file = (await win.textContent('#hud-file'))?.trim()
check('便携版启动并加载模型', faces === '12' && file?.includes('cube.obj') === true, `面数:${faces} 文件:${file}`)

// 检查文件关联是否被注册（启动时 registerFileAssociations 执行）
await new Promise((r) => setTimeout(r, 1000))
const assocCheck = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\.obj', '/ve'], { encoding: 'utf8' })
check('便携版自动注册 .obj 文件关联', assocCheck.includes('3D模型查看器.Model'), assocCheck.trim().split('\n').pop() ?? '')

// 检查 open command 指向便携版 exe
const openCmd = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\3D模型查看器.Model\\shell\\open\\command', '/ve'], { encoding: 'utf8' })
check('文件关联命令指向便携版 exe', openCmd.includes('portable-test'), openCmd.trim().split('\n').pop() ?? '')

await app.close()
const pass = results.filter((r) => r.ok).length
console.log(`\n=== 便携版测试: ${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
