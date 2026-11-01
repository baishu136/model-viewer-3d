import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { MODEL_EXTENSIONS } from '../shared/model-formats'

const SUPPORTED_EXT = new Set(MODEL_EXTENSIONS.map((ext) => `.${ext}`))

/**
 * 便携版文件关联：zip 解压即用版未经安装程序注册文件关联，
 * 首次运行时调用 reg.exe 写入 HKCU 注册表，实现双击模型文件用本软件打开。
 * 幂等——已注册的关联不会重复覆盖（可先读取比对）。
 */
const FILE_ASSOC_CLASS = '3D模型查看器.Model'
const FILE_ASSOC_EXT = [...SUPPORTED_EXT]

function registerFileAssociations(): void {
  const exePath = process.execPath
  try {
    // 创建 ProgID 类
    const classArgs = [
      'add',
      `HKCU\\Software\\Classes\\${FILE_ASSOC_CLASS}`,
      '/ve',
      '/d',
      '3D模型文件 (FBX/GLB/glTF/VRM/OBJ/STL/PLY/PMX/PMD/BLEND/BLENDER/C4D/MA/MB/MAX/MD)',
      '/f'
    ]
    const iconArgs = [
      'add',
      `HKCU\\Software\\Classes\\${FILE_ASSOC_CLASS}\\DefaultIcon`,
      '/ve',
      '/d',
      `"${exePath}",0`,
      '/f'
    ]
    const openArgs = [
      'add',
      `HKCU\\Software\\Classes\\${FILE_ASSOC_CLASS}\\shell\\open\\command`,
      '/ve',
      '/d',
      `"${exePath}" "%1"`,
      '/f'
    ]
    execFile('reg.exe', classArgs)
    execFile('reg.exe', iconArgs)
    execFile('reg.exe', openArgs)

    // 每个扩展名指向 ProgID
    for (const ext of FILE_ASSOC_EXT) {
      execFile('reg.exe', [
        'add',
        `HKCU\\Software\\Classes\\${ext}`,
        '/ve',
        '/d',
        FILE_ASSOC_CLASS,
        '/f'
      ])
    }
  } catch (err) {
    console.warn('注册文件关联失败（可忽略）:', err)
  }
}

// 自定义 scheme，供渲染进程以标准 fetch 读取本地 3D 模型及其附属资源（纹理/MTL）
const SCHEME = 'model'

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

let mainWindow: BrowserWindow | null = null
/** 待处理的模型文件路径（窗口就绪前收到的启动文件） */
let pendingOpenFile: string | null = null

function isModelFile(p: string): boolean {
  return SUPPORTED_EXT.has(path.extname(p).toLowerCase())
}

/** 智能解析实际模型文件（若用户点击了 macOS 解压残留的 ._* 或 __MACOSX 影子文件，自动重定向至真实模型） */
function resolveActualModelPath(filePath: string): string {
  const fileName = path.basename(filePath)
  if (fileName.startsWith('._') || filePath.includes('__MACOSX')) {
    const cleanFileName = fileName.replace(/^\._/, '')
    const dir = path.dirname(filePath)
    const sameDirCandidate = path.join(dir, cleanFileName)
    if (fs.existsSync(sameDirCandidate)) return sameDirCandidate

    const cleanPath = filePath
      .replace(/[\\/]__MACOSX(?=[\\/]|$)/gi, '')
      .replace(new RegExp(`[\\\\/]\\._${cleanFileName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'i'), `\\${cleanFileName}`)
    if (fs.existsSync(cleanPath)) return cleanPath
  }
  return filePath
}

/** 从 argv 中提取第一个 3D 模型文件路径（跳过可执行路径与各种标志） */
function extractModelPath(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('-') || arg.startsWith('--')) continue
    if (isModelFile(arg)) {
      try {
        if (fs.existsSync(arg)) return resolveActualModelPath(arg)
      } catch {
        /* 非法路径忽略 */
      }
    }
  }
  return null
}

function sendOpenFile(file: string): void {
  const actualFile = resolveActualModelPath(file)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('open-file', actualFile)
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const file = extractModelPath(argv)
    if (file) {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
        sendOpenFile(file)
      } else {
        pendingOpenFile = file
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.focus()
        }
      }
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // macOS 上双击文件打开
  app.on('open-file', (event, file) => {
    event.preventDefault()
    if (mainWindow && mainWindow.isDestroyed() === false) sendOpenFile(file)
  })

  app.whenReady().then(() => {
    // 将 model:// 协议映射到本地文件系统
    protocol.handle(SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        let p = decodeURIComponent(url.pathname)
        if (/^\/[A-Za-z]:/.test(p)) {
          p = p.slice(1)
        }
        p = path.normalize(p)
        const data = await fsp.readFile(p)
        return new Response(new Uint8Array(data), {
          headers: { 'Access-Control-Allow-Origin': '*' }
        })
      } catch {
        return new Response('file not found: ' + request.url, { status: 404 })
      }
    })

    // 打包版（含 zip 便携版）：运行时确保文件关联已注册，实现双击打开
    if (app.isPackaged) registerFileAssociations()

    createWindow()

    // 启动时通过命令行 / 文件关联传入的模型文件：窗口加载完成后发送，
    // 确保渲染进程已注册好 open-file 监听器
    const startFile = extractModelPath(process.argv)
    if (startFile) pendingOpenFile = startFile

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: '3D模型查看器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 渲染进程加载完成后，发送启动时待处理的模型文件
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenFile) {
      const file = pendingOpenFile
      pendingOpenFile = null
      sendOpenFile(file)
    }
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

// ---------- IPC ----------

/** 读取文件内容为 ArrayBuffer，供渲染进程各加载器 parse() */
ipcMain.handle('file:read', async (_event, filePath: string): Promise<ArrayBuffer> => {
  const data = await fsp.readFile(filePath)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
})

ipcMain.handle('file:exists', (_event, filePath: string): boolean => {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
})

/** 弹出保存对话框并写入导出文件，返回 { canceled, filePath } */
ipcMain.handle('file:save', async (event, options: { defaultName: string; filters: Array<{ name: string; extensions: string[] }> }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    title: '导出模型',
    defaultPath: options.defaultName,
    filters: options.filters
  })
  if (result.canceled || !result.filePath) return { canceled: true, filePath: null }

  // 确保扩展名
  let finalPath = result.filePath
  const ext = path.extname(finalPath).toLowerCase()
  const wanted = (options.defaultName.split('.').pop() || '').toLowerCase()
  if (!ext && wanted) finalPath += '.' + wanted
  return { canceled: false, filePath: finalPath }
})

ipcMain.handle('file:write', async (_event, filePath: string, data: Uint8Array): Promise<boolean> => {
  await fsp.writeFile(filePath, data)
  return true
})
