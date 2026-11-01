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
const find = (item: any, id: number): any => { if (!item || !item.c) return null; for (const c of children(item)) { if (c.id === id) return c; if (c.c) { const f = find(c, id); if (f) return f } } return null }

const readKnots = (item: any) => {
  const c290a = find(item, 0x290a)
  const c2900 = find(item, 0x2900)
  if (!c290a || !c2900) return null
  const count = view.getUint32(c2900.start + c2900.hdr, true)
  const total = (c290a.end - c290a.start - c290a.hdr) / 4
  const stride = total / count
  const pts: number[][] = []
  for (let k = 0; k < count; k++) {
    const base = c290a.start + c290a.hdr + k * stride * 4
    const f = (i: number) => view.getFloat32(base + i * 4, true)
    pts.push([f(3), f(4), f(6), f(7), f(9), f(10), f(2), f(11), f(12)])
  }
  return { count, stride, pts }
}

for (const name of ['dosk_1', 'strela']) {
  // 找到节点
  let objRef = -1
  items.forEach((item) => {
    if (objRef >= 0 || !item.c) return
    const kids = children(item)
    const nameChunk = kids.find((k: any) => k.id === 0x0962 && !k.c)
    if (!nameChunk) return
    let n = ''
    for (let p = nameChunk.start + nameChunk.hdr; p + 1 < nameChunk.end; p += 2) { const ch = view.getUint16(p, true); if (!ch) break; n += String.fromCharCode(ch) }
    if (n !== name) return
    for (const k of kids) if (k.id === 0x2035 && !k.c) for (let p = k.start + k.hdr + 4; p + 8 <= k.end; p += 8) if (view.getInt32(p, true) === 1) objRef = view.getInt32(p + 4, true)
  })
  console.log(`\n=== ${name} objRef=${objRef}`)
  const targets: any[] = []
  const seen = new Set<number>()
  const collect = (idx: number) => {
    if (idx < 0 || idx >= items.length || seen.has(idx)) return
    seen.add(idx)
    const it = items[idx]
    if (!it || !it.c) return
    targets.push(it)
    for (const c of children(it)) {
      if (c.c) collect(items.indexOf(c))
      if (c.id === 0x2034) {
        for (let p = c.start + c.hdr; p + 4 <= c.end; p += 4) collect(view.getInt32(p, true))
      }
      if (c.id === 0x2035) {
        for (let p = c.start + c.hdr + 4; p + 8 <= c.end; p += 8) collect(view.getInt32(p + 4, true))
      }
    }
  }
  collect(objRef)
  for (const t of targets) {
    const knots = readKnots(t)
    if (!knots) continue
    console.log(`  found spline data: count=${knots.count} stride=${knots.stride}`)
    const xs = knots.pts.map((p) => p[2])
    const ys = knots.pts.map((p) => p[3])
    console.log('  bbox x', Math.min(...xs).toFixed(1), Math.max(...xs).toFixed(1), 'y', Math.min(...ys).toFixed(1), Math.max(...ys).toFixed(1))
    for (let i = 0; i < knots.count; i++) {
      const p = knots.pts[i]
      console.log(`   #${i} A=(${p[0].toFixed(1)},${p[1].toFixed(1)}) B=(${p[2].toFixed(1)},${p[3].toFixed(1)}) C=(${p[4].toFixed(1)},${p[5].toFixed(1)}) flags=${p[6]},${p[7]},${p[8]}`)
    }
    break
  }
}
