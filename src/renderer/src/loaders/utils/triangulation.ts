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
