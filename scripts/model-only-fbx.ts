import type { Plugin } from 'vite'

/** Adapt the locked Three.js loader at build time, without maintaining a full fork.
 * Skip material/image parsing entirely, retaining transform nodes for cameras/lights.
 * Fail explicitly if an upstream update changes these integration points.
 */
export function modelOnlyFbx(): Plugin {
  return {
    name: 'model-only-fbx',
    enforce: 'pre',
    transform(source, id) {
      if (!id.replace(/\\/g, '/').endsWith('/three/examples/jsm/loaders/FBXLoader.js')) return
      const replacements: Array<[RegExp, string]> = [
        [/const images = this\.parseImages\(\);\s*const textures = this\.parseTextures\( images \);\s*const materials = this\.parseMaterials\( textures \);/, 'const materials = new Map();'],
        [/model = this\.createCamera\( relationships \);/, 'model = new Group();'],
        [/model = this\.createLight\( relationships \);/, 'model = new Group();']
      ]
      for (const [pattern, replacement] of replacements) {
        if (!pattern.test(source)) throw new Error('Three.js FBXLoader changed: review the model-only adapter.')
        source = source.replace(pattern, replacement)
      }
      return { code: source, map: null }
    }
  }
}
