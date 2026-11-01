import * as THREE from 'three'

/**
 * Polygon triangulation utilities for converting arbitrary polygons (triangles, quads, ngons)
 * into standard triangle index buffers.
 */

/**
 * Decomposes an n-sided polygon into triangles using convex fan triangulation.
 * @param polygonIndices Vertex indices forming the polygon in counter-clockwise order
 * @param targetIndices Array to push resulting triangle indices into
 */
export function fanTriangulate(polygonIndices: number[], targetIndices: number[]): void {
  const count = polygonIndices.length
  if (count < 3) return
  if (count === 3) {
    targetIndices.push(polygonIndices[0], polygonIndices[1], polygonIndices[2])
    return
  }
  if (count === 4) {
    // Quad split into 2 triangles: (0, 1, 2) and (0, 2, 3)
    targetIndices.push(
      polygonIndices[0], polygonIndices[1], polygonIndices[2],
      polygonIndices[0], polygonIndices[2], polygonIndices[3]
    )
    return
  }
  // N-gon: fan from first vertex
  for (let i = 1; i < count - 1; i++) {
    targetIndices.push(polygonIndices[0], polygonIndices[i], polygonIndices[i + 1])
  }
}

/** Ear clipping on the dominant Newell plane, retaining the source winding. */
export function triangulatePolygon(vertices: number[], positions: ArrayLike<number>, indices: number[]): void {
  if (vertices.length < 3 || vertices.some((v) => !Number.isInteger(v) || v < 0 || v * 3 + 2 >= positions.length)) return
  const points = vertices.map((v) => new THREE.Vector3().fromArray(positions, v * 3))
  if (points.some((p) => ![p.x, p.y, p.z].every(Number.isFinite))) return
  if (vertices.length === 3) { indices.push(...vertices); return }
  const normal = new THREE.Vector3()
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    normal.x += (a.y - b.y) * (a.z + b.z)
    normal.y += (a.z - b.z) * (a.x + b.x)
    normal.z += (a.x - b.x) * (a.y + b.y)
  }
  if (normal.lengthSq() === 0) return
  const axis = Math.abs(normal.x) > Math.abs(normal.y)
    ? (Math.abs(normal.x) > Math.abs(normal.z) ? 0 : 2) : (Math.abs(normal.y) > Math.abs(normal.z) ? 1 : 2)
  const outline = points.map((p) => axis === 0 ? new THREE.Vector2(p.y, p.z)
    : axis === 1 ? new THREE.Vector2(p.z, p.x) : new THREE.Vector2(p.x, p.y))
  const ab = new THREE.Vector3(), ac = new THREE.Vector3()
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outline, [])) {
    const direction = ab.subVectors(points[b], points[a]).cross(ac.subVectors(points[c], points[a])).dot(normal)
    if (direction !== 0) indices.push(vertices[a], vertices[direction > 0 ? b : c], vertices[direction > 0 ? c : b])
  }
}
