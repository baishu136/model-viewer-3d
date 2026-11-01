import * as THREE from 'three'
import { triangulatePolygon } from './utils/triangulation'

interface MayaNode {
  type: string
  name: string
  path: string
  parent: string
  vectors: Record<string, THREE.Vector3>
  order: number
  intermediate: boolean
  vertices: number[]
  edges: number[][]
  faces: number[][]
}

/** Saved static Maya geometry and DAG transforms; faces reference oriented edges, not vertices. */
export class MayaAsciiLoader {
  unit: 'cm' | 'mm' | 'm' = 'cm'
  constructor(_manager?: THREE.LoadingManager) {}

  parse(text: string): THREE.Group {
    this.unit = 'cm'
    const root = new THREE.Group()
    root.name = 'MayaAsciiRoot'
    const nodes: MayaNode[] = [], byPath = new Map<string, MayaNode>(), byName = new Map<string, MayaNode>()
    const aliases: Record<string, string> = { translate: 't', rotate: 'r', scale: 's', rotatePivot: 'rp', scalePivot: 'sp',
      rotatePivotTranslate: 'rpt', scalePivotTranslate: 'spt', jointOrient: 'jo', rotateAxis: 'ra' }
    let current: MayaNode | undefined, zUp = false, radians = false
    const flag = (s: string, names: string): string => s.match(new RegExp(`-(?:${names})\\s+"([^"]+)"`))?.[1] || ''
    const numbers = (s: string): number[] => (s.replace(/-(?:type|typ)\s+"[^"]+"/g, '')
      .match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || []).map(Number)
    // Keep quoted semicolons; discard only comments outside quoted strings.
    const clean = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*/g, (token) => token.startsWith('//') ? '' : token)
    const statements = clean.match(/(?:"(?:\\.|[^"\\])*"|[^;"])+;/g) || []
    for (const raw of statements) {
      const s = raw.trim().replace(/;$/, '')
      if (/^currentUnit\b/.test(s)) {
        const linear = s.match(/-(?:l|linear)\s+(\w+)/)?.[1] || ''
        this.unit = /^(mm|millimeter)$/.test(linear) ? 'mm' : /^(m|meter)$/.test(linear) ? 'm' : 'cm'
        radians = /-(?:a|angle)\s+(rad|radian)\b/.test(s)
      } else if (/^upAxis\b/.test(s)) zUp = /-(?:ax|axis)\s+"?z\b/i.test(s)
      else if (/^createNode\b/.test(s)) {
        const type = s.match(/^createNode\s+(\w+)/)?.[1] || '', name = flag(s, 'n|name') || `${type}_${nodes.length}`
        const parent = flag(s, 'p|parent'), parentNode = byPath.get(parent) || byPath.get('|' + parent) || byName.get(parent)
        const fullPath = (parentNode?.path || (parent ? '|' + parent.replace(/^\|/, '') : '')) + '|' + name
        const vectors: Record<string, THREE.Vector3> = {}
        for (const attr of ['t', 'r', 's', 'rp', 'sp', 'rpt', 'spt', 'jo', 'ra']) vectors[attr] = new THREE.Vector3()
        vectors.s.set(1, 1, 1)
        current = { type, name, path: fullPath, parent, vectors, order: 0, intermediate: false, vertices: [], edges: [], faces: [] }
        nodes.push(current); byPath.set(fullPath, current); byName.set(name, current)
      } else if (/^select\b/.test(s)) {
        const name = s.match(/"([^"]+)"/)?.[1]
        current = name ? byPath.get(name) || byName.get(name) : undefined
      } else if (current && /^setAttr\b/.test(s)) {
        const attr = s.match(/"\.([^"]+)"/)
        if (!attr) continue
        const data = s.slice(attr.index! + attr[0].length), key = attr[1]
        const range = key.match(/^(vt|vrts|vertices|ed|edge|edges|fc|face)\[(\d+)(?::(\d+))?\]$/)
        if (range) {
          const start = Number(range[2])
          if (['vt', 'vrts', 'vertices'].includes(range[1])) {
            const values = numbers(data)
            for (let i = 0; i < values.length; i++) current.vertices[start * 3 + i] = values[i]
          } else if (['ed', 'edge', 'edges'].includes(range[1])) {
            const values = numbers(data)
            for (let i = 0; i + 2 < values.length; i += 3) current.edges[start + i / 3] = values.slice(i, i + 2)
          } else {
            const tokens = data.match(/\b(?:f|h|mu|mf|mc|mh|fc)\b|[-+]?\d+/g) || []
            let faceIndex = start
            for (let i = 0; i < tokens.length; i++) {
              if (tokens[i] !== 'f') continue
              const count = Number(tokens[++i])
              if (!Number.isInteger(count) || count < 3 || count > 100000) continue
              const edges = tokens.slice(i + 1, i + 1 + count).map(Number)
              if (edges.length === count && edges.every(Number.isInteger)) current.faces[faceIndex++] = edges
              i += count
            }
          }
          continue
        }
        const values = numbers(data), short = aliases[key] || key
        if (current.vectors[short] && values.length >= 3) current.vectors[short].fromArray(values)
        else if (key === 'ro' || key === 'rotateOrder') current.order = values[0] || 0
        else if (key === 'io' || key === 'intermediateObject') current.intermediate = /\b(yes|on|true|1)\b/.test(data)
        else {
          const component = key.match(/^(translate|rotate|scale|t|r|s)([xyzXYZ])$/)
          if (component && values.length) current.vectors[aliases[component[1]] || component[1]].setComponent('xyz'.indexOf(component[2].toLowerCase()), values[0])
        }
      }
    }
    const matrices = new Map<MayaNode, THREE.Matrix4>()
    const translate = (v: THREE.Vector3, sign = 1): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(v.x * sign, v.y * sign, v.z * sign)
    const rotate = (v: THREE.Vector3, order: THREE.EulerOrder = 'ZYX'): THREE.Matrix4 => new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(v.x * (radians ? 1 : Math.PI / 180), v.y * (radians ? 1 : Math.PI / 180), v.z * (radians ? 1 : Math.PI / 180), order))
    const resolve = (node: MayaNode, stack = new Set<MayaNode>()): THREE.Matrix4 => {
      const cached = matrices.get(node)
      if (cached) return cached
      if (stack.has(node)) throw new Error('Maya 节点层级包含循环引用。')
      stack.add(node)
      const v = node.vectors, orders: THREE.EulerOrder[] = ['ZYX', 'XZY', 'YXZ', 'ZXY', 'YZX', 'XYZ']
      const local = translate(v.t).multiply(translate(v.rpt)).multiply(translate(v.rp)).multiply(rotate(v.jo))
        .multiply(rotate(v.r, orders[node.order] || 'ZYX')).multiply(rotate(v.ra)).multiply(translate(v.rp, -1))
        .multiply(translate(v.spt)).multiply(translate(v.sp)).multiply(new THREE.Matrix4().makeScale(v.s.x, v.s.y, v.s.z)).multiply(translate(v.sp, -1))
      const parent = byPath.get(node.path.slice(0, node.path.lastIndexOf('|'))) || byPath.get(node.parent) || byName.get(node.parent)
      const matrix = parent ? resolve(parent, stack).clone().multiply(local) : local
      stack.delete(node); matrices.set(node, matrix)
      return matrix
    }
    const candidates = nodes.filter((n) => n.type === 'mesh' && n.vertices.length >= 9 && n.faces.length)
    for (const node of candidates) {
      // Use saved original geometry when a deformer output has no mesh cache.
      if (node.intermediate && candidates.some((n) => !n.intermediate && n.parent === node.parent)) continue
      const indices: number[] = []
      for (const face of node.faces) {
        if (!face) continue
        const vertices = face.map((edge) => {
          const e = node.edges[edge >= 0 ? edge : -edge - 1]
          return e ? e[edge >= 0 ? 0 : 1] : (node.edges.length ? -1 : edge)
        })
        triangulatePolygon(vertices, node.vertices, indices)
      }
      if (!indices.length) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(node.vertices, 3))
      geometry.setIndex(indices); geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(geometry)
      mesh.name = node.name; mesh.applyMatrix4(resolve(node)); root.add(mesh)
    }
    if (zUp) root.rotation.x = -Math.PI / 2
    return root
  }
}
