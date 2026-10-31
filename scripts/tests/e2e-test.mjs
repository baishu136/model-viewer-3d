/**
 * 端到端验证脚本：用 Playwright 驱动 Electron 应用，验证核心功能。
 * 运行：node scripts/e2e-test.mjs
 */
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const SHOT_DIR = path.join(ROOT, 'screenshots')

const mainEntry = path.join(ROOT, 'out/main/index.js')
const testObj = path.join(ROOT, 'testdata', 'cube.obj')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // 启动 Electron 应用（生产构建产物），传入测试模型路径。
  // 注意：绝不能设置 ELECTRON_RUN_AS_NODE，否则 electron 以 Node 模式运行导致主进程 ESM import 失败。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_EXEC_PATH
  const electronApp = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [mainEntry, testObj],
    cwd: ROOT,
    env
  })

  const win = await electronApp.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await new Promise((r) => setTimeout(r, 3500))

  // ---- 1. 模型加载 & HUD ----
  const faces = (await win.textContent('#hud-faces'))?.trim()
  const verts = (await win.textContent('#hud-vertices'))?.trim()
  const size = (await win.textContent('#hud-size'))?.trim()
  const file = (await win.textContent('#hud-file'))?.trim()
  console.log(`  HUD → 面数:${faces} 顶点:${verts} 尺寸:${size} 文件:${file}`)

  check('模型加载: 文件名显示', file?.includes('cube.obj') === true, `当前: ${file}`)
  check('HUD 面数 = 12', faces === '12', `当前: ${faces}`)
  check('HUD 顶点数 = 36', verts === '36', `当前: ${verts}`)
  check('HUD 尺寸 = 10×20×30 mm', /10\.00 × 20\.00 × 30\.00 mm/.test(size ?? ''), `当前: ${size}`)

  await win.screenshot({ path: path.join(SHOT_DIR, '1-solid.png') })
  console.log('  → 截图: 1-solid.png')

  // ---- 2. 查看模式切换 ----
  await win.click('[data-mode="wire"]')
  await new Promise((r) => setTimeout(r, 600))
  await win.screenshot({ path: path.join(SHOT_DIR, '2-solid-wire.png') })
  const wireActive = await win.$eval('[data-mode="wire"]', (el) => el.classList.contains('active'))
  check('查看模式: 实体叠加布线激活', wireActive === true)

  await win.locator('#opacity-slider').fill('45')
  const opacity = await win.inputValue('#opacity-slider')
  const opacityLabel = (await win.textContent('#opacity-value'))?.trim()
  check('模型透明度: 滑块可调节', opacity === '45' && opacityLabel === '45%', `当前: ${opacityLabel}`)
  await win.screenshot({ path: path.join(SHOT_DIR, '3-wire.png') })

  // 回到白模
  await win.click('[data-mode="solid"]')

  // ---- 3. 单位切换 ----
  await win.selectOption('#unit-select', 'cm')
  await new Promise((r) => setTimeout(r, 300))
  const sizeCm = (await win.textContent('#hud-size'))?.trim()
  check('单位切换: cm 显示 1×2×3', /1\.000 × 2\.000 × 3\.000 cm/.test(sizeCm ?? ''), `当前: ${sizeCm}`)
  await win.selectOption('#unit-select', 'm')
  await new Promise((r) => setTimeout(r, 300))
  const sizeM = (await win.textContent('#hud-size'))?.trim()
  check('单位切换: m 显示 0.01×0.02×0.03', /0\.010 × 0\.020 × 0\.030 m/.test(sizeM ?? ''), `当前: ${sizeM}`)

  // ---- 4. 导出弹窗 ----
  await win.click('#export-btn')
  await new Promise((r) => setTimeout(r, 400))
  const modalText = await win.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('div'))
    const exportModal = boxes.find((b) => b.textContent?.includes('导出当前姿态') && b.offsetParent !== null)
    return exportModal?.textContent ?? ''
  })
  check('导出: 格式选择弹窗出现', modalText.includes('Wavefront OBJ') && modalText.includes('STL') && modalText.includes('FBX'))
  // 关闭弹窗
  await win.keyboard.press('Escape')
  await win.click('body', { position: { x: 400, y: 400 } })

  // ---- 5. 加载层与导出序列化验证（OBJ/STL/FBX） ----
  const testStl = path.join(ROOT, 'testdata', 'cube.stl')

  // 加载层验证：loadModelFile 解析 STL
  const stlParse = await win.evaluate(async (stlPath) => {
    const { loadModelFile } = (window).__test
    const { root, unit } = await loadModelFile(stlPath.replace(/\\/g, '/'))
    let faces = 0
    let verts = 0
    root.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry
        if (g.index) faces += g.index.count / 3
        else if (g.attributes.position) faces += g.attributes.position.count / 3
        if (g.attributes.position) verts += g.attributes.position.count
      }
    })
    return { faces, verts, unit, isMesh: root.isMesh }
  }, testStl)
  check('加载层: STL 解析成功 (12面/36顶点)', stlParse?.faces === 12 && stlParse?.verts === 36, `当前: ${JSON.stringify(stlParse)}`)

  // 导出序列化验证
  const exportTest = await win.evaluate(async (stlPath) => {
    const { loadModelFile, serializeModel } = (window).__test
    const { root } = await loadModelFile(stlPath.replace(/\\/g, '/'))
    const out = {}
    for (const fmt of ['obj', 'stl', 'fbx']) {
      try {
        const { data, info } = await serializeModel(fmt, root, 'test-cube')
        out[fmt] = { len: data.length, magic: data.length > 4 ? Array.from(data.slice(0, 5)) : null }
        if (fmt === 'obj') out[fmt].head = new TextDecoder().decode(data.slice(0, 60)).split('\n').slice(0, 2).join(';')
      } catch (e) {
        out[fmt] = { error: String(e) }
      }
    }
    return out
  }, testStl)

  console.log('  导出结果:', JSON.stringify(exportTest))
  check('导出: OBJ 序列化非空', (exportTest?.obj?.len ?? 0) > 100, `字节数: ${exportTest?.obj?.len}`)
  check('导出: STL 序列化非空', (exportTest?.stl?.len ?? 0) > 100, `字节数: ${exportTest?.stl?.len}`)
  check('导出: FBX 序列化非空', (exportTest?.fbx?.len ?? 0) > 100, `字节数: ${exportTest?.fbx?.len}`)

  // 将导出字节写入磁盘供人工检查（FBX 魔数等）
  const exportBytes = await win.evaluate(async (stlPath) => {
    const { loadModelFile, serializeModel } = (window).__test
    const { root } = await loadModelFile(stlPath.replace(/\\/g, '/'))
    const bytes = {}
    for (const fmt of ['obj', 'stl', 'fbx']) {
      const { data } = await serializeModel(fmt, root, 'test-cube')
      bytes[fmt] = Array.from(data)
    }
    return bytes
  }, testStl)
  const EXPORT_DIR = path.join(ROOT, 'testdata', 'export')
  fs.mkdirSync(EXPORT_DIR, { recursive: true })
  for (const [fmt, arr] of Object.entries(exportBytes ?? {})) {
    fs.writeFileSync(path.join(EXPORT_DIR, `cube.${fmt === 'fbx' ? 'fbx' : fmt}`), Buffer.from(arr))
  }
  // 验证 FBX 魔数
  const fbxBuf = fs.readFileSync(path.join(EXPORT_DIR, 'cube.fbx'))
  const fbxHead = fbxBuf.subarray(0, 20).toString('latin1')
  check('导出: FBX 含 Kaydara 魔数', fbxHead.includes('Kaydara FBX Binary'), `头部: ${fbxHead}`)
  // 验证 STL 是二进制（>=84 字节头 + face 数据）
  const stlBuf = fs.readFileSync(path.join(EXPORT_DIR, 'cube.stl'))
  check('导出: STL 为二进制格式 (80头+4计数)', stlBuf.length >= 84 && stlBuf.readUInt32LE(80) === 12, `大小: ${stlBuf.length}, face数: ${stlBuf.readUInt32LE(80)}`)
  // 验证 OBJ 含顶点与面
  const objText = fs.readFileSync(path.join(EXPORT_DIR, 'cube.obj'), 'utf8')
  const objVCount = (objText.match(/^v /gm) || []).length
  const objFCount = (objText.match(/^f /gm) || []).length
  check('导出: OBJ 含顶点与面', objVCount >= 24 && objFCount >= 12, `v:${objVCount} f:${objFCount}`)

  // ---- 6. 单模型替换验证（UI 层） ----
  // 通过 preload 桥暴露的 open-file 事件（主进程会调用 sendOpenFile）
  // 这里用 Playwright 触发 electronApp 的 IPC——直接调用窗口的 api 事件无法模拟主进程 send，
  // 改为验证场景中模型被替换：加载 STL 后，检查 HUD 文件名变化
  // 通过主进程 electronApp.evaluate 发送 open-file
  await electronApp.evaluate(({ BrowserWindow }, stlPath) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('open-file', stlPath)
  }, testStl)
  await new Promise((r) => setTimeout(r, 1500))
  const fileAfterReplace = (await win.textContent('#hud-file'))?.trim()
  const facesAfter = (await win.textContent('#hud-faces'))?.trim()
  console.log(`  替换后 → 文件:${fileAfterReplace} 面数:${facesAfter}`)
  check('单模型替换: 文件名变为 cube.stl', fileAfterReplace?.includes('cube.stl') === true, `当前: ${fileAfterReplace}`)
  check('单模型替换: 面数仍为 12', facesAfter === '12', `当前: ${facesAfter}`)
  await win.screenshot({ path: path.join(SHOT_DIR, '4-replaced.png') })

  // ---- 汇总 ----
  await electronApp.close()

  const pass = results.filter((r) => r.ok).length
  console.log(`\n=== 测试结果: ${pass}/${results.length} 通过 ===`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
