import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SaveOptions {
  defaultName: string
  filters: Array<{ name: string; extensions: string[] }>
}

export interface SaveResult {
  canceled: boolean
  filePath: string | null
}

/** 渲染进程可用的安全桥接 API */
const api = {
  /** 读取文件内容为 ArrayBuffer */
  readFile: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('file:read', filePath),

  fileExists: (filePath: string): Promise<boolean> => ipcRenderer.invoke('file:exists', filePath),

  /** 弹出保存对话框，返回用户选择的路径（不写入内容） */
  saveFileDialog: (options: SaveOptions): Promise<SaveResult> => ipcRenderer.invoke('file:save', options),

  /** 写入文件 */
  writeFile: (filePath: string, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('file:write', filePath, data),

  /** 从拖放的 File 对象解析真实磁盘路径（必须在 preload 中调用） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** 订阅"文件关联/第二个实例"传来的模型路径，返回取消订阅函数 */
  onOpenFile: (callback: (filePath: string) => void): (() => void) => {
    const listener = (_event: unknown, filePath: string): void => callback(filePath)
    ipcRenderer.on('open-file', listener)
    return () => ipcRenderer.removeListener('open-file', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
