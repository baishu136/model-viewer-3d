import * as fs from 'fs'
import { CompoundFile } from '../src/renderer/src/loaders/utils/compound-file'

const file = 'C:/Users/GUDGA/Desktop/模型有关/场景参考/2/Decorative_set_4/Decorative_set_4_CORONA.max'
const scene = new CompoundFile(new Uint8Array(fs.readFileSync(file))).readStream('Scene')!
const view = new DataView(scene.buffer, scene.byteOffset, scene.byteLength)
const rh = (off: number, limit: number): any => {
  if (off + 6 > limit) return null
  const id = view.getUint16(off, true), raw = view.getUint32(off + 2, true)
  if (raw !== 0) return { id, start: off, end: off + (raw & 0x7fffffff), hdr: 6, c: (raw & 0x80000000) !== 0 }
  const lo = view.getUint32(off + 6, true), hi = view.getUint32(off + 10, true)
  return { id, start: off, end: off + ((hi & 0x7fffffff) * 4294967296 + lo), hdr: 14, c: (hi & 0x80000000) !== 0 }
}
const children = (r: any) => { const out: any[] = []; let o = r.start + r.hdr; while (o < r.end) { const c = rh(o, r.end); if (!c) break; out.push(c); o = c.end } return out }
const root = rh(0, scene.length)
const items = children(root)

const item = items[1084]
const p2000 = children(item).find((c: any) => c.id === 0x2000)
console.log('0x2000 size', p2000.end - p2000.start - p2000.hdr, 'container', p2000.c)
const dump = (r: any, depth = 0) => {
  console.log('  '.repeat(depth) + `0x${r.id.toString(16)} len=${r.end - r.start - r.hdr} cont=${r.c}`)
  if (r.c && depth < 3) for (const k of children(r)) dump(k, depth + 1)
  if (!r.c) {
    const bytes = scene.subarray(r.start + r.hdr, Math.min(r.end, r.start + r.hdr + 64))
    console.log('  '.repeat(depth + 1) + Buffer.from(bytes).toString('hex'))
    const floats: number[] = []
    for (let i = 0; i + 4 <= Math.min(64, r.end - r.start - r.hdr); i += 4) floats.push(+view.getFloat32(r.start + r.hdr + i, true).toFixed(2))
    console.log('  '.repeat(depth + 1) + 'f32:', floats.join(','))
  }
}
dump(p2000)
