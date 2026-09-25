/**
 * 干净的 dev 启动器：
 * 确保 ELECTRON_RUN_AS_NODE 被清除（防止 electron 以 Node 模式运行而破坏主进程），
 * 然后代理执行 electron-vite dev。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const electronViteBin = path.resolve(path.dirname(require.resolve('electron-vite/package.json')), 'dist', 'cli.js')

// 关键：清除污染变量，确保 electron 以 GUI 模式启动
delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_EXEC_PATH

const cliArgs = process.argv.slice(2)
const child = spawn(process.execPath, [electronViteBin, ...cliArgs], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.resolve(__dirname, '..')
})

child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('无法启动 electron-vite:', err)
  process.exit(1)
})
