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
const c1010 = children(p2000).find((c: any) => c.id === 0x1010)
const inner = children(c1010).find((c: any) => c.id === 0x1010)
const c290a = children(inner).find((c: any) => c.id === 0x290a)
const start = c290a.start + c290a.hdr
const len = c290a.end - start
const floats: number[] = []
for (let i = 0; i + 4 <= len; i += 4) floats.push(+view.getFloat32(start + i, true).toFixed(3))
console.log('total floats', floats.length)
for (let i = 0; i < Math.min(floats.length, 120); i += 10) {
  console.log(i.toString().padStart(4), floats.slice(i, i + 10).join(', '))
}
