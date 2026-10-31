import * as THREE from 'three'
import { fanTriangulate } from './utils/triangulation'

export interface MayaParseResult {
  scene: THREE.Group
  unit: 'cm' | 'mm' | 'm'
}

/**
 * High-performance, streaming pure TypeScript parser for Maya ASCII (.ma) files.
 * Directly extracts geometric meshes, polygon vertices, and face indices.
 */
export class MayaAsciiLoader {
  private manager: THREE.LoadingManager

  constructor(manager?: THREE.LoadingManager) {
    this.manager = manager || THREE.DefaultLoadingManager
  }

  parse(text: string): THREE.Group {
    const root = new THREE.Group()
    root.name = 'MayaAsciiRoot'

    // Clean up carriage returns and split by statement (semicolon)
    const statements = text.split(';')

    let currentMeshName: string | null = null
    let vertices: number[] = []
    let indices: number[] = []

    const flushCurrentMesh = () => {
      if (currentMeshName && vertices.length >= 9) { // At least 3 vertices (3 * 3 floats)
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
        if (indices.length > 0) {
          geometry.setIndex(indices)
        }
        geometry.computeVertexNormals()

        const mesh = new THREE.Mesh(geometry)
        mesh.name = currentMeshName
        root.add(mesh)
      }
      currentMeshName = null
      vertices = []
      indices = []
    }

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].trim()
      if (!stmt || stmt.startsWith('//')) continue

      // Detect mesh node creation: createNode mesh -n "shapeName"
      if (stmt.startsWith('createNode mesh')) {
        flushCurrentMesh()
        const nameMatch = stmt.match(/-n\s+"?([^"\s;]+)"?/)
        currentMeshName = nameMatch ? nameMatch[1] : `mesh_${root.children.length + 1}`
        continue
      }

      // If we are tracking a mesh, parse its vertex and face attributes
      if (currentMeshName) {
        // Vertex coordinates: setAttr ".vt[...]" -type "float3" x y z ...
        if (stmt.includes('.vt[')) {
          // Find the float values in the statement
          // Strip attributes prefix up to "float3" or type declaration
          const typeIndex = stmt.indexOf('"float3"')
          const dataStr = typeIndex !== -1 ? stmt.slice(typeIndex + 8) : stmt.slice(stmt.indexOf(']') + 1)

          // Match all floating point numbers (supporting scientific notation)
          const numMatches = dataStr.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g)
          if (numMatches) {
            for (let j = 0; j < numMatches.length; j++) {
              vertices.push(parseFloat(numMatches[j]))
            }
          }
        }
        // Face definitions: setAttr ".fc[...]" -type "polyFaces" f 4 0 1 3 2 ...
        else if (stmt.includes('.fc[')) {
          // Tokenize the statement tokens
          const tokens = stmt.split(/\s+/)
          let t = 0
          while (t < tokens.length) {
            if (tokens[t] === 'f') {
              t++
              if (t >= tokens.length) break
              const count = parseInt(tokens[t++], 10)
              if (!isNaN(count) && count >= 3) {
                const polyIndices: number[] = []
                for (let c = 0; c < count && t < tokens.length; c++) {
                  const idx = parseInt(tokens[t++], 10)
                  if (!isNaN(idx)) {
                    polyIndices.push(idx)
                  }
                }
                fanTriangulate(polyIndices, indices)
              }
            } else if (tokens[t] === 'mu' || tokens[t] === 'm') {
              // Skip UV or edge texture tokens inside polyFaces
              t++
              if (t < tokens.length) {
                const skipCount = parseInt(tokens[t++], 10)
                if (!isNaN(skipCount)) {
                  t += skipCount
                }
              }
            } else {
              t++
            }
          }
        }
      }
    }

    // Flush any pending mesh at the end of file
    flushCurrentMesh()

    return root
  }
}
