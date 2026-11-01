import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/** Static VRM 1.0 container: retain the baked geometry and add an unweighted reference humanoid. */
export class StaticVRMExporter {
  async parse(scene: THREE.Group, name: string): Promise<Uint8Array> {
    const box = new THREE.Box3().setFromObject(scene, true)
    if (box.isEmpty()) throw new Error('没有可导出的 VRM 网格。')
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
    const height = Math.max(size.y, Math.max(size.x, size.z) * 0.25, 0.001)
    const rig = new THREE.Group()
    rig.name = 'StaticVRMReferenceRig'
    rig.userData.description = 'Reference humanoid only. Geometry is static and has no automatic skin weights.'
    const bones = new Map<string, THREE.Bone>()
    const absolute = new Map<string, THREE.Vector3>()
    const add = (boneName: string, parent: string | null, x: number, y: number, z = 0): void => {
      const bone = new THREE.Bone()
      bone.name = `StaticVRM_${boneName}`
      const point = new THREE.Vector3(center.x + x * height, box.min.y + y * height, center.z + z * height)
      bone.position.copy(point)
      if (parent) {
        bone.position.sub(absolute.get(parent)!)
        bones.get(parent)!.add(bone)
      } else rig.add(bone)
      bones.set(boneName, bone); absolute.set(boneName, point)
    }
    add('hips', null, 0, 0.5)
    add('spine', 'hips', 0, 0.6)
    add('chest', 'spine', 0, 0.72)
    add('neck', 'chest', 0, 0.84)
    add('head', 'neck', 0, 0.9)
    for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
      add(`${side}UpperLeg`, 'hips', sign * 0.08, 0.48)
      add(`${side}LowerLeg`, `${side}UpperLeg`, sign * 0.08, 0.25)
      add(`${side}Foot`, `${side}LowerLeg`, sign * 0.08, 0.02, 0.03)
      add(`${side}Toes`, `${side}Foot`, sign * 0.08, 0.02, 0.1)
      add(`${side}Shoulder`, 'chest', sign * 0.07, 0.78)
      add(`${side}UpperArm`, `${side}Shoulder`, sign * 0.15, 0.78)
      add(`${side}LowerArm`, `${side}UpperArm`, sign * 0.3, 0.78)
      add(`${side}Hand`, `${side}LowerArm`, sign * 0.44, 0.78)
    }
    scene.add(rig)
    const binary = await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer
    const view = new DataView(binary)
    const jsonLength = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, jsonLength)))
    const humanBones: Record<string, { node: number }> = {}
    for (const [boneName, bone] of bones) {
      const node = json.nodes.findIndex((entry: { name?: string }) => entry.name === bone.name)
      if (node < 0) throw new Error(`VRM 导出缺少基础骨骼：${boneName}`)
      humanBones[boneName] = { node }
    }
    json.extensions ||= {}
    json.extensions.VRMC_vrm = {
      specVersion: '1.0',
      meta: {
        name: name || 'Static model',
        authors: ['Original author not specified'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        avatarPermission: 'onlySeparatelyLicensedPerson',
        allowRedistribution: false,
        modification: 'prohibited',
        creditNotation: 'required',
        thirdPartyLicenses: 'Static conversion only. Original model rights and licenses remain applicable; this conversion grants no additional permissions.'
      },
      humanoid: { humanBones },
      extras: { staticModel: true, automaticSkinning: false, description: 'Static snapshot with an unweighted reference humanoid. Not a motion-ready avatar.' }
    }
    json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'VRMC_vrm'])]
    json.asset.generator = '3D模型查看器 — Static VRM 1.0'
    // Replace only the GLB JSON chunk. Keep all binary/image chunks unchanged and four-byte aligned.
    const text = new TextEncoder().encode(JSON.stringify(json))
    const paddedLength = (text.length + 3) & ~3
    const tail = new Uint8Array(binary, 20 + jsonLength)
    const result = new Uint8Array(20 + paddedLength + tail.length)
    const header = new DataView(result.buffer)
    header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true)
    header.setUint32(8, result.length, true); header.setUint32(12, paddedLength, true); header.setUint32(16, 0x4e4f534a, true)
    result.fill(0x20, 20, 20 + paddedLength)
    result.set(text, 20); result.set(tail, 20 + paddedLength)
    return result
  }
}
