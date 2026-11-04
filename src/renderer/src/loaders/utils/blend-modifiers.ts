import * as THREE from 'three'
import { triangulatePolygon } from './triangulation'

export interface PolygonMesh { positions: number[]; faces: number[][] }

/** Basic constant-width Wireframe preview on a polygon surface (no vertex groups/creases). */
export function wireframeMesh(source: PolygonMesh, thickness: number, offset: number, replace: boolean, even: boolean): PolygonMesh {
  const points = Array.from({ length: source.positions.length / 3 }, (_, i) => new THREE.Vector3().fromArray(source.positions, i * 3))
  const normals = points.map(() => new THREE.Vector3())
  const faceNormals = source.faces.map((face) => {
    const normal = new THREE.Vector3()
    for (let i = 0; i < face.length; i++) {
      const a = points[face[i]], b = points[face[(i + 1) % face.length]]
      normal.x += (a.y - b.y) * (a.z + b.z)
      normal.y += (a.z - b.z) * (a.x + b.x)
      normal.z += (a.x - b.x) * (a.y + b.y)
    }
    normal.normalize()
    for (const v of face) normals[v].add(normal)
    return normal
  })
  normals.forEach((n) => n.normalize())
  const positions: number[] = [], faces: number[][] = []
  const add = (point: THREE.Vector3): number => { positions.push(...point.toArray()); return positions.length / 3 - 1 }
  const half = Math.abs(thickness) / 2
  const top = points.map((p, i) => add(p.clone().addScaledVector(normals[i], half * (1 + offset))))
  const bottom = points.map((p, i) => add(p.clone().addScaledVector(normals[i], half * (offset - 1))))
  source.faces.forEach((face, fi) => {
    const insetTop: number[] = [], insetBottom: number[] = [], normal = faceNormals[fi]
    face.forEach((vi, i) => {
      const p = points[vi]
      const incoming = p.clone().sub(points[face[(i + face.length - 1) % face.length]]).normalize()
      const outgoing = points[face[(i + 1) % face.length]].clone().sub(p).normalize()
      const a = new THREE.Vector3().crossVectors(normal, incoming), b = new THREE.Vector3().crossVectors(normal, outgoing)
      const bisector = a.clone().add(b).normalize()
      const divisor = even ? Math.max(Math.abs(bisector.dot(b)), 0.05) : 1
      const inset = p.clone().addScaledVector(bisector, half / divisor)
      insetTop.push(add(inset.clone().addScaledVector(normals[vi], half * (1 + offset))))
      insetBottom.push(add(inset.clone().addScaledVector(normals[vi], half * (offset - 1))))
    })
    for (let i = 0; i < face.length; i++) {
      const j = (i + 1) % face.length
      faces.push([top[face[i]], top[face[j]], insetTop[j], insetTop[i]])
      faces.push([bottom[face[j]], bottom[face[i]], insetBottom[i], insetBottom[j]])
      faces.push([insetTop[i], insetTop[j], insetBottom[j], insetBottom[i]])
    }
    if (!replace) faces.push(face.map((v) => top[v]))
  })
  return { positions, faces }
}

/** Catmull-Clark / simple subdivision for polygon preview, without crease weights. */
export function subdivideMesh(source: PolygonMesh, simple = false): PolygonMesh {
  const points = Array.from({ length: source.positions.length / 3 }, (_, i) => new THREE.Vector3().fromArray(source.positions, i * 3))
  const centers = source.faces.map((face) => face.reduce((sum, v) => sum.add(points[v]), new THREE.Vector3()).divideScalar(face.length))
  const edges = new Map<string, { a: number; b: number; faces: number[]; index: number }>()
  const vertexFaces = points.map(() => new Set<number>()), vertexEdges = points.map(() => new Set<string>())
  const key = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`
  source.faces.forEach((face, fi) => face.forEach((a, i) => {
    const b = face[(i + 1) % face.length], k = key(a, b)
    if (!edges.has(k)) edges.set(k, { a, b, faces: [], index: 0 })
    edges.get(k)!.faces.push(fi)
    vertexFaces[a].add(fi); vertexEdges[a].add(k); vertexEdges[b].add(k)
  }))
  const positions: number[] = [], faces: number[][] = []
  const add = (p: THREE.Vector3): number => { positions.push(...p.toArray()); return positions.length / 3 - 1 }
  points.forEach((p, i) => {
    const connected = [...vertexEdges[i]].map((k) => edges.get(k)!)
    const boundary = connected.filter((e) => e.faces.length === 1).map((e) => points[e.a === i ? e.b : e.a])
    if (simple || !connected.length) { add(p); return }
    if (boundary.length === 2) { add(p.clone().multiplyScalar(6).add(boundary[0]).add(boundary[1]).divideScalar(8)); return }
    const n = vertexFaces[i].size
    const averageFace = [...vertexFaces[i]].reduce((sum, fi) => sum.add(centers[fi]), new THREE.Vector3()).divideScalar(n || 1)
    const averageEdge = connected.reduce((sum, e) => sum.add(points[e.a]).add(points[e.b]), new THREE.Vector3()).divideScalar(2 * connected.length)
    add(p.clone().multiplyScalar(n - 3).add(averageFace).addScaledVector(averageEdge, 2).divideScalar(n || 1))
  })
  for (const edge of edges.values()) {
    const p = points[edge.a].clone().add(points[edge.b])
    if (!simple && edge.faces.length === 2) p.add(centers[edge.faces[0]]).add(centers[edge.faces[1]]).divideScalar(4)
    else p.divideScalar(2)
    edge.index = add(p)
  }
  const centerIndices = centers.map(add)
  source.faces.forEach((face, fi) => face.forEach((v, i) => {
    const next = face[(i + 1) % face.length], previous = face[(i + face.length - 1) % face.length]
    faces.push([v, edges.get(key(v, next))!.index, centerIndices[fi], edges.get(key(previous, v))!.index])
  }))
  return { positions, faces }
}

export function polygonGeometry(source: PolygonMesh): THREE.BufferGeometry {
  const indices: number[] = []
  for (const face of source.faces) triangulatePolygon(face, source.positions, indices)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}
