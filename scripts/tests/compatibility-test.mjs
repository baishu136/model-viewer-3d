import { _electron as electron } from 'playwright-core'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModelFixtures } from './model-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = await createModelFixtures(root)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_EXEC_PATH
const packaged = process.argv.includes('--packaged')
const app = await electron.launch({
  executablePath: path.join(root, packaged ? 'release/win-unpacked/3D模型查看器.exe' : 'node_modules/electron/dist/electron.exe'),
  args: [...(packaged ? [] : [path.join(root, 'out/main/index.js')]), path.join(fixtures, 'animated.glb')], cwd: root, env
})
let passed = 0
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${++passed}: ${name}`) }
try {
  const win = await app.firstWindow()
  const errors = [], textureRequests = []
  win.on('pageerror', (error) => errors.push(error.message))
  win.on('request', (request) => { if (/textures\.invalid|missing\.png/.test(request.url())) textureRequests.push(request.url()) })
  win.on('dialog', (dialog) => { errors.push(dialog.message()); void dialog.dismiss() })
  await win.waitForFunction(() => window.__test?.viewer.getAnimationState().clips.length === 2)
  check('GLB opens from the command line with two animation clips', await win.locator('#animation-panel').isVisible())
  check('glTF metres are displayed correctly', (await win.textContent('#hud-size')).includes('1.000 × 1.000'))
  check('initial skin framing uses converted units correctly', await win.evaluate(() => window.__test.viewer.camera.position.length() < 10000))
  const inspect = () => win.evaluate(() => {
    const { viewer } = window.__test
    const model = viewer.getModel(), meshes = []
    let lights = 0, cameras = 0, points = 0, faces = 0
    model.traverse((obj) => {
      if (obj.isLight) lights++
      if (obj.isCamera) cameras++
      if (obj.isPoints) points += obj.geometry.attributes.position.count
      if (obj.isMesh) {
        const geo = obj.geometry
        faces += (geo.index?.count ?? geo.attributes.position.count) / 3
        meshes.push({ name: obj.name, skin: !!obj.isSkinnedMesh, morph: obj.morphTargetInfluences, color: obj.material.color.getHex(), texture: !!obj.material.map })
      }
    })
    return { lights, cameras, points, faces, meshes, state: viewer.getAnimationState() }
  })
  let data = await inspect()
  check('white model retains skin/morph data and ignores scene lights/cameras', data.lights === 0 && data.cameras === 0 && data.meshes[0].skin && !data.meshes[0].texture && data.meshes[0].color === 0xffffff)
  await win.locator('#animation-time').fill('1')
  const pose = await win.evaluate(() => {
    const model = window.__test.viewer.getModel()
    const bone = model.getObjectByName('AnimatedBone'), mesh = model.getObjectByName('AnimatedMesh')
    return { x: bone.position.x, morph: mesh.morphTargetInfluences[0], rootX: model.getObjectByName('FixtureRoot').position.x }
  })
  check('scrubbing evaluates skeleton and morph animation at the exact time', Math.abs(pose.x - 1) < 0.001 && Math.abs(pose.morph - 0.5) < 0.001 && pose.rootX === 3)
  const snapshot = await win.evaluate(async () => {
    const { viewer, serializeModel } = window.__test
    const mesh = viewer.getModel().getObjectByName('AnimatedMesh')
    // Refresh sibling bone transforms too, independently of the next render frame.
    viewer.getModel().updateMatrixWorld(true)
    mesh.skeleton.update()
    const expected = mesh.getVertexPosition(2, mesh.position.clone()).applyMatrix4(mesh.matrixWorld).toArray()
    const { data } = await serializeModel('obj', viewer.getModel(), 'snapshot')
    const vertices = new TextDecoder().decode(data).split('\n').filter((line) => line.startsWith('v ')).map((line) => line.split(/\s+/).slice(1).map(Number))
    return { expected, actual: vertices[2] }
  })
  check('existing static export bakes the displayed skin/morph pose', snapshot.expected.every((value, i) => Math.abs(value - snapshot.actual[i]) < 0.001))
  const binaryRoundTrip = await win.evaluate(async (file) => {
    const { viewer, serializeModel, loadModelFile } = window.__test
    const { data } = await serializeModel('fbx', viewer.getModel(), 'snapshot')
    await window.api.writeFile(file, data)
    const loaded = await loadModelFile(file)
    let faces = 0
    loaded.root.traverse((obj) => { if (obj.isMesh) faces += (obj.geometry.index?.count ?? obj.geometry.attributes.position.count) / 3 })
    return { unit: loaded.unit, faces, clips: loaded.animations.length }
  }, path.join(fixtures, 'snapshot.fbx'))
  check('binary FBX loads with correct millimetre metadata and static geometry', binaryRoundTrip.unit === 'mm' && binaryRoundTrip.faces === 1 && binaryRoundTrip.clips === 0)
  await win.click('[data-mode="wire"]')
  await win.click('#animation-play')
  await win.waitForFunction(() => window.__test.viewer.getAnimationState().time > 1.15)
  await win.click('#animation-play')
  check('play/pause advances time and updates its button', (await win.textContent('#animation-play')) === '播放')
  const paused = (await inspect()).state.time
  await win.waitForTimeout(180)
  check('paused animation remains at its pose', Math.abs((await inspect()).state.time - paused) < 0.001)
  const wire = await win.evaluate(() => {
    const viewer = window.__test.viewer, source = viewer.getModel().getObjectByName('AnimatedMesh')
    const group = viewer.scene.children.find((obj) => obj.children.some((child) => child.renderOrder === 3))
    const overlay = group.children[0]
    const sourceVertex = source.getVertexPosition(0, source.position.clone()).applyMatrix4(source.matrixWorld)
    const overlayVertex = overlay.getVertexPosition(0, overlay.position.clone()).applyMatrix4(overlay.matrixWorld)
    return { skin: overlay.isSkinnedMesh, skeleton: overlay.skeleton === source.skeleton, morph: overlay.morphTargetInfluences === source.morphTargetInfluences, matrix: overlay.matrix.equals(source.matrixWorld), vertexDistance: sourceVertex.distanceTo(overlayVertex) }
  })
  check('wire overlay follows animated skin, morphs and world transforms', wire.skin && wire.skeleton && wire.morph && wire.matrix && wire.vertexDistance < 0.001)
  await win.selectOption('#animation-speed', '2')
  check('speed selection updates playback', (await inspect()).state.speed === 2)
  await win.selectOption('#animation-clip', '1')
  await win.locator('#animation-time').fill('1')
  const transformed = await win.evaluate(() => {
    const node = window.__test.viewer.getModel().getObjectByName('FixtureRoot')
    return { scale: node.scale.x, rotation: node.quaternion.z }
  })
  check('clip switching evaluates scale and rotation', Math.abs(transformed.scale - 1.5) < 0.001 && Math.abs(transformed.rotation - Math.SQRT1_2) < 0.001)
  await win.uncheck('#animation-loop')
  await win.locator('#animation-time').fill('1.8')
  await win.click('#animation-play')
  await win.waitForFunction(() => !window.__test.viewer.getAnimationState().playing)
  check('non-looping clip stops at its final frame', Math.abs((await inspect()).state.time - 2) < 0.001)
  await win.click('#fit-view-btn')
  await win.screenshot({ path: path.join(root, 'screenshots', '5-animation.png') })

  const open = async (name) => {
    await win.evaluate((file) => window.__test.openModel(file), path.join(fixtures, name))
    assert.equal(errors.length, 0, errors.join('\n'))
  }
  for (const name of [path.join('模型 空格 %', 'animated.gltf'), 'embedded.gltf', 'animated.fbx']) {
    await open(name)
    data = await inspect()
    check(`${name}: geometry and animation load`, data.faces === 1 && data.state.clips.length > 0)
    check(`${name}: no imported lights or cameras`, data.lights === 0 && data.cameras === 0)
    if (name.endsWith('.fbx')) {
      await win.locator('#animation-time').fill('1')
      const x = await win.evaluate(() => window.__test.viewer.getModel().getObjectByName('MovingTriangle').position.x)
      check('FBX transform animation can be scrubbed', Math.abs(x - 1) < 0.001)
    }
  }
  for (const name of ['triangle.ply', 'triangle-le.ply', 'triangle-be.ply', 'triangle-face-uv.ply', 'compressed.glb']) {
    await open(name)
    data = await inspect()
    check(`${name}: one triangle loads without animation controls`, data.faces === 1 && data.state.clips.length === 0 && await win.locator('#animation-panel').isHidden())
  }
  await open('points.ply')
  data = await inspect()
  check('PLY point cloud has three points and zero faces', data.points === 3 && data.faces === 0 && (await win.textContent('#hud-vertices')) === '3')
  check('source textures were never requested', textureRequests.length === 0)
  // Existing inputs must continue to work after releasing the mixer and skin resources.
  for (const name of ['cube.obj', 'cube.stl']) {
    await win.evaluate((file) => window.__test.openModel(file), path.join(root, 'testdata', name))
    check(`${name}: original static input still loads`, (await inspect()).faces === 12)
  }
  check('no renderer errors or loading dialogs', errors.length === 0)
  console.log(`Compatibility checks: ${passed} passed`)
} finally {
  await app.close()
}
